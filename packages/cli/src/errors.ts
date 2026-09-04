// Structured CLI errors with stable codes + a capped exit-code taxonomy.
//
// Per the agent-first design (§6/§7): an agent shelling out branches on the EXIT CODE first and the
// structured `code` enum second, so both must be deterministic. Every failable command throws a
// `CliError`; the bin wrapper (index.ts / cli.ts formatError) maps it to an exit code and a structured
// stdout envelope — never by prose-matching the message. Non-CliError throws are classified by
// `classifyBundleError` — THE one boundary from typed failures to public codes/exits — whether they
// reach a command catch-all or fall all the way to `toExit`.
//
// The 0/1/2/4/5/6 exit taxonomy is PRESERVED intact from holaxis-agentstate.
import { InvalidInputError, MalformedDocumentError, RemoteError, VersionConflict } from "@superbee/core";
import { isBoardGitError, type BoardGitError } from "@superbee/board-git";
import { commandLiteral, commandToken } from "./command-text.js";

/** Stable, documented error codes. Finer than the exit table; rides alongside it in the envelope. */
export type CliErrorCode =
  | "AUTH_REQUIRED"
  | "AUDIENCE_MISMATCH"
  | "NOT_FOUND"
  | "STALE_HEAD"
  | "ALREADY_EXISTS"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INTEGRITY_MISMATCH"
  | "NOT_IMPLEMENTED"
  | "USAGE"
  | "TRANSIENT"
  | "RUNTIME"
  /**
   * The caller authenticated fine but a remote denied the operation (`403 FORBIDDEN`).
   * Exit 2 (USAGE) is the least-wrong bucket in the capped taxonomy — exit 4 (AUTH) would
   * mislead an agent into re-authenticating, which grants no additional role — but the
   * `code` is preserved distinctly (not collapsed into a generic `"USAGE"`) so an agent can
   * still branch on "wrong role" vs. "malformed request."
   */
  | "FORBIDDEN"
  /**
   * A remote's `409 LAST_ADMIN` — a well-formed membership mutation that would strip a bundle
   * of its last real admin. A genuine precondition conflict, same taxonomy bucket as
   * `STALE_HEAD`/`ALREADY_EXISTS`.
   */
  | "LAST_ADMIN"
  /**
   * The `git` binary itself is absent (the spawn
   * fails ENOENT). Exit 1 with a DISTINCT code — the FORBIDDEN/LAST_ADMIN distinct-code-shared-exit
   * pattern — so an agent can branch on "install git" vs. a transient runtime failure.
   */
  | "GIT_MISSING"
  /**
   * The board branch has no usable remote counterpart — no `origin` remote, or `origin`
   * exists but carries no `board` ref (`origin/board` unresolvable). Exit 1, distinct code.
   */
  | "NO_UPSTREAM"
  /**
   * Another git process holds the repository lock (`index.lock` exists —
   * a concurrent sync, or the user's own git mid-operation). Exit 1 with `details.retryable: true`
   * — a STRUCTURED RETRY envelope, never a raw git strand on stdout.
   */
  | "GIT_BUSY"
  /**
   * An unresolved same-doc divergence between the local board and `origin/board` (or a
   * worktree left with unmerged paths). The CAS-semantics bucket: same exit (5) as
   * `STALE_HEAD`/`ALREADY_EXISTS` — "the precondition moved under you" — with a distinct code.
   */
  | "CONFLICT";

/** The capped exit-code taxonomy (§6). More codes become brittle; refine via `code` instead. */
export const EXIT = {
  /** success or definitive no-op/empty */
  OK: 0,
  /** recoverable runtime error (5xx / transient) */
  RUNTIME: 1,
  /** usage error: bad/missing flags, parse failure, not-implemented */
  USAGE: 2,
  /** auth required: no/expired creds, refresh failed, audience mismatch */
  AUTH: 4,
  /** CAS / precondition conflict: head moved, expected-* mismatch */
  CONFLICT: 5,
  /** not found: doc_key / doc_id / concept id absent */
  NOT_FOUND: 6,
} as const;

/** Single source of truth mapping each `code` to its exit code. */
const CODE_EXIT: Record<CliErrorCode, number> = {
  AUTH_REQUIRED: EXIT.AUTH,
  AUDIENCE_MISMATCH: EXIT.AUTH,
  NOT_FOUND: EXIT.NOT_FOUND,
  STALE_HEAD: EXIT.CONFLICT,
  ALREADY_EXISTS: EXIT.CONFLICT,
  UNSUPPORTED_MEDIA_TYPE: EXIT.USAGE,
  INTEGRITY_MISMATCH: EXIT.RUNTIME,
  NOT_IMPLEMENTED: EXIT.USAGE,
  USAGE: EXIT.USAGE,
  TRANSIENT: EXIT.RUNTIME,
  RUNTIME: EXIT.RUNTIME,
  FORBIDDEN: EXIT.USAGE,
  LAST_ADMIN: EXIT.CONFLICT,
  GIT_MISSING: EXIT.RUNTIME,
  NO_UPSTREAM: EXIT.RUNTIME,
  GIT_BUSY: EXIT.RUNTIME,
  CONFLICT: EXIT.CONFLICT,
};

