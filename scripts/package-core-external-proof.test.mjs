import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
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
    assert.ok(paths.includes("README.md"), "core consumers receive filesystem migration guidance");
    assert.ok(paths.includes("dist/index.js"));
    assert.ok(paths.includes("dist/index.d.ts"));
    assert.ok(paths.includes("dist/engine.js"));
    assert.ok(paths.includes("dist/engine.d.ts"));
    assert.ok(paths.includes("dist/kinds.js"));
    assert.ok(paths.includes("dist/kinds.d.ts"));
    assert.ok(paths.includes("dist/recipes.js"));
    assert.ok(paths.includes("dist/recipes.d.ts"));
    for (const module of ["builtin-recipes", "kind-authoring"]) {
      assert.ok(paths.includes(`dist/${module}.js`));
      assert.ok(paths.includes(`dist/${module}.d.ts`));
    }
    assert.ok(paths.includes("dist/connectors.js"));
    assert.ok(paths.includes("dist/connectors.d.ts"));
    assert.ok(paths.includes("dist/recipe-lifecycle/index.js"));
    assert.ok(paths.includes("dist/recipe-lifecycle/index.d.ts"));
    assert.ok(paths.includes("dist/record-overlay/index.js"));
    assert.ok(paths.includes("dist/record-overlay/index.d.ts"));
    assert.ok(paths.includes("dist/bundle-health/index.js"));
    assert.ok(paths.includes("dist/bundle-health/index.d.ts"));
    assert.ok(paths.includes("dist/remote.js"));
    assert.ok(paths.includes("dist/remote.d.ts"));
    assert.ok(paths.includes("dist/storage.js"));
    assert.ok(paths.includes("dist/storage.d.ts"));
    assert.ok(paths.includes("dist/filesystem.js"));
    assert.ok(paths.includes("dist/filesystem.d.ts"));
    assert.ok(paths.includes("dist/view-admission.js"));
    assert.ok(paths.includes("dist/view-admission.d.ts"));
    assert.ok(paths.includes("dist/artifact-contract.js"));
    assert.ok(paths.includes("dist/artifact-contract.d.ts"));
    assert.ok(paths.includes("dist/site-capabilities.js"));
    assert.ok(paths.includes("dist/site-capabilities.d.ts"));
    assert.ok(paths.includes("dist/search/index.js"));
    assert.ok(paths.includes("dist/search/index.d.ts"));
    assert.ok(paths.includes("dist/source-engine/index.js"));
    assert.ok(paths.includes("dist/source-engine/index.d.ts"));
    assert.ok(paths.includes("dist/source-harness/index.js"));
    assert.ok(paths.includes("dist/source-harness/index.d.ts"));
    assert.ok(paths.every((file) => file === "package.json" || file === "README.md" || file.startsWith("dist/")));

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
import { createFilesystemRuntime, type FilesystemHostPolicy, type FilesystemRuntime } from "@superbee/core/filesystem";
import { isTerminal, type KindConvention } from "@superbee/core/kinds";
import {
  MalformedDocumentError,
  type EdgeFilter,
  type Link,
} from "@superbee/core/engine";
import { MalformedDocumentError as StorageMalformedDocumentError } from "@superbee/core/storage";
import { admitActiveView, MAX_ACTIVE_VIEW_BYTES, ACTIVE_VIEW_CONTENT_TYPE } from "@superbee/core/view-admission";

import { decodeDocumentTargetV1, type DocumentTargetV1, type ArtifactDecodeResult } from "@superbee/core/artifact-contract";
const decodedTarget: ArtifactDecodeResult<DocumentTargetV1> = decodeDocumentTargetV1({
  schemaVersion: "superbee.document-target.v1", authority: { mode: "local", authorityKey: "local" },
  bundleKey: "selected", documentId: "x.md",
});
if (decodedTarget.ok) { const exactId: string = decodedTarget.value.documentId; void exactId; }

const admitted: { bytes: Uint8Array; contentType: "text/html; charset=utf-8" } = admitActiveView(new Uint8Array(), ACTIVE_VIEW_CONTENT_TYPE);
void [admitted, MAX_ACTIVE_VIEW_BYTES];

const policy: FilesystemHostPolicy = {
  runtimeLockParent: () => "/tmp", runtimeOwnerKey: () => "proof",
  enforcePrivateMode: true, isTransientOpenError: () => false,
  isReplacementConflict: () => false, isDirectoryContentionError: () => false,
};
const runtime: FilesystemRuntime = createFilesystemRuntime(policy);
void runtime.backend(".");
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
import { createFilesystemRuntime } from "@superbee/core/filesystem";

