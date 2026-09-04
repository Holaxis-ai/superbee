// `errors.ts` — the git tier's OWN typed error taxonomy (board-git A0 seam prep, relocated
// here by A1).
//
// The git tier (porcelain/diff/cursor/engine/flow/autopull) throws and consumes `BoardGitError`;
// the CLI command boundary maps it onto `CliError`/envelope/exit codes through ONE mapping layer
// (`cliErrorFromBoardGit` in the CLI's errors.ts). This module is deliberately DEPENDENCY-CLEAN
// — node builtins only — the package's one error vocabulary.
//
// Detection is STRUCTURAL ({@link isBoardGitError}), never bare `instanceof`: cli tests resolve
// workspace deps to built `dist` while the esbuild bundle aliases source, so two copies of this
// class can coexist in one process and `instanceof` would silently miss one of them.

/**
 * The codes the git tier produces. Each maps 1:1 onto the SAME-NAMED `CliErrorCode`; the
 * code→exit parity is pinned by the CLI's `test/board-git-errors.test.ts` table.
 */
export type BoardGitErrorCode =
  | "GIT_MISSING"
  | "TRANSIENT"
  | "GIT_BUSY"
  | "NO_UPSTREAM"
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "RUNTIME";

/** Exhaustive code list (compile-time checked) — the parity table iterates this. */
export const BOARD_GIT_ERROR_CODES: readonly BoardGitErrorCode[] = [
  "GIT_MISSING",
  "TRANSIENT",
  "GIT_BUSY",
  "NO_UPSTREAM",
  "AUTH_REQUIRED",
  "CONFLICT",
  "RUNTIME",
];

export interface BoardGitErrorOptions {
  /** Machine-readable specifics (e.g. { op, retryable: true }) the boundary preserves verbatim. */
  details?: Record<string, unknown>;
  /** A parameterized fixing command — preserved verbatim into the CLI envelope's `help`. */
  help?: string;
}

/**
 * A git-tier failure carrying its stable `code` plus optional machine `details` and a `help`
 * fixing command. Deliberately carries NO exit code and NO envelope shape — those are CLI
 * boundary policy (errors.ts), not git-tier facts.
 */
export class BoardGitError extends Error {
  readonly code: BoardGitErrorCode;
  readonly details?: Record<string, unknown>;
  readonly help?: string;

  constructor(code: BoardGitErrorCode, message: string, opts: BoardGitErrorOptions = {}) {
    super(message);
    this.name = "BoardGitError";
    this.code = code;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.help !== undefined) this.help = opts.help;
  }
}

/**
 * Structural type guard — the ONLY sanctioned detection (never `instanceof`, see the module
 * header's dual-load hazard): the `BoardGitError` name marker plus a known `code`.
 */
