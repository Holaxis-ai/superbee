/** Offline example acceptance. Orchestration below is a test double, never a production runner. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bindSourceFeed, changeBetween, findingsFor, mapRecord, parseConnectorDoc, renderIdentity, type MappingDiagnostic, type Connector } from "../src/connectors.js";
import { parseMarkdown } from "../src/frontmatter.js";
import { mutateDocument } from "../src/document-mutation.js";
import { loadKinds } from "../src/kinds-load.js";
import { installRecipe } from "../src/recipe-lifecycle/index.js";
import { parseRecipeFiles } from "../src/recipes.js";
import { applyRecordOverlay, buildSourceIndex, planFindings, planRecordOverlay, readOverlayPolicy, type OverlayBundle, type RecordChange } from "../src/record-overlay/index.js";
import { runSourceScenario } from "../src/source-harness/index.js";
import type { Frontmatter, Version } from "../src/types.js";
import { RecordingBackend } from "./record-overlay-helpers.js";
import githubFixtureProfile, { normalizeGithubIssue, uncoveredGithubFields } from "../../../examples/integrations/work-items-github/profile.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("../../../examples/integrations/work-items-github/issues.json", import.meta.url), "utf8"));
const ISSUES = fixture.issues as Array<Record<string, any>>;
const FEED = "source-feeds/widgets-issues";
const RESOURCE = "https://github.com/example-org/widgets";
const NOW = "2026-10-19T12:00:00Z";
const ACTOR = "process:work-item-fixture";
const BODY = "# Notes\n\nThese are human notes, not a source description.\n";

async function recipe(name: string) {
  const dir = path.join(root, "examples/recipes", name);
  const files: Array<{ path: string; bytes: string }> = [];
  async function walk(at: string): Promise<void> {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push({ path: path.relative(dir, full), bytes: await readFile(full, "utf8") });
    }
  }
  await walk(dir);
  const result = parseRecipeFiles(files, `example:${name}`, { okfVersion: "0.2" });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  return result.recipe;
}

async function world() {
  const backend = new RecordingBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Work Item fixture\n");
  const bundle = { root: "memory://work-item-fixture", backend };
  await installRecipe(bundle, await recipe("source-feeds"), { now: NOW });
  await installRecipe(bundle, await recipe("work-items"), { now: NOW });
  const registry = await loadKinds(bundle);
  assert.deepEqual(registry.warnings, []);
  const overlay: OverlayBundle = { bundle, registry, okfVersion: "0.2" };
  const parsed = parseConnectorDoc((await backend.read("connectors/github")).doc, { kinds: registry });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const connector = parsed.connector;
  const owned = Object.keys(connector.sources[0]!.fields);
  const put = async (id: string, frontmatter: Record<string, unknown>, body = ""): Promise<Version> => (await mutateDocument({
    bundle, id, mode: "create-only", registry, strict: true, actor: "human:fixture-editor",
    buildCandidate: () => ({ frontmatter: structuredClone(frontmatter) as Frontmatter, body }),
  })).version;
  await put(FEED, { type: "Source Feed", title: "Synthetic widget issues", feed_kind: "connector", connector: connector.id, source: "issues", url: RESOURCE, owned_fields: owned, target_kind: "Work Item", missing_threshold: 2 });
  const bound = bindSourceFeed(connector, (await backend.read(FEED)).doc, registry, { okfVersion: "0.2" });
  const accepted = new Map<string, Record<string, unknown>>();
  const observed = new Map<string, Record<string, unknown>>();
  const edit = async (id: string, set: Record<string, unknown>) => mutateDocument({
    bundle, id, mode: "patch", registry, strict: true, actor: "human:fixture-editor",
    buildCandidate: (doc) => ({ frontmatter: { ...doc!.frontmatter, ...set } as Frontmatter, body: doc!.body }),
  });
  const adopt = (issue: Record<string, any>, extra: Record<string, unknown> = {}) => put(`work-items/widgets-${issue.number}`, {
    type: "Work Item", title: issue.title, sources: [{ resource: RESOURCE, id: issue.node_id }], ...extra,
  }, BODY);
  return { backend, overlay, connector, bound, accepted, observed, put, edit, adopt };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * Fixture orchestration only. The tuple includes the document, so first adoption and re-binding
 * use an empty accepted baseline. changeBetween owns mapping/change semantics; overlay owns writes.
 * Store commits include converged and partial-conflict outcomes, but no refused or uncertain step.
 */
