// Shared surface for the `doc` verb modules (write/update/read/history/delete): the help text, the
// deps interface, the stdin-detection helper, and the error-classification helper used by ≥2 verbs.
// Verb modules import from HERE, never from `../doc.js` (the thin entry re-exports FROM here, and a
// verb importing back from the entry would create a circular import).
import { fstatSync } from "node:fs";
import { CliError, classifyBundleError } from "../../errors.js";
import { cliInvocation } from "../../invocation.js";

/** The common flags every `doc` verb accepts — appended to each verb's focused help (§10). */
const COMMON_OPTIONS = `Common options:
  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Talk to a wire-protocol server instead of a local bundle
                       (mutually exclusive with --dir; remote access is always explicit)
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help`;

/**
 * The FAMILY INDEX — printed only for a bare `doc`/`doc --help`. Each verb has its OWN focused help
 * (below), so a `doc read --help` no longer dumps the write/update/delete manual too (AXI §10).
 */
export const DOC_USAGE = `superbee doc — write, patch, read, present, or delete a generic OKF concept document

Usage:
  superbee doc write   <id> --type <t> [options]        Create/overwrite a concept doc
  superbee doc update  <id> [options]                   Patch given fields of an existing doc
  superbee doc read    <id> [--out <p> | --body-out <p> | --rendered-out <p>] Read/export a doc
  superbee doc open    <id>                             Open the rendered doc in a browser
  superbee doc history <id>                             Show a doc's attributed version chain
  superbee doc delete  <id> [--expected-version <v>]    Hard-delete a doc (idempotent)

Authoring paths:
  superbee doc write <id> --type <Type> ...             Generic document creation or full replacement
  superbee new "<Kind>" <id> --<field> <value> ...      Governed, strict, create-only authoring

Examples:
  superbee doc write notes/idea --type Note --title "Idea" --body "Capture this."
  superbee new "Task" clarify-authoring --title "Clarify authoring" --progress_status todo

Run 'superbee doc <verb> --help' for a verb's full options.

${COMMON_OPTIONS}
`;

export const DOC_OPEN_USAGE = `superbee doc open — display one exact bundle document in the browser

Usage:
  superbee doc open <id> [options]

The command verifies the document exists and opens its trusted DocPage route in the existing local web UI.
It uses the same bounded Markdown renderer as the rest of Superbee; it does not export
a second HTML copy or introduce another rendering path. Local launches return promptly and reuse one
managed UI per exact bundle + actor. Explicit remote launches stay in the foreground. Use
'superbee ui --status' or 'superbee ui --stop' to inspect or stop a managed local UI.

Options:
  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Display a document from an explicit remote bundle
                       (mutually exclusive with --dir; remote access is always explicit)
  --port <p>           Require this port for a new managed UI (default: OS-assigned and then reused)
  --actor <name>       Advisory identity for any later human-confirmed View actions in this UI
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help

Examples:
  superbee doc open docs/core
  superbee doc open tasks/42 --dir .superbee
`;

