// Model changes from a hosted checkout (designs/hosted-model-evolution.md sections 5 and 8;
// superbee-dev tasks/build-definition-writes-s2): the CLI side of the host's definition writes,
// against the fake host held to the model-change golden exchanges (`hosted-fake-contract.test.ts`).
// The host says, in its capabilities answer, whether this person may change the bundle's model:
// absent (no workspace has model changes: everything is as before), `refused` (the neutral
// refusal, conventions held), or `allowed` (the Kind commands run and sync sends `conventions/`).
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { deleteDoc, parseMarkdown, writeDoc } from "@superbee/core";

import { CliError, toExit } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { kind } from "../src/commands/kind.js";
import { recipe } from "../src/commands/recipe.js";
import { promote } from "../src/commands/promote.js";
import { defaultSummarizeBundle } from "../src/commands/home.js";
import { builtinNames, resolveBuiltinSync } from "../src/recipe-source-builtin.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath } from "../src/hosted/binding.js";
import { openBundle } from "../src/bundle.js";
import { assertAllowedInHostedCheckout, assertRecipeAllowedInHostedCheckout, hostedRecipeRefusal } from "../src/hosted/refusals.js";
import { servedBundle } from "../src/hosted/served-bundle.js";
import { heldPathReason, unsendable } from "../src/hosted/sync-scan.js";
import { renderErrorEnvelope } from "../src/output.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
}

const NOTE_KIND = { type: "Convention", title: "Note", governs: "Note" };
const PROJECT_KIND = { type: "Convention", title: "Project", governs: "Project", fields: { optional: ["phase"], values: { phase: ["active", "done"] } } };
/** The Project Kind, and the fake's one Project document carrying its field. */
const PROJECTS = { "conventions/project": PROJECT_KIND, "projects/2026/plan": { type: "Project", title: "Plan", phase: "active" } };

