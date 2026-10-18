/** Typed delivery of an existing frozen blob journal intent. Persistence, fresh claims and
 * checkout locking belong to the caller; this composition owns no retry or authorization policy. */
import { blobReceipt, captureBlobDeletionHold, type BlobDeletionHold, captureBlobIntentRecord, decodePreparedBlobIntent, type BlobIntentRecord, type BlobIntentPatch, type BlobReceipt, type BlobTargetScope } from "../blob-journal.js";
import { captureJournalValue, equalJournalValue } from "../journaled-backend.js";
import { performUncertainWrite, type RecordedWriteOptions, type Sleep, type OperationState } from "../uncertain-write.js";
import { classifyBlobWriteAnswer } from "../hosted-transport/answer-rows.js";
import { isAcceptedDeletionCount } from "../hosted-transport/carrier.js";
import type { HostedBlobWriteAdapter } from "../hosted-transport/blob-write.js";

export interface HostedBlobDeliveryContext {
  /** Separately trusted current checkout target, never selected from a journal record. */
  scope: BlobTargetScope;
  /** Trusted caller contract: close over that fixed target, scoped carrier and fresh capability
   * provider; create an adapter bound to the supplied lifetime. The record supplies no authority. */
  adapterFor(signal: AbortSignal): HostedBlobWriteAdapter;
}
export type HostedBlobDeliveryOptions = Omit<RecordedWriteOptions, "settlement"> & {
  /** Admission only, for this delete submission. Never persisted or sent on lookup. */
  acceptDeletes?: number;
};
export type HostedBlobDeliveryOutcome =
  | { kind: "committed"; receipt: Extract<BlobReceipt, { result: { ok: true } }> }
  | { kind: "conflict"; receipt: Extract<BlobReceipt, { result: { ok: false } }> }
  | { kind: "refused"; code: string; message: string; receipt: Extract<BlobReceipt, { result: { ok: false } }> }
  | { kind: "not-executed"; attempts: number; details: BlobDeletionHold }
  | { kind: "unknown" };
export interface HostedBlobDeliveryResult {
  attempts: number;
  state: OperationState;
  lookups: number;
  outcome: HostedBlobDeliveryOutcome;
  /** Pass only this patch to the existing full-guard updateBlobIntent transaction. */
  patch: BlobIntentPatch;
}
const UNKNOWN = Object.freeze({ kind: "unknown" as const });
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
  return value;
}
const sleepTimer: Sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

/** A submit-claimed call requires a freshly durable in_flight CAS under the checkout lock.
 * Reopened/unclear claims MUST use lookup; absence never proves an older delivery cannot commit.
 * This function persists nothing. The caller subsequently applies patch under its full guard.
 * deadlineMs bounds each lookup as well as the primitive's submission deadline; without it,
 * the supplied wire carrier retains its own deadline. Caller cancellation ends either path. */