export const DOC_WRITE_USAGE = `superbee doc write — create or overwrite a generic OKF concept document

Usage:
  superbee doc write <id> --type <t> [--title <t>] [--body <s> | --body-file <p>] [options]

Idempotent: re-writing a doc with identical frontmatter + body is a no-op (exit 0, no error, no
duplication — a plain overwrite that converges to the same on-disk state).

If a declared Kind governs the document type, prefer 'superbee new "<Kind>" <id> ...'; its
authoring is strict and create-only. Use 'doc write' for a generic type or a deliberate full
replacement.

Options:
  --type <t>           OKF concept type (non-empty)                          [required]
  --title <t>          Display title
  --description <d>    One-sentence summary
  --resource <uri>     Canonical URI of the underlying asset
  --tag <t>            A tag (repeatable)
  --timestamp <iso>    Explicit legacy-compatible ISO-8601 last-change time. Current bundles use
                       their standard generated.at clock automatically.
  --body <s>           Markdown body inline
  --body-file <path>   Read the markdown body from a file (else: piped stdin)
  --blank-body         Required to deliberately overwrite an EXISTING doc's non-empty body with an
                       empty one when no other body source is given. --body (even --body "") and
                       --body-file always count as an explicit source; piped stdin counts ONLY when
                       it carries NON-EMPTY content — an empty pipe, a character device, or an
                       interactive TTY all count as "nothing given" here (pass --body "" to blank
                       explicitly instead). A NEW doc with no body source is always allowed — see
                       'doc update' to patch other fields while preserving the body.
  --replace-links      Required to overwrite an EXISTING doc's body when the new body would silently
                       DROP one or more of its outbound cross-links (links live in the body — OKF).
                       Without it, a body replace that drops a link is refused (exit 2, naming the
                       dropped link(s)); a new body that still contains the same link(s) never needs
                       this flag. SHORT-TERM guard — see 'link add'/'link show' to manage links.
  --accept-truncated-body
                       Required to overwrite an EXISTING doc's body with a TRUNCATED 'doc read' body
                       preview — one still carrying the truncated-preview marker, or one that is
                       exactly the preview slice of this doc's own longer stored body. Without it
                       such a write is refused (exit 2) and nothing is written; read the complete
                       body with 'doc read <id> --body-out <path>' instead.
  --strict             If a kind convention governs --type, reject (exit 2) instead of writing with
                       warnings when the doc does not satisfy it (default: warn-and-write, exit 0 —
                       see 'superbee kinds')
  --actor <name>       Attribute this write using the bundle's compatible advisory field, used by
                       per-doc sync receipts and version history for a persisting backend. Note doc
                       write is a FULL replace:
                       omitting both --actor and the supported actor environment variables on an
                       overwrite drops any existing attribution field (reported in dropped_fields). Precedence:
                       --actor > SUPERBEE_ACTOR > legacy AGENTSTATE_LITE_ACTOR > absent. A
                       present-but-blank flag or environment value is a USAGE error (exit 2).
${COMMON_OPTIONS}

Examples:
  superbee doc write concepts/auth --type Concept --title "Auth flow" --body "How login works"
  echo "# Notes" | superbee doc write notes/x --type Note --title "Scratch"
`;

export const DOC_UPDATE_USAGE = `superbee doc update — patch given fields of an EXISTING concept document

Usage:
  superbee doc update <id> [--<field> <value> ...] [--body <s> | --body-file <p>] [options]

Only the fields you pass change; everything else — including the body when no body source is given —
is preserved verbatim. Idempotent: a patch that changes NOTHING (ignoring the auto-refreshed
timestamp) converges to changed:false (no write, no timestamp refresh).

Options:
  --title <t>            Replace the title
  --description <d>      Replace the description
  --tag <t>              Replace the WHOLE tag set (repeatable; passing --tag at all replaces every
                         existing tag rather than adding to them). It cannot CLEAR the set to empty.
  --type <t>             Replace the type
  --body <s>             Replace the body inline
  --body-file <path>     Replace the body, read from a file. If NEITHER --body nor --body-file is
                         given AND no other field flag is given either (e.g. 'cat body.md | ...
                         doc update <id>' with nothing else), piped stdin is used as the body — same
                         non-empty rule doc write's F1 guard uses (an empty pipe does not count). A
                         patch that DOES pass another field flag (--title/--description/--tag/--type/
                         a kind field) never reads stdin, even without --body/--body-file: it patches
                         only the given fields and leaves the body untouched.
  --replace-links         Required when a --body/--body-file replace would silently DROP one or more
                         of the doc's existing outbound cross-links (links live in the body — OKF).
                         Without it, such a replace is refused (exit 2, naming the dropped link(s));
                         a new body that still contains the same link(s) — the ordinary read-edit-
                         update cycle — never needs this flag. SHORT-TERM guard — see 'link add'/
                         'link show' to manage links.
  --accept-truncated-body
                         Required when a --body/--body-file/stdin replace would write a TRUNCATED
                         'doc read' body preview — one still carrying the truncated-preview marker,
                         or one that is exactly the preview slice of this doc's own longer stored
                         body. Without it such a replace is refused (exit 2) and nothing is written.
                         A preview is not a body: read the complete one with 'doc read <id>
                         --body-out <path>', edit that file, then pass it back with --body-file.
  --keep-timestamp       Preserve an existing legacy compatibility timestamp. Current bundles use
                         their standard generated.at clock automatically.
  --strict               If a kind convention governs the resulting type, reject (exit 2) instead of
                         writing with warnings (default: warn-and-write, exit 0)
  --<field> <value>      Set a kind-declared field of the doc's type (e.g. --progress_status done).
                         The field
                         MUST be declared by the kind governing the doc's type — run 'superbee
                         kinds' to see them. An unknown field, or an out-of-enum value, is rejected
                         (exit 2, no write). Use 'doc write' to rewrite the whole doc if you must set
                         a not-yet-declared value.
  --expected-version <v> Optimistic compare-and-swap: patch ONLY if the doc still matches this token
                         (from a prior read/write/history receipt) — a conflict is STALE_HEAD (exit
                         5), NOT retried. Omit for a normal (auto-retrying) update. A present-but-
                         blank value is a USAGE error (exit 2), not "no CAS".
  --actor <name>         Attribute a substantive patch using the bundle's compatible advisory field
                         and thread it to version history (see 'doc history'). Precedence: --actor >
                         SUPERBEE_ACTOR > legacy AGENTSTATE_LITE_ACTOR > absent. Without a source,
                         Superbee applies the bundle's compatibility policy. An identical no-op
                         preserves exact bytes. Attribution is
                         not a patch by itself and cannot turn an identical patch into a write. A
                         present-but-blank flag or environment value is a USAGE error (exit 2).

Passing NO patchable field at all is a USAGE error (exit 2) — there is nothing to do.
${COMMON_OPTIONS}

Examples:
  superbee doc update tasks/42 --progress_status done
  superbee doc update concepts/auth --title "Auth v2" --expected-version sha256:...
`;

