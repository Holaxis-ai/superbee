/** The one runtime-neutral YAML loader for frontmatter and other untrusted YAML values. */

import yaml from "js-yaml";

import { FrontmatterLimitError } from "./frontmatter-contract.js";

/**
 * Limits every YAML load applies, all measured on the loaded value with aliases expanded.
 * `sourceChars` counts UTF-16 code units of the YAML source. `depth` counts nested mappings and
 * sequences, the root included, whether written in block or flow style. `aliases` counts alias
 * uses of any node. `expandedNodes` counts every node and `expandedChars` the string characters a
 * full traversal visits.
 */
export const FRONTMATTER_LIMITS = Object.freeze({
  sourceChars: 1024 * 1024,
  depth: 64,
  aliases: 10_000,
  expandedNodes: 1_000_000,
  expandedChars: 8 * 1024 * 1024,
});

/** Parser nesting allowed before the value can be measured; a stack guard, not the depth rule. */
const PARSE_NESTING_GUARD = FRONTMATTER_LIMITS.depth * 4;

export interface BoundedYamlOptions {
  /** The js-yaml schema, or `json` for the JSON schema; the safe default schema when omitted. */
  schema?: yaml.Schema | "json";
}

interface Extent {
  nodes: number;
  chars: number;
  depth: number;
}

interface ParserState {
  anchor: string | null;
  anchorMap: Record<string, unknown>;
}

function tooDeep(): FrontmatterLimitError {
  return new FrontmatterLimitError("FRONTMATTER_TOO_DEEP", `YAML nesting is deeper than ${FRONTMATTER_LIMITS.depth} levels`);
}

function tooLarge(): FrontmatterLimitError {
  return new FrontmatterLimitError(
    "FRONTMATTER_ALIAS_LIMIT",
    `YAML aliases expand to more than ${FRONTMATTER_LIMITS.expandedNodes} nodes or ${FRONTMATTER_LIMITS.expandedChars} characters`,
  );
}

function scalarExtent(value: unknown): Extent {
  return { nodes: 1, chars: typeof value === "string" ? value.length : 0, depth: 0 };
}

function isCollection(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Measures values with aliases expanded, reusing the extent of a collection that is referenced
 * more than once. Mapping keys count toward characters. A reference to a collection on the current
 * path, or to an anchored collection the parser is still filling, is a cycle; within a measurement
 * it counts as one node, since readers detect cycles rather than unroll them.
 */
class ExtentMeter {
  private readonly known = new Map<object, Extent>();
  private readonly path = new Set<object>();

  private readonly unfinished: ReadonlySet<object>;

  constructor(unfinished: ReadonlySet<object> = new Set()) {
    this.unfinished = unfinished;
  }

  measure(value: unknown): Extent {
    if (!isCollection(value)) return scalarExtent(value);
    const known = this.known.get(value);
    if (known !== undefined) return known;
    if (this.path.has(value) || this.unfinished.has(value)) return { nodes: 1, chars: 0, depth: 1 };
    return this.walk(value, true);
  }

  /** The current extent of a collection the parser is still filling; never remembered, as it grows. */
  measureUnfinished(value: unknown): Extent {
    if (!isCollection(value)) return scalarExtent(value);
    if (this.path.has(value)) return { nodes: 1, chars: 0, depth: 1 };
    return this.walk(value, false);
  }

  private walk(value: object, remember: boolean): Extent {
    if (this.path.size >= FRONTMATTER_LIMITS.depth) throw tooDeep();
    this.path.add(value);
    const keyed = !Array.isArray(value);
    const extent: Extent = { nodes: 1, chars: 0, depth: 1 };
    for (const [key, child] of Object.entries(value)) {
      const inner = this.measure(child);
      extent.nodes += inner.nodes;
      extent.chars += inner.chars + (keyed ? key.length : 0);
      extent.depth = Math.max(extent.depth, inner.depth + 1);
      if (extent.nodes > FRONTMATTER_LIMITS.expandedNodes || extent.chars > FRONTMATTER_LIMITS.expandedChars) throw tooLarge();
      if (extent.depth > FRONTMATTER_LIMITS.depth) throw tooDeep();
    }
    this.path.delete(value);
    if (remember) this.known.set(value, extent);
    return extent;
  }
}

/**
 * Charges each alias as the parser resolves it, so expansion work done while parsing (merge keys,
 * collection keys) stays within the same budget as the loaded value.
 */
class AliasBudget {
  private readonly unfinished = new Set<object>();
  private readonly finished = new Set<string>();
  private readonly meter = new ExtentMeter(this.unfinished);
  private aliases = 0;
  private nodes = 0;
  private chars = 0;

  /** Wrap the parser's anchor table; the parser reads it only to resolve an alias. */
  watch(state: ParserState): void {
    state.anchorMap = new Proxy(state.anchorMap, {
      get: (target, name, receiver) => {
        const value: unknown = Reflect.get(target, name, receiver);
        if (typeof name === "string") this.charge(name, value);
        return value;
      },
      set: (target, name, value, receiver) => {
        if (typeof name === "string") {
          this.finished.delete(name);
          if (isCollection(value)) this.unfinished.add(value);
        }
        return Reflect.set(target, name, value, receiver);
      },
    });
  }

  /** Called when an anchored node closes: its anchor now names a complete value. */
  close(anchor: string, value: unknown): void {
    this.finished.add(anchor);
    if (isCollection(value)) this.unfinished.delete(value);
  }

  private charge(name: string, value: unknown): void {
    this.aliases += 1;
    if (this.aliases > FRONTMATTER_LIMITS.aliases) {
      throw new FrontmatterLimitError(
        "FRONTMATTER_ALIAS_LIMIT",
        `YAML aliases are used more than ${FRONTMATTER_LIMITS.aliases} times`,
      );
    }
    // An alias to an anchor still being filled is charged its current extent, which the parser may
    // copy (as a mapping key, for example) before the anchor closes.
    const extent = this.finished.has(name) ? this.meter.measure(value) : this.meter.measureUnfinished(value);
    this.nodes += extent.nodes;
    this.chars += extent.chars;
    if (this.nodes > FRONTMATTER_LIMITS.expandedNodes || this.chars > FRONTMATTER_LIMITS.expandedChars) throw tooLarge();
  }
}

const MERGE_KEY_LIMIT_REASON = "merge keys exceeded maxTotalMergeKeys";

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
  const budget = new AliasBudget();
  let watched: Record<string, unknown> | undefined;
  let nesting = 0;
  let value: unknown;
  try {
    value = yaml.safeLoad(source, {
      ...(schema ? { schema } : {}),
      listener(event, rawState) {
        const state = rawState as unknown as ParserState & { result: unknown };
        if (state.anchorMap !== watched) {
          budget.watch(state);
          watched = state.anchorMap;
        }
        if (event === "open") {
          nesting += 1;
          if (nesting > PARSE_NESTING_GUARD) throw tooDeep();
        } else {
          nesting -= 1;
          if (state.anchor !== null) budget.close(state.anchor, state.result);
        }
      },
    });
  } catch (error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.startsWith(MERGE_KEY_LIMIT_REASON)) {
      throw new FrontmatterLimitError("FRONTMATTER_ALIAS_LIMIT", reason);
    }
    throw error;
  }
  new ExtentMeter().measure(value);
  return value;
}
