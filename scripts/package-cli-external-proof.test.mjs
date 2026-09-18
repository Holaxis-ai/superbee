import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { init, parse } from "es-module-lexer";
import { build } from "esbuild";
import { versionPattern } from "./package-version-policy.mjs";
import { before } from "node:test";
import { embeddedEngineRecord } from "../packages/cli/scripts/embedded-engine.mjs";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const readJson = async file => JSON.parse(await readFile(file, "utf8"));

// Independent derivation of what the artifact embeds and which tree built it. `runtime` is the
// runtime bundle's metafile (inputs relative to packages/cli); `assets` are repo-relative paths
// the proof located in the asset stages; `manifestOf` maps a packages/ directory to its manifest;
// `head` is this tree's {commit, dirty}, or null facts when git is unavailable.
function embeddedEngineErrors(record, { runtime, assets }, manifestOf, head) {
  const errors = [];
  const contributors = new Map();
  for (const input of Object.keys(runtime.inputs ?? {})) {
    const parts = path.relative(root, path.resolve(root, "packages/cli", input)).split(path.sep);
    if (parts[0] === "..") errors.push(`input ${input}: resolves outside the repository`);
    const scoped = parts.indexOf("@superbee");
    if (scoped > 0 && parts[scoped - 1] === "node_modules") errors.push(`input ${input}: @superbee/${parts[scoped + 1]} resolves to an installed package, not workspace source`);
    if (parts[0] !== "packages" || parts.includes("node_modules") || parts[1] === "cli") continue;
    const manifest = manifestOf(parts[1]);
    if (!manifest?.name?.startsWith("@superbee/")) errors.push(`input ${input}: packages/${parts[1]} is not an @superbee workspace`);
    else if (parts[2] !== "src") errors.push(`input ${input}: ${manifest.name} resolves outside workspace source`);
    else contributors.set(manifest.name, manifest.version);
  }
  // Asset stages embed compiled output, so their inputs may be a workspace's dist/.
  for (const asset of assets) {
    const parts = asset.split("/");
    const manifest = parts[0] === "packages" && !parts.includes("node_modules") && parts[1] !== "cli" ? manifestOf(parts[1]) : undefined;
    if (!manifest?.name?.startsWith("@superbee/")) errors.push(`asset ${asset}: not @superbee workspace content`);
    else contributors.set(manifest.name, manifest.version);
  }
  if (record?.schema !== "superbee.cli-embedded-engine.v2") errors.push(`schema: found ${JSON.stringify(record?.schema)}`);
  if (/match|identical/i.test(JSON.stringify(record))) errors.push("record asserts equality with a release; it may only name what it embeds");
  const rows = Array.isArray(record?.packages) ? record.packages : [];
  if (!Array.isArray(record?.packages)) errors.push("packages: expected an array");
  const recorded = rows.map(row => row?.name);
  for (const name of contributors.keys()) if (!recorded.includes(name)) errors.push(`packages: bundle contributor ${name} is missing from the record`);
  for (const [index, row] of rows.entries()) {
    const at = `packages[${index}]`;
    if (Object.keys(row ?? {}).sort().join() !== "name,release_tag,version") { errors.push(`${at}: unexpected fields`); continue; }
    if (recorded.indexOf(row.name) !== index) errors.push(`${at}: duplicate ${row.name}`);
    if (!contributors.has(row.name)) { errors.push(`${at}: ${row.name} contributes no bundle input`); continue; }
    if (row.version !== contributors.get(row.name)) errors.push(`${at}: version ${row.version} is not the workspace manifest version`);
    const tag = ["@superbee/core", "@superbee/server"].includes(row.name) ? `libraries/v${row.version}` : null;
    if (row.release_tag !== tag) errors.push(`${at}: release_tag ${JSON.stringify(row.release_tag)}; expected ${JSON.stringify(tag)}`);
  }
  const source = record?.source;
  if (Object.keys(source ?? {}).sort().join() !== "commit,dirty" || !(source.commit === null || /^[a-f0-9]{40}$/.test(source.commit)) || !(source.dirty === null || typeof source.dirty === "boolean")) errors.push("source: expected {commit: 40-hex|null, dirty: boolean|null}");
  // The proof builds the artifact from this tree, so its source facts must be this tree's.
  else if (source.commit !== head.commit || source.dirty !== head.dirty) errors.push(`source: ${JSON.stringify(source)} does not describe this tree (stale or fabricated build); expected ${JSON.stringify(head)} from git`);
  if (Object.keys(record ?? {}).sort().join() !== "packages,schema,source") errors.push("record: unexpected top-level fields");
  return errors;
}
// This tree's own {commit, dirty}; null facts when git is unavailable, as the record would carry.
const treeFacts = () => {
  const git = args => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: status.status === 0 ? status.stdout !== "" : null };
};
const workspaceManifests = async () => {
  const manifests = new Map();
  for (const directory of await readdir(path.join(root, "packages"))) manifests.set(directory, await readJson(path.join(root, "packages", directory, "package.json")).catch(() => undefined));
  return directory => manifests.get(directory);
};
const walk = async directory => (await readdir(directory, { withFileTypes: true, recursive: true })).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
// What the built artifact embeds, located without the build's own list: the runtime metafile, the
// MCP resources' modules bundled again here, and the UI files whose gzip payloads sit in the bundle.
const embeddedInventory = async () => {
  const runtime = await readJson(path.join(root, "out/cli-runtime-metafile.json"));
  const assets = new Set();
  const mcpRoot = path.join(root, "packages/mcp-app");
  for (const entry of ["view", "document"]) {
    const result = await build({ entryPoints: [path.join(mcpRoot, "src", `${entry}.ts`)], bundle: true, platform: "browser", format: "iife", target: "es2022", write: false, logLevel: "silent", metafile: true, absWorkingDir: mcpRoot });
    for (const input of Object.keys(result.metafile.inputs)) {
      const parts = path.relative(root, path.resolve(mcpRoot, input)).split(path.sep);
      if (parts[0] === "packages" && !parts.includes("node_modules")) assets.add(parts.join("/"));
    }
  }
  const bundle = await readFile(path.join(root, "packages/cli/dist/index.mjs"), "utf8");
  const payloads = new Set([...bundle.matchAll(/gzipBase64: "([A-Za-z0-9+/=]+)"/g)].map(([, base64]) => createHash("sha256").update(gunzipSync(Buffer.from(base64, "base64"))).digest("hex")));
  const uiDist = path.join(root, "packages/ui/dist");
  const uiFiles = await walk(uiDist);
  assert.ok(uiFiles.length > 0 && payloads.size > 0);
  for (const file of uiFiles) {
    assert.ok(payloads.has(createHash("sha256").update(await readFile(file)).digest("hex")), `${file} is not embedded in the bundle`);
    assets.add(path.relative(root, file).split(path.sep).join("/"));
  }
  return { runtime, assets: [...assets].sort() };
};

