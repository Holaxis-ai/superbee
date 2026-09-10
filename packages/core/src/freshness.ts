/**
 * Freshness derivation from the document's edition-neutral meaningful-change clock.
 *
 * OKF v0.2's `stale_after` supplies an absolute instant; v0.1 `timestamp` and v0.2
 * `generated.at` supply the instant of the last meaningful change. The remaining
 * staleness rules are consumer judgments layered on top:
 *   - `empty` — no usable meaningful-change time is present.
 *   - `stale` — a declared dependency was written more recently than this concept,
 *               OR the concept's age exceeds `maxAgeMs`.
 *   - `fresh` — otherwise.
 * The v0.2 absolute instant takes precedence, then dependency-newer, then the age rule.
 *
 * Pure and dependency-free, hence directly unit-testable.
 */

import type { FreshnessOptions, FreshnessResult, OkfDocument } from "./types.js";
import { meaningfulChangeTimeField, meaningfulChangeTimeValue } from "./meaningful-change-time.js";
import { parseIsoInstant } from "./verification.js";

/** A deadline must name an explicit instant; rounding up avoids expiring sub-ms instants early. */
export function staleAfterInstant(value: unknown): number | null {
  return typeof value === "string" ? parseIsoInstant(value, "ceil") : null;
}

/** Parse a clock to epoch milliseconds. v0.2 requires an explicit ISO instant; legacy mode is permissive. */
export function parseTimestamp(ts: unknown, okfVersion?: string): number | null {
  if (okfVersion === "0.2") return typeof ts === "string" ? parseIsoInstant(ts) : null;
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof ts === "number") {
    return Number.isFinite(ts) ? ts : null;
  }
  if (typeof ts !== "string" || ts.trim() === "") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** Diagnose only an effective, present legacy clock; standard generated.at diagnostics own shadowing values. */
export function invalidLegacyTimestamp(
  frontmatter: { readonly generated?: unknown; readonly timestamp?: unknown },
  okfVersion?: string,
): { field: "timestamp"; value: unknown } | undefined {
  if (okfVersion !== "0.2" || !Object.hasOwn(frontmatter, "timestamp")
    || meaningfulChangeTimeField(frontmatter) !== "timestamp"
    || parseTimestamp(frontmatter.timestamp, okfVersion) !== null) return undefined;
  return { field: "timestamp", value: frontmatter.timestamp };
}

/**
 * Derive a freshness verdict from `generated.at`, falling back to legacy `timestamp`.
 *
 * @param doc     the concept document (v0.2 `stale_after` and meaningful-change clocks are consulted).
 * @param options bundle edition, `now` (defaults to the current instant), `maxAgeMs`, and
 *                the ISO timestamps of upstream `dependsOn` artifacts.
 */
export function freshness(doc: OkfDocument, options: FreshnessOptions = {}): FreshnessResult {
  const parseClock = (value: unknown) => parseTimestamp(value, options.okfVersion);
  const tsMs = parseClock(meaningfulChangeTimeValue(doc.frontmatter));
  const now = options.now ?? new Date();
  const ageMs = tsMs === null ? undefined : now.getTime() - tsMs;
  const staleAfter = options.okfVersion === "0.2"
    ? staleAfterInstant(doc.frontmatter.stale_after)
    : null;
  if (staleAfter !== null && now.getTime() >= staleAfter) {
    return {
      verdict: "stale",
      ...(ageMs === undefined ? {} : { ageMs }),
      reason: `now is on or after stale_after ${doc.frontmatter.stale_after}`,
    };
  }
  if (tsMs === null) {
    return { verdict: "empty", reason: "no usable meaningful-change time (`generated.at` or `timestamp`)" };
  }
  const meaningfulAgeMs = now.getTime() - tsMs;

  // Dependency-based staleness wins: any dependency newer than this concept.
  if (options.dependsOn && options.dependsOn.length > 0) {
    for (const dep of options.dependsOn) {
      const depMs = parseClock(dep);
      if (depMs !== null && depMs > tsMs) {
        return {
          verdict: "stale",
          ageMs: meaningfulAgeMs,
          reason: `a dependency (${dep}) is newer than this concept`,
        };
      }
    }
  }

  if (typeof options.maxAgeMs === "number" && meaningfulAgeMs > options.maxAgeMs) {
    return {
      verdict: "stale",
      ageMs: meaningfulAgeMs,
      reason: `age ${meaningfulAgeMs}ms exceeds max ${options.maxAgeMs}ms`,
    };
  }

  return { verdict: "fresh", ageMs: meaningfulAgeMs };
}
