// `private-state.ts` — the publication-side private-state backstop (specification F8 and P11).
//
// Every other private-state guard answers a question about a PATH the caller named. This one
// answers a question about BYTES about to leave the machine: a commit sync pushes, a snapshot
// establishment publishes, a bundle `publish --to hosted` uploads. A copied state folder
// (`cp -R ~/.superbee-state my-project/.superbee/`) reaches none of the path guards, so it is
// recognized here by what it IS, never by where it came from:
//
//   • by NAME: a folder named like a guarded root (`.superbee-state`, `.agentstate`), at any
//     depth, and the credential file's own name (`okf-config.json`);
//   • by CONTENT: the ownership marker (on its `{"product":"superbee"` prefix), the API-key
//     credential file, the hosted session and refresh-token records, the bearer credential an
//     older client stored, and the workspace catalog, each on its schema.
//
// A legacy or superseded root carries no ownership marker (P10/P11), so a marker-only detector
// could never cover it; the name and record rules above do. The names are a projection of the
// CLI's own constants, pinned by an agreement test there.
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

import { BoardGitError, isBoardGitError } from "./errors.js";

/** The final segment of every guarded private-state root that has a product-specific name. */
export const PRIVATE_STATE_ROOT_NAMES: readonly string[] = Object.freeze([".superbee-state", ".agentstate"]);
/** The API-key credential file's name (`okf-config.json`), recognized whatever it holds. */
export const PRIVATE_STATE_CREDENTIAL_FILE_NAME = "okf-config.json";
/** The ownership marker's literal prefix, matched even when the rest of the file does not parse. */
export const PRIVATE_STATE_MARKER_PREFIX = '{"product":"superbee"';
/** Records larger than this are not private state (the largest, the catalog, is bounded at 4 MiB). */
export const PRIVATE_STATE_MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** The `details.reason` every private-state publication refusal carries. */
export const PRIVATE_STATE_REFUSAL_REASON = "private_state_in_bundle";

export type PrivateStateEvidence =
  | "state_folder"
  | "credential_file"
  | "state_marker"
  | "api_key_credentials"
  | "bearer_credentials"
  | "hosted_session"
  | "hosted_refresh_token"
  | "workspace_catalog";

const EVIDENCE_LABEL: Record<PrivateStateEvidence, string> = {
  state_folder: "a Superbee private-state folder",
  credential_file: "Superbee's API-key credential file",
  state_marker: "Superbee's private-state ownership marker",
  api_key_credentials: "Superbee API-key credentials",
  bearer_credentials: "a stored bearer credential",
  hosted_session: "a hosted sign-in session",
  hosted_refresh_token: "a hosted refresh token",
  workspace_catalog: "Superbee's workspace catalog",
};

/** One private-state file found in what is about to be published. */
export interface PrivateStateFinding {
  /** The file, relative to the bundle (or the published tree), `/`-separated. */
  path: string;
  evidence: PrivateStateEvidence;
  /** What to move out of the bundle: the state folder for a name match, else the file itself. */
  remove: string;
}

function fold(segment: string): string {
  return segment.normalize("NFC").toLowerCase();
}

const ROOT_NAMES = new Set(PRIVATE_STATE_ROOT_NAMES.map(fold));

/** Name evidence for one relative path, or null. Pure. */
export function privateStatePathEvidence(relPath: string): { evidence: PrivateStateEvidence; remove: string } | null {
  const segments = relPath.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (ROOT_NAMES.has(fold(segments[index]!))) {
      return { evidence: "state_folder", remove: segments.slice(0, index + 1).join("/") };
    }
  }
  const last = segments.at(-1);
  if (last !== undefined && fold(last) === PRIVATE_STATE_CREDENTIAL_FILE_NAME) {
    return { evidence: "credential_file", remove: segments.join("/") };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Content evidence for one file's bytes, or null. Pure; reads nothing past the bound. */
export function privateStateContentEvidence(bytes: Uint8Array): PrivateStateEvidence | null {
  if (bytes.byteLength === 0 || bytes.byteLength > PRIVATE_STATE_MAX_RECORD_BYTES) return null;
  // Every recognized record is a JSON object: skip a BOM and leading whitespace, require `{`.
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (start < bytes.byteLength && (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d)) start += 1;
  if (bytes[start] !== 0x7b) return null;
  const text = Buffer.from(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start).toString("utf8");
  if (text.startsWith(PRIVATE_STATE_MARKER_PREFIX)) return "state_marker";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.product === "superbee" && "schema_version" in value) return "state_marker";
  if (isRecord(value.remotes) && Object.values(value.remotes).some((entry) => isRecord(entry) && typeof entry.api_key === "string")) {
    return "api_key_credentials";
  }
  if (typeof value.access_token === "string" && typeof value.access_token_expires_at_ms === "number") return "hosted_session";
  if (typeof value.refresh_token === "string" && typeof value.account === "string") return "hosted_refresh_token";
  if (typeof value.access_token === "string" && typeof value.server === "string") return "bearer_credentials";
  if (
    hasExactKeys(value, ["schema_version", "entries"])
    && typeof value.schema_version === "number"
    && Array.isArray(value.entries)
    && value.entries.every((entry) => isRecord(entry) && isRecord(entry.locator))
  ) {
    return "workspace_catalog";
  }
  return null;
}

