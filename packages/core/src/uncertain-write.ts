/**
 * The shared uncertain-write primitive: durable request identity, unknown-outcome handling, and
 * acknowledgement reconciliation for a write whose delivery to a shared authority may be lost.
 *
 * A network write has three answers, not two: the authority applied it, refused it, or the
 * client cannot tell (a dropped response, a timeout, a transport error). Retrying a write in the
 * third case is only safe when the authority can recognize the retry as the same request, so
 * every write carries a {@link OperationIntent.requestId} minted once when the intent is first
 * recorded and never reminted, and every transport offers {@link OperationTransport.lookup} to
 * fetch the authority's recorded outcome for that id.
 *
 * This module is owned by core so the browser-local sync component and bounded CLI remote
 * operations consume one primitive rather than each defining unknown-outcome handling. It
 * imports no Node builtin and bundles for the browser. The only injected time source is the
 * `sleep` used for the submission deadline and the delay between lookups; there is no
 * injectable clock, and a transport's own latency is real.
 */

import type { Version } from "./types.js";

/**
 * The operation an intent performs: a whole-document write, or `document.delete` (the document
 * leaves at exactly the intent's base). The union is open.
 */
export type OperationKind = "document.write" | "document.delete" | (string & {});

/**
 * The journal states of an intent. `unknown` is the primitive's own classification of an
 * exhausted attempt: the authority may or may not hold the write, and a later attempt begins
 * with a lookup rather than a submission.
 */
export type OperationState = "pending" | "in_flight" | "acknowledged" | "conflict" | "refused" | "unknown";

/** A recorded local write awaiting a shared outcome. */
export interface OperationIntent {
  /** Durable request identity: minted once at record time, reused verbatim on every retry. */
  requestId: string;
  kind: OperationKind;
  /** The target the operation applies to; a concept id for `document.write`. */
  target: string;
  /**
   * The tombstone a create acknowledges it re-creates: the id's latest deletion, as the
   * authority named it. Set only by an explicit decision to re-create a deleted document (the
   * caller's own observed delete, or `keep` on a "deleted remotely" conflict), and only on a
   * create recorded after that decision; never inferred by a transport. An authority whose latest
   * deletion of the id is another one refuses the create, and the refusal comes back as a
   * conflict.
   */
  recreates?: Version;
  /** The shared version the local edit was made against, or `null` for a create. */
  base: Version | null;
  /** The content-addressed version of `content`. */
  local: Version;
  /** The serialized document: the comparison content reconciliation needs later. */
  content: string;
  createdAt: string;
  /**
   * Submissions made or durably claimed so far. A non-zero count means the authority may already
   * hold the write, so delivery begins with a lookup rather than a submission; a journal records
   * the count before a submission leaves, never only after its outcome is known.
   */
  attempts: number;
  state: OperationState;
}

/** The authority's answer for one request identity. */
export type Outcome =
  | { kind: "committed"; version: Version }
  /**
   * The shared head moved. `actual` is the version the authority serves now, or `null` when it
   * serves none ("deleted remotely"). With `actual: null`, `tombstone` names the deletion the
   * authority reported, when it reported one: the acknowledgement a deliberate re-create sends.
   * It is never a version any read serves, so it is never a base or a remote version.
   */
  | { kind: "conflict"; actual: Version | null; tombstone?: Version }
  /**
   * `executed` is present only on a refusal that is not the identity's recorded answer: `false`
   * when this attempt was refused before it could execute (nothing was sent, or the authority
   * refused it before dispatch), `"unknown"` when the authority's answer does not say. Such a
   * refusal is evidence about this attempt only, never about an earlier delivery of the identity.
   */
  | { kind: "refused"; code: string; message: string; executed?: false | "unknown" }
  /**
   * `refusal` names the attempt-only refusal that ended the call, when one did: a resend refused
   * before execution while an earlier delivery may still be held. The identity stays unknown;
   * the refusal says why it could not be settled now (for example, access withdrawn).
   */
  | { kind: "unknown"; refusal?: { code: string; message: string } };

/**
 * A lookup's answer that the authority holds the identity without a result yet: a delivery of
 * it was admitted and may still commit. Distinct from `null`, which says it was never admitted.
 */
export interface LookupPending {
  kind: "pending";
}

/** The one {@link LookupPending} answer. */
export const LOOKUP_PENDING: LookupPending = Object.freeze({ kind: "pending" });

