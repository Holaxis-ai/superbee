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
import type { Frontmatter } from "./types.js";

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
 * Thrown by {@link parseMarkdown} when a document's YAML frontmatter cannot be parsed. Carries
 * `context` — the document's id/path when the caller supplied one — so a whole-bundle scan can
 * attribute the corruption to a SPECIFIC document ("malformed frontmatter in 'notes/bad.md': …")
 * instead of surfacing a raw, id-less js-yaml message. `detail` is the underlying parser message
 * (first line only) for compact reporting; the original error is preserved on `.cause`.
 */
export class MalformedDocumentError extends Error {
  override readonly name = "MalformedDocumentError";
  /** The document id/path the malformed content belongs to (when the caller supplied one). */
  readonly context?: string;
  /** The underlying parser message, first line only — for compact per-doc reporting. */
  readonly detail: string;

  constructor(context: string | undefined, cause: unknown) {
    const detail = ((cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? "")
      .trim();
    super(
      `malformed frontmatter${context ? ` in '${context}'` : ""}: ${detail} — ` +
        `fix the YAML or remove the file`,
    );
    if (context !== undefined) this.context = context;
    this.detail = detail;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
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

/**
 * THE engine's usable-document-timestamp predicate: a non-empty (post-trim) string. Anything
 * else — absent, empty string, null, or any non-string — is unusable, and the engine write path
 * (`writeDocVersioned`) replaces it with the current time. A consumer that must DISCLOSE that
 * stamping (e.g. the legacy-name migration's `timestamp_added` receipt) reuses this predicate
 * rather than inventing a second definition of "has a timestamp".
 */
export function isUsableTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
