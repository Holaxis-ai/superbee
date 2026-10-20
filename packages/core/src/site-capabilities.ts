/**
 * Site capabilities: one contract for a read-only tool a site or a recipe pack provides, so the
 * same value serves an assistant's provider adapter, Portal's WebMCP registration and a remote
 * MCP server. This module owns the contract's rules: the descriptor shape, names and the reserved
 * `superbee_` prefix, conflict refusal, deterministic order, per-surface filtering, limits, the
 * composition identity digest, fixture checks, and host-minted `site-record` citations.
 *
 * Pure and platform-neutral: `TextEncoder`, `URL` and the package's own synchronous SHA-256, with
 * no Node built-in, so it runs unchanged in a Cloudflare Worker, a browser and Node. Nothing here
 * executes a capability except `checkSiteCapability` and the conformance cases, which run the
 * caller's own fixtures.
 */
import { sha256HexOfUtf8 } from "./sha256.js";

/**
 * MCP tool hints, plus Portal's `untrustedContentHint` and `privateInputHint`. Other keys pass
 * through unchanged.
 *
 * These are self-declared: a capability states them about itself and nothing at runtime enforces
 * them. `checkSiteCapability` tests recorded fixtures, and `composeSiteCapabilities` with
 * `requireReadOnly` refuses a capability that does not declare `readOnlyHint: true`, but neither
 * proves what the code does. They are acceptable as a control only for in-process code from the
 * same reviewed deploy; never cite them as a control for code a host did not review.
 */
export interface SiteCapabilityAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  /** The result carries text authored or copied by others: a model must treat it as data. */
  readonly untrustedContentHint?: boolean;
  /** The input may carry private data: a surface takes it only in a request body (POST) and never caches or stores it. */
  readonly privateInputHint?: boolean;
  readonly [hint: string]: unknown;
}

/** What a surface passes to `execute`. Every surface passes `signal`; a provider adapter also
 * passes its `toolCallId`; a host that pins the clock (fixtures, evals) passes `now`. */
export interface SiteCapabilityInvocation {
  readonly signal: AbortSignal;
  readonly toolCallId?: string;
  /** Milliseconds since the epoch. A capability reads the clock only through this when present. */
  readonly now?: () => number;
}

/** A citable record in a successful result. The host mints source IDs from these; the tool never
 * does (`siteRecordSource`). */
export interface SiteRecordCitation {
  /** The record's stable ID, as it appears in the result. */
  readonly recordId: string;
  /** The record's same-origin page path, such as `/fairport/places/lift-bridge`. */
  readonly path: string;
  /** When the record's data was current (ISO 8601). */
  readonly asOf: string;
}

/**
 * A tool a site or a recipe pack provides.
 *
 * How it maps onto the existing tool shapes (each mapping is a function below, so no caller relies
 * on structural luck):
 * - Portal `PortalWebMcpAdditionalToolV0` (`@superbee/portal-webmcp` 0.3.x `additionalTools`,
 *   restated here as `PortalAdditionalTool`): a `SiteCapability` is assignable to it, and Portal's
 *   registration keeps only the fields it binds. `toPortalAdditionalTool` makes that explicit;
 *   `siteCapabilityFromPortalTool` maps the other way.
 * - The hosted provider port's `AgentProviderTool` (`name`, `description`, `inputSchema`,
 *   `execute(input, { signal, toolCallId })`): assignable; `toProviderTool` keeps only those fields.
 * - The hosted `ToolDescriptor`, whose `execute` takes an optional invocation with an optional
 *   signal: NOT assignable, because a capability always receives a signal. `toToolDescriptor`
 *   supplies one.
 */
export interface SiteCapability<Result = unknown> {
  /** `^[a-z][a-z0-9_]{2,63}$`: valid for MCP, WebMCP, the Messages API and Managed Agents. */
  readonly name: string;
  /** Stable identity of this implementation, as Portal's `implementationId`: a changed meaning
   * behind an unchanged schema gets a new one. */
  readonly implementationId: string;
  readonly title?: string;
  readonly description: string;
  /** JSON Schema of the input, with `type: "object"`. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: SiteCapabilityAnnotations;
  /** Largest serialized result in UTF-8 bytes. Defaults to `DEFAULT_MAXIMUM_OUTPUT_BYTES`. */
  readonly maximumOutputBytes?: number;
  /** Runs the capability. Failures a caller can act on are results (`{ ok: false, error }`), not
   * throws; a throw is a fault. */
  execute(input: unknown, invocation: SiteCapabilityInvocation): Promise<Result>;
  /** The citable records in a successful result. Never called on a failed result. */
  mintSources?(result: Result): readonly SiteRecordCitation[];
}

/** Serializable capability identity, also used by deliberately trusted local actions.
 * Read-only conformance remains the separate checkSiteCapability contract. */
export type SiteCapabilityMetadata = Omit<SiteCapability, "execute" | "mintSources">;

/** Portal's `PortalWebMcpAdditionalToolV0` (`@superbee/portal-webmcp` 0.3.1, `registration.d.ts`),
 * restated so this package stays dependency-free. */
export interface PortalAdditionalTool {
  readonly name: string;
  readonly implementationId: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  execute(input: unknown, context: { signal: AbortSignal }): Promise<unknown>;
}

/** A host-minted citation of one site record. Like a Portal document source it binds the
 * publication the record was read from, so a citation names exact bytes, not only a date. */
export interface SiteRecordSourceRef {
  readonly sourceId: string;
  readonly kind: "site-record";
  readonly siteId: string;
  readonly recordId: string;
  readonly path: string;
  readonly asOf: string;
  readonly artifactDigest: string;
  readonly snapshotDigest: string;
}