/** A transport to a shared authority that records outcomes by request identity. */
export interface OperationTransport {
  /** Deliver the intent once; a repeated `requestId` must return the recorded outcome unchanged. */
  submit(intent: OperationIntent, options?: { signal?: AbortSignal }): Promise<Outcome>;
  /**
   * The recorded outcome for `requestId`; {@link LookupPending} when the authority holds it
   * unanswered; or `null` when the authority never recorded it. A transport that cannot tell
   * pending from absent answers `null` for both.
   */
  lookup(requestId: string): Promise<Outcome | LookupPending | null>;
}

/** Minimal classification for recorded-only delivery. A commit need not invent a new-head
 * version (for example, an identified blob delete can carry its complete absence receipt). */
export interface NonExecutedAttempt { kind: "not-executed"; attempts: number; details: unknown }
export type RecordedWriteOutcome =
  | NonExecutedAttempt
  | { kind: "committed" }
  | { kind: "conflict" }
  | { kind: "refused"; code: string; message: string }
  | { kind: "unknown" };
export type RecordedWriteIntent = Pick<OperationIntent, "requestId" | "kind" | "target" | "createdAt" | "attempts" | "state"> & {
  /** Opt-in qualification; old no-prefix explicit callers retain their contract. */
  notAppliedThrough?: number;
};
export interface RecordedWriteTransport<I extends RecordedWriteIntent, O extends RecordedWriteOutcome> {
  submit(intent: I, options?: { signal?: AbortSignal }): Promise<O>;
  /** Null/absence is inconclusive and NEVER grants this path permission to submit. */
  lookup(requestId: string): Promise<O | null>;
}
/** Explicit starts are for callers that own persistence, not proof minted by this primitive.
 * submit-claimed requires a freshly successful durable in_flight CAS, held under the checkout
 * lock, immediately before this call; its counted attempt is sent at most once. After reopening,
 * or when that freshness cannot be established, use lookup. Replaying a stored claim is NOT a
 * fresh CAS. Nor does a new CAS prove an earlier unclear delivery cannot still commit: those
 * identities must use lookup. This function creates no ticket or journal persistence itself. */
export type RecordedWriteOptions = Omit<UncertainWriteOptions, "settlement" | "maxSubmissions" | "earlierDeliveryUnclear"> & {
  settlement: "recorded-only";
  start: "submit-claimed" | "lookup";
};
export interface RecordedWriteResult<I extends RecordedWriteIntent, O extends RecordedWriteOutcome> {
  intent: Omit<I, "attempts" | "state"> & Pick<RecordedWriteIntent, "attempts" | "state">;
  outcome: O | { kind: "unknown" };
  lookups: number;
}

/** Wait `ms`, resolving early and harmlessly when `signal` aborts. Injected by tests. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface UncertainWriteOptions {
  /** Exact-content writes may settle matching conflicts; governed writes require recorded evidence. */
  settlement?: "exact-content" | "recorded-only";
  /** How long one submission may take before its outcome is treated as unknown. */
  deadlineMs?: number;
  /** Lookups attempted after an unknown submission before giving up (default 3). */
  maxLookups?: number;
  /** Delay between lookups (default 250 ms; the injected `sleep` decides what that means). */
  lookupDelayMs?: number;
  /** Submissions permitted in one call, counting the first (default 2). */
  maxSubmissions?: number;
  /** Timer; defaults to a `setTimeout` sleep. */
  sleep?: Sleep;
  /**
   * Ends the call early once aborted: no further lookup or resubmission starts, the wait between
   * lookups is cut short, and the outcome is `unknown` unless one was already known. Absent, the
   * call runs every lookup and submission it is permitted.
   */
  signal?: AbortSignal;
  /**
   * The intent's earlier submission, made by an earlier call, ended without a definitive answer
   * (its outcome was unknown, or the call stopped while it was in flight). A resubmission refused
   * before execution is then `unknown`, as one after an unclear submission in this call is.
   * Default false: an earlier submission answered with such a refusal (a paused intent requeued)
   * may be resent and refused again definitively.
   */
  earlierDeliveryUnclear?: boolean;
}

export interface UncertainWriteResult {
  /** The intent with `attempts` and `state` advanced to reflect this call. */
  intent: OperationIntent;
  outcome: Outcome;
  /** How many times `lookup` was called in this call. */
  lookups: number;
}

