import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InvalidInputError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { mutateDocument } from "../src/document-mutation.js";
import { builtinNames, builtinRecipeFiles, loadBuiltinRecipe } from "../src/builtin-recipes.js";
import { installRecipe } from "../src/recipe-lifecycle/index.js";
import { loadKinds } from "../src/kinds-load.js";
import { KindAuthoringError, prepareKindDraft, prepareKindDraftMutation, applyKindDraft, prepareKindDismissal, dismissKind, kindInstanceCandidate, kindDeclaresAnything, draftPlanToken, conventionSlugForType } from "../src/kind-authoring.js";
import type { OkfDocument, WriteOptions, Bundle } from "../src/types.js";

async function fixture(backend = new MemoryBackend(), edition = "0.2") {
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n# Bundle\n`);
  const bundle = { root: "/unused", backend };
  await backend.write("notes/a", { id: "notes/a", frontmatter: { type: "Research", title: "A", state: "active" }, body: "# Summary\nA" });
  return { bundle, backend };
}
const refusal = (reason: string) => (error: unknown) => error instanceof KindAuthoringError && error.reason === reason;

test("builtins are opt-in, own-name only and freshly detached", async () => {
  assert.deepEqual(builtinNames(), ["context-notes", "work-tracking", "roadmap", "site"]);
  for (const name of ["unknown", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(loadBuiltinRecipe(name), null); assert.equal(builtinRecipeFiles(name), undefined);
  }
  const files = builtinRecipeFiles("work-tracking")!;
  files[0]!.bytes = "poison";
  const loaded = loadBuiltinRecipe("work-tracking"); assert.ok(loaded?.ok);
  loaded.recipe.docs[0]!.frontmatter.governs = "Poison";
  loaded.recipe.governs.length = 0;
  const fresh = loadBuiltinRecipe("work-tracking"); assert.ok(fresh?.ok);
  assert.deepEqual(fresh.recipe.governs, ["Task"]);
  assert.equal(fresh.recipe.docs[0]!.frontmatter.governs, "Task");
  const { bundle } = await fixture();
  assert.equal((await loadKinds(bundle)).kinds.size, 0, "generic bundle has no ambient recipes");
});

test("backend-independent built-in install, Kind draft/apply and typed strict instance create", async () => {
  for (const edition of ["0.1", "0.2"]) {
    const { bundle, backend } = await fixture(undefined, edition);
    const builtin = loadBuiltinRecipe("work-tracking"); assert.ok(builtin?.ok);
    await installRecipe(bundle, builtin.recipe);
    const plan = await prepareKindDraft(bundle, "Research", { inferredBody: () => "Accepted shape.\n" });
    assert.equal(plan.warnings, 0);
    assert.deepEqual(plan.candidateKind.sections, ["Summary"]);
    const applied = await applyKindDraft(bundle, "Research", plan.token, { inferredBody: () => "Accepted shape.\n", actor: "process:author" });
    assert.equal(applied.warningsAfterApply, 0);
    const registry = await loadKinds(bundle), kind = registry.kinds.get("Research")!;
    const instance = kindInstanceCandidate(kind, { title: "B", state: "active" });
    await mutateDocument({ bundle, id: "notes/b", mode: "create-only", registry, strict: true, buildCandidate: () => instance });
    assert.equal((await backend.read("notes/b")).doc.body, "# Summary\n");
    assert.equal((await backend.read(plan.candidateDoc.id)).doc.frontmatter.generated, undefined);
  }
});

test("plan token remains exact sha256 of the inspected bytes and forecast", async () => {
  const { bundle, backend } = await fixture();
  const prose = { inferredBody: () => "First.\n" };
  const plan = await prepareKindDraft(bundle, "Research", prose);
  const input = { target: plan.candidateDoc.id, candidate: plan.candidateDoc, okfVersion: plan.okfVersion, stats: plan.stats, warnings: plan.warnings };
  assert.equal(draftPlanToken(input), `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`);
  await assert.rejects(() => applyKindDraft(bundle, "Research", plan.token, { inferredBody: () => "Changed.\n" }), refusal("plan-changed"));
  await backend.write("notes/b", { id: "notes/b", frontmatter: { type: "Research", title: "B" }, body: "" });
  await assert.rejects(() => applyKindDraft(bundle, "Research", plan.token, prose), refusal("plan-changed"));
  await assert.rejects(() => prepareKindDraft(bundle, "Unknown"), refusal("no-instances"));
});

test("dismiss is declaration-free/idempotent, redraft retains target and reports replaced prose links", async () => {
  const { bundle, backend } = await fixture();
  const first = await dismissKind(bundle, "Research", { body: () => "Declined [why](notes/a.md).\n" });
  assert.equal(first.changed, true);
  assert.equal(kindDeclaresAnything((await loadKinds(bundle)).kinds.get("Research")!), false);
  assert.equal((await dismissKind(bundle, "Research")).changed, false);
  const moved = (await backend.read(first.id)).doc;
  await backend.write("conventions/custom", { ...moved, id: "conventions/custom" });
  await backend.delete(first.id);
  const plan = await prepareKindDraft(bundle, "Research");
  assert.equal(plan.candidateDoc.id, "conventions/custom");
  const applied = await applyKindDraft(bundle, "Research", plan.token);
  assert.deepEqual(applied.droppedLinks.map(link => link.text), ["why"]);
  await assert.rejects(() => dismissKind(bundle, "Research"), refusal("dismiss-governed"));
  await assert.rejects(() => prepareKindDraft(bundle, "Research"), refusal("already-governed"));
});

test("shared mutation spec rechecks bundle edition and fresh redraft declaration on a retry", async () => {
  class RacingBackend extends MemoryBackend {
    race = false;
    override async write(id: string, doc: OkfDocument, options: WriteOptions = {}) {
      if (this.race && id.startsWith("conventions/")) {
        this.race = false;
        await super.write(id, { id, frontmatter: { type: "Convention", governs: "Research", fields: { required: ["title"] } }, body: "Concurrent human schema\n" }, options);
      }
      return super.write(id, doc, options);
    }
  }
  const { bundle, backend } = await fixture(new RacingBackend());
  await dismissKind(bundle, "Research");
  const plan = await prepareKindDraft(bundle, "Research");
  const prepared = prepareKindDraftMutation(bundle, plan, plan.token);
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n");
  await assert.rejects(() => mutateDocument(prepared.options), refusal("edition-changed"));
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  backend.race = true;
  await assert.rejects(() => applyKindDraft(bundle, "Research", plan.token), refusal("redraft-changed"));
  assert.equal((await backend.read(plan.candidateDoc.id)).doc.body, "Concurrent human schema\n");
});

test("catalog drafts preserve shipped schema; dismissal uses the same catalog", async () => {
  const { bundle, backend } = await fixture();
  await backend.write("tasks/old", { id: "tasks/old", frontmatter: { type: "Task", title: "Old" }, body: "" });
  const plan = await prepareKindDraft(bundle, "Task");
  assert.equal(plan.catalog?.recipeId, "work-tracking");
  assert.ok(plan.warnings > 0);
  const dismissed = await prepareKindDismissal(bundle, "Task");
  assert.equal(dismissed.catalog?.recipeId, "work-tracking");
});

test("instance templates preserve own prototype-shaped fields and authoritative type; empty is explicit", () => {
  const fields = JSON.parse('{"__proto__":"own","constructor":"ctor","prototype":"proto","type":"Wrong"}');
  const kind = { id: "conventions/x", governs: "Right", sections: ["Summary"], fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {} } };
  const candidate = kindInstanceCandidate(kind, fields);
  assert.equal(candidate.frontmatter.type, "Right");
  assert.equal(Object.getPrototypeOf(candidate.frontmatter), Object.prototype);
  assert.equal(Object.hasOwn(candidate.frontmatter, "__proto__"), true);
  assert.equal(candidate.frontmatter.__proto__, "own");
  assert.equal(candidate.body, "# Summary\n");
  assert.equal(kindInstanceCandidate(kind, {}, "").body, "");
});

