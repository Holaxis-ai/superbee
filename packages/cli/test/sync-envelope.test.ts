// One sync receipt shape across homes (designs/seamless-multi-backend-cli, S4): every `sync --json`
// run receipt carries `home`, `sent`, `received`, `conflicts`, `held` and `next` beside its home's
// own keys, which stay exactly as they were. The built rehearsal (multi-backend-session.test.ts)
// checks the keys in all three homes end to end; this pins the projection and the per-home verbs.
import test from "node:test";
import assert from "node:assert/strict";

import { conditionDigest } from "../src/commands/turn-end.js";
import { CliError } from "../src/errors.js";
import { SYNC_ENVELOPE_KEYS, SYNC_RECEIPT_SCHEMA_VERSION, syncEnvelope, syncVerbNotApplicable, withSyncEnvelope } from "../src/sync-outcomes.js";

test("an envelope counts what it is given, and zero for the rest", () => {
  assert.deepEqual(syncEnvelope("local"), { home: "local", sent: 0, received: 0, conflicts: 0, held: 0, next: [] });
  assert.deepEqual(syncEnvelope("git", { sent: 2, received: 4 }), { home: "git", sent: 2, received: 4, conflicts: 0, held: 0, next: [] });
});

test("the envelope is additive: every existing key kept, in order and unchanged, then the version and the envelope", () => {
  const receipt = { sync: "hosted", status: "incomplete", counts: { committed: 3, conflict: 1 }, rows: [{ id: "notes/alpha" }], help: ["x"] };
  const out = withSyncEnvelope(receipt, syncEnvelope("hosted", { sent: 3, conflicts: 1, next: ["x"] }));
  assert.deepEqual(Object.keys(out), [...Object.keys(receipt), "schema_version", ...SYNC_ENVELOPE_KEYS]);
  for (const [key, value] of Object.entries(receipt)) assert.deepEqual(out[key], value, key);
  assert.equal(out.schema_version, SYNC_RECEIPT_SCHEMA_VERSION);
  assert.deepEqual([out.home, out.sent, out.conflicts, out.next], ["hosted", 3, 1, ["x"]]);
  // A key a receipt already carries is never overwritten.
  const own = withSyncEnvelope({ home: "mine", schema_version: 7 }, syncEnvelope("git"));
  assert.deepEqual([own.home, own.schema_version], ["mine", 7]);
  // The input is not changed.
  assert.equal("home" in receipt, false);
});

test("a verb of another home answers one 'not applicable in a <home> bundle'", () => {
  const git = syncVerbNotApplicable(["accept-deletes", "restore-deletes"], "git", "they apply to a hosted checkout only", "superbee sync --help");
  assert.ok(git instanceof CliError);
  assert.equal(git.code, "USAGE");
  assert.equal(git.message, "--accept-deletes, --restore-deletes are not applicable in a git bundle: they apply to a hosted checkout only");
  assert.equal(git.help, "superbee sync --help");
  assert.deepEqual(git.details, { reason: "not_applicable", home: "git", flags: ["--accept-deletes", "--restore-deletes"] });
  assert.match(syncVerbNotApplicable(["establish"], "hosted", "why", "h").message, /^--establish is not applicable in a hosted bundle: why$/);
});

test("the Stop hook's condition digest is the same for the same condition, with or without the envelope", () => {
  const receipt = { sync: "hosted", counts: { committed: 0, conflict: 1 }, rows: [{ id: "notes/alpha", state: "conflict", reason: "changed_remotely" }], help: ["x"] };
  const error = new CliError("CONFLICT", "1 document(s) not synced", { details: { reason: "sync_incomplete" } });
  assert.equal(conditionDigest(error, JSON.stringify(withSyncEnvelope(receipt, syncEnvelope("hosted", { conflicts: 1, next: ["x"] })))), conditionDigest(error, JSON.stringify(receipt)));
});
