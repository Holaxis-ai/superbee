import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
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

function npmInvocation(args, env = process.env) {
  const npmCli = env.npm_execpath?.trim();
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

test("npm is launched shell-free through its CLI JavaScript path", () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(npmInvocation(["pack", "--json"], { npm_execpath: npmCli }), {
    command: process.execPath,
    args: [npmCli, "pack", "--json"],
  });
  assert.throws(() => npmInvocation([], {}), /npm_execpath is required/);
});

test("packed core installs, typechecks, and runs outside the monorepo", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "agentstate-lite-core-consumer-"));
  const packDir = path.join(scratch, "pack");
  try {
    await mkdir(packDir);
    await runNpm(["run", "build", "-w", "@superbee/core"], repoRoot);
    const packed = await runNpm(
      ["pack", "-w", "@superbee/core", "--json", "--pack-destination", packDir],
      repoRoot,
    );
    const [receipt] = JSON.parse(packed.stdout);
    const paths = receipt.files.map((file) => file.path).sort();
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes("dist/index.js"));
    assert.ok(paths.includes("dist/index.d.ts"));
    assert.ok(paths.includes("dist/engine.js"));
    assert.ok(paths.includes("dist/engine.d.ts"));
    assert.ok(paths.includes("dist/kinds.js"));
    assert.ok(paths.includes("dist/kinds.d.ts"));
    assert.ok(paths.includes("dist/remote.js"));
    assert.ok(paths.includes("dist/remote.d.ts"));
    assert.ok(paths.includes("dist/storage.js"));
    assert.ok(paths.includes("dist/storage.d.ts"));
    assert.ok(paths.every((file) => file === "package.json" || file.startsWith("dist/")));

    await writeFile(
      path.join(scratch, "package.json"),
      JSON.stringify({ name: "core-external-proof", private: true, type: "module" }, null, 2),
    );
    await runNpm(
      [
        "install",
        // prefer-offline, not offline: resolving core's real dependency range (gray-matter)
        // needs a registry packument on a cold cache — `npm ci` caches tarballs by exact URL,
        // never packuments, so a fresh machine/CI runner cannot resolve ranges fully offline.
        "--prefer-offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--no-save",
        path.join(packDir, receipt.filename),
      ],
      scratch,
    );

    await writeFile(
      path.join(scratch, "consumer.ts"),
      `import {
  FilesystemBackend,
  MemoryBackend,
  RemoteBackend,
  type OkfDocument,
  type StorageBackend,
} from "@superbee/core";
import { isTerminal, type KindConvention } from "@superbee/core/kinds";
import {
  MalformedDocumentError,
  type EdgeFilter,
  type Link,
} from "@superbee/core/engine";
import { MalformedDocumentError as StorageMalformedDocumentError } from "@superbee/core/storage";

const document: OkfDocument = { id: "proof", frontmatter: { type: "Proof" }, body: "works" };
const backends: StorageBackend[] = [
  new FilesystemBackend("."),
  new MemoryBackend(),
  new RemoteBackend({ baseUrl: "http://127.0.0.1:1", bundleId: "bnd_00112233445566778899aabbccddeeff", maxRetries: 0 }),
];
const kind: KindConvention = {
  id: "conventions/task",
  title: "Task",
  governs: "Task",
  fields: {
    required: [],
    optional: ["status"],
    values: { status: ["done"] },
    terminal: { status: ["done"] },
    descriptions: {},
  },
};
const terminal: boolean = isTerminal(kind, { type: "Task", status: "done" });
const edgeFilter: EdgeFilter = { from: "proof/", to: ["target"] };
const link: Link = { from: "proof/source", to: "target", text: "proof", href: "../target.md" };
const sameMalformedError: boolean = MalformedDocumentError === StorageMalformedDocumentError;
void [document, backends, terminal, edgeFilter, link, sameMalformedError];
`,
    );
    await writeFile(
      path.join(scratch, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      ),
    );
    await run(
      process.execPath,
      [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      scratch,
    );

    await writeFile(
      path.join(scratch, "consumer.mjs"),
      `import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FilesystemBackend,
  MemoryBackend,
  RemoteBackend,
  initBundle,
  readDoc,
  writeDoc,
} from "@superbee/core";
import { freshnessHorizonMs } from "@superbee/core/kinds";

const root = await mkdtemp(path.join(tmpdir(), "core-packed-runtime-"));
try {
  const bundle = await initBundle(root);
  await writeDoc(bundle, { id: "filesystem/proof", frontmatter: { type: "Proof" }, body: "works" });
  if ((await readDoc(bundle, "filesystem/proof")).body.trim() !== "works") throw new Error("filesystem engine failed");
  if (!(await new FilesystemBackend(root).exists("filesystem/proof"))) throw new Error("filesystem backend failed");

  const memory = new MemoryBackend();
  await memory.write("memory/proof", { id: "memory/proof", frontmatter: { type: "Proof" }, body: "works" });
  if ((await memory.read("memory/proof")).doc.body !== "works") throw new Error("memory backend failed");

  const remote = new RemoteBackend({
    baseUrl: "http://external-proof.invalid",
    bundleId: "bnd_00112233445566778899aabbccddeeff",
    maxRetries: 0,
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  if (await remote.exists("missing")) throw new Error("remote backend failed");
  const kind = {
    id: "conventions/proof",
    title: "Proof",
    governs: "Proof",
    freshnessHorizon: "2h",
    fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {} },
  };
  if (freshnessHorizonMs(kind) !== 7_200_000) throw new Error("kinds subpath failed");
} finally {
  await rm(root, { recursive: true, force: true });
}
`,
    );
    await run(process.execPath, ["consumer.mjs"], scratch);

    await writeFile(
      path.join(scratch, "no-buffer-consumer.mjs"),
      `delete globalThis.Buffer;
const { MalformedDocumentError, readBundleOkfVersion, writeDocVersioned } = await import("@superbee/core/engine");
if (typeof Buffer !== "undefined") throw new Error("proof must execute without Buffer");
const backend = {
  readReserved: async () => ({
    content: "\\uFEFF---\\nokf_version: '0.2'\\n---\\n# Packed Worker proof\\n",
    version: "proof",
  }),
  write: async (_id, doc) => {
    if (doc.frontmatter.timestamp !== undefined) throw new Error("BOM caused v0.1 timestamp fallback");
    return "sha256:proof";
  },
};
if (await readBundleOkfVersion(backend) !== "0.2") throw new Error("portable version read failed");
const written = await writeDocVersioned(backend, {
  id: "packed/bom-proof",
  frontmatter: { type: "Proof" },
  body: "v0.2 stays v0.2",
});
if (written.doc.frontmatter.timestamp !== undefined) throw new Error("portable engine fell back to v0.1");
backend.readReserved = async () => ({ content: "---\\nokf_version: [\\n---\\n", version: "bad" });
try {
  await readBundleOkfVersion(backend);
  throw new Error("malformed root was accepted");
} catch (error) {
  if (!(error instanceof MalformedDocumentError)) throw error;
}
`,
    );
    await run(process.execPath, ["no-buffer-consumer.mjs"], scratch);

    // N3: the filesystem identity unit is not reachable from the packed package. Each negative
    // consumer must FAIL to typecheck for the named reason, and a runtime deep import must be
    // refused by the exports map, so the sealed boundary is protected by CI rather than by naming.
    const internalNames = [
      "identityKey",
      "classifyLeaf",
      "classifyMkdir",
      "observeExact",
      "mutateExact",
      "acquireFilesystemIdentityLock",
      "filesystemIdentityLockPath",
      "nodeFilesystemIdentityPort",
    ];
    const negatives = [
      {
        file: "negative-internal.ts",
        source: `import { ${internalNames.join(", ")} } from "@superbee/core";\nvoid [${internalNames.join(", ")}];\n`,
        expect: internalNames.map((name) => new RegExp(`error TS2305: .*has no exported member '${name}'`)),
      },
      {
        file: "negative-deep.ts",
        source: 'import { identityKey } from "@superbee/core/dist/filesystem-identity.js";\nvoid identityKey;\n',
        expect: [/error TS2307: Cannot find module '@superbee\/core\/dist\/filesystem-identity\.js'/],
      },
      {
        file: "negative-options.ts",
        source:
          'import { withFilesystemMutationLock } from "@superbee/core";\n' +
          'void withFilesystemMutationLock("/tmp/x", async () => 1, { waitMs: 1, unknownKey: true });\n',
        expect: [/error TS2353: .*'unknownKey' does not exist in type 'FilesystemMutationLockOptions'/],
      },
    ];
    for (const negative of negatives) {
      await writeFile(path.join(scratch, negative.file), negative.source);
      await writeFile(
        path.join(scratch, "tsconfig.negative.json"),
        JSON.stringify({ extends: "./tsconfig.json", include: [negative.file] }, null, 2),
      );
      let diagnostics = "";
      try {
        await run(
          process.execPath,
          [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.negative.json"],
          scratch,
        );
        assert.fail(`${negative.file} must not typecheck against the packed package`);
      } catch (error) {
        if (error?.code === "ERR_ASSERTION") throw error;
        diagnostics = String(error.stdout ?? "") + String(error.stderr ?? "");
      }
      for (const pattern of negative.expect) {
        assert.match(diagnostics, pattern, `${negative.file}: expected ${pattern} in:\n${diagnostics}`);
      }
    }
    await writeFile(
      path.join(scratch, "deep-import.mjs"),
      `try {
  await import("@superbee/core/dist/filesystem-identity.js");
  console.log("RESOLVED");
} catch (error) {
  console.log(error?.code ?? "NO_CODE");
}
`,
    );
    const deep = await run(process.execPath, ["deep-import.mjs"], scratch);
    assert.equal(deep.stdout.trim(), "ERR_PACKAGE_PATH_NOT_EXPORTED");

    const installed = path.join(scratch, "node_modules", "@superbee", "core");

    await writeFile(
      path.join(scratch, "worker-consumer.ts"),
      `import { queryHeads, writeDocVersioned } from "@superbee/core/engine";
import {
  InvalidInputError,
  VersionConflict,
  assertSafeConceptId,
  type OkfDocument,
  type StorageBackend,
} from "@superbee/core/storage";
import { RemoteBackend, RemoteError } from "@superbee/core/remote";

declare const backend: StorageBackend;
declare const document: OkfDocument;
export async function exercisePortableCore(): Promise<void> {
  assertSafeConceptId(document.id);
  await writeDocVersioned(backend, document);
  await queryHeads(backend, { type: String(document.frontmatter.type) });
}
export const portableRuntime = { InvalidInputError, VersionConflict, RemoteBackend, RemoteError };
`,
    );
    await writeFile(
      path.join(scratch, "tsconfig.worker.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "WebWorker"],
            types: [],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: ["worker-consumer.ts"],
        },
        null,
        2,
      ),
    );
    await run(
      process.execPath,
      [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.worker.json"],
      scratch,
    );
    const workerBundle = await build({
      absWorkingDir: scratch,
      entryPoints: ["worker-consumer.ts"],
      bundle: true,
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    assert.equal(workerBundle.errors.length, 0);
    assert.ok(workerBundle.outputFiles[0].text.includes("RemoteBackend"));

    const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    const sourceManifest = JSON.parse(
      await readFile(path.join(repoRoot, "packages", "core", "package.json"), "utf8"),
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
    assert.ok(installedManifest.exports["./kinds"]);
    assert.ok(installedManifest.exports["./engine"]);
    assert.ok(installedManifest.exports["./remote"]);
    assert.ok(installedManifest.exports["./storage"]);
    const installedFiles = await filesUnder(installed);
    assert.ok(installedFiles.every((file) => file === "package.json" || file.startsWith("dist/")));

    const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
    for (const file of installedFiles.filter((name) => /\.(?:js|d\.ts)$/.test(name))) {
      const source = await readFile(path.join(installed, file), "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        assert.ok(!specifier.startsWith("@superbee/"), `${file} imports workspace package ${specifier}`);
        assert.ok(!/(^|\/)src(?:\/|$)/.test(specifier), `${file} imports source path ${specifier}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
