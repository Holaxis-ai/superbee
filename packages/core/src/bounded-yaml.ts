/** The one runtime-neutral YAML loader for frontmatter and other untrusted YAML values. */

import yaml from "js-yaml";

import { FrontmatterLimitError } from "./frontmatter-contract.js";

/**
 * Limits every YAML load applies. `sourceChars` counts UTF-16 code units. `depth` bounds nesting,
 * both as written and with aliases expanded. `aliases` bounds references to an already loaded
 * collection, and `expandedNodes` bounds the node count a full traversal visits with aliases
 * expanded.
 */
export const FRONTMATTER_LIMITS = Object.freeze({
  sourceChars: 1024 * 1024,
  depth: 64,
  aliases: 10_000,
  expandedNodes: 1_000_000,
});

export interface BoundedYamlOptions {
  /** The js-yaml schema, or `json` for the JSON schema; the safe default schema when omitted. */
  schema?: yaml.Schema | "json";
}

function tooDeep(): FrontmatterLimitError {
  return new FrontmatterLimitError("FRONTMATTER_TOO_DEEP", `YAML nesting is deeper than ${FRONTMATTER_LIMITS.depth} levels`);
}

function isCollection(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Measure a loaded value with aliases expanded, sharing work across repeated references. A
 * reference back to a collection still being measured is a cycle; it counts once, since readers
 * detect cycles rather than unroll them.
 */
function assertExpansionWithinLimits(root: unknown): void {
  const measured = new Map<object, { nodes: number; depth: number }>();
  const open = new Set<object>();
  let references = 0;

  const measure = (value: unknown, pathDepth: number): { nodes: number; depth: number } => {
    if (!isCollection(value)) return { nodes: 1, depth: 1 };
    const known = measured.get(value);
    if (known !== undefined || open.has(value)) {
      references += 1;
      if (references > FRONTMATTER_LIMITS.aliases) {
        throw new FrontmatterLimitError(
          "FRONTMATTER_ALIAS_LIMIT",
          `YAML aliases are used more than ${FRONTMATTER_LIMITS.aliases} times`,
        );
      }
      if (known === undefined) return { nodes: 1, depth: 1 };
      if (pathDepth + known.depth - 1 > FRONTMATTER_LIMITS.depth) throw tooDeep();
      return known;
    }
    if (pathDepth > FRONTMATTER_LIMITS.depth) throw tooDeep();
    open.add(value);
    let nodes = 1;
    let depth = 1;
    for (const child of Object.values(value)) {
      const result = measure(child, pathDepth + 1);
      nodes += result.nodes;
      depth = Math.max(depth, result.depth + 1);
      if (nodes > FRONTMATTER_LIMITS.expandedNodes) {
        throw new FrontmatterLimitError(
          "FRONTMATTER_ALIAS_LIMIT",
          `YAML aliases expand to more than ${FRONTMATTER_LIMITS.expandedNodes} nodes`,
        );
      }
    }
    open.delete(value);
    const result = { nodes, depth };
    measured.set(value, result);
    return result;
  };

  measure(root, 1);
}

/**
 * Load one YAML document within {@link FRONTMATTER_LIMITS}. A refusal throws
 * {@link FrontmatterLimitError}; other YAML errors propagate from js-yaml unchanged.
 */
export function loadBoundedYaml(source: string, options: BoundedYamlOptions = {}): unknown {
  if (source.length > FRONTMATTER_LIMITS.sourceChars) {
    throw new FrontmatterLimitError(
      "FRONTMATTER_TOO_LARGE",
      `YAML source is longer than ${FRONTMATTER_LIMITS.sourceChars} characters`,
    );
  }
  const schema = options.schema === "json" ? yaml.JSON_SCHEMA : options.schema;
  let depth = 0;
  let anchored = false;
  const value = yaml.safeLoad(source, {
    ...(schema ? { schema } : {}),
    listener(event, state) {
      if (!anchored) {
        for (const _anchor in (state as { anchorMap?: Record<string, unknown> }).anchorMap) {
          anchored = true;
          break;
        }
      }
      if (event === "open") {
        depth += 1;
        if (depth > FRONTMATTER_LIMITS.depth) throw tooDeep();
      } else {
        depth -= 1;
      }
    },
  });
  // Without an anchor every node is written out, so the source cap already bounds the value.
  if (anchored) assertExpansionWithinLimits(value);
  return value;
}