/** A checkout of a host that serves `definitionWrites` as given, with the Kinds seeded on the host first. */
async function harness(definitionWrites: "allowed" | "refused" | undefined, kinds: Record<string, Record<string, unknown>> = { "conventions/note": NOTE_KIND }): Promise<Harness> {
  const host = new FakeHost(definitionWrites === undefined ? {} : { definitionWrites });
  for (const [id, frontmatter] of Object.entries(kinds)) host.put(id, frontmatter, `# ${String(frontmatter.title)}\n`);
  const home = await mkdtemp(path.join(tmpdir(), "sb-defs-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-defs-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  host.writes.length = 0;
  return { home, cwd, folder: path.join(cwd, "team"), auth, host };
}

const instant = async () => {};

type Row = { id: string; state: string; reason: string; version: string | null; message: string };

/** One sync; its receipt, and the error when it fails (a refused or held row fails the run). */
async function runSync(h: Harness): Promise<{ receipt: Record<string, unknown>; rows: Row[]; error: CliError | null }> {
  const out: string[] = [];
  let error: CliError | null = null;
  try {
    await sync(["--dir", h.folder], { stdout: (text: string) => void out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant });
  } catch (caught) {
    assert.ok(caught instanceof CliError, String(caught));
    error = caught;
  }
  const receipt = decode(out.at(-1)!.trim()) as Record<string, unknown>;
  return { receipt, rows: (receipt.rows as Row[]) ?? [], error };
}

/** `superbee kind …` in the checkout, as the CLI runs it: the up-front refusal, then the command. */
async function runKind(h: Harness, args: string[]): Promise<void> {
  const argv = [...args, "--dir", h.folder];
  await assertAllowedInHostedCheckout("kind", argv, { home: h.home, cwd: h.cwd });
  await kind(argv, { stdout: () => {} });
}

async function rewrite(h: Harness, id: string, change: (frontmatter: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(h.folder, `${id}.md`);
  const parsed = parseMarkdown(await readFile(file, "utf8"), id);
  const frontmatter = { ...(parsed.frontmatter as Record<string, unknown>) };
  change(frontmatter);
  await writeFile(file, `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${parsed.body}`);
}

const fieldsOf = (h: Harness, id: string) => h.host.docs.get(id)?.frontmatter.fields as { required?: string[]; optional?: string[]; values?: Record<string, string[]> } | undefined;
const sentOrder = (h: Harness) => h.host.writes.filter((call) => call.route !== "outcome").map((call) => `${call.route} ${String(call.body.documentId)}`);

test("allowed: kind field add --required runs in the checkout and the Kind reaches the host once its documents fit", async () => {
  const h = await harness("allowed", PROJECTS);
  assert.equal((await bindingForPath(h.home, h.folder))?.definition_writes, "allowed", "checkout records what the host said");
  await runKind(h, ["field", "Project", "add", "phase", "--required"]);
  const { rows, error } = await runSync(h);
  assert.equal(error, null, JSON.stringify(rows));
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [["conventions/project", "committed"]]);
  assert.deepEqual(fieldsOf(h, "conventions/project")?.required, ["phase"]);
  // The next sync has nothing to send: the Kind round-tripped.
  assert.deepEqual((await runSync(h)).rows, []);
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a narrowing its documents fail is refused with the host's findings, and the file stays", async () => {
  const h = await harness("allowed");
  await runKind(h, ["field", "Note", "add", "stage", "--required"]);
  const { rows, error } = await runSync(h);
  assert.equal(error?.code, "CONFLICT");
  const row = rows.find((candidate) => candidate.id === "conventions/note")!;
  assert.deepEqual([row.state, row.reason], ["refused", "definition_incompatible"]);
  assert.match(row.message, /instance_invalid on Kind 'Note' field 'stage' \(KIND_FIELD_MISSING\): 2 documents, notes\/alpha, notes\/beta/);
  assert.match(row.message, /Fix the documents it names/);
  assert.equal(fieldsOf(h, "conventions/note"), undefined, "the host's Kind is unchanged");
  assert.match(await readFile(path.join(h.folder, "conventions/note.md"), "utf8"), /stage/);
  // Fixing the documents in a later sync lands the Kind without touching its file (the retry pass
  // takes refusals from earlier runs), and it is sent once more only.
  for (const id of ["notes/alpha", "notes/beta"]) await rewrite(h, id, (frontmatter) => void (frontmatter.stage = "open"));
  h.host.writes.length = 0;
  const fixed = await runSync(h);
  assert.equal(fixed.error, null, JSON.stringify(fixed.rows));
  assert.deepEqual(fieldsOf(h, "conventions/note")?.required, ["stage"]);
  assert.equal(sentOrder(h).filter((line) => line.endsWith("conventions/note")).length, 1);
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a narrowing whose documents are fixed in the same sync lands through the one retry pass", async () => {
  const h = await harness("allowed");
  await runKind(h, ["field", "Note", "add", "stage", "--required"]);
  for (const id of ["notes/alpha", "notes/beta"]) await rewrite(h, id, (frontmatter) => void (frontmatter.stage = "open"));
  const { rows, error } = await runSync(h);
  assert.equal(error, null, JSON.stringify(rows));
  assert.deepEqual(rows.map((row) => [row.id, row.state]).sort(), [["conventions/note", "committed"], ["notes/alpha", "committed"], ["notes/beta", "committed"]]);
  // The Kind went first and was refused, the documents landed, and the Kind was sent once more.
  assert.deepEqual(sentOrder(h), ["replace conventions/note", "replace notes/alpha", "replace notes/beta", "replace conventions/note"]);
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a new enumeration value and the documents that use it commit in one sync, the Kind first", async () => {
  const h = await harness("allowed", PROJECTS);
  await rewrite(h, "conventions/project", (frontmatter) => void (frontmatter.fields = { optional: ["phase"], values: { phase: ["active", "done", "paused"] } }));
  await rewrite(h, "projects/2026/plan", (frontmatter) => void (frontmatter.phase = "paused"));
  const { rows, error } = await runSync(h);
  assert.equal(error, null, JSON.stringify(rows));
  // The document's journal order is not the push order: the widening is sent before it.
  assert.deepEqual(sentOrder(h), ["replace conventions/project", "replace projects/2026/plan"]);
  assert.equal(h.host.docs.get("projects/2026/plan")?.frontmatter.phase, "paused");
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a convention delete goes after the deletes of its last documents, and commits", async () => {
  const h = await harness("allowed", PROJECTS);
  await unlink(path.join(h.folder, "conventions/project.md"));
  await unlink(path.join(h.folder, "projects/2026/plan.md"));
  const { rows, error } = await runSync(h);
  assert.equal(error, null, JSON.stringify(rows));
  assert.deepEqual(sentOrder(h), ["delete projects/2026/plan", "delete conventions/project"]);
  assert.equal(h.host.docs.has("conventions/project"), false);
  await rm(h.home, { recursive: true, force: true });
});

test("refused: the Kind commands name the missing permission neutrally, and conventions stay held", async () => {
  const h = await harness("refused");
  assert.equal((await bindingForPath(h.home, h.folder))?.definition_writes, "refused");
  // The recipe commands refuse once they have read the recipe; the result is the same.
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ["kind field", () => assertAllowedInHostedCheckout("kind", ["field", "Note", "add", "stage", "--dir", h.folder], { home: h.home, cwd: h.cwd })],
    ["recipe add", () => runRecipe(h, ["add", "context-notes"])],
    ["recipe evolve", () => runRecipe(h, ["evolve", "context-notes"])],
  ];
  for (const [name, attempt] of attempts) {
    const error = await attempt().then(
      () => assert.fail(`${name} was not refused`),
      (caught: unknown) => caught as CliError,
    );
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.details?.reason, "definitions_refused");
    assert.match(error.message, /you don't have permission to change this bundle's model/);
    assert.equal(error.help, "ask whoever manages access to it");
    assert.doesNotMatch(`${error.message} ${error.help}`, /admin|organization|workspace|app/i);
  }
  await rewrite(h, "conventions/note", (frontmatter) => void (frontmatter.fields = { optional: ["stage"] }));
  const { rows } = await runSync(h);
  const row = rows.find((candidate) => candidate.id === "conventions/note")!;
  assert.deepEqual([row.state, row.reason], ["held", "convention_folder"]);
  assert.match(row.message, /you don't have permission to change this bundle's model; ask whoever manages access to it/);
  assert.equal(h.host.writes.length, 0);
  await rm(h.home, { recursive: true, force: true });
});

test("absent: a host that says nothing keeps today's refusal, word for word, and the capability is not recorded", async () => {
  const h = await harness(undefined);
  assert.equal((await bindingForPath(h.home, h.folder))?.definition_writes, undefined);
  const error = await assertAllowedInHostedCheckout("kind", ["field", "Note", "add", "stage", "--dir", h.folder], { home: h.home, cwd: h.cwd }).then(
    () => assert.fail("kind was not refused"),
    (caught: unknown) => caught as CliError,
  );
  assert.equal(error.message, "'kind field' cannot sync from a hosted checkout (a hosted bundle's Kinds cannot be changed from a checkout): to design Kinds, work in a local or Git bundle and publish it");
  assert.equal(error.details?.reason, "not_syncable");
  await rm(h.home, { recursive: true, force: true });
});

