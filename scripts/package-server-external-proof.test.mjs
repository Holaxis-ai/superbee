import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function run(command, args, cwd) {
  return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

function npmInvocation(args) {
  const npmCli = process.env.npm_execpath?.trim();
  if (!npmCli) {
    throw new Error("npm_execpath is required; run this proof through the repository's npm test:scripts gate");
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

async function runNpm(args, cwd) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, cwd);
}

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

async function packWorkspace(workspace, packDir) {
  const packed = await runNpm(
    ["pack", "-w", workspace, "--json", "--pack-destination", packDir],
    repoRoot,
  );
  const [receipt] = JSON.parse(packed.stdout);
  assert.ok(receipt);
  return { receipt, tarball: path.join(packDir, receipt.filename) };
}

test("packed server installs, typechecks, and round-trips through packaged core outside the monorepo", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "agentstate-lite-server-consumer-"));
  const packDir = path.join(scratch, "pack");
  try {
    await mkdir(packDir);
    await runNpm(
      ["run", "build", "-w", "@superbee/core", "-w", "@superbee/server"],
      repoRoot,
    );

    const core = await packWorkspace("@superbee/core", packDir);
    const server = await packWorkspace("@superbee/server", packDir);
    const serverPaths = server.receipt.files.map((file) => file.path).sort();
    assert.ok(serverPaths.includes("package.json"));
    assert.ok(serverPaths.includes("dist/index.js"));
    assert.ok(serverPaths.includes("dist/index.d.ts"));
    assert.ok(serverPaths.includes("dist/legacy-router.js"));
    assert.ok(serverPaths.includes("dist/legacy-router.d.ts"));
    assert.ok(serverPaths.includes("dist/router.js"));
    assert.ok(serverPaths.includes("dist/router.d.ts"));
    assert.ok(serverPaths.includes("dist/serve.js"));
    assert.ok(serverPaths.includes("dist/serve.d.ts"));
    assert.ok(serverPaths.every((file) => file === "package.json" || file.startsWith("dist/")));

    await writeFile(
      path.join(scratch, "package.json"),
      `${JSON.stringify(
        {
          name: "server-external-proof",
          private: true,
          type: "module",
          dependencies: {
            "@superbee/core": `file:${core.tarball}`,
            "@superbee/server": `file:${server.tarball}`,
          },
          devDependencies: {
            "@types/node": "^22.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await runNpm(
      ["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      scratch,
    );

    await writeFile(
      path.join(scratch, "consumer.ts"),
      `import {
  MemoryBackend,
  RemoteBackend,
  type OkfDocument,
  type StorageBackend,
  type Version,
} from "@superbee/core";
import {
  createRouterForBackend,
  type ServerHandle,
} from "@superbee/server";
import {
  createRouter as createWorkerRouter,
  resolveWireRequest,
  type ResolvedBundleWireRoute,
} from "@superbee/server/router";

const backend: StorageBackend = new MemoryBackend();
const router = createRouterForBackend(backend);
const remote = new RemoteBackend({
  baseUrl: "http://wire.external",
  bundleId: "bnd_00112233445566778899aabbccddeeff",
  fetchImpl: router,
  maxRetries: 0,
});
const document: OkfDocument = {
  id: "proof/document",
  frontmatter: { type: "Proof" },
  body: "external",
};
const version: Promise<Version> = remote.write(document.id, document);
const response: Promise<Response> = router(new Request("http://wire.external/v0/capabilities"));
const handle: ServerHandle | undefined = undefined;
const resolved = resolveWireRequest(
  new Request("http://wire.external/v0/bundles/bnd_00112233445566778899aabbccddeeff/docs"),
);
const workerRouter = createWorkerRouter({
  capabilities: { enforced_cas: true, blobs: true },
  resolveContext: (_request, route: ResolvedBundleWireRoute) => ({
    backend,
    attribution: { actor: route.bundleId },
  }),
});
void [version, response, handle, resolved, workerRouter];
`,
    );
    await writeFile(
      path.join(scratch, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            types: ["node"],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      )}\n`,
    );
    await run(
      process.execPath,
      [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      scratch,
    );

    await writeFile(
      path.join(scratch, "consumer.mjs"),
      `import assert from "node:assert/strict";
import {
  MemoryBackend,
  RemoteBackend,
  VersionConflict,
  blobVersion,
} from "@superbee/core";
import { createRouterForBackend } from "@superbee/server";

const backend = new MemoryBackend();
const router = createRouterForBackend(backend);
const remote = new RemoteBackend({
  baseUrl: "http://wire.external",
  bundleId: "bnd_00112233445566778899aabbccddeeff",
  fetchImpl: router,
  maxRetries: 0,
});

const id = "proof/document";
const first = await remote.write(
  id,
  { id, frontmatter: { type: "Proof" }, body: "one" },
  { expectedVersion: null, actor: "external-consumer" },
);
assert.equal((await remote.read(id)).version, first);

const second = await remote.write(
  id,
  { id, frontmatter: { type: "Proof" }, body: "two" },
  { expectedVersion: first, actor: "external-consumer" },
);
assert.notEqual(second, first);
await assert.rejects(
  () =>
    remote.write(
      id,
      { id, frontmatter: { type: "Proof" }, body: "stale" },
      { expectedVersion: first },
    ),
  (error) =>
    error instanceof VersionConflict &&
    error.expected === first &&
    error.actual === second,
);
assert.deepEqual(
  (await remote.versions(id)).map((entry) => entry.version),
  [second, first],
);

const key = "artifacts/proof.bin";
const bytes = new Uint8Array([0, 255, 1, 128]);
const writtenBlob = await remote.writeBlob(
  key,
  bytes,
  "application/octet-stream",
  { expectedVersion: null, actor: "external-consumer" },
);
const readBlob = await remote.readBlob(key);
assert.ok(readBlob);
assert.equal(writtenBlob, blobVersion(bytes));
assert.equal(readBlob.version, writtenBlob);
assert.deepEqual([...readBlob.bytes], [...bytes]);
`,
    );
    await run(process.execPath, ["consumer.mjs"], scratch);

    const installedServer = path.join(scratch, "node_modules", "@superbee", "server");
    const installedCore = path.join(scratch, "node_modules", "@superbee", "core");
    assert.equal((await lstat(installedServer)).isSymbolicLink(), false);
    assert.equal((await lstat(installedCore)).isSymbolicLink(), false);

    const installedManifest = JSON.parse(
      await readFile(path.join(installedServer, "package.json"), "utf8"),
    );
    const sourceManifest = JSON.parse(
      await readFile(path.join(repoRoot, "packages", "server", "package.json"), "utf8"),
    );
    assert.equal(installedManifest.private, undefined);
    assert.equal(installedManifest.version, sourceManifest.version);
    assert.deepEqual(installedManifest.publishConfig, {
      access: "restricted",
      registry: "https://registry.npmjs.org/",
    });
    assert.match(installedManifest.scripts.prepublishOnly, /process\.exit\(1\)/);
    assert.deepEqual(installedManifest.files, ["dist"]);
    assert.ok(installedManifest.exports["."]);
    assert.ok(installedManifest.exports["./router"]);
    assert.equal(installedManifest.dependencies["@superbee/core"], installedManifest.version);

    const installedFiles = await filesUnder(installedServer);
    assert.ok(installedFiles.every((file) => file === "package.json" || file.startsWith("dist/")));
    const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
    for (const file of installedFiles.filter((name) => /\.(?:js|d\.ts)$/.test(name))) {
      const source = await readFile(path.join(installedServer, file), "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        assert.ok(!/(^|\/)src(?:\/|$)/.test(specifier), `${file} imports source path ${specifier}`);
        if (specifier.startsWith("@superbee/")) {
          assert.ok(
            ["@superbee/core", "@superbee/core/engine", "@superbee/core/storage"].includes(specifier),
            `${file} imports workspace package ${specifier}`,
          );
        }
      }
    }

    const workerBundle = await build({
      entryPoints: [path.join(installedServer, "dist", "router.js")],
      bundle: true,
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    assert.equal(workerBundle.errors.length, 0);
    assert.ok(workerBundle.outputFiles[0].text.includes("resolveWireRequest"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
