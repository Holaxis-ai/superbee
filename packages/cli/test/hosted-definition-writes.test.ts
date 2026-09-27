// Model changes from a hosted checkout (designs/hosted-model-evolution.md sections 5 and 8;
// superbee-dev tasks/build-definition-writes-s2): the CLI side of the host's definition writes,
// against the fake host held to the model-change golden exchanges (`hosted-fake-contract.test.ts`).
// The host says, in its capabilities answer, whether this person may change the bundle's model:
// absent (no workspace has model changes: everything is as before), `refused` (the neutral
// refusal, conventions held), or `allowed` (the Kind commands run and sync sends `conventions/`).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { parseMarkdown } from "@superbee/core";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { kind } from "../src/commands/kind.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath } from "../src/hosted/binding.js";
import { assertAllowedInHostedCheckout, assertKindOnlyRecipe } from "../src/hosted/refusals.js";
import { heldPathReason } from "../src/hosted/sync-scan.js";
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
  for (const [command, args] of [["kind", ["field", "Note", "add", "stage"]], ["recipe", ["add", "context-notes"]], ["recipe", ["evolve", "context-notes"]]] as const) {
    const error = await assertAllowedInHostedCheckout(command, [...args, "--dir", h.folder], { home: h.home, cwd: h.cwd }).then(
      () => assert.fail(`${command} ${args[0]} was not refused`),
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
  await mkdir(path.join(h.folder, "Conventions"), { recursive: true }).catch(() => {});
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
  });
  await assertKindOnlyRecipe("recipe add", h.folder, recipe({}), { home: h.home, cwd: h.cwd });
  const error = await assertKindOnlyRecipe("recipe add", h.folder, recipe({ pages: [{ registry: { id: "views-registry/board" }, entry: "views/board.html" }], references: [{ doc: { id: "references/guide" } }] }), { home: h.home, cwd: h.cwd }).then(
    () => assert.fail("the recipe was not refused"),
    (caught: unknown) => caught as CliError,
  );
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.artifacts, "views-registry/board, views/board.html, references/guide");
  assert.match(error.message, /installs 3 artifact\(s\) outside conventions\//);
  // Outside a checkout it is not a hosted refusal at all.
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "sb-defs-plain-")));
  await assertKindOnlyRecipe("recipe add", plain, recipe({ references: [{ doc: { id: "references/guide" } }] }), { home: h.home, cwd: h.cwd });
  await rm(h.home, { recursive: true, force: true });
});