test("sync records the host's answer on the binding as it changes, and removes it when the host stops saying", async () => {
  const h = await harness("allowed");
  const host = h.host as unknown as { options: { definitionWrites?: string } };
  host.options.definitionWrites = "refused";
  await runSync(h);
  assert.equal((await bindingForPath(h.home, h.folder))?.definition_writes, "refused");
  delete host.options.definitionWrites;
  await runSync(h);
  assert.equal((await bindingForPath(h.home, h.folder))?.definition_writes, undefined);
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: views-registry/, a case variant of conventions/ and a Convention elsewhere stay held", async () => {
  const h = await harness("allowed");
  await mkdir(path.join(h.folder, "views-registry"), { recursive: true });
  await writeFile(path.join(h.folder, "views-registry/board.md"), "---\ntype: View\ntitle: Board\n---\n");
  await writeFile(path.join(h.folder, "notes/kind.md"), "---\ntype: Convention\ngoverns: Idea\n---\n");
  const { rows } = await runSync(h);
  const reason = (id: string) => rows.find((row) => row.id === id)?.reason;
  assert.equal(reason("views-registry/board"), "convention_folder");
  assert.equal(reason("notes/kind"), "not_sendable");
  assert.equal(h.host.writes.length, 0);
  // The path rule, as the kernel's fence has it: folded, and the exception spelled exactly.
  assert.equal(heldPathReason("conventions/x.md", { definitionWrites: "allowed" }), null);
  assert.equal(heldPathReason("Conventions/x.md", { definitionWrites: "allowed" }), "convention_folder");
  assert.equal(heldPathReason("conventions/x.md", { definitionWrites: "refused" }), "convention_folder");
  assert.equal(heldPathReason("conventions/x.md"), "convention_folder", "every other caller (the local MCP app) keeps conventions held");
  assert.equal(heldPathReason("Views-Registry/x.md", { definitionWrites: "allowed" }), "convention_folder");
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a recipe that installs anything but Kind conventions is refused before any write, naming it", async () => {
  const h = await harness("allowed");
  const recipe = (extra: Partial<{ pages: { registry: { id: string }; entry: string }[]; references: { doc: { id: string } }[] }>) => ({
    id: "portable",
    docs: [{ id: "conventions/idea" }],
    pages: [],
    references: [],
    ...extra,
  }) as unknown as Parameters<typeof assertRecipeAllowedInHostedCheckout>[2];
  await assertRecipeAllowedInHostedCheckout("recipe add", h.folder, recipe({}), { home: h.home, cwd: h.cwd });
  const error = await assertRecipeAllowedInHostedCheckout("recipe add", h.folder, recipe({ pages: [{ registry: { id: "views-registry/board" }, entry: "views/board.html" }], references: [{ doc: { id: "references/guide" } }] }), { home: h.home, cwd: h.cwd }).then(
    () => assert.fail("the recipe was not refused"),
    (caught: unknown) => caught as CliError,
  );
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.artifacts, "views-registry/board, views/board.html, references/guide");
  assert.match(error.message, /installs 3 artifact\(s\) outside conventions\//);
  // Outside a checkout it is not a hosted refusal at all.
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "sb-defs-plain-")));
  await assertRecipeAllowedInHostedCheckout("recipe add", plain, recipe({ references: [{ doc: { id: "references/guide" } }] }), { home: h.home, cwd: h.cwd });
  await rm(h.home, { recursive: true, force: true });
});

/** Switch what the fake's capabilities answer says (and so what its writes follow). */
const answer = (h: Harness, definitionWrites: "allowed" | "refused" | undefined) => {
  const options = (h.host as unknown as { options: { definitionWrites?: string } }).options;
  if (definitionWrites === undefined) delete options.definitionWrites;
  else options.definitionWrites = definitionWrites;
};

test("allowed recorded: the local MCP app still never writes the model, before the file changes", async () => {
  const h = await harness("allowed");
  const bundle = await servedBundle(await openBundle(h.folder), { home: h.home });
  const before = await readFile(path.join(h.folder, "conventions/note.md"), "utf8");
  const refused = (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.details?.held_reason, "convention_folder");
    assert.match(error.message, /change it with the kind and recipe commands/);
    return true;
  };
  await assert.rejects(writeDoc(bundle, { id: "conventions/note", frontmatter: { ...NOTE_KIND, fields: { optional: ["stage"] } }, body: "# Note\n" }), refused);
  await assert.rejects(deleteDoc(bundle, "conventions/note"), refused);
  // The type half too: a Convention or a View outside the held folders is refused, not left for sync to hold.
  for (const type of ["Convention", "View"]) {
    await assert.rejects(writeDoc(bundle, { id: `notes/${type.toLowerCase()}`, frontmatter: { type, title: "X", governs: "X" }, body: "" }), (error: unknown) => error instanceof CliError && error.details?.held_reason === "not_sendable");
  }
  assert.equal(await readFile(path.join(h.folder, "conventions/note.md"), "utf8"), before);
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a document its Kind refused lands in the same run once a widening of the Kind lands", async () => {
  const h = await harness("allowed", PROJECTS);
  // The document goes out first and its Kind refuses the new value; the widening follows in a later edit.
  await rewrite(h, "projects/2026/plan", (frontmatter) => void (frontmatter.phase = "paused"));
  const first = await runSync(h);
  assert.deepEqual(first.rows.map((row) => [row.id, row.state, row.reason]), [["projects/2026/plan", "refused", "validation_failed"]]);
  await rewrite(h, "conventions/project", (frontmatter) => void (frontmatter.fields = { optional: ["phase"], values: { phase: ["active", "done", "paused"] } }));
  h.host.writes.length = 0;
  const second = await runSync(h);
  assert.equal(second.error, null, JSON.stringify(second.rows));
  assert.deepEqual(sentOrder(h), ["replace conventions/project", "replace projects/2026/plan"]);
  assert.equal(h.host.docs.get("projects/2026/plan")?.frontmatter.phase, "paused");
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a document refused for a Kind no change in the run touches is not resent", async () => {
  const h = await harness("allowed", { ...PROJECTS, "conventions/note": { ...NOTE_KIND, fields: { optional: ["stage"], values: { stage: ["open"] } } } });
  await rewrite(h, "projects/2026/plan", (frontmatter) => void (frontmatter.phase = "paused"));
  await runSync(h);
  // A Note Kind change lands; the Project document's refusal does not depend on it.
  await rewrite(h, "conventions/note", (frontmatter) => void (frontmatter.fields = { optional: ["stage", "owner"], values: { stage: ["open"] } }));
  h.host.writes.length = 0;
  const { rows } = await runSync(h);
  assert.deepEqual(sentOrder(h), ["replace conventions/note"]);
  assert.equal(rows.find((row) => row.id === "projects/2026/plan")?.reason, "validation_failed");
  await rm(h.home, { recursive: true, force: true });
});

