/**
 * OKF v0.2 `verified` read normalization, trust-tier derivation (SPEC 5.2, 5.3), and the one
 * append policy. Pure: no bundle on disk.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InvalidInputError } from "../src/errors.js";
import { isHumanActor, isOkfActor } from "../src/okf-actor.js";
import {
  appendVerificationEvent,
  latestVerifiedAt,
  parseIsoInstant,
  storedInstant,
  trustTier,
  verificationEvents,
} from "../src/verification.js";

test("actor grammar: human/process identities and producer/version pairs; everything else is rejected", () => {
  for (const actor of ["human:alice", "process:finance-nightly", "reference_agent/gemini-2.5-pro", "openai/codex"]) {
    assert.equal(isOkfActor(actor), true, actor);
  }
  for (const actor of ["", " human:alice", "human:", "codex-root", "brian", "human:a b", "a/b/c", 42, undefined]) {
    assert.equal(isOkfActor(actor), false, String(actor));
  }
  assert.equal(isHumanActor("human:alice"), true);
  assert.equal(isHumanActor("process:alice"), false);
  assert.equal(isHumanActor("humanoid/1.0"), false);
  // Read-side classification keys off the prefix alone (SPEC 7): a producer's malformed human
  // spelling still names a person; case and an empty id do not.
  assert.equal(isHumanActor("human:Jane Doe"), true);
  assert.equal(isOkfActor("human:Jane Doe"), false);
  assert.equal(isHumanActor("Human:alice"), false);
  assert.equal(isHumanActor("human:"), false);
});

test("verificationEvents: absent -> [], bare mapping -> one-element list (SPEC 5.2 MUST), list preserved with extras", () => {
  assert.deepEqual(verificationEvents({ type: "Note" }), []);
  assert.deepEqual(verificationEvents({ verified: null }), []);
  assert.deepEqual(
    verificationEvents({ verified: { by: "human:ahormati", at: "2026-06-25T09:00:00Z" } }),
    [{ by: "human:ahormati", at: "2026-06-25T09:00:00Z" }],
  );
  const list = [
    { by: "human:reviewer", at: "2026-07-29T09:15:00Z", method: "human-review" },
    { by: "process:finance-nightly", at: "2026-07-30T02:00:00Z" },
  ];
  const events = verificationEvents({ verified: list });
  assert.deepEqual(events, list);
  assert.notEqual(events[0], list[0], "returned events are copies, never the frontmatter's own objects");
});

test("verificationEvents: entries without a usable `by` cannot name a verifier and are skipped", () => {
  assert.deepEqual(
    verificationEvents({ verified: [{ at: "2026-01-01T00:00:00Z" }, "human:alice", { by: " " }, { by: "human:bob" }] }),
    [{ by: "human:bob" }],
  );
  assert.deepEqual(verificationEvents({ verified: "human:alice" }), []);
});

test("trustTier: no key -> unverified; non-human verifiers only -> machine-confirmed; any human: -> human-reviewed", () => {
  assert.equal(trustTier({}), "unverified");
  assert.equal(trustTier({ verified: [] }), "unverified");
  assert.equal(trustTier({ verified: { by: "process:nightly", at: "2026-01-01T00:00:00Z" } }), "machine-confirmed");
  assert.equal(trustTier({ verified: [{ by: "finance_agent/1.0" }] }), "machine-confirmed");
  assert.equal(
    trustTier({ verified: [{ by: "process:nightly" }, { by: "human:ahormati", at: "2026-01-02T00:00:00Z" }] }),
    "human-reviewed",
  );
  // The tier keys off the prefix, not the substring: a producer named "human" is still a machine.
  assert.equal(trustTier({ verified: [{ by: "human/2.0" }] }), "machine-confirmed");
  // A verifier spelled outside the grammar is a verifier, but not a human one — unless it still
  // carries the human: prefix, which a consumer must not downgrade (SPEC 7, 11).
  assert.equal(trustTier({ verified: [{ by: "brian" }] }), "machine-confirmed");
  assert.equal(trustTier({ verified: [{ by: "human:Jane Doe" }] }), "human-reviewed");
  assert.equal(trustTier({ verified: [{ by: "human:" }] }), "machine-confirmed");
});

test("latestVerifiedAt: the newest parseable instant wins; unparseable or missing `at` is ignored", () => {
  assert.equal(latestVerifiedAt([]), undefined);
  assert.equal(latestVerifiedAt([{ by: "human:a" }]), undefined);
  assert.equal(
    latestVerifiedAt([
      { by: "human:a", at: "2026-01-03T00:00:00Z" },
      { by: "process:b", at: "not a date" },
      { by: "process:c", at: "2026-01-05T00:00:00.000Z" },
      { by: "human:d", at: "2026-01-04T00:00:00Z" },
    ]),
    "2026-01-05T00:00:00.000Z",
  );
});

test("appendVerificationEvent: absent -> [event]; bare mapping -> [existing, event]; list grows by one with extras intact", () => {
  const at = "2026-09-07T12:00:00.000Z";
  assert.deepEqual(appendVerificationEvent({ type: "Note", title: "T" }, { by: "human:alice", at }), {
    type: "Note",
    title: "T",
    verified: [{ by: "human:alice", at }],
  });
  const bare = { verified: { by: "human:ahormati", at: "2026-06-25T09:00:00Z" } };
  assert.deepEqual(appendVerificationEvent(bare, { by: "process:nightly", at }).verified, [
    { by: "human:ahormati", at: "2026-06-25T09:00:00Z" },
    { by: "process:nightly", at },
  ]);
  const list = { verified: [{ by: "human:reviewer", at: "2026-07-29T09:15:00Z", method: "human-review" }] };
  const appended = appendVerificationEvent(list, { by: "human:reviewer", at });
  assert.deepEqual(appended.verified, [
    { by: "human:reviewer", at: "2026-07-29T09:15:00Z", method: "human-review" },
    { by: "human:reviewer", at },
  ]);
  assert.deepEqual(list.verified, [{ by: "human:reviewer", at: "2026-07-29T09:15:00Z", method: "human-review" }], "input untouched");
});

test("appendVerificationEvent: an already-recorded event (same by, same instant) returns the input unchanged", () => {
  const list = { verified: [{ by: "human:a", at: "2026-06-25T09:00:00Z" }, { by: "process:b", at: "2026-06-26T02:00:00Z" }] };
  assert.equal(appendVerificationEvent(list, { by: "human:a", at: "2026-06-25T09:00:00.000Z" }), list, "same instant, different spelling");
  const bare = { verified: { by: "human:a", at: "2026-06-25T09:00:00Z" } };
  assert.equal(appendVerificationEvent(bare, { by: "human:a", at: "2026-06-25T09:00:00Z" }), bare, "a satisfied bare mapping keeps its bytes");
  // A different instant or a different verifier is a new confirmation.
  assert.equal((appendVerificationEvent(list, { by: "human:a", at: "2026-06-27T00:00:00Z" }).verified as unknown[]).length, 3);
  assert.equal((appendVerificationEvent(list, { by: "human:c", at: "2026-06-25T09:00:00Z" }).verified as unknown[]).length, 3);
});

test("stored instants resolve through one grammar: hour-only offsets compare and rank like every other spelling", () => {
  // Date.parse alone cannot read `+02`; the strict grammar must be consulted first.
  assert.equal(storedInstant("2026-09-07T14:00:00+02"), Date.UTC(2026, 8, 7, 12));
  assert.equal(storedInstant("2026-09-07T12:00:00Z"), Date.UTC(2026, 8, 7, 12));
  // Legacy producer spellings the read side must not drop still resolve permissively.
  assert.equal(storedInstant("2026-06-21 03:00:00"), Date.parse("2026-06-21 03:00:00"));
  assert.equal(storedInstant("not a date"), null);
  assert.equal(storedInstant(42), null);

  const imported = { verified: [{ by: "human:reviewer", at: "2026-09-07T14:00:00+02" }] };
  const same = appendVerificationEvent(imported, { by: "human:reviewer", at: "2026-09-07T12:00:00Z" });
  assert.equal(same, imported, "an imported +02 event re-verified at the same instant is already recorded");
  assert.equal(
    latestVerifiedAt([
      { by: "process:a", at: "2026-09-06T23:00:00Z" },
      { by: "human:b", at: "2026-09-07T14:00:00+02" },
    ]),
    "2026-09-07T14:00:00+02",
    "an hour-only offset event ranks by its real instant",
  );
});

test("appendVerificationEvent: refuses a non-conforming verifier, a bad instant, and an unrecognized verified shape", () => {
  const at = "2026-09-07T12:00:00.000Z";
  assert.throws(() => appendVerificationEvent({}, { by: "codex-root", at }), InvalidInputError);
  assert.throws(() => appendVerificationEvent({}, { by: "human:alice", at: "yesterday" }), InvalidInputError);
  // Date.parse would roll February 30 into March; the append policy refuses instead.
  assert.throws(() => appendVerificationEvent({}, { by: "human:alice", at: "2026-02-30T12:00:00Z" }), InvalidInputError);
  assert.throws(() => appendVerificationEvent({}, { by: "human:alice", at: "2026-06-25T09:00:00" }), InvalidInputError);
  for (const verified of ["human:alice", 3, [{ at }], [{ by: "human:a" }, "junk"], { at }]) {
    assert.throws(
      () => appendVerificationEvent({ verified }, { by: "human:alice", at }),
      InvalidInputError,
      JSON.stringify(verified),
    );
  }
});

test("parseIsoInstant: real calendar dates with a zone designator only — no rollover, no host-local guessing", () => {
  const T = (v: string) => parseIsoInstant(v);
  assert.equal(T("2026-09-07T12:00:00Z"), Date.UTC(2026, 8, 7, 12));
  assert.equal(T("2026-09-07T14:00:00+02:00"), Date.UTC(2026, 8, 7, 12));
  assert.equal(T("2026-09-07T14:00:00+0200"), Date.UTC(2026, 8, 7, 12));
  assert.equal(T("2026-09-07T06:30:00-05:30"), Date.UTC(2026, 8, 7, 12));
  assert.equal(T("2026-09-07t12:00:00.250z"), Date.UTC(2026, 8, 7, 12, 0, 0, 250));
  assert.equal(T("2026-09-07T12:00Z"), Date.UTC(2026, 8, 7, 12));
  assert.equal(T("2028-02-29T00:00:00Z"), Date.UTC(2028, 1, 29), "leap day in a leap year");
  assert.equal(T("2026-09-07T14:00:00+02"), Date.UTC(2026, 8, 7, 12), "ISO hour-only offset");
  // Sub-millisecond fractions truncate: never record an instant later than the caller supplied.
  assert.equal(T("2026-12-31T23:59:59.9995Z"), Date.UTC(2026, 11, 31, 23, 59, 59, 999));
  assert.equal(T("2026-12-31T23:59:59.5Z"), Date.UTC(2026, 11, 31, 23, 59, 59, 500));
  for (const bad of [
    "2026-02-30T12:00:00Z", // no February 30
    "2026-02-29T00:00:00Z", // 2026 is not a leap year
    "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-06-00T00:00:00Z",
    "2026-06-25T24:00:00Z",
    "2026-06-25T23:60:00Z",
    "2026-06-25T23:59:60Z",
    "2026-06-25T09:00:00+24:00",
    "2026-06-25T09:00:00", // zone-less
    "2026-06-25", // date-only
    "2026-06-25 09:00:00Z", // space separator
    "yesterday",
    "",
  ]) {
    assert.equal(T(bad), null, bad);
  }
});