/** The finding for one file (its name first, then its bytes when given), or null. */
export function privateStateFinding(relPath: string, bytes: Uint8Array | null): PrivateStateFinding | null {
  const normalized = relPath.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".").join("/");
  const named = privateStatePathEvidence(normalized);
  if (named) return { path: normalized, ...named };
  const evidence = bytes === null ? null : privateStateContentEvidence(bytes);
  return evidence ? { path: normalized, evidence, remove: normalized } : null;
}

/**
 * A regular file's bytes when it could be a private-state record, else null: never follows a final
 * symlink (Git publishes a link, not its target), never blocks on a FIFO, and skips anything past
 * the record bound without reading it.
 */
export function readPrivateStateCandidate(file: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const status = fstatSync(fd);
    if (!status.isFile() || status.size === 0 || status.size > PRIVATE_STATE_MAX_RECORD_BYTES) return null;
    const bytes = Buffer.alloc(status.size);
    let read = 0;
    while (read < bytes.byteLength) {
      const n = readSync(fd, bytes, read, bytes.byteLength - read, read);
      if (n === 0) break;
      read += n;
    }
    return bytes.subarray(0, read);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Findings sorted by path, so a refusal names the same file first on every run. */
export function sortPrivateStateFindings(findings: Iterable<PrivateStateFinding>): PrivateStateFinding[] {
  return [...findings].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What the refusal is about: the operation, the folder the paths are relative to, and its remedy. */
export interface PrivateStateRefusalContext {
  /** The operation refused, in a few words: `sync`, `publish --to hosted`, `board establishment`. */
  operation: string;
  /** The absolute folder the findings' paths are relative to (the bundle or board checkout). */
  root: string;
  /**
   * `files`: the bytes are in the folder and nothing is committed, so moving them out suffices.
   * `commits`: they are already in local commits that are not on the remote; those must be undone.
   */
  stage: "files" | "commits";
  /** The commit range's base for `commits` (the remote ref), when there is one. */
  base?: string | null;
  /** The command to run once the folder is clean. */
  rerun: string;
}

/** The refusal's message, help and details: one wording for every publication surface. */
export function privateStateRefusal(
  found: readonly PrivateStateFinding[],
  context: PrivateStateRefusalContext,
): { message: string; help: string; details: Record<string, unknown> } {
  const findings = sortPrivateStateFindings(found);
  const removals = [...new Set(findings.map((finding) => finding.remove))];
  const first = findings[0]!;
  const more = removals.length > 1 ? ` (and ${removals.length - 1} more)` : "";
  const message =
    `${context.operation} refused: '${first.remove}' in ${context.root} is ${EVIDENCE_LABEL[first.evidence]}${more}, ` +
    `which is private Superbee state and never bundle content; nothing was ${context.stage === "files" ? "committed or sent" : "pushed"}`;
  // A collision-safe MOVE out of the bundle, never a delete: the copy may be the only one.
  const moves = removals.map((relative) =>
    `mv -- ${shellQuote(path.join(context.root, ...relative.split("/")))} "$(mktemp -d ~/superbee-private-state-removed.XXXXXX)"/`);
  const undo = context.stage === "commits"
    ? context.base
      ? `undo the unpushed commits that carry it, keeping their changes: git -C ${shellQuote(context.root)} reset --soft ${shellQuote(context.base)}; then `
      : `remove it from the commits that carry it (they have never been pushed); then `
    : "";
  const help =
    `${undo}move it out of the bundle: ${moves.join(" && ")}; then ${context.rerun}. ` +
    `If it held an API key or token that was ever shared, revoke that key.`;
  return {
    message,
    help,
    details: {
      reason: PRIVATE_STATE_REFUSAL_REASON,
      stage: context.stage,
      private_state: findings.slice(0, 20).map((finding) => ({ path: finding.path, evidence: finding.evidence })),
      private_state_total: findings.length,
      remove: removals,
    },
  };
}

/** The refusal as the git tier's typed error (CONFLICT, exit 5 at the CLI boundary). */
export function privateStateRefusalError(found: readonly PrivateStateFinding[], context: PrivateStateRefusalContext): BoardGitError {
  const refusal = privateStateRefusal(found, context);
  return new BoardGitError("CONFLICT", refusal.message, { details: refusal.details, help: refusal.help });
}

/** True for a private-state publication refusal, from either tier (structural, never `instanceof`). */
export function isPrivateStateRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = (error as { details?: unknown }).details;
  return (isBoardGitError(error) || (error as { name?: unknown }).name === "CliError")
    && typeof details === "object" && details !== null
    && (details as { reason?: unknown }).reason === PRIVATE_STATE_REFUSAL_REASON;
}
