// One row per document for a hosted sync (client contract, section 3.4): what happened to each
// local change, and the one next step for it. The row states are fixed:
//
//   committed  the host accepted the whole document
//   conflict   the document changed on the host too; nothing was merged (inspect, then resolve)
//   held       sync cannot send this file as it stands; it stays in the folder, nothing is sent
//   refused    the host refused this document's content, or refused writes to the bundle
//   unknown    the answer was lost; the next sync looks it up by the same request identity
//   paused     sync stopped before sending it (sign-in, or the sync quota); nothing was lost
//
// The exit code is non-zero while any row is not committed.
import type { IntentRecord } from "@superbee/core/journaled-backend";
import { CAPACITY_REFUSAL_CODES } from "@superbee/core/hosted-transport";

import { CliError, type CliErrorCode } from "../errors.js";
import type { FolderConflict, HeldFile } from "./sync-scan.js";

export const ROW_STATES = ["committed", "conflict", "held", "refused", "unknown", "paused"] as const;
export type RowState = (typeof ROW_STATES)[number];

export interface SyncRow {
  readonly id: string;
  readonly state: RowState;
  /** A stable reason code an agent can branch on. */
  readonly reason: string;
  /** The committed version for a committed row; null otherwise. */
  readonly version: string | null;
  readonly message: string;
}

/** Recorded refusals that say the bundle was busy, not that the content is wrong: requeued under a fresh identity. */
export const BUSY_REFUSAL_CODES: ReadonlySet<string> = new Set(["concurrent_change", "backend_unavailable", "internal_error", "deadline_exceeded", "cancelled"]);
const SIGN_IN_CODES: ReadonlySet<string> = new Set(["AUTH_REQUIRED", "UNAUTHORIZED", "FORBIDDEN"]);

/** Why nothing was sent for a document that was never attempted, when the whole push did not run. */
export type NotSentReason = "read_only" | null;

export const QUOTA_MESSAGES = Object.freeze({
  principal:
    "paused: sync quota. Your sync quota for this bundle is used up (it counts your writes over a rolling 24 hours, shared with your browser editor). Nothing was lost; run sync again once earlier writes age out.",
  bundle:
    "paused: sync quota. This bundle's sync capacity is used up. Nothing was lost; run sync again later.",
});

export const READ_ONLY_MESSAGE =
  "The host refused writes to this bundle: you have read-only access, or sync writes are not enabled for it. Your change stays in the folder; ask a bundle admin for write access, or make the change in the Superbee app.";

function refusalRow(id: string, row: IntentRecord): SyncRow {
  const code = row.refusal?.code ?? "refused";
  const message = row.refusal?.message ?? "the host refused the change";
  if (code === CAPACITY_REFUSAL_CODES.principal) return { id, state: "paused", reason: "sync_quota_principal", version: null, message: QUOTA_MESSAGES.principal };
  if (code === CAPACITY_REFUSAL_CODES.bundle) return { id, state: "paused", reason: "sync_quota_bundle", version: null, message: QUOTA_MESSAGES.bundle };
  if (code === "PERMISSION_DENIED") return { id, state: "refused", reason: "read_only", version: null, message: READ_ONLY_MESSAGE };
  if (SIGN_IN_CODES.has(code)) return { id, state: "paused", reason: "sign_in", version: null, message: "The hosted session ended before this change was sent; sign in and run sync again." };
  if (BUSY_REFUSAL_CODES.has(code)) return { id, state: "paused", reason: "busy", version: null, message: "The host was busy and did not apply this change; run sync again." };
  return { id, state: "refused", reason: code, version: null, message: `The host refused this document (${code}): ${message} Edit the file and run sync again.` };
}

/** The row a pending intent that was not sent in this run stands for. */
function waitingRow(id: string, pausedBy: SyncRow | null, notSent: NotSentReason): SyncRow {
  if (notSent === "read_only") return { id, state: "refused", reason: "read_only", version: null, message: READ_ONLY_MESSAGE };
  if (pausedBy) return { ...pausedBy, id };
  return { id, state: "paused", reason: "not_sent", version: null, message: "Not sent in this run; run sync again." };
}

export const CHANGED_REMOTELY_MESSAGE = "The document also changed on the host. Nothing was merged or sent. Inspect it, then keep yours, take theirs, or revise.";
export const DELETED_REMOTELY_MESSAGE =
  "The document was deleted on the host while you changed it. Nothing was sent. Inspect it, then take the deletion; re-creating it is done in the Superbee app until sync can re-create a deleted document.";
const FOLDER_CHANGED_MESSAGE =
  "The file was edited while the host changed this document (during a sync, or while sync held the file). Nothing was merged or sent. Inspect it, then keep your file, take the host's version, or revise.";

