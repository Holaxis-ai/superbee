import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const manifestAt = async directory => JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));

test("packed browser-local exposes browser-safe recovery and checked declarations outside the workspace", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-browser-local-consumer-"));
  const run = (command, args, cwd = scratch) => exec(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  const npm = (args, cwd = scratch) => {
    assert.ok(process.env.npm_execpath, "run through npm run test:scripts");
    return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
  };
  try {
    const artifacts = path.join(scratch, "artifacts");
    await mkdir(artifacts);
    const sourceCore = await manifestAt(path.join(root, "packages/core"));
    const sourceBrowser = await manifestAt(path.join(root, "packages/browser-local"));
    assert.notEqual(sourceBrowser.version, "0.0.0");
    assert.equal(sourceBrowser.dependencies["@superbee/core"], sourceCore.version, "the consumer must use the exact paired core release");
    const packed = {};
    // CI builds first. This proof packs those outputs; it is not a publication or staging step.
    for (const name of ["core", "browser-local"]) {
      const { stdout } = await npm(["pack", "-w", `@superbee/${name}`, "--json", "--pack-destination", artifacts], root);
      const [receipt] = JSON.parse(stdout);
      assert.equal(receipt.name, `@superbee/${name}`);
      assert.ok(receipt.files.some(file => file.path === "dist/index.d.ts"));
      packed[name] = { receipt, tarball: path.join(artifacts, receipt.filename) };
    }
    const allowedDocuments = new Set(["README.md", "EDITOR-RECOVERY.md", "CONFLICT-RECOVERY.md", "LICENSE"]);
    const paths = packed["browser-local"].receipt.files.map(file => file.path);
    for (const file of paths) {
      assert.ok(file === "package.json" || file.startsWith("dist/") || allowedDocuments.has(file), `unexpected packed file ${file}`);
    }
    for (const file of ["dist/index.js", "dist/index.d.ts", "dist/editor-recovery.js", "dist/editor-recovery.d.ts"]) assert.ok(paths.includes(file), `missing ${file}`);
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({
      name: "browser-local-external-proof", private: true, type: "module",
      dependencies: {
        "@superbee/core": `file:${packed.core.tarball}`,
        "@superbee/browser-local": `file:${packed["browser-local"].tarball}`,
      },
      devDependencies: { "@types/node": sourceCore.devDependencies["@types/node"] },
    }));
    await npm(["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const lock = JSON.parse(await readFile(path.join(scratch, "package-lock.json"), "utf8"));
    for (const [name, row] of Object.entries(lock.packages)) {
      assert.ok(!row.link, `workspace link in external install: ${name}`);
      if (name.includes("node_modules/@superbee/")) assert.ok(["node_modules/@superbee/core", "node_modules/@superbee/browser-local"].includes(name), `unexpected workspace dependency ${name}`);
    }
    for (const name of ["core", "browser-local"]) {
      const directory = path.join(scratch, "node_modules/@superbee", name);
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
      assert.ok((await realpath(directory)).startsWith(await realpath(scratch)));
      const row = lock.packages[`node_modules/@superbee/${name}`];
      assert.equal(row.version, name === "core" ? sourceCore.version : sourceBrowser.version);
      assert.ok(row.resolved.startsWith("file:"), `must install literal ${name} tarball`);
      assert.equal(row.integrity, packed[name].receipt.integrity, `installed ${name} must match packed bytes`);
    }
    const installed = await manifestAt(path.join(scratch, "node_modules/@superbee/browser-local"));
    assert.equal(installed.private, undefined);
    assert.equal(installed.version, sourceBrowser.version);
    assert.deepEqual(installed.dependencies, { "@superbee/core": sourceCore.version });
    assert.deepEqual(installed.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
    assert.deepEqual(installed.files, sourceBrowser.files);
    assert.deepEqual(installed.exports, {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./editor-recovery": { types: "./dist/editor-recovery.d.ts", default: "./dist/editor-recovery.js" },
    });
    for (const entry of ["@superbee/browser-local", "@superbee/browser-local/editor-recovery"]) {
      const result = await build({
        absWorkingDir: scratch,
        stdin: { contents: `export * from ${JSON.stringify(entry)};`, resolveDir: scratch, sourcefile: "browser-consumer.js" },
        bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
      });
      assert.ok(result.outputFiles[0].text.length > 0);
      for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
        assert.ok(!input.includes(root), `workspace source leaked: ${input}`);
        assert.ok(!builtins.has(input) && !input.startsWith("node:"), `Node builtin leaked: ${input}`);
        for (const dependency of metadata.imports) assert.ok(!builtins.has(dependency.path) && !dependency.path.startsWith("node:"), `Node import ${dependency.path}`);
      }
      for (const output of Object.values(result.metafile.outputs)) {
        for (const dependency of output.imports) assert.ok(!dependency.external && !builtins.has(dependency.path) && !dependency.path.startsWith("node:"), `non-browser output import ${dependency.path}`);
      }
    }
    await writeFile(path.join(scratch, "consumer.ts"), `
import { openLocalBundle, withEditorRecovery as rootRecovery, type LocalBundle } from "@superbee/browser-local";
import { withEditorRecovery, type EditorRecoveryScope, type EditorPreparedAttempt } from "@superbee/browser-local/editor-recovery";
const scope: EditorRecoveryScope = { endpoint: "https://example.test", principalScope: "p", workspace: "w", bundle: "b", installation: "i", registrationScope: "r" };
const local: LocalBundle = openLocalBundle("consumer");
const sameAPI: typeof withEditorRecovery = rootRecovery;
void sameAPI(scope, { backend: local.backend, locks: null }, async session => {
  const row = await session.read("notes/one");
  const pending: EditorPreparedAttempt | null = row?.pending ?? null;
  return pending;
});
`);
    await writeFile(path.join(scratch, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "NodeNext", moduleResolution: "NodeNext",
      types: ["node"], strict: true, noEmit: true, skipLibCheck: false,
    }, include: ["consumer.ts"] }));
    await run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
    // Only the fake browser service comes from the test harness; all product imports resolve in the external install.
    const fakeIDB = pathToFileURL(require.resolve("fake-indexeddb")).href;
    await writeFile(path.join(scratch, "consumer.mjs"), `
import assert from "node:assert/strict";
import { IDBFactory } from ${JSON.stringify(fakeIDB)};
import { openLocalBundle, withEditorRecovery as rootRecovery } from "@superbee/browser-local";
import { withEditorRecovery } from "@superbee/browser-local/editor-recovery";
import { versionOfBytes } from "@superbee/core/versioning";
assert.equal(rootRecovery, withEditorRecovery);
const indexedDB = new IDBFactory();
const locks = { request: async (name, options, callback) => callback({ name }) };
const scope = { endpoint: "https://example.test", principalScope: "p", workspace: "w", bundle: "b", installation: "i", registrationScope: "r" };
const requestId = "00000000-0000-4000-8000-000000000001";
const local = openLocalBundle("external-proof", { indexedDB });
await withEditorRecovery(scope, { backend: local.backend, locks }, async session => {
  const draft = await session.saveDraft("notes/one", { base: { version: versionOfBytes("base"), body: "base" }, body: "prepared" }, null);
  await session.prepare("notes/one", { requestId }, draft.revision);
  await session.saveDraft("notes/one", { base: draft.base, body: "newer" }, draft.revision);
});
local.close();
const reopened = openLocalBundle("external-proof", { indexedDB });
try {
  await withEditorRecovery(scope, { backend: reopened.backend, locks }, async session => {
    const row = await session.read("notes/one");
    assert.equal(row.body, "newer");
    assert.equal(row.pending.body, "prepared");
    assert.equal(row.pending.requestId, requestId);
  });
} finally { reopened.close(); }
`);
    await run(process.execPath, ["consumer.mjs"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
