import type { LinkTypeDeclaration } from "../../src/link-types.js";

const shared: LinkTypeDeclaration[] = [
  { governs: "Menu Item", target: "beers:Beer" },
  { governs: "Milestone", target: "goals:Goal" },
];

/** One agreement table for pure typed-edge checks and storage-neutral health projection. */
export const QUALIFIED_EDGE_CASES: {
  name: string; declared: LinkTypeDeclaration[]; source: string; alias: string;
  actual?: string; violation: boolean;
}[] = [
  { name: "correct actual Kind", declared: shared, source: "Menu Item", alias: "beers", actual: "Beer", violation: false },
  { name: "wrong actual Kind", declared: shared, source: "Menu Item", alias: "beers", actual: "Reference", violation: true },
  { name: "absent actual type", declared: shared, source: "Menu Item", alias: "beers", actual: "", violation: true },
  { name: "metadata-only remains unchecked", declared: shared, source: "Menu Item", alias: "beers", violation: false },
  { name: "wrong source", declared: shared, source: "Note", alias: "beers", actual: "Beer", violation: true },
  { name: "wrong alias and actual Kind", declared: shared, source: "Menu Item", alias: "wines", actual: "Reference", violation: true },
  { name: "local declaration with qualified edge", declared: [{ governs: "Menu Item", target: "Beer" }], source: "Menu Item", alias: "beers", actual: "Beer", violation: true },
  { name: "shared label selects matching source", declared: shared, source: "Milestone", alias: "goals", actual: "Goal", violation: false },
  { name: "shared label matching source wrong Kind", declared: shared, source: "Milestone", alias: "goals", actual: "Beer", violation: true },
  { name: "undeclared label stays untyped", declared: [], source: "Menu Item", alias: "beers", actual: "Reference", violation: false },
];
