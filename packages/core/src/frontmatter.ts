/**
 * Markdown + YAML frontmatter parsing and gray-matter-compatible serialization.
 *
 * This is the full-document YAML parse/serialize surface; every other module works with the
 * already-parsed {@link Frontmatter}/body shapes. The runtime-neutral root-marker reader shares
 * the same exact delimiter splitter. Unknown keys are preserved on round-trip (OKF v0.1 §9 /
 * v0.2 §11 permissive consumption).
 */

import yaml from "js-yaml";
import { FRONTMATTER_LIMITS, loadBoundedYaml } from "./bounded-yaml.js";
import { FrontmatterRefusedError } from "./errors.js";
import { FrontmatterLimitError, MalformedDocumentError } from "./frontmatter-contract.js";
import { splitLeadingFrontmatter, startsWithFrontmatterSyntax } from "./frontmatter-splitter.js";
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
    return (loadBoundedYaml(input, { schema: losslessDateSchema }) ?? {}) as object;
  },
};

/** Options shared by full-document and standalone YAML decoding. */
export interface ParseDocumentOptions {
  okfVersion?: string;
  /** Preserve the stored legacy timestamp value instead of applying v0.1 normalization. */
  preserveTimestamp?: boolean;
}

/**
 * Normalize the legacy top-level `timestamp` field to an ISO-8601 string.
 *
 * gray-matter/js-yaml turns an UNQUOTED ISO timestamp scalar — the form OKF's own
 * sample bundles use (`timestamp: 2026-07-01T12:05:00Z`) — into a non-string under its
 * default schema. The parser above now retains all YAML timestamp scalars as strings so
 * date-only values remain distinguishable at any depth. This legacy field still keeps its
 * established canonical ISO behavior, including epoch-millisecond input, for default/v0.1
 * decoding. v0.2 and explicit stored decoding preserve its value so consumers can distinguish
 * ambiguous legacy clocks.
 */
function normalizeFrontmatter(data: Record<string, unknown>, options: ParseDocumentOptions): Frontmatter {
  const out: Record<string, unknown> = { ...data };
  if (options.preserveTimestamp || options.okfVersion === "0.2") return out as Frontmatter;
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
 * The shared splitter recognizes only exact OKF delimiters, and the fixed YAML engine preserves
 * timestamp-like scalars as strings so date-only values retain their original semantic shape.
 */
export function parseMarkdown(
  raw: string,
  context?: string,
  options: ParseDocumentOptions = {},
): { frontmatter: Frontmatter; body: string } {
  const split = splitLeadingFrontmatter(raw, context);
  if (!("yamlSource" in split)) return { frontmatter: {} as Frontmatter, body: split.body };

  return { frontmatter: parseFrontmatter(split.yamlSource, context, options), body: split.body };
}

/** Decode YAML metadata independently of document delimiters and body content. */
export function parseFrontmatter(
  source: string,
  context?: string,
  options: ParseDocumentOptions = {},
): Frontmatter {
  let parsed;
  try {
    parsed = yamlEngine.parse(source);
  } catch (err) {
    throw new MalformedDocumentError(context, err);
  }
  return normalizeFrontmatter(parsed as Record<string, unknown>, options);
}

/** Whether an error is the engine running out of stack, as each JavaScript engine reports it. */
export function isStackExhaustion(error: unknown): boolean {
  if (error instanceof RangeError) return /call stack/i.test(error.message);
  return (error as { name?: unknown } | null)?.name === "InternalError" && /recursion/i.test((error as Error).message);
}

/**
 * The metadata bytes shared by document serialization and parsed-object stores. Every document
 * write serializes its frontmatter here, and this refuses with {@link FrontmatterRefusedError} any
 * bytes the frontmatter reader would refuse. Reserved files are stored as given, so each backend
 * checks them with `assertStorableReservedWrite` instead.
 */
export function stringifyFrontmatter(data: Record<string, unknown>): string {
  let dumped: string;
  try {
    dumped = yaml.safeDump(data).trim();
  } catch (error) {
    // The dumper recurses, so a value nested far past the limit exhausts the stack before the check below.
    if (isStackExhaustion(error)) throw new FrontmatterRefusedError("FRONTMATTER_TOO_DEEP", `YAML nesting is deeper than ${FRONTMATTER_LIMITS.depth} levels`);
    throw error;
  }
  try {
    // Check the exact text a reader will see between the fences, including the framing newline.
    yamlEngine.parse(`${dumped}\n`);
  } catch (error) {
    if (error instanceof FrontmatterLimitError) throw new FrontmatterRefusedError(error.code, error.message);
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    throw new FrontmatterRefusedError("FRONTMATTER_MALFORMED", detail);
  }
  return dumped;
}

/** Match the exact body shape emitted by the document serializer. */
export function normalizeDocumentBodyForStorage(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** Serialize an arbitrary YAML-mapping + body to OKF markdown (used for reserved files). */
export function stringifyWithData(data: Record<string, unknown>, body: string): string {
  return stringifyWithSerializedFrontmatter(stringifyFrontmatter(data), body);
}

/** Frame already-serialized metadata, so a snapshot and its version use the same bytes. */
export function stringifyWithSerializedFrontmatter(dumped: string, body: string): string {
  const content = body ?? "";
  const newline = (value: string): string => (value.endsWith("\n") ? value : `${value}\n`);
  if (dumped === "{}") {
    // Like gray-matter, empty metadata writes a bare body, unless the reader would misread that body.
    return `${startsWithFrontmatterSyntax(content) ? "---\n---\n" : ""}${normalizeDocumentBodyForStorage(content)}`;
  }
  return `---\n${newline(dumped)}---\n${normalizeDocumentBodyForStorage(content)}`;
}

/** Serialize a concept document's frontmatter + body to OKF-conformant markdown. */
export function stringifyDoc(frontmatter: Frontmatter, body: string): string {
  return stringifyWithData(frontmatter as Record<string, unknown>, body);
}
