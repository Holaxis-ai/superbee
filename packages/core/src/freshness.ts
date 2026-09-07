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
import { meaningfulChangeTimeValue } from "./meaningful-change-time.js";
import { parseIsoInstant } from "./verification.js";

/**
 * Parse a timestamp to epoch ms, or `null`. Accepts an ISO-8601 (or any
 * `Date.parse`-able) STRING — the normal case, since {@link parseMarkdown}
 * normalizes frontmatter dates to strings — and, as belt-and-suspenders, a raw
 * `Date` or epoch-millis `number` should one reach here unnormalized.
 */
export function parseTimestamp(ts: unknown): number | null {
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

/**
 * Derive a freshness verdict from `generated.at`, falling back to legacy `timestamp`.
 *
 * @param doc     the concept document (v0.2 `stale_after` and meaningful-change clocks are consulted).
 * @param options bundle edition, `now` (defaults to the current instant), `maxAgeMs`, and
 *                the ISO timestamps of upstream `dependsOn` artifacts.
 */
export function freshness(doc: OkfDocument, options: FreshnessOptions = {}): FreshnessResult {
  const tsMs = parseTimestamp(meaningfulChangeTimeValue(doc.frontmatter));
  const now = options.now ?? new Date();
  const ageMs = tsMs === null ? undefined : now.getTime() - tsMs;
  const staleAfter = options.okfVersion === "0.2" && typeof doc.frontmatter.stale_after === "string"
    ? parseIsoInstant(doc.frontmatter.stale_after, "ceil")
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
      const depMs = parseTimestamp(dep);
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
