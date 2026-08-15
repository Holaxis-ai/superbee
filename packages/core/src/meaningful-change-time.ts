/**
 * Return the raw frontmatter value that represents a document's last meaningful change.
 *
 * This is intentionally only field selection: each consumer keeps its existing parsing,
 * formatting, and missing-value behavior. Backend revision timestamps are a different clock.
 */
export function meaningfulChangeTimeValue(frontmatter: {
  readonly generated?: unknown;
  readonly timestamp?: unknown;
}): unknown {
  const generated = frontmatter.generated;
  if (generated !== null && typeof generated === "object" && !Array.isArray(generated)) {
    const at = (generated as Record<string, unknown>).at;
    if (at !== undefined) return at;
  }
  return frontmatter.timestamp;
}
