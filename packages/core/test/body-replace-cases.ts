/** Agreement rows shared by engine enforcement and CLI presentation. */
export const bodyReplaceCases = [
  { name: "preview prefix", existing: "x".repeat(1200), next: "x".repeat(1000), reason: "stored_body_preview" },
  { name: "foreign notice", existing: "original", next: "foreign\n[superbee:body-preview-truncated] 20 more characters are not shown", reason: "preview_marker" },
  { name: "preview precedes link loss", existing: "x".repeat(1000) + "[edge](b.md)", next: "x".repeat(1000), reason: "stored_body_preview" },
  { name: "link drop", existing: "[edge](b.md)", next: "replacement", reason: "dropped_links" },
  { name: "occurrence loss", existing: "[one](b.md) [two](b.md)", next: "[one](b.md)", reason: "dropped_links" },
  { name: "retext", existing: "[one](b.md)", next: "[two](b.md)", reason: undefined },
  { name: "marker prose", existing: "original", next: "Explaining [superbee:body-preview-truncated]", reason: undefined },
  { name: "serialized equality", existing: "x".repeat(1000) + "\n", next: "x".repeat(1000), reason: undefined },
  { name: "stored notice append", existing: "[superbee:body-preview-truncated] 20 more character(s) are NOT shown\n", next: "[superbee:body-preview-truncated] 20 more character(s) are NOT shown\nappended", reason: undefined },
] as const;