export async function performHostedBlobDelivery(context: HostedBlobDeliveryContext, record: BlobIntentRecord, options: HostedBlobDeliveryOptions): Promise<HostedBlobDeliveryResult> {
  const row = captureBlobIntentRecord(record);
  const prepared = freeze(decodePreparedBlobIntent(row.prepared));
  const scope = captureJournalValue(context.scope), adapterFor = context.adapterFor;
  const copied = { ...options };
  if (!equalJournalValue(scope, prepared.scope)) throw new TypeError("blob delivery target does not match the trusted checkout scope");
  if (typeof adapterFor !== "function" || row.receipt !== undefined) throw new TypeError("blob delivery requires an adapter factory and an unsettled journal record");
  if (Object.keys(copied).some(key => !["start", "signal", "deadlineMs", "maxLookups", "lookupDelayMs", "sleep", "acceptDeletes"].includes(key))) throw new TypeError("unsupported blob delivery options");
  const { start, signal, deadlineMs, maxLookups, lookupDelayMs, sleep, acceptDeletes } = copied;
  for (const [name, value] of [["deadlineMs", deadlineMs], ["maxLookups", maxLookups], ["lookupDelayMs", lookupDelayMs]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (name === "maxLookups" ? 1 : 0))) throw new TypeError("invalid blob delivery timing bound");
  }
  if (sleep !== undefined && typeof sleep !== "function") throw new TypeError("invalid blob delivery timer");
  if (acceptDeletes !== undefined && (start !== "submit-claimed" || prepared.intent.operationId !== "blobs.delete.v1" || !isAcceptedDeletionCount(acceptDeletes))) throw new TypeError("acceptDeletes belongs only to this delete submission");
  // Only a host deletion hold needs acceptance; a prefix proven by not-dispatched evidence alone resends as is.
  if (start === "submit-claimed" && row.deletionHold !== undefined && (acceptDeletes === undefined || acceptDeletes < row.deletionHold.deletions)) throw new TypeError("held deletion continuation requires current invocation acceptance of its held count");
  const bytes = prepared.bytesBase64 === undefined ? undefined : Uint8Array.from(atob(prepared.bytesBase64), c => c.charCodeAt(0));

  // Each adapter receives one combined lifetime. Race cancellation even if a caller-supplied
  // port hangs, and remove listeners/timers when that individual operation is finished.
  async function call<T>(attempt: AbortSignal | undefined, lookup: boolean, work: (adapter: HostedBlobWriteAdapter) => Promise<T>): Promise<T> {
    const controller = new AbortController(), timer = new AbortController();
    const watched = [...new Set([signal, attempt].filter((s): s is AbortSignal => s !== undefined))];
    const abort = () => controller.abort();
    for (const source of watched) { if (source.aborted) abort(); else source.addEventListener("abort", abort, { once: true }); }
    let interrupted: (() => void) | undefined;
    try {
      if (controller.signal.aborted) throw new Error("blob delivery cancelled");
      const cancelled = new Promise<never>((_resolve, reject) => {
        interrupted = () => reject(new Error("blob delivery cancelled or timed out"));
        controller.signal.addEventListener("abort", interrupted, { once: true });
      });
      if (lookup && deadlineMs !== undefined) {
        void Promise.resolve().then(() => (sleep ?? sleepTimer)(deadlineMs, timer.signal)).then(() => { if (!timer.signal.aborted) abort(); }, abort);
      }
      const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("blob delivery cancelled");
        return work(adapterFor(controller.signal));
      });
      return await Promise.race([operation, cancelled]);
    } finally {
      timer.abort();
      for (const source of watched) source.removeEventListener("abort", abort);
      if (interrupted) controller.signal.removeEventListener("abort", interrupted);
      controller.abort();
    }
  }
  function candidate(raw: unknown): HostedBlobDeliveryOutcome {
    const receipt = freeze(blobReceipt(row.prepared, raw));
    if (receipt.result.ok) return freeze({ kind: "committed", receipt } as HostedBlobDeliveryOutcome);
    if (receipt.result.error.code === "version_conflict") return freeze({ kind: "conflict", receipt } as HostedBlobDeliveryOutcome);
    return freeze({ kind: "refused", code: receipt.result.error.code, message: receipt.result.error.message, receipt } as HostedBlobDeliveryOutcome);
  }
  const selected = await performUncertainWrite({
    async submit(_intent, attempt): Promise<HostedBlobDeliveryOutcome> {
      try {
        const answer = await call(attempt?.signal, false, adapter => adapter.send(prepared.intent, { ...prepared.identity, ...(acceptDeletes === undefined ? {} : { acceptDeletes }) }, bytes));
        if (answer.status === 428 && answer.result !== undefined && !answer.result.ok && prepared.intent.operationId === "blobs.delete.v1") {
          const classified = classifyBlobWriteAnswer({ status: 428, body: { error: answer.result.error }, headers: new Headers() }, prepared.intent);
          const captured = classified.result;
          if (captured && !captured.ok && equalJournalValue(captured, answer.result) && classified.row.answer === "428 deletions_held" && equalJournalValue(classified.row, answer.row) && captured.error.writeState === "not_applied" && (row.notAppliedThrough ?? 0) === row.attempts - 1) {
            return freeze({ kind: "not-executed", attempts: row.attempts, details: captureBlobDeletionHold({ deletions: captured.error.deletions!, baseline: captured.error.baseline! }) });
          }
          return UNKNOWN;
        }
        if (answer.status !== 200 || answer.result === undefined) return UNKNOWN;
        const classified = classifyBlobWriteAnswer({ status: 200, body: answer.result, headers: new Headers() }, prepared.intent);
        if (classified.row.answer !== answer.row.answer || classified.row.recorded !== answer.row.recorded || classified.row.outcome !== answer.row.outcome ||
            !(answer.row.recorded === "yes" || answer.row.recorded === "settled-only" && answer.settled === true)) return UNKNOWN;
        return candidate(classified.result!);
      } catch { return UNKNOWN; }
    },
    async lookup(): Promise<HostedBlobDeliveryOutcome> {
      // Availability failures remain failures for the existing bounded lookup owner. Absence
      // and malformed terminal evidence are inconclusive outcomes, never resend permission.
      const answer = await call(undefined, true, adapter => adapter.lookup(prepared.intent, prepared.identity));
      try {
        if (answer.status !== "committed" && answer.status !== "refused") return UNKNOWN;
        const outcome = candidate(answer.result);
        if ((answer.status === "committed") !== (outcome.kind === "committed")) return UNKNOWN;
        return outcome;
      } catch { return UNKNOWN; }
    },
  }, { requestId: row.requestId, kind: prepared.intent.operationId, target: row.target, createdAt: prepared.createdAt, attempts: row.attempts, state: row.state, notAppliedThrough: row.notAppliedThrough ?? 0 },
  { settlement: "recorded-only", start, signal, deadlineMs, maxLookups, lookupDelayMs, sleep });
  const outcome = selected.outcome;
  const patch = { state: selected.intent.state, attempts: selected.intent.attempts, ...(outcome.kind === "unknown" ? {} : outcome.kind === "not-executed" ? { notAppliedThrough: outcome.attempts, deletionHold: outcome.details } : { receipt: outcome.receipt }) };
  return freeze({ attempts: selected.intent.attempts, state: selected.intent.state, lookups: selected.lookups, outcome, patch });
}
