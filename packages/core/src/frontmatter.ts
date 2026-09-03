/**
 * Markdown + YAML frontmatter (de)serialization via `gray-matter`.
 *
 * This is the ONLY module that touches the YAML layer; every other module works
 * with the already-parsed {@link Frontmatter}/body shapes. gray-matter delimits
 * frontmatter with `---` lines (OKF §4.1) and preserves unknown keys on
 * round-trip (OKF v0.1 §9 / v0.2 §11 permissive consumption).
 */

import matter from "gray-matter";
import yaml from "js-yaml";
import { isUsableTimestamp, MalformedDocumentError } from "./frontmatter-contract.js";
import type { Frontmatter } from "./types.js";

export { isUsableTimestamp, MalformedDocumentError } from "./frontmatter-contract.js";

const YAML_TIMESTAMP_TAG = "tag:yaml.org,2002:timestamp";

type SchemaWithImplicitTypes = yaml.Schema & {
  implicit: yaml.Type[];
};

type TaggedType = yaml.Type & {
  tag: string;
};

function requireYamlTimestampType(): yaml.Type {
  const type = (yaml.DEFAULT_SAFE_SCHEMA as SchemaWithImplicitTypes).implicit.find(
    (candidate) => (candidate as TaggedType).tag === YAML_TIMESTAMP_TAG,
  );
  if (!type) throw new Error("js-yaml safe schema is missing its timestamp type");
  return type;
}

const yamlTimestampType = requireYamlTimestampType();

/**
 * Keep YAML timestamps as their original strings. The default schema constructs both
 * `2026-01-02` and `2026-01-02T00:00:00Z` as identical `Date` objects, irreversibly erasing the
 * date-only distinction before unknown nested frontmatter can be preserved.
 */
const stringTimestampType = new yaml.Type(YAML_TIMESTAMP_TAG, {
  kind: "scalar",
  resolve: (value) => yamlTimestampType.resolve(value),
  construct: (value) => value,
});

const losslessDateSchema = new yaml.Schema({
  include: [yaml.DEFAULT_SAFE_SCHEMA],
  implicit: [stringTimestampType],
});

const yamlEngine = {
  parse(input: string): object {
    return (yaml.safeLoad(input, { schema: losslessDateSchema }) ?? {}) as object;
  },
};

/**
 * Normalize the legacy top-level `timestamp` field to an ISO-8601 string.
 *
 * gray-matter/js-yaml turns an UNQUOTED ISO timestamp scalar — the form OKF's own
 * sample bundles use (`timestamp: 2026-07-01T12:05:00Z`) — into a non-string under its
 * default schema. The parser above now retains all YAML timestamp scalars as strings so
 * date-only values remain distinguishable at any depth. This legacy field still keeps its
 * established canonical ISO behavior, including epoch-millisecond input.
 */
function normalizeFrontmatter(data: Record<string, unknown>): Frontmatter {
  const out: Record<string, unknown> = { ...data };
  const value = out.timestamp;
  if (value instanceof Date) {
    out.timestamp = value.toISOString();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    out.timestamp = new Date(value).toISOString();
  } else if (typeof value === "string" && yamlTimestampType.resolve(value)) {
    const parsed = yamlTimestampType.construct(value);
    if (parsed instanceof Date) out.timestamp = parsed.toISOString();
  }
  return out as Frontmatter;
}

/**
 * Parse raw markdown into `{ frontmatter, body }`. Missing frontmatter yields `{}`. Malformed YAML
 * throws an attributed {@link MalformedDocumentError} (naming `context` when given).
 *
 * Passing parser options bypasses gray-matter's input cache. Without options, gray-matter can cache
 * a still-unparsed file before YAML parsing, causing a later parse of the same malformed bytes to
 * return empty data instead of throwing again. The custom YAML engine also preserves timestamp-like
 * scalars as strings so date-only values retain their original semantic shape.
 */
export function parseMarkdown(
  raw: string,
  context?: string,
): { frontmatter: Frontmatter; body: string } {
  // An exact opening delimiter asserts that the document has YAML frontmatter. gray-matter accepts
  // a missing closing delimiter when the remaining bytes happen to be valid YAML (Markdown heading
  // lines are YAML comments), then returns an empty body. That is lossy ambiguity, not a successful
  // parse: every caller must see the same attributed malformed-document result before it can read,
  // export, or rewrite a body that silently disappeared.
  if (/^---(?:\r?\n|$)/.test(raw)) {
    const firstLineEnd = raw.indexOf("\n");
    const afterOpening = firstLineEnd === -1 ? "" : raw.slice(firstLineEnd + 1);
    if (!/^---\r?$/m.test(afterOpening)) {
      throw new MalformedDocumentError(context, new Error("unterminated YAML frontmatter delimiter"));
    }
  }
  let parsed;
  try {
    parsed = matter(raw, { engines: { yaml: yamlEngine } });
  } catch (err) {
    throw new MalformedDocumentError(context, err);
  }
  const frontmatter = normalizeFrontmatter((parsed.data ?? {}) as Record<string, unknown>);
  return { frontmatter, body: parsed.content };
}

/** Match the exact body shape emitted by the document serializer. */
export function normalizeDocumentBodyForStorage(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** Serialize an arbitrary YAML-mapping + body to OKF markdown (used for reserved files). */
export function stringifyWithData(data: Record<string, unknown>, body: string): string {
  const engines = (matter as typeof matter & {
    engines: { yaml: { stringify(value: object): string } };
  }).engines;
  const yaml = engines.yaml.stringify(data).trim();
  const content = body ?? "";
  const newline = (value: string): string => (value.endsWith("\n") ? value : `${value}\n`);
  if (yaml === "{}") return normalizeDocumentBodyForStorage(content);
  return `---\n${newline(yaml)}---\n${normalizeDocumentBodyForStorage(content)}`;
}

/** Serialize a concept document's frontmatter + body to OKF-conformant markdown. */
export function stringifyDoc(frontmatter: Frontmatter, body: string): string {
  return stringifyWithData(frontmatter as Record<string, unknown>, body);
}
