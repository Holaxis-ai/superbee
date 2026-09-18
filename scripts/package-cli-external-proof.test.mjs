import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { init, parse } from "es-module-lexer";
import { versionPattern } from "./package-version-policy.mjs";
import { embeddedEngineRecord } from "../packages/cli/scripts/embedded-engine.mjs";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const readJson = async file => JSON.parse(await readFile(file, "utf8"));

// The record is checked against the bundler's own input list and the tree's own git facts, not
// against the build script's derivation of them. `manifestOf` maps a packages/ directory name to
// its workspace manifest; `compare(directory, tag)` is the tree's tri-state measurement.
function embeddedEngineErrors(record, metafile, manifestOf, isTracked, compare) {
  const errors = [];
  const contributors = new Map();
  const untracked = new Map();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const parts = path.relative(root, path.resolve(root, "packages/cli", input)).split(path.sep);
    if (parts[0] === "..") errors.push(`input ${input}: resolves outside the repository`);
    const scoped = parts.indexOf("@superbee");
    if (scoped > 0 && parts[scoped - 1] === "node_modules") errors.push(`input ${input}: @superbee/${parts[scoped + 1]} resolves to an installed package, not workspace source`);
    if (parts[0] !== "packages" || parts.includes("node_modules") || parts[1] === "cli") continue;
    const manifest = manifestOf(parts[1]);
    if (!manifest?.name?.startsWith("@superbee/")) errors.push(`input ${input}: packages/${parts[1]} is not an @superbee workspace`);
    else if (parts[2] !== "src") errors.push(`input ${input}: ${manifest.name} resolves outside workspace source`);
    else {
      contributors.set(manifest.name, { version: manifest.version, directory: parts[1] });
      if (!isTracked(parts.join("/"))) untracked.set(manifest.name, [...(untracked.get(manifest.name) ?? []), input]);
    }
  }
  if (record?.schema !== "superbee.cli-embedded-engine.v1") errors.push(`schema: found ${JSON.stringify(record?.schema)}`);
  if (/match/i.test(JSON.stringify(record))) errors.push("record asserts a match; it may only report measurements");
  const rows = Array.isArray(record?.packages) ? record.packages : [];
  if (!Array.isArray(record?.packages)) errors.push("packages: expected an array");
  const recorded = rows.map(row => row?.name);
  for (const name of contributors.keys()) if (!recorded.includes(name)) errors.push(`packages: bundle contributor ${name} is missing from the record`);
  for (const [index, row] of rows.entries()) {
    const at = `packages[${index}]`;
    if (Object.keys(row ?? {}).sort().join() !== "name,release_tag,source_identical_to_release_tag,version") { errors.push(`${at}: unexpected fields`); continue; }
    if (recorded.indexOf(row.name) !== index) errors.push(`${at}: duplicate ${row.name}`);
    if (!contributors.has(row.name)) { errors.push(`${at}: ${row.name} contributes no bundle input`); continue; }
    const { version, directory } = contributors.get(row.name);
    if (row.version !== version) errors.push(`${at}: version ${row.version} is not the workspace manifest version`);
    const tag = ["@superbee/core", "@superbee/server"].includes(row.name) ? `libraries/v${row.version}` : null;
    if (row.release_tag !== tag) errors.push(`${at}: release_tag ${JSON.stringify(row.release_tag)}; expected ${JSON.stringify(tag)}`);
    if (![true, false, null].includes(row.source_identical_to_release_tag) || (tag === null && row.source_identical_to_release_tag !== null)) errors.push(`${at}: source_identical_to_release_tag is not a measurement against ${JSON.stringify(tag)}`);
    else if (tag !== null) {
      // One expectation per row: an untracked embedded input makes the tree unmeasurable.
      const expected = untracked.has(row.name) ? null : compare(directory, tag);
      if (row.source_identical_to_release_tag !== expected) errors.push(`${at}: source_identical_to_release_tag is ${row.source_identical_to_release_tag} but the tree measures ${expected}${untracked.has(row.name) ? `; ${untracked.get(row.name).join(", ")} is not tracked by git` : ""}`);
    }
  }
  // Development trees are dirty and may lack git, so source is checked for shape only.
  const source = record?.source;
  if (Object.keys(source ?? {}).sort().join() !== "commit,dirty" || !(source.commit === null || /^[a-f0-9]{40}$/.test(source.commit)) || !(source.dirty === null || typeof source.dirty === "boolean")) errors.push("source: expected {commit: 40-hex|null, dirty: boolean|null}");
  if (Object.keys(record ?? {}).sort().join() !== "packages,schema,source") errors.push("record: unexpected top-level fields");
  return errors;
}
// The tree's own measurement: null unless the tag is reachable and the package directory is clean.
const treeComparison = (directory, tag) => {
  const git = args => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]).status !== 0) return null;
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", `packages/${directory}`]);
  if (status.status !== 0 || status.stdout !== "") return null;
  const diff = git(["diff", "--quiet", `refs/tags/${tag}`, "HEAD", "--", `packages/${directory}`]);
  return diff.status === 0 ? true : diff.status === 1 ? false : null;
};
const trackedPaths = async () => {
  const listed = await exec("git", ["ls-files", "-z", "--", "packages"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const tracked = new Set(listed.stdout.split("\0"));
  return path => tracked.has(path);
};
const workspaceManifests = async () => {
  const manifests = new Map();
  for (const directory of await readdir(path.join(root, "packages"))) manifests.set(directory, await readJson(path.join(root, "packages", directory, "package.json")).catch(() => undefined));
  return directory => manifests.get(directory);
};

test("workspace directories and lock links follow package identities", async () => {
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  for (const [directory, name] of [["cli", "@superbee/cli"], ["superbee", "superbee"]]) {
    const packagePath = `packages/${directory}`;
    const pkg = JSON.parse(await readFile(path.join(root, packagePath, "package.json"), "utf8"));
    assert.equal(pkg.name, name);
    assert.equal(lock.packages[packagePath].version, pkg.version);
    assert.equal(lock.packages[`node_modules/${name}`].resolved, packagePath);
    assert.equal(lock.packages[`node_modules/${name}`].link, true);
  }
});

test("packed reusable CLI is closed, inert on import, and binds commands to its executable", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-cli-consumer-"));
  const npm = process.env.npm_execpath;
  assert.ok(npm, "run through npm test:scripts or npm exec");
  const run = (args, cwd = scratch, env = {}) => exec(process.execPath, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
  try {
    const packed = await run([npm, "pack", "-w", "@superbee/cli", "--json", "--pack-destination", scratch], root);
    const [receipt] = JSON.parse(packed.stdout);
    assert.ok(receipt.files.every(({ path: file }) => ["package.json", "README.md"].includes(file) || file.startsWith("dist/")));
    const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({ private: true, type: "module", devDependencies: { "@types/node": lock.packages["node_modules/@types/node"].version }, dependencies: { "@superbee/cli": `file:${path.join(scratch, receipt.filename)}` } }));
    // Node adapter declarations need consumer-owned Node types; cold caches require registry metadata.
    await run([npm, "install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const library = path.join(scratch, "node_modules/@superbee/cli");
    assert.equal((await lstat(library)).isSymbolicLink(), false);
    assert.deepEqual(await readdir(path.join(scratch, "node_modules/@superbee")), ["cli"]);
    const pkg = JSON.parse(await readFile(path.join(library, "package.json"), "utf8"));
    const workspace = await readJson(path.join(root, "packages/cli/package.json"));
    assert.equal(pkg.private, undefined); assert.equal(pkg.version, workspace.version); assert.match(pkg.version, versionPattern); assert.equal(pkg.bin, undefined);
    assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) assert.equal(pkg[key], undefined);
    assert.ok(receipt.files.some(({ path: file }) => file === "dist/embedded-engine.json"));
    // The record is data, read through its export without loading the library.
    await writeFile(path.join(scratch, "engine.cjs"), "process.stdout.write(JSON.stringify(require('@superbee/cli/embedded-engine.json')));\n");
    const record = JSON.parse((await run([path.join(scratch, "engine.cjs")])).stdout);
    assert.deepEqual(record, await readJson(path.join(library, "dist/embedded-engine.json")));
    assert.deepEqual(embeddedEngineErrors(record, await readJson(path.join(root, "out/cli-runtime-metafile.json")), await workspaceManifests(), await trackedPaths(), treeComparison), []);
    await init;
    const [imports] = parse(await readFile(path.join(library, "dist/index.mjs"), "utf8"));
    for (const imported of imports.filter(item => item.d !== -2)) assert.ok(imported.n?.startsWith("node:"), `unclosed import ${imported.n}`);
    await writeFile(path.join(scratch, "consumer.ts"), `import { main, configureSourceIdentity, registerExecutableEntry, buildIdentityEnvelope, type BuildIdentityEnvelope } from '@superbee/cli';\nconfigureSourceIdentity({ name: 'superbee', version: '1.2.3' });\nregisterExecutableEntry('fixture.mjs');\nconst identity: BuildIdentityEnvelope = buildIdentityEnvelope();\nvoid main(['help']); void identity;\n`);
    await appendFile(path.join(scratch, "consumer.ts"), `
import { createCliRuntime, createPosixCliRuntime, type CliRuntimeOptions, type CliDistribution } from '@superbee/cli';
import { getDistributionResources } from '@superbee/cli/resources';
declare const options: CliRuntimeOptions;
declare const distribution: CliDistribution;
void createCliRuntime(options).run(['help']);
void createPosixCliRuntime(distribution).runManagedUiWorker();
const resources = getDistributionResources({ packageName: '@fixture/cli', binName: 'fixture' });
const text: string = resources.skill;
void [text, resources.references];
`);
    await writeFile(path.join(scratch, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ES2022", types: ["node"], skipLibCheck: false }, files: ["consumer.ts"] }));
    await run([path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
    const home = path.join(scratch, "home"); const cwd = path.join(scratch, "work"); await mkdir(home); await mkdir(cwd);
    const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: home, ASLITE_NO_UPDATE_CHECK: "1", AGENTSTATE_LITE_NO_AUTOPULL: "1" };
    await writeFile(path.join(scratch, "inert.mjs"), `import assert from 'node:assert/strict';
import child from 'node:child_process'; import net from 'node:net'; import { syncBuiltinESMExports } from 'node:module';
import { readdirSync } from 'node:fs';
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[key] = () => { throw new Error('import spawned child'); };
net.Server.prototype.listen = () => { throw new Error('import opened listener'); }; syncBuiltinESMExports();
const env = JSON.stringify(process.env); process.exitCode = 37;
process.exit = () => { throw new Error('import exited process'); };
const cli = await import('@superbee/cli');
const resources = await import('@superbee/cli/resources');
const rendered = resources.getDistributionResources({packageName:'@fixture/cli',binName:'fixture'});
assert.ok(rendered.skill.includes('fixture setup'));
assert.ok(rendered.references.length > 0);
assert.equal(JSON.stringify(process.env), env); assert.equal(process.exitCode, 37); process.exitCode = 0;
assert.equal(cli.currentExecutableRealPath(), undefined);
assert.equal(cli.cliVersion(), 'unknown');
assert.throws(() => cli.configureSourceIdentity({name:'superbee',version:'1.2.3'}), /already/);
assert.deepEqual(readdirSync(process.env.HOME), []); assert.deepEqual(readdirSync(process.cwd()), []);
`);
    for (const argv of [["init"], ["ui"], ["__managed-ui-v1"], ["__update-refresh-v1", "bad"]]) {
      const result = await run([path.join(scratch, "inert.mjs"), ...argv], cwd, env);
      assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
    }
    await mkdir(path.join(scratch, "dist"));
    await mkdir(path.join(scratch, "references"));
    await writeFile(path.join(scratch, "SKILL.md"), "# External fixture skill\n");
    await writeFile(path.join(scratch, "references", "proof.md"), "External resource proof\n");
    const entry = path.join(scratch, "dist", "fixture.mjs");
    await writeFile(entry, `import assert from 'node:assert/strict'; import { createHash } from 'node:crypto'; import { readFileSync, realpathSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
globalThis.__SUPERBEE_BUILD_IDENTITY__ = {
  schema:'superbee.build-identity.v1', package:{name:'ambient-host',version:'9.9.9'},
  source:{commit:null,dirty:null}, artifact:{channel:'npm-package'},
  compatibility_contracts:{skill:1,hook:1,mcp:1}
};
globalThis.__SUPERBEE_FUNCTIONAL_VERSION_FLOOR__ = '1.0.0';
globalThis.__SUPERBEE_UPDATE_POLICY__ = {enabled:true};
let registryCalls = 0;
globalThis.fetch = async () => { registryCalls++; throw new Error('unexpected registry access'); };
const { configureSourceIdentity, registerExecutableEntry, buildIdentityEnvelope, cliVersion, main } = await import('@superbee/cli');
const pkg = {name:'superbee',version:'1.2.3'}; configureSourceIdentity(pkg); pkg.version = '9.9.9';
configureSourceIdentity({name:'superbee',version:'1.2.3'});
assert.throws(() => configureSourceIdentity({name:'superbee',version:'2.0.0'}), /already/);
const entry = realpathSync(fileURLToPath(import.meta.url)); registerExecutableEntry(entry); registerExecutableEntry(entry);
assert.throws(() => registerExecutableEntry(fileURLToPath(import.meta.resolve('@superbee/cli'))), /already/);
const envelope = buildIdentityEnvelope(); assert.equal(cliVersion(), '1.2.3'); assert.equal(envelope.identity.runtime.executable_path, entry);
assert.equal(envelope.identity.artifact.sha256, 'sha256:' + createHash('sha256').update(readFileSync(entry)).digest('hex'));
await main(process.argv.slice(2));
assert.equal(registryCalls, 0, 'ambient globals must not enable update checks');
`);
    const version = await run([entry, "version", "--json"], cwd, env);
    assert.deepEqual(JSON.parse(version.stdout).identity.package, { name: "superbee", version: "1.2.3" });
    await assert.rejects(run([entry, "version", "--check", "--json"], cwd, env), error => {
      assert.equal(error.code, 1);
      const output = JSON.parse(error.stdout);
      assert.equal(output.check.unavailable.code, "policy_disabled");
      assert.equal(output.check.unavailable.message, "supported-release checks are disabled for this build target");
      assert.deepEqual(output.identity.package, { name: "superbee", version: "1.2.3" });
      assert.equal(error.stderr, "");
      return true;
    });
    assert.match((await run([entry, "help"], cwd, env)).stdout, /superbee/);
    await run([entry, "skill", "install", "--scope", "project"], cwd, env);
    assert.equal(await readFile(path.join(cwd, ".claude/skills/superbee/SKILL.md"), "utf8"), "# External fixture skill\n");
    assert.equal(await readFile(path.join(cwd, ".claude/skills/superbee/references/proof.md"), "utf8"), "External resource proof\n");
    const bundle = path.join(scratch, "bundle");
    await run([entry, "init", "--create-only", "--dir", bundle, "--recipe", "none"], cwd, env);
    await run([entry, "doc", "write", "notes/proof", "--type", "Note", "--body", "portable proof", "--actor", "process:external-proof", "--dir", bundle], cwd, env);
    assert.match((await run([entry, "doc", "read", "notes/proof", "--dir", bundle], cwd, env)).stdout, /portable proof/);
    await assert.rejects(run([entry, "unknown-command"], cwd, env), error => error.code === 2);
    // superbee's private-state identity must not drift to the library package coordinate.
    assert.equal((await readdir(home)).some(name => name.includes("cli") || name === "@superbee"), false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("embedded engine check rejects an incomplete record and non-source engine inputs", async () => {
  const manifestOf = await workspaceManifests();
  const isTracked = await trackedPaths();
  const metafile = await readJson(path.join(root, "out/cli-runtime-metafile.json"));
  const record = await readJson(path.join(root, "packages/cli/dist/embedded-engine.json"));
  assert.deepEqual(embeddedEngineErrors(record, metafile, manifestOf, isTracked, treeComparison), []);
  const withCore = value => ({ ...record, packages: record.packages.map(row => row.name === "@superbee/core" ? { ...row, source_identical_to_release_tag: value } : row) });
  // A build without the release tag legitimately records null, so the probe supplies its own comparison.
  const compared = withCore(false);
  // The probe's own expectation for core: null when any embedded core input is untracked.
  const coreInputs = Object.keys(metafile.inputs).map(input => path.relative(root, path.resolve(root, "packages/cli", input)).split(path.sep).join("/")).filter(input => input.startsWith("packages/core/src/"));
  const measured = coreInputs.every(isTracked) ? treeComparison("core", record.packages.find(row => row.name === "@superbee/core").release_tag) : null;
  assert.ok([true, false, null].includes(measured));
  const rerouted = target => ({ inputs: Object.fromEntries(Object.entries(metafile.inputs).map(([input, value]) => [input === "../core/src/index.ts" ? target : input, value])) });
  assert.ok("../core/src/index.ts" in metafile.inputs);
  for (const [label, candidate, inputs, expected] of [
    ["missing contributor", { ...record, packages: record.packages.filter(row => row.name !== "@superbee/server") }, metafile, /^packages: bundle contributor @superbee\/server is missing from the record$/],
    ["installed core", record, rerouted("../../node_modules/@superbee/core/dist/index.js"), /^input \S+: @superbee\/core resolves to an installed package, not workspace source$/],
    ["built core", record, rerouted("../core/dist/index.js"), /^input \S+: @superbee\/core resolves outside workspace source$/],
    ["core outside the repository", record, rerouted("../../../elsewhere/core/src/index.ts"), /^input \S+: resolves outside the repository$/],
    ["uncontributing row", { ...record, packages: [...record.packages, { name: "@superbee/publication", version: "0.0.0", release_tag: null, source_identical_to_release_tag: null }] }, metafile, /^packages\[\d+\]: @superbee\/publication contributes no bundle input$/],
    ["equality claim", { ...record, packages: record.packages.map(row => row.name === "@superbee/core" ? { ...row, source_identical_to_release_tag: "matches" } : row) }, metafile, /^record asserts a match/],
    ["untagged measurement", { ...record, packages: record.packages.map(row => row.name === "@superbee/board-git" ? { ...row, source_identical_to_release_tag: true } : row) }, metafile, /^packages\[\d+\]: source_identical_to_release_tag is not a measurement against null$/],
    ["malformed source", { ...record, source: { commit: "HEAD", dirty: false } }, metafile, /^source: expected/],
    ...[true, false, null].filter(value => value !== measured).map(value => [`fabricated ${value} comparison`, withCore(value), metafile, new RegExp(`^packages\\[\\d+\\]: source_identical_to_release_tag is ${value} but the tree measures ${measured}(; .* is not tracked by git)?$`)]),
    ["comparison over an untracked input", compared, { inputs: { ...metafile.inputs, "../core/src/generated/assets.ts": {} } }, /^packages\[\d+\]: source_identical_to_release_tag is false but the tree measures null; (.*, )?\.\.\/core\/src\/generated\/assets\.ts is not tracked by git$/],
  ]) {
    const errors = embeddedEngineErrors(candidate, inputs, manifestOf, isTracked, treeComparison);
    assert.ok(errors.some(error => expected.test(error)), `${label}: ${JSON.stringify(errors)}`);
  }
});

test("release-tag comparison is reported only for a clean package tree with a reachable tag", () => {
  const metafile = { inputs: { "src/index.ts": {}, "../core/src/index.ts": {}, "../server/src/index.ts": {}, "../board-git/src/index.ts": {}, "../../node_modules/pako/index.js": {}, "../core/node_modules/nested/index.js": {} } };
  const manifestOf = directory => ({ name: `@superbee/${directory}`, version: "1.2.3-pre.4" });
  const source = { commit: "a".repeat(40), dirty: false };
  const measure = (changedPaths, git, inputs = metafile) => {
    const calls = [];
    const record = embeddedEngineRecord({ metafile: inputs, source, changedPaths, manifestOf, git: args => { calls.push(args); return git(args); } });
    assert.deepEqual(record.packages.map(row => [row.name, row.release_tag]), [["@superbee/board-git", null], ["@superbee/core", "libraries/v1.2.3-pre.4"], ["@superbee/server", "libraries/v1.2.3-pre.4"]]);
    assert.equal(record.source, source);
    return { calls, states: Object.fromEntries(record.packages.map(row => [row.name.slice(10), row.source_identical_to_release_tag])) };
  };
  // Tracked paths are the fixture's committed sources; a generated module under core is not among them.
  const tracked = ["packages/core/src/index.ts", "packages/server/src/index.ts", "packages/board-git/src/index.ts"];
  const tagged = differs => args => args[0] === "ls-files"
    ? { status: 0, stdout: tracked.filter(path => path.startsWith(`${args.at(-1)}/`)).join("\0") + "\0" }
    : { status: args[0] === "diff" && args.at(-1) === differs ? 1 : 0, stdout: "" };
  const identical = measure([], tagged(""));
  assert.deepEqual(identical.states, { "board-git": null, core: true, server: true });
  assert.deepEqual(identical.calls.filter(args => args[0] === "diff"), ["core", "server"].map(directory => ["diff", "--quiet", "refs/tags/libraries/v1.2.3-pre.4", "HEAD", "--", `packages/${directory}`]));
  assert.deepEqual(measure([], tagged("packages/core")).states, { "board-git": null, core: false, server: true });
  // HEAD equal to the tag proves nothing about edits the bundler read from the working tree.
  assert.deepEqual(measure(["packages/core/src/index.ts", "packages/cli/build.mjs"], tagged("")).states, { "board-git": null, core: null, server: true });
  assert.deepEqual(measure(["packages/old.ts", "packages/server/new.ts"], tagged("")).states, { "board-git": null, core: true, server: null });
  assert.deepEqual(measure(null, tagged("")).states, { "board-git": null, core: null, server: null });
  const generated = { inputs: { ...metafile.inputs, "../core/src/generated/assets.ts": {} } };
  assert.deepEqual(measure([], tagged(""), generated).states, { "board-git": null, core: null, server: true });
  assert.deepEqual(measure([], args => args[0] === "ls-files" ? { status: 128, stdout: "" } : tagged("")(args)).states, { "board-git": null, core: null, server: null });
  assert.deepEqual(measure([], args => ({ status: args[0] === "rev-parse" ? 1 : 0, stdout: "" })).states, { "board-git": null, core: null, server: null });
  assert.deepEqual(measure([], () => null).states, { "board-git": null, core: null, server: null });
  assert.deepEqual(measure([], args => ({ status: args[0] === "diff" ? 128 : 0, stdout: "" })).states, { "board-git": null, core: null, server: null });
  assert.throws(() => embeddedEngineRecord({ metafile, source, changedPaths: [], git: tagged(""), manifestOf: () => ({ name: "superbee", version: "1.0.0" }) }), /not a versioned @superbee workspace/);
});