/**
 * Refusal codes that pause shared operations rather than say the content is wrong: the caller's
 * authorization is gone, or a hosted sync quota (`REQUEST_CAPACITY_*`, one per scope the host
 * names) is spent. Nothing is lost; the refused intents are requeued when the store resumes.
 */
export const AUTHORIZATION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
  "REQUEST_CAPACITY_PRINCIPAL",
  "REQUEST_CAPACITY_BUNDLE",
]);

/** True when a refusal reports lost permission, which pauses further shared operations. */
export function isAuthorizationRefusal(outcome: Outcome | RecordedWriteOutcome): boolean {
  return outcome.kind === "refused" && AUTHORIZATION_REFUSAL_CODES.has(outcome.code);
}

/**
 * True when a resend's refusal cannot settle an identity whose earlier delivery is unclear. An
 * authorization refusal never can: access lost now says nothing about a delivery authorized
 * earlier. Once a lookup answered {@link LookupPending}, an earlier delivery is known to be held,
 * so no refusal the transport marks as attempt-only (`executed`) can either. Without that
 * answer, a marked refusal of the same bytes (a schema `400`, the mass-delete hold) settles, as
 * it would refuse a delayed first delivery too.
 */
function refusalLeavesUnknown(outcome: RecordedWriteOutcome, held: boolean): outcome is Extract<RecordedWriteOutcome, { kind: "refused" }> {
  return outcome.kind === "refused" && (isAuthorizationRefusal(outcome) || (held && (outcome as { executed?: unknown }).executed !== undefined));
}

/** The journal state an outcome settles an intent into. */
export function stateForOutcome(outcome: Outcome | RecordedWriteOutcome): OperationState {
  switch (outcome.kind) {
    case "committed":
      return "acknowledged";
    case "conflict":
      return "conflict";
    case "refused":
      return "refused";
    case "not-executed":
      return "pending";
    case "unknown":
      return "unknown";
  }
}

/** The longest request identity the wire accepts as `Idempotency-Key`. */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * True when `value` is a request identity the wire accepts: 1 to {@link REQUEST_ID_MAX_LENGTH}
 * printable ASCII characters with no space, and neither `.` nor `..`, which URL normalization
 * folds away so the lookup route could never name them. One rule, checked by the client before
 * a header is built and by the reference router before a key is claimed, so the two sides cannot
 * disagree about which keys identify a write. A minted UUID always satisfies it.
 */
export function isRequestIdentity(value: string): boolean {
  if (value === "." || value === "..") return false;
  return value.length >= 1 && value.length <= REQUEST_ID_MAX_LENGTH && /^[!-~]+$/.test(value);
}

/** A fresh request identity. UUIDs come from the platform's `crypto` in both Node and browsers. */
export function mintRequestId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  throw new Error("mintRequestId requires crypto.randomUUID in this host.");
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const UNKNOWN: Outcome = { kind: "unknown" };

/**
 * The outcome as it applies to `intent`. A conflict whose `actual` is the intent's own `local`
 * version means the shared head already holds exactly this content, so the write is committed
 * at that version. This is the wire's post-expiry compare-and-swap property: a committed write
 * whose acknowledgement was lost and whose recorded outcome expired from the authority's
 * retention window is resubmitted with its original `base`, which no longer matches, and the
 * authority answers a conflict against the version the client itself committed. If the head
 * has meanwhile returned to `base` exactly, the premise matches and the resubmission is applied
 * again instead (see {@link performUncertainWrite}). The mapping depends only on the outcome and
 * the intent, so the primitive owns it and every consumer settles such a write as acknowledged
 * rather than presenting it as a concurrent edit. Every other conflict, including one against
 * an absent head (`actual: null`), is returned unchanged.
 */
export function settleAgainstIntent(outcome: Outcome, intent: OperationIntent): Outcome {
  if (outcome.kind === "conflict" && outcome.actual !== null && outcome.actual === intent.local) {
    return { kind: "committed", version: outcome.actual };
  }
  return outcome;
}

/**
 * One submission under a deadline. A transport rejection or a deadline overrun both yield
 * `unknown`: the request may have reached the authority, so nothing here decides otherwise.
 */