test("generic parser and bundle initialization do not import the optional catalog or authoring operations", async () => {
  const { build } = await import("esbuild");
  const result = await build({ stdin: { contents: 'export { initBundle } from "./bundle.js"; export { parseRecipeFiles } from "./recipes.js";', resolveDir: new URL("../src/", import.meta.url).pathname }, bundle: true, platform: "node", write: false, metafile: true, logLevel: "silent" });
  assert.ok(Object.keys(result.metafile!.inputs).every(file => !/builtin-recipes|kind-authoring/.test(file)), "generic entrypoints must not pull in opt-in content");
});


const typeInputRows: readonly { label: string; value: unknown }[] = [
  { label: "empty", value: "" },
  { label: "whitespace", value: " \t\n " },
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "number", value: 0 },
  { label: "boolean", value: false },
  { label: "object", value: {} },
  { label: "array", value: ["Research"] },
];
const typeAuthoringRoutes = [
  { name: "prepare draft", run: (bundle: Bundle, type: string) => prepareKindDraft(bundle, type) },
  { name: "apply draft", run: (bundle: Bundle, type: string) => applyKindDraft(bundle, type, "sha256:unused") },
  { name: "prepare dismissal", run: (bundle: Bundle, type: string) => prepareKindDismissal(bundle, type) },
  { name: "dismiss", run: (bundle: Bundle, type: string) => dismissKind(bundle, type) },
];
for (const row of typeInputRows) test(`public type input agreement: ${row.label} refuses before storage access`, async () => {
  for (const route of typeAuthoringRoutes) {
    const storageCalls: PropertyKey[] = [];
    const backend = new Proxy(new MemoryBackend(), {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value !== "function" ? value : () => {
          storageCalls.push(key);
          throw new Error("Invalid type reached storage");
        };
      },
    });
    await assert.rejects(() => route.run({ root: "/unused", backend }, row.value as string), InvalidInputError, route.name);
    assert.deepEqual(storageCalls, [], `${route.name} must not read or write for invalid type input`);
  }
});

