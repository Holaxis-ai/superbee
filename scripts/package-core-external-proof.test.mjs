import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

function publicExportSpecifiers(manifest) {
  const exports = manifest.exports;
  assert.ok(exports && typeof exports === "object", "core package must declare exports");
  return Object.keys(exports)
    .sort()
    .map((entry) => {
      assert.ok(entry === "." || entry.startsWith("./"), `unsupported core export key ${entry}`);
      return entry === "." ? "@superbee/core" : `@superbee/core/${entry.slice(2)}`;
    });
}

function declaredExportFiles(manifest) {
  const files = new Set();
  for (const [entry, condition] of Object.entries(manifest.exports ?? {})) {
    assert.ok(condition && typeof condition === "object", `unsupported core export shape for ${entry}`);
    for (const target of Object.values(condition)) {
      assert.equal(typeof target, "string", `unsupported core export target for ${entry}`);
      files.add(target.replace(/^\.\//, ""));
    }
  }
  return [...files].sort();
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
    assert.ok(paths.includes("dist/kinds.js"));
    assert.ok(paths.includes("dist/kinds.d.ts"));
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

    const installed = path.join(scratch, "node_modules", "@superbee", "core");
    const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    const publicExports = publicExportSpecifiers(installedManifest);
    assert.ok(publicExports.length > 1, "fixture must exercise root and subpath exports");

    await writeFile(
      path.join(scratch, "consumer.ts"),
      `${publicExports.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n")}

import {
  FilesystemBackend,
  MemoryBackend,
  RemoteBackend,
  type OkfDocument,
  type StorageBackend,
} from "@superbee/core";
import { isTerminal, type KindConvention } from "@superbee/core/kinds";

const document: OkfDocument = { id: "proof", frontmatter: { type: "Proof" }, body: "works" };
const backends: StorageBackend[] = [
  new FilesystemBackend("."),
  new MemoryBackend(),
  new RemoteBackend({ baseUrl: "http://127.0.0.1:1", bundle: "default", maxRetries: 0 }),
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
void [document, backends, terminal];
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

const publicExports = ${JSON.stringify(publicExports)};
for (const specifier of publicExports) {
  const loaded = await import(specifier);
  if (Object.keys(loaded).length === 0) throw new Error(specifier + " resolved to an empty module");
}

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
    bundle: "default",
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

    assert.equal(installedManifest.private, true);
    assert.deepEqual(installedManifest.files, ["dist"]);
    const installedFiles = await filesUnder(installed);
    assert.ok(installedFiles.every((file) => file === "package.json" || file.startsWith("dist/")));
    for (const file of declaredExportFiles(installedManifest)) {
      assert.ok(installedFiles.includes(file), `declared core export file is missing from package: ${file}`);
    }

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