export interface CliErrorOptions {
  /** Machine-readable specifics (e.g. { current_head_seq: 9 }) the agent can act on. */
  details?: Record<string, unknown>;
  /** A parameterized fixing command — the SPECIFIC next step, never "see --help". */
  help?: string;
  /**
   * When true, the command already emitted this error's envelope to its own channel (e.g.
   * `doc read --out -` routes it to STDERR to keep the stdout byte stream pure). The bin wrapper
   * honors this and does NOT re-emit the envelope to stdout — it only sets the exit code.
   */
  handled?: boolean;
}

/**
 * A command-level failure carrying its own stable `code`, derived `exitCode`, and optional
 * machine `details` + a `help` fixing command. Throw this from any command instead of a bare
 * Error so the exit code and structured envelope are deterministic.
 */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;
  readonly help?: string;
  /** See CliErrorOptions.handled — the bin wrapper skips the stdout envelope when true. */
  readonly handled: boolean;

  constructor(code: CliErrorCode, message: string, opts: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = CODE_EXIT[code];
    this.handled = opts.handled ?? false;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.help !== undefined) this.help = opts.help;
  }
}

/** The on-wire structured-error envelope an agent parses from stdout (§7). */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    help?: string;
  };
}

/** Project a CliError into its wire envelope (omitting absent optional fields). */
export function toEnvelope(err: CliError): ErrorEnvelope {
  const e: ErrorEnvelope["error"] = { code: err.code, message: err.message };
  if (err.details !== undefined) e.details = err.details;
  if (err.help !== undefined) e.help = err.help;
  return { error: e };
}

/**
 * THE CLI error boundary: classify ANY thrown value into a `CliError` on the capped taxonomy.
 * Every command catch-all delegates here; `toExit` (the bin wrapper) applies the SAME mapping to
 * anything left uncaught, so the two layers can never disagree. Command-level catches may still
 * translate an EXPECTED domain condition with better context (a typed pre-check — e.g. ENOENT ->
 * "no concept document at id 'X'"), but never classify an arbitrary plain error themselves.
 * `classifyGitError` (@superbee/board-git) is the git-porcelain DOMAIN classifier: it produces
 * typed `BoardGitError`s that this boundary maps through {@link cliErrorFromBoardGit} — the ONE
 * BoardGitError→CliError mapping (parity pinned by `test/board-git-errors.test.ts`'s table).
 * Contract (pinned by `test/error-boundary.test.ts`'s table):
 *
 *  - `CliError` -> unchanged (already classified).
 *  - `BoardGitError` (structural guard, never `instanceof` — the dual-load hazard) -> the
 *    same-named `CliErrorCode`, message/details/help preserved verbatim.
 *  - `InvalidInputError` (core's typed input-validation rejection: unsafe/reserved ids,
 *    empty type, bad option values) -> USAGE (2). This TYPE is the only path by which a
 *    non-`CliError` throw reaches USAGE — "fix your input" is a claim about the input, so it
 *    must be provably input-derived, never a fallback bucket.
 *  - `MalformedDocumentError` (corrupt STORED bytes; the invocation was valid) -> RUNTIME (1).
 *  - `VersionConflict` that escaped a call site's own translation -> STALE_HEAD (5), with
 *    `{expected, actual}` details.
 *  - `RemoteError` -> by ITS server-derived `code`: AUTH_REQUIRED -> exit 4 with an
 *    `SUPERBEE_API_KEY` fixing hint; RUNTIME and VERSION_MISSING (a 5xx, or an
 *    intermediary stripping the version header — retry/report, not a caller mistake) -> RUNTIME
 *    (1); REDIRECT_REFUSED is likewise a remote protocol failure, not caller input; FORBIDDEN ->
 *    FORBIDDEN (USAGE's exit 2, distinct code — re-authenticating grants no
 *    role); NOT_FOUND -> NOT_FOUND (6); LAST_ADMIN -> LAST_ADMIN (CONFLICT's exit 5). An
 *    UNRECOGNIZED code falls back by HTTP STATUS, never blindly to USAGE: `RATE_LIMITED`/429
 *    -> TRANSIENT (1) with `details.retryable: true` — attested
 *    client fault, but the fix is BACKING OFF, not editing input; any 5xx -> RUNTIME (1); a
 *    remaining 4xx (e.g. the wire's own USAGE, 400) -> USAGE (2) — a 400-class status IS the
 *    server attesting client fault, the one sanctioned non-typed USAGE source.
 *  - ANYTHING else — fs errnos (ENOSPC, EACCES, a raw ENOENT no call site translated),
 *    unexpected backend/engine failures, a non-Error throw — -> RUNTIME (1): a valid invocation
 *    hitting a broken environment is "retry/report a bug", never "fix your input". An
 *    ENOENT-shaped "missing document" is a DOMAIN condition: the call sites that know the id
 *    translate it (NOT_FOUND with the id, USAGE for a missing `promote` source file) before it
 *    ever reaches this fallback — context-free, ENOENT is just a failed syscall.
 */
