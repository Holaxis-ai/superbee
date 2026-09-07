/**
 * OKF v0.2 `verified` events and the trust tier consumers derive from them (SPEC 5.2, 5.3).
 *
 * Read side: `verified` is a list of `{ by, at }` events. A producer MAY write a single event as
 * a bare mapping; consumers MUST treat it as a one-element list. Every surface that classifies
 * trust reads through {@link verificationEvents} so the normalization exists exactly once.
 *
 * Write side: {@link appendVerificationEvent} is the one policy that adds an event. It preserves
 * existing events byte-for-byte (including producer extras such as `method`), normalizes a bare
 * mapping into the list it already meant, and refuses to append onto a `verified` value that is
 * not a list of events rather than silently replacing it.
 *
 * Pure and dependency-light on purpose: the browser UI consumes it through the
 * `@superbee/core/verification` subpath without pulling the storage engine.
 */
import { InvalidInputError, OkfActorError } from "./errors.js";
import { isHumanActor, isOkfActor } from "./okf-actor.js";

/** One verification event. Producer extras beyond `by`/`at` are preserved, never interpreted. */
export interface VerificationEvent {
  by: string;
  at?: string;
  [extra: string]: unknown;
}

/** Trust tiers, lowest to highest (SPEC 5.3). */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/** The three tiers in ascending order — the one place a consumer iterates them. */
export const TRUST_TIERS: readonly TrustTier[] = Object.freeze([
  "unverified",
  "machine-confirmed",
  "human-reviewed",
]);

/** The derived projection name surfaces expose (`list --fields trust`, receipts, status counts). */
export const TRUST_TIER_FIELD = "trust";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEvent(value: unknown): value is VerificationEvent {
  return isRecord(value) && typeof value.by === "string" && value.by.trim() !== "";
}

/**
 * The document's verification events as the list the spec defines, or `[]` when the key is absent.
 * A bare `{ by, at }` mapping reads as a one-element list (SPEC 5.2 MUST). Entries that carry no
 * usable `by` cannot name a verifier and therefore cannot raise a tier; they are skipped here, and
 * {@link appendVerificationEvent} refuses to write around them.
 */
export function verificationEvents(frontmatter: Readonly<Record<string, unknown>>): VerificationEvent[] {
  const raw = frontmatter.verified;
  if (raw === undefined || raw === null) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  return entries.filter(isEvent).map((event) => ({ ...event }));
}

/** Derive the trust tier (SPEC 5.3): keyed on the `human:` prefix of any verifier. */
export function trustTier(frontmatter: Readonly<Record<string, unknown>>): TrustTier {
  const events = verificationEvents(frontmatter);
  if (events.length === 0) return "unverified";
  return events.some((event) => isHumanActor(event.by)) ? "human-reviewed" : "machine-confirmed";
}

/** The latest parseable `at` across the events ("how recently" per SPEC 5.2), or `undefined`. */
export function latestVerifiedAt(events: readonly VerificationEvent[]): string | undefined {
  let latest: { at: string; ms: number } | undefined;
  for (const event of events) {
    if (typeof event.at !== "string") continue;
    const ms = storedInstant(event.at);
    if (ms === null) continue;
    if (latest === undefined || ms > latest.ms) latest = { at: event.at, ms };
  }
  return latest?.at;
}

/** Documents per tier — the one fold `status` and `home` both render. */
export type TrustTierCounts = Record<TrustTier, number>;

export function trustTierCounts(
  docs: Iterable<{ frontmatter: Readonly<Record<string, unknown>> }>,
): TrustTierCounts {
  const counts: TrustTierCounts = { unverified: 0, "machine-confirmed": 0, "human-reviewed": 0 };
  for (const doc of docs) counts[trustTier(doc.frontmatter)] += 1;
  return counts;
}

