/**
 * `@superbee/core/bundle-health` on MemoryBackend: every report section from core alone, the
 * presence rules carried as null, the binding hook's single call after every read, the resolver
 * verdicts for bound copies, the JSON-safe diagnostic values, and the read-only contract.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bundleHealth, type BundleHealthReport } from "../src/bundle-health/index.js";
import type { BundleBinding, PinCheck } from "../src/cross-bundle.js";
import { InvalidInputError } from "../src/errors.js";
import { MalformedDocumentError } from "../src/frontmatter-contract.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { Bundle, OkfDocument, StorageBackend } from "../src/types.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const WRITE_METHODS = new Set(["write", "delete", "writeReserved", "writeBlob", "deleteBlob"]);

type Doc = Omit<OkfDocument, "id">;

/** A MemoryBackend wrapped to record every call in order, refusing named ids as malformed. */
async function store(
  okfVersion: string | null,
  docs: Record<string, Doc>,
  options: { blobs?: string[]; malformed?: string[]; rootIndex?: string } = {},
): Promise<{ backend: StorageBackend; calls: string[] }> {
  const memory = new MemoryBackend();
  const rootIndex = options.rootIndex ?? (okfVersion === null ? "# Bundle\n" : `---\nokf_version: '${okfVersion}'\n---\n# Bundle\n`);
  await memory.writeReserved("", "index.md", rootIndex);
  for (const [id, doc] of Object.entries(docs)) await memory.write(id, { id, ...doc });
  for (const key of options.blobs ?? []) await memory.writeBlob(key, new TextEncoder().encode("<!doctype html>"), "text/html");
  const malformed = new Set(options.malformed ?? []);
  for (const id of malformed) await memory.write(id, { id, frontmatter: {}, body: "" });
  const calls: string[] = [];
  const refuse = (id: string): never => {
    throw new MalformedDocumentError(id, new Error("unexpected end of the stream"));
  };
  const backend = new Proxy(memory, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        if (property === "read" && malformed.has(args[0] as string)) return Promise.reject(refuse(args[0] as string));
        if (property === "readMany" && (args[0] as string[]).some((id) => malformed.has(id))) {
          return Promise.reject(refuse((args[0] as string[]).find((id) => malformed.has(id))!));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as StorageBackend;
  return { backend, calls };
}

async function copy(bundleId: string | null, docs: Record<string, Doc> = {}): Promise<StorageBackend> {
  const all: Record<string, Doc> = { ...docs };
  if (bundleId !== null) all["docs/bundle"] = { frontmatter: { type: "Bundle Name", title: bundleId, bundle_id: bundleId }, body: "" };
  return (await store("0.1", all)).backend;
}

const convention = (governs: string, extra: Record<string, unknown> = {}): Doc => ({
  frontmatter: { type: "Convention", title: governs, governs, ...extra },
  body: "",
});

test("bundle health: every section fires on an in-memory v0.2 bundle", async () => {
  const { backend } = await store("0.2", {
    "conventions/widget": convention("Widget", {
      fields: { required: ["title", "priority"], values: { priority: ["low", "high"] } },
      sections: ["Notes"],
      freshness_horizon: "1h",
    }),
    "conventions/widget-again": convention("Widget"),
    "conventions/box": convention("Box", { links: { contains: "Crate" } }),
    "conventions/crate": convention("Crate", {
      fields: { optional: ["superbee_progress_status"], values: { superbee_progress_status: ["queued", "done"] }, terminal: { superbee_progress_status: ["done"] } },
      expects_inbound: { contains: "Box" },
    }),
    "conventions/shelf": convention("Shelf", { fields: { optional: ["status"], values: { status: ["draft", "stable"] } }, expects_inbound: { holds: "Box" } }),
    "conventions/menu-item": convention("Menu Item", { links: { pours: "beers:Beer" } }),
    "conventions/page": convention("Page"),
    "widgets/missing-title": { frontmatter: { type: "Widget", priority: "low", generated: { at: "2026-10-17T11:30:00Z" } }, body: "# Notes\n" },
    "widgets/no-section": { frontmatter: { type: "Widget", title: "N", priority: "high", generated: { at: "2026-10-17T11:30:00Z" } }, body: "" },
    "widgets/stale": { frontmatter: { type: "Widget", title: "S", priority: "low", generated: { at: "2026-10-17T09:00:00Z" } }, body: "# Notes\n[t](missing-title.md)\n" },
    "widgets/no-ts": { frontmatter: { type: "Widget", title: "T", priority: "low" }, body: "# Notes\n" },
    "notes/expired": { frontmatter: { type: "Note", stale_after: "2026-01-01T00:00:00Z" }, body: "[t](target.md)" },
    "notes/date-only": { frontmatter: { type: "Note", stale_after: "2026-12-01" }, body: "[t](target.md)" },
    "notes/bad-legacy": { frontmatter: { type: "Note", timestamp: "2026-09-08" }, body: "[t](target.md)" },
    "notes/linker": { frontmatter: { type: "Note" }, body: "[ghost](../ghosts/nope.md)" },
    "notes/target": { frontmatter: { type: "Note" }, body: "" },
    "notes/orphan": { frontmatter: { type: "Note" }, body: "" },
    "notes/self": { frontmatter: { type: "Note" }, body: "[me](self.md)" },
    "notes/human": { frontmatter: { type: "Note", verified: { by: "human:ada", at: "2026-10-01T00:00:00Z" } }, body: "[t](target.md)" },
    "items/box": { frontmatter: { type: "Box", title: "B" }, body: "[contains](../notes/target.md)" },
    "items/queued": { frontmatter: { type: "Crate", superbee_progress_status: "queued" }, body: "" },
    "items/done": { frontmatter: { type: "Crate", superbee_progress_status: "done" }, body: "" },
    "items/shelf": { frontmatter: { type: "Shelf", status: "draft" }, body: "" },
    "menus/local": { frontmatter: { type: "Menu Item", title: "L" }, body: "[pours](../notes/target.md)" },
    "views-registry/ghost": { frontmatter: { type: "View", title: "G", entry: "views/ghost.html", access: "none" }, body: "" },
    "views-registry/live": { frontmatter: { type: "View", title: "L", entry: "views/live.html", access: "none", bridge: "none" }, body: "" },
    "notes/view-shaped": { frontmatter: { type: "View", title: "V", entry: "views/live.html", access: "none" }, body: "" },
    "pages-registry/retired": { frontmatter: { type: "Page", title: "R", entry: "pages/retired.html" }, body: "" },
  }, { blobs: ["views/live.html", "pages/retired.html"], malformed: ["notes/broken"] });

  const report = await bundleHealth({ root: "memory://every", backend }, { now: NOW });
  assert.equal(report.okfVersion, "0.2");
  assert.deepEqual(report.malformed, [{ id: "notes/broken", reason: "unexpected end of the stream" }]);
  assert.deepEqual(report.kindLint.map((row) => [row.id, row.code]), [
    ["widgets/missing-title", "KIND_FIELD_MISSING"],
    ["widgets/no-section", "KIND_SECTION_MISSING"],
  ]);
  assert.deepEqual(report.conformanceDebt, [{ id: "widgets/missing-title", type: "Widget" }]);
  assert.deepEqual(report.registryWarnings.map((w) => w.code), ["KIND_DUPLICATE_GOVERNS"]);
  assert.deepEqual(report.unresolvedLinks, [{ from: "notes/linker", href: "../ghosts/nope.md" }]);
  assert.ok(report.orphans.some((row) => row.id === "notes/self"), "a self-link rescues nothing");
  assert.ok(report.orphans.some((row) => row.id === "notes/orphan"));
  assert.deepEqual(report.linkTypeViolations, [{ from: "items/box", to: "notes/target", text: "contains", expected: "Box -> Crate" }]);
  assert.deepEqual(report.crossLinkTypeViolations, [
    { from: "menus/local", href: "../notes/target.md", text: "pours", expected: "Menu Item -> beers:Beer" },
  ]);
  assert.equal(report.crossBundle, null, "no dependencies and no okf: link");
  assert.deepEqual(report.missingExpectedLinks, [
    { id: "items/queued", missing: ["contains"] },
    { id: "items/shelf", status: "draft", missing: ["holds"] },
  ]);
  assert.equal(report.terminalSkipped, 1);
  assert.deepEqual(report.stale, [
    { id: "notes/expired", stale_after: "2026-01-01T00:00:00Z" },
    { id: "widgets/stale", age_ms: 3 * 3_600_000, horizon_ms: 3_600_000 },
  ]);
  assert.deepEqual(report.noTimestamp, [{ id: "widgets/no-ts", type: "Widget" }]);
  assert.deepEqual(report.invalidStaleAfter, [{ id: "notes/date-only", type: "Note", value: "2026-12-01" }]);
  assert.deepEqual(report.invalidTimestamps, [{ id: "notes/date-only", type: "Note", field: "stale_after", value: "2026-12-01" }]);
  assert.deepEqual(report.invalidLegacyTimestamps, [{ id: "notes/bad-legacy", type: "Note", field: "timestamp", value: "2026-09-08" }]);
  assert.equal(report.trust?.["human-reviewed"], 1);
  assert.deepEqual(report.views, {
    typed: 3,
    danglingEntries: [{ id: "views-registry/ghost", entry: "views/ghost.html" }],
    invalidRegistrations: [{ id: "notes/view-shaped", problem: "id" }],
  });
  assert.equal(report.okfUpgrade, null, "a v0.2 bundle has no upgrade finding");
  assert.deepEqual(report.legacyNaming, {
    pageTyped: [{ id: "pages-registry/retired" }],
    bridgeField: [{ id: "views-registry/live" }],
    pageConvention: [{ id: "conventions/page" }],
    legacyPrefix: [{ id: "pages-registry/retired", store: "doc" }, { id: "pages/retired.html", store: "blob" }],
  });
});

test("bundle health: presence rules are null on a conventions-free v0.1 bundle and on an undeclared edition", async () => {
  for (const okfVersion of ["0.1", null]) {
    const { backend } = await store(okfVersion, { "notes/a": { frontmatter: { type: "Note", status: "open" }, body: "" } });
    const report = await bundleHealth({ root: "memory://plain", backend });
    assert.equal(report.okfVersion, okfVersion ?? undefined);
    assert.equal(report.conformanceDebt, null);
    assert.equal(report.trust, null);
    assert.equal(report.okfUpgrade, null);
    assert.equal(report.crossBundle, null);
  }
  const { backend } = await store(null, {
    "conventions/release": convention("Release", { fields: { required: ["status"], values: { status: ["planned"] } } }),
    "releases/r1": { frontmatter: { type: "Release", status: "planned", generated: { at: "2026-09-08" } }, body: "" },
  });
  const undeclared = await bundleHealth({ root: "memory://undeclared", backend });
  assert.equal(undeclared.okfUpgrade, null, "only a declared v0.1 edition carries the upgrade finding");
  assert.deepEqual(undeclared.invalidTimestamps, [], "the v0.2 timestamp families need a declared v0.2 edition");
  assert.deepEqual(undeclared.conformanceDebt, []);
});

test("bundle health: a v0.1 workflow-status collision is the upgrade finding, with every Kind's row", async () => {
  const { backend } = await store("0.1", {
    "conventions/release": convention("Release", { fields: { required: ["status"], values: { status: ["planned", "published"] } } }),
    "conventions/ticket": convention("Ticket", { fields: { optional: ["status"] } }),
    "releases/r1": { frontmatter: { type: "Release", status: "planned" }, body: "" },
    "tickets/t1": { frontmatter: { type: "Ticket", status: "open" }, body: "" },
    "tickets/t2": { frontmatter: { type: "Ticket", status: ["open"] }, body: "" },
  });
  const report = await bundleHealth({ root: "memory://upgrade", backend });
  assert.deepEqual(report.okfUpgrade, {
    affectedDocuments: 3,
    statusFieldRows: [
      { kind: "Release", convention: "conventions/release", declaration: "enumerated", incompatible_values: ["planned", "published"], observed_incompatible_values: ["planned"], affected_documents: 1 },
      { kind: "Ticket", convention: "conventions/ticket", declaration: "unbounded", incompatible_values: [], observed_incompatible_values: ["<array>", "open"], affected_documents: 2 },
    ],
  });
});

test("bundle health: a malformed root index is the first malformed row and leaves the edition undeclared", async () => {
  const { backend } = await store("0.1", {
    "conventions/release": convention("Release", { fields: { required: ["status"], values: { status: ["planned"] } } }),
    "releases/r1": { frontmatter: { type: "Release", status: "planned" }, body: "" },
  }, { rootIndex: "---\nokf_version: [\n---\n", malformed: ["releases/broken"] });
  const report = await bundleHealth({ root: "memory://broken-root", backend });
  assert.equal(report.okfVersion, undefined);
  assert.deepEqual(report.malformed.map((row) => row.id), ["index.md", "releases/broken"]);
  assert.match(report.malformed[0]!.reason, /malformed frontmatter in 'index\.md'/);
  assert.equal(report.okfUpgrade, null);
});

const DEPENDENCIES: Doc = {
  frontmatter: {
    type: "Bundle Dependencies",
    dependencies: {
      beers: { bundle_id: "beer-bundle" },
      wines: { bundle_id: "wine-bundle", pin: "abcdef1" },
      me: { bundle_id: "town-bundle" },
    },
  },
  body: "",
};
const MENU: Doc = {
  frontmatter: { type: "Menu Item" },
  body: "[pours](okf://beers/beers/whale.md)\n[pours](okf://beers/beers/missing.md)\n[pairs](okf://wines/wines/red.md)\n[x](okf://ciders/c.md)\n",
};

test("bundle health: selfBundleId names this bundle only when docs/bundle declares none, and drops a self alias as DEP_SELF", async () => {
  const fallback = await store("0.1", { "docs/dependencies": DEPENDENCIES });
  const viaOption = await bundleHealth({ root: "memory://town", backend: fallback.backend }, { selfBundleId: "town-bundle" });
  assert.deepEqual(viaOption.crossBundle?.problems, [{ code: "DEP_SELF", alias: "me", detail: "bundle_id 'town-bundle' is this bundle" }]);
  assert.deepEqual(viaOption.crossBundle?.dependencies.map((row) => row.alias), ["beers", "wines"]);

  const declared = await store("0.1", {
    "docs/dependencies": DEPENDENCIES,
    "docs/bundle": { frontmatter: { type: "Bundle Name", title: "Town", bundle_id: "wine-bundle" }, body: "" },
  });
  const viaDoc = await bundleHealth({ root: "memory://town", backend: declared.backend }, { selfBundleId: "town-bundle" });
  assert.deepEqual(viaDoc.crossBundle?.problems.map((p) => [p.code, p.alias]), [["DEP_SELF", "wines"]], "docs/bundle wins over the option");
});

test("bundle health: the bindings hook runs once, after every read, with the one parse; its error propagates unchanged", async () => {
  const { backend, calls } = await store("0.1", { "docs/dependencies": DEPENDENCIES, "menus/whale": MENU });
  const seen: { declared: string[]; callsBefore: string[] }[] = [];
  await bundleHealth({ root: "memory://town", backend }, {
    selfBundleId: "town-bundle",
    bindings: async (declared) => {
      seen.push({ declared: [...declared.dependencies.keys()], callsBefore: [...calls] });
      return new Map();
    },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.declared, ["beers", "wines"], "the self alias is dropped before the hook sees the declaration");
  for (const read of ["list", "readMany", "readReserved", "listBlobs"]) {
    assert.ok(seen[0]!.callsBefore.includes(read), `${read} completed before the hook`);
  }
  assert.deepEqual(calls.slice(seen[0]!.callsBefore.length), [], "nothing of this bundle is read after the hook");

  const malformedDeps = await store("0.1", {}, { malformed: ["docs/dependencies"] });
  let parsed: unknown;
  const report = await bundleHealth({ root: "memory://town", backend: malformedDeps.backend }, {
    bindings: async (declared) => {
      parsed = declared;
      return new Map();
    },
  });
  assert.deepEqual(parsed, { dependencies: new Map(), problems: [], rejected: new Map() }, "a malformed declaration is a finding, never a read the hook sees");
  assert.deepEqual(report.malformed.map((row) => row.id), ["docs/dependencies"]);

  const refusal = new Error("binder refused");
  await assert.rejects(
    bundleHealth({ root: "memory://town", backend }, { bindings: async () => { throw refusal; } }),
    (error: unknown) => error === refusal,
  );
});

test("bundle health: bound copies get the resolver's verdicts, unbound aliases count as unchecked, and bound is the label", async () => {
  const { backend } = await store("0.1", { "docs/dependencies": DEPENDENCIES, "menus/whale": MENU });
  const beers = await copy("beer-bundle", { "beers/whale": { frontmatter: { type: "Beer" }, body: "" } });
  const failingPin: PinCheck = async () => ({ ok: false, detail: "subtree differs" });

  const unbound = await bundleHealth({ root: "memory://town", backend }, { selfBundleId: "town-bundle" });
  assert.equal(unbound.crossBundle?.links, 4);
  assert.equal(unbound.crossBundle?.unchecked, 3);
  assert.deepEqual(unbound.crossBundle?.unresolved.map((row) => row.reason), ["unknown_alias"]);
  assert.deepEqual(unbound.crossBundle?.dependencies.map((row) => [row.alias, row.state, row.bound, row.pin]), [
    ["beers", "unbound", null, null],
    ["wines", "unbound", null, "abcdef1"],
  ]);

  const bindings = new Map<string, BundleBinding>([
    ["beers", { backend: beers, label: "copy:beers", identity: "beer-bundle" }],
    ["wines", { backend: await copy("wine-bundle"), label: "copy:wines", identity: "wine-bundle", pin: failingPin }],
  ]);
  const bound = await bundleHealth({ root: "memory://town", backend }, { selfBundleId: "town-bundle", bindings });
  assert.equal(bound.crossBundle?.unchecked, 0);
  assert.deepEqual(bound.crossBundle?.dependencies.map((row) => [row.alias, row.state, row.bound]), [
    ["beers", "ok", "copy:beers"],
    ["wines", "pin_mismatch", "copy:wines"],
  ]);
  assert.deepEqual(bound.crossBundle?.unresolved.map((row) => [row.href, row.reason]), [
    ["okf://beers/beers/missing.md", "target_missing"],
    ["okf://wines/wines/red.md", "pin_mismatch"],
    ["okf://ciders/c.md", "unknown_alias"],
  ]);

  const impostor = new Map<string, BundleBinding>([["beers", { backend: await copy("other-bundle"), label: "copy:impostor", identity: "other-bundle" }]]);
  const wrong = await bundleHealth({ root: "memory://town", backend }, { selfBundleId: "town-bundle", bindings: impostor });
  assert.deepEqual(wrong.crossBundle?.dependencies[0], { alias: "beers", bundle_id: "beer-bundle", state: "bundle_unavailable", bound: "copy:impostor", pin: null });
});

test("bundle health: diagnostic values are JSON-safe, including non-finite numbers and an alias cycle", async () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const { backend } = await store("0.2", {
    "notes/infinite": { frontmatter: { type: "Note", generated: { at: Number.POSITIVE_INFINITY } }, body: "" },
    "notes/cycle": { frontmatter: { type: "Note", stale_after: cycle }, body: "" },
    "notes/legacy": { frontmatter: { type: "Note", timestamp: [Number.NaN] }, body: "" },
  });
  const report = await bundleHealth({ root: "memory://values", backend });
  const fields = [...report.invalidStaleAfter, ...report.invalidTimestamps, ...report.invalidLegacyTimestamps];
  assert.ok(fields.length >= 3);
  assert.doesNotThrow(() => JSON.stringify(fields));
  assert.deepEqual(report.invalidStaleAfter, [{ id: "notes/cycle", type: "Note", value: "<non-JSON object: circular or too deeply nested>" }]);
  assert.ok(report.invalidTimestamps.some((row) => row.id === "notes/infinite" && row.value === "<Infinity>"));
  assert.deepEqual(report.invalidLegacyTimestamps, [{ id: "notes/legacy", type: "Note", field: "timestamp", value: ["<NaN>"] }]);
});

test("bundle health: the report reads only, and a backend-less bundle in a runtime without a default throws InvalidInputError", async () => {
  const { backend, calls } = await store("0.2", { "docs/dependencies": DEPENDENCIES, "menus/whale": MENU });
  const beers = await copy("beer-bundle");
  const report: BundleHealthReport = await bundleHealth({ root: "memory://town", backend }, {
    bindings: new Map([["beers", { backend: beers, label: "beers", identity: "beer-bundle" }]]),
  });
  assert.ok(report.crossBundle);
  assert.deepEqual(calls.filter((call) => WRITE_METHODS.has(call)), []);

  // This file never loads the Node entry, so no filesystem default is installed.
  const bare: Bundle = { root: "/nowhere" };
  await assert.rejects(bundleHealth(bare), (error: unknown) => error instanceof InvalidInputError);
});
