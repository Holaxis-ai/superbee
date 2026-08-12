/**
 * The BoardGitError → CliError PARITY TABLE (board-git A0's behavior pin).
 *
 * Before the taxonomy split the git tier threw `CliError` directly; now it throws typed
 * `BoardGitError`s (from `@superbee/board-git`) that THE one boundary mapping (`cliErrorFromBoardGit`, also applied inside
 * `classifyBundleError`/`toExit`) projects onto the CLI surface. This suite pins that the
 * projection is IDENTICAL to the old direct-throw behavior for EVERY BoardGitError code:
 * same-named CliErrorCode, same exit code, byte-identical envelope (message/details/help
 * preserved verbatim). The table is exhaustive by construction — a Record over
 * `BoardGitErrorCode` fails to compile when a code is added without a row.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_GIT_ERROR_CODES,
  BoardGitError,
  classifyGitError,
  isBoardGitError,
  type BoardGitErrorCode,
} from "@superbee/board-git";
import {
  CliError,
  classifyBundleError,
  cliErrorFromBoardGit,
  toEnvelope,
  toExit,
  EXIT,
  type CliErrorCode,
} from "../src/errors.js";

/** Every code's expected CLI projection — the values the tier's direct CliError throws had. */
const PARITY: Record<BoardGitErrorCode, { cliCode: CliErrorCode; exit: number }> = {
  GIT_MISSING: { cliCode: "GIT_MISSING", exit: EXIT.RUNTIME },
  TRANSIENT: { cliCode: "TRANSIENT", exit: EXIT.RUNTIME },
  GIT_BUSY: { cliCode: "GIT_BUSY", exit: EXIT.RUNTIME },
  NO_UPSTREAM: { cliCode: "NO_UPSTREAM", exit: EXIT.RUNTIME },
  AUTH_REQUIRED: { cliCode: "AUTH_REQUIRED", exit: EXIT.AUTH },
  CONFLICT: { cliCode: "CONFLICT", exit: EXIT.CONFLICT },
  RUNTIME: { cliCode: "RUNTIME", exit: EXIT.RUNTIME },
};

test("BOARD_GIT_ERROR_CODES and the parity table cover the same set", () => {
  assert.deepEqual([...BOARD_GIT_ERROR_CODES].sort(), Object.keys(PARITY).sort());
});

for (const code of BOARD_GIT_ERROR_CODES) {
  test(`parity: ${code} maps to CliError ${PARITY[code].cliCode} / exit ${PARITY[code].exit} with an identical envelope`, () => {
    const details = { op: "fetch", retryable: true };
    const help = "run the fixing command";
    const boardErr = new BoardGitError(code, `msg for ${code}`, { details, help });

    // The one mapping layer, direct.
    const mapped = cliErrorFromBoardGit(boardErr);
    assert.ok(mapped instanceof CliError);
    assert.equal(mapped.code, PARITY[code].cliCode);
    assert.equal(mapped.exitCode, PARITY[code].exit);
    assert.equal(mapped.message, boardErr.message);
    assert.deepEqual(mapped.details, details);
    assert.equal(mapped.help, help);

    // The catch-all boundary agrees row for row.
    const classified = classifyBundleError(boardErr);
    assert.equal(classified.code, PARITY[code].cliCode);
    assert.equal(classified.exitCode, PARITY[code].exit);

    // The bin wrapper's projection — envelope byte-identical to a direct CliError throw.
    const exit = toExit(boardErr);
    assert.equal(exit.exitCode, PARITY[code].exit);
    assert.deepEqual(
      exit.envelope,
      toEnvelope(new CliError(PARITY[code].cliCode, `msg for ${code}`, { details, help })),
    );
  });
}

test("parity: absent details/help stay absent through the mapping (no undefined keys minted)", () => {
  const mapped = cliErrorFromBoardGit(new BoardGitError("RUNTIME", "bare"));
  assert.equal(mapped.details, undefined);
  assert.equal(mapped.help, undefined);
  assert.deepEqual(toEnvelope(mapped), { error: { code: "RUNTIME", message: "bare" } });
});

test("classifyGitError produces BoardGitError (never CliError) — the tier's own taxonomy", () => {
  const err = classifyGitError({ args: ["fetch"], status: null, stdout: "", stderr: "", spawnErrorCode: "ENOENT" });
  assert.ok(isBoardGitError(err));
  assert.ok(!(err instanceof CliError));
  assert.equal(err.code, "GIT_MISSING");
});

test("isBoardGitError: STRUCTURAL detection — a dual-load twin passes, non-board errors do not", () => {
  assert.ok(isBoardGitError(new BoardGitError("GIT_BUSY", "locked")));
  // The dual-load hazard: a structurally identical instance from a second copy of the module
  // (dist vs aliased source) must still be detected — simulate with a plain shaped object.
  const twin = Object.assign(new Error("locked"), { name: "BoardGitError", code: "GIT_BUSY" });
  assert.ok(isBoardGitError(twin));
  // Not board-git errors: CliError (name differs), unknown code, plain Error, primitives.
  assert.ok(!isBoardGitError(new CliError("GIT_BUSY", "locked")));
  assert.ok(!isBoardGitError(Object.assign(new Error("x"), { name: "BoardGitError", code: "NOT_A_CODE" })));
  assert.ok(!isBoardGitError(new Error("x")));
  assert.ok(!isBoardGitError(null));
  assert.ok(!isBoardGitError("GIT_BUSY"));
});
