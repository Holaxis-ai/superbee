import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, readdir, lstat, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { init, parse } from "es-module-lexer";
import { build } from "esbuild";
import ts from "typescript";
import { versionPattern } from "./package-version-policy.mjs";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const readJson = async file => JSON.parse(await readFile(file, "utf8"));

// This one opt-in extension is intentionally not a bundled dependency. Freeze its entire
// compiled guard/loader shape; future loader changes require a reviewed proof-policy change.
const authorProfileLoader = String.raw`async function explicitProfile(input) {
  try {
    assertPathOutsidePrivateState(input);
    if (!/\.(?:mjs|js)$/.test(input)) return void 0;
    const resolved = await filesystem.realpath(paths.resolve(input));
    if (!(await filesystem.stat(resolved)).isFile()) return void 0;
    const module = await import(fileURL(resolved).href);
    const selected = isRecord(module) ? module.default ?? module.profile : void 0;
    if (!isRecord(selected) || typeof selected.id !== "string" || containsCredentialText(selected.id) || !Number.isSafeInteger(selected.version) || selected.version < 1 || typeof selected.kind !== "string" || !["generic", "extension"].includes(selected.kind) || typeof selected.validateSpec !== "function" || typeof selected.hostsFor !== "function" || typeof selected.observe !== "function") return void 0;
    return selected;
  } catch { return void 0; }
}`;
const printer = ts.createPrinter({ removeComments: true });
function printed(node, source, names = new Map()) {
  const transformed = ts.transform(node, [context => {
    const visit = child => ts.isIdentifier(child) && names.has(child.text)
      && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)
      ? ts.factory.createIdentifier(names.get(child.text)) : ts.visitEachChild(child, visit, context);
    return root => ts.visitNode(root, visit);
  }]);
  try { return printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0], source); }
  finally { transformed.dispose(); }
}