test("a convention change journaled while allowed waits, held, once the host says refused, and is never resent", async () => {
  const h = await harness("allowed");
  await runKind(h, ["field", "Note", "add", "stage", "--required"]);
  const refusedOnce = await runSync(h);
  assert.equal(refusedOnce.rows.find((row) => row.id === "conventions/note")?.reason, "definition_incompatible");
  answer(h, "refused");
  await rewrite(h, "notes/alpha", (frontmatter) => void (frontmatter.stage = "open"));
  h.host.writes.length = 0;
  await runSync(h);
  assert.deepEqual(sentOrder(h), ["replace notes/alpha"], "a Note landing does not resend the Kind the host would now refuse");
  // A convention intent journaled while allowed (an interrupted sync's) waits held under refused,
  // with the neutral wording, and is not sent.
  answer(h, "allowed");
  await rewrite(h, "conventions/note", (frontmatter) => void (frontmatter.title = "Notes"));
  h.host.hook = (call) => (String(call.body.documentId) === "conventions/note" ? { kind: "drop" } : undefined);
  await runSync(h);
  h.host.hook = undefined;
  answer(h, "refused");
  h.host.writes.length = 0;
  const waiting = await runSync(h);
  assert.equal(sentOrder(h).filter((line) => line.endsWith("conventions/note")).length, 0);
  const row = waiting.rows.find((candidate) => candidate.id === "conventions/note")!;
  assert.deepEqual([row.state, row.reason], ["held", "convention_folder"]);
  assert.match(row.message, /you don't have permission to change this bundle's model; ask whoever manages access to it/);
  await rm(h.home, { recursive: true, force: true });
});

test("deleted files under held folders are held and no delete is sent", async () => {
  const h = await harness("refused", { "conventions/note": NOTE_KIND, "views-registry/board": { type: "View", title: "Board" } });
  await unlink(path.join(h.folder, "conventions/note.md"));
  await unlink(path.join(h.folder, "views-registry/board.md"));
  const { rows } = await runSync(h);
  const held = Object.fromEntries(rows.map((row) => [row.id, [row.state, row.reason]]));
  assert.deepEqual(held["conventions/note"], ["held", "convention_folder"]);
  assert.deepEqual(held["views-registry/board"], ["held", "convention_folder"]);
  assert.equal(h.host.writes.length, 0);
  // Never held forever: the host's version is placed back, and the next sync is clean.
  for (const file of ["conventions/note.md", "views-registry/board.md"]) await readFile(path.join(h.folder, file), "utf8");
  assert.deepEqual((await runSync(h)).rows, []);
  // views-registry/ is held under every answer.
  answer(h, "allowed");
  await unlink(path.join(h.folder, "views-registry/board.md"));
  h.host.writes.length = 0;
  const allowed = await runSync(h);
  assert.equal(allowed.rows.find((row) => row.id === "views-registry/board")?.reason, "convention_folder");
  assert.equal(h.host.writes.length, 0);
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: a retry that fails again leaves the Kind refused, sent exactly twice, and nothing unrelated resends it", async () => {
  const h = await harness("allowed");
  await runKind(h, ["field", "Note", "add", "stage", "--required"]);
  // Only one of the two documents gets the field: the retry is sent, and refused again.
  await rewrite(h, "notes/alpha", (frontmatter) => void (frontmatter.stage = "open"));
  const { rows } = await runSync(h);
  assert.equal(sentOrder(h).filter((line) => line.endsWith("conventions/note")).length, 2);
  assert.equal(rows.find((row) => row.id === "conventions/note")?.reason, "definition_incompatible");
  // A write of another type lands: the refused Kind does not depend on it and is not resent.
  await rewrite(h, "projects/2026/plan", (frontmatter) => void (frontmatter.title = "Plan, revised"));
  h.host.writes.length = 0;
  await runSync(h);
  assert.deepEqual(sentOrder(h), ["replace projects/2026/plan"]);
  await rm(h.home, { recursive: true, force: true });
});

