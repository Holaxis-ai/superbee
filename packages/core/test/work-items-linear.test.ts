/** Offline second-tracker acceptance; no GraphQL execution or provider credentials. */
import test from "node:test";
import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {bindSourceFeed, changeBetween, mapRecord, parseConnectorDoc, renderIdentity} from "../src/connectors.js";
import {loadKinds} from "../src/kinds-load.js";
import {installRecipe} from "../src/recipe-lifecycle/index.js";
import {parseRecipeFiles} from "../src/recipes.js";
import {mutateDocument} from "../src/document-mutation.js";
import {parseMarkdown} from "../src/frontmatter.js";
import {getSourceProfile} from "../src/source-profiles/index.js";
import {buildSourceIndex} from "../src/record-overlay/index.js";
import {createSourceOverlayAdapter, type SourceOverlaySnapshot, type SourceState} from "../src/source-engine/index.js";
import {RecordingBackend} from "./record-overlay-helpers.js";
import type {Frontmatter} from "../src/types.js";
import fixtureProfile, {normalizeLinearIssue, linearSourceProperties, uncoveredLinearFields} from "../../../examples/integrations/work-items-linear/profile.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("../../../examples/integrations/work-items-linear/issues.json", import.meta.url), "utf8"));
const ISSUES = fixture.issues as Array<Record<string, any>>;
const TEAM = ISSUES[0]!.team.id as string;
const RESOURCE = `https://linear.app/team/${TEAM}`;
const FEED = "source-feeds/linear";
const NOW = "2026-10-19T12:00:00Z";
const issue = (edit: Record<string, unknown> = {}) => ({...structuredClone(ISSUES[0]!), ...edit});
async function recipe(name: string) {
  const dir = path.join(root, "examples/recipes", name);
  const files: Array<{path: string; bytes: string}> = [];
  async function walk(at: string): Promise<void> {
    for (const entry of await readdir(at, {withFileTypes: true})) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push({path: path.relative(dir, full), bytes: await readFile(full, "utf8")});
    }
  }
  await walk(dir);
  const parsed = parseRecipeFiles(files, `example:${name}`, {okfVersion: "0.2"});
  assert.ok(parsed.ok, JSON.stringify(parsed)); return parsed.recipe;
}
async function world(team = TEAM) {
  const backend = new RecordingBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Linear fixture\n");
  const bundle = {root: "memory://linear-fixture", backend};
  await installRecipe(bundle, await recipe("source-feeds"), {now: NOW});
  await installRecipe(bundle, await recipe("work-items"), {now: NOW});
  const registry = await loadKinds(bundle);
  assert.deepEqual(registry.warnings, []);
  const fixtureDeclaration = parseMarkdown(await readFile(new URL("../../../examples/integrations/work-items-linear/connectors/linear.md", import.meta.url), "utf8"), undefined, {okfVersion: "0.2"});
  const parsed = parseConnectorDoc({id: "connectors/linear", ...fixtureDeclaration}, {kinds: registry});
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const connector = parsed.connector;
  const put = async (id: string, frontmatter: Record<string, unknown>, body = "") => mutateDocument({bundle, id, mode: "create-only", registry, strict: true, actor: "human:fixture", buildCandidate: () => ({frontmatter: frontmatter as Frontmatter, body})});
  await put("connectors/linear", fixtureDeclaration.frontmatter, fixtureDeclaration.body);
  await put(FEED, {type: "Source Feed", title: "Offline Linear", feed_kind: "connector", connector: connector.id, source: "issues", url: `https://linear.app/team/${team}`, target_kind: "Work Item", owned_fields: Object.keys(connector.sources[0]!.fields), missing_threshold: 2});
  const bound = bindSourceFeed(connector, (await backend.read(FEED)).doc, registry, {okfVersion: "0.2"});
  const map = (row: Record<string, any>) => mapRecord(bound.source, normalizeLinearIssue(row, bound.parameters), bound.kind);
  return {bundle, backend, registry, connector, bound, put, map};
}

test("default recipe stays executable while the fixture explicitly adds Linear on its Work Item Kind", async () => {
  const w = await world();
  assert.equal((await w.backend.read("conventions/work-item")).doc.frontmatter.x_recipe?.connectors, 1);
  assert.equal((await w.backend.read("connectors/linear")).doc.frontmatter.x_recipe, undefined);
  assert.equal((await w.backend.read("connectors/github")).doc.frontmatter.type, "Connector");
  assert.equal(w.registry.kinds.get("Work Item")?.governs, "Work Item");
  assert.equal(getSourceProfile("linear-issues-fixture"), undefined);
  assert.deepEqual(w.connector.auth, {kind: "none"}); assert.deepEqual(w.connector.domains, []);
  assert.equal(w.bound.source.request, undefined);
  assert.equal(w.bound.source.completeness, "partial");
});

