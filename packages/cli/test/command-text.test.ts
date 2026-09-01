/**
 * Unit coverage for the rendering authority itself, including the Windows branch, where the
 * platform-specific trade-offs live.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  commandToken, commandLiteral, commandQuoted, commandWords, commandFragment, joinCommandTokens,
} from "../src/command-text.js";
import { renderPosixToken, renderWindowsToken, isRenderableToken } from "../src/shell-quoting.js";

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

/**
 * Windows renders through a different strategy, because cmd.exe and PowerShell disagree: `'…'` is
 * literal in PowerShell and not quoting at all in cmd.exe, and inside `"…"` PowerShell still
 * EXECUTES `$(…)`. So `$`, a backtick and `!` are refused rather than mis-rendered.
 */
test("the Windows renderer quotes what it can and refuses only what no shell can hold inertly", () => {
  assert.equal(renderWindowsToken("Context Note"), '"Context Note"');
  // Regression guard: the hook-token grammar rewrote backslashes as path separators, silently
  // turning a kind named `Task\Sub` into a different, plausible-looking value.
  assert.equal(renderWindowsToken("Task\\Sub"), '"Task\\Sub"');
  // A trailing backslash run would otherwise escape the closing quote.
  assert.equal(renderWindowsToken("C:\\dir\\"), '"C:\\dir\\\\"');
  for (const refused of ["a$(b)", "a`b`", "a!b", "a\u0007b", "a%b"]) {
    assert.equal(renderWindowsToken(refused), undefined, refused);
    assert.equal(isRenderableToken(refused, "win32"), false, refused);
  }
});

/**
 * PowerShell's tokenizer closes a double-quoted string at the FIRST character its double-quote
 * predicate accepts, and that predicate accepts typographic quotes — so a value carrying one would
 * escape the emitted `"…"` and the remainder would parse as PowerShell. We cannot exercise a
 * PowerShell host from these lanes, so the refusal class is defined by Unicode property and is
 * deliberately wider than the code points any one implementation is known to accept.
 */
test("the Windows renderer refuses what can CLOSE a double-quoted string, and permits apostrophes", () => {
  // The APOSTROPHE family is permitted: a single-quote character cannot close a double-quoted
  // string in PowerShell or cmd.exe, so refusing it bought nothing and cost ordinary text.
  for (const permitted of ["Owner's Guide", "don't-repeat", "L'\u00c9toile", "a\u2019b", "a\u2032b", "a\u00abb\u00bb"]) {
    assert.notEqual(renderWindowsToken(permitted), undefined, `must render: ${permitted}`);
    assert.equal(isRenderableToken(permitted, "win32"), true, permitted);
  }

  const quoteLike = [
    '"',            // U+0022 — refused, not escaped: `""` doubling is a cmd.exe/CRT convention
    "\u201c", "\u201d", "\u201e",   // the family PowerShell's IsDoubleQuote accepts
    "\u201f", "\u2033", "\u2036",   // double-quote-shaped forms beyond that table
    "\u275d", "\u275e",             // ornamental DOUBLE quotes
    "\u301d", "\u301e", "\u301f",   // CJK double quotes
    "\uff02",                       // fullwidth quotation mark
    "\uff40",                       // fullwidth grave, alongside the ASCII backtick
  ];
  for (const character of quoteLike) {
    const value = `a${character}b`;
    assert.equal(renderWindowsToken(value), undefined, `U+${character.codePointAt(0)!.toString(16)}`);
    assert.equal(isRenderableToken(value, "win32"), false, value);
  }
  // POSIX is unaffected either way: only U+0027 quotes there, and it is escaped, not refused.
  assert.equal(renderPosixToken("a\u201db"), "'a\u201db'");
  assert.equal(isRenderableToken("a\u201db", "linux"), true);
});