test("allowed: recipe add refuses a recipe with a View end to end, before anything is written", async () => {
  const h = await harness("allowed");
  const dir = await mkdtemp(path.join(tmpdir(), "sb-defs-recipe-"));
  await mkdir(path.join(dir, "conventions"), { recursive: true });
  await mkdir(path.join(dir, "views-registry"), { recursive: true });
  await mkdir(path.join(dir, "views"), { recursive: true });
  await writeFile(path.join(dir, "recipe.md"), '---\ntype: Recipe\nid: view-recipe\ntitle: View recipe\nversion: "1"\nsummary: A View package.\ncontent_policy: definitions-only\npages:\n  - registry: views-registry/board.md\n    entry: views/board.html\n---\n');
  await writeFile(path.join(dir, "conventions/term.md"), "---\ntype: Convention\ngoverns: Term\n---\n# Term\n");
  await writeFile(path.join(dir, "views-registry/board.md"), "---\ntype: View\ntitle: Board\nentry: views/board.html\naccess: bundle-read\n---\nA board.\n");
  await writeFile(path.join(dir, "views/board.html"), "<!doctype html><title>Board</title>");
  const argv = ["add", dir, "--dir", h.folder];
  await assertAllowedInHostedCheckout("recipe", argv, { home: h.home, cwd: h.cwd });
  const previousHome = process.env.HOME;
  process.env.HOME = h.home;
  try {
    await assert.rejects(recipe(argv, { stdout: () => {} }), (error: unknown) => error instanceof CliError && error.code === "FORBIDDEN" && /views-registry\/board, views\/board\.html/.test(String(error.details?.artifacts)));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  await assert.rejects(readFile(path.join(h.folder, "conventions/term.md"), "utf8"), "nothing was written");
  await rm(dir, { recursive: true, force: true });
  await rm(h.home, { recursive: true, force: true });
});

/** A recipe folder whose one convention is the fake host's Note Kind, at `version`. */
async function noteRecipeFolder(version: string, governs = "Note"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-defs-stamp-recipe-"));
  await mkdir(path.join(dir, "conventions"), { recursive: true });
  await writeFile(path.join(dir, "recipe.md"), `---\ntype: Recipe\nid: notes\ntitle: Notes\nversion: "${version}"\nsummary: The Note Kind.\n---\n`);
  await writeFile(path.join(dir, `conventions/${governs.toLowerCase()}.md`), `---\ntype: Convention\ntitle: ${governs}\ngoverns: ${governs}\n---\n# ${governs}\n`);
  return dir;
}

/** `superbee recipe …` in the checkout as the CLI runs it: the up-front refusal, then the command (whose own check reads HOME). */
async function runRecipe(h: Harness, args: string[]): Promise<Record<string, unknown>> {
  const argv = [...args, "--dir", h.folder];
  await assertAllowedInHostedCheckout("recipe", argv, { home: h.home, cwd: h.cwd });
  const previousHome = process.env.HOME;
  process.env.HOME = h.home;
  let out = "";
  try {
    await recipe([...argv, "--json"], { stdout: (text: string) => void (out += text) });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  return JSON.parse(out) as Record<string, unknown>;
}

test("T11 allowed: recipe evolve --apply in a checkout stamps the Kind, and sync sends the stamp as a definition write", async () => {
  const h = await harness("allowed");
  const source = await noteRecipeFolder("1");
  const plan = await runRecipe(h, ["evolve", source]);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.changed, false);
  assert.equal(plan.writes, 1);
  const applied = await runRecipe(h, ["evolve", source, "--apply", String(plan.plan_token)]);
  assert.equal(applied.recipe, "stamped");
  const local = parseMarkdown(await readFile(path.join(h.folder, "conventions/note.md"), "utf8"));
  assert.equal((local.frontmatter.x_recipe as Record<string, unknown>).id, "notes");
  const { rows, error } = await runSync(h);
  assert.equal(error, null, JSON.stringify(rows));
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [["conventions/note", "committed"]]);
  assert.deepEqual(sentOrder(h), ["replace conventions/note"]);
  const stored = h.host.docs.get("conventions/note")?.frontmatter.x_recipe as Record<string, unknown> | undefined;
  assert.deepEqual(stored, local.frontmatter.x_recipe, "the host stores the stamp as written");
  // The stamp round-tripped: nothing more to send, and a fresh plan has nothing to write.
  assert.deepEqual((await runSync(h)).rows, []);
  assert.equal((await runRecipe(h, ["evolve", source])).writes, 0);
  // The host's write gate sees a stamped convention as sendable.
  const bytes = new TextEncoder().encode(await readFile(path.join(h.folder, "conventions/note.md"), "utf8"));
  assert.equal(unsendable("conventions/note", "conventions/note.md", bytes, null, { bundleId: BUNDLE, okfVersion: "0.2", documentInputBytes: null }, { definitionWrites: "allowed" }), null);
  await rm(source, { recursive: true, force: true });
  await rm(h.home, { recursive: true, force: true });
});

test("T11 refused: recipe evolve is refused before any stamp exists", async () => {
  const h = await harness("refused");
  const source = await noteRecipeFolder("1");
  const before = await readFile(path.join(h.folder, "conventions/note.md"), "utf8");
  await assert.rejects(runRecipe(h, ["evolve", source]), (error: unknown) => error instanceof CliError && error.details?.reason === "definitions_refused");
  assert.equal(await readFile(path.join(h.folder, "conventions/note.md"), "utf8"), before);
  assert.doesNotMatch(before, /x_recipe/);
  await rm(source, { recursive: true, force: true });
  await rm(h.home, { recursive: true, force: true });
});

