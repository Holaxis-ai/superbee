import test from "node:test";
import assert from "node:assert/strict";

import { SUPERBEE_ACTOR_ENV, resolveActor } from "../src/actor.js";
import { CliError } from "../src/errors.js";

test("resolveActor: explicit flag wins over environment and both are trimmed", () => {
  assert.equal(resolveActor("  flag-user  ", { env: { [SUPERBEE_ACTOR_ENV]: "env-user" } }), "flag-user");
  assert.equal(resolveActor("flag-user", { env: { [SUPERBEE_ACTOR_ENV]: "   " } }), "flag-user");
});

test("resolveActor: environment is the fallback; neither source stays absent", () => {
  assert.equal(resolveActor(undefined, { env: { [SUPERBEE_ACTOR_ENV]: "  superbee-user  " } }), "superbee-user");
  assert.equal(resolveActor(undefined, { env: {} }), undefined);
});

test("resolveActor: the retired AGENTSTATE_LITE_ACTOR is never read", () => {
  assert.equal(resolveActor(undefined, { env: { AGENTSTATE_LITE_ACTOR: "legacy-user" } }), undefined);
  assert.equal(
    resolveActor(undefined, { env: { [SUPERBEE_ACTOR_ENV]: "superbee-user", AGENTSTATE_LITE_ACTOR: "legacy-user" } }),
    "superbee-user",
  );
});

test("resolveActor: a present-but-blank flag or environment value fails loudly", () => {
  for (const [explicit, env, source] of [
    ["  ", { [SUPERBEE_ACTOR_ENV]: "env-user" }, "--actor"],
    [undefined, { [SUPERBEE_ACTOR_ENV]: " \t " }, SUPERBEE_ACTOR_ENV],
  ] as const) {
    assert.throws(
      () => resolveActor(explicit, { env, help: "aslite example --actor <name>" }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, new RegExp(source));
        assert.equal(err.help, "aslite example --actor <name>");
        return true;
      },
    );
  }
});
