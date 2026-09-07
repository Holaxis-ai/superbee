/**
 * The OKF v0.2 actor convention (SPEC 7). One grammar owns every identity-bearing field
 * (`generated.by`, `verified[].by`, the resolved mutation actor) so trust classification and
 * provenance validation cannot drift apart.
 */

/** OKF v0.2 actor spellings: human/process identities or a producer/version pair. */
export function isOkfActor(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || /\s/.test(value)) {
    return false;
  }
  if (/^(?:human|process):[^\s:]+$/.test(value)) return true;
  return /^[^\s/:]+\/[^\s/]+$/.test(value);
}

/**
 * A person, per the `human:<id>` prefix consumers key trust tiers off (SPEC 5.3, 7).
 *
 * Prefix-only on purpose, unlike {@link isOkfActor}: classification is a READ rule, and a consumer
 * must surface a human signal even when a producer's spelling breaks the rest of the grammar
 * (`human:Jane Doe`) rather than silently downgrade it to machine-confirmed (SPEC 11). The write
 * path enforces the full grammar before any verifier is recorded. Case-sensitive, and the id must
 * be non-empty: `Human:x` and a bare `human:` name nobody.
 */
export function isHumanActor(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("human:") && value.length > "human:".length;
}