test("T11: a conventions-only recipe governing a reserved model Kind is refused before any write, naming it", async () => {
  const h = await harness("allowed");
  const recipeOf = (docs: Array<{ id: string; governs: string }>) => ({
    id: "reserved",
    docs: docs.map(({ id, governs }) => ({ id, frontmatter: { type: "Convention", title: governs, governs }, body: "" })),
    pages: [],
    references: [],
  }) as unknown as Parameters<typeof assertRecipeAllowedInHostedCheckout>[2];
  for (const governs of ["View", "Convention", "Connector", "Site"]) {
    const error = await assertRecipeAllowedInHostedCheckout("recipe evolve", h.folder, recipeOf([{ id: "conventions/idea", governs: "Idea" }, { id: `conventions/${governs.toLowerCase()}`, governs }]), { home: h.home, cwd: h.cwd }).then(
      () => assert.fail(`a recipe governing ${governs} was not refused`),
      (caught: unknown) => caught as CliError,
    );
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.details?.conventions, `conventions/${governs.toLowerCase()}`);
    assert.match(error.message, /declares 1 Kind\(s\) governing/);
  }
  // End to end, before anything is written.
  const source = await noteRecipeFolder("1", "View");
  await assert.rejects(runRecipe(h, ["add", source]), (error: unknown) => error instanceof CliError && error.code === "FORBIDDEN" && error.details?.conventions === "conventions/view");
  await assert.rejects(readFile(path.join(h.folder, "conventions/view.md"), "utf8"), "nothing was written");
  // Outside a checkout it is not a hosted refusal at all.
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "sb-defs-plain-")));
  await assertRecipeAllowedInHostedCheckout("recipe add", plain, recipeOf([{ id: "conventions/view", governs: "View" }]), { home: h.home, cwd: h.cwd });
  await rm(source, { recursive: true, force: true });
  await rm(h.home, { recursive: true, force: true });
});

/** A Connector a recipe may carry (designs/recipe-connectors-2026-10-17, section 5.5). */
const CONNECTOR_MD = `---
type: Connector
title: Calendar
auth:
  kind: none
domains:
  - calendar.example.org
record_sources:
  - name: events
    profile: ics
    target_kind: Event
    mode: overlay
    identity:
      resource: "https://calendar.example.org/{feed}.ics"
      id: "{uid}"
    fields:
      title: summary
    completeness: complete
---
A calendar.
`;
const CONNECTORS_INSTEAD = "keep this recipe for local and Git bundles until hosted workspaces can enable Connections";

test("allowed: a recipe carrying a Connector is refused with its own reason, ahead of a View, and no publish advice; no other recipe is", async () => {
  const h = await harness("allowed");
  const context = { home: h.home, cwd: h.cwd };
  const connector = (id: string) => ({ doc: { id, frontmatter: { type: "Connector", title: "Calendar" }, body: "" } });
  const recipeOf = (extra: Record<string, unknown>) => ({
    id: "feeds",
    docs: [{ id: "conventions/event", frontmatter: { type: "Convention", title: "Event", governs: "Event" }, body: "" }],
    pages: [],
    references: [],
    ...extra,
  }) as unknown as Parameters<typeof assertRecipeAllowedInHostedCheckout>[2];
  const refusal = (words: string, recipe: Parameters<typeof assertRecipeAllowedInHostedCheckout>[2]) => assertRecipeAllowedInHostedCheckout(words, h.folder, recipe, context).then(
    () => assert.fail("the recipe was not refused"),
    (caught: unknown) => caught as CliError,
  );
  await assertRecipeAllowedInHostedCheckout("recipe add", h.folder, recipeOf({}), context);
  await assertRecipeAllowedInHostedCheckout("recipe add", h.folder, recipeOf({ connectors: [] }), context);
  const view = { pages: [{ registry: { id: "views-registry/board" }, entry: "views/board.html" }] };
  for (const extra of [{ connectors: [connector("connectors/calendar")] }, { ...view, connectors: [connector("connectors/calendar")] }]) {
    for (const words of ["recipe add", "recipe evolve"]) {
      const error = await refusal(words, recipeOf(extra));
      assert.equal(error.code, "FORBIDDEN");
      assert.deepEqual(
        [error.details?.reason, error.details?.command, error.details?.connectors, error.details?.connectors_total, error.details?.artifacts],
        ["connectors", words, "connectors/calendar", "1", undefined],
      );
      assert.equal(error.help, CONNECTORS_INSTEAD);
      assert.equal(error.message, `'${words}' refused in a hosted checkout: recipe 'feeds' declares 1 Connector(s), which need a Connection, and hosted workspaces cannot enable one yet; ${CONNECTORS_INSTEAD}`);
      assert.doesNotMatch(`${error.message} ${error.help}`, /publish/);
    }
  }
  // A recipe with a View and no Connector keeps its refusal word for word.
  const viewOnly = await refusal("recipe add", recipeOf(view));
  assert.deepEqual([viewOnly.details?.reason, viewOnly.help], ["not_syncable", "to design Kinds, work in a local or Git bundle and publish it"]);
  // Outside a checkout it is not a hosted refusal at all.
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "sb-defs-plain-")));
  await assertRecipeAllowedInHostedCheckout("recipe add", plain, recipeOf({ connectors: [connector("connectors/calendar")] }), context);
  await rm(h.home, { recursive: true, force: true });
});