test("official-shaped fields are covered and source descriptions and relationships do not leak", () => {
  for (const row of ISSUES) assert.deepEqual(uncoveredLinearFields(row), []);
  assert.deepEqual(uncoveredLinearFields({...issue(), unexplained: 1}), ["unexplained"]);
  const row = normalizeLinearIssue(issue(), {team: TEAM});
  assert.deepEqual(row.labels, ["Area/Backend", "bug"]); assert.deepEqual(row.assignees, ["linear:alice"]);
  for (const key of ["description", "project", "delegate", "cycle", "parent", "attachments", "relations"]) assert.equal(Object.hasOwn(row, key), false);
  assert.deepEqual(linearSourceProperties(issue()), {number: 42, team_key: "ENG", estimate_scale: "fibonacci", project: issue().project.id, delegate: issue().delegate.id});
});

test("all native workflow types map through the same Work Item fields, including triage and duplicate", async () => {
  const w = await world();
  const categories = ["todo", "todo", "todo", "in_progress", "done", "canceled", "canceled"];
  for (let i = 0; i < 7; i++) {
    const mapped = w.map(ISSUES[i]!); assert.equal(mapped.kind, "mapped");
    if (mapped.kind !== "mapped") continue;
    assert.equal(mapped.fields.state_category, categories[i]); assert.equal(mapped.fields.source_state, ISSUES[i]!.state.name);
    assert.equal(mapped.fields.priority, "high"); assert.equal(mapped.fields.estimate, 3);
    if (i < 4) {assert.ok(mapped.cleared.includes("close_reason")); assert.ok(mapped.cleared.includes("closed_at"));}
    else assert.equal(mapped.fields.close_reason, ["completed", "not_planned", "duplicate"][i - 4]);
  }
  const canceled = w.map(issue({state: {type: "canceled", name: "Duplicate"}, canceledAt: NOW}));
  assert.equal(canceled.kind === "mapped" && canceled.fields.close_reason, "not_planned");
});

test("archive and trash are explicit presence observations; restored issue clears optional facts", async () => {
  const w = await world();
  for (const [index, presence] of [[7, "archived"], [8, "gone"]] as const) {
    const mapped = w.map(ISSUES[index]!); assert.equal(mapped.kind === "mapped" && mapped.fields.source_presence, presence);
  }
  const restored = w.map(issue({assignee: null, labels: {nodes: []}, estimate: null, dueDate: null}));
  assert.equal(restored.kind, "mapped"); if (restored.kind !== "mapped") return;
  assert.deepEqual(restored.fields.assignees, []); assert.deepEqual(restored.fields.labels, []);
  for (const key of ["closed_at", "close_reason", "estimate", "due_on"]) assert.ok(restored.cleared.includes(key), key);
});

test("team UUID scopes identity independently of mutable keys and team moves never merge resources", async () => {
  const w = await world();
  const row = normalizeLinearIssue(issue(), {team: TEAM});
  assert.deepEqual(renderIdentity(w.bound.source, w.bound, row), {ok: true, resource: RESOURCE, id: issue().id});
  const renamed = normalizeLinearIssue(issue({team: {...issue().team, key: "NEW"}, identifier: "NEW-42"}), {team: TEAM});
  assert.deepEqual(renderIdentity(w.bound.source, w.bound, renamed), {ok: true, resource: RESOURCE, id: issue().id});
  const nextTeam = "66666666-6666-4666-8666-666666666666";
  assert.throws(() => normalizeLinearIssue(issue({team: {...issue().team, id: nextTeam}}), {team: TEAM}), /outside bound/);
  const moved = normalizeLinearIssue(issue({team: {...issue().team, id: nextTeam}}), {team: nextTeam});
  const nextWorld = await world(nextTeam);
  assert.notDeepEqual(renderIdentity(nextWorld.bound.source, nextWorld.bound, moved), {ok: true, resource: RESOURCE, id: issue().id});
});

test("unknown workflow type keeps normalized enum unobserved and list projection rejects malformed data", async () => {
  const w = await world();
  const mapped = w.map(issue({state: {type: "future", name: "New workflow"}}));
  assert.equal(mapped.kind, "mapped"); if (mapped.kind !== "mapped") return;
  for (const key of ["state_category", "close_reason", "closed_at"]) assert.ok(mapped.unobserved.includes(key)); assert.equal(mapped.fields.source_state, "New workflow");
  assert.throws(() => normalizeLinearIssue(issue({assignee: {id: "user"}}), {team: TEAM}), /displayName/);
  assert.throws(() => normalizeLinearIssue(issue({labels: {nodes: [{}]}}), {team: TEAM}), /label.name/);
});

test("fixture profile is explicitly local, partial, and never reaches a transport", async () => {
  const w = await world();
  assert.equal(fixtureProfile.validateSpec({issues: ISSUES}).ok, true);
  assert.equal(fixtureProfile.validateSpec({}).ok, false);
  const page = await fixtureProfile.observe({spec: {issues: ISSUES}, bound: w.bound, transport: {request: () => {throw new Error("network forbidden");}}});
  assert.equal(page.records.length, ISSUES.length); assert.equal(page.complete, false); assert.equal(page.more, false);
  assert.deepEqual(fixtureProfile.hostsFor(), []);
});