async function observe(w: World, issues: Array<Record<string, any>>, beforeApply?: () => Promise<unknown>) {
  const index = await buildSourceIndex(w.overlay.bundle, { type: "Work Item" });
  const changes: RecordChange[] = [];
  const diagnostics: MappingDiagnostic[] = [];
  const commits: Array<{ id: string; tuple: string | null; after: Record<string, unknown> }> = [];
  const numbers = new Map<string, number>();
  let skipped = 0;
  for (const issue of issues) {
    const normalized = normalizeGithubIssue(issue, w.bound.parameters);
    if (normalized === null) { skipped += 1; continue; }
    const mapped = mapRecord(w.bound.source, normalized, w.bound.kind);
    diagnostics.push(...mapped.diagnostics);
    if (mapped.kind === "refused") continue;
    numbers.set(mapped.external_id, issue.number);
    const matches = index.lookup(RESOURCE, mapped.external_id, { type: "Work Item" });
    const tuple = matches.length === 1 ? JSON.stringify([FEED, mapped.external_id, matches[0]!.id]) : null;
    const previous = tuple !== null ? w.accepted.get(tuple) ?? {} : w.observed.get(mapped.external_id) ?? null;
    const change = changeBetween(previous, mapped, { external_id: mapped.external_id, change_kind: previous === null ? "new" : "changed" });
    // Include a converged adoption so G1-1 is exercised through a real record-only/skipped step.
    if (change.changed_fields.length || previous === null || (tuple !== null && !w.accepted.has(tuple)) || matches.length > 1) changes.push(change);
    commits.push({ id: mapped.external_id, tuple, after: change.after! });
  }
  const plan = await planRecordOverlay({
    content: w.overlay, ops: w.overlay, policy: w.bound.policy, changes, observedAt: NOW, sameBundle: true, overlays: index,
    hooks: { sourceProperties: (change) => ({ number: numbers.get(change.external_id)! }) },
  });
  if (beforeApply) await beforeApply();
  const receipt = await applyRecordOverlay(plan, { content: w.overlay, ops: w.overlay, policy: w.bound.policy, actor: ACTOR });
  for (const commit of commits) {
    const refusedStep = receipt.results.some((r) => r.external_id === commit.id && r.outcome === "refused");
    const wholeRefusal = receipt.refusals.some((r) => r.external_id === commit.id && r.code !== "OVERLAY_DOC_CONFLICT");
    if (refusedStep || wholeRefusal) continue;
    w.observed.set(commit.id, commit.after);
    if (commit.tuple !== null) w.accepted.set(commit.tuple, commit.after);
  }
  const findingRows = findingsFor(diagnostics, { source: "issues" });
  const steps = await planFindings({ ops: w.overlay, provider: RESOURCE, feed: FEED, slug: "widgets-mapping", findings: findingRows, observedAt: NOW });
  const findings = await applyRecordOverlay({ feed: FEED, provider: RESOURCE, observed_at: NOW, steps, refusals: [] }, {
    content: w.overlay, ops: w.overlay, policy: w.bound.policy, actor: ACTOR,
  });
  return { changes, diagnostics, plan, receipt, findingRows, findings, skipped };
}
const issue = (n = 0, patch: Record<string, unknown> = {}) => ({ ...structuredClone(ISSUES[n]!), ...patch });
const read = (w: World, n = 42) => w.backend.read(`work-items/widgets-${n}`);
const closed = (patch: Record<string, unknown> = {}) => issue(0, { state: "closed", state_reason: "not_planned", closed_at: "2026-10-03T12:00:00Z", updated_at: "2026-10-03T12:00:00Z", ...patch });
const appliedFor = (result: Awaited<ReturnType<typeof observe>>, id: string) => result.receipt.results.filter((r) => r.external_id === id && r.op === "apply-owned-fields" && r.outcome === "applied");

