// The host's findings on a hosted sync's writes: what the operations port returns with a write
// (a saved write's links, warnings and guidance; a refusal's diagnostics and input issues), shown
// on that document's row in the words a local write's findings use (`write-findings.ts`), and kept
// as data under --json. A host from before these results answers as it did, and sync prints as
// it did. Host text is data: it is stripped of control and format characters before it is shown.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN, type FakeHostOptions } from "./support/fake-hosted-sync.js";

interface Harness { cwd: string; folder: string; auth: HostedAuthDeps; host: FakeHost }

type Row = { id: string; state: string; reason: string; version: string | null; message: string; warnings?: { code: string; message: string; field?: string }[]; guidance?: unknown[]; diagnostics?: { code: string; field?: string; message?: string; kindId?: string }[]; input_issues?: unknown[] };

const NOTE_KIND = { type: "Convention", title: "Note", governs: "Note", fields: { optional: ["stage"], values: { stage: ["open", "done"] } } };

async function harness(options: FakeHostOptions = {}): Promise<Harness> {
  const host = new FakeHost(options);
  if (options.definitionWrites) host.put("conventions/note", NOTE_KIND, "# Note\n");
  const home = await mkdtemp(path.join(tmpdir(), "sb-findings-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-findings-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  return { cwd, folder: path.join(cwd, "team"), auth, host };
}

const instant = async () => {};

async function runSync(h: Harness, json = false): Promise<{ text: string; rows: Row[]; error: CliError | null }> {
  const out: string[] = [];
  let error: CliError | null = null;
  try {
    await sync(["--dir", h.folder, ...(json ? ["--json"] : [])], { stdout: (text: string) => void out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant });
  } catch (caught) {
    assert.ok(caught instanceof CliError, String(caught));
    error = caught;
  }
  const text = out.at(-1)!;
  const receipt = (json ? JSON.parse(text) : decode(text.trim())) as { rows?: Row[] };
  return { text, rows: receipt.rows ?? [], error };
}

const note = (body: string, extra = "") => `---\ntype: Note\ntitle: New${extra}\n---\n${body}\n`;
const rowOf = (rows: Row[], id: string) => rows.find((row) => row.id === id)!;

test("a committed write shows the host's findings after its row: a broken link, a host warning and guidance, host text stripped", async () => {
  const h = await harness();
  h.host.reportHook = (id) => id === "notes/new"
    ? { warnings: [{ code: "KIND_FIELD_UNDECLARED", severity: "warning", field: "colour‮\u001b[31m" }, { code: "SOME_NEW\u0007CODE", severity: "error" }], guidance: [{ field: "stage", value: "open", description: "Work not started​." }] }
    : undefined;
  await writeFile(path.join(h.folder, "notes", "new.md"), note("See [Alpha](/notes/alpha.md) and [Gone](/notes/gone.md)."));
  const { text, rows, error } = await runSync(h);
  assert.equal(error, null);
  const row = rowOf(rows, "notes/new");
  assert.equal(row.state, "committed");
  assert.deepEqual(row.warnings?.map((w) => w.code), ["KIND_FIELD_UNDECLARED", "SOME_NEWCODE", "LINK_TARGET_ABSENT"]);
  assert.equal(row.warnings?.[0]?.message, "'colour[31m' is not declared by this document's Kind.");
  assert.equal(row.warnings?.[1]?.message, "the host reported SOME_NEWCODE.");
  // The same words `doc write` uses for a link whose target has no document; the existing target says nothing.
  assert.match(row.warnings?.[2]?.message ?? "", /^target 'notes\/gone' has no document yet \(kept as a forward declaration\); create it with `.* doc write notes\/gone --type <t>`\.$/);
  assert.deepEqual(row.guidance, [{ field: "stage", value: "open", description: "Work not started." }]);
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f​‮]/u);
  assert.match(text, /has no document yet/);
});

test("--json carries the host's findings as data on the row", async () => {
  const h = await harness();
  await writeFile(path.join(h.folder, "notes", "new.md"), note("[Gone](/notes/gone.md)"));
  const { rows } = await runSync(h, true);
  const row = rowOf(rows, "notes/new");
  assert.equal(row.state, "committed");
  assert.deepEqual(row.warnings?.map((w) => [w.code, w.field]), [["LINK_TARGET_ABSENT", "body"]]);
});

test("a refused write shows the host's diagnostics with the document id, in its message and as data", async () => {
  const h = await harness({ definitionWrites: "allowed" });
  await writeFile(path.join(h.folder, "notes", "alpha.md"), note("alpha", "\nstage: later"));
  const { rows, error } = await runSync(h, true);
  assert.equal(error?.code, "CONFLICT");
  const row = rowOf(rows, "notes/alpha");
  assert.equal(row.state, "refused");
  assert.equal(row.reason, "validation_failed");
  assert.match(row.message, /Findings: KIND_FIELD_VALUE on field 'stage' \(This field's value is not one of the allowed values\.\)\./);
  assert.deepEqual(row.diagnostics, [{ code: "KIND_FIELD_VALUE", severity: "error", message: "This field's value is not one of the allowed values.", kindId: "conventions/note", field: "stage" }]);
});

test("an older host's answers (no write results) print as before", async () => {
  const h = await harness({ writeResults: "earlier", definitionWrites: "allowed" });
  await writeFile(path.join(h.folder, "notes", "new.md"), note("[Gone](/notes/gone.md)"));
  await writeFile(path.join(h.folder, "notes", "alpha.md"), note("alpha", "\nstage: later"));
  const { rows } = await runSync(h, true);
  assert.deepEqual(rowOf(rows, "notes/new"), { id: "notes/new", state: "committed", reason: "committed", version: rowOf(rows, "notes/new").version, message: "Sent and accepted." });
  const refused = rowOf(rows, "notes/alpha");
  assert.equal(refused.state, "refused");
  assert.equal(refused.message, "The host refused this document (validation_failed): The candidate or bundle conventions failed validation; no change was saved. Edit the file and run sync again.");
  assert.equal(refused.diagnostics, undefined);
});
