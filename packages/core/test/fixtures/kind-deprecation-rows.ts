import type { OkfDocument } from "../../src/types.js";
export const deprecationConvention: OkfDocument = {
  id: "conventions/widget", body: "Widget policy.\n",
  frontmatter: { type: "Convention", title: "Widget", governs: "Widget",
    fields: { required: ["title"], optional: ["legacy", "category", "topics"],
      values: { category: ["old", "new"], topics: ["old", "new"] }, types: { topics: "string-list" } },
    links: { legacy_link: "Widget", active_link: "Widget" },
    deprecated: { fields: ["legacy"], values: { category: ["old"], topics: ["old"] }, links: ["legacy_link"] } },
};
export const widget = (fields: Record<string, unknown> = {}, body = "", type = "Widget"): OkfDocument => ({
  id: "widgets/one", frontmatter: { type, title: "One", ...fields }, body,
});
export interface DeprecationRow { name: string; existing?: OkfDocument; candidate: OkfDocument; refused: boolean }
export const deprecationRows: DeprecationRow[] = [
  { name: "active create", candidate: widget({ category: "new" }), refused: false },
  { name: "deprecated field create", candidate: widget({ legacy: "old" }), refused: true },
  { name: "deprecated null create", candidate: widget({ legacy: null }), refused: true },
  { name: "deprecated empty create", candidate: widget({ legacy: "" }), refused: true },
  { name: "preserve structured field", existing: widget({ legacy: { a: [1, 2] } }), candidate: widget({ legacy: { a: [1, 2] }, title: "Edited" }, "New prose"), refused: false },
  { name: "change deprecated field", existing: widget({ legacy: "old" }), candidate: widget({ legacy: "changed" }), refused: true },
  { name: "remove deprecated field", existing: widget({ legacy: "old" }), candidate: widget(), refused: false },
  { name: "introduce scalar enum", candidate: widget({ category: "old" }), refused: true },
  { name: "preserve scalar enum", existing: widget({ category: "old" }), candidate: widget({ category: "old" }, "Edit"), refused: false },
  { name: "migrate scalar enum", existing: widget({ category: "old" }), candidate: widget({ category: "new" }), refused: false },
  { name: "list reorder and active addition", existing: widget({ topics: ["old"] }), candidate: widget({ topics: ["new", "old"] }), refused: false },
  { name: "list deprecated duplication", existing: widget({ topics: ["old"] }), candidate: widget({ topics: ["old", "old"] }), refused: true },
  { name: "list cleanup", existing: widget({ topics: ["old", "new"] }), candidate: widget({ topics: ["new"] }), refused: false },
  { name: "local link introduce", candidate: widget({}, "[legacy_link](two.md)"), refused: true },
  { name: "local href equivalent", existing: widget({}, "[legacy_link](two.md)"), candidate: widget({}, "Text\n[legacy_link](./two.md)"), refused: false },
  { name: "local link target change", existing: widget({}, "[legacy_link](two.md)"), candidate: widget({}, "[legacy_link](three.md)"), refused: true },
  { name: "local link duplicate", existing: widget({}, "[legacy_link](two.md)"), candidate: widget({}, "[legacy_link](two.md)\n[legacy_link](two.md)"), refused: true },
  { name: "qualified preserve", existing: widget({}, "[legacy_link](okf://a/widgets/two.md)"), candidate: widget({}, "Text\n[legacy_link](okf://a/widgets/two.md#part)"), refused: false },
  { name: "qualified alias retarget", existing: widget({}, "[legacy_link](okf://a/widgets/two.md)"), candidate: widget({}, "[legacy_link](okf://b/widgets/two.md)"), refused: true },
  { name: "local becomes qualified", existing: widget({}, "[legacy_link](two.md)"), candidate: widget({}, "[legacy_link](okf://a/widgets/two.md)"), refused: true },
  { name: "malformed preserve", existing: widget({}, "[legacy_link](okf://INVALID/widgets/two.md)"), candidate: widget({}, "Text\n[legacy_link](okf://INVALID/widgets/two.md)"), refused: false },
  { name: "malformed introduce", candidate: widget({}, "[legacy_link](okf://INVALID/widgets/two.md)"), refused: true },
  { name: "malformed change", existing: widget({}, "[legacy_link](okf://INVALID/widgets/two.md)"), candidate: widget({}, "[legacy_link](okf://INVALID/widgets/three.md)"), refused: true },
  { name: "link cleanup", existing: widget({}, "[legacy_link](two.md)"), candidate: widget(), refused: false },
  { name: "retype gets no grandfathering", existing: widget({ legacy: "old" }, "", "Other"), candidate: widget({ legacy: "old" }), refused: true },
  { name: "different document identity cannot lend allowance", existing: { ...widget({ legacy: "old" }), id: "widgets/another" }, candidate: widget({ legacy: "old" }), refused: true },
  { name: "copy gets no grandfathering", candidate: widget({ legacy: "old" }), refused: true },
  { name: "unrelated active link", existing: widget({}, "[legacy_link](two.md)"), candidate: widget({}, "[legacy_link](two.md)\n[active_link](three.md)"), refused: false },
];