test("example installs complete recipe definitions and binds the scalar GitHub mapping without changing built-in Task", async () => {
  const w = await world();
  for (const id of ["conventions/work-item", "connectors/github"]) {
    const stamp = (await w.backend.read(id)).doc.frontmatter.x_recipe as Record<string, unknown>;
    assert.equal(stamp.id, "work-items"); assert.equal(stamp.version, "1"); assert.equal(stamp.connectors, 1);
  }
  assert.equal(w.overlay.registry.kinds.has("Task"), false);
  assert.equal(w.bound.kind.claim, undefined);
  assert.equal(w.bound.kind.fields.types.labels, "string-list");
  assert.equal(w.bound.source.fields.labels, undefined);
  assert.equal(w.bound.source.fields.assignees, undefined);
  assert.deepEqual(w.bound.parameters, { owner: "example-org", repo: "widgets" });
  assert.equal(w.bound.resource, RESOURCE);
  assert.deepEqual(w.bound.policy, { ...readOverlayPolicy((await w.backend.read(FEED)).doc, { targetKind: w.bound.kind }), target_kind: "Work Item", completeness: "complete" });
  assert.deepEqual(renderIdentity(w.bound.source, w.bound, normalizeGithubIssue(issue(), w.bound.parameters)), { ok: true, resource: RESOURCE, id: issue().node_id });
  const feed = (await w.backend.read(FEED)).doc;
  for (const patch of [{ url: `${RESOURCE}/extra` }, { owned_fields: ["tags"] }, { target_kind: "Task" }]) {
    assert.throws(() => bindSourceFeed(w.connector, { ...feed, frontmatter: { ...feed.frontmatter, ...patch } }, w.overlay.registry), { code: "POLICY_INVALID" });
  }
});

test("six synthetic issues raise low Signals, skip the pull request, and never create Work Items", async () => {
  const w = await world();
  const result = await observe(w, ISSUES);
  assert.equal(result.skipped, 1);
  assert.equal(result.changes.length, 6);
  const signals = await w.backend.list("signals/");
  assert.equal(signals.length, 6);
  for (const id of signals) assert.equal((await w.backend.read(id)).doc.frontmatter.priority, "low");
  assert.deepEqual(await w.backend.list("work-items/"), []);
});

test("adoption fills scalar facts in one write, preserves body/tags/human lists, then closes and reopens", async () => {
  const w = await world();
  await observe(w, ISSUES);
  await w.adopt(issue(), { tags: ["human"], labels: ["local-label"], assignees: ["human:editor"] });
  await w.adopt(issue(1));
  w.backend.writes = [];
  const result = await observe(w, ISSUES);
  assert.equal(appliedFor(result, issue().node_id).length, 1);
  assert.equal(w.backend.writes.filter((id) => id === "work-items/widgets-42").length, 1);
  let doc = (await read(w)).doc;
  assert.equal(doc.frontmatter.state_category, "todo");
  assert.equal(doc.frontmatter.key, "example-org/widgets#42");
  assert.equal(doc.frontmatter.scope, "example-org/widgets");
  assert.deepEqual(doc.frontmatter.tags, ["human"]);
  assert.deepEqual(doc.frontmatter.labels, ["local-label"]);
  assert.deepEqual(doc.frontmatter.assignees, ["human:editor"]);
  assert.equal(doc.body, BODY);
  assert.equal((doc.frontmatter.sources as any[])[0].number, 42);
  const close = await observe(w, [closed()]);
  assert.equal(appliedFor(close, issue().node_id).length, 1);
  doc = (await read(w)).doc;
  assert.equal(doc.frontmatter.state_category, "canceled");
  assert.equal(doc.frontmatter.close_reason, "not_planned");
  const reopen = await observe(w, [issue(0, { state_reason: "reopened", updated_at: "2026-10-04T12:00:00Z" })]);
  assert.equal(appliedFor(reopen, issue().node_id).length, 1);
  doc = (await read(w)).doc;
  assert.equal(doc.frontmatter.state_category, "todo");
  assert.equal(doc.frontmatter.source_state, "open");
  assert.equal(Object.hasOwn(doc.frontmatter, "close_reason"), false);
  assert.equal(Object.hasOwn(doc.frontmatter, "closed_at"), false);
  assert.equal(doc.body, BODY);
});

