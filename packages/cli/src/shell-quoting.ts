// How ONE value is written so a host shell delivers it as exactly one argument.
//
// Split out of invocation.ts and command-text.ts because both need it and neither should own it,
// and split away from `renderGeneratedHookToken` (hook-compatibility.ts) because that function
// answers a DIFFERENT question. Its grammar describes the tokens the SessionStart hook writer
// emits — CLI-resolved executable paths, which it may legitimately normalize AS paths — and it is
// paired with a recognizer that has to read those tokens back. Emitted commands carry arbitrary
// bundle-authored values instead, so borrowing that grammar stretched it past its contract: it
// refused a plain `%` (routine in a percent-encoded URL) and rewrote backslashes, silently turning
// a kind named `Task\Sub` into `Task/Sub`. Neither behavior is wrong for a hook token; both are
// wrong for a value being rendered back to a reader.

/**
 * SCOPE OF THIS MODULE'S CONTRACT: a token is rendered for the PLATFORM, and is inert in that
 * platform's NATIVE shell family — sh and its relatives on POSIX; cmd.exe and PowerShell on
 * Windows. It is not inert in every shell that can merely be installed on that platform.
 * PowerShell also runs on POSIX hosts and does not implement the POSIX `'\''` escape — it escapes
 * a quote by DOUBLING it and treats `\` literally — so a POSIX-rendered token whose value
 * contains a quote does not survive PowerShell. `emitted-command-contract.test.ts` pins that
 * boundary in both directions rather than leaving it implied.
 */

/**
 * POSIX: single quotes make every byte literal, and `'\''` closes, escapes, and reopens. Total —
 * every possible value has a representation, so this never fails.
 */
export function renderPosixToken(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Characters that can TERMINATE a double-quoted string, which is the only quoting form the Windows
 * renderer emits.
 *
 * PowerShell's tokenizer does not treat U+0022 as the only double quote: `CharTraits.IsDoubleQuote`
 * also accepts `“` U+201C, `”` U+201D and `„` U+201E, and `ScanStringLiteral` closes at the FIRST
 * character satisfying that predicate without requiring it to match the opening one. So a
 * typographic quote inside an emitted `"…"` ends the string and the remainder is parsed as
 * PowerShell. This list is a deliberate SUPERSET of that table — the other double-quote-shaped code
 * points are included because the table is a moving target across versions and we cannot exercise a
 * PowerShell host from these lanes.
 *
 * The APOSTROPHE family is deliberately absent, and that is a structural claim rather than a
 * judgement call: a single-quote character cannot close a double-quoted string in either PowerShell
 * or cmd.exe, so refusing it would buy nothing while costing ordinary text — apostrophes occur in
 * everyday kind, field and link names. `\p{Quotation_Mark}` is therefore too wide a class to use
 * here: it sweeps the apostrophes in with the double quotes.
 *
 * U+0022 itself is REFUSED rather than escaped by doubling. `""` doubling is a cmd.exe/CRT
 * convention whose PowerShell equivalence is untested here, and a plain `"` is illegal in Windows
 * filenames and paths and invalid unescaped in a URL, so refusing it costs almost nothing. It also
 * means no quote can appear inside the rendered value, which removes the backslash-before-quote
 * corner where the CRT parser and PowerShell resolve the same bytes differently.
 */
const DOUBLE_QUOTE_LIKE =
  /["\u201c\u201d\u201e\u201f\u2033\u2036\u275d\u275e\u301d\u301e\u301f\uff02]/u;

/**
 * Characters a shell reads as an escape or an expansion sigil INSIDE double quotes — the only
 * quoting form the Windows renderer emits, so none of these can be neutralized by quoting.
 *
 * `$` covers PowerShell's `$var` and `$(…)`, which EXECUTES; the backtick is PowerShell's escape
 * character; `!` is cmd.exe delayed expansion; U+FF40 is the fullwidth grave, included for the same
 * defensive reason as the double-quote superset above.
 *
 * `%` is REFUSED. cmd.exe performs variable expansion inside double quotes, so a value containing
 * `%` cannot be rendered inert on Windows by any quoting this function can emit.
 *
 * Do not relax this without reading GHSA-xj7r-76cc-7fxf first. The case for allowing `%` is easy to
 * reconstruct and sounds reasonable — it cannot EXECUTE, and refusing it costs percent-bearing
 * values their rendering — and it is wrong for a reason worth stating here: this function's
 * contract is that what it returns is INERT, and it signals "no inert form exists" by returning
 * undefined. Returning a token the shell will still expand makes that contract false on one
 * platform, silently and in one direction — POSIX single-quoting neutralizes `$VAR`, Windows
 * double-quoting does not neutralize the `%` form. The brand and the quoting checker both rest on
 * "a rendered token is inert", so either the contract holds or neither of them means anything.
 *
 * Refusing only SOME percents would depend on cmd.exe's exact expansion behaviour across
 * interactive, batch and delayed-expansion contexts, which these lanes cannot exercise. Refusing
 * every `%` is total and testable; the cost is a VISIBLE placeholder on Windows.
 */
const EXPANSION_LIKE = /[$`!%\uff40]/u;

/** Control characters have no printable command-text representation at all. */
const UNPRINTABLE = /[\u0000-\u001f\u007f]/u;

/**
 * Windows: returns `undefined` when the value has NO safe rendering, which is a real category here
 * rather than a hedge. A Windows reader may paste into cmd.exe or into PowerShell, and the two
 * disagree about nearly everything:
 *
 *   • `'…'` is fully literal in PowerShell and is not quoting at all in cmd.exe, so the POSIX
 *     strategy above cannot simply be reused;
 *   • inside `"…"`, PowerShell still expands `$(…)` — which EXECUTES — and still honors a backtick
 *     escape, while cmd.exe still expands `%NAME%` and, with delayed expansion enabled, `!NAME!`.
 *
 * So a value carrying anything in {@link DOUBLE_QUOTE_LIKE} or {@link EXPANSION_LIKE} has no form
 * that is inert in both shells. Those are refused and the caller decides how to degrade.
 *
 * `%` is refused for the reason given on {@link EXPANSION_LIKE}: cmd.exe expands variables inside
 * double quotes, so allowing it would make this function return a token that is not inert while
 * claiming to be one.
 */
export function renderWindowsToken(value: string): string | undefined {
  if (UNPRINTABLE.test(value) || DOUBLE_QUOTE_LIKE.test(value) || EXPANSION_LIKE.test(value)) {
    return undefined;
  }
  // A run of backslashes immediately before the closing quote would otherwise be read as escaping
  // it. Doubling that run is the CRT argument rule (mirrors host-command.ts:174). It is knowingly
  // asymmetric: PowerShell delivers the doubled run literally, so a value ending in a backslash
  // arrives with one extra. Inert either way; recorded as a known fidelity divergence.
  return `"${value.replace(/(\\+)$/, "$1$1")}"`;
}

/** Whether `platform` can render `value` as one inert argument at all. */
export function isRenderableToken(value: string, platform: string = process.platform): boolean {
  return platform !== "win32" || renderWindowsToken(value) !== undefined;
}

/** Quote `value` as one argument for `platform`, or throw when it has no safe rendering. */
export function renderShellToken(value: string, platform: string = process.platform): string {
  if (platform !== "win32") return renderPosixToken(value);
  const rendered = renderWindowsToken(value);
  if (rendered === undefined) {
    throw new Error("value has no inert single-argument rendering for the Windows command shells");
  }
  return rendered;
}