export async function assertClosedCliImports(text) {
  await init;
  const [imports] = parse(text);
  const external = imports.filter(item => item.d !== -2 && !item.n?.startsWith("node:"));
  if (!external.length) return;
  assert.equal(external.length, 1, "unclosed imports outside the explicit author-profile boundary");
  assert.equal(external[0].n, undefined, `unclosed import ${external[0].n}`);
  const source = ts.createSourceFile("retained-cli.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0, "invalid retained CLI syntax");
  const loaders = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "explicitProfile");
  assert.equal(loaders.length, 1, "missing unique explicit author-profile loader");
  const loader = loaders[0];
  assert.equal(loader.parameters.length, 1);
  assert.ok(ts.isIdentifier(loader.parameters[0].name));
  const names = new Map([[loader.parameters[0].name.text, "input"]]);
  const importBindings = new Map();
  for (const node of source.statements.filter(ts.isImportDeclaration)) {
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (specifier === "node:path" && clause?.name) importBindings.set(clause.name.text, "paths");
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const entry of clause.namedBindings.elements) {
      const imported = entry.propertyName?.text ?? entry.name.text;
      if (specifier === "node:fs" && imported === "promises") importBindings.set(entry.name.text, "filesystem");
      if (specifier === "node:url" && imported === "pathToFileURL") importBindings.set(entry.name.text, "fileURL");
    }
  }
  const importsInLoader = [], locals = [];
  let recordName;
  function visit(node) {
    if (ts.isVariableDeclaration(node)) locals.push(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) importsInLoader.push(node);
    if (ts.isConditionalExpression(node) && ts.isCallExpression(node.condition) && ts.isIdentifier(node.condition.expression)) recordName = node.condition.expression.text;
    if (ts.isIdentifier(node) && importBindings.has(node.text)) names.set(node.text, importBindings.get(node.text));
    ts.forEachChild(node, visit);
  }
  visit(loader);
  assert.equal(locals.length, 3, "changed author-profile loader locals");
  for (const [index, name] of ["resolved", "module", "selected"].entries()) {
    assert.ok(ts.isIdentifier(locals[index].name)); names.set(locals[index].name.text, name);
  }
  assert.ok(recordName, "missing profile shape predicate"); names.set(recordName, "isRecord");
  // Do not let an unrelated predicate gain authority just because it has the expected call shape.
  const predicates = [];
  function findPredicate(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === recordName && node.initializer) predicates.push(node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === recordName) predicates.push(node.right);
    ts.forEachChild(node, findPredicate);
  }
  findPredicate(source);
  assert.equal(predicates.length, 1);
  const predicate = predicates[0];
  assert.ok(ts.isArrowFunction(predicate) && predicate.parameters.length === 1 && ts.isIdentifier(predicate.parameters[0].name));
  const predicateNames = new Map([[predicate.parameters[0].name.text, "value"]]);
  const expectedPredicate = ts.createSourceFile("predicate.mjs", '(value) => value !== null && typeof value === "object" && !Array.isArray(value)', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(printed(predicate, source, predicateNames), printed(expectedPredicate.statements[0].expression, expectedPredicate), "changed profile shape predicate");
  const expected = ts.createSourceFile("loader.mjs", authorProfileLoader, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(printed(loader, source, names), printed(expected.statements[0], expected), "changed explicit author-profile loader shape");
  assert.equal(importsInLoader.length, 1);
  assert.equal(importsInLoader[0].getStart(source), external[0].ss, "unclosed import outside guarded loader");
  assert.equal(importsInLoader[0].end, external[0].se);
  const references = [];
  function findReferences(node) {
    if (ts.isIdentifier(node) && node.text === "explicitProfile" && node !== loader.name) references.push(node);
    ts.forEachChild(node, findReferences);
  }
  findReferences(source);
  assert.equal(references.length, 1, "unexpected explicit-profile loader reference");
  const call = references[0].parent, awaited = call.parent, conditional = awaited.parent;
  assert.ok(ts.isCallExpression(call) && ts.isAwaitExpression(awaited) && ts.isConditionalExpression(conditional));
  const fallback = conditional.whenFalse;
  assert.ok(ts.isCallExpression(fallback) && fallback.arguments.length === 1 && ts.isPropertyAccessExpression(fallback.arguments[0]) && ts.isIdentifier(fallback.arguments[0].expression));
  const sourceName = fallback.arguments[0].expression.text;
  assert.match(sourceName, /^source\d*$/);
  assert.equal(printed(conditional, source, new Map([[sourceName, "source"]])), "options.profile ? await explicitProfile(options.profile) : getSourceProfile(source.profile)", "profile loading must be explicitly selected");
  let owner = conditional;
  while (owner.parent && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
  assert.ok(ts.isFunctionDeclaration(owner) && owner.name?.text === "testSourceForAuthor", "unexpected profile-loader owner");
}

// Independent derivation of what the artifact embeds and which tree built it. `runtime` is the
// runtime bundle's metafile (inputs relative to packages/cli); `assets` are repo-relative paths
// the proof located in the asset stages; `manifestOf` maps a packages/ directory to its manifest;
// `head` is this tree's {commit, dirty}, or null facts when git is unavailable.
export function embeddedEngineErrors(record, { runtime, assets }, manifestOf, head) {
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
  // The supplied artifact must have been built from this tree.
  else if (source.commit !== head.commit || source.dirty !== head.dirty) errors.push(`source: ${JSON.stringify(source)} does not describe this tree (stale or fabricated build); expected ${JSON.stringify(head)} from git`);
  if (Object.keys(record ?? {}).sort().join() !== "packages,schema,source") errors.push("record: unexpected top-level fields");
  return errors;
}
// This tree's own {commit, dirty}; null facts when git is unavailable, as the record would carry.
export const treeFacts = () => {
  const git = args => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: status.status === 0 ? status.stdout !== "" : null };
};
export const workspaceManifests = async () => {
  const manifests = new Map();
  for (const directory of await readdir(path.join(root, "packages"))) manifests.set(directory, await readJson(path.join(root, "packages", directory, "package.json")).catch(() => undefined));
  return directory => manifests.get(directory);
};
const walk = async directory => (await readdir(directory, { withFileTypes: true, recursive: true })).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
// What the built artifact embeds, located without the build's own list: the runtime metafile, the
// MCP resources' modules bundled again here, and the UI files whose gzip payloads sit in the bundle.
export const embeddedInventory = async (bundleFile = path.join(root, "packages/cli/dist/index.mjs")) => {
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
  const bundle = await readFile(bundleFile, "utf8");
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

// Read the opened inode, never a pathname checked earlier. O_NONBLOCK also lets fstat
// reject special files without waiting for a FIFO writer.
async function readRetainedFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ELOOP") throw new Error("retained artifact must be a regular file", { cause: error });
    throw error;
  }
  try {
    assert.ok((await handle.stat()).isFile(), "retained artifact must be a regular file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

// All pathname-based tools consume one private snapshot of the descriptor-read bytes.
// This copies the archive verbatim; it does not extract, rebuild or repack it.
export async function withRetainedTarball(tarball, consume) {
  const directory = await mkdtemp(path.join(tmpdir(), "superbee-cli-retained-"));
  try {
    const bytes = await readRetainedFile(tarball);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const snapshot = path.join(directory, "superbee-cli.tgz");
    await writeFile(snapshot, bytes, { flag: "wx", mode: 0o400 });
    const result = await consume(snapshot, sha256);
    assert.ok((await readRetainedFile(snapshot)).equals(bytes), "private tarball snapshot changed during proof");
    assert.ok((await readRetainedFile(tarball)).equals(bytes), "retained tarball changed during proof");
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function validateCliTarEntries(entries) {
  for (const entry of entries) {
    const segments = entry.split("/");
    const canonical = segments.every(segment => segment !== "" && segment !== "." && segment !== "..");
    const allowed = entry === "package/package.json" || entry === "package/README.md"
      || (segments[0] === "package" && segments[1] === "dist" && segments.length > 2);
    assert.ok(canonical && allowed, `unexpected tar entry ${JSON.stringify(entry)}`);
  }
}

// Development tests own build/pack setup; this proof consumes the retained CLI and
// auxiliary workspace inventory evidence without rebuilding or repacking that CLI.
export async function proveCliTarball(tarball, { checkSource, execute = exec } = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-cli-consumer-"));
  const npm = process.env.npm_execpath;
  assert.ok(npm, "run through npm test:scripts or npm exec");
  const run = (args, cwd = scratch, env = {}) => execute(process.execPath, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
  try {
    return await withRetainedTarball(tarball, async (snapshot, before) => {
      const listing = (await exec("tar", ["-tzf", snapshot])).stdout.trimEnd().split("\n");
      validateCliTarEntries(listing);
      const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
      await writeFile(path.join(scratch, "package.json"), JSON.stringify({ private: true, type: "module", devDependencies: { "@types/node": lock.packages["node_modules/@types/node"].version }, dependencies: { "@superbee/cli": `file:${snapshot}` } }));
      // Node adapter declarations need consumer-owned Node types; cold caches require registry metadata.
      await run([npm, "install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
      const library = path.join(scratch, "node_modules/@superbee/cli");
      assert.equal((await lstat(library)).isSymbolicLink(), false);
      assert.deepEqual(await readdir(path.join(scratch, "node_modules/@superbee")), ["cli"]);
      const pkg = JSON.parse(await readFile(path.join(library, "package.json"), "utf8"));
      const workspace = await readJson(path.join(root, "packages/cli/package.json"));
      assert.equal(pkg.name, "@superbee/cli");
      assert.equal(pkg.private, undefined); assert.equal(pkg.version, workspace.version); assert.match(pkg.version, versionPattern); assert.equal(pkg.bin, undefined);
      assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
      for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) assert.equal(pkg[key], undefined);
      assert.ok(listing.includes("package/dist/embedded-engine.json"));
      // The record is data, read through its export without loading the library.
      await writeFile(path.join(scratch, "engine.cjs"), "process.stdout.write(JSON.stringify(require('@superbee/cli/embedded-engine.json')));\n");
      const record = JSON.parse((await run([path.join(scratch, "engine.cjs")])).stdout);
      assert.deepEqual(record, await readJson(path.join(library, "dist/embedded-engine.json")));
      assert.deepEqual(embeddedEngineErrors(record, await embeddedInventory(path.join(library, "dist/index.mjs")), await workspaceManifests(), treeFacts()), []);
      // Compare actual installed bytes; the workspace cannot stand in for the retained artifact.
      assert.equal(createHash("sha256").update(await readFile(path.join(library, "dist/index.mjs"))).digest("hex"), createHash("sha256").update(await readFile(path.join(root, "packages/cli/dist/index.mjs"))).digest("hex"), "packed runtime differs from the proved build");
      if (checkSource) checkSource(record, await workspaceManifests());
      await assertClosedCliImports(await readFile(path.join(library, "dist/index.mjs"), "utf8"));
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
      return { record, manifest: pkg, sha256: before };
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