for (const type of ["Research", "研究 – Résumé / α?"]) test(`canonical public authoring type: ${type}`, async () => {
  const { bundle, backend } = await fixture();
  if (type !== "Research") await backend.write("observations/unicode", { id: "observations/unicode", frontmatter: { type, title: "Observed" }, body: "# Summary\n" });
  const padded = ` \t${type}\n `;
  const body = (normalized: string) => { assert.equal(normalized, type); return `Accepted ${normalized}.\n`; };
  const canonicalPlan = await prepareKindDraft(bundle, type, { inferredBody: body });
  const paddedPlan = await prepareKindDraft(bundle, padded, { inferredBody: body });
  assert.equal(paddedPlan.type, type);
  assert.equal(paddedPlan.candidateDoc.frontmatter.governs, type);
  assert.deepEqual(paddedPlan.candidateDoc, canonicalPlan.candidateDoc);
  assert.equal(paddedPlan.token, canonicalPlan.token);
  const prepared = await prepareKindDismissal(bundle, padded, { body });
  assert.equal(prepared.id, canonicalPlan.candidateDoc.id);
  const first = await dismissKind(bundle, padded, { body });
  assert.equal(first.changed, true);
  assert.equal((await backend.read(first.id)).doc.frontmatter.governs, type);
  assert.equal((await dismissKind(bundle, padded)).changed, false);
  assert.equal((await dismissKind(bundle, type)).changed, false);
  const redraft = await prepareKindDraft(bundle, padded, { inferredBody: body });
  await applyKindDraft(bundle, padded, redraft.token, { inferredBody: body });
  await assert.rejects(() => prepareKindDraft(bundle, padded), refusal("already-governed"));
  await assert.rejects(() => prepareKindDismissal(bundle, padded), refusal("dismiss-governed"));
  await assert.rejects(() => dismissKind(bundle, padded), refusal("dismiss-governed"));
});


test("convention slugs preserve legacy cleanup behavior after punctuation runs collapse", () => {
  const punctuation = "!?_-".repeat(50_000);
  const cases = [
    { input: "Context Note", expected: "context-note" },
    { input: "  Mixed CASE  ", expected: "mixed-case" },
    { input: "--Already---Hyphenated--", expected: "already-hyphenated" },
    { input: "foo.bar/baz", expected: "foo-bar-baz" },
    { input: "A0_9Z", expected: "a0-9z" },
    { input: "研究 – Résumé / α?", expected: "r-sum" },
    { input: "", expected: "kind" },
    { input: " \t\n ", expected: "kind" },
    { input: "-", expected: "kind" },
    { input: "研究", expected: "kind" },
    { input: punctuation, expected: "kind" },
    { input: punctuation + "Context Note" + punctuation, expected: "context-note" },
    { input: "A" + punctuation + "Z", expected: "a-z" },
  ];
  const legacy = (type: string) => type.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "kind";
  for (const { input, expected } of cases) {
    assert.equal(conventionSlugForType(input), expected);
    assert.equal(conventionSlugForType(input), legacy(input));
  }
});
