// The single authority for building an emitted, runnable command string.
//
// WHY THIS MODULE EXISTS
//
// Per AXI §7/§10 the CLI emits follow-up commands that a human or agent is expected to RUN: the
// `help:` field of an error envelope, the `help[]` entries of a success receipt, and the runnable
// spans embedded in prose messages. Those strings are assembled from values the CLI does not own:
//
//   • a kind convention's `governs`, `path`, declared field names, enum values and link-type names
//     come from a Markdown file the BUNDLE AUTHOR wrote (core enforces non-emptiness, not a charset
//     — the OKF data model legitimately allows arbitrary strings there);
//   • a concept id may contain any byte that is not path traversal, so a conflicted id arriving from
//     a shared board is authored by a REMOTE PEER;
//   • `.agentstate.json`'s `bundle` binding is authored by whoever wrote the repository, not by the
//     person running the command.
//
// Interpolating such a value into a command string bare, or inside double quotes, produces a string
// whose meaning is decided by the VALUE rather than by this code the moment it is pasted into a
// shell: `$(…)`, a backtick, a backslash and a literal `"` all stay live inside `"…"`, and a literal
// `"` ends the quote outright. Double quoting is therefore not a weaker mitigation — it is not a
// mitigation, and it reads as one. That last point is the whole reason this module exists; the
// security analysis itself lives in advisory GHSA-xj7r-76cc-7fxf, not in this file.
//
// The fix is structural rather than a per-site reminder: a value only reaches a command string by
// being rendered into a {@link CommandText} token here, and `test/emitted-command-quoting.test.ts`
// fails the build for any command-shaped template literal that interpolates something else.
//
// THE PROSE / COMMAND LINE
//
// Drawn once, here, so no site re-litigates it: **quoting protects the span a reader executes, not
// the sentence around it.** A message like
//
//     unknown field(s) for kind 'Task': …  — to ADD it to the 'Task' kind: `superbee kind field …`
//
// mentions the same bundle value twice: once as English ("the 'Task' kind"), once inside a runnable
// span. Only the second is rendered. Quoting the first would make every diagnostic unreadable to buy
// nothing, because prose is not executed.
//
// That line is drawn STRUCTURALLY rather than by a per-site marker: the checker walks each template
// literal and tracks whether it is inside the span a command opened (the invocation prefix opens
// one; a backtick, newline, em dash or arrow closes it), and only interpolations inside that span —
// plus anything written in an argument position anywhere, such as `--type ${…}` — must be rendered.
// There is deliberately no "this occurrence is only prose" escape hatch to be misapplied.
//
// NEVER RE-WRAP A RENDERED TOKEN. `commandToken` quotes only what needs quoting, so a site that
// adds its own quotes around the result reads fine for an ordinary one-word value and emits
// `--text ''runs on''` — which pastes as two arguments — for an ordinary multi-word one. A sentence
// that wants to SHOW a quoted value should render with `shellArg` (always-quote) and drop its own
// quotes, which reproduces the same bytes without the collision. The quoting checker rejects a
// rendered token that is wrapped in quotes again.
//
// WINDOWS. Rendering there is a different strategy, not a variant of this one, and it lives in
// shell-quoting.ts: cmd.exe and PowerShell disagree about which quoting even exists, so a few
// values (`$`, a backtick, `!`) have no inert rendering in both and are refused. `commandToken`
// degrades those to a QUOTED `<value-omitted-unquotable>` placeholder rather than propagating the
// refusal, because the diagnostic carrying the hint is often a failing command's only output.
//
// NOT IN SCOPE: argument injection. Shell quoting makes a value ONE token; it does not stop a value
// that looks like `--dir` from being parsed as a flag by the command it is pasted into. That is a
// separate concern belonging to the emitted command's own argv shape (a `--` separator), not to the
// lexical rendering this module owns.
import { shellArg } from "./invocation.js";
import { isRenderableToken } from "./shell-quoting.js";

declare const commandTextBrand: unique symbol;
declare const commandPrefixBrand: unique symbol;

/**
 * A fragment of an emitted command that has passed through this module: either one rendered shell
 * token or a space-joined run of them. It is a `string` at runtime; the brand exists so that the
 * quoting checker can decide, by TYPE rather than by name, whether an interpolation is safe.
 */
export type CommandText = string & { readonly [commandTextBrand]: true };

/**
 * The prefix that OPENS a runnable command — `cliInvocation()` / `exactCliInvocation()`. Separate
 * from {@link CommandText} because the checker uses it to find where a runnable span begins: a
 * rendered flag value inside an ordinary sentence must not turn the rest of that sentence into a
 * command.
 */
export type CommandPrefix = CommandText & { readonly [commandPrefixBrand]: true };

/**
 * Characters that survive verbatim in every shell we emit for. Deliberately NARROWER than
 * `isSafeUnquotedHookToken`: `%` is excluded because it is cmd.exe's variable-expansion delimiter,
 * and `~` because a bare leading `~` is expanded by the shell rather than passed through.
 */