/** A recipe folder with an Event Kind and a Connector onto it. */
async function connectorRecipeFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-defs-connector-recipe-"));
  await mkdir(path.join(dir, "conventions"), { recursive: true });
  await mkdir(path.join(dir, "connectors"), { recursive: true });
  await writeFile(path.join(dir, "recipe.md"), '---\ntype: Recipe\nid: feeds\ntitle: Feeds\nversion: "1"\nsummary: An Event Kind and a connector.\ncontent_policy: definitions-only\nconnectors:\n  - connectors/calendar.md\n---\n');
  await writeFile(path.join(dir, "conventions/event.md"), "---\ntype: Convention\ntitle: Event\ngoverns: Event\n---\n# Event\n");
  await writeFile(path.join(dir, "connectors/calendar.md"), CONNECTOR_MD);
  return dir;
}

test("allowed: recipe add refuses a connector recipe end to end, before any write, and the checkout holds no connectors/ document", async () => {
  const h = await harness("allowed");
  const dir = await connectorRecipeFolder();
  for (const sub of ["add", "evolve"]) {
    await assert.rejects(runRecipe(h, [sub, dir]), (error: unknown) => error instanceof CliError && error.code === "FORBIDDEN" && error.details?.reason === "connectors" && error.details?.connectors === "connectors/calendar");
  }
  await assert.rejects(readFile(path.join(h.folder, "conventions/event.md"), "utf8"), "nothing was written");
  await assert.rejects(readFile(path.join(h.folder, "connectors/calendar.md"), "utf8"), "no connectors/ document");
  assert.deepEqual((await runSync(h)).rows, []);
  assert.deepEqual(sentOrder(h), []);
  await rm(dir, { recursive: true, force: true });
  await rm(h.home, { recursive: true, force: true });
});

/**
 * The refusal a Kind-only recipe got before connector recipes had their own, byte for byte as the
 * CLI prints it, with the checkout path as `<checkout>`; captured at 6bb0af79. Exit code 2.
 */
const KIND_ONLY_REFUSAL: Record<"unstated" | "refused", Record<"add" | "evolve", string>> = {
  unstated: {
    add: "error:\n  code: FORBIDDEN\n  message: \"'recipe add' cannot sync from a hosted checkout (recipes change a hosted bundle's Kinds, which cannot be changed from a checkout): to design Kinds, work in a local or Git bundle and publish it\"\n  details:\n    reason: not_syncable\n    command: recipe add\n    bundle_id: team.knowledge\n    host: \"https://hosted.example\"\n    checkout: <checkout>\n  help: \"to design Kinds, work in a local or Git bundle and publish it\"\n",
    evolve: "error:\n  code: FORBIDDEN\n  message: \"'recipe evolve' cannot sync from a hosted checkout (recipes change a hosted bundle's Kinds, which cannot be changed from a checkout): to design Kinds, work in a local or Git bundle and publish it\"\n  details:\n    reason: not_syncable\n    command: recipe evolve\n    bundle_id: team.knowledge\n    host: \"https://hosted.example\"\n    checkout: <checkout>\n  help: \"to design Kinds, work in a local or Git bundle and publish it\"\n",
  },
  refused: {
    add: "error:\n  code: FORBIDDEN\n  message: \"'recipe add' refused: you don't have permission to change this bundle's model (bundle team.knowledge on https://hosted.example); ask whoever manages access to it\"\n  details:\n    reason: definitions_refused\n    command: recipe add\n    bundle_id: team.knowledge\n    host: \"https://hosted.example\"\n    checkout: <checkout>\n  help: ask whoever manages access to it\n",
    evolve: "error:\n  code: FORBIDDEN\n  message: \"'recipe evolve' refused: you don't have permission to change this bundle's model (bundle team.knowledge on https://hosted.example); ask whoever manages access to it\"\n  details:\n    reason: definitions_refused\n    command: recipe evolve\n    bundle_id: team.knowledge\n    host: \"https://hosted.example\"\n    checkout: <checkout>\n  help: ask whoever manages access to it\n",
  },
};

/** Every file under `folder` with its bytes. */
async function snapshot(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(folder, full)] = await readFile(full, "utf8");
  }
  return out;
}

for (const rights of [undefined, "refused", "allowed"] as const) {
  const state = rights ?? "unstated";
  test(`${state} rights: a connector recipe is refused as such before the bundle is read, and a Kind-only recipe exactly as before`, async () => {
    const h = await harness(rights);
    const connectorSource = await connectorRecipeFolder();
    const kindSource = await noteRecipeFolder("1");
    const before = await snapshot(h.folder);
    // The checkout's documents are unreadable while the connector recipe runs: a command that read
    // the bundle before refusing would fail on them instead.
    const conventions = path.join(h.folder, "conventions");
    await chmod(conventions, 0o000);
    try {
      for (const sub of ["add", "evolve"]) {
        const error = await runRecipe(h, [sub, connectorSource]).then(() => assert.fail(`recipe ${sub} was not refused`), (caught: unknown) => caught as CliError);
        const exit = toExit(error);
        assert.equal(exit.exitCode, 2);
        assert.deepEqual([error.code, error.details?.reason, error.details?.connectors, error.details?.connectors_total], ["FORBIDDEN", "connectors", "connectors/calendar", "1"]);
        assert.equal(error.message, `'recipe ${sub}' refused in a hosted checkout: recipe 'feeds' declares 1 Connector(s), which need a Connection, and hosted workspaces cannot enable one yet; ${CONNECTORS_INSTEAD}`);
        assert.equal(error.help, CONNECTORS_INSTEAD);
        assert.doesNotMatch(renderErrorEnvelope(exit.envelope), /publish/);
      }
    } finally {
      await chmod(conventions, 0o755);
    }
    assert.deepEqual(await snapshot(h.folder), before, "nothing was written");
    assert.deepEqual(sentOrder(h), []);

    for (const sub of ["evolve", "add"] as const) {
      if (rights === "allowed") {
        const receipt = await runRecipe(h, [sub, kindSource]);
        assert.equal(receipt.id, "notes", `a person the host allows runs recipe ${sub}`);
        continue;
      }
      const error = await runRecipe(h, [sub, kindSource]).then(() => assert.fail(`recipe ${sub} was not refused`), (caught: unknown) => caught as CliError);
      const exit = toExit(error);
      assert.equal(exit.exitCode, 2);
      assert.equal(renderErrorEnvelope(exit.envelope).replaceAll(h.folder, "<checkout>"), KIND_ONLY_REFUSAL[rights ?? "unstated"][sub]);
    }
    await rm(connectorSource, { recursive: true, force: true });
    await rm(kindSource, { recursive: true, force: true });
    await rm(h.home, { recursive: true, force: true });
  });
}


