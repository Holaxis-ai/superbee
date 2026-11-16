/** Exact Kind identities are local strings; only alias:Kind denotes a cross-bundle target. */
export const SOURCE_SCOPED_EDGE_CASES = [
  { name: "legacy Task follow-up", source: "Task", target: "Task", violation: false },
  { name: "untyped source", source: "", target: "Task", violation: false },
  { name: "unrelated declared source", source: "Note", target: "Task", violation: false },
  { name: "bare source is distinct", source: "Decision", target: "Task", violation: false },
  { name: "exact qualified local source", source: "github.com/example/decision/Decision", target: "Task", violation: false },
  { name: "matching source wrong target", source: "github.com/example/decision/Decision", target: "Note", violation: true },
  { name: "second source same label", source: "Research", target: "Note", violation: false },
  { name: "second source wrong target", source: "Research", target: "Task", violation: true },
];
export const SOURCE_SCOPED_DECLARATIONS = [
  { governs: "github.com/example/decision/Decision", target: "Task" },
  { governs: "Research", target: "Note" },
];