export const SITE_CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
/** Package-owned tools only (Portal's `PORTAL_WEBMCP_RESERVED_PREFIX_V0`). */
export const RESERVED_TOOL_PREFIX = "superbee_";
export const DEFAULT_MAXIMUM_OUTPUT_BYTES = 65536;
/** The closed error-code set a site capability's `{ ok: false }` results use by default. */
export const SITE_CAPABILITY_ERROR_CODES = ["INVALID_INPUT", "NOT_FOUND", "AMBIGUOUS", "NOT_AVAILABLE"] as const;

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]{1,15}$/;
const MAX_IDENTIFIER_BYTES = 256;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * JSON with object keys sorted at every depth, so equal values serialize to equal bytes. Throws on
 * anything JSON cannot carry exactly: functions, symbols, `undefined` array items, non-finite
 * numbers, bigints and cycles. Object properties whose value is `undefined` are omitted, as
 * `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (item: unknown): string => {
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new TypeError(`canonicalJson: ${typeof item}`);
    if (seen.has(item)) throw new TypeError("canonicalJson: cycle");
    seen.add(item);
    try {
      if (Array.isArray(item))
        return `[${item
          .map((entry) => {
            if (entry === undefined) throw new TypeError("canonicalJson: undefined array item");
            return walk(entry);
          })
          .join(",")}]`;
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${walk(record[key])}`)
        .join(",")}}`;
    } finally {
      seen.delete(item);
    }
  };
  return walk(value);
}


/**
 * Whether `path` is a plain same-origin page path: absolute, not protocol-relative, no query,
 * fragment, backslash, control character, encoded slash or dot segment, and unchanged by URL
 * normalization. The same checks as agent-surface's `portalAssistantRoute`. Syntax only: a path
 * such as `/a/%252e%252e/b` or `/a/..;/b` passes, so the host's route-membership check
 * (`admittedPath` in `siteRecordSource`) must still refuse any path it does not serve.
 */
export function isSafeSitePath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 2048 ||
    /[\\?#\u0000-\u001f\u007f]/u.test(path) ||
    /%2f|%5c/iu.test(path)
  )
    return false;
  try {
    if (
      path.split("/").some((part) => {
        const decoded = decodeURIComponent(part);
        return decoded === "." || decoded === ".." || /[\u0000-\u001f\u007f]/u.test(decoded);
      })
    )
      return false;
    const url = new URL(path, "https://site.invalid");
    return url.origin === "https://site.invalid" && url.pathname === path;
  } catch {
    return false;
  }
}

/** An ISO 8601 calendar date, or a date and time with a `Z` or numeric offset (a date-time without an offset is refused, since it names no instant). */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const isDate = (value: unknown): value is string =>
  typeof value === "string" && ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

/**
 * The host-minted `site-record` source for one citation a capability returned, or `undefined`
 * when the citation is malformed, its path is not a safe same-origin path, or the path is not one
 * the host admits. `sourceId` is the host's own ID for this read; a model-produced ID or URL never
 * mints a source. `admittedPath` is the host's route-membership check (the publication's
 * digest-bound route list, or the build's route list): syntax alone does not admit a path.
 */
export function siteRecordSource(options: {
  sourceId: string;
  siteId: string;
  /** The publication the capability read: its artifact and snapshot digests. */
  publication: { artifactDigest: string; snapshotDigest: string };
  citation: SiteRecordCitation;
  admittedPath: (path: string) => boolean;
}): SiteRecordSourceRef | undefined {
  const { sourceId, siteId, publication, citation, admittedPath } = options;
  if (typeof admittedPath !== "function" || !isRecord(publication) || !isRecord(citation)) return undefined;
  // Each field is read once; only these copies are checked and returned, so a getter cannot pass
  // the checks with one value and mint a source with another.
  const artifactDigest: unknown = publication.artifactDigest,
    snapshotDigest: unknown = publication.snapshotDigest;
  const recordId: unknown = citation.recordId,
    path: unknown = citation.path,
    asOf: unknown = citation.asOf;
  const bounded = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && utf8Bytes(value) <= MAX_IDENTIFIER_BYTES;
  if (!bounded(sourceId) || !bounded(siteId)) return undefined;
  if (!bounded(artifactDigest) || !bounded(snapshotDigest)) return undefined;
  if (!bounded(recordId) || typeof path !== "string" || !isSafeSitePath(path) || !isDate(asOf)) return undefined;
  if (admittedPath(path) !== true) return undefined;
  return Object.freeze({
    sourceId,
    kind: "site-record",
    siteId,
    recordId,
    path,
    asOf,
    artifactDigest,
    snapshotDigest,
  });
}

/**
 * Portal's `additionalTools` shape as a `SiteCapability`. The Portal tool keeps receiving exactly
 * `{ signal }`; `extras` adds what Portal's shape has no field for. The reverse needs no adapter:
 * a `SiteCapability` is already a valid `PortalAdditionalTool`.
 */
export function siteCapabilityFromPortalTool(
  tool: PortalAdditionalTool,
  extras: Pick<SiteCapability, "title" | "outputSchema" | "maximumOutputBytes" | "mintSources"> = {},
): SiteCapability {
  return {
    name: tool.name,
    implementationId: tool.implementationId,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(extras.title === undefined ? {} : { title: extras.title }),
    ...(extras.outputSchema === undefined ? {} : { outputSchema: extras.outputSchema }),
    ...(extras.maximumOutputBytes === undefined ? {} : { maximumOutputBytes: extras.maximumOutputBytes }),
    ...(extras.mintSources === undefined ? {} : { mintSources: extras.mintSources }),
    execute: (input, invocation) => tool.execute(input, { signal: invocation.signal }),
  };
}

/** Portal's `additionalTools` entry for a capability: exactly the fields Portal binds, with the
 * capability receiving `{ signal }`. */
export function toPortalAdditionalTool(capability: SiteCapability): PortalAdditionalTool {
  return {
    name: capability.name,
    implementationId: capability.implementationId,
    description: capability.description,
    inputSchema: capability.inputSchema,
    ...(capability.annotations === undefined ? {} : { annotations: capability.annotations }),
    execute: (input, context) => capability.execute(input, { signal: context.signal }),
  };
}

/** The provider port's tool shape (hosted `AgentProviderTool`): name, description, input schema
 * and `execute(input, { signal, toolCallId })`. */
export function toProviderTool(capability: SiteCapability): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, invocation: { signal: AbortSignal; toolCallId: string }): Promise<unknown>;
} {
  return {
    name: capability.name,
    description: capability.description,
    inputSchema: capability.inputSchema as Record<string, unknown>,
    execute: (input, invocation) =>
      capability.execute(input, { signal: invocation.signal, toolCallId: invocation.toolCallId }),
  };
}

/** The hosted `ToolDescriptor` shape, whose callers may omit the invocation or its signal; the
 * capability then receives a signal that never aborts. */
export function toToolDescriptor(capability: SiteCapability): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute(input: unknown, invocation?: { signal?: AbortSignal }): Promise<unknown>;
} {
  return {
    name: capability.name,
    description: capability.description,
    inputSchema: capability.inputSchema as Record<string, unknown>,
    ...(capability.annotations === undefined ? {} : { annotations: { ...capability.annotations } }),
    execute: (input, invocation) =>
      capability.execute(input, { signal: invocation?.signal ?? new AbortController().signal }),
  };
}

/**
 * One annotation set from several declarations of the same capability (for example a WebMCP
 * declaration and an MCP declaration that each carry some hints). For the MCP hints the more
 * cautious value wins: `readOnlyHint` and `idempotentHint` are true only if no set says false;
 * `destructiveHint`, `openWorldHint`, `untrustedContentHint` and `privateInputHint` are true if any
 * set says true. A hint a set leaves out does not count either way, so the result can carry a hint
 * only some sets declared; MCP's defaults for absent hints (`readOnlyHint` false, `openWorldHint`
 * true) apply only when no set declares it. Any other key must not disagree between sets; a
 * disagreement throws.
 */
export function mergeAnnotations(...sets: readonly (SiteCapabilityAnnotations | undefined)[]): SiteCapabilityAnnotations {
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const allTrue = new Set(["readOnlyHint", "idempotentHint"]);
  const anyTrue = new Set(["destructiveHint", "openWorldHint", "untrustedContentHint", "privateInputHint"]);
  for (const set of sets) {
    if (set === undefined) continue;
    if (!isRecord(set)) throw new TypeError("mergeAnnotations: annotations must be objects");
    for (const [key, value] of Object.entries(set)) {
      if (value === undefined) continue;
      if (allTrue.has(key) || anyTrue.has(key)) {
        if (typeof value !== "boolean") throw new TypeError(`mergeAnnotations: ${key} must be boolean`);
        const prior = merged[key] as boolean | undefined;
        merged[key] = prior === undefined ? value : allTrue.has(key) ? prior && value : prior || value;
      } else if (key in merged && canonicalJson(merged[key]) !== canonicalJson(value)) {
        throw new TypeError(`mergeAnnotations: ${key} disagrees`);
      } else merged[key] = value;
    }
  }
  return { ...merged } as SiteCapabilityAnnotations;
}

/** The descriptor a surface shows a model: what the descriptor limits and the identity cover. */
export function siteCapabilityDescriptor(capability: SiteCapabilityMetadata) {
  return {
    name: capability.name,
    ...(capability.title === undefined ? {} : { title: capability.title }),
    description: capability.description,
    inputSchema: capability.inputSchema,
    ...(capability.outputSchema === undefined ? {} : { outputSchema: capability.outputSchema }),
    ...(capability.annotations === undefined ? {} : { annotations: capability.annotations }),
  };
}

/** Why a value is not a structurally valid `SiteCapability`, or `undefined` when it is. Checks the
 * descriptor only; the name rules of a tier are compose's. */
export function siteCapabilityMetadataProblem(value: unknown): string | undefined {
  const capability = value as SiteCapabilityMetadata;
  if (!isRecord(capability)) return "not an object";
  if (typeof capability.name !== "string" || !SITE_CAPABILITY_NAME_PATTERN.test(capability.name))
    return "name must match ^[a-z][a-z0-9_]{2,63}$";
  if (
    typeof capability.implementationId !== "string" ||
    capability.implementationId.length === 0 ||
    utf8Bytes(capability.implementationId) > MAX_IDENTIFIER_BYTES
  )
    return "implementationId must be a non-empty string of at most 256 bytes";
  if (typeof capability.description !== "string" || capability.description.trim().length === 0)
    return "description must be non-empty text";
  if (capability.title !== undefined && (typeof capability.title !== "string" || capability.title.trim().length === 0))
    return "title must be non-empty text when present";
  if (!isRecord(capability.inputSchema) || capability.inputSchema.type !== "object")
    return 'inputSchema must be a JSON Schema object with type "object"';
  if (capability.outputSchema !== undefined && !isRecord(capability.outputSchema))
    return "outputSchema must be an object when present";
  if (capability.annotations !== undefined && !isRecord(capability.annotations))
    return "annotations must be an object when present";
  if (
    capability.maximumOutputBytes !== undefined &&
    (!Number.isSafeInteger(capability.maximumOutputBytes) || capability.maximumOutputBytes <= 0)
  )
    return "maximumOutputBytes must be a positive integer when present";
  try {
    canonicalJson(siteCapabilityDescriptor(capability));
  } catch {
    return "descriptor must be plain JSON";
  }
  return undefined;
}

function descriptorProblem(capability: SiteCapability): string | undefined {
  const problem = siteCapabilityMetadataProblem(capability);
  if (problem) return problem;
  if (typeof capability.execute !== "function") return "execute must be a function";
  if (capability.mintSources !== undefined && typeof capability.mintSources !== "function")
    return "mintSources must be a function when present";
  return undefined;
}

/** Thrown by `capture` when a JSON field of a capability is not plain JSON. */
class NotPlainJson extends Error {}

/**
 * Reads each field of a capability exactly once into a plain object, with its JSON fields
 * (`inputSchema`, `outputSchema`, `annotations`) cloned through canonical JSON. Validation, the
 * frozen snapshot, the digest and every surface then see the same values even when the caller
 * passes getters or later mutates its objects. A non-object is returned unchanged for
 * `descriptorProblem` to report. Throws when a field cannot be read, and `NotPlainJson` when a JSON
 * field is not plain JSON.
 */
function capture(capability: SiteCapability): SiteCapability {
  if (!isRecord(capability)) return capability;
  const source = capability;
  const name = source.name,
    implementationId = source.implementationId,
    title = source.title,
    description = source.description,
    inputSchema = source.inputSchema,
    outputSchema = source.outputSchema,
    annotations = source.annotations,
    maximumOutputBytes = source.maximumOutputBytes,
    execute = source.execute,
    mintSources = source.mintSources;
  const clone = <T>(value: T): T => {
    if (value === undefined) return value;
    let text: string;
    try {
      text = canonicalJson(value);
    } catch {
      throw new NotPlainJson();
    }
    return JSON.parse(text) as T;
  };
  return {
    name,
    implementationId,
    ...(title === undefined ? {} : { title }),
    description,
    inputSchema: clone(inputSchema),
    ...(outputSchema === undefined ? {} : { outputSchema: clone(outputSchema) }),
    ...(annotations === undefined ? {} : { annotations: clone(annotations) }),
    ...(maximumOutputBytes === undefined ? {} : { maximumOutputBytes }),
    execute: execute === undefined ? execute : bindTo(source, execute),
    ...(mintSources === undefined ? {} : { mintSources: bindTo(source, mintSources) }),
  } as SiteCapability;
}

/** `method` called with `source` as `this`, or `method` itself when it is not a function, so
 * `descriptorProblem` still sees what the caller passed. */
function bindTo<F>(source: object, method: F): F {
  if (typeof method !== "function") return method;
  return ((...args: unknown[]) => (method as (...a: unknown[]) => unknown).apply(source, args)) as F;
}

/** The validated capture, frozen at every depth. */
function snapshot(captured: SiteCapability): SiteCapability {
  return Object.freeze({
    ...captured,
    inputSchema: deepFreeze(captured.inputSchema),
    ...(captured.outputSchema === undefined ? {} : { outputSchema: deepFreeze(captured.outputSchema) }),
    ...(captured.annotations === undefined ? {} : { annotations: deepFreeze(captured.annotations) }),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** The three tiers of site-capability design, composed in this order. */
export type SiteCapabilityTier = "generic" | "pack" | "site";

/** One declared list. `pack` and `site` lists own a namespace: each name starts with
 * `<namespace>_` (`guide_open_now`, `hm_who_handles`). `generic` lists (the Portal snapshot reads,
 * hosted reads) have none and alone may use the reserved `superbee_` prefix. */
export interface SiteCapabilityGroup {
  readonly tier: SiteCapabilityTier;
  readonly namespace?: string;
  readonly capabilities: readonly SiteCapability[];
}

export interface SiteCapabilityLimits {
  readonly maxTools: number;
  /** Per descriptor (`siteCapabilityDescriptor`), canonical JSON in UTF-8 bytes. */
  readonly maxDescriptorBytes: number;
  /** All kept descriptors together. */
  readonly maxTotalDescriptorBytes: number;
}
export const DEFAULT_SITE_CAPABILITY_LIMITS: SiteCapabilityLimits = Object.freeze({
  maxTools: 32,
  maxDescriptorBytes: 4096,
  maxTotalDescriptorBytes: 49152,
});

export interface ComposeSiteCapabilitiesOptions {
  /** The surface this list is for (`hm-ask`, `webmcp`, `mcp`); part of the identity digest. */
  readonly surface: string;
  /** Names this surface does not offer. Applied after every conflict check, so a filter can never
   * hide a conflict. Naming a capability that is not composed refuses. */
  readonly exclude?: readonly string[];
  /** Refuse any capability that does not declare `readOnlyHint: true`, or declares
   * `destructiveHint: true`, in any tier (a static-site surface has no writes). Checked before
   * `exclude`, so excluding a write tool does not make the list acceptable. The hints are
   * self-declared (see `SiteCapabilityAnnotations`). */
  readonly requireReadOnly?: boolean;
  readonly limits?: Partial<SiteCapabilityLimits>;
}

export type SiteCapabilityCompositionRefusal =
  /** The surface ID is empty or longer than 256 bytes. */
  | "invalid_surface"
  /** A group has an unknown tier, a missing, invalid, reserved or repeated namespace, or a
   * namespace on the generic tier. */
  | "invalid_group"
  /** A capability is not structurally valid (see `checkSiteCapability` for behavior). */
  | "invalid_descriptor"
  | "duplicate_name"
  /** A `superbee_` name outside the generic tier. */
  | "reserved_prefix"
  /** A pack or site name that does not start with its group's namespace. */
  | "outside_namespace"
  /** `requireReadOnly` and a capability that does not declare itself read-only. */
  | "not_read_only"
  | "unknown_exclusion"
  | "too_many_tools"
  | "descriptor_too_large"
  | "total_too_large";

export type SiteCapabilityComposition =
  | {
      readonly ok: true;
      readonly surface: string;
      /** Frozen snapshots in composed order: generic, then packs, then site extras, each in
       * declaration order. Pass them unchanged to a provider adapter, Portal registration or an
       * MCP server. */
      readonly capabilities: readonly SiteCapability[];
      /** The tier of each entry of `capabilities`, index for index. */
      readonly tiers: readonly SiteCapabilityTier[];
      /** Names removed by `exclude`, in composed order. */
      readonly dropped: readonly string[];
      /** SHA-256 of the canonical JSON `{ schema: "superbee-site-capabilities/v1", surface, tools }`,
       * where each tool is `{ tier, namespace, implementationId, maximumOutputBytes, descriptor }`
       * for the kept capabilities in composed order. It identifies one surface's tool list: record
       * it per session and compare it at provisioning. It is not Portal registration's
       * `identityDigest`, which also binds the publication, owner and activation. */
      readonly identityDigest: `sha256:${string}`;
    }
  | {
      readonly ok: false;
      readonly refused: SiteCapabilityCompositionRefusal;
      /** The names (or, for `invalid_group`, the namespaces) involved, when there are any. */
      readonly names: readonly string[];
      /** A fixed English explanation; never echoes descriptor text. */
      readonly detail: string;
    };

const TIER_ORDER: readonly SiteCapabilityTier[] = ["generic", "pack", "site"];

/**
 * Composes the capabilities one surface offers. This is the one owner of the composition rule;
 * Portal's registration applies the same reserved-prefix and duplicate refusals to its own
 * additional tools and can call this instead. Conflicts refuse the whole
 * composition, never shadow: a duplicate name, a `superbee_` name outside the generic tier, or a
 * pack or site name outside its namespace. Order is deterministic (generic, packs, site extras,
 * each in declaration order), which prompt caching and the Managed Agents byte check depend on.
 * The surface's exclusions apply after the conflict checks; the limits apply to what is kept.
 */
export function composeSiteCapabilities(
  groups: readonly SiteCapabilityGroup[],
  options: ComposeSiteCapabilitiesOptions,
): SiteCapabilityComposition {
  const refuse = (
    refused: SiteCapabilityCompositionRefusal,
    detail: string,
    names: readonly string[] = [],
  ): SiteCapabilityComposition => Object.freeze({ ok: false, refused, names: Object.freeze([...names]), detail });
  // A limit that is not a non-negative safe integer (undefined, NaN, Infinity) keeps its default,
  // so a malformed override can never switch a limit off.
  const limit = (key: keyof SiteCapabilityLimits): number => {
    const value = (options.limits as Partial<SiteCapabilityLimits> | undefined)?.[key];
    return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : DEFAULT_SITE_CAPABILITY_LIMITS[key];
  };
  const limits: SiteCapabilityLimits = {
    maxTools: limit("maxTools"),
    maxDescriptorBytes: limit("maxDescriptorBytes"),
    maxTotalDescriptorBytes: limit("maxTotalDescriptorBytes"),
  };
  if (typeof options.surface !== "string" || options.surface.length === 0 || utf8Bytes(options.surface) > 256)
    return refuse("invalid_surface", "surface must be a non-empty string of at most 256 bytes");

  const namespaces = new Set<string>();
  const entries: { tier: SiteCapabilityTier; namespace: string | null; capability: SiteCapability }[] = [];
  for (const tier of TIER_ORDER) {
    for (const group of groups) {
      if (!isRecord(group) || !TIER_ORDER.includes(group.tier))
        return refuse("invalid_group", "each group needs a tier of generic, pack or site");
      if (group.tier !== tier) continue;
      if (tier === "generic") {
        if (group.namespace !== undefined)
          return refuse("invalid_group", "the generic tier has no namespace", [String(group.namespace)]);
      } else if (
        typeof group.namespace !== "string" ||
        !NAMESPACE_PATTERN.test(group.namespace) ||
        `${group.namespace}_` === RESERVED_TOOL_PREFIX ||
        namespaces.has(group.namespace)
      ) {
        return refuse(
          "invalid_group",
          "each pack and site group needs its own namespace matching ^[a-z][a-z0-9]{1,15}$, other than superbee",
          typeof group.namespace === "string" ? [group.namespace] : [],
        );
      }
      if (tier !== "generic") namespaces.add(group.namespace!);
      if (!Array.isArray(group.capabilities)) return refuse("invalid_group", "capabilities must be an array");
      for (const capability of group.capabilities) {
        let owned: SiteCapability;
        try {
          // Validate the one capture, never the caller's object, so a getter cannot pass the
          // checks with one value and ship another.
          const captured = capture(capability);
          const problem = descriptorProblem(captured);
          if (problem)
            return refuse("invalid_descriptor", problem, typeof captured?.name === "string" ? [captured.name] : []);
          owned = snapshot(captured);
        } catch (error) {
          if (error instanceof NotPlainJson) return refuse("invalid_descriptor", "descriptor must be plain JSON");
          return refuse("invalid_descriptor", "descriptor could not be read");
        }
        entries.push({ tier, namespace: tier === "generic" ? null : group.namespace!, capability: owned });
      }
    }
  }

  const seen = new Set<string>();
  for (const { tier, namespace, capability } of entries) {
    if (seen.has(capability.name)) return refuse("duplicate_name", "two capabilities share a name", [capability.name]);
    seen.add(capability.name);
    if (tier !== "generic" && capability.name.startsWith(RESERVED_TOOL_PREFIX))
      return refuse("reserved_prefix", "superbee_ names belong to the generic tier", [capability.name]);
    if (namespace !== null && !capability.name.startsWith(`${namespace}_`))
      return refuse("outside_namespace", "a pack or site name must start with its namespace and _", [capability.name]);
    if (
      options.requireReadOnly === true &&
      (capability.annotations?.readOnlyHint !== true || capability.annotations?.destructiveHint === true)
    )
      return refuse("not_read_only", "this surface takes only capabilities declared read-only", [capability.name]);
  }

  const exclude = options.exclude ?? [];
  const unknown = exclude.filter((name) => !seen.has(name));
  if (unknown.length) return refuse("unknown_exclusion", "an excluded name is not composed", unknown);
  const excluded = new Set(exclude);
  const kept = entries.filter((entry) => !excluded.has(entry.capability.name));
  const dropped = entries.filter((entry) => excluded.has(entry.capability.name)).map((entry) => entry.capability.name);

  if (kept.length > limits.maxTools)
    return refuse("too_many_tools", `at most ${limits.maxTools} tools per surface`);
  let total = 0;
  for (const { capability } of kept) {
    const size = utf8Bytes(canonicalJson(siteCapabilityDescriptor(capability)));
    if (size > limits.maxDescriptorBytes)
      return refuse("descriptor_too_large", `a descriptor is over ${limits.maxDescriptorBytes} bytes`, [
        capability.name,
      ]);
    total += size;
  }
  if (total > limits.maxTotalDescriptorBytes)
    return refuse("total_too_large", `descriptors total over ${limits.maxTotalDescriptorBytes} bytes`);

  const identityDigest: `sha256:${string}` = `sha256:${sha256HexOfUtf8(
    canonicalJson({
      schema: "superbee-site-capabilities/v1",
      surface: options.surface,
      tools: kept.map(({ tier, namespace, capability }) => ({
        tier,
        namespace,
        implementationId: capability.implementationId,
        maximumOutputBytes: capability.maximumOutputBytes ?? null,
        descriptor: siteCapabilityDescriptor(capability),
      })),
    }),
  )}`;
  return Object.freeze({
    ok: true,
    surface: options.surface,
    capabilities: Object.freeze(kept.map((entry) => entry.capability)),
    tiers: Object.freeze(kept.map((entry) => entry.tier)),
    dropped: Object.freeze(dropped),
    identityDigest,
  });
}

/** The requirements `checkSiteCapability` tests from fixtures. Whether each record carries its own
 * sources with checked dates has no site-neutral shape; a site checks that, and anything else
 * site-specific, with its own fixture assertions (`SiteCapabilityFixture.check`, reported as
 * `site`). */
export type SiteCapabilityRequirement =
  | "descriptor"
  | "read_only"
  | "dated"
  | "stable_ids"
  | "public_urls"
  | "errors"
  | "bounded"
  | "deterministic"
  | "input_checked"
  | "fixed_text"
  | "site";

/** One recorded input and what it must produce. */
export interface SiteCapabilityFixture {
  /** Shown in problems; defaults to the fixture's index. */
  readonly name?: string;
  readonly input: unknown;
  readonly expect: "ok" | "error";
  /** For `expect: "error"`, the exact code. */
  readonly errorCode?: string;
  /** The pinned clock for this fixture, in milliseconds since the epoch. */
  readonly now?: number;
  /** A site's own assertion over the result (per-record sources, anything site-specific): return a
   * problem description, or nothing when the result is acceptable. */
  readonly check?: (result: unknown) => string | undefined | void;
}

export interface CheckSiteCapabilityOptions {
  /** The site's own origin, such as `https://hereandmain.town`. Every absolute http(s) URL in a
   * result must be on it, or on one of `externalHosts`. */
  readonly origin: string;
  /** Hosts whose pages a result may link to: a provider's own page for a feed-only item. */
  readonly externalHosts?: readonly string[];
  /** The closed error-code set; defaults to `SITE_CAPABILITY_ERROR_CODES`. */
  readonly errorCodes?: readonly string[];
  /** The pinned clock for fixtures without their own. Defaults to 2026-01-01T12:00:00Z. */
  readonly now?: number;
  /** Probe one successful fixture's input with an unknown argument, which must be refused
   * with `{ ok: false }`. Default true. */
  readonly probeUnknownArgument?: boolean;
}