test("Hosted recipe availability agrees with command admission for the complete builtin catalog", async () => {
  for (const permission of ["allowed", "refused", undefined] as const) {
    const h = await harness(permission);
    try {
      for (const name of builtinNames()) {
        const loaded = resolveBuiltinSync(name);
        const refusal = hostedRecipeRefusal("recipe add", loaded, permission ?? null);
        assert.equal(refusal === null, permission === "allowed" && name !== "site", name);
        const attempt = assertRecipeAllowedInHostedCheckout("recipe add", h.folder, loaded, { home: h.home, cwd: h.cwd });
        if (refusal) await assert.rejects(attempt, (error: unknown) => error instanceof CliError && error.code === "FORBIDDEN");
        else await attempt;
      }
      assert.equal(h.host.writes.length, 0);
      const previousHome = process.env.HOME;
      process.env.HOME = h.home;
      try {
        const summary = await defaultSummarizeBundle(h.folder);
        assert.ok(summary && "docs" in summary);
        assert.equal(summary.home, "hosted");
        assert.equal(summary.hostedDefinitionWrites, permission ?? null);
        assert.equal(h.host.requests.length, 0, "offline availability does not contact the host");
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    } finally { await rm(h.home, { recursive: true, force: true }); await rm(h.cwd, { recursive: true, force: true }); }
  }
});

test("Hosted add/evolve of the Site builtin and reference-free reserved model recipes refuse before writes", async () => {
  const h = await harness("allowed");
  const sources: string[] = [];
  const snapshot = async () => {
    const rows: [string,string][] = [];
    for (const relative of await readdir(h.folder, { recursive: true })) {
      const file = path.join(h.folder, relative);
      if ((await stat(file)).isFile()) rows.push([relative, await readFile(file, "utf8")]);
    }
    return rows.sort(([a],[b]) => a.localeCompare(b));
  };
  try {
    const before = await snapshot();
    for (const command of ["add", "evolve"]) {
      await assert.rejects(runRecipe(h, [command, "site"]), (error: unknown) => error instanceof CliError && error.code === "FORBIDDEN");
      assert.deepEqual(await snapshot(), before);
    }
    for (const governs of ["Site", "Connector"]) {
      const source = await noteRecipeFolder("1", governs); sources.push(source);
      // The owning recipe parser refuses a Connector convention even earlier; neither path writes.
      await assert.rejects(runRecipe(h, ["add", source]), (error: unknown) => error instanceof CliError && (
        governs === "Connector" ? error.code === "USAGE" && /declare connectors/.test(error.message)
          : error.code === "FORBIDDEN" && String(error.details?.conventions).includes("conventions/site")
      ));
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal(h.host.writes.length, 0);
  } finally {
    for (const source of sources) await rm(source, { recursive: true, force: true });
    await rm(h.home, { recursive: true, force: true }); await rm(h.cwd, { recursive: true, force: true });
  }
});

test("transport only: full Site promote and sync preserve structured YAML without installing a Kind", async () => {
  // This FakeHost checks whole-document transfer, not Hosted C's real model/grant authorization.
  const h = await harness("allowed", {});
  const id = "sites/investor", file = path.join(h.cwd, "site.md");
  const body = (title: string) => `---\ntype: Site\ntitle: ${title}\npresentation: "@superbee/portal-document@0.1.1"\naudience: restricted\nviews: []\noptions:\n  layout: compact\n---\n# Site\n`;
  try {
    for (const title of ["Investor", "Updated"]) {
      await writeFile(file, body(title));
      const bundle = await openBundle(h.folder);
      const previous = h.host.docs.has(id) ? await bundle.backend!.read(id) : undefined;
      await promote([file, "--doc-key", `${id}.md`, "--dir", h.folder, ...(previous ? ["--expected-version", previous.version] : [])], { stdout: () => {}, cwd: h.cwd, home: h.home });
      const result = await runSync(h);
      assert.equal(result.error, null, JSON.stringify(result.rows));
      const stored = h.host.docs.get(id)!;
      assert.equal(stored.frontmatter.title, title);
      assert.equal(stored.frontmatter.presentation, "@superbee/portal-document@0.1.1");
      assert.equal(stored.frontmatter.audience, "restricted");
      assert.deepEqual(stored.frontmatter.views, []);
      assert.deepEqual(stored.frontmatter.options, { layout: "compact" });
      assert.equal(h.host.docs.has("conventions/site"), false);
    }
  } finally { await rm(h.home, { recursive: true, force: true }); await rm(h.cwd, { recursive: true, force: true }); }
});
