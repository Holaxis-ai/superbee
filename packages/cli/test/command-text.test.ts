/** Unit coverage for the supported POSIX rendering authority. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  commandToken, commandLiteral, commandQuoted, commandWords, commandFragment, joinCommandTokens,
} from "../src/command-text.js";
import { renderPosixToken, isRenderableToken } from "../src/shell-quoting.js";

test("an inert value renders verbatim so ordinary help text is unchanged", () => {
  for (const value of ["tasks/t1", "Task", "progress_status", "a-b_c.d", "http://x/y", "50", "a@b:c,d=e+f"]) {
    assert.equal(commandToken(value), value, value);
  }
});

test("a value that is not inert is quoted as ONE token", () => {
  assert.equal(commandToken("Context Note"), "'Context Note'");
  assert.equal(commandToken("<todo|done>"), "'<todo|done>'");
  assert.equal(commandToken("a'b"), "'a'\\''b'");
  // `~` is expanded by the shell, and `%` stays quoted so every host adapter can preserve the
  // shared inert-token contract.
  assert.equal(commandToken("~/x"), "'~/x'");
  assert.equal(commandToken("50%"), "'50%'");
});

test("commandWords keeps a multi-word subcommand path runnable", () => {
  assert.equal(commandWords("bundle locate"), "bundle locate");
  assert.equal(commandWords("doc update"), "doc update");
});

test("commandLiteral accepts CLI-authored scaffolding and refuses executing characters", () => {
  assert.equal(commandLiteral("--out (<path> | -)"), "--out (<path> | -)");
  assert.equal(commandLiteral(""), "");
  for (const bad of ["a; b", "a && b", "a`b`", "a$b", "a\\b", 'a"b', "a'b"]) {
    assert.throws(() => commandLiteral(bad), /not CLI-owned/, bad);
  }
});

test("commandFragment builds a multi-token suffix without a brand cast", () => {
  assert.equal(commandFragment` --dir ${commandToken("/tmp/a b")}`, " --dir '/tmp/a b'");
  assert.equal(joinCommandTokens([commandToken("--x"), commandToken("y z")]), "--x 'y z'");
});

test("commandQuoted always quotes supported-host values", () => {
  assert.equal(commandQuoted("runs on"), "'runs on'");
  // An inert value still gets quotes here — the sentence around it shows a quoted value.
  assert.equal(commandQuoted("no-such-relation"), "'no-such-relation'");
  assert.doesNotThrow(() => commandQuoted("a$b"));
  assert.doesNotThrow(() => commandQuoted("a\u201db"));
});

test("POSIX renders every byte, so it never refuses", () => {
  for (const value of ["a$(b)", "a`b`", "a!b", "a'b", "a\u0007b", ""]) {
    assert.equal(isRenderableToken(value), true, value);
    assert.equal(typeof renderPosixToken(value), "string");
  }
});


/** The scanner's authority identity keeps distinct files and POSIX case distinct. */
test("path identity preserves distinct files and POSIX case", async () => {
  const { canonicalPath, toPosixPath } = await import("./support/emitted-command-scanner.js");
  assert.equal(toPosixPath("nested\\command-text.ts"), "nested/command-text.ts");
  assert.equal(toPosixPath("nested/command-text.ts"), "nested/command-text.ts");

  // Distinct files must stay distinct: folding separators must not fold IDENTITY.
  assert.notEqual(
    canonicalPath("/repo/packages/cli/src/command-text.ts"),
    canonicalPath("/repo/packages/cli/test/fixtures/nested/command-text.ts"),
  );

  assert.notEqual(canonicalPath("/repo/Src/x.ts"), canonicalPath("/repo/src/x.ts"));
});