/**
 * Strict ISO-8601 instant grammar: calendar date, `T`, time, and a REQUIRED zone designator
 * (`Z`, `±hh`, `±hhmm`, or `±hh:mm`). Fractional seconds optional. Lowercase `t`/`z` accepted as
 * ISO permits.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)$/;

/**
 * Parse an instant a verifier supplies, or return `null`. Unlike `Date.parse`, this refuses what
 * a caller did not say: an impossible calendar date (`2026-02-30`, a non-leap `02-29`), an
 * out-of-range time, or a value without a zone designator (which would name a different instant
 * on every host). Read-side consumers stay permissive (see {@link latestVerifiedAt}); this rule
 * guards what gets WRITTEN.
 */
export function parseIsoInstant(raw: string): number | null {
  const match = ISO_INSTANT.exec(raw);
  if (!match) return null;
  const [, y, mo, d, h, mi, sec = "0", frac = "0", zulu, sign, oh, om = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(sec);
  if (month < 1 || month > 12) return null;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0); // day 0 of the NEXT month = last day of this one
  if (day < 1 || day > probe.getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (!zulu) {
    const offsetHours = Number(oh);
    const offsetMins = Number(om);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  // Truncate, never round: a recorded instant must not be later than the one the caller supplied.
  const millis = Number(frac.padEnd(3, "0").slice(0, 3));
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, millis);
  return instant.getTime() - offsetMinutes * 60_000;
}

/**
 * The instant a stored `at` denotes, for comparison and "how recently" selection: the strict
 * grammar first (so every spelling the write path accepts resolves identically), then the
 * permissive `Date.parse` for legacy producer spellings the read side must not drop. `null` when
 * neither understands the value.
 */
export function storedInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const strict = parseIsoInstant(value.trim());
  if (strict !== null) return strict;
  const legacy = Date.parse(value);
  return Number.isNaN(legacy) ? null : legacy;
}

export interface AppendVerificationOptions {
  /** The verifier; must satisfy the OKF actor convention (SPEC 7). */
  by: string;
  /** ISO-8601 instant of the confirmation, with a zone designator (see {@link parseIsoInstant}). */
  at: string;
}

/**
 * Return frontmatter with one more verification event appended. The result is always a list:
 * an absent key becomes `[event]`, a bare mapping becomes `[existing, event]`, a list grows by one.
 * Every other `verified` shape (a scalar, a list containing a non-event) is refused, because
 * rewriting it would destroy trust history the caller did not ask to change.
 *
 * Idempotent: an event that already exists (same `by`, same instant) is already recorded, so the
 * frontmatter is returned as-is and the caller's mutation converges to a no-op — repeating a
 * satisfied verification never manufactures a duplicate confirmation or a new revision.
 */
export function appendVerificationEvent<F extends Readonly<Record<string, unknown>>>(
  frontmatter: F,
  options: AppendVerificationOptions,
): F & { verified: VerificationEvent[] } {
  if (!isOkfActor(options.by)) {
    throw new OkfActorError(
      options.by,
      `OKF v0.2 verifier '${options.by}' must be human:<id>, process:<id>, or <producer>/<version>`,
    );
  }
  const instant = typeof options.at === "string" ? parseIsoInstant(options.at) : null;
  if (instant === null) {
    throw new InvalidInputError(
      "OKF v0.2 verified.at must be a real ISO-8601 date-time with a timezone designator (e.g. 2026-09-07T12:00:00Z)",
    );
  }
  const raw = frontmatter.verified;
  let existing: VerificationEvent[];
  if (raw === undefined || raw === null) {
    existing = [];
  } else {
    const entries = Array.isArray(raw) ? raw : [raw];
    if (!entries.every(isEvent)) {
      throw new InvalidInputError(
        "OKF v0.2 verified must be a list of { by, at } events (or one bare event) before a verification can be appended",
      );
    }
    existing = entries;
  }
  // Same resolver as the read side, so any spelling the grammar accepts on write (including an
  // imported `+02` offset) is recognized as the same instant on repeat.
  const alreadyRecorded = existing.some((prior) => prior.by === options.by && storedInstant(prior.at) === instant);
  if (alreadyRecorded) return frontmatter as F & { verified: VerificationEvent[] };
  const event: VerificationEvent = { by: options.by, at: options.at };
  return { ...frontmatter, verified: [...existing, event] };
}