export function isBoardGitError(v: unknown): v is BoardGitError {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as { name?: unknown; code?: unknown; message?: unknown };
  return (
    candidate.name === "BoardGitError" &&
    typeof candidate.code === "string" &&
    (BOARD_GIT_ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === "string"
  );
}

/**
 * The captured outcome of one failed `git` invocation (`porcelain.ts`'s spawn wrapper is the ONLY
 * producer). Deliberately a plain data shape — not an Error subclass — so the classifier below is
 * a pure, unit-testable function.
 */
export interface GitFailure {
  /** The git argv (WITHOUT the leading `git -C <dir>` prefix) — names the op in messages/details. */
  args: readonly string[];
  /** The child's exit status; null when the spawn itself failed or the process was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when the per-op timeout killed the child (the wrapper's no-hang invariant fired). */
  timedOut?: boolean;
  /** The spawn-level errno code (e.g. `ENOENT` = no git binary), when the process never ran. */
  spawnErrorCode?: string;
}

/** First non-empty line of a git failure's stderr (fall back to stdout) — for compact messages. */
function firstGitLine(f: GitFailure): string {
  const line =
    f.stderr.split("\n").find((l) => l.trim().length > 0) ??
    f.stdout.split("\n").find((l) => l.trim().length > 0) ??
    "";
  return line.trim();
}

/**
 * Classify one failed git invocation into a `BoardGitError` — the ONE chokepoint between raw git
 * and the structured surface: no raw git strand ever reaches stdout; every failure lands typed.
 * Matching prefers STABLE signals (spawn errno, `index.lock`, ref names) over localized prose
 * where git offers one; the prose fallbacks are ordered so the more specific state wins:
 *
 *  - spawn `ENOENT` -> `GIT_MISSING`: git itself is not installed — a distinct, branchable code.
 *  - per-op timeout -> `TRANSIENT`: the no-hang invariant fired; retryable.
 *  - `index.lock` / "Another git process" -> `GIT_BUSY` with `details.retryable: true`.
 *  - a non-fast-forward push -> `TRANSIENT`: another writer advanced the board; re-run sync.
 *  - missing `origin` remote / unresolvable `origin/board` -> `NO_UPSTREAM`.
 *  - credential/permission signals -> `AUTH_REQUIRED`. BEST-EFFORT by design: GitHub answers
 *    "Repository not found." for unauthorized-private, so not-found-shaped transport failures
 *    classify as AUTH rather than silently reading as "no such repo".
 *  - detached HEAD -> `RUNTIME`, a precondition failure NAMING the state.
 *  - unmerged paths / mid-merge refusals -> `CONFLICT`.
 *  - unreachable/unresolvable host, connection refused/timed out -> `TRANSIENT`.
 *  - anything else -> `RUNTIME` carrying the op name + first stderr line (never a raw dump).
 */
export function classifyGitError(f: GitFailure): BoardGitError {
  const op = f.args[0] ?? "git";
  const text = `${f.stderr}\n${f.stdout}`;

  if (f.spawnErrorCode === "ENOENT") {
    return new BoardGitError("GIT_MISSING", "sync needs git, which isn't installed on this machine", {
      details: { op },
      help: "install git (https://git-scm.com/downloads), then re-run the command",
    });
  }
  if (f.timedOut || f.spawnErrorCode === "ETIMEDOUT") {
    return new BoardGitError("TRANSIENT", `git ${op} timed out — the network or repository may be slow; retry`, {
      details: { op, retryable: true },
    });
  }
  if (/index\.lock|Another git process seems to be running/i.test(text)) {
    return new BoardGitError(
      "GIT_BUSY",
      "another git process is using this repository — retry once it finishes",
      { details: { op, retryable: true } },
    );
  }
  if (
    op === "push" &&
    (/\[rejected\].*\((?:fetch first|non-fast-forward)\)/i.test(text) ||
      /Updates were rejected because (?:the remote contains work|the tip of your current branch is behind)/i.test(text))
  ) {
    return new BoardGitError(
      "TRANSIENT",
      "a teammate pushed to the board at the same time — re-run sync to incorporate their changes and retry",
      { details: { op, retryable: true, reason: "non-fast-forward" } },
    );
  }
  if (op === "push" && (/\[remote rejected\]/i.test(text) || /pre-receive hook declined/i.test(text))) {
    return new BoardGitError(
      "RUNTIME",
      "the remote rejected the board push; a remote policy, branch rule, or server-side hook may be responsible",
      { details: { op, reason: "remote-rejected", best_effort: true } },
    );
  }
  if (
    /'origin' does not appear to be a git repository/i.test(text) ||
    /No such remote:? '?origin'?/i.test(text) ||
    /invalid upstream ['"]?origin\//i.test(text) ||
    /origin\/[^\s]+ - not something we can merge/i.test(text) ||
    /couldn'?t find remote ref/i.test(text) ||
    /src refspec [^\s]+ does not match any/i.test(text)
  ) {
    return new BoardGitError(
      "NO_UPSTREAM",
      "the board branch isn't linked to a remote yet — sync can't share it",
      { details: { op } },
    );
  }
  if (
    /authentication failed/i.test(text) ||
    /could not read (Username|Password)/i.test(text) ||
    /Permission denied \(publickey/i.test(text) ||
    /returned error: 40[13]/i.test(text) ||
    /Repository not found/i.test(text) ||
    /does not appear to be a git repository/i.test(text) ||
    /access denied|Invalid username or password/i.test(text)
  ) {
    return new BoardGitError(
      "AUTH_REQUIRED",
      `git ${op} was denied access to the remote (or the repository is not visible to your credentials)`,
      { details: { op, best_effort: true } },
    );
  }
  if (/You are not currently on a branch|HEAD detached/i.test(text)) {
    return new BoardGitError(
      "RUNTIME",
      "the board worktree is in a detached-HEAD state — sync needs the board branch checked out",
      { details: { op, state: "detached-head" } },
    );
  }
  if (
    /needs merge/i.test(text) ||
    /unmerged files/i.test(text) ||
    /not possible because you have unmerged/i.test(text) ||
    /Resolve all conflicts/i.test(text)
  ) {
    return new BoardGitError("CONFLICT", "the board worktree has unresolved conflicts", { details: { op } });
  }
  if (
    /Could not resolve host|unable to access|Connection (refused|timed out|reset)|Operation timed out|network is unreachable|Failed to connect/i.test(
      text,
    )
  ) {
    return new BoardGitError("TRANSIENT", `git ${op} could not reach the remote — offline or the host is unreachable; retry`, {
      details: { op, retryable: true },
    });
  }
  const line = firstGitLine(f);
  return new BoardGitError("RUNTIME", `git ${op} failed${line ? `: ${line}` : ""}`, {
    details: { op, exit_status: f.status },
  });
}
