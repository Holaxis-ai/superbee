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
 * imports no Node builtin and bundles for the browser; timers are injectable so tests run
 * deterministically.
 */

import type { Version } from "./types.js";

/** The operation an intent performs. Only document writes exist today; the union is open. */
export type OperationKind = "document.write" | (string & {});

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
  /** The shared version the local edit was made against, or `null` for a create. */
  base: Version | null;
  /** The content-addressed version of `content`. */
  local: Version;
  /** The serialized document: the comparison content reconciliation needs later. */
  content: string;
  createdAt: string;
  /** Submissions made so far; a non-zero count means the authority may already hold the write. */
  attempts: number;
  state: OperationState;
}

/** The authority's answer for one request identity. */
export type Outcome =
  | { kind: "committed"; version: Version }
  | { kind: "conflict"; actual: Version | null }
  | { kind: "refused"; code: string; message: string }
  | { kind: "unknown" };

/** A transport to a shared authority that records outcomes by request identity. */
export interface OperationTransport {
  /** Deliver the intent once; a repeated `requestId` must return the recorded outcome unchanged. */
  submit(intent: OperationIntent, options?: { signal?: AbortSignal }): Promise<Outcome>;
  /** The recorded outcome for `requestId`, or `null` when the authority never recorded it. */
  lookup(requestId: string): Promise<Outcome | null>;
}

/** Wait `ms`, resolving early and harmlessly when `signal` aborts. Injected by tests. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface UncertainWriteOptions {
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
}

export interface UncertainWriteResult {
  /** The intent with `attempts` and `state` advanced to reflect this call. */
  intent: OperationIntent;
  outcome: Outcome;
  /** How many times `lookup` was called in this call. */
  lookups: number;
}

/** Refusal codes that mean the caller's authorization is gone rather than the content wrong. */
export const AUTHORIZATION_REFUSAL_CODES: ReadonlySet<string> = new Set(["AUTH_REQUIRED", "FORBIDDEN", "UNAUTHORIZED", "PERMISSION_DENIED"]);

/** True when a refusal reports lost permission, which pauses further shared operations. */
export function isAuthorizationRefusal(outcome: Outcome): boolean {
  return outcome.kind === "refused" && AUTHORIZATION_REFUSAL_CODES.has(outcome.code);
}

/** The journal state an outcome settles an intent into. */
export function stateForOutcome(outcome: Outcome): OperationState {
  switch (outcome.kind) {
    case "committed":
      return "acknowledged";
    case "conflict":
      return "conflict";
    case "refused":
      return "refused";
    case "unknown":
      return "unknown";
  }
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
 * One submission under a deadline. A transport rejection or a deadline overrun both yield
 * `unknown`: the request may have reached the authority, so nothing here decides otherwise.
 */
async function submitOnce(transport: OperationTransport, intent: OperationIntent, deadlineMs: number | undefined, sleep: Sleep): Promise<Outcome> {
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
 * settles the intent. A `null` lookup proves the authority never recorded the request, so a
 * resubmission with the same `requestId` is the first delivery and is allowed, up to
 * `maxSubmissions`. A lookup that fails leaves the outcome unknown and the intent for a later
 * call.
 *
 * No resubmission happens without a `null` lookup because a blind retry after an unknown
 * outcome is unsound in both directions: if the earlier delivery committed, the retry's
 * `base` no longer matches the shared head and the authority answers with a conflict against
 * the intent's own write, which the client would then present as a concurrent edit; and on an
 * authority without request identity the retry applies the write twice. The lookup is what
 * turns "unknown" into a fact before any second delivery.
 */
export async function performUncertainWrite(
  transport: OperationTransport,
  intent: OperationIntent,
  options: UncertainWriteOptions = {},
): Promise<UncertainWriteResult> {
  const sleep = options.sleep ?? defaultSleep;
  const maxLookups = Math.max(1, options.maxLookups ?? 3);
  const maxSubmissions = Math.max(1, options.maxSubmissions ?? 2);
  const lookupDelayMs = options.lookupDelayMs ?? 250;

  let attempts = intent.attempts;
  let submissions = 0;
  let lookups = 0;
  const finish = (outcome: Outcome): UncertainWriteResult => ({
    intent: { ...intent, attempts, state: stateForOutcome(outcome) },
    outcome,
    lookups,
  });

  // A previously submitted intent starts at the lookup, never at a submission.
  let needSubmission = attempts === 0;
  for (;;) {
    if (needSubmission) {
      if (submissions >= maxSubmissions) return finish(UNKNOWN);
      submissions += 1;
      attempts += 1;
      const outcome = await submitOnce(transport, { ...intent, attempts, state: "in_flight" }, options.deadlineMs, sleep);
      if (outcome.kind !== "unknown") return finish(outcome);
    }
    needSubmission = false;
    let recorded: Outcome | null | undefined;
    for (let round = 0; round < maxLookups; round++) {
      if (round > 0) await sleep(lookupDelayMs);
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
    if (recorded !== null) return finish(recorded);
    needSubmission = true;
  }
}