async function submitOnce<I extends RecordedWriteIntent, O extends RecordedWriteOutcome>(transport: Pick<RecordedWriteTransport<I, O>, "submit">, intent: I, deadlineMs: number | undefined, sleep: Sleep): Promise<O | typeof UNKNOWN> {
  const controller = new AbortController();
  const attempt = transport.submit(intent, { signal: controller.signal }).then(
    (outcome) => ({ settled: true as const, outcome }),
    () => ({ settled: true as const, outcome: UNKNOWN }),
  );
  if (deadlineMs === undefined) return (await attempt).outcome;
  const timerControl = new AbortController();
  const deadline = sleep(deadlineMs, timerControl.signal).then(() => ({ settled: false as const }));
  const first = await Promise.race([attempt, deadline]);
  if (first.settled) {
    timerControl.abort();
    return first.outcome;
  }
  controller.abort();
  return UNKNOWN;
}

/**
 * Deliver `intent` and settle it against the authority's recorded outcome.
 *
 * Flow: when the intent has never been submitted, submit it; when it has (`attempts > 0`), or
 * when a submission's outcome is unknown, look the request identity up. A positive lookup
 * settles the intent. A `null` lookup is taken as proof that the authority never recorded the
 * request, so a resubmission with the same `requestId` is the first delivery and is allowed, up
 * to `maxSubmissions`. A lookup that fails leaves the outcome unknown and the intent for a later
 * call.
 *
 * No resubmission happens without a `null` lookup because a blind retry after an unknown
 * outcome is unsound: on an authority without request identity the retry applies the write
 * twice, and even on one with it the retry can only ever learn what the lookup already knew.
 * The lookup is what turns "unknown" into a fact before any second delivery.
 *
 * That fact is only as good as the transport's `null`. An authority that has expired or lost a
 * record answers as if it never recorded it, and the reference wire transport returns `null`
 * then. The resubmission is guarded only by its `base`, and versions are content hashes: if the
 * write had landed and a third party has since restored `base` exactly, the premise matches, the
 * write is applied a second time over that revert, and the outcome is `committed`. The hosted
 * transport never answers `null` for an absent record once the intent is older than the host's
 * stated retention window, less a skew margin, so it does not resubmit there.
 *
 * A refusal before execution ({@link isAuthorizationRefusal}) of a resubmission that follows an
 * unclear submission (in this call, or an earlier one per `earlierDeliveryUnclear`) is `unknown`,
 * carrying that refusal, not settled: a `null` lookup cannot prove an earlier delivery will not
 * still arrive, and the delivery can still commit. After a {@link LookupPending} answer, which
 * says a delivery is held, the same holds for every refusal the transport marks `executed`
 * (a gateway's `400` included). A pending lookup still permits the resubmission.
 *
 * By default every outcome passes through {@link settleAgainstIntent}, so a conflict naming the
 * intent's own version is committed. `recorded-only` preserves the recorded outcome instead.
 */
export function performUncertainWrite<I extends RecordedWriteIntent, O extends RecordedWriteOutcome>(
  transport: RecordedWriteTransport<I, O>, intent: I, options: RecordedWriteOptions,
): Promise<RecordedWriteResult<I, O>>;
/** Compatibility path: a complete document intent, with the existing counters/resubmission
 * defaults. Body delivery's recorded-only call without start remains on this path. */
