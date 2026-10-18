/**
 * Isomorphic-boundary gate: every core subpath the BROWSER runtime-imports must bundle for the
 * browser with no `node:*` builtin. The SPA (packages/ui) runtime-imports `@superbee/core`
 * subpaths — `links` (resolveConceptId), `meaningful-change-time`
 * (meaningfulChangeTimeValue), `page` (parseRegistration), `query-selection`
 * (applyQuerySelectionFilters), `kinds` (isTerminal) — into a bundle where node builtins do not
 * resolve.
 *
 * This DECLARES that isomorphic surface once and gates it, rather than discovering a Node-only
 * import the hard way at build time (the `links.ts` → `node:path` break, designs/doc-reader HIGH-1,
 * cost a real detour). Each subpath is bundled with esbuild `platform: "browser"`; any node builtin
 * sneaking in fails with "Could not resolve" (red-on-regression). Requires a prior root build — the
 * sibling-dist convention other core tests document.
 *
 * ADD A SUBPATH HERE when the browser starts runtime-importing a new core subpath — keep this list
 * in sync with the SPA's runtime `@superbee/core/*` imports. `versioning` and `memory-backend`
 * are the browser-local working copy's token minting and store for SaaS mode, `indexeddb-backend`
 * its persistent store candidate and `journaled-backend` the seam its sync runtime programs
 * against; `mutation`, `bundle-ops` and `document-mutation` are its
 * read/decide/CAS document mutation path; `uncertain-write` is the shared unknown-outcome
 * primitive its sync component pushes intents through, and `remote-operations` the transport
 * that carries those intents to a wire authority as identified writes; `platform` is the
 * contract a presentation programs against above both execution modes. `bundle-health` is the
 * status report a browser host computes in process, and `kinds-load` the registry load it runs.
 * `connectors` is the declaration parser and mapping contract a hosted runner shares;
 * `source-engine` is the observation loop and guarded transport every runner shares, and
 * `source-harness` the fixture harness and transport conformance suite they prove it with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { build } from "esbuild";

import { stringifyDoc } from "../src/frontmatter.js";
import { contentVersion } from "../src/versioning.js";
import type { OkfDocument } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** subpath dist module -> a symbol the bundle must still carry (proves the entry resolved, not an empty file). */
const BROWSER_SUBPATHS: Array<{ module: string; symbol: string }> = [
  { module: "artifact-contract.js", symbol: "decodeDocumentTargetV1" },
  { module: "engine.js", symbol: "writeDocVersioned" },
  { module: "links.js", symbol: "resolveConceptId" },
  { module: "qualified-links.js", symbol: "parseQualifiedHref" },
  { module: "dependencies.js", symbol: "parseDependencies" },
  { module: "cross-bundle.js", symbol: "createLocalResolver" },
  { module: "meaningful-change-time.js", symbol: "meaningfulChangeTimeValue" },
  { module: "page.js", symbol: "parseRegistration" },
  { module: "query-filter.js", symbol: "matchesFilter" },
  { module: "query-order.js", symbol: "compareByMeaningfulChange" },
  { module: "query-selection.js", symbol: "applyQuerySelectionFilters" },
  { module: "kinds.js", symbol: "isTerminal" },
  { module: "remote.js", symbol: "RemoteBackend" },
  { module: "remote-operations.js", symbol: "createRemoteOperationTransport" },
  { module: "storage.js", symbol: "assertSafeConceptId" },
  { module: "versioning.js", symbol: "contentVersion" },
  { module: "memory-backend.js", symbol: "MemoryBackend" },
  { module: "indexeddb-backend.js", symbol: "IndexedDbBackend" },
  { module: "journaled-backend.js", symbol: "IntentStateConflict" },
  { module: "mutation.js", symbol: "versionedMutation" },
  { module: "bundle-ops.js", symbol: "backendFor" },
  { module: "document-mutation.js", symbol: "mutateDocument" },
  { module: "uncertain-write.js", symbol: "performUncertainWrite" },
  { module: "governed-body-write.js", symbol: "performBodyDelivery" },
  { module: "platform.js", symbol: "provenanceLabel" },
  { module: "hosted-transport/index.js", symbol: "createHostedReadAdapter" },
  { module: "hosted-client/index.js", symbol: "createHostedClient" },
  { module: "recipe-lifecycle/index.js", symbol: "planRecipeEvolution" },
  { module: "record-overlay/index.js", symbol: "planRecordOverlay" },
  { module: "connectors.js", symbol: "parseConnectorDoc" },
  { module: "source-engine/index.js", symbol: "observeSource" },
  { module: "source-harness/index.js", symbol: "runTransportConformance" },
  { module: "kinds-load.js", symbol: "loadKinds" },
  { module: "bundle-health/index.js", symbol: "bundleHealth" },
  // The one search engine: the working copy's page tool and a site Worker run it in process.
  { module: "search/index.js", symbol: "searchDocuments" },
];