const root = await mkdtemp(path.join(tmpdir(), "core-packed-runtime-"));
try {
  const runtime = createFilesystemRuntime({
    runtimeLockParent: () => tmpdir(), runtimeOwnerKey: () => "packed-proof",
    enforcePrivateMode: true, isTransientOpenError: () => false,
    isReplacementConflict: () => false, isDirectoryContentionError: () => false,
  });
  const bundle = await runtime.initBundle(root);
  if (!(bundle.backend instanceof FilesystemBackend)) throw new Error("runtime lost its backend");
  await writeDoc(bundle, { id: "filesystem/proof", frontmatter: { type: "Proof" }, body: "works" });
  if ((await readDoc(bundle, "filesystem/proof")).body.trim() !== "works") throw new Error("filesystem engine failed");
  if (!(await new FilesystemBackend(root).exists("filesystem/proof"))) throw new Error("filesystem backend failed");

  const memory = new MemoryBackend();
  await memory.write("memory/proof", { id: "memory/proof", frontmatter: { type: "Proof" }, body: "works" });
  if ((await memory.read("memory/proof")).doc.body !== "works\\n") throw new Error("memory backend failed");

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

    await writeFile(
      path.join(scratch, "search-consumer.mjs"),
      `delete globalThis.Buffer;
const { memorySearchSource, searchDocuments, SearchInputError, SEARCH_ALGORITHM } = await import("@superbee/core/search");
if (typeof Buffer !== "undefined") throw new Error("proof must execute without Buffer");
const source = memorySearchSource([
  { id: "notes/lock", version: "v1", frontmatter: { title: "Lock keeper", type: "Note", tags: ["canal"] }, body: "The lock keeper opens the gate." },
  { id: "notes/mill", version: "v1", frontmatter: { title: "Mill" }, body: "The mill sits past the lock." },
], { key: "packed" });
const answer = await searchDocuments(source, { query: "lock keeper", facets: ["type"] }, { scope: "packed" });
if (answer.total !== 1 || answer.hits[0].id !== "notes/lock" || answer.hits[0].score !== 11120) throw new Error("search ranked differently");
if (answer.facets.type[0].value !== "Note" || SEARCH_ALGORITHM !== "portal-webmcp-search/v1") throw new Error("search contract changed");
if (JSON.stringify(answer.corpus) !== JSON.stringify({ documents: 2, indexed: 2, skipped: 0, reindexPending: 0 })) throw new Error("search corpus changed");
try {
  await searchDocuments(source, { query: "lock", cursor: "forged" });
  throw new Error("a forged cursor was accepted");
} catch (error) {
  if (!(error instanceof SearchInputError)) throw error;
}
`,
    );
    await run(process.execPath, ["search-consumer.mjs"], scratch);

    await writeFile(
      path.join(scratch, "source-consumer.mjs"),
      `delete globalThis.Buffer;
const { observeSource, MemoryMachineState, refusedAddress } = await import("@superbee/core/source-engine");
const { peerTransport, runTransportConformance, REQUIRED_SCENARIOS } = await import("@superbee/core/source-harness");
if (typeof Buffer !== "undefined") throw new Error("proof must execute without Buffer");
const rows = await runTransportConformance({ name: "packed memory", create: (peer, credential) => peerTransport(peer, { credential }) });
const failed = rows.filter((row) => !row.ok);
if (rows.length !== 6 || failed.length) throw new Error("conformance failed: " + JSON.stringify(failed));
if (refusedAddress(new URL("https://169.254.169.254/latest")) !== "ip_literal") throw new Error("address rule changed");
if (!REQUIRED_SCENARIOS.includes("complete.disappear") || typeof observeSource !== "function" || typeof MemoryMachineState !== "function") throw new Error("source surface changed");
`,
    );
    await run(process.execPath, ["source-consumer.mjs"], scratch);

    await writeFile(path.join(scratch, "view-consumer.mjs"), `
import { admitActiveView, MAX_ACTIVE_VIEW_BYTES, ACTIVE_VIEW_CONTENT_TYPE } from "@superbee/core/view-admission";
export function exerciseViewAdmission() {
  const input = new TextEncoder().encode("<h1>Exact bytes</h1>");
  const output = admitActiveView(input, 'TEXT/HTML; CHARSET="UTF-8"');
  input.fill(0);
  if (new TextDecoder().decode(output.bytes) !== "<h1>Exact bytes</h1>") throw new Error("admitted bytes alias input");
  if (output.contentType !== ACTIVE_VIEW_CONTENT_TYPE || MAX_ACTIVE_VIEW_BYTES !== 512 * 1024) throw new Error("byte contract changed");
  let rejected = false;
  try { admitActiveView(new Uint8Array(MAX_ACTIVE_VIEW_BYTES + 1), "text/html"); } catch { rejected = true; }
  if (!rejected) throw new Error("oversized bytes accepted");
  return output.contentType;
}
`);
    await run(process.execPath, ["--input-type=module", "-e", 'import { exerciseViewAdmission } from "./view-consumer.mjs"; exerciseViewAdmission();'], scratch);
    const viewBundle = await build({
      absWorkingDir: scratch, entryPoints: ["view-consumer.mjs"], bundle: true,
      platform: "browser", format: "iife", globalName: "ViewProof", write: false, logLevel: "silent",
    });
    assert.equal(runInNewContext(viewBundle.outputFiles[0].text + '\nViewProof.exerciseViewAdmission()',
      { TextEncoder, TextDecoder }, { timeout: 5000 }), "text/html; charset=utf-8");

    await writeFile(path.join(scratch, "artifact-consumer.mjs"), `
import { decodeDocumentTargetV1, decodePresentDocumentRequestV1, decodePresentDocumentReceiptV1 } from "@superbee/core/artifact-contract";
export function exerciseArtifacts() {
  const target = decodeDocumentTargetV1({ schemaVersion: "superbee.document-target.v1", authority: { mode: "local", authorityKey: "local" }, bundleKey: "selected", documentId: "x.md" });
  if (!target.ok) throw new Error("valid target refused");
  const request = decodePresentDocumentRequestV1({ schemaVersion: "superbee.present-document.v1", operation: "present_document", invocationId: "invocation", target: target.value });
  if (!request.ok) throw new Error("valid request refused");
  const receipt = decodePresentDocumentReceiptV1({ schemaVersion: "superbee.present-document-receipt.v1", operation: "present_document", invocationId: "invocation", target: target.value, ok: true, presentation: { state: "open_requested" } }, request.value);
  if (!receipt.ok || !receipt.value.ok) throw new Error("valid receipt refused");
  return receipt.value.target.documentId;
}
`);
    await run(process.execPath, ["--input-type=module", "-e", 'import { exerciseArtifacts } from "./artifact-consumer.mjs"; if (exerciseArtifacts() !== "x.md") throw new Error("identity changed");'], scratch);
    const artifactBundle = await build({ absWorkingDir: scratch, entryPoints: ["artifact-consumer.mjs"], bundle: true, platform: "browser", format: "iife", globalName: "ArtifactProof", write: false, logLevel: "silent" });
    assert.equal(runInNewContext(artifactBundle.outputFiles[0].text + '\nArtifactProof.exerciseArtifacts()', {}, { timeout: 5000 }), "x.md");

    // Site capabilities run where a Worker or a page runs them: bundled for the browser and
    // evaluated with only the globals those runtimes share, no Node built-in.
    await writeFile(path.join(scratch, "site-capability-consumer.mjs"), `
import { composeSiteCapabilities, siteRecordSource } from "@superbee/core/site-capabilities";
export async function exerciseSiteCapabilities() {
  const tool = { name: "guide_open_now", implementationId: "guide.open_now.v1", description: "Places open now.",
    inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, execute: async () => ({ ok: true }) };
  const composed = composeSiteCapabilities([{ tier: "pack", namespace: "guide", capabilities: [tool] }], { surface: "ask", requireReadOnly: true });
  if (!composed.ok) throw new Error("conforming capability refused");
  const refused = composeSiteCapabilities([{ tier: "pack", namespace: "guide", capabilities: [{ ...tool, name: "superbee_x" }] }], { surface: "ask" });
  if (refused.ok || refused.refused !== "reserved_prefix") throw new Error("reserved prefix accepted");
  const source = siteRecordSource({ sourceId: "s", siteId: "site", publication: { artifactDigest: "a", snapshotDigest: "p" },
    citation: { recordId: "r", path: "/r", asOf: "2026-10-12" }, admittedPath: (p) => p === "/r" });
  return composed.identityDigest.slice(0, 7) + ":" + source.kind;
}
`);
    const siteBundle = await build({ absWorkingDir: scratch, entryPoints: ["site-capability-consumer.mjs"], bundle: true, platform: "browser", format: "iife", globalName: "SiteProof", write: false, logLevel: "silent" });
    assert.doesNotMatch(siteBundle.outputFiles[0].text, /require\(|node:/);
    assert.equal(await runInNewContext(siteBundle.outputFiles[0].text + '\nSiteProof.exerciseSiteCapabilities()', { TextEncoder, URL }, { timeout: 5000 }), "sha256::site-record");

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

    await assert.rejects(lstat(path.join(scratch, "node_modules", "superbee")), { code: "ENOENT" });
    await writeFile(path.join(scratch, "recipe-consumer.mjs"), String.raw`
import { parseRecipeFiles } from "@superbee/core/recipes";
import { buildKindRegistry, validateAgainstKind } from "@superbee/core/kinds";
import { MalformedDocumentError } from "@superbee/core/document-codec";

export function exerciseRecipes() {
  const files = [
    { path: "recipe.md", bytes: "---\ntype: Recipe\nid: glossary\ntitle: Glossary\nversion: '1'\nsummary: Define terms.\ncontent_policy: definitions-only\n---\n" },
    { path: "conventions/term.md", bytes: "---\ntype: Convention\ngoverns: Term\nfields:\n  required: [title]\nsections: [Definition]\n---\n" },
  ];
  const before = JSON.stringify(files);
  const parsed = parseRecipeFiles(files, "memory:glossary");
  if (!parsed.ok || parsed.recipe.source !== "memory:glossary") throw new Error("recipe parse failed");
  if (JSON.stringify(files) !== before) throw new Error("parser mutated input");
  const registry = buildKindRegistry(parsed.recipe.docs);
  const kind = registry.kinds.get("Term");
  if (!kind || registry.warnings.length) throw new Error("Kind registry failed");
  const good = { id: "terms/example", frontmatter: { type: "Term", title: "Example" }, body: "# Definition\n\nAn example." };
  if (validateAgainstKind(good, kind).length) throw new Error("valid record rejected");
  const warnings = validateAgainstKind({ ...good, frontmatter: { type: "Term" } }, kind);
  if (warnings.length !== 1 || warnings[0].code !== "KIND_FIELD_MISSING" || warnings[0].field !== "title") throw new Error("invalid record accepted");
  const missing = parseRecipeFiles([], "memory:missing");
  if (missing.ok || missing.error.code !== "RECIPE_MALFORMED") throw new Error("missing manifest accepted");
  const undeclared = parseRecipeFiles([...files, { path: "terms/instance.md", bytes: "instance" }], "memory:strict");
  if (undeclared.ok || undeclared.error.code !== "RECIPE_UNSAFE_PATH") throw new Error("instance data accepted");
  const reserved = parseRecipeFiles([{ ...files[0], bytes: files[0].bytes.replace("summary:", "requires: []\nsummary:") }, files[1]], "memory:warning");
  if (!reserved.ok || reserved.recipe.warnings[0]?.code !== "RECIPE_MANIFEST_RESERVED_KEY") throw new Error("warning lost");
  try {
    parseRecipeFiles([{ path: "recipe.md", bytes: "---\nid: [\n---\n" }], "memory:malformed");
    throw new Error("malformed YAML accepted");
  } catch (error) {
    if (!(error instanceof MalformedDocumentError)) throw error;
  }
  return { id: parsed.recipe.id, invalidField: warnings[0].field };
}
`);
    await run(process.execPath, ["--input-type=module", "-e", 'import { exerciseRecipes } from "./recipe-consumer.mjs"; exerciseRecipes();'], scratch);
    const recipeBundle = await build({
      absWorkingDir: scratch,
      entryPoints: ["recipe-consumer.mjs"],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "RecipeProof",
      write: false,
      logLevel: "silent",
    });
    // Exercise the browser bundle without Node globals. This is not a live browser/Worker test.
    const recipeProof = runInNewContext(recipeBundle.outputFiles[0].text + '\nJSON.stringify(RecipeProof.exerciseRecipes())', {}, { timeout: 5000 });
    assert.deepEqual(JSON.parse(recipeProof), { id: "glossary", invalidField: "title" });

    // Use only installed public subpaths over the existing MemoryBackend and engine mutation seam.
    await writeFile(path.join(scratch, "kind-authoring-consumer.mjs"), String.raw`import { MemoryBackend } from "@superbee/core/memory-backend";
import { query } from "@superbee/core/engine";
import { mutateDocument } from "@superbee/core/document-mutation";
import { buildKindRegistry } from "@superbee/core/kinds";
import { loadBuiltinRecipe } from "@superbee/core/builtin-recipes";
import { installRecipe } from "@superbee/core/recipe-lifecycle";
import { prepareKindDraft, applyKindDraft, dismissKind, kindInstanceCandidate, KindAuthoringError } from "@superbee/core/kind-authoring";
export async function exerciseKindAuthoring() {
  const backend = new MemoryBackend(), bundle = { root: "memory://consumer", backend };
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Consumer\n");
  const loaded = loadBuiltinRecipe("work-tracking");
  if (!loaded || !loaded.ok) throw new Error("built-in load failed");
  await installRecipe(bundle, loaded.recipe);
  const empty = { kinds: new Map(), warnings: [] };
  await mutateDocument({ bundle, id: "research/first", mode: "create-only", registry: empty, strict: false,
    buildCandidate: () => ({ frontmatter: { type: "Research", title: "First" }, body: "# Summary\nObserved" }) });
  const text = { inferredBody: () => "Accepted local shape.\n" };
  const plan = await prepareKindDraft(bundle, "Research", text);
  await applyKindDraft(bundle, "Research", plan.token, text);
  const registry = buildKindRegistry(await query(backend, { prefix: "conventions/" }));
  const kind = registry.kinds.get("Research");
  if (!kind || !registry.kinds.has("Task")) throw new Error("structured bundle missing Kinds");
  const candidate = kindInstanceCandidate(kind, { title: "Second" });
  const created = await mutateDocument({ bundle, id: "research/second", mode: "create-only", registry, strict: true, buildCandidate: () => candidate });
  const declined = await dismissKind(bundle, "Freeform", { body: () => "Deliberately freeform.\n" });
  let refused = false;
  try { await applyKindDraft(bundle, "Research", plan.token, text); }
  catch (error) { refused = error instanceof KindAuthoringError && error.reason === "already-governed"; }
  if (!refused || !declined.changed || created.warnings.length) throw new Error("authoring contract failed");
  return { builtin: loaded.recipe.id, kind: created.doc.frontmatter.type, body: created.doc.body, declined: declined.id };
}
`);
    await run(process.execPath, ["--input-type=module", "-e", 'import { exerciseKindAuthoring } from "./kind-authoring-consumer.mjs"; await exerciseKindAuthoring();'], scratch);
    const authoringBundle = await build({ absWorkingDir: scratch, entryPoints: ["kind-authoring-consumer.mjs"], bundle: true,
      platform: "browser", format: "iife", globalName: "KindAuthoringProof", write: false, logLevel: "silent" });
    const authored = await runInNewContext(authoringBundle.outputFiles[0].text + '\nKindAuthoringProof.exerciseKindAuthoring()', { TextEncoder, TextDecoder, structuredClone }, { timeout: 5000 });
    assert.deepEqual(JSON.parse(JSON.stringify(authored)), { builtin: "work-tracking", kind: "Research", body: "# Summary\n", declined: "conventions/freeform" });

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
import { memorySearchSource, searchDocuments, searchRowText, SearchInputError, textVersion, type SearchDocumentV1, type SearchResultV1, type SearchRowTextV1, type SearchSource } from "@superbee/core/search";
import { parseRecipeFiles, recipeConnectors, type RecipeConnector, type RecipeFile, type LoadResult } from "@superbee/core/recipes";
import { builtinNames, loadBuiltinRecipe } from "@superbee/core/builtin-recipes";
import { prepareKindDraft, applyKindDraft, dismissKind, kindInstanceCandidate, type KindDraftPlan } from "@superbee/core/kind-authoring";
import { buildKindRegistry, validateAgainstKind } from "@superbee/core/kinds";
import { ConnectorTargetUnsatisfied, installRecipe, installedConnectorDocs, installedRecipes, planRecipeEvolution, RecipeLifecycleError, type RecipeInstallState } from "@superbee/core/recipe-lifecycle";
import { applyRecordOverlay, buildSourceIndex, OverlayRefusal, planRecordOverlay, type OverlayBundle, type OverlayPolicy, type OverlayReceipt, type RecordChange } from "@superbee/core/record-overlay";
import { bundleHealth, bundleKindFindings, type BindDependencies, type BundleHealthReport } from "@superbee/core/bundle-health";
import { bindSourceFeed, changeBetween, connectorPinDigest, findingsFor, mapRecord, parseConnectorDoc, type Connector, type ConnectorError } from "@superbee/core/connectors";
import { MemoryMachineState, observeSource, type ObservePage, type SourceProfile, type SourceRunReceipt, type Transport } from "@superbee/core/source-engine";
import { peerTransport, runTransportConformance, type ConformanceRow, type ScriptedPeer, type TransportCredential } from "@superbee/core/source-harness";
import type { BundleBinding } from "@superbee/core/cross-bundle";

declare const backend: StorageBackend;
declare const document: OkfDocument;
declare const files: RecipeFile[];
const recipe: LoadResult = parseRecipeFiles(files, "memory:typed");
if (recipe.ok) {
  const registry = buildKindRegistry(recipe.recipe.docs);
  const kind = registry.kinds.get(String(document.frontmatter.type));
  if (kind) validateAgainstKind(document, kind);
}
export async function exercisePortableCore(): Promise<void> {
  assertSafeConceptId(document.id);
  await writeDocVersioned(backend, document);
  await queryHeads(backend, { type: String(document.frontmatter.type) });
}
export const portableRuntime = { InvalidInputError, VersionConflict, RemoteBackend, RemoteError };
export async function exerciseKindAuthoringTypes(bundle: Parameters<typeof prepareKindDraft>[0]): Promise<KindDraftPlan> {
  const loaded = loadBuiltinRecipe(builtinNames()[0]!);
  if (loaded?.ok) await installRecipe(bundle, loaded.recipe);
  const plan = await prepareKindDraft(bundle, "Research");
  await applyKindDraft(bundle, "Research", plan.token);
  await dismissKind(bundle, "Freeform");
  kindInstanceCandidate(plan.candidateKind, { title: "typed" }, "");
  return plan;
}
declare const lifecycleBundle: Parameters<typeof installRecipe>[0];
export async function exerciseRecipeLifecycle(): Promise<string | undefined> {
  if (!recipe.ok) return undefined;
  await installRecipe(lifecycleBundle, recipe.recipe, { now: "2026-10-17T00:00:00.000Z" });
  return (await planRecipeEvolution(lifecycleBundle, recipe.recipe)).plan_token;
}
export function installStates(conventions: OkfDocument[]): RecipeInstallState[] {
  return installedRecipes(conventions).rows.map((row) => row.state);
}
export async function connectorCarriage(): Promise<number> {
  if (!recipe.ok) return 0;
  const carried: readonly RecipeConnector[] = recipeConnectors(recipe.recipe);
  const installed = [...(await installedConnectorDocs(lifecycleBundle)).values()];
  return carried.length + installedRecipes(installed).rows.reduce((count, row) => count + (row.connectors ?? 0), 0);
}
export const lifecycleRuntime = { RecipeLifecycleError, ConnectorTargetUnsatisfied };
declare const overlayBundle: OverlayBundle;
declare const overlayPolicy: OverlayPolicy;
declare const overlayChanges: RecordChange[];
export async function exerciseRecordOverlay(): Promise<OverlayReceipt> {
  const overlays = await buildSourceIndex(overlayBundle.bundle, { type: overlayPolicy.target_kind });
  const plan = await planRecordOverlay({ content: overlayBundle, ops: overlayBundle, policy: overlayPolicy, changes: overlayChanges, observedAt: "2026-10-17T00:00:00Z", overlays });
  return applyRecordOverlay(plan, { content: overlayBundle, ops: overlayBundle, policy: overlayPolicy, actor: "process:worker", overlays });
}
export const overlayRuntime = { OverlayRefusal };
declare const connectorDocument: OkfDocument;
declare const sourceFeed: OkfDocument;
export async function exerciseConnectors(): Promise<string | ConnectorError[]> {
  const parsed = parseConnectorDoc(connectorDocument, { kinds: overlayBundle.registry });
  if (!parsed.ok) return parsed.errors;
  const connector: Connector = parsed.connector;
  const bound = bindSourceFeed(connector, sourceFeed, overlayBundle.registry);
  const mapped = mapRecord(bound.source, { uid: "worker-1" }, bound.kind);
  if (mapped.kind === "mapped") {
    const change: RecordChange = changeBetween(null, mapped, { external_id: mapped.external_id, change_kind: "new" });
    await planRecordOverlay({ content: overlayBundle, ops: overlayBundle, policy: bound.policy, changes: [change], observedAt: "2026-10-17T00:00:00Z" });
  }
  return findingsFor(mapped.diagnostics, { source: bound.source.name }).length + connectorPinDigest(connector);
}
declare const healthBundle: Parameters<typeof bundleHealth>[0];
export async function exerciseBundleHealth(): Promise<number> {
  const bind: BindDependencies = async (declared) => new Map([...declared.dependencies.keys()].map((alias): [string, BundleBinding] => [alias, { backend, label: alias }]));
  const report: BundleHealthReport = await bundleHealth(healthBundle, { now: new Date(0), bindings: bind, selfBundleId: "worker" });
  const findings = bundleKindFindings([document], "0.2", { actor: "process:worker" });
  return report.malformed.length + report.kindLint.length + (report.crossBundle?.unchecked ?? 0) + findings.documents.length;
}
declare const searchCorpus: readonly SearchDocumentV1[];
export async function exerciseSearch(): Promise<[SearchResultV1, SearchRowTextV1, string]> {
  const source: SearchSource = memorySearchSource(searchCorpus, { key: "worker", maxSourceBytes: 1_048_576 });
  const result = await searchDocuments(source, { query: "worker", match: "any", limit: 5, prefix: "notes/" }, { scope: "worker" }, { signal: new AbortController().signal }, { maxEvidenceInstances: 10_000 });
  return [result, searchRowText(searchCorpus[0]!), textVersion()];
}
export const searchRuntime = { searchDocuments, SearchInputError };
declare const sourceTransport: Transport;
const workerProfile: SourceProfile<{ url: string }, { after: string }> = {
  id: "worker-pages", version: 1, kind: "generic",
  validateSpec: (spec) => ({ ok: true, spec: spec as { url: string } }),
  hostsFor: (spec) => [new URL(spec.url).hostname],
  async observe({ spec, cursor, transport }): Promise<ObservePage<{ after: string }>> {
    const response = await transport.request({ url: cursor ? spec.url + "?after=" + encodeURIComponent(cursor.after) : spec.url });
    return { records: JSON.parse(response.body) as Record<string, unknown>[], nextCursor: null, more: false, complete: true };
  },
};
export async function exerciseSourceEngine(): Promise<[SourceRunReceipt, ConformanceRow[]] | ConnectorError[]> {
  const parsed = parseConnectorDoc(connectorDocument, { kinds: overlayBundle.registry });
  if (!parsed.ok) return parsed.errors;
  const bound = bindSourceFeed(parsed.connector, sourceFeed, overlayBundle.registry);
  const receipt = await observeSource({
    connector: parsed.connector, bound, profile: workerProfile, spec: { url: "https://feeds.example.org/items" }, transport: sourceTransport,
    state: new MemoryMachineState(), identity: { userAgent: "Worker/1 (+https://worker.example.org)", productToken: "Worker" },
    signal: new AbortController().signal, commit: async (page) => ({ hold: page.changes.map((change: RecordChange) => change.external_id) }),
  });
  const rows = await runTransportConformance({ name: "worker", create: (peer: ScriptedPeer, credential: TransportCredential) => peerTransport(peer, { credential }) });
  return [receipt, rows];
}
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
    assert.ok(workerBundle.outputFiles[0].text.includes("connectorPinDigest"), "the connectors subpath bundles for a Worker");
    assert.ok(workerBundle.outputFiles[0].text.includes("observeSource"), "the source engine subpath bundles for a Worker");
    assert.ok(workerBundle.outputFiles[0].text.includes("runTransportConformance"), "the source harness subpath bundles for a Worker");

    const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    const sourceManifest = JSON.parse(
      await readFile(path.join(repoRoot, "packages", "core", "package.json"), "utf8"),
    );
    assert.equal(installedManifest.private, undefined);
    assert.equal(installedManifest.version, sourceManifest.version);
    assert.deepEqual(installedManifest.publishConfig, {
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
    assert.match(installedManifest.scripts.prepublishOnly, /process\.exit\(1\)/);
    assert.deepEqual(installedManifest.files, ["dist"]);
    assert.ok(installedManifest.exports["."]);
    assert.ok(installedManifest.exports["./kinds"]);
    assert.ok(installedManifest.exports["./recipes"]);
    for (const module of ["builtin-recipes", "kind-authoring"]) assert.deepEqual(installedManifest.exports[`./${module}`], { types: `./dist/${module}.d.ts`, default: `./dist/${module}.js` });
    assert.ok(installedManifest.exports["./engine"]);
    assert.ok(installedManifest.exports["./remote"]);
    assert.ok(installedManifest.exports["./storage"]);
    assert.ok(installedManifest.exports["./filesystem"]);
    assert.ok(installedManifest.exports["./view-admission"]);
    assert.deepEqual(installedManifest.exports["./artifact-contract"], { types: "./dist/artifact-contract.d.ts", default: "./dist/artifact-contract.js" });
    assert.deepEqual(installedManifest.exports["./search"], { types: "./dist/search/index.d.ts", default: "./dist/search/index.js" });
    assert.deepEqual(installedManifest.exports["./hosted-client"], { types: "./dist/hosted-client/index.d.ts", default: "./dist/hosted-client/index.js" });
    assert.deepEqual(installedManifest.exports["./hosted-client/node"], { types: "./dist/hosted-client/node.d.ts", default: "./dist/hosted-client/node.js" });
    assert.deepEqual(installedManifest.exports["./recipe-lifecycle"], { types: "./dist/recipe-lifecycle/index.d.ts", default: "./dist/recipe-lifecycle/index.js" });
    assert.deepEqual(installedManifest.exports["./record-overlay"], { types: "./dist/record-overlay/index.d.ts", default: "./dist/record-overlay/index.js" });
    assert.deepEqual(installedManifest.exports["./connectors"], { types: "./dist/connectors.d.ts", default: "./dist/connectors.js" });
    assert.deepEqual(installedManifest.exports["./source-engine"], { types: "./dist/source-engine/index.d.ts", default: "./dist/source-engine/index.js" });
    assert.deepEqual(installedManifest.exports["./source-harness"], { types: "./dist/source-harness/index.d.ts", default: "./dist/source-harness/index.js" });
    assert.deepEqual(installedManifest.exports["./bundle-health"], { types: "./dist/bundle-health/index.d.ts", default: "./dist/bundle-health/index.js" });
    const installedFiles = await filesUnder(installed);
    assert.ok(installedFiles.every((file) => file === "package.json" || file === "README.md" || file.startsWith("dist/")));
    assert.ok(installedFiles.includes("dist/hosted-client/index.js"), "the hosted client subpath is packed");
    assert.ok(installedFiles.includes("dist/hosted-client/node.js"), "the hosted client's Node-only subpath is packed");
    assert.ok(installedFiles.includes("dist/recipe-lifecycle/index.js"), "the recipe lifecycle subpath is packed");
    assert.ok(installedFiles.includes("dist/recipe-lifecycle/stamp.js"), "the recipe install stamps are packed");
    assert.ok(installedFiles.includes("dist/record-overlay/index.js"), "the record overlay subpath is packed");
    assert.ok(installedFiles.includes("dist/record-overlay/apply.js"), "the record overlay guards are packed");
    assert.ok(installedFiles.includes("dist/connectors.js"), "the connectors subpath is packed");
    assert.ok(installedFiles.includes("dist/source-engine/index.js"), "the source engine subpath is packed");
    assert.ok(installedFiles.includes("dist/source-engine/guard.js"), "the source engine's guarded transport is packed");
    assert.ok(installedFiles.includes("dist/source-harness/index.js"), "the source harness subpath is packed");
    assert.ok(installedFiles.includes("dist/source-harness/conformance.js"), "the transport conformance suite is packed");
    assert.ok(installedFiles.includes("dist/bundle-health/index.js"), "the bundle health subpath is packed");
    assert.ok(installedFiles.includes("dist/bundle-health/report.js"), "the bundle health report is packed");
    assert.ok(installedFiles.includes("dist/bundle-health/kind-findings.js"), "the Kind findings rule is packed");
    assert.ok(installedFiles.includes("dist/search/index.js"), "the search subpath is packed");
    assert.ok(installedFiles.includes("dist/search/memory-source.js"), "the in-memory search source is packed");
    assert.ok(workerBundle.outputFiles[0].text.includes("searchDocuments"), "the search subpath bundles for a Worker");

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