export const DOC_READ_USAGE = `superbee doc read — read a concept document (or pull its raw markdown bytes)

Usage:
  superbee doc read <id> [--out (<path> | -) | --body-out (<path> | -) | --rendered-out (<path> | -)] [options]

The default (no byte-channel flag) render shows EVERY frontmatter field — the standard keys plus any
kind-declared fields like progress_status/priority — and truncates a large body (pointing at --out).
A truncated body is published as 'body_preview' (never 'body'), with body_truncated:true, the true
body_chars, and a marker inside the value itself. That value is a PREVIEW, not a body: writing it
back through 'doc write'/'doc update' is refused (exit 2) unless --accept-truncated-body is passed.
Use --body-out to get the complete body for an edit cycle.

Options:
  --out <path>         Write the doc's raw markdown bytes to a file (bypasses context).
                       Use --out - to stream raw bytes to stdout (the receipt goes to stderr).
                       Over --remote, bytes are the canonical OKF re-serialization (no raw-bytes
                       wire endpoint yet — see docs/WIRE-PROTOCOL.md open questions).
                       For a local (--dir) bundle, a resolved --out path landing INSIDE the bundle
                       root gets a loud 'warning' field on the receipt: a non-reserved .md path
                       will be re-ingested as a concept doc on the next bundle walk; a reserved
                       filename (index.md/log.md) will instead CLOBBER that file outright; any
                       other (non-.md) path is inert (no warning) — the write still proceeds in
                       every case; not applicable to --out - or to --remote.
  --body-out <path>    Write ONLY the parsed markdown body (no YAML frontmatter) as UTF-8. The
                       receipt includes the version from the SAME read, so the safe edit cycle is:
                         superbee doc read <id> --body-out <path-outside-bundle> --json
                         # edit that file; copy the receipt's version
                         superbee doc update <id> --body-file <path-outside-bundle> \\
                           --expected-version <version>
                       Choose a unique path OUTSIDE the bundle: a .md target inside a local bundle
                       is refused below, so the safe-cycle path must never be bundle-relative.
                       Use --body-out - to stream body bytes to stdout (receipt/errors go to stderr).
                       An empty body is a valid zero-byte result. A .md target inside a local bundle
                       is refused: body-only markdown has no OKF frontmatter and would corrupt or
                       clobber bundle content. Choose a path outside the bundle (an in-bundle non-.md
                       target is inert and remains allowed).
  --rendered-out <path>
                       Write the parsed body as bounded, inert HTML produced by Superbee's shared
                       Markdown renderer. This is the canonical presentation byte channel for
                       static publishers and other trusted shells; it does not include frontmatter
                       chrome or executable scripts. Internal concept links carry only normalized
                       data-aslite-doc-id targets for the consuming shell to navigate. Use
                       --rendered-out - to stream HTML bytes to stdout (receipt/errors go to stderr).
                       The renderer is BOUNDED: a body past its character/node limits renders
                       TRUNCATED, and the receipt then reports bounded:true plus a warning naming
                       the enforced limits — a truncated page is lossy egress, so treat bounded:true
                       as "incomplete" and use --out for the complete raw markdown. Like --body-out,
                       a local in-bundle .md target is refused: rendered HTML has no OKF frontmatter
                       and would corrupt or clobber bundle content (an in-bundle non-.md target is
                       inert and remains allowed).
  --field <name>       Print ONE frontmatter field's raw value to stdout, newline-terminated, no
                       TOON envelope and no other output — for scripting, e.g. capturing
                       head_version for a follow-up --expected-version write. A scalar prints
                       as-is (no quotes); an array/object prints as compact JSON. id/type/
                       head_version work too (head_version is the store's CAS token, not
                       frontmatter). An absent field, or a missing doc, reports the error to
                       STDERR instead (stdout stays reserved for the raw value); an absent field's
                       error lists the fields that DO exist. Mutually exclusive with --out,
                       --body-out, and --rendered-out.
${COMMON_OPTIONS}

Examples:
  superbee doc read concepts/auth
  superbee doc read concepts/auth --out ./auth.md
  superbee doc read concepts/auth --body-out <path-outside-bundle>
  superbee doc read concepts/auth --rendered-out ./auth.html
  superbee doc read concepts/auth --field head_version
`;