for (const { module, symbol } of BROWSER_SUBPATHS) {
  test(`core/${module} bundles for the browser with no node builtins`, async () => {
    const result = await build({
      entryPoints: [path.resolve(here, "../dist", module)],
      bundle: true,
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0, `${module}: ${JSON.stringify(result.errors, null, 2)}`);
    assert.ok(result.outputFiles[0]!.text.includes(symbol), `${module}: bundled output must carry ${symbol}`);
  });
}

test("core/versioning mints Node-identical tokens in a sandbox with no process, Buffer, or node:crypto", async () => {
  const result = await build({
    entryPoints: [path.resolve(here, "../dist/versioning.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeVersioning",
    write: false,
    logLevel: "silent",
  });
  const sandbox: Record<string, unknown> = { TextEncoder };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  runInNewContext(result.outputFiles[0]!.text, sandbox);
  const versioning = sandbox.SuperbeeVersioning as {
    contentVersion(doc: { id: string; frontmatter: Record<string, unknown>; body: string }): string;
    blobVersion(bytes: Uint8Array): string;
    defaultActor(): string;
  };
  const doc = { id: "browser/proof", frontmatter: { type: "Proof", title: "Ünïcödé 🐝" }, body: "same bytes, same token\n" };
  assert.equal(
    versioning.contentVersion(doc),
    `sha256:${createHash("sha256").update(stringifyDoc(doc.frontmatter, doc.body), "utf8").digest("hex")}`,
  );
  const blob = new Uint8Array([0x80, 0xff, 0xfe, 0x00]);
  assert.equal(versioning.blobVersion(blob), `sha256:${createHash("sha256").update(blob).digest("hex")}`);
  assert.equal(versioning.defaultActor(), "local");
});

test("core/engine executes bundle-version parsing with no Buffer global", async () => {
  const result = await build({
    entryPoints: [path.resolve(here, "../dist/engine.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeEngine",
    write: false,
    logLevel: "silent",
  });
  const sandbox: Record<string, unknown> = {};
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  runInNewContext(result.outputFiles[0]!.text, sandbox);
  const engine = sandbox.SuperbeeEngine as {
    readBundleOkfVersion(backend: unknown): Promise<string | undefined>;
    writeDocVersioned(
      backend: unknown,
      doc: { id: string; frontmatter: Record<string, unknown>; body: string },
    ): Promise<{ doc: { frontmatter: Record<string, unknown> }; version: string }>;
  };
  let written: { frontmatter: Record<string, unknown> } | undefined;
  const backend = {
    readReserved: async () => ({
      content: "\uFEFF---\nokf_version: '0.2'\n---\n# Worker-safe\n",
      version: "proof",
    }),
    write: async (_id: string, doc: { frontmatter: Record<string, unknown> }) => {
      written = doc;
      return "sha256:proof";
    },
  };
  assert.equal(await engine.readBundleOkfVersion(backend), "0.2");
  const resultDoc = await engine.writeDocVersioned(backend, {
    id: "worker/bom-proof",
    frontmatter: { type: "Proof" },
    body: "v0.2 stays v0.2",
  });
  assert.equal(resultDoc.doc.frontmatter.timestamp, undefined);
  assert.equal(written?.frontmatter.timestamp, undefined);
});

test("core/document-mutation updates a document body over MemoryBackend in a sandbox with no process, Buffer, or node builtins, minting Node's version", async () => {
  // One bundle for the mutation path and the store, so the sandbox shares a single class graph
  // (VersionConflict, MemoryBackend) exactly as a browser working copy would.
  const result = await build({
    stdin: {
      contents: [
        'export { mutateDocument } from "./document-mutation.js";',
        'export { backendFor } from "./bundle-ops.js";',
        'export { MemoryBackend } from "./memory-backend.js";',
      ].join("\n"),
      resolveDir: path.resolve(here, "../dist"),
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeMutation",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  // TextEncoder is a web platform global. structuredClone is too, but Node's clones carry the
  // outer realm's prototypes and the engine's mapping checks are per realm, so the sandbox gets
  // an in-realm clone shim and the whole proof runs inside that one realm, as a browser would.
  const sandbox: Record<string, unknown> = { TextEncoder };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  assert.equal(runInNewContext("typeof require", sandbox), "undefined");
  runInNewContext("globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));", sandbox);
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  // No Node entry ran in the sandbox, so a bare { root } has no filesystem default to fall back on.
  // The sandbox realm has its own Error constructor, so identify the refusal by name, not instanceof.
  const refusal = runInNewContext(
    "(() => { try { SuperbeeMutation.backendFor({ root: '/nowhere' }); return null; } catch (error) { return { name: error.name, message: error.message }; } })()",
    sandbox,
  ) as { name: string; message: string } | null;
  assert.equal(refusal?.name, "InvalidInputError");
  assert.match(refusal?.message ?? "", /pass bundle\.backend explicitly/);

  const proof = (await runInNewContext(
    `(async () => {
      const { mutateDocument, MemoryBackend } = SuperbeeMutation;
      const backend = new MemoryBackend();
      await backend.writeReserved("", "index.md", "---\\nokf_version: '0.2'\\n---\\n# Browser proof\\n");
      const bundle = { root: "browser-working-copy", backend };
      const registry = { kinds: new Map(), warnings: [] };
      const id = "browser/proof";
      const created = await mutateDocument({
        bundle, id, mode: "create-only", registry, strict: false, actor: "process:browser",
        now: () => "2026-09-10T12:00:00.000Z",
        buildCandidate: () => ({ frontmatter: { type: "Proof", title: "\u00dcn\u00efc\u00f6d\u00e9 \u{1F41D}" }, body: "first body\\n" }),
      });
      const updated = await mutateDocument({
        bundle, id, mode: "patch", registry, strict: false, actor: "process:browser",
        now: () => "2026-09-10T12:05:00.000Z",
        buildCandidate: (existing) => ({ frontmatter: { ...existing.frontmatter }, body: "second body\\n" }),
      });
      const head = await backend.read(id);
      const history = await backend.versions(id);
      return JSON.stringify({ created, updated, headVersion: head.version, historyLength: history.length });
    })()`,
    sandbox,
  )) as string;
  const { created, updated, headVersion, historyLength } = JSON.parse(proof) as {
    created: { doc: OkfDocument; changed: boolean; version: string };
    updated: { doc: OkfDocument; changed: boolean; version: string };
    headVersion: string;
    historyLength: number;
  };
  assert.equal(created.changed, true);
  assert.equal(created.version, contentVersion(created.doc));

  assert.equal(updated.changed, true);
  assert.equal(updated.doc.body, "second body\n");
  assert.equal(updated.doc.frontmatter.title, "\u00dcn\u00efc\u00f6d\u00e9 \u{1F41D}");
  assert.notEqual(updated.version, created.version);
  assert.equal(updated.version, contentVersion(updated.doc), "sandbox token equals the Node engine's contentVersion");
  assert.equal(
    updated.version,
    `sha256:${createHash("sha256").update(stringifyDoc(updated.doc.frontmatter, updated.doc.body), "utf8").digest("hex")}`,
    "sandbox token equals node:crypto over the same serialized bytes",
  );
  assert.equal(headVersion, updated.version, "the store's head is the write the sandbox reported");
  assert.equal(historyLength, 2, "one create and one CAS update, no retries");
});

test("core/recipe-lifecycle installs a View recipe, plans and applies its evolution in a sandbox with no process, Buffer, or node builtins", async () => {
  // The esbuild bundle alone cannot see a free `Buffer` identifier; executing install (View blob
  // write and compare), plan (View entry version) and apply in a realm without one can.
  const result = await build({
    stdin: {
      contents: [
        'export { applyRecipeEvolution, installRecipe, installedRecipes, planRecipeEvolution } from "./recipe-lifecycle/index.js";',
        'export { MemoryBackend } from "./memory-backend.js";',
      ].join("\n"),
      resolveDir: path.resolve(here, "../dist"),
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeRecipes",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  assert.equal(runInNewContext("typeof require", sandbox), "undefined");
  // The vm realm has no structuredClone; the document-mutation proof above uses the same in-realm shim.
  runInNewContext("globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));", sandbox);
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  const html = "<!doctype html><p>\u00dcn\u00efc\u00f6d\u00e9 gallery \u{1F41D}</p>\n";
  const proof = (await runInNewContext(
    `(async () => {
      const { applyRecipeEvolution, installRecipe, installedRecipes, planRecipeEvolution, MemoryBackend } = SuperbeeRecipes;
      const backend = new MemoryBackend();
      await backend.writeReserved("", "index.md", "---\\nokf_version: '0.2'\\n---\\n# Sandbox recipes\\n");
      const bundle = { root: "browser-recipes", backend };
      const recipe = (version, optional) => ({
        id: "gallery", title: "Gallery", version, summary: "Gallery.", offer: "Gallery", source: "sandbox:gallery:" + version,
        docs: [{ id: "conventions/exhibit", frontmatter: { type: "Convention", title: "Exhibit", governs: "Exhibit", fields: { required: ["title"], optional } }, body: "# Exhibit\\n" }],
        pages: [{
          registry: { id: "views-registry/gallery", frontmatter: { type: "View", title: "Gallery", entry: "views/gallery/index.html", access: "none" }, body: "Every exhibit.\\n" },
          entry: "views/gallery/index.html",
          html: ${JSON.stringify(html)},
        }],
        references: [], governs: ["Exhibit"], warnings: [],
      });
      const installed = await installRecipe(bundle, recipe("1", []), { now: "2026-10-16T12:00:00.000Z" });
      const reinstalled = await installRecipe(bundle, recipe("1", []), { now: "2026-10-16T12:00:00.000Z" });
      const plan = await planRecipeEvolution(bundle, recipe("2", ["room"]));
      const applied = await applyRecipeEvolution(bundle, recipe("2", ["room"]), plan.plan_token, { actor: "process:sandbox" });
      const settled = await planRecipeEvolution(bundle, recipe("2", ["room"]));
      const blob = await backend.readBlob("views/gallery/index.html");
      const convention = await backend.read("conventions/exhibit");
      const state = installedRecipes([convention.doc]).rows.map(({ id, state, version }) => ({ id, state, version }));
      return JSON.stringify({
        installed: installed.counts, reinstalled: reinstalled.counts,
        plan: { ready: plan.ready, changed: plan.changed, token: plan.plan_token, blockers: plan.blockers },
        applied: { recipe: applied.recipe, counts: applied.counts },
        settled: { ready: settled.ready, changed: settled.changed, writes: settled.writes },
        stamp: convention.doc.frontmatter.x_recipe, state,
        blob: Array.from(blob.bytes), blobVersion: blob.version,
        optional: convention.doc.frontmatter.fields.optional,
      });
    })()`,
    sandbox,
  )) as string;
  const outcome = JSON.parse(proof) as {
    installed: Record<string, number>;
    reinstalled: Record<string, number>;
    plan: { ready: boolean; changed: boolean; token: string; blockers: unknown[] };
    applied: { recipe: string; counts: Record<string, number> };
    settled: { ready: boolean; changed: boolean; writes: number };
    stamp: Record<string, unknown>;
    state: unknown[];
    blob: number[];
    blobVersion: string;
    optional: string[];
  };
  assert.deepEqual(outcome.installed, { created: 2, existing: 0, legacy_present: 0, migration_required: 0 });
  assert.deepEqual(outcome.reinstalled, { created: 0, existing: 2, legacy_present: 0, migration_required: 0 });
  assert.deepEqual(outcome.plan.blockers, []);
  assert.equal(outcome.plan.ready, true);
  assert.equal(outcome.plan.changed, true);
  assert.match(outcome.plan.token, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(outcome.applied, { recipe: "evolved", counts: { updated: 1, stamped: 0, unchanged: 0 } });
  assert.deepEqual(outcome.settled, { ready: true, changed: false, writes: 0 });
  assert.equal(outcome.stamp.version, "2");
  assert.match(String(outcome.stamp.definition), /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(outcome.state, [{ id: "gallery", state: "installed", version: "2" }]);
  assert.deepEqual(outcome.optional, ["room"]);
  const nodeBytes = Buffer.from(html, "utf8");
  assert.deepEqual(outcome.blob, Array.from(nodeBytes), "the sandbox wrote the bytes Node's UTF-8 encoder produces");
  assert.equal(outcome.blobVersion, `sha256:${createHash("sha256").update(nodeBytes).digest("hex")}`);
});

test("core/record-overlay plans and applies over MemoryBackend in a sandbox with only TextEncoder, URL and structuredClone, matching Node's plan", async () => {
  const result = await build({
    stdin: {
      contents: [
        'export { applyRecordOverlay, planRecordOverlay, readOverlayPolicy } from "./record-overlay/index.js";',
        'export { MemoryBackend } from "./memory-backend.js";',
        'export { buildKindRegistry } from "./kinds.js";',
      ].join("\n"),
      resolveDir: path.resolve(here, "../dist"),
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeOverlay",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  const sandbox: Record<string, unknown> = { TextEncoder, URL };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  assert.equal(runInNewContext("typeof require", sandbox), "undefined");
  runInNewContext("globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));", sandbox);
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  // The same scenario runs in Node from source; the plans must agree byte for byte.
  const scenario = `async (api) => {
    const { applyRecordOverlay, planRecordOverlay, readOverlayPolicy, MemoryBackend, buildKindRegistry } = api;
    const provider = "https://calendar.example.org/feed.ics?token=sandbox-secret";
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", "---\\nokf_version: '0.2'\\n---\\n# Sandbox overlay\\n");
    const bundle = { root: "browser-overlay", backend };
    const conventions = [
      { id: "conventions/event", body: "", frontmatter: { type: "Convention", title: "Event", governs: "Event", fields: { required: ["title", "start"], optional: ["event_status"] } } },
      { id: "conventions/signal", body: "", frontmatter: { type: "Convention", title: "Signal", governs: "Signal", path: "signals/", links: { "from feed": "Source Feed" },
        claim: { owner_field: "assignee", state_field: "progress_status" },
        fields: { required: ["title", "superbee_progress_status", "change_kind", "observed_at"], optional: ["provider", "external_id", "diff_summary", "priority", "assignee", "about_doc"] } } },
    ];
    for (const doc of conventions) await backend.write(doc.id, doc);
    await backend.write("events/story", { id: "events/story", body: "Editor text.\\n", frontmatter: { type: "Event", title: "Story", start: "2026-10-10T10:00:00-04:00", event_status: "scheduled", sources: [{ resource: provider, id: "rec-1" }] } });
    const registry = buildKindRegistry(conventions, [], { okfVersion: "0.2" });
    const overlay = { bundle, registry, okfVersion: "0.2" };
    const policy = readOverlayPolicy({ id: "source-feeds/sandbox", frontmatter: { url: provider, target_kind: "Event", owned_fields: ["start", "event_status"], auto_apply: ["changed", "canceled"] } }, { targetKind: registry.kinds.get("Event") });
    const plan = await planRecordOverlay({ content: overlay, ops: overlay, policy, sameBundle: true, observedAt: "2026-10-03T14:00:00Z", changes: [
      { external_id: "rec-1", change_kind: "canceled", changed_fields: ["event_status"], before: { title: "Story", event_status: "scheduled" }, after: { title: "Story", event_status: "canceled" }, content_digest: "sha256:aa" },
      { external_id: "rec-2", change_kind: "new", changed_fields: ["title"], before: null, after: { title: "Ünïcödé 🐝" }, content_digest: "sha256:bb" },
    ] });
    const receipt = await applyRecordOverlay(plan, { content: overlay, ops: overlay, policy, actor: "process:sandbox" });
    const story = await backend.read("events/story");
    const signals = (await backend.list("signals/")).length;
    return JSON.stringify({ plan, outcomes: receipt.results.map((r) => r.outcome), status: story.doc.frontmatter.event_status, signals });
  }`;
  const inSandbox = JSON.parse(await (runInNewContext(`(${scenario})(SuperbeeOverlay)`, sandbox) as Promise<string>)) as {
    plan: { steps: Array<{ op: string; target: string; candidate?: { frontmatter: Record<string, unknown> } }> };
    outcomes: string[];
    status: string;
    signals: number;
  };
  const overlayApi = await import("../src/record-overlay/index.js");
  const { MemoryBackend } = await import("../src/memory-backend.js");
  const { buildKindRegistry } = await import("../src/kinds.js");
  const inNode = JSON.parse(await (new Function("api", `return (${scenario})(api)`)({ ...overlayApi, MemoryBackend, buildKindRegistry }) as Promise<string>)) as typeof inSandbox;
  assert.deepEqual(inSandbox.outcomes, ["applied", "applied", "applied"]);
  assert.equal(inSandbox.status, "canceled");
  assert.equal(inSandbox.signals, 2);
  assert.deepEqual(inSandbox.plan, inNode.plan, "the sandbox plan equals Node's: ids, digests, versions and redaction");
  assert.ok(!JSON.stringify(inSandbox.plan.steps.filter((s) => s.op === "create-signal")).includes("sandbox-secret"));
});

test("core/connectors parses, binds, maps and drives record-overlay over MemoryBackend in a sandbox with only TextEncoder, URL and structuredClone, matching Node's", async () => {
  const result = await build({
    stdin: {
      contents: [
        'export { bindSourceFeed, changeBetween, connectorPinDigest, findingsFor, mapRecord, parseConnectorDoc } from "./connectors.js";',
        'export { applyRecordOverlay, planFindings, planRecordOverlay } from "./record-overlay/index.js";',
        'export { MemoryBackend } from "./memory-backend.js";',
        'export { buildKindRegistry } from "./kinds.js";',
      ].join("\n"),
      resolveDir: path.resolve(here, "../dist"),
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeConnectors",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  const sandbox: Record<string, unknown> = { TextEncoder, URL };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  assert.equal(runInNewContext("typeof require", sandbox), "undefined");
  runInNewContext("globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));", sandbox);
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  const scenario = `async (api) => {
    const { bindSourceFeed, changeBetween, connectorPinDigest, findingsFor, mapRecord, parseConnectorDoc, applyRecordOverlay, planFindings, planRecordOverlay, MemoryBackend, buildKindRegistry } = api;
    const url = "https://calendar.example.org/library.ics";
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", "---\\nokf_version: '0.2'\\n---\\n# Sandbox connectors\\n");
    const bundle = { root: "browser-connectors", backend };
    const conventions = [
      { id: "conventions/event", body: "", frontmatter: { type: "Convention", title: "Event", governs: "Event", fields: { required: ["title", "event_status"], optional: [], values: { event_status: ["scheduled", "canceled"] } } } },
      { id: "conventions/signal", body: "", frontmatter: { type: "Convention", title: "Signal", governs: "Signal", path: "signals/", claim: { owner_field: "assignee", state_field: "progress_status" },
        fields: { required: ["title", "superbee_progress_status", "change_kind", "observed_at"], optional: ["provider", "external_id", "diff_summary", "priority", "assignee", "content_digest"] } } },
    ];
    for (const doc of conventions) await backend.write(doc.id, doc);
    await backend.write("events/story", { id: "events/story", body: "Editor text.\\n", frontmatter: { type: "Event", title: "Story", event_status: "scheduled", sources: [{ resource: url, id: "evt-1" }] } });
    const registry = buildKindRegistry(conventions, [], { okfVersion: "0.2" });
    const parsed = parseConnectorDoc({ id: "connectors/calendar", body: "Prose.\\n", frontmatter: {
      type: "Connector", title: "Calendar", auth: { kind: "none" }, domains: ["calendar.example.org"],
      record_sources: [{ name: "events", profile: "ics", target_kind: "Event", identity: { resource: "https://calendar.example.org/{feed}.ics", id: "{uid}" },
        fields: { title: "summary", event_status: { from: "status", values: { CONFIRMED: "scheduled", CANCELLED: "canceled" } } }, completeness: "complete" }],
    } }, { kinds: registry });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const bound = bindSourceFeed(parsed.connector, { id: "source-feeds/library", frontmatter: { type: "Source Feed", connector: "connectors/calendar", source: "events", url, owned_fields: ["title", "event_status"], auto_apply: ["changed", "canceled"] } }, registry);
    const overlay = { bundle, registry, okfVersion: "0.2" };
    const previous = { title: "Story", event_status: "scheduled" };
    const changes = [];
    const diagnostics = [];
    for (const record of [{ uid: "evt-1", summary: "Story Time", status: "WITHDRAWN" }, { uid: "evt-2", summary: "Ünïcödé 🐝", status: "WITHDRAWN" }]) {
      const mapped = mapRecord(bound.source, record, bound.kind);
      diagnostics.push(...mapped.diagnostics);
      if (mapped.kind !== "mapped") continue;
      const before = mapped.external_id === "evt-1" ? previous : null;
      changes.push(changeBetween(before, mapped, { external_id: mapped.external_id, change_kind: before ? "changed" : "new" }));
    }
    const plan = await planRecordOverlay({ content: overlay, ops: overlay, policy: bound.policy, sameBundle: true, observedAt: "2026-10-03T14:00:00Z", changes });
    const receipt = await applyRecordOverlay(plan, { content: overlay, ops: overlay, policy: bound.policy, actor: "process:sandbox" });
    const steps = await planFindings({ ops: overlay, provider: url, feed: "source-feeds/library", slug: "library-mapping", findings: findingsFor(diagnostics, { source: "events" }), observedAt: "2026-10-03T14:00:00Z" });
    const story = await backend.read("events/story");
    const { title, event_status } = story.doc.frontmatter;
    return JSON.stringify({ pin: connectorPinDigest(parsed.connector), changes, plan, outcomes: receipt.results.map((r) => r.outcome), steps, story: { title, event_status } });
  }`;
  const inSandbox = JSON.parse(await (runInNewContext(`(${scenario})(SuperbeeConnectors)`, sandbox) as Promise<string>)) as {
    pin: string;
    changes: Array<{ changed_fields: string[]; after: Record<string, unknown> }>;
    plan: unknown;
    outcomes: string[];
    steps: Array<{ op: string }>;
    story: Record<string, unknown>;
  };
  const connectorsApi = await import("../src/connectors.js");
  const overlayApi = await import("../src/record-overlay/index.js");
  const { MemoryBackend } = await import("../src/memory-backend.js");
  const { buildKindRegistry } = await import("../src/kinds.js");
  const inNode = JSON.parse(await (new Function("api", `return (${scenario})(api)`)({ ...connectorsApi, ...overlayApi, MemoryBackend, buildKindRegistry }) as Promise<string>)) as typeof inSandbox;
  assert.deepEqual(inSandbox, inNode, "the sandbox run equals Node's: pin, changes, plan, outcomes and finding steps");
  assert.deepEqual(inSandbox.changes[0]!.changed_fields, ["title"], "the unmapped status is carried, not removed");
  assert.equal(inSandbox.story.title, "Story Time");
  assert.equal(inSandbox.story.event_status, "scheduled");
  assert.deepEqual(inSandbox.steps.map((s) => s.op), ["create-signal"], "two records with one unknown value raise one finding");

  // Without a URL global the userinfo rule still refuses, and the pin is unchanged.
  const bare: Record<string, unknown> = { TextEncoder };
  assert.equal(runInNewContext("typeof URL", bare), "undefined");
  runInNewContext(result.outputFiles[0]!.text, bare);
  const userinfo = runInNewContext(`JSON.stringify(SuperbeeConnectors.parseConnectorDoc({ id: "connectors/calendar", body: "", frontmatter: {
    type: "Connector", title: "Calendar", description: "Fetch https://reader:pw@calendar.example.org/x.ics daily.", auth: { kind: "none" },
    events: [{ name: "changed", signature: { scheme: "hmac-sha256", header: "x-signature" } }],
  } }))`, bare) as string;
  assert.deepEqual(JSON.parse(userinfo).errors.map((e: { code: string; path: string }) => [e.code, e.path]), [["CONNECTOR_SECRET_PRESENT", "/description"]]);
});

test("core/source-engine runs a paged observation and core/source-harness passes conformance in a sandbox with only TextEncoder, URL and the timer globals, matching Node's", async () => {
  const result = await build({
    stdin: {
      contents: [
        'export { fetchIdentity, MemoryMachineState, observeSource } from "./source-engine/index.js";',
        'export { peerTransport, runTransportConformance, ScriptedPeer } from "./source-harness/index.js";',
        'export { bindSourceFeed, parseConnectorDoc } from "./connectors.js";',
        'export { buildKindRegistry } from "./kinds.js";',
      ].join("\n"),
      resolveDir: path.resolve(here, "../dist"),
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeSource",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  // The engine's own deadline needs the timer and abort globals every browser and Worker has.
  const sandbox: Record<string, unknown> = { TextEncoder, URL, setTimeout, clearTimeout, AbortController };
  for (const name of ["process", "Buffer", "require", "fetch", "WebSocket", "XMLHttpRequest"]) {
    assert.equal(runInNewContext(`typeof ${name}`, sandbox), "undefined", name);
  }
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  const scenario = `async (api) => {
    const { fetchIdentity, MemoryMachineState, observeSource, peerTransport, runTransportConformance, ScriptedPeer, bindSourceFeed, parseConnectorDoc, buildKindRegistry } = api;
    const conformance = await runTransportConformance({ name: "memory", create: (peer, credential) => peerTransport(peer, { credential }) });
    const registry = buildKindRegistry([{ id: "conventions/item", body: "", frontmatter: { type: "Convention", title: "Item", governs: "Item", fields: { required: ["title"] } } }], [], { okfVersion: "0.2" });
    const parsed = parseConnectorDoc({ id: "connectors/items", body: "", frontmatter: { type: "Connector", title: "Items", auth: { kind: "none" }, domains: ["items.example.org"],
      record_sources: [{ name: "items", profile: "pages", target_kind: "Item", identity: { resource: "https://items.example.org/{list}", id: "{id}" }, fields: { title: "name" }, completeness: "complete" }] } }, { kinds: registry });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const bound = bindSourceFeed(parsed.connector, { id: "source-feeds/items", frontmatter: { type: "Source Feed", connector: "connectors/items", source: "items", url: "https://items.example.org/all", owned_fields: ["title"] } }, registry);
    const profile = { id: "pages", version: 1, kind: "generic", validateSpec: (spec) => ({ ok: true, spec }), hostsFor: () => ["items.example.org"],
      async observe({ cursor, transport }) {
        const url = new URL("https://items.example.org/api/items");
        if (cursor) url.searchParams.set("after", cursor.after);
        const body = JSON.parse((await transport.request({ url: url.href, headers: { accept: "application/json" } })).body);
        return { records: body.items, nextCursor: body.next ? { after: body.next } : null, more: Boolean(body.next), complete: !body.next };
      } };
    const listings = [
      { "/api/items": { items: [{ id: "a", name: "Ünïcödé 🐝" }, { id: "b", name: "Bee" }], next: "c&1" }, "/api/items?after=c%261": { items: [{ id: "c", name: "Sea" }] } },
      { "/api/items": { items: [{ id: "a", name: "Ünïcödé 🐝" }, { id: "c", name: "Sea" }] } },
      { "/api/items": { items: [{ id: "a", name: "Ünïcödé 🐝" }, { id: "c", name: "Sea" }] } },
    ];
    const state = new MemoryMachineState();
    const identity = fetchIdentity("SandboxProbe/1 (+https://superbee.example.org/sandbox)");
    const receipts = [];
    for (const [index, routes] of listings.entries()) {
      const peer = new ScriptedPeer((request) => {
        const u = new URL(request.url);
        if (u.pathname === "/robots.txt") return { status: 404, body: "" };
        const routed = routes[u.pathname + u.search];
        return routed ? { status: 200, body: JSON.stringify(routed) } : { status: 404, body: "" };
      });
      const changes = [];
      const receipt = await observeSource({ connector: parsed.connector, bound, profile, spec: {}, transport: peerTransport(peer), state, identity, mode: "complete",
        now: () => new Date(Date.UTC(2026, 0, 1 + index)), commit: async (page) => { changes.push(...page.changes); } });
      receipts.push({ outcome: receipt.outcome, pages: receipt.pages, cursor: receipt.cursor, complete: receipt.pass.complete, requests: receipt.requests,
        changes: changes.map((c) => [c.external_id, c.change_kind, c.content_digest]) });
    }
    return JSON.stringify({ conformance, receipts, state: (await state.read("source-feeds/items")).state });
  }`;
  const inSandbox = JSON.parse(await (runInNewContext(`(${scenario})(SuperbeeSource)`, sandbox) as Promise<string>)) as {
    conformance: Array<{ ok: boolean }>;
    receipts: Array<{ complete: boolean; changes: Array<[string, string, string]> }>;
    state: { records: Record<string, { gone?: boolean }> };
  };
  const engineApi = await import("../src/source-engine/index.js");
  const harnessApi = await import("../src/source-harness/index.js");
  const connectorsApi = await import("../src/connectors.js");
  const { buildKindRegistry } = await import("../src/kinds.js");
  const inNode = JSON.parse(await (new Function("api", `return (${scenario})(api)`)({ ...engineApi, ...harnessApi, ...connectorsApi, buildKindRegistry }) as Promise<string>)) as typeof inSandbox;
  assert.deepEqual(inSandbox, inNode, "the sandbox runs equal Node's: conformance rows, receipts, digests and stored state");
  assert.ok(inSandbox.conformance.every((row) => row.ok), JSON.stringify(inSandbox.conformance));
  assert.deepEqual(inSandbox.receipts.map((r) => r.complete), [true, true, true]);
  assert.deepEqual(inSandbox.receipts.map((r) => r.changes.map(([id, kind]) => `${id}:${kind}`)), [["a:new", "b:new", "c:new"], [], ["b:disappeared"]]);
  assert.equal(inSandbox.state.records.b!.gone, true);
});

test("core/bundle-health computes a report and the Kind findings over MemoryBackend in a sandbox with only TextEncoder and TextDecoder, matching Node's", async () => {
  const result = await build({
    stdin: {
      contents: [
        'export { bundleHealth, bundleKindFindings } from "./bundle-health/index.js";',
        'export { MemoryBackend } from "./memory-backend.js";',
      ].join("\n"),
      resolveDir: path.resolve(here, "../dist"),
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeHealth",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  assert.equal(runInNewContext("typeof require", sandbox), "undefined");
  runInNewContext("globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));", sandbox);
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  // No Node entry ran in the sandbox, so a bare { root } has no filesystem default to fall back on.
  const refusal = (await runInNewContext(
    "SuperbeeHealth.bundleHealth({ root: '/nowhere' }).then(() => null, (error) => ({ name: error.name }))",
    sandbox,
  )) as { name: string } | null;
  assert.equal(refusal?.name, "InvalidInputError");

  // The same scenario runs in Node from source; the reports must agree.
  const scenario = `async (api) => {
    const { bundleHealth, bundleKindFindings, MemoryBackend } = api;
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", "---\\nokf_version: '0.2'\\n---\\n# Sandbox health\\n");
    const docs = [
      { id: "conventions/widget", body: "", frontmatter: { type: "Convention", title: "Widget", governs: "Widget", fields: { required: ["title", "owner"] }, freshness_horizon: "1h" } },
      { id: "widgets/stale", body: "[unowned](unowned.md)\\n[ghost](ghost.md)\\n", frontmatter: { type: "Widget", title: "Ünïcödé 🐝", owner: "ada", generated: { at: "2026-10-17T09:00:00Z" } } },
      { id: "widgets/unowned", body: "", frontmatter: { type: "Widget", title: "Unowned", generated: { at: "2026-10-17T11:30:00Z" }, stale_after: "2026-12-01" } },
      { id: "views-registry/ghost", body: "", frontmatter: { type: "View", title: "Ghost", entry: "views/ghost.html", access: "none" } },
      { id: "menus/whale", body: "[pours](okf://beers/beers/whale.md)\\n", frontmatter: { type: "Menu Item", title: "Whale" } },
    ];
    for (const doc of docs) await backend.write(doc.id, doc);
    const report = await bundleHealth({ root: "browser-health", backend }, { now: new Date("2026-10-17T12:00:00.000Z") });
    const findings = bundleKindFindings(docs, "0.2", { actor: "person:ada", producer: "process:sandbox" });
    return JSON.stringify({ report, findings: findings.documents.map((finding) => finding.id) });
  }`;
  const inSandbox = JSON.parse(await (runInNewContext(`(${scenario})(SuperbeeHealth)`, sandbox) as Promise<string>)) as {
    report: Record<string, unknown> & { stale: unknown[]; kindLint: unknown[]; unresolvedLinks: unknown[]; views: { danglingEntries: unknown[] }; crossBundle: { unchecked: number } | null };
    findings: string[];
  };
  const healthApi = await import("../src/bundle-health/index.js");
  const { MemoryBackend } = await import("../src/memory-backend.js");
  const inNode = JSON.parse(await (new Function("api", `return (${scenario})(api)`)({ ...healthApi, MemoryBackend }) as Promise<string>)) as typeof inSandbox;
  assert.deepEqual(inSandbox, inNode, "the sandbox report equals Node's");
  assert.deepEqual(inSandbox.report.stale, [{ id: "widgets/stale", age_ms: 10_800_000, horizon_ms: 3_600_000 }]);
  assert.deepEqual(inSandbox.report.kindLint, [{ id: "widgets/unowned", field: "owner", code: "KIND_FIELD_MISSING" }]);
  assert.deepEqual(inSandbox.report.unresolvedLinks, [{ from: "widgets/stale", href: "ghost.md" }]);
  assert.equal(inSandbox.report.views.danglingEntries.length, 1);
  assert.equal(inSandbox.report.crossBundle?.unchecked, 0);
  assert.deepEqual(inSandbox.findings, ["widgets/unowned"]);
});

test("core/search answers the parity golden in a sandbox with only TextEncoder and TextDecoder, matching Node's", async () => {
  const result = await build({
    entryPoints: [path.resolve(here, "../dist/search/index.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeSearch",
    write: false,
    logLevel: "silent",
    metafile: true,
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  const inputs = Object.keys(result.metafile!.inputs).map((input) => input.split(path.sep).join("/"));
  assert.deepEqual(
    inputs.filter((input) => !/(?:^|\/)dist\/(?:search\/[a-z-]+|sha256)\.js$/.test(input)),
    [],
    "the bundle holds only the search subpath and core's SHA-256",
  );
  const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  assert.equal(runInNewContext("typeof require", sandbox), "undefined");
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  const { readFile } = await import("node:fs/promises");
  const fixture = await readFile(path.resolve(here, "fixtures/search-parity.json"), "utf8");
  const scenario = `async (api, fixture) => {
    const parity = JSON.parse(fixture);
    const source = api.memorySearchSource(parity.documents, { key: "parity" });
    const answers = [];
    for (const { request } of parity.cases)
      answers.push(await api.searchDocuments(source, { ...request, limit: 50, facets: ["type", "tags"] }, { scope: "sandbox" }));
    const paged = await api.searchDocuments(source, { query: "alpha", limit: 2, prefix: "notes/" }, { scope: "sandbox" });
    const rows = parity.documents.map((document) => {
      const row = api.searchRowText(document);
      return { ...row, instances: [...row.instances] };
    });
    return JSON.stringify({ indexDigest: source.indexDigest, answers, paged, rows, textVersion: api.textVersion() });
  }`;
  sandbox.fixture = fixture;
  const inSandbox = (await runInNewContext(`(${scenario})(SuperbeeSearch, fixture)`, sandbox)) as string;
  const searchApi = await import("../src/search/index.js");
  const inNode = (await (new Function("api", "fixture", `return (${scenario})(api, fixture)`)(searchApi, fixture) as Promise<string>));
  assert.equal(inSandbox, inNode, "the sandbox answers equal Node's, byte for byte");
  assert.equal(JSON.parse(inSandbox).indexDigest, JSON.parse(fixture).indexDigest);
});

test("artifact contract imports and decodes without storage, network or DOM globals", async () => {
  const result = await build({
    entryPoints: [path.resolve(here, "../dist/artifact-contract.js")],
    bundle: true, platform: "browser", format: "iife", globalName: "Artifacts",
    write: false, logLevel: "silent", metafile: true,
  });
  assert.ok(Object.keys(result.metafile!.inputs).every(input => !input.includes("node_modules")));
  const sandbox = {};
  runInNewContext(`for (const key of ["fetch", "localStorage", "sessionStorage", "indexedDB", "document", "window"]) {
    Object.defineProperty(globalThis, key, { get() { throw new Error("unexpected effect: " + key); } });
  }`, sandbox);
  runInNewContext(result.outputFiles[0]!.text, sandbox);
  assert.equal(runInNewContext(`JSON.stringify(Artifacts.decodeDocumentTargetV1({
    schemaVersion: "superbee.document-target.v1", authority: { mode: "local", authorityKey: "local" },
    bundleKey: "selected", documentId: "x.md"
  }))`, sandbox), JSON.stringify({ ok: true, value: {
    schemaVersion: "superbee.document-target.v1", authority: { mode: "local", authorityKey: "local" },
    bundleKey: "selected", documentId: "x.md",
  } }));
});