test("G1-1 converged replay commits accepted state and the next real edit applies without conflict", async () => {
  const w = await world(); await w.adopt(issue()); await observe(w, [issue()]);
  w.accepted.clear(); w.observed.clear();
  const before = (await read(w)).version;
  const replay = await observe(w, [issue()]);
  assert.ok(replay.receipt.results.some((r) => r.op === "record-only" && r.outcome === "skipped"));
  assert.equal((await read(w)).version, before);
  assert.equal(w.accepted.size, 1);
  const next = await observe(w, [closed()]);
  assert.deepEqual(next.receipt.refusals, []);
  assert.equal(appliedFor(next, issue().node_id).length, 1);
  assert.equal((await read(w)).doc.frontmatter.state_category, "canceled");
});

test("editor title conflicts do not prevent accepted-state advancement beside successful scalar updates", async () => {
  const w = await world(); await w.adopt(issue(), { title: "Editor title" });
  const first = await observe(w, [issue()]);
  assert.ok(first.receipt.refusals.some((r) => r.code === "OVERLAY_DOC_CONFLICT" && r.field === "title"));
  assert.equal((await read(w)).doc.frontmatter.title, "Editor title");
  assert.equal((await read(w)).doc.frontmatter.state_category, "todo");
  assert.equal(w.accepted.size, 1);
  const next = await observe(w, [closed()]);
  assert.equal((await read(w)).doc.frontmatter.state_category, "canceled");
  assert.equal((await read(w)).doc.frontmatter.title, "Editor title");
  assert.equal(next.receipt.refusals.some((r) => r.field === "state_category"), false);
  assert.ok((await w.backend.list("signals/")).length > 0);
});

test("unknown values remain unwritten and dedupe per field across records without leaking source text", async () => {
  const w = await world(); await w.adopt(issue()); await w.adopt(issue(1));
  await observe(w, [issue(), issue(1)]);
  const result = await observe(w, [0, 1].map((n) => issue(n, { state: "closed", state_reason: "wontfix", title: `PRIVATE-SOURCE-TITLE-${n}`, updated_at: "2026-10-04T12:00:00Z" })));
  assert.equal(result.findingRows.length, 2, "one per mapped field, not one per record");
  assert.equal(result.findings.results.filter((r) => r.op === "create-signal").length, 2);
  assert.ok(result.diagnostics.every((d) => d.code === "VALUE_UNMAPPED"));
  assert.equal(JSON.stringify(result.diagnostics).includes("PRIVATE-SOURCE-TITLE"), false);
  assert.equal(JSON.stringify(result.findingRows).includes("PRIVATE-SOURCE-TITLE"), false);
  assert.equal(result.receipt.results.some((r) => r.code === "KIND_REJECTED"), false);
  const doc = (await read(w)).doc;
  assert.equal(doc.frontmatter.state_category, "todo");
  assert.equal(Object.hasOwn(doc.frontmatter, "close_reason"), false);
  assert.equal(doc.frontmatter.source_state, "closed");
  assert.equal(doc.body, BODY);
});

