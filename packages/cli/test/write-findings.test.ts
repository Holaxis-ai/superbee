/**
 * Post-write findings on authoring receipts (`doc write`, `doc update`, `doc field`, `new`): links
 * the stored body has that will not register (`LINK_NOT_RECOGNIZED`), links whose target has no
 * document (`LINK_TARGET_ABSENT`) and a type no Kind declares (`KIND_TYPE_UNDECLARED`), each from
 * core's findings and only when this write introduced it. Nothing is added when there is nothing
 * to say, and a finding never fails the write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, readDoc, writeDoc, FilesystemBackend, CONVENTION_TYPE, type Bundle, type ConceptId, type ReadResult } from "@superbee/core";

import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { LINK_FORM_HELP } from "../src/write-findings.js";
import { detectHostAliasing, hostAliasesPair } from "../../core/test/host-class.js";

const T = "2026-07-01T00:00:00.000Z";
const BAD_BODY = "See [[tasks/t9]], [Plan](plan) and [Spec](/notes/spec.md).\n";

async function withBundle(run: (dir: string, bundle: Bundle) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-write-findings-"));
  const bundle: Bundle = { root: dir };
  await initBundle(dir);
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: { type: CONVENTION_TYPE, title: "Task", governs: "Task", path: "tasks/", fields: { required: ["title"], optional: [] }, timestamp: T },
    body: "A unit of work.",
  });
  await writeDoc(bundle, { id: "notes/plan", frontmatter: { type: "Task", title: "Plan", timestamp: T }, body: "x" });
  try {
    await run(dir, bundle);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function run(cmd: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>, argv: string[], json = true): Promise<string> {
  let out = "";
  await cmd([...argv, ...(json ? ["--json"] : [])], { stdout: (s) => (out += s) });
  return out;
}
const runJson = async (cmd: Parameters<typeof run>[0], argv: string[]) => JSON.parse(await run(cmd, argv)) as Record<string, unknown>;
type Warning = { code: string; message: string; field?: string; severity: string; details?: Record<string, unknown> };
const warningsOf = (receipt: Record<string, unknown>) => (receipt.warnings ?? []) as Warning[];
const codes = (receipt: Record<string, unknown>) => warningsOf(receipt).map((w) => w.code);

test("doc write: links that will not register, an absent target and an undeclared type are named with the fix", async () => {
  await withBundle(async (dir) => {
    const receipt = await runJson(doc, ["write", "notes/one", "--type", "task", "--title", "One", "--body", BAD_BODY, "--dir", dir]);
    assert.equal(receipt.doc, "written");
    assert.deepEqual(codes(receipt), ["LINK_NOT_RECOGNIZED", "LINK_NOT_RECOGNIZED", "LINK_TARGET_ABSENT", "KIND_TYPE_UNDECLARED"]);
    const [wikilink, missingMd, absent, type] = warningsOf(receipt);
    assert.deepEqual(wikilink!.details, { reason: "wikilink", text: "tasks/t9", href: "tasks/t9", suggestedHref: "/tasks/t9.md", suggestedTo: "tasks/t9" });
    assert.match(wikilink!.message, /\[\[tasks\/t9\]\] will not register as a link: .*write \[tasks\/t9\]\(\/tasks\/t9\.md\)\.$/);
    assert.equal(wikilink!.severity, "warning");
    assert.equal(missingMd!.details!.reason, "missing-md-extension");
    assert.equal(missingMd!.details!.suggestedHref, "plan.md", "core points the suggestion at the document that exists");
    assert.deepEqual(absent!.details, { to: "notes/spec", href: "/notes/spec.md", text: "Spec" });
    assert.match(absent!.message, /^target 'notes\/spec' has no document yet/);
    assert.deepEqual(type!.details, { type: "task", suggestedType: "Task" });
    assert.equal(type!.severity, "warning");
    assert.equal(type!.message, "no Kind declares type 'task'; did you mean 'Task'?");
    const help = receipt.help as string[];
    assert.equal(help.length, 3);
    assert.equal(help[1], LINK_FORM_HELP);
    assert.match(help[2]!, / kinds$/);
  });
});

test("doc write: a write with nothing to say has no warnings and only its own help line; a no-op reports nothing", async () => {
  await withBundle(async (dir, bundle) => {
    const receipt = await runJson(doc, ["write", "tasks/one", "--type", "Task", "--title", "One", "--body", "See [Plan](/notes/plan.md).", "--dir", dir]);
    assert.deepEqual(Object.keys(receipt), ["doc", "changed", "id", "type", "timestamp", "version", "help"]);
    assert.equal((receipt.help as string[]).length, 1);
    await run(doc, ["write", "notes/bad", "--type", "Note", "--title", "Bad", "--body", BAD_BODY, "--dir", dir]);
    const before = (await readDoc(bundle, "notes/bad")).body;
    const again = await runJson(doc, ["write", "notes/bad", "--type", "Note", "--title", "Bad", "--body", BAD_BODY, "--dir", dir]);
    assert.equal(again.changed, false);
    assert.equal(again.warnings, undefined);
    // A changed write that keeps the body and type introduces nothing.
    const retitled = await runJson(doc, ["write", "notes/bad", "--type", "Note", "--title", "Renamed", "--body", BAD_BODY, "--dir", dir]);
    assert.equal(retitled.changed, true);
    assert.equal(retitled.warnings, undefined);
    assert.equal((await readDoc(bundle, "notes/bad")).body, before);
  });
});

test("doc update: only what the patch introduced is named; a field-only patch and a no-op name nothing", async () => {
  await withBundle(async (dir) => {
    await run(doc, ["write", "tasks/one", "--type", "Task", "--title", "One", "--body", "See [[old]].", "--dir", dir]);
    const body = await runJson(doc, ["update", "tasks/one", "--body", "See [[old]] and [[tasks/new]].", "--dir", dir]);
    assert.deepEqual(codes(body), ["LINK_NOT_RECOGNIZED"]);
    assert.equal(warningsOf(body)[0]!.details!.href, "tasks/new");
    assert.ok((body.help as string[]).includes(LINK_FORM_HELP));
    const absent = await runJson(doc, ["update", "tasks/one", "--body", "See [[old]] and [Gone](/notes/gone.md).", "--dir", dir]);
    assert.deepEqual(codes(absent), ["LINK_TARGET_ABSENT"]);
    const titled = await runJson(doc, ["update", "tasks/one", "--title", "Renamed", "--dir", dir]);
    assert.equal(titled.warnings, undefined);
    assert.equal((titled.help as string[]).length, 1);
    // A deliberate ad-hoc type is legal and says nothing; a near miss of a declared one is named.
    const adHoc = await runJson(doc, ["update", "tasks/one", "--type", "Chore", "--dir", dir]);
    assert.equal(adHoc.warnings, undefined);
    assert.equal((adHoc.help as string[]).length, 1);
    const retyped = await runJson(doc, ["update", "tasks/one", "--type", "TASK", "--dir", dir]);
    assert.deepEqual(codes(retyped), ["KIND_TYPE_UNDECLARED"]);
    assert.equal(warningsOf(retyped)[0]!.severity, "warning");
    assert.deepEqual(warningsOf(retyped)[0]!.details, { type: "TASK", suggestedType: "Task" });
  });
});

test("doc update: a body from --body-file or from stdin is checked the same way", async () => {
  await withBundle(async (dir) => {
    await run(doc, ["write", "tasks/one", "--type", "Task", "--title", "One", "--body", "See [[old]].", "--dir", dir]);
    const file = path.join(dir, "..", `${path.basename(dir)}-body.md`);
    await writeFile(file, "See [[old]] and [[tasks/from-file]].");
    try {
      const fromFile = await runJson(doc, ["update", "tasks/one", "--body-file", file, "--dir", dir]);
      assert.deepEqual(warningsOf(fromFile).map((w) => w.details!.href), ["tasks/from-file"]);
    } finally {
      await rm(file, { force: true });
    }
    let out = "";
    await doc(["update", "tasks/one", "--dir", dir, "--json"], {
      stdout: (text) => (out += text),
      readStdin: async () => "See [[old]], [[tasks/from-file]] and [[tasks/from-stdin]].",
    });
    const fromStdin = JSON.parse(out) as Record<string, unknown>;
    assert.equal(fromStdin.changed, true);
    assert.deepEqual(warningsOf(fromStdin).map((w) => w.details!.href), ["tasks/from-stdin"]);
  });
});

test("a rewrite that only moves its links reports nothing", async () => {
  await withBundle(async (dir) => {
    await run(doc, ["write", "notes/bad", "--type", "Note", "--title", "Bad", "--body", BAD_BODY, "--dir", dir]);
    const moved = "Intro first.\n\n[Spec](/notes/spec.md) then [Plan](plan), and last [[tasks/t9]].\n";
    const receipt = await runJson(doc, ["write", "notes/bad", "--type", "Note", "--title", "Bad", "--body", moved, "--dir", dir]);
    assert.equal(receipt.changed, true);
    assert.equal(receipt.warnings, undefined);
    assert.equal((receipt.help as string[]).length, 1);
  });
});

test("doc field: a field action keeps the body and type, so it introduces no finding even on a document that has some", async () => {
  await withBundle(async (dir) => {
    const written = await runJson(doc, ["write", "notes/bad", "--type", "Note", "--title", "Bad", "--body", BAD_BODY, "--dir", dir]);
    assert.equal(warningsOf(written).length, 3);
    const field = await runJson(doc, ["field", "add", "notes/bad", "tags", "x", "--dir", dir]);
    assert.equal(field.changed, true);
    assert.equal(field.warnings, undefined);
    assert.equal((field.help as string[]).length, 1);
  });
});

test("doc field set type: a near miss of a declared type is named; an ad-hoc type is not", async () => {
  await withBundle(async (dir) => {
    await run(doc, ["write", "notes/n", "--type", "Note", "--title", "N", "--body", "x", "--dir", dir]);
    const adHoc = await runJson(doc, ["field", "set", "notes/n", "type", "Widget", "--dir", dir]);
    assert.equal(adHoc.changed, true);
    assert.equal(adHoc.warnings, undefined);
    const near = await runJson(doc, ["field", "set", "notes/n", "type", "task", "--dir", dir]);
    assert.equal(near.changed, true);
    assert.deepEqual(codes(near), ["KIND_TYPE_UNDECLARED"]);
    assert.deepEqual(warningsOf(near)[0]!.details, { type: "task", suggestedType: "Task" });
    assert.match((near.help as string[]).at(-1)!, / kinds$/);
  });
});

test("new: the body new writes is checked; a --link row keeps its own target warning, never repeated", async () => {
  await withBundle(async (dir) => {
    const receipt = await runJson(newCommand, ["Task", "t1", "--title", "T1", "--body", BAD_BODY, "--dir", dir]);
    assert.equal(receipt.new, "written");
    assert.deepEqual(codes(receipt), ["LINK_NOT_RECOGNIZED", "LINK_NOT_RECOGNIZED", "LINK_TARGET_ABSENT"], "a Kind instance's type is always declared");
    assert.ok((receipt.help as string[]).includes(LINK_FORM_HELP));
    const clean = await runJson(newCommand, ["Task", "t2", "--title", "T2", "--link", "depends on=tasks/absent", "--dir", dir]);
    assert.equal(clean.warnings, undefined);
    assert.equal(((clean.links as { warnings?: Warning[] }[])[0]!.warnings ?? []).some((w) => w.code === "LINK_TARGET_ABSENT"), true);
  });
});

test("a target that cannot be read is LINK_LINT_UNAVAILABLE for that target alone; the other findings stand and the write lands", async () => {
  await withBundle(async (dir, bundle) => {
    const read = FilesystemBackend.prototype.read;
    FilesystemBackend.prototype.read = async function (this: FilesystemBackend, id: ConceptId): Promise<ReadResult> {
      if (id === "notes/spec") throw new Error("injected target read failure");
      return read.call(this, id);
    };
    try {
      const receipt = await runJson(doc, ["write", "notes/one", "--type", "Task", "--title", "One", "--body", BAD_BODY, "--dir", dir]);
      assert.equal(receipt.doc, "written");
      assert.deepEqual(codes(receipt), ["LINK_NOT_RECOGNIZED", "LINK_NOT_RECOGNIZED", "LINK_LINT_UNAVAILABLE"]);
      const unavailable = warningsOf(receipt)[2]!;
      assert.deepEqual(unavailable.details, { to: "notes/spec" });
      assert.equal(unavailable.message, "the link to 'notes/spec' could not be checked: injected target read failure");
    } finally {
      FilesystemBackend.prototype.read = read;
    }
    assert.equal((await readDoc(bundle, "notes/one")).body, BAD_BODY);
  });
});

test("a target with malformed frontmatter does not hide the wikilink finding beside it", async () => {
  await withBundle(async (dir) => {
    await mkdir(path.join(dir, "notes"), { recursive: true });
    await writeFile(path.join(dir, "notes", "broken.md"), "---\ntype: [unclosed\n---\nBody.\n");
    const receipt = await runJson(doc, ["write", "tasks/one", "--type", "Task", "--title", "One", "--body", "See [Broken](/notes/broken.md) and [[tasks/t9]].", "--dir", dir]);
    assert.deepEqual(codes(receipt), ["LINK_NOT_RECOGNIZED", "LINK_LINT_UNAVAILABLE"]);
    assert.equal(warningsOf(receipt)[0]!.details!.reason, "wikilink");
    assert.deepEqual(warningsOf(receipt)[1]!.details, { to: "notes/broken" });
  });
});

test("a link spelled with another case than an existing folder does not hide the other findings", async () => {
  await withBundle(async (dir) => {
    const receipt = await runJson(doc, ["write", "tasks/one", "--type", "Task", "--title", "One", "--body", "See [Plan](/Notes/Plan.md) and [[tasks/t9]].", "--dir", dir]);
    assert.equal(receipt.doc, "written");
    assert.equal(warningsOf(receipt)[0]!.details!.reason, "wikilink");
    // Where the host equates this pair core refuses the folded spelling on read, naming the
    // existing one; elsewhere the spelling is a distinct id that names no document. The verdict is
    // the pair's, never the aggregate host class (this file runs in the aliasing-host lane).
    if (hostAliasesPair(await detectHostAliasing(), "notes/plan", "Notes/Plan")) {
      assert.deepEqual(codes(receipt), ["LINK_NOT_RECOGNIZED", "LINK_LINT_UNAVAILABLE"]);
      assert.deepEqual(warningsOf(receipt)[1]!.details, { to: "Notes/Plan" });
      assert.match(warningsOf(receipt)[1]!.message, /^the link to 'Notes\/Plan' could not be checked: /);
    } else {
      assert.deepEqual(codes(receipt), ["LINK_NOT_RECOGNIZED", "LINK_TARGET_ABSENT"]);
    }
  });
});

test("an aliased wikilink is quoted as written", async () => {
  await withBundle(async (dir) => {
    const receipt = await runJson(doc, ["write", "tasks/one", "--type", "Task", "--title", "One", "--body", "See [[tasks/t9|the plan]].", "--dir", dir]);
    const [wikilink] = warningsOf(receipt);
    assert.match(wikilink!.message, /^\[\[tasks\/t9\|the plan\]\] will not register as a link: .*; write \[the plan\]\(\/tasks\/t9\.md\)\.$/);
    assert.equal(wikilink!.details!.text, "the plan");
  });
});

test("the TOON receipt prints the findings in the warnings shape other receipts use", async () => {
  await withBundle(async (dir) => {
    const out = await run(doc, ["write", "notes/one", "--type", "Task", "--title", "One", "--body", "See [[tasks/t9]].", "--dir", dir], false);
    assert.match(out, /^warnings\[1\]:\n  - code: LINK_NOT_RECOGNIZED\n    message: .*\n    field: body\n    severity: warning\n    details:\n      reason: wikilink\n/m);
  });
});

test("at most ten link findings are listed; the last says how many more there are", async () => {
  await withBundle(async (dir) => {
    const body = Array.from({ length: 12 }, (_, n) => `[[tasks/t${n}]]`).join(" ");
    const receipt = await runJson(doc, ["write", "tasks/many", "--type", "Task", "--title", "Many", "--body", body, "--dir", dir]);
    const warnings = warningsOf(receipt);
    assert.equal(warnings.length, 10);
    assert.match(warnings[9]!.message, /\(2 more link findings not shown\)$/);
    assert.equal(warnings[9]!.details!.href, "tasks/t9");
  });
});
