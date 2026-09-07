/**
 * The OKF actor grammar's guidance half: a deterministic corrected spelling for a rejected value,
 * and the typed rejection every presenting boundary keys off. Pure: no bundle on disk.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OkfActorError } from "../src/errors.js";
import { applyV02MutationMetadata } from "../src/document-write-policy.js";
import { OKF_ACTOR_FORMS, isOkfActor, suggestOkfActor } from "../src/okf-actor.js";
import { appendVerificationEvent } from "../src/verification.js";

test("suggestOkfActor: a conforming value is returned as-is with no alternatives", () => {
  for (const actor of ["human:brian", "process:nightly", "openai/codex", "anthropic/claude"]) {
    assert.deepEqual(suggestOkfActor(actor), { primary: actor, alternatives: [], placeholder: false });
  }
});

test("suggestOkfActor: bare names offer the process reading first and the human reading as the alternative", () => {
  assert.deepEqual(suggestOkfActor("codex-root"), { primary: "process:codex-root", alternatives: ["human:codex-root"], placeholder: false });
  assert.deepEqual(suggestOkfActor("brian"), { primary: "process:brian", alternatives: ["human:brian"], placeholder: false });
  assert.deepEqual(suggestOkfActor("  claude review orchestrator "), {
    primary: "process:claude-review-orchestrator",
    alternatives: ["human:claude-review-orchestrator"],
    placeholder: false,
  });
});

test("suggestOkfActor: a role-qualified producer path keeps the two-segment identity and offers the role as a process id", () => {
  assert.deepEqual(suggestOkfActor("openai/codex/root"), { primary: "openai/codex", alternatives: ["process:codex-root"], placeholder: false });
  assert.deepEqual(suggestOkfActor("openai/codex/access-admin-ui"), {
    primary: "openai/codex",
    alternatives: ["process:codex-access-admin-ui"],
    placeholder: false,
  });
  // A segment that slugs to nothing must not leak a dangling `a/`: fall through to the bare rule.
  assert.deepEqual(suggestOkfActor("a/:/b"), { primary: "process:a-b", alternatives: ["human:a-b"], placeholder: false });
  assert.deepEqual(suggestOkfActor(":/x/y"), { primary: "process:x-y", alternatives: ["human:x-y"], placeholder: false });
});

test("suggestOkfActor: a kind prefix is preserved and its id repaired; case and whitespace are normalized", () => {
  assert.deepEqual(suggestOkfActor("Human:alice"), { primary: "human:alice", alternatives: [], placeholder: false });
  assert.deepEqual(suggestOkfActor("human:Jane Doe"), { primary: "human:Jane-Doe", alternatives: [], placeholder: false });
  // An embedded line terminator keeps the human: kind (SPEC 7 distinguishes the identities).
  assert.deepEqual(suggestOkfActor("human:Jane\nDoe"), { primary: "human:Jane-Doe", alternatives: [], placeholder: false });
  assert.deepEqual(suggestOkfActor("process:"), { primary: "process:<id>", alternatives: [], placeholder: true });
  assert.deepEqual(suggestOkfActor("my tool/v 2"), { primary: "my-tool/v-2", alternatives: [], placeholder: false });
  assert.deepEqual(suggestOkfActor(" / "), { primary: "process:<id>", alternatives: ["human:<id>", "<producer>/<version>"], placeholder: true });
});

test("suggestOkfActor: every suggestion it makes for a concrete value conforms to the grammar it repairs", () => {
  const inputs = [
    "codex-root", "openai/codex/root", "Human:alice", "human:Jane Doe", "agent:builder", "a/b/c/d", "x y",
    "a/:/b", ":/x/y", "a/ : /b", "a//b", "/a", "a/", "process:::", "humán:x", "$(id)", "a;b", "`x`", "--dir",
    "\tlead", "a\nb", "x".repeat(5000), "human:", ":", "///",
  ];
  for (const value of inputs) {
    const { primary, alternatives, placeholder } = suggestOkfActor(value);
    for (const candidate of [primary, ...alternatives]) {
      if (placeholder) assert.match(candidate, /<id>|<producer>/, `${JSON.stringify(value)} placeholder -> ${candidate}`);
      else assert.equal(isOkfActor(candidate), true, `${JSON.stringify(value)} -> ${candidate}`);
    }
  }
  assert.match(OKF_ACTOR_FORMS, /human:<id>.*process:<id>.*<producer>\/<version>/);
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

test("OkfActorError: the write policy and the verifier append both raise the typed rejection carrying the actor", () => {
  const err = capture(() =>
    applyV02MutationMetadata({
      candidate: { frontmatter: { type: "Note" }, body: "" },
      meaningfulChangeAt: "2026-09-07T12:00:00.000Z",
      actor: "codex-root",
    }),
  );
  assert.ok(err instanceof OkfActorError, String(err));
  assert.equal(err.actor, "codex-root");
  const verifier = capture(() => appendVerificationEvent({}, { by: "openai/codex/root", at: "2026-09-07T12:00:00Z" }));
  assert.ok(verifier instanceof OkfActorError, String(verifier));
  assert.equal(verifier.actor, "openai/codex/root");
});