const INERT_TOKEN = /^[A-Za-z0-9_@+=:,./-]+$/;

/**
 * Emitted in place of a value the host shell cannot represent inertly at all — on Windows, one
 * carrying `$`, a backtick, `!` or a control character (see shell-quoting.ts). It reads as a
 * placeholder because that is exactly what it is: the reader must substitute the value themselves.
 * Rendering the value anyway, or letting the refusal propagate and abort a diagnostic that is often
 * the ONLY output a failing command produces, are both worse than saying so.
 *
 * It is QUOTED like any other token. Unquoted it would still carry `<` and `>`, which are
 * redirection operators in both `sh` and cmd.exe — so the degraded hint would break the surrounding
 * command's parse and, under cmd.exe, create a junk file named after the next flag.
 */
const UNRENDERABLE = "<value-omitted-unquotable>";

/**
 * Render one arbitrary value as exactly ONE shell token. Values already made of inert characters
 * pass through verbatim so ordinary help text stays readable (`doc read tasks/t1`, not
 * `doc read 'tasks/t1'`); anything else is quoted by {@link shellArg}.
 *
 * This is the ONLY sanctioned way to put a value that did not come from this invocation's argv into
 * a command string — and it is used for argv-derived values too, since a path containing a space is
 * an ordinary correctness bug in an emitted command even when nothing hostile is involved.
 *
 * An ASSEMBLED argument — one the CLI builds from several untrusted pieces, such as a
 * `<path-prefix>/<slug>` id placeholder or an `<a|b|c>` enum placeholder — is rendered here as a
 * WHOLE. Rendering the pieces and then joining them would leave the joins, and the `<`/`>`/`|`
 * scaffolding between them, outside the quotes and therefore live.
 */
export function commandToken(value: string): CommandText {
  if (INERT_TOKEN.test(value)) return value as CommandText;
  return (isRenderableToken(value) ? shellArg(value) : shellArg(UNRENDERABLE)) as CommandText;
}

/**
 * Render a SUBCOMMAND PATH — command text that is several words rather than one argument, such as
 * `bundle locate` or `doc update`. Each word is rendered separately, so an ordinary path passes
 * through unchanged while a value that somehow was not CLI-owned still cannot break out; rendering
 * the whole path as one token would instead emit `superbee 'bundle locate' --help`, which is not a
 * runnable command.
 */
export function commandWords(value: string): CommandText {
  return joinCommandTokens(value.split(" ").filter(Boolean).map(commandToken));
}

/**
 * Join already-rendered tokens into one command fragment — a repeated `--flag <value>` run, or a
 * `--dir <path>` suffix appended to several different commands.
 */
export function joinCommandTokens(tokens: readonly CommandText[], separator = " "): CommandText {
  return tokens.join(separator) as CommandText;
}

/**
 * Always-quote, with the same refusal absorption {@link commandToken} provides. For a sentence that
 * SHOWS a quoted value — `no links matched --text 'runs on'` — where dropping the quotes for an
 * inert value would read wrong and adding the sentence's own quotes around a rendered token would
 * double them.
 *
 * Use this rather than `shellArg` in any message-building path. `shellArg` THROWS for a value
 * Windows cannot render, and in a diagnostic builder that throw escapes as a bare `Error` with no
 * CLI error code — an unhandled stack trace in place of the message the user was owed.
 */
export function commandQuoted(value: string): CommandText {
  return (isRenderableToken(value) ? shellArg(value) : shellArg(UNRENDERABLE)) as CommandText;
}

/**
 * Build a command FRAGMENT from literal text plus already-rendered tokens — the ` --dir <path>`
 * suffix several commands append, and nothing more exotic. Exists so that no file outside this
 * module has any reason to write `as CommandText`: the cast is how a raw string reaches a rendering
 * position unnoticed, and a contributor copying a cast they saw locally is the likeliest way this
 * guard erodes. TypeScript rejects a raw `string` interpolation here, and the quoting checker
 * rejects the cast itself outside its two owning modules.
 */
export function commandFragment(
  strings: TemplateStringsArray,
  ...values: readonly CommandText[]
): CommandText {
  return strings.reduce((acc, part, index) => acc + part + (values[index] ?? ""), "") as CommandText;
}

/**
 * Command text the CLI ITSELF authored: a subcommand path like `hook install`, or the placeholder
 * scaffolding a reader is expected to replace (`--out (<path> | -)`). Rejects the characters that
 * could execute, and the quoting checker additionally requires the argument to be a literal at the
 * call site — so this cannot become the back door that a "trust me" marker would be.
 */
export function commandLiteral(value: string): CommandText {
  if (/[`$;&\\\n\r"']/.test(value)) {
    throw new Error(`commandLiteral received text that is not CLI-owned: ${JSON.stringify(value)}`);
  }
  return value as CommandText;
}
