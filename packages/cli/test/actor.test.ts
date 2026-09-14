import test from "node:test";
import assert from "node:assert/strict";

import { ACTOR_ENV, SUPERBEE_ACTOR_ENV, resolveActor } from "../src/actor.js";
import { CliError } from "../src/errors.js";

test("resolveActor: explicit flag wins over environment and both are trimmed", () => {
  assert.equal(resolveActor("  flag-user  ", { env: { [ACTOR_ENV]: "env-user" } }), "flag-user");
  assert.equal(resolveActor("flag-user", { env: { [ACTOR_ENV]: "   " } }), "flag-user");
});

test("resolveActor: environment is the fallback; neither source stays absent", () => {
  assert.equal(resolveActor(undefined, { env: { [ACTOR_ENV]: "  env-user  " } }), "env-user");
  assert.equal(resolveActor(undefined, { env: { [SUPERBEE_ACTOR_ENV]: "  superbee-user  " } }), "superbee-user");
  assert.equal(resolveActor(undefined, { env: {} }), undefined);
});

test("resolveActor: compatible Superbee and legacy environment actors must agree", () => {
  assert.equal(
    resolveActor(undefined, { env: { [SUPERBEE_ACTOR_ENV]: "  same-user  ", [ACTOR_ENV]: "same-user" } }),
    "same-user",
  );
  assert.throws(
    () => resolveActor(undefined, { env: { [SUPERBEE_ACTOR_ENV]: "superbee-user", [ACTOR_ENV]: "legacy-user" } }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "USAGE");
      assert.match(err.message, new RegExp(SUPERBEE_ACTOR_ENV));
      assert.match(err.message, new RegExp(ACTOR_ENV));
      return true;
    },
  );
});

test("resolveActor: a present-but-blank flag or environment value fails loudly", () => {
  for (const [explicit, env, source] of [
    ["  ", { [ACTOR_ENV]: "env-user" }, "--actor"],
    [undefined, { [ACTOR_ENV]: " \t " }, ACTOR_ENV],
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