export interface RowInputs {
  /** Files edited against a version the host has since changed or deleted (`folderConflicts`). */
  readonly folderConflicts?: readonly FolderConflict[];
  /** Unsettled intents after the push, in journal order. */
  readonly unsettled: readonly IntentRecord[];
  /** Documents the host acknowledged in this run, with the committed version. */
  readonly acknowledged: ReadonlyMap<string, string>;
  readonly held: readonly HeldFile[];
  readonly notSent: NotSentReason;
}

/** One row per document, in a stable order: not-committed rows first, then by id. */
export function buildRows(inputs: RowInputs): SyncRow[] {
  const byTarget = new Map<string, IntentRecord[]>();
  for (const row of inputs.unsettled) byTarget.set(row.target, [...(byTarget.get(row.target) ?? []), row]);
  // A pause (quota, sign-in, read-only) stops the push, so the documents after it wait on it.
  let pausedBy: SyncRow | null = null;
  for (const [id, rows] of byTarget) {
    const head = rows[0]!;
    if (head.state !== "refused") continue;
    const row = refusalRow(id, head);
    if (row.state === "paused" || row.reason === "read_only") pausedBy = row;
  }
  const out = new Map<string, SyncRow>();
  for (const [id, rows] of byTarget) {
    const head = rows[0]!;
    switch (head.state) {
      case "conflict": {
        const deleted = head.remote !== undefined && head.remote.version === null;
        out.set(id, {
          id,
          state: "conflict",
          reason: deleted ? "deleted_remotely" : "changed_remotely",
          version: null,
          message: deleted ? DELETED_REMOTELY_MESSAGE : CHANGED_REMOTELY_MESSAGE,
        });
        break;
      }
      case "refused":
        out.set(id, refusalRow(id, head));
        break;
      case "pending":
      case "in_flight":
        out.set(
          id,
          head.attempts > 0
            ? { id, state: "unknown", reason: "possibly_delivered", version: null, message: "The answer was lost; the change may have landed. The next sync looks it up by the same request, never sending it twice." }
            : waitingRow(id, pausedBy, inputs.notSent),
        );
        break;
      default:
        break;
    }
  }
  for (const conflict of inputs.folderConflicts ?? []) {
    if (out.get(conflict.id)?.state === "conflict") continue;
    out.set(conflict.id, {
      id: conflict.id,
      state: "conflict",
      reason: conflict.reason,
      version: null,
      message: conflict.reason === "deleted_remotely" ? DELETED_REMOTELY_MESSAGE : FOLDER_CHANGED_MESSAGE,
    });
  }
  for (const [id, version] of inputs.acknowledged) {
    if (!out.has(id)) out.set(id, { id, state: "committed", reason: "committed", version, message: "Sent and accepted." });
  }
  for (const file of inputs.held) {
    const existing = out.get(file.id);
    if (existing && existing.state !== "committed") continue;
    out.set(file.id, { id: file.id, state: "held", reason: file.reason, version: null, message: `${file.message}. The file stays as it is and nothing is sent.` });
  }
  const order = (row: SyncRow) => (row.state === "committed" ? 1 : 0);
  return [...out.values()].sort((a, b) => order(a) - order(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function countRows(rows: readonly SyncRow[]): Record<RowState, number> {
  const counts = Object.fromEntries(ROW_STATES.map((state) => [state, 0])) as Record<RowState, number>;
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

/**
 * The failure a finished sync reports when any row is not committed, or null. Precedence: a
 * row that needs the person (conflict, held, refused content) is CONFLICT (exit 5); a bundle
 * that refuses writes is FORBIDDEN (exit 2); a pause or a lost answer is TRANSIENT (exit 1).
 */
export function rowsFailure(rows: readonly SyncRow[]): { code: CliErrorCode; message: string } | null {
  const pending = rows.filter((row) => row.state !== "committed");
  if (pending.length === 0) return null;
  const needsPerson = pending.filter((row) => row.state === "conflict" || row.state === "held" || (row.state === "refused" && row.reason !== "read_only"));
  if (needsPerson.length > 0) return { code: "CONFLICT", message: `${pending.length} document(s) not synced; ${needsPerson.length} need your decision` };
  if (pending.some((row) => row.reason === "read_only")) return { code: "FORBIDDEN", message: `${pending.length} document(s) not synced: the host refused writes to this bundle` };
  return { code: "TRANSIENT", message: `${pending.length} document(s) not synced yet; run sync again` };
}

/** The exit that goes with an already-printed receipt: the envelope is not printed again. */
export function receiptFailure(failure: { code: CliErrorCode; message: string }, details: Record<string, unknown>): CliError {
  return new CliError(failure.code, failure.message, { details, handled: true });
}
