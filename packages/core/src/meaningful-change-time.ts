/** Select the meaningful-change field; even a malformed generated.at shadows the legacy clock. */
export function meaningfulChangeTimeField(frontmatter: {
  readonly generated?: unknown;
  readonly timestamp?: unknown;
}): "generated.at" | "timestamp" {
  const generated = frontmatter.generated;
  if (generated !== null && typeof generated === "object" && !Array.isArray(generated)
    && (generated as Record<string, unknown>).at !== undefined) return "generated.at";
  return "timestamp";
}

/** Return the selected raw value. Backend revision timestamps are a different clock. */
export function meaningfulChangeTimeValue(frontmatter: {
  readonly generated?: unknown;
  readonly timestamp?: unknown;
}): unknown {
  return meaningfulChangeTimeField(frontmatter) === "generated.at"
    ? (frontmatter.generated as Record<string, unknown>).at
    : frontmatter.timestamp;
}