test("duplicate identities and post-plan stale versions commit no accepted state", async () => {
  const duplicate = await world(); await duplicate.adopt(issue(), { sources: [{ resource: RESOURCE, id: issue().node_id }, { resource: RESOURCE, id: issue().node_id }] });
  const ambiguous = await observe(duplicate, [issue()]);
  assert.ok(ambiguous.receipt.refusals.some((r) => r.code === "OVERLAY_IDENTITY_AMBIGUOUS"));
  assert.equal(duplicate.accepted.size, 0);
  assert.equal((await read(duplicate)).doc.frontmatter.state_category, undefined);
  const stale = await world(); await stale.adopt(issue());
  const refused = await observe(stale, [issue()], () => stale.edit("work-items/widgets-42", { priority: "high" }));
  assert.ok(refused.receipt.results.some((r) => r.code === "STALE_VERSION"));
  assert.equal(stale.accepted.size, 0);
  const retry = await observe(stale, [issue()]);
  assert.equal(appliedFor(retry, issue().node_id).length, 1);
  assert.equal((await read(stale)).doc.frontmatter.priority, "high");
});

test("a whole-step field-type refusal keeps adoption pending; a corrected observation fills it", async () => {
  const w = await world(); await w.adopt(issue());
  const refused = await observe(w, [issue(0, { html_url: "not-an-https-url" })]);
  assert.ok(refused.receipt.results.some((r) => r.outcome === "refused"));
  assert.equal(w.accepted.size, 0);
  assert.equal((await read(w)).doc.frontmatter.state_category, undefined);
  const recovered = await observe(w, [issue()]);
  assert.equal(appliedFor(recovered, issue().node_id).length, 1);
  assert.equal(w.accepted.size, 1);
});

test("later manual title edits survive, while a legacy close with no reason maps to done", async () => {
  const w = await world(); await w.adopt(issue()); await observe(w, [issue()]);
  await w.edit("work-items/widgets-42", { title: "Human diagnosis", estimate: 3 });
  const result = await observe(w, [closed({ title: "Source revised title", state_reason: null })]);
  assert.ok(result.receipt.refusals.some((r) => r.code === "OVERLAY_DOC_CONFLICT" && r.field === "title"));
  assert.deepEqual(result.diagnostics, []);
  const doc = (await read(w)).doc;
  assert.equal(doc.frontmatter.title, "Human diagnosis");
  assert.equal(doc.frontmatter.estimate, 3);
  assert.equal(doc.frontmatter.state_category, "done");
  assert.equal(Object.hasOwn(doc.frontmatter, "close_reason"), false);
});

test("coverage accounts for fixture fields, rejects an unexplained field, and keeps normalization bounded", () => {
  for (const raw of ISSUES) assert.deepEqual(uncoveredGithubFields(raw), []);
  assert.deepEqual(uncoveredGithubFields({ ...issue(), unexpected_field: "not silently lost" }), ["unexpected_field"]);
  const normalized = normalizeGithubIssue(issue(), { owner: "example-org", repo: "widgets" });
  assert.equal(normalized.body, undefined);
  assert.equal(normalized.labels, undefined);
  assert.equal(normalized.assignees, undefined);
  assert.throws(() => normalizeGithubIssue(issue(), { owner: "other-org", repo: "widgets" }), /outside the bound repository/);
});

test("the explicit profile double also runs in the one public offline source harness", async () => {
  const w = await world();
  const documents = [];
  for (const id of await w.backend.list()) documents.push((await w.backend.read(id)).doc);
  const result = await runSourceScenario({ connector: w.connector, profile: githubFixtureProfile, spec: {}, feed: FEED, documents }, {
    name: "github.synthetic-first-observation", runs: [{ mode: "complete", exchanges: [{
      request: { url: "https://api.github.com/repos/example-org/widgets/issues?state=all&sort=updated&direction=asc&per_page=100" },
      response: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(ISSUES) },
    }] }],
  });
  const run = result.runs[0]!;
  assert.equal(run.receipt.outcome, "observed", JSON.stringify(run.receipt));
  assert.deepEqual(run.unscripted, []); assert.deepEqual(run.unused, []);
  assert.equal(run.receipt.changes.new, 6);
  assert.ok(run.receipt.profile_diagnostics.some((d) => d.code === "PULL_REQUEST_SKIPPED" && d.count === 1));
  assert.equal(Object.values(run.documents).filter((fm) => fm.type === "Work Item").length, 0);
});
