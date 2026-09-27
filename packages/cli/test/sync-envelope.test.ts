// One sync receipt shape across homes (designs/seamless-multi-backend-cli, S4): every `sync --json`
// run receipt carries `home`, `sent`, `received`, `conflicts`, `held` and `next` beside its home's
// own keys, which stay exactly as they were. The built rehearsal (multi-backend-session.test.ts)
// checks the keys in all three homes end to end; this pins the projection and the per-home verbs.
import test from "node:test";
import assert from "node:assert/strict";

import { CliError } from "../src/errors.js";
import { SYNC_ENVELOPE_KEYS, SYNC_RECEIPT_SCHEMA_VERSION, syncEnvelope, syncVerbNotApplicable, withSyncEnvelope } from "../src/sync-outcomes.js";

const hostedReceipt = {
  sync: "hosted",
  bundle_id: "team.knowledge",
  status: "incomplete",
  pulled: { refreshed: 2, removed: 1 },
  counts: { committed: 3, conflict: 1, held: 2, refused: 0, unknown: 0, paused: 0 },
  rows: [{ id: "notes/alpha", state: "conflict", reason: "changed_remotely" }],
  help: ["superbee sync --inspect --doc notes/alpha --dir /x"],
};

test("each home's receipt projects to the same envelope keys", () => {
  assert.deepEqual(syncEnvelope(hostedReceipt, "hosted"), { home: "hosted", sent: 3, received: 3, conflicts: 1, held: 2, next: ["superbee sync --inspect --doc notes/alpha --dir /x"] });
  assert.deepEqual(syncEnvelope({ committed: 2, pushed: 1, pulled: 4, incoming: { shown: 0, total: 0, rows: [] } }, "git"), { home: "git", sent: 2, received: 4, conflicts: 0, held: 0, next: [] });
  assert.deepEqual(syncEnvelope({ committed: 2, pushed: 0, pulled: 0 }, "git").sent, 0, "committed but not pushed is not sent");
  assert.deepEqual(syncEnvelope({ sync: "already up to date" }, "git"), { home: "git", sent: 0, received: 0, conflicts: 0, held: 0, next: [] });
  assert.deepEqual(syncEnvelope({ sync: "nothing to sync" }, "local"), { home: "local", sent: 0, received: 0, conflicts: 0, held: 0, next: [] });
});

test("the envelope is additive: every existing key kept, in order and unchanged, then the version and the envelope", () => {
  const text = `${JSON.stringify(hostedReceipt)}\n`;
  const out = withSyncEnvelope(text, "hosted");
  assert.ok(out.endsWith("\n"));
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [...Object.keys(hostedReceipt), "schema_version", ...SYNC_ENVELOPE_KEYS]);
  for (const [key, value] of Object.entries(hostedReceipt)) assert.deepEqual(parsed[key], value, key);
  assert.equal(parsed.schema_version, SYNC_RECEIPT_SCHEMA_VERSION);
  // A key a receipt already carries is never overwritten.
  assert.equal((JSON.parse(withSyncEnvelope(JSON.stringify({ home: "mine", schema_version: 7 }), "git")) as { home: string; schema_version: number }).home, "mine");
  // Anything that is not one JSON object receipt passes through as it is.
  for (const other of ['{"error":{"code":"CONFLICT","message":"x"}}\n', "sync: hosted\nstatus: synced\n", "[1,2]", "not json"]) assert.equal(withSyncEnvelope(other, "git"), other);
});

test("a verb of another home answers one 'not applicable in a <home> bundle'", () => {
  const git = syncVerbNotApplicable(["accept-deletes", "restore-deletes"], "git", "help");
  assert.ok(git instanceof CliError);
  assert.equal(git.code, "USAGE");
  assert.equal(git.message, "--accept-deletes, --restore-deletes are not applicable in a git bundle");
  assert.deepEqual(git.details, { reason: "not_applicable", home: "git", flags: ["--accept-deletes", "--restore-deletes"] });
  assert.equal(syncVerbNotApplicable(["establish"], "hosted", "h").message, "--establish is not applicable in a hosted bundle");
});
