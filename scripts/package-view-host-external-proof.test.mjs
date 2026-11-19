import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const manifestAt = async directory => JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
const ENTRIES = ["", "/view-bridge-host", "/action-bridge", "/action-preparation", "/view-frame"];

test("packed view-host installs outside the workspace with only core, bundles for browsers, and hosts a View", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-view-host-consumer-"));
  const run = (command, args, cwd = scratch) => exec(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  const npm = (args, cwd = scratch) => {
    assert.ok(process.env.npm_execpath, "run through npm run test:scripts");
    return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
  };
  try {
    const artifacts = path.join(scratch, "artifacts");
    await mkdir(artifacts);
    const sourceCore = await manifestAt(path.join(root, "packages/core"));
    const sourceHost = await manifestAt(path.join(root, "packages/view-host"));
    assert.notEqual(sourceHost.version, "0.0.0");
    // A range the packed source Core must satisfy: the install below uses only these two tarballs.
    assert.match(sourceHost.dependencies["@superbee/core"], /^\^/, "the View host takes a Core range, not an exact pin");
    const packed = {};
    // CI builds first. This proof packs those outputs; it is not a publication or staging step.
    for (const name of ["core", "view-host"]) {
      const { stdout } = await npm(["pack", "-w", `@superbee/${name}`, "--json", "--pack-destination", artifacts], root);
      const [receipt] = JSON.parse(stdout);
      assert.equal(receipt.name, `@superbee/${name}`);
      packed[name] = { receipt, tarball: path.join(artifacts, receipt.filename) };
    }
    const paths = packed["view-host"].receipt.files.map(file => file.path);
    for (const file of paths) {
      assert.ok(file === "package.json" || file === "README.md" || file === "LICENSE" || file.startsWith("dist/"), `unexpected packed file ${file}`);
      assert.ok(!file.includes("test"), `test file packed: ${file}`);
    }
    for (const entry of ["index", "view-bridge-host", "action-bridge", "action-preparation", "view-frame", "read-adapter-error"])
      for (const extension of [".js", ".d.ts"]) assert.ok(paths.includes(`dist/${entry}${extension}`), `missing dist/${entry}${extension}`);
    await writeFile(path.join(scratch, "package.json"), JSON.stringify({
      name: "view-host-external-proof", private: true, type: "module",
      dependencies: {
        "@superbee/core": `file:${packed.core.tarball}`,
        "@superbee/view-host": `file:${packed["view-host"].tarball}`,
      },
      devDependencies: { "@types/node": sourceCore.devDependencies["@types/node"] },
    }));
    await npm(["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const lock = JSON.parse(await readFile(path.join(scratch, "package-lock.json"), "utf8"));
    for (const [name, row] of Object.entries(lock.packages)) {
      assert.ok(!row.link, `workspace link in external install: ${name}`);
      if (name.includes("node_modules/@superbee/")) assert.ok(["node_modules/@superbee/core", "node_modules/@superbee/view-host"].includes(name), `unexpected workspace dependency ${name}`);
    }
    for (const name of ["core", "view-host"]) {
      const directory = path.join(scratch, "node_modules/@superbee", name);
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
      assert.ok((await realpath(directory)).startsWith(await realpath(scratch)));
      const row = lock.packages[`node_modules/@superbee/${name}`];
      assert.equal(row.version, name === "core" ? sourceCore.version : sourceHost.version);
      assert.ok(row.resolved.startsWith("file:"), `must install literal ${name} tarball`);
      assert.equal(row.integrity, packed[name].receipt.integrity, `installed ${name} must match packed bytes`);
    }
    const installed = await manifestAt(path.join(scratch, "node_modules/@superbee/view-host"));
    assert.equal(installed.private, undefined);
    assert.equal(installed.version, sourceHost.version);
    assert.deepEqual(installed.dependencies, sourceHost.dependencies);
    assert.deepEqual(installed.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
    assert.deepEqual(installed.files, sourceHost.files);
    assert.deepEqual(Object.keys(installed.exports), ENTRIES.map(entry => `.${entry}`));
    for (const entry of ENTRIES) {
      const specifier = `@superbee/view-host${entry}`;
      const result = await build({
        absWorkingDir: scratch,
        stdin: { contents: `export * from ${JSON.stringify(specifier)};`, resolveDir: scratch, sourcefile: "browser-consumer.js" },
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
import { createViewBridgeHost, viewFrameHeaders, type ViewBridgeExecute, type ViewBridgeHost } from "@superbee/view-host";
import { parseActionBridgeMessage, type DocumentAction } from "@superbee/view-host/action-bridge";
import { prepareViewDocumentAction } from "@superbee/view-host/action-preparation";
import { ReadAdapterError } from "@superbee/view-host/view-bridge-host";
import { viewFramePolicy } from "@superbee/view-host/view-frame";
const execute: ViewBridgeExecute = async (_operation, _input, _signal) => ({ ok: true, data: {} });
const host: ViewBridgeHost = createViewBridgeHost({ postMessage() {} }, { id: "b", name: "B" }, execute, { operations: ["documents.read.v1"] });
const headers: Record<string, string> = viewFrameHeaders("https://app.example");
const policy: string = viewFramePolicy("https://app.example");
const parsed = parseActionBridgeMessage({});
const action: DocumentAction | undefined = parsed?.ok && parsed.message.type === "action.propose" ? parsed.message.action : undefined;
void [host, headers, policy, action, prepareViewDocumentAction, new ReadAdapterError("invalid_input")];
`);
    await writeFile(path.join(scratch, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", lib: ["ES2022", "DOM"], module: "NodeNext", moduleResolution: "NodeNext",
      types: [], strict: true, noEmit: true, skipLibCheck: false,
    }, include: ["consumer.ts"] }));
    await run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
    await writeFile(path.join(scratch, "consumer.mjs"), `
import assert from "node:assert/strict";
import { createViewBridgeHost } from "@superbee/view-host";
const replies = [];
const frame = { postMessage: (message) => replies.push(message) };
const document = { id: "notes/one", frontmatter: { type: "Note" }, body: "# One\\n" };
const host = createViewBridgeHost(frame, { id: "b", name: "Bundle" }, async (operation, input) => {
  assert.equal(operation, "documents.read.v1");
  assert.deepEqual(input, { documentId: "notes/one", bundleId: "b" });
  return { ok: true, data: { document, version: "sha256:" + "a".repeat(64) } };
}, { operations: ["documents.read.v1"] });
await host.receive({ source: frame, origin: "null", data: { bridge: "v0", id: "h", type: "hello" } });
await host.receive({ source: frame, origin: "null", data: { bridge: "v0", id: "r", type: "read", docId: "notes/one" } });
assert.equal(replies[0].result.host.limits.query, 0);
assert.deepEqual(replies[1], { bridge: "v0", id: "r", type: "read:result", result: document });
`);
    await run(process.execPath, ["consumer.mjs"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
