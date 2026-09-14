import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { init, parse } from "es-module-lexer";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("packed reusable CLI is closed, inert on import, and binds commands to its executable", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-cli-consumer-"));
  const npm = process.env.npm_execpath;
  assert.ok(npm, "run through npm test:scripts or npm exec");
  const run = (args, cwd = scratch, env = {}) => exec(process.execPath, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
  try {
    const packed = await run([npm, "pack", "-w", "@superbee/cli", "--json", "--pack-destination", scratch], root);
    const [receipt] = JSON.parse(packed.stdout);
    assert.ok(receipt.files.every(({ path: file }) => ["package.json", "README.md"].includes(file) || file.startsWith("dist/")));
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@superbee/cli": `file:${path.join(scratch, receipt.filename)}` } }));
    await run([npm, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const library = path.join(scratch, "node_modules/@superbee/cli");
    assert.equal((await lstat(library)).isSymbolicLink(), false);
    assert.deepEqual(await readdir(path.join(scratch, "node_modules/@superbee")), ["cli"]);
    const pkg = JSON.parse(await readFile(path.join(library, "package.json"), "utf8"));
    assert.equal(pkg.private, true); assert.equal(pkg.version, "0.0.0"); assert.equal(pkg.bin, undefined);
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) assert.equal(pkg[key], undefined);
    await init;
    const [imports] = parse(await readFile(path.join(library, "dist/index.mjs"), "utf8"));
    for (const imported of imports.filter(item => item.d !== -2)) assert.ok(imported.n?.startsWith("node:"), `unclosed import ${imported.n}`);
    await writeFile(path.join(scratch, "consumer.ts"), `import { main, configureSourceIdentity, registerExecutableEntry, buildIdentityEnvelope, type BuildIdentityEnvelope } from '@superbee/cli';\nconfigureSourceIdentity({ name: 'superbee', version: '1.2.3' });\nregisterExecutableEntry('fixture.mjs');\nconst identity: BuildIdentityEnvelope = buildIdentityEnvelope();\nvoid main(['help']); void identity;\n`);
    await writeFile(path.join(scratch, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ES2022", types: [], skipLibCheck: false }, files: ["consumer.ts"] }));
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
    assert.equal((await readdir(home)).some(name => name.includes("cli-runtime") || name === "@superbee"), false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
