/** Typed refusal vocabulary. Consumers branch on `code`, never on message text. */
export const REFUSAL_CODES = Object.freeze({
  /** A write would touch a field the feed does not own, or a Signal write left its bounded set. */
  FIELD_NOT_OWNED: "FIELD_NOT_OWNED",
  /** An owned field diverged from the last accepted feed value. */
  OVERLAY_DOC_CONFLICT: "OVERLAY_DOC_CONFLICT",
  /** More than one document claims the same provider identity. */
  OVERLAY_IDENTITY_AMBIGUOUS: "OVERLAY_IDENTITY_AMBIGUOUS",
  /** The fresh read no longer carries the `sources[]` identity. */
  OVERLAY_IDENTITY_LOST: "OVERLAY_IDENTITY_LOST",
  /** CAS lost: the document changed after planning (retryable). */
  STALE_VERSION: "STALE_VERSION",
  /** The Signal was claimed or closed after planning (retryable). */
  SIGNAL_CLAIMED: "SIGNAL_CLAIMED",
  /** Strict Kind admission refused the candidate. */
  KIND_REJECTED: "KIND_REJECTED",
  /** The candidate violates a declared field type or vocabulary. */
  FIELD_TYPE_VIOLATION: "FIELD_TYPE_VIOLATION",
  /** The input is not well-formed: a plan, an actor, or a candidate core's field actions refuse. */
  INVALID_INPUT: "INVALID_INPUT",
  /** The Source Feed policy cannot be honoured. */
  POLICY_INVALID: "POLICY_INVALID",
} as const);

export type RefusalCode = (typeof REFUSAL_CODES)[keyof typeof REFUSAL_CODES];

/**
 * Codes after which the caller does not advance the record's store entry and plans the same change
 * again: the source engine keeps it pending and replans it at the start of every run, whether or
 * not the provider lists the record again.
 */
export const RETRYABLE: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  REFUSAL_CODES.STALE_VERSION,
  REFUSAL_CODES.SIGNAL_CLAIMED,
]);

/**
 * Refusals that also leave the store entry where it was but are not expected to succeed on a plain
 * retry: the feed's value is not admissible, so it is planned and refused again, visibly, whenever
 * the record is observed, until the provider or the recipe changes.
 */
export const HOLD_STORE: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  ...RETRYABLE,
  REFUSAL_CODES.FIELD_TYPE_VIOLATION,
  REFUSAL_CODES.INVALID_INPUT,
]);

/** Core's Kind findings that refuse a value for its declared type, vocabulary or arity. */
export const CORE_VALUE_CODES: readonly string[] = Object.freeze(["KIND_FIELD_TYPE", "KIND_FIELD_VALUE", "KIND_FIELD_ARITY"]);

export class OverlayRefusal extends Error {
  readonly code: RefusalCode;
  readonly details: Record<string, unknown>;

  constructor(code: RefusalCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OverlayRefusal";
    this.code = code;
    this.details = details;
  }
}