test("refusing the quote family removes the backslash-before-quote corner entirely", () => {
  // The CRT argv parser and PowerShell resolve `\"` inside a quoted run differently. With no quote
  // able to survive into the value, that divergence cannot arise.
  assert.equal(renderWindowsToken('a\\"b'), undefined);
  // A TRAILING backslash run is still doubled for the CRT rule. Knowingly asymmetric: PowerShell
  // delivers the doubled run literally, so the value arrives with one extra backslash. Inert both
  // ways; recorded as a fidelity divergence rather than fixed.
  assert.equal(renderWindowsToken("C:\\dir\\"), '"C:\\dir\\\\"');
  assert.equal(renderWindowsToken("C:\\dir\\sub"), '"C:\\dir\\sub"');
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

test("a value Windows cannot render degrades to a QUOTED placeholder, never a bare one", () => {
  // Bare, the placeholder still carries `<` and `>`, which redirect in both sh and cmd.exe — so a
  // degraded hint would break the surrounding command's parse and create a junk file.
  const posix = renderPosixToken("<value-omitted-unquotable>");
  assert.equal(posix, "'<value-omitted-unquotable>'");
  const windows = renderWindowsToken("<value-omitted-unquotable>");
  assert.equal(windows, '"<value-omitted-unquotable>"');
});

test("POSIX renders every byte, so it never refuses", () => {
  for (const value of ["a$(b)", "a`b`", "a!b", "a'b", "a\u0007b", ""]) {
    assert.equal(isRenderableToken(value, "linux"), true, value);
    assert.equal(typeof renderPosixToken(value), "string");
  }
});

/**
 * cmd.exe performs variable expansion INSIDE double quotes, so a rendered token containing `%`
 * would not be inert — the single property this renderer exists to guarantee. Allowing `%` to keep
 * percent-bearing values readable would trade a silent, one-directional weakening of the contract
 * for an ergonomic win. POSIX single-quoting neutralizes `$VAR`; Windows double-quoting does not
 * neutralize the `%` form, so allowing it would make the two platforms' guarantees differ in
 * silence. See GHSA-xj7r-76cc-7fxf.
 *
 * Fixture names below are synthetic on purpose (`SUPERBEE_PROBE_*`): a real variable name would
 * turn this file into a worked example, and it proves nothing that a synthetic one does not.
 */
test("Windows refuses every percent sign, so no emitted token can be expanded by cmd.exe", () => {
  // A whole reference, and one embedded mid-value.
  assert.equal(renderWindowsToken("%SUPERBEE_PROBE_VAR%"), undefined);
  assert.equal(renderWindowsToken("a%SUPERBEE_PROBE_VAR%b"), undefined);
  // A lone percent is refused too. Deciding which percents are "safe" would depend on cmd.exe's
  // expansion behaviour across interactive, batch and delayed-expansion contexts — untestable here.
  assert.equal(renderWindowsToken("50%"), undefined);
  assert.equal(renderWindowsToken("http://example.com/a%20b"), undefined);
  assert.equal(isRenderableToken("http://example.com/a%20b", "win32"), false);

  // POSIX is unaffected: `%` is not special to any POSIX shell, and single quoting is literal.
  assert.equal(renderPosixToken("http://example.com/a%20b"), "'http://example.com/a%20b'");
  assert.equal(isRenderableToken("%SUPERBEE_PROBE_VAR%", "linux"), true);
});

test("a refused percent value degrades VISIBLY, never to something that reads like the value", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try {
    const rendered = commandToken("http://example.com/a%20b");
    // The reader must be able to SEE that something was withheld — the cost of refusing `%` is a
    // visible placeholder, not a silently altered or truncated value.
    assert.match(rendered, /<value-omitted-unquotable>/);
    assert.ok(!rendered.includes("%20"), `the value must not survive: ${rendered}`);
    assert.ok(!rendered.includes("example.com"), `no partial value may leak through: ${rendered}`);
    // Still exactly one quoted argument, so the surrounding command still parses.
    assert.equal(rendered, '"<value-omitted-unquotable>"');
    // The apostrophe cases stay green on the same platform.
    assert.equal(commandToken("Owner's Guide"), `"Owner's Guide"`);
    assert.equal(commandToken("don't-repeat"), `"don't-repeat"`);
  } finally {
    Object.defineProperty(process, "platform", original);
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