export const DOC_HISTORY_USAGE = `superbee doc history — show a doc's attributed version chain (newest first)

Usage:
  superbee doc history <id> [--limit <n>] [options]

Lists version + actor + timestamp (and agent, when recorded) per revision, with a count. A
history-keeping backend (a remote deployment) returns the full chain and its real per-write
attribution; on an AUTH'D remote, actor is your authenticated principal (server-set, unforgeable)
and agent is the resolved advisory actor label from --actor, SUPERBEE_ACTOR, or legacy
AGENTSTATE_LITE_ACTOR. A local --dir bundle keeps no history, so it returns just the single current
revision. Its actor is resolved from the doc's compatible advisory attribution, falling back to
the local user identity when none is present. The newest version is the token to
pass to --expected-version for an optimistic doc update/delete.

Options:
  --limit <n>           Cap the number of revisions returned, newest first (default: 20; 0 =
                        unlimited). A truncated result reports \`shown\` alongside the total
                        \`count\`, and a help line names the escape (a higher --limit, or 0 for
                        all). The newest revision is always included when truncated (it never
                        gets cut off the front).
${COMMON_OPTIONS}

Examples:
  superbee doc history concepts/auth
  superbee doc history concepts/auth --limit 0
`;

export const DOC_DELETE_USAGE = `superbee doc delete — hard-delete a concept document (idempotent)

Usage:
  superbee doc delete <id> [--expected-version <v>] [options]

Hard-delete (no tombstone) and idempotent: deleting an ABSENT id is SUCCESS (deleted:false, exit 0),
never an error. Reserved ids (index.md/log.md) are rejected (USAGE, exit 2). Non-cascading: it does
NOT touch other docs' links to/from the id (backlinks are derived — a dangling reference simply
stops resolving on the next graph walk) and does NOT append a log.md entry.

Options:
  --expected-version <v>  Compare-and-swap token from a prior read/write receipt (a stale token is a
                          CONFLICT, exit 5; omit for an unconditional delete)
${COMMON_OPTIONS}

Examples:
  superbee doc delete notes/scratch
  superbee doc delete concepts/auth --expected-version sha256:...
`;