type DurableFixture = {observed: SourceState; accepted: SourceOverlaySnapshot};
/** One synthetic observation, co-publishing the existing observation and adapter snapshot shapes. */
async function applyFixture(w: Awaited<ReturnType<typeof world>>, row: Record<string, any>, durable?: DurableFixture, cached = false) {
  const mapped = w.map(row); assert.equal(mapped.kind, "mapped");
  if (mapped.kind !== "mapped") throw new Error("fixture mapping refused");
  const previous = durable?.observed.records[mapped.external_id]?.after ?? null;
  const change = changeBetween(previous, mapped, {external_id: mapped.external_id, change_kind: previous === null ? "new" : "changed"});
  const observed: SourceState = {v: 1, profile: {id: "linear-issues-fixture", version: 1}, cursor: null, open: false, complete_observations: 0,
    records: {[mapped.external_id]: {after: change.after!, digest: change.content_digest, missing: 0, seen_at: NOW}}};
  const adapter = createSourceOverlayAdapter({content: {bundle: w.bundle, registry: w.registry, okfVersion: "0.2"}, policy: w.bound.policy,
    actor: "process:linear-fixture", overlays: await buildSourceIndex(w.bundle), accepted: durable?.accepted,
    hooks: {sourceProperties: () => linearSourceProperties(row)}});
  const result = cached ? await adapter.reconcile(durable!.observed, NOW) : await adapter.commit({feed: FEED, provider: RESOURCE, observed_at: NOW, page: 1, replay: false,
    changes: [change], records: {[mapped.external_id]: {fields: mapped.fields}}, baseline: durable === undefined, complete: false});
  assert.deepEqual(result.retry, []); assert.deepEqual(result.hold, []);
  const next = {observed: cached ? durable!.observed : observed, accepted: adapter.stagedSnapshot()!};
  adapter.consume();
  return {result, durable: next};
}

test("shared adapter fills a late adoption from cached observation and preserves source properties", async () => {
  const w = await world(); const row = issue();
  const first = await applyFixture(w, row);
  assert.equal(first.durable.accepted.entries.length, 0);
  assert.ok((await w.backend.list("signals/")).length > 0);
  assert.equal((await w.backend.list()).filter(id => id.startsWith("work-items/")).length, 0);
  await w.put("work-items/linear-42", {type: "Work Item", title: row.title, sources: [{resource: RESOURCE, id: row.id}], tags: ["human"]}, "# Notes\n\nHuman notes stay here.\n");
  const second = await applyFixture(w, row, first.durable, true);
  const doc = (await w.backend.read("work-items/linear-42")).doc;
  assert.equal(second.durable.accepted.entries.length, 1);
  assert.deepEqual(doc.frontmatter.labels, ["Area/Backend", "bug"]); assert.deepEqual(doc.frontmatter.assignees, ["linear:alice"]);
  assert.equal(doc.frontmatter.priority, "high"); assert.equal(doc.frontmatter.estimate, 3);
  assert.deepEqual(doc.frontmatter.tags, ["human"]); assert.match(doc.body, /Human notes stay here/);
  const source = doc.frontmatter.sources![0]!;
  assert.equal(source.project, row.project.id); assert.equal(source.estimate_scale, "fibonacci"); assert.equal(source.delegate, row.delegate.id);
  const version = (await w.backend.read("work-items/linear-42")).version;
  await applyFixture(w, row, second.durable, true);
  assert.equal((await w.backend.read("work-items/linear-42")).version, version);
});

test("shared adapter keeps human list edits while applying scalar changes and optional clears", async () => {
  const w = await world(); const row = issue({...ISSUES[4], id: issue().id});
  await w.put("work-items/linear-42", {type: "Work Item", title: row.title, sources: [{resource: RESOURCE, id: row.id}]}, "Human notes");
  const humanBody = (await w.backend.read("work-items/linear-42")).doc.body;
  const first = await applyFixture(w, row);
  await mutateDocument({bundle: w.bundle, id: "work-items/linear-42", mode: "patch", registry: w.registry, strict: true, actor: "human:editor", expectedVersion: (await w.backend.read("work-items/linear-42")).version, input: {kind: "field-action", action: {action: "replace-all", field: "labels", value: ["my-label"]}}});
  const reopened = issue({title: "Source title updated", labels: {nodes: [{name: "new-label", parent: null}]}, assignee: null, estimate: null, dueDate: null});
  const second = await applyFixture(w, reopened, first.durable);
  assert.ok(second.result.receipt.refusals.some(row => row.code === "OVERLAY_DOC_CONFLICT"));
  const doc = (await w.backend.read("work-items/linear-42")).doc;
  assert.deepEqual(doc.frontmatter.labels, ["my-label"]); assert.deepEqual(doc.frontmatter.assignees, []);
  assert.equal(doc.frontmatter.title, "Source title updated"); assert.equal(doc.frontmatter.state_category, "todo");
  for (const key of ["closed_at", "close_reason", "due_on", "estimate"]) assert.equal(Object.hasOwn(doc.frontmatter, key), false, key);
  assert.equal(doc.body, humanBody); assert.deepEqual(w.backend.deletes, []);
});
