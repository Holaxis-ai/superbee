/**
 * Unit coverage for the rendering authority itself, including the Windows branch, where the
 * platform-specific trade-offs live.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  commandToken, commandLiteral, commandQuoted, commandWords, commandFragment, joinCommandTokens,
} from "../src/command-text.js";
import { renderPosixToken, isRenderableToken } from "../src/shell-quoting.js";

/**
 * Run `body` with `process.platform` forced. The renderer deliberately spells a token differently
 * per platform, so a test about ONE platform's spelling must say which platform it means rather
 * than inherit the host's — otherwise it passes on POSIX and fails on Windows while the code is
 * correct.
 */
function onPlatform(platform: string, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    body();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("an inert value renders verbatim so ordinary help text is unchanged", () => {
  for (const value of ["tasks/t1", "Task", "progress_status", "a-b_c.d", "http://x/y", "50", "a@b:c,d=e+f"]) {
    assert.equal(commandToken(value), value, value);
  }
});

test("a value that is not inert is quoted as ONE token", () => {
  onPlatform("linux", () => {
    assert.equal(commandToken("Context Note"), "'Context Note'");
    assert.equal(commandToken("<todo|done>"), "'<todo|done>'");
    assert.equal(commandToken("a'b"), "'a'\\''b'");
    // `~` and `%` are excluded from the inert set deliberately: a leading `~` is expanded by the
    // shell, and `%` is cmd.exe's variable delimiter.
    assert.equal(commandToken("~/x"), "'~/x'");
    assert.equal(commandToken("50%"), "'50%'");  });

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
  onPlatform("linux", () => {
    assert.equal(commandFragment` --dir ${commandToken("/tmp/a b")}`, " --dir '/tmp/a b'");
    assert.equal(joinCommandTokens([commandToken("--x"), commandToken("y z")]), "--x 'y z'");  });

});

test("commandQuoted always quotes and absorbs a Windows refusal instead of throwing", () => {
  onPlatform("linux", () => {
    assert.equal(commandQuoted("runs on"), "'runs on'");
    // An inert value still gets quotes here — the sentence around it shows a quoted value.
    assert.equal(commandQuoted("no-such-relation"), "'no-such-relation'");
    // The point of the helper: `shellArg` THROWS for a value Windows cannot render, and in a
    // diagnostic builder that escapes as a bare Error with no CLI code. This must never throw.
    assert.doesNotThrow(() => commandQuoted("a$b"));
    assert.doesNotThrow(() => commandQuoted("a\u201db"));  });

});

test("POSIX renders every byte, so it never refuses", () => {
  for (const value of ["a$(b)", "a`b`", "a!b", "a'b", "a\u0007b", ""]) {
    assert.equal(isRenderableToken(value, "linux"), true, value);
    assert.equal(typeof renderPosixToken(value), "string");
  }
});


/**
 * The scanner decides "is this the rendering authority?" by PATH. TypeScript reports `C:/x/y.ts`
 * while `node:path` builds `C:\\x\\y.ts`, and on Windows those are the same file — so the comparison
 * is pinned here directly, under both separator conventions, rather than only through a scan. A
 * per-platform regression in this helper is invisible on POSIX and reads like a security bypass on
 * Windows, which is exactly how it presented the first time.
 */
test("path identity folds separators, and case only where the platform is case-insensitive", async () => {
  const { canonicalPath, toPosixPath } = await import("./support/emitted-command-scanner.js");
  const posix = "/repo/packages/cli/src/command-text.ts";
  const windows = "\\repo\\packages\\cli\\src\\command-text.ts";
  assert.equal(canonicalPath(posix), canonicalPath(windows.split("\\").join("/")));
  assert.equal(toPosixPath("nested\\command-text.ts"), "nested/command-text.ts");
  assert.equal(toPosixPath("nested/command-text.ts"), "nested/command-text.ts");

  // Distinct files must stay distinct: folding separators must not fold IDENTITY.
  assert.notEqual(
    canonicalPath("/repo/packages/cli/src/command-text.ts"),
    canonicalPath("/repo/packages/cli/test/fixtures/nested/command-text.ts"),
  );

  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    // Windows is case-insensitive, so a drive-letter or segment casing difference is the same file.
    assert.equal(canonicalPath("C:/Repo/Src/Command-Text.ts"), canonicalPath("c:/repo/src/command-text.ts"));
    Object.defineProperty(process, "platform", { ...original, value: "linux" });
    // POSIX is case-SENSITIVE; folding case there would wrongly merge two different files.
    assert.notEqual(canonicalPath("/repo/Src/x.ts"), canonicalPath("/repo/src/x.ts"));
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});