export function classifyBundleError(err: unknown, remoteUrl?: string, remoteBundleId?: string): CliError {
  if (err instanceof CliError) return err;
  if (isBoardGitError(err)) return cliErrorFromBoardGit(err);
  if (err instanceof InvalidInputError) return new CliError("USAGE", err.message);
  if (err instanceof MalformedDocumentError) return new CliError("RUNTIME", err.message);
  if (err instanceof VersionConflict) {
    return new CliError("STALE_HEAD", err.message, {
      details: { expected: err.expected, actual: err.actual },
    });
  }
  if (err instanceof RemoteError) {
    if (err.code === "AUTH_REQUIRED") {
      return new CliError("AUTH_REQUIRED", err.message, {
        help:
          `set SUPERBEE_API_KEY=<key> and retry the same command against --remote ${remoteUrl ? commandToken(remoteUrl) : commandLiteral("<url>")} ` +
          `--bundle ${remoteBundleId ? commandToken(remoteBundleId) : commandLiteral("<bundle_id>")}; ` +
          "an already-provisioned stored credential for the exact origin and bundle is also accepted",
      });
    }
    if (err.code === "RUNTIME" || err.code === "VERSION_MISSING" || err.code === "REDIRECT_REFUSED") {
      return new CliError("RUNTIME", err.message);
    }
    if (err.code === "FORBIDDEN") {
      return new CliError("FORBIDDEN", err.message);
    }
    if (err.code === "NOT_FOUND") {
      return new CliError("NOT_FOUND", err.message);
    }
    if (err.code === "LAST_ADMIN") {
      return new CliError("LAST_ADMIN", err.message);
    }
    if (err.code === "RATE_LIMITED" || err.status === 429) {
      return new CliError("TRANSIENT", err.message, { details: { retryable: true, status: err.status } });
    }
    if (err.status >= 500) {
      return new CliError("RUNTIME", err.message);
    }
    return new CliError("USAGE", err.message);
  }
  return new CliError("RUNTIME", err instanceof Error ? err.message : String(err));
}

/**
 * Map ANY thrown value to the exit code + envelope the bin wrapper emits — the SAME
 * {@link classifyBundleError} mapping, so an uncaught typed failure lands on the identical
 * code/exit a command catch-all would have produced. `handled` rides along so the wrapper can
 * suppress its stdout write when the command already emitted the envelope on its own channel.
 */
export function toExit(err: unknown): { exitCode: number; envelope: ErrorEnvelope; handled: boolean } {
  const cliErr = classifyBundleError(err);
  return { exitCode: cliErr.exitCode, envelope: toEnvelope(cliErr), handled: cliErr.handled };
}

/**
 * THE one BoardGitError→CliError mapping (the CLI command boundary for the git tier): the
 * same-named `CliErrorCode` — every `BoardGitErrorCode` exists in {@link CliErrorCode}, checked at
 * compile time — with message/details/help preserved verbatim, so the envelope and exit code are
 * byte-identical to what the tier produced when it threw `CliError` directly. Code→exit parity is
 * pinned by `test/board-git-errors.test.ts`'s exhaustive table.
 */
export function cliErrorFromBoardGit(err: BoardGitError): CliError {
  return new CliError(err.code, err.message, {
    ...(err.details !== undefined ? { details: err.details } : {}),
    ...(err.help !== undefined ? { help: err.help } : {}),
  });
}

/**
 * Re-wrap a thrown value as a CliError flagged `handled` (preserving code/message/details/help).
 * A command that has already written the error envelope to its own channel (e.g. `doc read --out -`
 * → stderr) throws `asHandled(err)` so the bin wrapper sets the exit code WITHOUT re-emitting the
 * envelope to stdout — keeping the reserved byte channel pure regardless of outcome.
 */
export function asHandled(err: unknown): CliError {
  const classified = classifyBundleError(err);
  return new CliError(classified.code, classified.message, {
    details: classified.details,
    help: classified.help,
    handled: true,
  });
}