// The record describes the tree it was built from; build here so the record and HEAD agree.
before(async () => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, "run through npm test:scripts or npm exec");
  await exec(process.execPath, [npm, "run", "build", "-w", "@superbee/cli"], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
});

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
    assert.deepEqual(embeddedEngineErrors(record, await embeddedInventory(), await workspaceManifests(), treeFacts()), []);
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
});test("embedded engine check rejects an incomplete record, non-source engine inputs and foreign source facts", async () => {
  const manifestOf = await workspaceManifests();
  const head = treeFacts();
  const inventory = await embeddedInventory();
  const record = await readJson(path.join(root, "packages/cli/dist/embedded-engine.json"));
  assert.deepEqual(embeddedEngineErrors(record, inventory, manifestOf, head), []);
  assert.ok(inventory.assets.some(asset => asset.startsWith("packages/ui/dist/")) && record.packages.some(row => row.name === "@superbee/ui"));
  const withCore = patch => ({ ...record, packages: record.packages.map(row => row.name === "@superbee/core" ? { ...row, ...patch } : row) });
  const rerouted = target => ({ ...inventory, runtime: { inputs: Object.fromEntries(Object.entries(inventory.runtime.inputs).map(([input, value]) => [input === "../core/src/index.ts" ? target : input, value])) } });
  assert.ok("../core/src/index.ts" in inventory.runtime.inputs);
  for (const [label, candidate, inputs, expected] of [
    ["missing contributor", { ...record, packages: record.packages.filter(row => row.name !== "@superbee/server") }, inventory, /^packages: bundle contributor @superbee\/server is missing from the record$/],
    ["missing asset-only contributor", { ...record, packages: record.packages.filter(row => row.name !== "@superbee/ui") }, inventory, /^packages: bundle contributor @superbee\/ui is missing from the record$/],
    ["installed core", record, rerouted("../../node_modules/@superbee/core/dist/index.js"), /^input \S+: @superbee\/core resolves to an installed package, not workspace source$/],
    ["built core", record, rerouted("../core/dist/index.js"), /^input \S+: @superbee\/core resolves outside workspace source$/],
    ["core outside the repository", record, rerouted("../../../elsewhere/core/src/index.ts"), /^input \S+: resolves outside the repository$/],
    ["foreign asset", record, { ...inventory, assets: [...inventory.assets, "node_modules/@superbee/ui/dist/index.html"] }, /^asset \S+: not @superbee workspace content$/],
    ["uncontributing row", { ...record, packages: [...record.packages, { name: "@superbee/publication", version: "0.0.0", release_tag: null }] }, inventory, /^packages\[\d+\]: @superbee\/publication contributes no bundle input$/],
    ["foreign version", withCore({ version: "9.9.9", release_tag: "libraries/v9.9.9" }), inventory, /^packages\[\d+\]: version 9.9.9 is not the workspace manifest version$/],
    ["wrong release tag", withCore({ release_tag: null }), inventory, /^packages\[\d+\]: release_tag null; expected "libraries\/v[^"]+"$/],
    ["equality claim", withCore({ release_match: true }), inventory, /^record asserts equality with a release/],
    ["unexpected row field", withCore({ verified: true }), inventory, /^packages\[\d+\]: unexpected fields$/],
    ["unexpected top-level field", { ...record, matches_release: true }, inventory, /^record asserts equality|^record: unexpected top-level fields$/],
    ["malformed source", { ...record, source: { commit: "HEAD", dirty: false } }, inventory, /^source: expected/],
    ["foreign commit", { ...record, source: { ...record.source, commit: "0".repeat(40) } }, inventory, /^source: .* does not describe this tree \(stale or fabricated build\)/],
    ["flipped dirty flag", { ...record, source: { ...record.source, dirty: record.source.dirty === null ? true : !record.source.dirty } }, inventory, /^source: .* does not describe this tree \(stale or fabricated build\)/],
  ]) {
    const errors = embeddedEngineErrors(candidate, inputs, manifestOf, head);
    assert.ok(errors.some(error => expected.test(error)), `${label}: ${JSON.stringify(errors)}`);
  }
});

