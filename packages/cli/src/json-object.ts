// One duplicate-key boundary for caller-authored JSON objects, including JSONC host configuration.
import { getNodeValue, parseTree, type Node as JsoncNode, type ParseError } from "jsonc-parser";

function uniqueKeys(node: JsoncNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string") continue;
      if (seen.has(key)) throw new Error(`configuration contains duplicate key '${key}'`);
      seen.add(key);
    }
  }
  for (const child of node.children ?? []) uniqueKeys(child);
}

export function parseUniqueJsonObject(text: string, options: { allowTrailingComma: boolean; disallowComments: boolean } = { allowTrailingComma: false, disallowComments: true }): Record<string, unknown> {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, options);
  if (errors.length > 0) throw new Error(`configuration is not valid JSON/JSONC (error ${errors[0]?.error})`);
  if (!tree || tree.type !== "object") throw new Error("configuration root is not an object");
  uniqueKeys(tree);
  return getNodeValue(tree) as Record<string, unknown>;
}