export interface DocCliDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  writeStdoutBytes: (data: Uint8Array) => void;
  /**
   * The opportunistic board-freshness trigger `doc read` (the READ verb only — never the
   * mutations) runs before serving a LOCAL read (default: autopull.ts's `maybeAutoPull`).
   */
  autoPull?: (dir?: string) => Promise<unknown>;
  /**
   * Resolves to the piped stdin content, or `undefined` when there is no real stdin data source at
   * all. The default impl (`defaultReadStdin`) fstats fd 0 and only reads when it is a FIFO, a
   * regular file, or a connected socket — an interactive TTY, a character device (notably an agent
   * harness's redirected-but-dataless stdin, which reports `isTTY === undefined`, not `true`), or an
   * fstat error all resolve to `undefined` without reading. A REAL source that stays silent past
   * `STDIN_FIRST_BYTE_TIMEOUT_MS` resolves the `STDIN_SILENT_TIMEOUT` sentinel — same "nothing
   * given" semantics as `undefined`, but distinguishable so the verb can surface
   * `STDIN_SILENT_NOTE` on its receipt/error. The F1 body-source guard below
   * additionally treats an EMPTY resolved string the SAME as `undefined`: only a NON-EMPTY piped body
   * counts as "a body source was given" via this channel — `--body ""` is the one unambiguous
   * explicit-empty channel.
   */
  readStdin: () => Promise<StdinReadResult>;
}

/**
 * True when fd 0 (stdin) is a real data source — a FIFO (a shell pipe), a regular file (input
 * redirection, `< file`), or a connected socket — as opposed to an interactive TTY, a character
 * device (e.g. `/dev/null`, or the redirected-but-dataless stdin many agent harnesses hand a spawned
 * process), or an fd that can't be fstat'd at all. `process.stdin.isTTY` alone is not sufficient:
 * agent harnesses commonly supply a character device with `isTTY === undefined`, which otherwise
 * looks like an empty pipe and bypasses the empty-body guard.
 *
 * `isSocket()` is included alongside `isFIFO()`/`isFile()` for a platform-specific reason found while
 * building this fix's own integration test: on macOS (unlike Linux), libuv implements Node's
 * `child_process` "pipe" stdio via an `AF_UNIX` socketpair, not a POSIX FIFO — so a Node-based agent
 * harness piping a REAL body into a spawned `superbee` (`spawn(cli, { stdio: ["pipe", …] })`,
 * exactly the mechanism many such harnesses use) hands this process a stdin that `fstat`s as a
 * socket, not a FIFO. Excluding sockets would silently defeat legitimate piped input for that entire
 * class of caller — reopening a DIFFERENT variant of the very bug this fix exists to close. A
 * character device (the actual false-positive this fix targets) is a distinct fstat file type from a
 * socket, so this addition does not reopen the original gap.
 */
