// Tests for src/reference.ts's `--help` index renderer (help-index-readability task).
//
// Round context: field feedback (external-agent session) found the top-level `--help` crammed every
// group's commands into a single TOON-encoded string-array value per group — an agent had to grep a
// giant escaped line rather than read it — while subcommand help (`new --help`) is plain prose and
// was praised. `helpIndexText()` replaces the TOON rendering with grouped plain text, one command per
// physical line; `commandReference()`/`COMMAND_GROUPS` (the registry) are UNCHANGED — only the
// renderer cli.ts's `--help` calls is new. These tests pin the NEW shape and guard against the OLD
// TOON-array shape regressing.
import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_GROUPS, DESCRIPTION, compactCommandReference, helpIndexText, remoteEnvPointer, wrapText } from "../src/reference.js";

const INV = "agentstate-lite";

/** Escape a string for embedding in a `new RegExp(...)` pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("helpIndexText: no TOON array shape survives — no `Group[n]:` header, no comma-quote array-item join", () => {
  const text = helpIndexText(INV);
  assert.doesNotMatch(text, /\[\d+\]:/, "must not contain a TOON array-length header like `Bundle[3]:`");
  assert.doesNotMatch(text, /","/, "must not contain TOON's comma-quote array-item separator");
});

test("helpIndexText: every group renders as its own plain-text heading line", () => {
  const text = helpIndexText(INV);
  for (const { group } of COMMAND_GROUPS) {
    assert.match(text, new RegExp(`(^|\\n)${escapeRegExp(group)}:\\n`), `missing "${group}:" heading`);
  }
});

test("helpIndexText: one command per physical line — each command's usage+summary is its own line, not comma-joined with siblings", () => {
  const text = helpIndexText(INV);
  const lines = text.split("\n");
  for (const { commands } of COMMAND_GROUPS) {
    for (const { usage, summary } of commands) {
      const expected = `  ${usage} — ${summary}`;
      assert.ok(
        lines.includes(expected),
        `expected "${usage}" to render on its own line, got:\n${text}`,
      );
    }
  }
});

test("helpIndexText: carries the tool description and a usage line (context subcommand help already had, index lacked)", () => {
  const text = helpIndexText(INV);
  assert.match(text, new RegExp(`^${escapeRegExp(INV)} — ${escapeRegExp(DESCRIPTION)}$`, "m"));
  assert.match(text, new RegExp(`^Usage: ${escapeRegExp(INV)} <command> \\[options\\]$`, "m"));
  assert.match(text, /full reference/);
});

test("helpIndexText: the kinds + bundle-resolution footer pointers still appear, as wrapped prose (not one giant unbroken line)", () => {
  const text = helpIndexText(INV);
  assert.match(text, /kinds are declared per-bundle/);
  assert.match(text, /bundle resolution: HTTP is activated only by explicit --remote/);
  // The raw remoteEnvPointer() is authored as ONE long line (no embedded newlines) — if it still
  // appeared verbatim in the rendered text, the footer would not actually be wrapped.
  assert.ok(!text.includes(remoteEnvPointer()), "remoteEnvPointer must be wrapped across lines, not embedded unbroken");
});

test("helpIndexText: is invocation-parameterized (no hardcoded bin name)", () => {
  const text = helpIndexText("some-other-bin");
  assert.match(text, /^some-other-bin — /m);
  assert.doesNotMatch(text, /\bagentstate-lite\b/);
});

test("wrapText: wraps long prose at existing spaces without breaking words, and leaves short text on one line", () => {
  assert.equal(wrapText("short line"), "short line");

  const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
  const wrapped = wrapText(long, 20);
  const lines = wrapped.split("\n");
  assert.ok(lines.length > 1, "expected the long text to wrap onto multiple lines");
  for (const line of lines) {
    assert.ok(line.length <= 20, `line exceeds requested width: "${line}"`);
  }
  // No word was split or dropped: rejoining the wrapped lines with spaces reproduces the input.
  assert.equal(lines.join(" "), long);
});

test("compactCommandReference: command names are deduplicated and hosted control-plane groups are absent", () => {
  const { commands } = compactCommandReference(INV);
  for (const [group, names] of Object.entries(commands)) {
    const list = names.split(", ");
    assert.deepEqual(list, [...new Set(list)], `group '${group}' repeats a command name: ${names}`);
  }
  assert.equal(commands.Identity, undefined);
  assert.equal(commands["Invites & members (admin)"], undefined);
  assert.equal(commands["API keys"], undefined);
});

// ── probe-help-surface-fixes finding 2: `doc history`'s top-level one-liner is honest about
// backend dependence ────────────────────────────────────────────────────────────────────────────
//
// Cold-start usability probe (2026-07-19): the top-level `--help`'s `doc history` blurb promised
// "attributed version history" unconditionally, but a LOCAL backend returns just the single current
// revision (`doc history --help`'s own full text already says so — see doc.test.ts's per-verb-help
// test). RED PROOF: the pre-fix wording was exactly "Show a doc's attributed version history
// (newest first) — the tokens for --expected-version", with no backend qualifier at all.

test("COMMAND_GROUPS: the 'doc history' one-line summary names backend-dependence — a local bundle keeps just the current revision, not a promise of attributed history unconditionally", () => {
  const docHistory = COMMAND_GROUPS.flatMap((g) => g.commands).find((c) => c.usage.startsWith("doc history"));
  assert.ok(docHistory, "expected a 'doc history' command entry in COMMAND_GROUPS");
  assert.match(docHistory!.summary, /local bundle/i);
  assert.match(docHistory!.summary, /current revision/i);
  assert.match(docHistory!.summary, /history-keeping backend/i);
  // The --expected-version pointer (the summary's other job) survives the honesty fix.
  assert.match(docHistory!.summary, /--expected-version/);
});

test("helpIndexText: the rendered top-level index carries doc history's honest, backend-dependent summary verbatim", () => {
  const text = helpIndexText(INV);
  // The rendered line is derived from the registry row, so a legitimate USAGE edit (adding a flag
  // the leaf really accepts) cannot fail this test — only losing or mangling the summary can.
  const docHistory = COMMAND_GROUPS.flatMap((g) => g.commands).find((c) => c.usage.startsWith("doc history"));
  assert.ok(docHistory, "expected a 'doc history' command entry in COMMAND_GROUPS");
  assert.match(docHistory!.summary, /a history-keeping backend returns the full attributed chain, a local bundle just the current revision/);
  assert.ok(text.includes(`${docHistory!.usage} — ${docHistory!.summary}`), text);
});
