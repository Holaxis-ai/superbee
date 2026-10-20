import { stringifyDoc } from "../../src/frontmatter.js";
import { parseRecipeFiles, type LoadedRecipe, type RecipeFile } from "../../src/recipes.js";
import type { OkfDocument } from "../../src/types.js";

export function retirementSource(version = "1", retire = false): LoadedRecipe {
  const fm: OkfDocument["frontmatter"] = { type: "Convention", title: "Widget", governs: "Widget", fields: {
    required: ["title"], optional: ["legacy", "category", "topics"], types: { legacy: "slug", topics: "string-list" },
    values: { category: ["old", "new"], topics: ["old", "new"] }, descriptions: { legacy: "Old field" },
    value_descriptions: { category: { old: "Old member", new: "New member" } } },
    links: { legacy_link: "Widget", active_link: "Widget" }, link_descriptions: { legacy_link: "Old relation" },
    deprecated: { fields: ["legacy"], values: { category: ["old"], topics: ["old"] }, links: ["legacy_link"] } };
  if (retire) {
    const fields = fm.fields as any; fields.optional = ["category", "topics"]; delete fields.types.legacy; delete fields.descriptions.legacy;
    fields.values.category = ["new"]; delete fields.value_descriptions.category.old;
    delete (fm.links as any).legacy_link; delete (fm.link_descriptions as any).legacy_link;
    fm.deprecated = { values: { topics: ["old"] } };
  }
  return { id: "retirement-widgets", title: "Retirement widgets", version, summary: "Widget lifecycle", offer: "Widget lifecycle", source: `test:retirement:${version}`,
    docs: [{ id: "conventions/widget", frontmatter: fm, body: "# Widget\n" }], governs: ["Widget"], pages: [], references: [], warnings: [] };
}
export function retirementFiles(source: LoadedRecipe): RecipeFile[] {
  return [{ path: "recipe.md", bytes: stringifyDoc({ type: "Recipe", id: source.id, title: source.title, version: source.version, summary: source.summary, offer: source.offer }, "") },
    ...source.docs.map(doc => ({ path: `${doc.id}.md`, bytes: stringifyDoc(doc.frontmatter, doc.body) }))];
}
export function parsedRetirementSource(version = "1", retire = false): LoadedRecipe {
  const parsed = parseRecipeFiles(retirementFiles(retirementSource(version, retire)), `test:retirement:${version}`, { okfVersion: "0.2" });
  if (!parsed.ok) throw new Error(parsed.error.message); return parsed.recipe;
}
export const retirementUsageRows: Array<{ name: string; fields?: Record<string, unknown>; body?: string; verdict: "complete-clean" | "used" | "unknown"; coordinate?: "field" | "value" | "link"; count?: number; declarationName?: string; retireTopics?: true }> = [
  { name: "no instances", verdict: "complete-clean" },
  { name: "own null key is use", fields: { legacy: null }, verdict: "used", coordinate: "field", count: 1 },
  { name: "own empty key is use", fields: { legacy: "" }, verdict: "used", coordinate: "field", count: 1 },
  { name: "scalar enum member", fields: { category: "old" }, verdict: "used", coordinate: "value", count: 1 },
  { name: "string-list enum occurrence count", fields: { topics: ["old", "old"] }, verdict: "used", coordinate: "value", declarationName: "topics", retireTopics: true, count: 2 },
  { name: "local edge", body: "[legacy_link](two.md)", verdict: "used", coordinate: "link", count: 1 },
  { name: "qualified alias edge", body: "[legacy_link](okf://a/widgets/two.md)", verdict: "used", coordinate: "link", count: 1 },
  { name: "qualified other alias still use", body: "[legacy_link](okf://b/widgets/two.md)", verdict: "used", coordinate: "link", count: 1 },
  { name: "malformed qualified is unknown", body: "[legacy_link](okf://INVALID/widgets/two.md)", verdict: "unknown", coordinate: "link", count: 1 },
];