function hasRealStdinInput(): boolean {
  try {
    const stats = fstatSync(0);
    if (stats.isFIFO() || stats.isFile() || stats.isSocket()) return true;
    // libuv does not classify an anonymous child-process pipe as a FIFO or socket on Windows.
    // It is still a real byte source. NUL and other redirected-but-dataless handles remain
    // character devices, so retain the original false-positive guard there.
    return process.platform === "win32" && !stats.isCharacterDevice() && !stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * How long {@link defaultReadStdin} waits for the FIRST byte before concluding "nothing given" (see
 * that function's doc comment for the full rationale). Exported so a test can assert on the exact
 * bound rather than a magic number duplicated at the call site.
 */
export const STDIN_FIRST_BYTE_TIMEOUT_MS = 200;

/**
 * Sentinel resolved by {@link defaultReadStdin} when fd 0 IS a real data source (an open
 * pipe/socket/file) but stayed SILENT past {@link STDIN_FIRST_BYTE_TIMEOUT_MS}. Consumers treat it
 * exactly like `undefined` ("nothing given") for the body-source decision, but it additionally lets
 * the verb surface {@link STDIN_SILENT_NOTE} — without it, a NEW doc created with an empty body
 * while a slow producer's bytes arrive too late would be indistinguishable from a deliberate
 * body-less write, a residual silent case. A distinct sentinel (not a boolean side channel) keeps
 * the signal in the ONE owning primitive's return value, so `doc write` and `doc update` both
 * receive it with no extra plumbing.
 */
export const STDIN_SILENT_TIMEOUT: unique symbol = Symbol("superbee.stdin-silent-timeout");

/** What a {@link DocCliDeps.readStdin} adapter can resolve — see each member's meaning on `readStdin`'s doc comment. */
export type StdinReadResult = string | undefined | typeof STDIN_SILENT_TIMEOUT;

/** The receipt/error `note` a verb attaches when its stdin probe hit the silent-pipe timeout. */
export const STDIN_SILENT_NOTE =
  `stdin was open but silent after ${STDIN_FIRST_BYTE_TIMEOUT_MS}ms — body treated as empty; ` +
  `use --body/--body-file for slow producers`;

/**
 * Read `stream` to EOF, but bound the wait for the FIRST byte to `timeoutMs`: no data at all within
 * that window resolves {@link STDIN_SILENT_TIMEOUT} (treated as "nothing given", but distinguishable
 * so the caller can surface {@link STDIN_SILENT_NOTE}) instead of blocking forever. This is
 * the fix for `tasks/doc-write-stdin-open-pipe-hang`: `hasRealStdinInput()` correctly identifies an
 * OPEN pipe/socket as a real data source, but an agent harness (or a Node `child_process` "pipe"
 * stdio whose parent never writes and never calls `.end()`) can hand this process exactly such an fd
 * with NOTHING ever sent and NO close — reading it to EOF unconditionally then blocks forever, the
 * worst AXI failure class (a silent, unpriceable hang). Once ANY byte has arrived, the bound is
 * permanently off: `clearTimeout` fires on the first `data` event, so a real piped body that starts
 * slowly (a chunked network relay, a large file) is still read to completion with no further
 * timeout — only the "is there anything here at all" question is time-boxed, never an in-progress
 * transfer. On timeout, the stream is EXPLICITLY paused and released (`pause()` + `unref()`; see the
 * inline comment below) — this CLI sets only `process.exitCode` and never calls `process.exit()`
 * (index.ts), so an active read handle left on a still-open, still-silent pipe would otherwise keep
 * the process alive indefinitely even after this function itself gives up.
 */
function readStdinBounded(
  stream: NodeJS.ReadStream,
  timeoutMs: number,
): Promise<string | typeof STDIN_SILENT_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let gaveUp = false;

    function cleanup(): void {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    }
    function onData(chunk: Buffer): void {
      clearTimeout(timer); // the FIRST byte disarms the bound permanently — never mid-stream.
      chunks.push(chunk);
    }
    function onEnd(): void {
      if (gaveUp) return; // already resolved on timeout; a late EOF has nothing left to report
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }
    function onError(err: Error): void {
      if (gaveUp) return;
      cleanup();
      reject(err);
    }

    // `timer.unref()`: the TIMER ITSELF must never be what keeps the process alive while it waits —
    // only a genuinely pending piece of work should do that.
    const timer = setTimeout(() => {
      gaveUp = true;
      cleanup();
      // Release the handle (see this function's doc comment) so a still-open, still-silent pipe
      // cannot keep the process alive after this read has already given up on it.
      stream.pause();
      stream.unref?.();
      resolve(STDIN_SILENT_TIMEOUT);
    }, timeoutMs);
    timer.unref();

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

/**
 * Resolves to the piped stdin content; `undefined` when there is no real stdin data source at all
 * (see `hasRealStdinInput`); or {@link STDIN_SILENT_TIMEOUT} when a real source stayed silent past
 * {@link STDIN_FIRST_BYTE_TIMEOUT_MS} (see `readStdinBounded`) — the bound that keeps an
 * open-but-silent pipe from hanging this read forever.
 */
export async function defaultReadStdin(): Promise<StdinReadResult> {
  if (!hasRealStdinInput()) return undefined;
  return readStdinBounded(process.stdin, STDIN_FIRST_BYTE_TIMEOUT_MS);
}

/** Map a filesystem ENOENT (missing concept file) to NOT_FOUND; classify anything else via `classifyBundleError`. */
export function readErrorToCliError(err: unknown, id: string, remoteUrl?: string): CliError {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new CliError("NOT_FOUND", `no concept document at id '${id}'`, {
      help: `${cliInvocation()} list`,
    });
  }
  // A corrupt document (unparseable YAML) → RUNTIME (exit 1), not the USAGE default: handled
  // centrally in classifyBundleError so read/write/update/history/link all agree (a valid
  // invocation hitting bad stored data is not a usage error).
  return classifyBundleError(err, remoteUrl);
}