test("record rows name every embedded workspace and its release tag; source facts are null without git", () => {
  const inputs = ["packages/cli/src/index.ts", "packages/core/src/index.ts", "packages/server/src/index.ts", "packages/board-git/src/index.ts", "packages/ui/dist/index.html", "node_modules/pako/index.js", "packages/core/node_modules/nested/index.js"];
  const manifestOf = directory => ({ name: `@superbee/${directory}`, version: "1.2.3-pre.4" });
  const source = { commit: "a".repeat(40), dirty: false };
  const record = embeddedEngineRecord({ inputs, source, manifestOf });
  assert.deepEqual(record, { schema: "superbee.cli-embedded-engine.v2", source, packages: [
    { name: "@superbee/board-git", version: "1.2.3-pre.4", release_tag: null },
    { name: "@superbee/core", version: "1.2.3-pre.4", release_tag: "libraries/v1.2.3-pre.4" },
    { name: "@superbee/server", version: "1.2.3-pre.4", release_tag: "libraries/v1.2.3-pre.4" },
    { name: "@superbee/ui", version: "1.2.3-pre.4", release_tag: null },
  ] });
  assert.throws(() => embeddedEngineRecord({ inputs, source, manifestOf: () => ({ name: "superbee", version: "1.0.0" }) }), /not a versioned @superbee workspace/);
  // Unknown is represented explicitly: with no git on PATH the facts are null, never invented.
  const facts = execFileSync(process.execPath, ["--input-type=module", "-e", "import { currentSourceFacts } from './packages/cli/scripts/source-facts.mjs'; process.stdout.write(JSON.stringify(currentSourceFacts()));"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.deepEqual(JSON.parse(facts), { commit: null, dirty: null });
});