export function performUncertainWrite(
  transport: OperationTransport, intent: OperationIntent, options?: UncertainWriteOptions,
): Promise<UncertainWriteResult>;
export async function performUncertainWrite(
  transport: { submit: RecordedWriteTransport<RecordedWriteIntent, RecordedWriteOutcome>["submit"]; lookup(requestId: string): Promise<RecordedWriteOutcome | LookupPending | null> },
  intent: RecordedWriteIntent,
  options: UncertainWriteOptions & { start?: "submit-claimed" | "lookup" } = {},
): Promise<RecordedWriteResult<RecordedWriteIntent, RecordedWriteOutcome>> {
  const explicitStart = "start" in options;
  if (explicitStart) {
    if (options.settlement !== "recorded-only" || (options.start !== "submit-claimed" && options.start !== "lookup") ||
        !Number.isSafeInteger(intent.attempts) || intent.attempts < 0 ||
        !["pending", "in_flight", "acknowledged", "conflict", "refused", "unknown"].includes(intent.state) ||
        (options.start === "submit-claimed" && (intent.state !== "in_flight" || intent.attempts < 1))) throw new Error("Invalid recorded-only delivery start or durable claim.");
    if (intent.notAppliedThrough !== undefined && (!Number.isSafeInteger(intent.notAppliedThrough) || intent.notAppliedThrough < 0 || intent.notAppliedThrough > intent.attempts || options.start === "submit-claimed" && intent.notAppliedThrough !== intent.attempts - 1)) throw new Error("Invalid recorded-only non-execution prefix or durable claim.");
    // Capture the descriptor before the first asynchronous boundary. Additional prepared data
    // belongs to the typed caller; the primitive neither fabricates nor interprets its fields.
    intent = { ...intent };
    options = { ...options };
  }
  if (options.settlement !== undefined && options.settlement !== "exact-content" && options.settlement !== "recorded-only") {
    throw new Error("Unknown uncertain-write settlement mode.");
  }
  const sleep = options.sleep ?? defaultSleep;
  const maxLookups = Math.max(1, options.maxLookups ?? 3);
  const maxSubmissions = explicitStart ? 1 : Math.max(1, options.maxSubmissions ?? 2);
  const lookupDelayMs = options.lookupDelayMs ?? 250;
  const { signal } = options;
  // Whether a submission of this identity may still be held by the authority unanswered.
  let unclear = options.earlierDeliveryUnclear === true && intent.attempts > 0;
  // Whether a lookup in this call answered pending: a delivery of this identity is held.
  let held = false;

  let attempts = intent.attempts;
  let submissions = 0;
  let lookups = 0;
  const finish = (raw: RecordedWriteOutcome): RecordedWriteResult<RecordedWriteIntent, RecordedWriteOutcome> => {
    // Only the compatibility overload admits exact-content settlement and it requires the
    // original full OperationIntent/Outcome contract. Explicit starts never use those fields.
    const outcome = options.settlement === "recorded-only" ? raw : settleAgainstIntent(raw as Outcome, intent as OperationIntent);
    return { intent: { ...intent, attempts, state: stateForOutcome(outcome) }, outcome, lookups };
  };

  // A previously submitted intent starts at the lookup, never at a submission.
  let needSubmission = explicitStart ? options.start === "submit-claimed" : attempts === 0;
  for (;;) {
    if (needSubmission) {
      if (submissions >= maxSubmissions || ((explicitStart || submissions > 0) && signal?.aborted)) return finish(UNKNOWN);
      submissions += 1;
      if (!explicitStart) attempts += 1;
      const outcome = await submitOnce(transport, { ...intent, attempts, state: "in_flight" }, options.deadlineMs, sleep);
      if (outcome.kind === "not-executed") {
        if (!explicitStart || intent.notAppliedThrough === undefined || intent.notAppliedThrough !== attempts - 1 || outcome.attempts !== attempts || signal?.aborted) return finish(UNKNOWN);
        return finish(outcome);
      }
      // A resend refused before it reached execution (no credential, access withdrawn, a spent
      // quota, a gateway's schema check) is evidence about that resend only: an earlier, unclear delivery may still be held
      // by the authority and commit, so the identity stays unknown and the intent is kept.
      if (unclear && refusalLeavesUnknown(outcome, held))
        return finish(explicitStart ? UNKNOWN : ({ kind: "unknown", refusal: { code: outcome.code, message: outcome.message } } satisfies Outcome));
      if (outcome.kind !== "unknown") return finish(outcome);
      unclear = true;
    }
    needSubmission = false;
    let recorded: RecordedWriteOutcome | LookupPending | null | undefined;
    for (let round = 0; round < maxLookups; round++) {
      if (signal?.aborted) break;
      if (round > 0) await sleep(lookupDelayMs, signal);
      if (signal?.aborted) break;
      lookups += 1;
      try {
        recorded = await transport.lookup(intent.requestId);
      } catch {
        recorded = undefined;
        continue;
      }
      break;
    }
    if (recorded === undefined) return finish(UNKNOWN);
    if (recorded !== null && recorded.kind === "pending") {
      // Held unanswered: a delivery of this identity was admitted and may still commit.
      unclear = true;
      held = true;
      recorded = null;
    }
    if (recorded !== null) return finish(recorded.kind === "not-executed" ? UNKNOWN : recorded);
    if (explicitStart) return finish(UNKNOWN);
    needSubmission = true;
  }
}