export interface SiteCapabilityProblem {
  readonly requirement: SiteCapabilityRequirement;
  readonly fixture?: string;
  readonly detail: string;
}
export interface SiteCapabilityCheck {
  readonly ok: boolean;
  readonly problems: readonly SiteCapabilityProblem[];
}

const DEFAULT_CHECK_NOW = Date.UTC(2026, 0, 1, 12);
const UNKNOWN_ARGUMENT = "zz_unexpected_argument";

function* strings(value: unknown, depth = 0): Generator<string> {
  if (depth > 64) return;
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const entry of value) yield* strings(entry, depth + 1);
  else if (isRecord(value)) for (const entry of Object.values(value)) yield* strings(entry, depth + 1);
}

/** A script or data URL as a whole string, or as a Markdown link, quoted or attribute value. */
const SCRIPT_URL_IN_TEXT = /(?:^\s*|\]\(\s*|["'<=]\s*)(?:javascript|data|vbscript):/iu;
/** An absolute URL in text: any scheme with `//`, a web scheme with up to two slashes or
 * backslashes (URL parsing reads `https:evil.example` as `https://evil.example`), or a
 * protocol-relative URL at the start of a word or attribute value. */
const URL_IN_TEXT =
  /(?:[a-z][a-z0-9+.-]*:\/\/|(?<![a-z0-9+.-])(?:https?|wss?|ftp):[\\/]{0,2}(?=[^\s\\/])|(?<![^\s("'<[=>])\/\/)[^\s<>"'`)\]]+/giu;
/** Sentence punctuation that ends prose, not the URL before it. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

/**
 * Tests one capability against recorded fixtures and the site capability requirements:
 * a valid, read-only descriptor; results that are deterministic for a pinned clock, bounded,
 * dated (`as_of`) when successful, and `{ ok: false, error: { code, message } }` with a closed code
 * and a message that never echoes input when not; absolute URLs only on the site's origin or its
 * declared external hosts; every citation from `mintSources` naming a record ID present in the
 * result and a safe same-origin path; unknown arguments refused; and a descriptor that running
 * the fixtures does not change. Runs each fixture twice. Never throws for a capability's fault.
 */
export async function checkSiteCapability(
  capability: SiteCapability,
  fixtures: readonly SiteCapabilityFixture[],
  options: CheckSiteCapabilityOptions,
): Promise<SiteCapabilityCheck> {
  const problems: SiteCapabilityProblem[] = [];
  const add = (requirement: SiteCapabilityRequirement, detail: string, fixture?: string) =>
    problems.push(Object.freeze({ requirement, detail, ...(fixture === undefined ? {} : { fixture }) }));
  const structural = descriptorProblem(capability);
  if (structural) {
    add("descriptor", structural);
    return Object.freeze({ ok: false, problems: Object.freeze(problems) });
  }
  if (capability.name.startsWith(RESERVED_TOOL_PREFIX)) add("descriptor", "site capabilities never use superbee_");
  if (capability.annotations?.readOnlyHint !== true) add("read_only", "annotations.readOnlyHint must be true");
  if (capability.annotations?.destructiveHint === true) add("read_only", "annotations.destructiveHint must not be true");
  const descriptorBefore = canonicalJson({
    ...siteCapabilityDescriptor(capability),
    implementationId: capability.implementationId,
  });
  const origin = new URL(options.origin).origin;
  const externalHosts = new Set((options.externalHosts ?? []).map((host) => host.toLowerCase()));
  const codes = new Set(options.errorCodes ?? SITE_CAPABILITY_ERROR_CODES);
  const maximum = capability.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;

  const run = async (input: unknown, now: number): Promise<{ result?: unknown; thrown?: true }> => {
    try {
      const controller = new AbortController();
      return { result: await capability.execute(structuredClone(input), { signal: controller.signal, now: () => now }) };
    } catch {
      return { thrown: true };
    }
  };

  const examine = async (fixture: SiteCapabilityFixture, label: string) => {
    const now = fixture.now ?? options.now ?? DEFAULT_CHECK_NOW;
    const first = await run(fixture.input, now);
    const second = await run(fixture.input, now);
    if (first.thrown || second.thrown) {
      add("errors", "execute threw; a refusal must be a { ok: false } result", label);
      return;
    }
    const result = first.result;
    let serialized: string;
    try {
      serialized = canonicalJson(result);
    } catch {
      add("bounded", "the result is not plain JSON", label);
      return;
    }
    if (utf8Bytes(serialized) > maximum) add("bounded", `the result is over ${maximum} bytes`, label);
    let again: string | undefined;
    try {
      again = canonicalJson(second.result);
    } catch {
      again = undefined;
    }
    if (again !== serialized) add("deterministic", "the same input and clock gave different results", label);
    if (!isRecord(result) || typeof result.ok !== "boolean") {
      add("errors", "a result must be an object with a boolean ok", label);
      return;
    }
    for (const text of strings(result)) {
      // URL parsing removes tabs and newlines, so `java\tscript:` is a script URL too.
      if (SCRIPT_URL_IN_TEXT.test(text.replace(/[\t\r\n]/gu, ""))) {
        add("public_urls", "a result carries a script or data URL", label);
        continue;
      }
      // Every absolute or protocol-relative URL in the text, not only a string that is one URL:
      // prose and Markdown links can carry them too.
      for (const [match] of text.matchAll(URL_IN_TEXT)) {
        let url: URL;
        try {
          const candidate = match.replace(TRAILING_PUNCTUATION, "");
          url = new URL(candidate.startsWith("//") ? `${new URL(origin).protocol}${candidate}` : candidate);
        } catch {
          continue;
        }
        if (url.origin === origin) continue;
        if ((url.protocol === "https:" || url.protocol === "http:") && externalHosts.has(url.hostname.toLowerCase()))
          continue;
        add("public_urls", `a result links off the site: ${url.origin}`, label);
      }
    }
    if (fixture.expect === "ok") {
      if (result.ok !== true) {
        add("errors", "expected a successful result", label);
        return;
      }
      if (!isDate(result.as_of)) add("dated", "a successful result needs an ISO 8601 as_of", label);
      if (capability.mintSources) {
        let citations: readonly SiteRecordCitation[];
        try {
          citations = capability.mintSources(result);
        } catch {
          add("stable_ids", "mintSources threw", label);
          citations = [];
        }
        if (!Array.isArray(citations)) add("stable_ids", "mintSources must return an array", label);
        else {
          const present = new Set(strings(result));
          for (const citation of citations) {
            if (!isRecord(citation) || typeof citation.recordId !== "string" || !present.has(citation.recordId))
              add("stable_ids", "a cited record ID does not appear in the result", label);
            else if (!isSafeSitePath(citation.path))
              add("stable_ids", `the citation of ${citation.recordId} has an unsafe path`, label);
            else if (!isDate(citation.asOf))
              add("stable_ids", `the citation of ${citation.recordId} has no ISO 8601 asOf`, label);
          }
        }
      }
    } else {
      const error = result.error;
      if (result.ok !== false || !isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string") {
        add("errors", "expected { ok: false, error: { code, message } }", label);
        return;
      }
      if (!codes.has(error.code)) add("errors", `error code ${error.code} is outside the closed set`, label);
      if (fixture.errorCode !== undefined && error.code !== fixture.errorCode)
        add("errors", `expected error code ${fixture.errorCode}, got ${error.code}`, label);
      const message = error.message;
      for (const text of strings(fixture.input))
        if (text.trim().length >= 3 && message.includes(text)) {
          add("errors", "an error message echoes the input", label);
          break;
        }
    }
    try {
      const verdict = fixture.check?.(result);
      if (typeof verdict === "string" && verdict) add("site", verdict, label);
    } catch {
      add("site", "the fixture's own check threw", label);
    }
  };

  for (const [index, fixture] of fixtures.entries()) await examine(fixture, fixture.name ?? String(index));

  const sample = fixtures.find((fixture) => fixture.expect === "ok" && isRecord(fixture.input));
  if (options.probeUnknownArgument !== false) {
    if (!sample) add("input_checked", "no successful fixture with an object input to probe");
    else {
      const probe = await run(
        { ...(sample.input as Record<string, unknown>), [UNKNOWN_ARGUMENT]: 1 },
        sample.now ?? options.now ?? DEFAULT_CHECK_NOW,
      );
      if (probe.thrown || !isRecord(probe.result) || probe.result.ok !== false)
        add("input_checked", "an unknown argument was not refused with { ok: false }", "unknown-argument probe");
    }
  }
  const descriptorAfter = (() => {
    try {
      return canonicalJson({ ...siteCapabilityDescriptor(capability), implementationId: capability.implementationId });
    } catch {
      return undefined;
    }
  })();
  if (descriptorAfter !== descriptorBefore) add("fixed_text", "running the capability changed its descriptor");
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

/** One named conformance case. `run` resolves when the capability conforms and rejects with an
 * `Error` naming every problem otherwise. Runner-neutral: wrap each case in `node:test`, Vitest or
 * any other runner (`for (const c of cases) test(c.name, c.run)`). */
export interface SiteCapabilityConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

const REQUIREMENT_TITLES: Readonly<Record<SiteCapabilityRequirement, string>> = {
  descriptor: "has a valid descriptor with a fixed name, implementation ID and object input schema",
  read_only: "declares itself read-only and not destructive",
  dated: "dates every successful result with as_of",
  stable_ids: "cites only record IDs present in the result, with safe paths and dates",
  public_urls: "links only to the site's origin or its declared external hosts",
  errors: "refuses with { ok: false, error: { code, message } } from the closed code set, never echoing input",
  bounded: "stays within its maximum output bytes",
  deterministic: "returns the same result for the same input and clock",
  input_checked: "refuses unknown arguments",
  fixed_text: "keeps its descriptor fixed while it runs",
  site: "passes the site's own fixture assertions",
};

/**
 * The reusable conformance suite for one capability: one case per requirement checked by
 * `checkSiteCapability`, plus the composition and mapping cases every surface relies on (it
 * composes alone in its own namespace on a read-only surface, and its provider, Portal and
 * descriptor mappings carry the same name, description and schema). A site, a pack and any host
 * run the same cases over the same fixtures.
 */
export function siteCapabilityConformanceCases(
  capability: SiteCapability,
  fixtures: readonly SiteCapabilityFixture[],
  options: CheckSiteCapabilityOptions & { readonly namespace?: string },
): readonly SiteCapabilityConformanceCase[] {
  let checked: Promise<SiteCapabilityCheck> | undefined;
  const check = () => (checked ??= checkSiteCapability(capability, fixtures, options));
  const label = typeof capability?.name === "string" ? capability.name : "capability";
  const cases: SiteCapabilityConformanceCase[] = (Object.keys(REQUIREMENT_TITLES) as SiteCapabilityRequirement[]).map(
    (requirement) => ({
      name: `${label} ${REQUIREMENT_TITLES[requirement]}`,
      async run() {
        const problems = (await check()).problems.filter((problem) => problem.requirement === requirement);
        if (problems.length)
          throw new Error(
            problems.map((problem) => (problem.fixture ? `[${problem.fixture}] ` : "") + problem.detail).join("\n"),
          );
      },
    }),
  );
  cases.push({
    name: `${label} composes alone in its namespace on a read-only surface`,
    async run() {
      const namespace = options.namespace ?? (typeof capability?.name === "string" ? capability.name.split("_")[0] : "");
      const composed = composeSiteCapabilities([{ tier: "site", namespace, capabilities: [capability] }], {
        surface: "conformance",
        requireReadOnly: true,
      });
      if (!composed.ok) throw new Error(`refused: ${composed.refused} (${composed.detail})`);
    },
  });
  cases.push({
    name: `${label} maps to the provider, Portal and descriptor tool shapes unchanged`,
    async run() {
      const expected = canonicalJson([capability.name, capability.description, capability.inputSchema]);
      for (const mapped of [toProviderTool(capability), toPortalAdditionalTool(capability), toToolDescriptor(capability)])
        if (canonicalJson([mapped.name, mapped.description, mapped.inputSchema]) !== expected)
          throw new Error("a mapping changed the name, description or input schema");
      const portal = toPortalAdditionalTool(capability);
      if (portal.implementationId !== capability.implementationId) throw new Error("the Portal mapping lost implementationId");
    },
  });
  return Object.freeze(cases);
}