/** One eligibility table drives registry/serializer, mutation and lifecycle boundary probes. */
export interface DeprecationEligibilityRow {
  name: string;
  convention: OkfDocument;
  invalid: boolean;
  field: string;
  mode: "fields" | "values";
  recipeUnsupported?: boolean;
}
const eligibilityConvention = (optional: string[], values: Record<string, string[]>, claim: { owner_field?: string; state_field?: string } | undefined,
  policy: unknown, terminal?: Record<string, string[]>): OkfDocument => ({
    id: "conventions/widget", body: "Eligibility fixture.\n",
    frontmatter: { type: "Convention", title: "Widget", governs: "Widget",
      fields: { required: ["title"], optional, values, ...(terminal ? { terminal } : {}) },
      ...(claim ? { claim } : {}), deprecated: policy },
  });
export const deprecationEligibilityRows: DeprecationEligibilityRow[] = [];
for (const mode of ["fields", "values"] as const) {
  for (const entry of [
    { name: "logical claim resolves physical progress", optional: ["superbee_progress_status"], claim: { state_field: "progress_status" }, field: "superbee_progress_status", invalid: true },
    { name: "physical claim remains protected", optional: ["superbee_progress_status"], claim: { state_field: "superbee_progress_status" }, field: "superbee_progress_status", invalid: true },
    { name: "literal logical collision owns claim", optional: ["progress_status", "superbee_progress_status"], claim: { state_field: "progress_status" }, field: "progress_status", invalid: true },
    { name: "literal logical collision leaves physical independent", optional: ["progress_status", "superbee_progress_status"], claim: { state_field: "progress_status" }, field: "superbee_progress_status", invalid: false },
    { name: "logical owner resolves physical progress", optional: ["superbee_progress_status"], claim: { owner_field: "progress_status" }, field: "superbee_progress_status", invalid: true },
  ]) {
    const values = Object.fromEntries(entry.optional.map(field => [field, ["old", "new"]]));
    const policy = mode === "fields" ? { fields: [entry.field] } : { values: Object.fromEntries([[entry.field, ["old"]]]) };
    deprecationEligibilityRows.push({ name: `${entry.name}: ${mode}`, convention: eligibilityConvention(entry.optional, values, entry.claim, policy), invalid: entry.invalid, field: entry.field, mode, recipeUnsupported: entry.optional.length > 1 });
  }
}
for (const field of ["toString", "constructor", "__proto__"]) for (const terminal of [false, true]) {
  deprecationEligibilityRows.push({ name: `${field}: ${terminal ? "own terminal excluded" : "prototype is not terminal"}`,
    convention: eligibilityConvention([field], Object.fromEntries([[field, ["old", "new"]]]), undefined,
      { values: Object.fromEntries([[field, ["old"]]]) }, terminal ? Object.fromEntries([[field, ["old"]]]) : undefined),
    invalid: terminal, field, mode: "values" });
}
