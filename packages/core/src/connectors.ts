/**
 * `@superbee/core/connectors`: target-agnostic Connector declarations.
 *
 * A Connector is a `type: Connector` document under `connectors/` that says what an integration
 * is: the credential kind (whose hosts come only from core's {@link AUTH_PROVIDERS} table, never
 * from the document), keyless `domains`, sources that map normalized records onto one target
 * Kind's fields, and actions and events as declared shapes. The document holds no authority:
 * nothing here fetches, executes or receives. {@link parseConnectorDoc} is the one parser, every
 * nested block is closed by {@link CONNECTOR_KEYS}, and {@link connectorPinDigest} reads the same
 * table, so a key cannot be accepted without being pinned.
 *
 * The mapping contract is code: {@link mapRecord} never lets a mapping gap erase a stored value (an
 * unobserved field is carried, an unmapped value is kept or refuses the record, and only an
 * explicit empty value clears an optional field); {@link changeBetween} builds the record-overlay
 * change; {@link findingsFor} turns diagnostics into findings for `planFindings`.
 * Storage-neutral: no Node globals or builtins.
 */
import { compareCodePoints } from "./code-point-order.js";
import { isStandardDocumentSetField } from "./document-field-actions.js";
import { PROGRESS_STATUS_FIELD, isKindListField, isPresent, type KindConvention, type KindRegistry } from "./kinds.js";
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";
import { overlayCanonicalJson, same } from "./record-overlay/canonical.js";
import { OverlayRefusal, REFUSAL_CODES } from "./record-overlay/errors.js";
import { NEVER_OWNED, readOverlayPolicy, workStateFields } from "./record-overlay/policy.js";
import type { Finding, OverlayPolicy, RecordChange } from "./record-overlay/types.js";
import { definitionCanonicalJson } from "./recipe-lifecycle/stamp.js";
import type { ConceptId, Frontmatter, OkfDocument } from "./types.js";
import type { ValidationWarning } from "./validation.js";
import { sha256Hex } from "./versioning.js";

export const CONNECTOR_TYPE = "Connector";
export const CONNECTORS_PREFIX = "connectors/";
/** The normalization rules of {@link connectorPinDigest}; bumped whenever a default or sort rule changes. */
export const CONNECTOR_PIN_RULES = 1;

/**
 * Credential providers: provider key to the exact hostnames a `token` or `oauth2` credential may be
 * sent to. A document names a row; it never states a host. Each row is added in its own reviewed
 * change, verified against the vendor's primary documentation. The pin records the hosts a row
 * resolves to, so adding a host to an existing row changes the pin of every Connection on that
 * provider, which then needs approving again.
 */
export const AUTH_PROVIDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  github: Object.freeze(["api.github.com"]),
});
const GITHUB_APP_HOSTS: readonly string[] = Object.freeze(["api.github.com"]);

/** The accepted keys of every closed block. The shape check and the pin digest read only this table. */
export const CONNECTOR_KEYS = Object.freeze({
  auth: Object.freeze(["kind", "provider", "permissions", "scheme"]),
  source: Object.freeze(["name", "profile", "target_kind", "mode", "identity", "fields", "completeness"]),
  identity: Object.freeze(["resource", "id"]),
  mapping: Object.freeze(["from", "values", "unmapped"]),
  action: Object.freeze(["name", "method", "host", "input", "confirm"]),
  input: Object.freeze(["type", "required", "values"]),
  event: Object.freeze(["name", "signature", "references"]),
  signature: Object.freeze(["scheme", "header"]),
}) satisfies Readonly<Record<string, readonly string[]>>;
export type ConnectorBlock = keyof typeof CONNECTOR_KEYS;

export const CONNECTOR_ERROR_CODES = Object.freeze([
  "CONNECTOR_MALFORMED",
  "CONNECTOR_UNKNOWN_KEY",
  "CONNECTOR_AUTH_INVALID",
  "CONNECTOR_SECRET_PRESENT",
  "CONNECTOR_DOMAIN_INVALID",
  "CONNECTOR_DUPLICATE",
  "CONNECTOR_PROFILE_INVALID",
  "CONNECTOR_TARGET_KIND_INVALID",
  "CONNECTOR_MODE_UNSUPPORTED",
  "CONNECTOR_IDENTITY_UNSTABLE",
  "CONNECTOR_FIELD_INVALID",
  "CONNECTOR_FIELD_NEVER_OWNED",
  "CONNECTOR_FIELD_UNDECLARED",
  "CONNECTOR_VALUES_INVALID",
  "CONNECTOR_LIST_FIELD_UNSUPPORTED",
  "CONNECTOR_ACTION_INVALID",
  "CONNECTOR_EVENT_INVALID",
] as const);
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/** One refusal; `path` is a JSON pointer into the frontmatter (empty for the whole document). */
export interface ConnectorError {
  code: ConnectorErrorCode;
  path: string;
  message: string;
}

export type ConnectorAuthKind = "none" | "token" | "github-app" | "oauth2" | "signed-webhook";
export interface ConnectorAuth {
  kind: ConnectorAuthKind;
  /** `token` and `oauth2`: an {@link AUTH_PROVIDERS} row. */
  provider?: string;
  /** `github-app`: permission name to access. */
  permissions?: Record<string, "read" | "write">;
  /** `signed-webhook`. */
  scheme?: "hmac-sha256";
}
export interface ConnectorMapping {
  /** A dotted record path. */
  from: string;
  /** Native value (as a string) to target value. */
  values?: Record<string, string>;
  /** Present exactly when `values` is: what a native outside the table does. */
  unmapped?: "keep" | "refuse";
}
export interface ConnectorSource {
  name: string;
  profile: string;
  target_kind: string;
  mode: "overlay";
  identity: { resource: string; id: string };
  /** Target field to mapping; the keys are the fields a Source Feed may own. */
  fields: Record<string, ConnectorMapping>;
  completeness: "complete" | "partial";
}
export interface ConnectorInput {
  type: "string" | "text" | "integer" | "boolean";
  required: boolean;
  values?: string[];
}
export interface ConnectorAction {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  host: string;
  input: Record<string, ConnectorInput>;
  confirm: "always" | "never";
}
export interface ConnectorEvent {
  name: string;
  signature: { scheme: "hmac-sha256"; header: string };
  references: string[];
}
export interface Connector {
  id: ConceptId;
  title: string;
  description?: string;
  version?: string;
  auth: ConnectorAuth;
  domains: string[];
  sources: ConnectorSource[];
  actions: ConnectorAction[];
  events: ConnectorEvent[];
}

export type ConnectorParseResult =
  | { ok: true; connector: Connector; warnings: ValidationWarning[] }
  | { ok: false; errors: ConnectorError[] };

// ------------------------------------------------------------------------------------------ grammar

const SLUG = /^[a-z][a-z0-9-]*$/;
const DOC_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const LOWER_NAME = /^[a-z][a-z0-9_]*$/;
const HEADER = /^[a-z0-9-]+$/;
const PARAMETER = "[A-Za-z0-9._~-]+";
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=%]*$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_TARGET_KINDS = new Set(["Convention", "View", "Connector", "Reference", "Source Feed", "Signal"]);
const AUTH_KINDS: readonly ConnectorAuthKind[] = ["none", "token", "github-app", "oauth2", "signed-webhook"];
const AUTH_KEYS_BY_KIND: Readonly<Record<ConnectorAuthKind, readonly string[]>> = {
  none: [], token: ["provider"], "github-app": ["permissions"], oauth2: ["provider"], "signed-webhook": ["scheme"],
};
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const INPUT_TYPES = new Set(["string", "text", "integer", "boolean"]);
const MAX_TEMPLATE = 2048;

type Path = ReadonlyArray<string | number>;

function pointer(path: Path): string {
  return path.map((s) => "/" + String(s).replaceAll("~", "~0").replaceAll("/", "~1")).join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/** A hostname as the declaration grammar admits it, or the reason it is refused. */
function hostnameProblem(host: unknown): string | undefined {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return "must be a hostname of 1 to 253 characters";
  const labels = host.split(".");
  if (labels.length < 2) return "needs two or more labels";
  if (!labels.every((label) => HOST_LABEL.test(label))) return "takes lowercase labels of letters, digits and inner hyphens, with no trailing dot, scheme, port, path or wildcard";
  const last = labels[labels.length - 1]!;
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return "may not end in a numeric label (an address literal)";
  return undefined;
}

/** The hosts a credential of this kind may be sent to: a table row or a fixed set, never document text. */
export function credentialHosts(auth: Pick<ConnectorAuth, "kind" | "provider">): readonly string[] {
  if (auth.kind === "github-app") return GITHUB_APP_HOSTS;
  if ((auth.kind === "token" || auth.kind === "oauth2") && typeof auth.provider === "string" && Object.hasOwn(AUTH_PROVIDERS, auth.provider)) {
    return AUTH_PROVIDERS[auth.provider]!;
  }
  return [];
}

// ------------------------------------------------------------------------------------ secret scan

const SECRET_KEYS = new Set(["token", "secret", "password", "passwd", "client_secret", "private_key", "api_key", "apikey", "authorization", "bearer", "cookie"]);
const SECRET_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];

/**
 * A URL authority carrying userinfo (`scheme://name@` or `scheme://name:password@`) anywhere in the
 * text. A linear scan with no `URL` global, so the rule holds in every realm.
 */
function hasUserinfo(text: string): boolean {
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    for (let i = at + 3; i < text.length; i++) {
      const c = text[i]!;
      if (c === "@") return true;
      if (c === "/" || c === "?" || c === "#" || c.trim() === "") break;
    }
  }
  return false;
}

function secretShaped(text: string): boolean {
  const s = text.trimStart();
  return SECRET_PREFIXES.some((prefix) => s.startsWith(prefix)) || /^xox[abprs]-/.test(s) || /^bearer /i.test(s)
    || (text.includes("-----BEGIN") && text.includes("PRIVATE KEY")) || hasUserinfo(text);
}

/** Token shapes in prose: a prefix followed by token characters, or `Bearer` followed by a token-like run. */
function bodyHoldsSecret(body: string): boolean {
  if (/(?:^|[^A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8}/.test(body)) return true;
  if (/(?:^|[^A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{8}/.test(body)) return true;
  if (body.includes("-----BEGIN") && body.includes("PRIVATE KEY")) return true;
  if (hasUserinfo(body)) return true;
  for (const match of body.matchAll(/\bbearer[ \t]+([A-Za-z0-9._~+/=-]{16,})/gi)) {
    if (/[0-9]/.test(match[1]!) && /[A-Za-z]/.test(match[1]!)) return true;
  }
  return false;
}

const holdsSecret = (text: string): boolean => secretShaped(text) || bodyHoldsSecret(text);
/**
 * Keys hold no prose, so a token glued to a word still counts. The shapes use the providers' real
 * token lengths, so data names that merely contain a prefix ("highs_", "weighs_") stay legal.
 */
const keyHoldsSecret = (key: string): boolean =>
  holdsSecret(key) || /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}/.test(key);

/**
 * Maps whose keys are data names (target fields, provider natives, input and permission names), not
 * credential slots: their keys get the token-shape rules only, never the key-name list.
 */
function keysAreDataNames(path: Path): boolean {
  const n = path.length;
  return (n === 3 && path[0] === "sources" && path[2] === "fields")
    || (n === 5 && path[0] === "sources" && path[2] === "fields" && path[4] === "values")
    || (n === 3 && path[0] === "actions" && path[2] === "input")
    || (n === 2 && path[0] === "auth" && path[1] === "permissions");
}

/**
 * Walk the frontmatter once, visiting each container at most once: a container reached twice is a
 * YAML alias (shared or circular), refused as `CONNECTOR_MALFORMED` so the scan, and every reader
 * after it, stays bounded by the document's size. Secret refusals name a path and never a value; a
 * secret-looking key reports its parent.
 */
function scanDocument(value: unknown, path: Path, out: Map<string, ConnectorError>, seen: WeakSet<object>): void {
  const add = (at: Path, what: string): void => {
    const p = pointer(at);
    if (!out.has(p)) out.set(p, { code: "CONNECTOR_SECRET_PRESENT", path: p, message: `${what} at '${p || "/"}'; a declaration never carries a credential` });
  };
  if (typeof value === "string") {
    if (holdsSecret(value)) add(path, "a secret-shaped value");
    return;
  }
  if (!Array.isArray(value) && !record(value)) return;
  if (seen.has(value)) {
    const p = pointer(path);
    out.set(`alias:${p}`, { code: "CONNECTOR_MALFORMED", path: p, message: `a Connector may not use YAML aliases (at '${p || "/"}')` });
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanDocument(item, [...path, index], out, seen));
    return;
  }
  const data = keysAreDataNames(path);
  for (const [key, item] of Object.entries(value)) {
    if ((!data && SECRET_KEYS.has(key.toLowerCase())) || keyHoldsSecret(key)) add(path, "a secret-looking key");
    else scanDocument(item, [...path, key], out, seen);
  }
}

// -------------------------------------------------------------------------------------- templates

type TemplatePart = { literal: string } | { name: string };

interface ResourceTemplate {
  parts: TemplatePart[];
  matcher: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * An absolute https URL template. A placeholder lies inside one path segment (at most one per
 * segment, with optional literal text around it) or is a whole query value; never in the host. No
 * userinfo, port, fragment or dot segment.
 */
function parseResourceTemplate(template: unknown): { ok: true; value: ResourceTemplate } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (typeof template !== "string" || template.length === 0 || template.length > MAX_TEMPLATE) return fail(`must be a URL template of at most ${MAX_TEMPLATE} characters`);
  if (!template.startsWith("https://")) return fail("must be an absolute https URL");
  if (template.includes("#")) return fail("may not carry a fragment");
  if (!URL_CHARS.test(template.replace(/\{[^{}]*\}/g, "x"))) return fail("holds characters a URL does not");
  const rest = template.slice("https://".length);
  const cut = rest.search(/[/?]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  if (/[{}]/.test(authority)) return fail("may not place a placeholder in the host");
  if (authority.includes("@")) return fail("may not carry userinfo");
  if (authority.includes(":")) return fail("may not carry a port");
  const hostProblem = hostnameProblem(authority);
  if (hostProblem) return fail(`host ${hostProblem}`);
  const tail = cut === -1 ? "" : rest.slice(cut);
  const queryAt = tail.indexOf("?");
  const pathPart = queryAt === -1 ? tail : tail.slice(0, queryAt);
  const query = queryAt === -1 ? undefined : tail.slice(queryAt + 1);
  const parts: TemplatePart[] = [{ literal: `https://${authority}` }];
  const names = new Set<string>();
  const placeholder = (name: string): string | undefined => {
    if (!LOWER_NAME.test(name)) return `placeholder '{${name}}' must be named [a-z][a-z0-9_]*`;
    if (names.has(name)) return `placeholder '{${name}}' appears twice`;
    names.add(name);
    parts.push({ name });
    return undefined;
  };
  const decoded = (text: string): string | undefined => {
    try { return decodeURIComponent(text); } catch { return undefined; }
  };
  if (pathPart !== "") {
    for (const segment of pathPart.slice(1).split("/")) {
      parts.push({ literal: "/" });
      const match = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(segment);
      const literals = match ? [match[1]!, match[3]!] : [segment];
      const plain = literals.map(decoded);
      if (plain.some((text) => text === undefined)) return fail("holds a malformed percent-encoding");
      if (!match && (plain[0] === "." || plain[0] === "..")) return fail("may not carry a dot segment, plain or percent-encoded");
      if (plain.some((text) => /[/\\]/.test(text!))) return fail("may not encode a path separator");
      if (match) {
        parts.push({ literal: match[1]! });
        const problem = placeholder(match[2]!);
        if (problem) return fail(problem);
        parts.push({ literal: match[3]! });
      } else if (/[{}]/.test(segment)) return fail("allows one placeholder per path segment");
      else parts.push({ literal: segment });
    }
  }
  if (query !== undefined) {
    parts.push({ literal: "?" });
    const pieces = query.split("&");
    for (const [index, piece] of pieces.entries()) {
      if (index > 0) parts.push({ literal: "&" });
      const eq = piece.indexOf("=");
      const key = eq === -1 ? piece : piece.slice(0, eq);
      const value = eq === -1 ? "" : piece.slice(eq + 1);
      if (/[{}]/.test(key)) return fail("allows a placeholder only as a whole query value");
      parts.push({ literal: eq === -1 ? key : `${key}=` });
      const whole = /^\{([^{}]*)\}$/.exec(value);
      if (whole) {
        const problem = placeholder(whole[1]!);
        if (problem) return fail(problem);
      } else if (/[{}]/.test(value)) return fail("allows a placeholder only as a whole query value");
      else parts.push({ literal: value });
    }
  }
  const matcher = new RegExp(`^${parts.map((p) => ("name" in p ? `(${PARAMETER})` : escapeRegExp(p.literal))).join("")}$`);
  return { ok: true, value: { parts, matcher } };
}

type IdPart = { literal: string } | { path: string };

/** A record path: segments `[A-Za-z0-9_-]+` joined by dots, none a prototype name. */
function pathProblem(path: unknown): string | undefined {
  if (typeof path !== "string" || path === "" || path.length > 512) return "must be a dotted record path";
  for (const segment of path.split(".")) {
    if (!PATH_SEGMENT.test(segment)) return "takes segments of letters, digits, '_' and '-' joined by '.'";
    if (PROTOTYPE_KEYS.has(segment)) return `may not name '${segment}'`;
  }
  return undefined;
}

/** An id template over record paths with at least one placeholder. */
function parseIdTemplate(template: unknown): { ok: true; parts: IdPart[]; paths: string[] } | { ok: false; reason: string } {
  if (typeof template !== "string" || template === "" || template.length > MAX_TEMPLATE) return { ok: false, reason: "must be a template string" };
  const parts: IdPart[] = [];
  const paths: string[] = [];
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  for (const match of template.matchAll(re)) {
    parts.push({ literal: template.slice(last, match.index) });
    const problem = pathProblem(match[1]);
    if (problem) return { ok: false, reason: `placeholder '{${match[1]}}' ${problem}` };
    parts.push({ path: match[1]! });
    paths.push(match[1]!);
    last = match.index! + match[0].length;
  }
  parts.push({ literal: template.slice(last) });
  if (parts.some((p) => "literal" in p && /[{}]/.test(p.literal))) return { ok: false, reason: "has an unbalanced brace" };
  if (paths.length === 0) return { ok: false, reason: "needs at least one {record.path} placeholder" };
  // Between two placeholders a literal must separate them, or two records could render one id.
  if (parts.some((p, i) => "literal" in p && p.literal === "" && i > 0 && i < parts.length - 1)) {
    return { ok: false, reason: "needs literal text between placeholders" };
  }
  return { ok: true, parts, paths };
}

// ----------------------------------------------------------------------------------------- parser

class Errors {
  readonly list: ConnectorError[] = [];
  add(code: ConnectorErrorCode, path: Path, message: string): void {
    this.list.push({ code, path: pointer(path), message });
  }
  closed(block: ConnectorBlock, value: Record<string, unknown>, at: Path): void {
    const accepted: readonly string[] = CONNECTOR_KEYS[block];
    for (const key of Object.keys(value)) {
      if (!accepted.includes(key)) this.add("CONNECTOR_UNKNOWN_KEY", [...at, key], `'${key}' is not a ${block} key (accepted: ${accepted.join(", ")})`);
    }
  }
}

function list(value: unknown, at: Path, errors: Errors, what: string): unknown[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { errors.add("CONNECTOR_MALFORMED", at, `${what} must be a list`); return undefined; }
  return value;
}

function parseAuth(raw: unknown, errors: Errors): ConnectorAuth | undefined {
  if (raw === undefined) { errors.add("CONNECTOR_MALFORMED", ["auth"], "auth is required"); return undefined; }
  if (!record(raw)) { errors.add("CONNECTOR_MALFORMED", ["auth"], "auth must be a mapping"); return undefined; }
  errors.closed("auth", raw, ["auth"]);
  const kind = raw.kind as ConnectorAuthKind;
  if (!AUTH_KINDS.includes(kind)) {
    errors.add("CONNECTOR_AUTH_INVALID", ["auth", "kind"], `auth.kind must be one of ${AUTH_KINDS.join(", ")}`);
    return undefined;
  }
  const before = errors.list.length;
  for (const key of ["provider", "permissions", "scheme"]) {
    if (key in raw && !AUTH_KEYS_BY_KIND[kind].includes(key)) errors.add("CONNECTOR_AUTH_INVALID", ["auth", key], `'${key}' belongs to another auth kind than ${kind}`);
  }
  const auth: ConnectorAuth = { kind };
  if (kind === "token" || kind === "oauth2") {
    if (typeof raw.provider !== "string" || !Object.hasOwn(AUTH_PROVIDERS, raw.provider)) {
      errors.add("CONNECTOR_AUTH_INVALID", ["auth", "provider"], `${kind} needs a provider core's table names (${Object.keys(AUTH_PROVIDERS).join(", ")})`);
    } else auth.provider = raw.provider;
  } else if (kind === "github-app") {
    const permissions: Record<string, "read" | "write"> = {};
    if (raw.permissions !== undefined && !record(raw.permissions)) errors.add("CONNECTOR_AUTH_INVALID", ["auth", "permissions"], "permissions must be a mapping");
    else for (const [name, access] of Object.entries(raw.permissions ?? {})) {
      if (!LOWER_NAME.test(name) || PROTOTYPE_KEYS.has(name)) errors.add("CONNECTOR_AUTH_INVALID", ["auth", "permissions", name], "a permission name is [a-z][a-z0-9_]*");
      else if (access !== "read" && access !== "write") errors.add("CONNECTOR_AUTH_INVALID", ["auth", "permissions", name], "a permission is read or write");
      else permissions[name] = access;
    }
    auth.permissions = permissions;
  } else if (kind === "signed-webhook") {
    if (raw.scheme !== "hmac-sha256") errors.add("CONNECTOR_AUTH_INVALID", ["auth", "scheme"], "signed-webhook takes scheme hmac-sha256");
    else auth.scheme = "hmac-sha256";
  }
  return errors.list.length === before ? auth : undefined;
}

function parseDomains(raw: unknown, auth: ConnectorAuth | undefined, errors: Errors): string[] {
  const entries = list(raw, ["domains"], errors, "domains") ?? [];
  const seen = new Set<string>();
  const credential = new Set(auth ? credentialHosts(auth) : []);
  entries.forEach((entry, index) => {
    const problem = hostnameProblem(entry);
    if (problem) errors.add("CONNECTOR_DOMAIN_INVALID", ["domains", index], `a domain ${problem}`);
    else if (seen.has(entry as string)) errors.add("CONNECTOR_DOMAIN_INVALID", ["domains", index], `domain '${entry}' is listed twice`);
    else if (credential.has(entry as string)) errors.add("CONNECTOR_DOMAIN_INVALID", ["domains", index], `domain '${entry}' is already a credential host of auth kind ${auth!.kind}`);
    seen.add(entry as string);
  });
  return [...seen];
}

/** Why a target field can never be a mapping key, whatever the Kind declares. */
function neverOwnedReason(field: string): string | undefined {
  if (NEVER_OWNED.has(field)) return "a field no source may own";
  if (isManagedDocumentMetadataField(field)) return "managed document metadata";
  if (field === PROGRESS_STATUS_FIELD || workStateFields(undefined, []).has(field)) return "work state";
  if (field === "body") return "the document body";
  return undefined;
}

function parseMapping(field: string, raw: unknown, at: Path, errors: Errors): ConnectorMapping | undefined {
  const before = errors.list.length;
  if (!FIELD_NAME.test(field) || PROTOTYPE_KEYS.has(field)) {
    errors.add("CONNECTOR_FIELD_INVALID", at, `mapping key '${field}' must be a field name [A-Za-z][A-Za-z0-9_]*`);
    return undefined;
  }
  const reason = neverOwnedReason(field);
  if (reason) errors.add("CONNECTOR_FIELD_NEVER_OWNED", at, `'${field}' is ${reason} and can never be mapped`);
  const entry = typeof raw === "string" ? { from: raw } : raw;
  if (!record(entry)) { errors.add("CONNECTOR_MALFORMED", at, "a mapping is a record path or { from, values, unmapped }"); return undefined; }
  if (typeof raw !== "string") errors.closed("mapping", entry, at);
  const problem = pathProblem(entry.from);
  if (problem) errors.add("CONNECTOR_FIELD_INVALID", [...at, ...(typeof raw === "string" ? [] : ["from"])], `from ${problem}`);
  const mapping: ConnectorMapping = { from: entry.from as string };
  if (entry.values !== undefined) {
    if (!record(entry.values) || Object.keys(entry.values).length === 0) errors.add("CONNECTOR_VALUES_INVALID", [...at, "values"], "values must be a non-empty mapping of native value to target value");
    else {
      const values: Record<string, string> = {};
      for (const [native, target] of Object.entries(entry.values)) {
        if (PROTOTYPE_KEYS.has(native) || typeof target !== "string" || target === "") errors.add("CONNECTOR_VALUES_INVALID", [...at, "values", native], "each values row maps a native string to a non-empty target string");
        else values[native] = target;
      }
      mapping.values = values;
    }
  }
  if (entry.unmapped !== undefined && entry.values === undefined) errors.add("CONNECTOR_VALUES_INVALID", [...at, "unmapped"], "unmapped needs a values table");
  else if (entry.unmapped !== undefined && entry.unmapped !== "keep" && entry.unmapped !== "refuse") errors.add("CONNECTOR_VALUES_INVALID", [...at, "unmapped"], "unmapped is keep or refuse");
  else if (entry.values !== undefined) mapping.unmapped = (entry.unmapped as "keep" | "refuse" | undefined) ?? "keep";
  return errors.list.length === before ? mapping : undefined;
}

function parseSource(raw: unknown, index: number, errors: Errors): ConnectorSource | undefined {
  const at = ["sources", index] as const;
  if (!record(raw)) { errors.add("CONNECTOR_MALFORMED", at, "a source must be a mapping"); return undefined; }
  const before = errors.list.length;
  errors.closed("source", raw, at);
  if (typeof raw.name !== "string" || !SLUG.test(raw.name)) errors.add("CONNECTOR_MALFORMED", [...at, "name"], "a source name is a slug [a-z][a-z0-9-]*");
  if (typeof raw.profile !== "string" || !SLUG.test(raw.profile)) errors.add("CONNECTOR_PROFILE_INVALID", [...at, "profile"], "profile is a slug [a-z][a-z0-9-]* naming a catalog profile");
  if (typeof raw.target_kind !== "string" || raw.target_kind.trim() === "") errors.add("CONNECTOR_TARGET_KIND_INVALID", [...at, "target_kind"], "target_kind must name a Kind");
  else if (RESERVED_TARGET_KINDS.has(raw.target_kind)) errors.add("CONNECTOR_TARGET_KIND_INVALID", [...at, "target_kind"], `a source may not target ${raw.target_kind}`);
  if (raw.mode !== undefined && typeof raw.mode !== "string") errors.add("CONNECTOR_MALFORMED", [...at, "mode"], "mode must be a string");
  else if (raw.mode !== undefined && raw.mode !== "overlay") {
    errors.add("CONNECTOR_MODE_UNSUPPORTED", [...at, "mode"], raw.mode === "mirror" ? "mirror mode is not supported before I4; use overlay" : "mode is overlay");
  }
  if (raw.completeness !== "complete" && raw.completeness !== "partial") errors.add("CONNECTOR_MALFORMED", [...at, "completeness"], "completeness is complete or partial");
  const fields: Record<string, ConnectorMapping> = {};
  if (!record(raw.fields) || Object.keys(raw.fields).length === 0) errors.add("CONNECTOR_MALFORMED", [...at, "fields"], "fields must map at least one target field");
  else for (const [field, entry] of Object.entries(raw.fields)) {
    const mapping = parseMapping(field, entry, [...at, "fields", field], errors);
    if (mapping) fields[field] = mapping;
  }
  let identity: ConnectorSource["identity"] | undefined;
  if (!record(raw.identity)) errors.add("CONNECTOR_MALFORMED", [...at, "identity"], "identity must be a mapping of resource and id");
  else {
    errors.closed("identity", raw.identity, [...at, "identity"]);
    const resource = parseResourceTemplate(raw.identity.resource);
    if (!resource.ok) errors.add("CONNECTOR_IDENTITY_UNSTABLE", [...at, "identity", "resource"], `identity.resource ${resource.reason}`);
    const id = parseIdTemplate(raw.identity.id);
    if (!id.ok) errors.add("CONNECTOR_IDENTITY_UNSTABLE", [...at, "identity", "id"], `identity.id ${id.reason}`);
    else {
      const owned = Object.values(fields).map((m) => m.from);
      const shared = id.paths.filter((p) => owned.includes(p));
      if (shared.length) errors.add("CONNECTOR_IDENTITY_UNSTABLE", [...at, "identity", "id"], `identity is never an owned value, but ${shared.join(", ")} is also mapped`);
    }
    if (resource.ok && id.ok) identity = { resource: raw.identity.resource as string, id: raw.identity.id as string };
  }
  if (errors.list.length !== before || !identity) return undefined;
  return {
    name: raw.name as string, profile: raw.profile as string, target_kind: raw.target_kind as string, mode: "overlay",
    identity, fields, completeness: raw.completeness as "complete" | "partial",
  };
}

function parseAction(raw: unknown, index: number, reach: ReadonlySet<string>, errors: Errors): ConnectorAction | undefined {
  const at = ["actions", index] as const;
  if (!record(raw)) { errors.add("CONNECTOR_MALFORMED", at, "an action must be a mapping"); return undefined; }
  const before = errors.list.length;
  errors.closed("action", raw, at);
  if (typeof raw.name !== "string" || !SLUG.test(raw.name)) errors.add("CONNECTOR_MALFORMED", [...at, "name"], "an action name is a slug [a-z][a-z0-9-]*");
  if (typeof raw.method !== "string" || !METHODS.has(raw.method)) errors.add("CONNECTOR_MALFORMED", [...at, "method"], `method is one of ${[...METHODS].join(", ")}`);
  if (hostnameProblem(raw.host) || !reach.has(raw.host as string)) errors.add("CONNECTOR_ACTION_INVALID", [...at, "host"], "an action host must be a credential host of the auth kind or a declared domain");
  if (raw.confirm !== undefined && raw.confirm !== "always" && raw.confirm !== "never") errors.add("CONNECTOR_MALFORMED", [...at, "confirm"], "confirm is always or never");
  const input: Record<string, ConnectorInput> = {};
  if (raw.input !== undefined && !record(raw.input)) errors.add("CONNECTOR_MALFORMED", [...at, "input"], "input must be a mapping");
  else for (const [name, spec] of Object.entries(raw.input ?? {})) {
    const where = [...at, "input", name];
    if (!LOWER_NAME.test(name) || PROTOTYPE_KEYS.has(name)) { errors.add("CONNECTOR_ACTION_INVALID", where, "an input name is [a-z][a-z0-9_]*"); continue; }
    if (!record(spec)) { errors.add("CONNECTOR_MALFORMED", where, "an input is { type, required, values }"); continue; }
    errors.closed("input", spec, where);
    if (typeof spec.type !== "string" || !INPUT_TYPES.has(spec.type)) errors.add("CONNECTOR_MALFORMED", [...where, "type"], `an input type is one of ${[...INPUT_TYPES].join(", ")}`);
    if (spec.required !== undefined && typeof spec.required !== "boolean") errors.add("CONNECTOR_MALFORMED", [...where, "required"], "required is true or false");
    if (spec.values !== undefined && (!Array.isArray(spec.values) || !spec.values.every((v) => typeof v === "string" && v !== ""))) {
      errors.add("CONNECTOR_MALFORMED", [...where, "values"], "values is a list of strings");
    } else if (spec.values !== undefined && spec.type !== "string") errors.add("CONNECTOR_ACTION_INVALID", [...where, "values"], "values restrict a string input only");
    input[name] = {
      type: spec.type as ConnectorInput["type"], required: spec.required === true,
      ...(Array.isArray(spec.values) ? { values: [...spec.values] as string[] } : {}),
    };
  }
  if (errors.list.length !== before) return undefined;
  return { name: raw.name as string, method: raw.method as ConnectorAction["method"], host: raw.host as string, input, confirm: (raw.confirm as "always" | "never" | undefined) ?? "always" };
}

function parseEvent(raw: unknown, index: number, sourceNames: ReadonlySet<string>, errors: Errors): ConnectorEvent | undefined {
  const at = ["events", index] as const;
  if (!record(raw)) { errors.add("CONNECTOR_MALFORMED", at, "an event must be a mapping"); return undefined; }
  const before = errors.list.length;
  errors.closed("event", raw, at);
  if (typeof raw.name !== "string" || !SLUG.test(raw.name)) errors.add("CONNECTOR_MALFORMED", [...at, "name"], "an event name is a slug [a-z][a-z0-9-]*");
  const signature = raw.signature;
  if (!record(signature)) errors.add("CONNECTOR_MALFORMED", [...at, "signature"], "signature must be a mapping of scheme and header");
  else {
    errors.closed("signature", signature, [...at, "signature"]);
    if (signature.scheme !== "hmac-sha256") errors.add("CONNECTOR_EVENT_INVALID", [...at, "signature", "scheme"], "signature.scheme is hmac-sha256");
    if (typeof signature.header !== "string" || !HEADER.test(signature.header)) errors.add("CONNECTOR_EVENT_INVALID", [...at, "signature", "header"], "signature.header is a lowercase token [a-z0-9-]+");
  }
  const references = list(raw.references, [...at, "references"], errors, "references") ?? [];
  const seen = new Set<string>();
  references.forEach((ref, i) => {
    if (typeof ref !== "string" || !sourceNames.has(ref)) errors.add("CONNECTOR_EVENT_INVALID", [...at, "references", i], "references name declared sources");
    else if (seen.has(ref)) errors.add("CONNECTOR_DUPLICATE", [...at, "references", i], `reference '${ref}' is listed twice`);
    else seen.add(ref);
  });
  if (errors.list.length !== before || !record(signature)) return undefined;
  return { name: raw.name as string, signature: { scheme: "hmac-sha256", header: signature.header as string }, references: [...seen] };
}

function duplicates(items: readonly unknown[], block: "sources" | "actions" | "events", what: string, errors: Errors): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const name = record(item) ? item.name : undefined;
    if (typeof name !== "string") return;
    if (seen.has(name)) errors.add("CONNECTOR_DUPLICATE", [block, index, "name"], `${what} '${name}' is declared twice`);
    seen.add(name);
  });
}

/** Kind rules for one source: ownable, declared, scalar, and enum-safe mapping keys. */
function sourceKindErrors(source: ConnectorSource, index: number, kind: KindConvention): ConnectorError[] {
  const errors = new Errors();
  const work = workStateFields(kind, ["0.1", "0.2"]);
  const declared = new Set([...kind.fields.required, ...kind.fields.optional, "title"]);
  for (const [field, mapping] of Object.entries(source.fields)) {
    const at = ["sources", index, "fields", field];
    if (work.has(field)) { errors.add("CONNECTOR_FIELD_NEVER_OWNED", at, `'${field}' holds the work state of ${kind.governs} and can never be mapped`); continue; }
    if (!declared.has(field)) { errors.add("CONNECTOR_FIELD_UNDECLARED", at, `${kind.governs} does not declare '${field}'`); continue; }
    const allowed = Object.hasOwn(kind.fields.values, field) ? kind.fields.values[field] : undefined;
    if (isKindListField(kind, field)) {
      // Core's replace-all refuses an OKF standard or managed field whatever the Kind types it as.
      if (isManagedDocumentMetadataField(field) || isStandardDocumentSetField(field, "0.1") || isStandardDocumentSetField(field, "0.2")) {
        errors.add("CONNECTOR_LIST_FIELD_UNSUPPORTED", at, `'${field}' is an OKF standard or managed field; a connector cannot own it as a list`);
        continue;
      }
      // A list maps whole: the profile flattens it, and there is no per-item value table yet.
      if (mapping.values || Array.isArray(allowed)) errors.add("CONNECTOR_LIST_FIELD_UNSUPPORTED", at, `'${field}' is a ${kind.fields.types![field]}; a list field maps whole lists, without a values table or allowed values`);
      continue;
    }
    if (!Array.isArray(allowed)) continue;
    if (!mapping.values) { errors.add("CONNECTOR_VALUES_INVALID", at, `'${field}' is an enum of ${kind.governs}; map it through a values table`); continue; }
    for (const [native, target] of Object.entries(mapping.values)) {
      if (!allowed.includes(target)) errors.add("CONNECTOR_VALUES_INVALID", [...at, "values", native], `${kind.governs}.${field} does not allow '${target}'`);
    }
  }
  return errors.list;
}

/**
 * Parse one Connector document, returning every refusal found. With `ctx.kinds`, a source whose
 * target Kind is in the registry is also checked against it; one whose Kind is absent is left to
 * {@link checkConnectorAgainstKinds} with a warning. A secret-shaped key or value, or a YAML alias,
 * refuses the document alone, so no other refusal can echo the one or expand the other.
 */
export function parseConnectorDoc(doc: OkfDocument, ctx: { kinds?: KindRegistry } = {}): ConnectorParseResult {
  const fm = (doc.frontmatter ?? {}) as unknown as Record<string, unknown>;
  const secrets = new Map<string, ConnectorError>();
  scanDocument(fm, [], secrets, new WeakSet());
  if (typeof doc.body === "string" && bodyHoldsSecret(doc.body)) {
    secrets.set("(body)", { code: "CONNECTOR_SECRET_PRESENT", path: "", message: "a secret-shaped token in the body; a declaration never carries a credential" });
  }
  if (secrets.size) return { ok: false, errors: [...secrets.values()] };

  const errors = new Errors();
  if (typeof doc.id !== "string" || !doc.id.startsWith(CONNECTORS_PREFIX) || !DOC_SLUG.test(doc.id.slice(CONNECTORS_PREFIX.length))) {
    errors.add("CONNECTOR_MALFORMED", [], `a Connector lives at ${CONNECTORS_PREFIX}<slug>`);
  }
  if (fm.type !== CONNECTOR_TYPE) errors.add("CONNECTOR_MALFORMED", ["type"], `type must be ${CONNECTOR_TYPE}`);
  if (typeof fm.title !== "string" || fm.title.trim() === "") errors.add("CONNECTOR_MALFORMED", ["title"], "title is required");
  if (fm.description !== undefined && typeof fm.description !== "string") errors.add("CONNECTOR_MALFORMED", ["description"], "description must be a string");
  if (fm.version !== undefined && typeof fm.version !== "string" && !(typeof fm.version === "number" && Number.isFinite(fm.version))) {
    errors.add("CONNECTOR_MALFORMED", ["version"], "version must be a string");
  }
  const auth = parseAuth(fm.auth, errors);
  const domains = parseDomains(fm.domains, auth, errors);
  const rawSources = list(fm.sources, ["sources"], errors, "sources");
  const rawActions = list(fm.actions, ["actions"], errors, "actions");
  const rawEvents = list(fm.events, ["events"], errors, "events");
  if (rawSources && rawActions && rawEvents && rawSources.length + rawActions.length + rawEvents.length === 0) {
    errors.add("CONNECTOR_MALFORMED", [], "a Connector declares at least one source, action or event");
  }
  duplicates(rawSources ?? [], "sources", "source", errors);
  duplicates(rawActions ?? [], "actions", "action", errors);
  duplicates(rawEvents ?? [], "events", "event", errors);
  const sources = (rawSources ?? []).map((raw, index) => parseSource(raw, index, errors));
  const reach = new Set([...(auth ? credentialHosts(auth) : []), ...domains]);
  const actions = (rawActions ?? []).map((raw, index) => parseAction(raw, index, reach, errors));
  const names = new Set((rawSources ?? []).flatMap((raw) => (record(raw) && typeof raw.name === "string" ? [raw.name] : [])));
  const events = (rawEvents ?? []).map((raw, index) => parseEvent(raw, index, names, errors));

  const warnings: ValidationWarning[] = [];
  if (ctx.kinds) {
    sources.forEach((source, index) => {
      if (!source) return;
      const kind = ctx.kinds!.kinds.get(source.target_kind);
      if (kind) errors.list.push(...sourceKindErrors(source, index, kind));
      else warnings.push({ code: "CONNECTOR_TARGET_KIND_DEFERRED", message: `source '${source.name}' targets ${source.target_kind}, which the given registry does not declare; its Kind rules run against the bundle`, field: pointer(["sources", index, "target_kind"]), severity: "warning" });
    });
  }
  if (errors.list.length || !auth) return { ok: false, errors: errors.list };
  const connector: Connector = {
    id: doc.id,
    title: fm.title as string,
    ...(typeof fm.description === "string" ? { description: fm.description } : {}),
    ...(fm.version !== undefined ? { version: String(fm.version) } : {}),
    auth,
    domains,
    sources: sources as ConnectorSource[],
    actions: actions as ConnectorAction[],
    events: events as ConnectorEvent[],
  };
  return { ok: true, connector, warnings };
}

/** The Kind rules over a bundle's registry; a source whose target Kind is not declared is refused. */
export function checkConnectorAgainstKinds(connector: Connector, kinds: KindRegistry): ConnectorError[] {
  return connector.sources.flatMap((source, index) => {
    const kind = kinds.kinds.get(source.target_kind);
    if (!kind) return [{ code: "CONNECTOR_TARGET_KIND_INVALID" as const, path: pointer(["sources", index, "target_kind"]), message: `${source.target_kind} is not declared in this bundle` }];
    return sourceKindErrors(source, index, kind);
  });
}

// --------------------------------------------------------------------------------------------- pin

function pinBlock(block: ConnectorBlock, value: object, nested: Partial<Record<string, (v: unknown) => unknown>> = {}): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CONNECTOR_KEYS[block]) {
    const v = source[key];
    out[key] = v !== undefined && nested[key] ? nested[key]!(v) : v;
  }
  return out;
}

const byName = <T extends { name: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const mapOf = (block: ConnectorBlock, defaults: (item: object) => object = (item) => item) => (value: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value as Record<string, object>).map(([key, item]) => [key, pinBlock(block, defaults(item))]));

/** The parser's defaults, filled again here so a Connector built without the parser pins the same. */
const PIN_DEFAULTS = {
  auth: (a: ConnectorAuth): object => (a.kind === "github-app" && a.permissions === undefined ? { ...a, permissions: {} } : a),
  source: (s: ConnectorSource): object => ({ ...s, mode: s.mode ?? "overlay" }),
  mapping: (m: object): object => {
    const mapping = m as ConnectorMapping;
    return mapping.values !== undefined && mapping.unmapped === undefined ? { ...mapping, unmapped: "keep" } : mapping;
  },
  action: (a: ConnectorAction): object => ({ ...a, input: a.input ?? {}, confirm: a.confirm ?? "always" }),
  input: (i: object): object => ({ ...i, required: (i as ConnectorInput).required ?? false }),
  event: (e: ConnectorEvent): object => ({ ...e, references: e.references ?? [] }),
};

/**
 * The digest a Connection records at enable time: every key {@link CONNECTOR_KEYS} accepts, with
 * defaults filled and order-free lists sorted, plus the credential hosts core resolves the auth kind
 * to, under the recipe stamp's canonical JSON. Blind to
 * `title`, `description`, `version`, the body, `x_recipe` and unknown top-level keys.
 */
export function connectorPinDigest(connector: Connector): string {
  const pinned = {
    rules: CONNECTOR_PIN_RULES,
    auth: pinBlock("auth", PIN_DEFAULTS.auth(connector.auth)),
    // Core's resolution of the provider, so a host joining a row changes every pin on that provider.
    credential_hosts: [...credentialHosts(connector.auth)].sort(),
    domains: [...connector.domains].sort(),
    sources: byName(connector.sources).map((source) => pinBlock("source", PIN_DEFAULTS.source(source), {
      identity: (v) => pinBlock("identity", v as object),
      fields: mapOf("mapping", PIN_DEFAULTS.mapping),
    })),
    actions: byName(connector.actions).map((action) => pinBlock("action", PIN_DEFAULTS.action(action), { input: mapOf("input", PIN_DEFAULTS.input) })),
    events: byName(connector.events).map((event) => pinBlock("event", PIN_DEFAULTS.event(event), {
      signature: (v) => pinBlock("signature", v as object),
      references: (v) => [...(v as string[])].sort(),
    })),
  };
  return `sha256:${sha256Hex(definitionCanonicalJson(pinned))}`;
}

// ----------------------------------------------------------------------------------------- binding

export interface BoundFeed {
  /** The overlay policy, with the source's target Kind and completeness. */
  policy: OverlayPolicy;
  source: ConnectorSource;
  kind: KindConvention;
  parameters: Record<string, string>;
  /** Equal to the feed's `url` byte for byte; identity only, never a fetch target. */
  resource: string;
}

/**
 * Bind a Source Feed to one source of a Connector. The feed chooses only among the resources the
 * identity template admits, within the mapping keys, under the source's own completeness and
 * profile. Every refusal is `POLICY_INVALID` naming the feed and the key. `okfVersion` is the content
 * bundle's edition; absent means v0.1, as an undeclared edition does, and an owned list field needs
 * v0.2 because only field actions write lists.
 */
export function bindSourceFeed(
  connector: Connector,
  feed: { id: ConceptId; frontmatter: Frontmatter },
  kinds: KindRegistry,
  options: { okfVersion?: "0.1" | "0.2" } = {},
): BoundFeed {
  const fm = (feed.frontmatter ?? {}) as unknown as Record<string, unknown>;
  const refuse = (key: string, message: string, details: Record<string, unknown> = {}): never => {
    throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, `${feed.id}: ${message}`, { feed: feed.id, key, ...details });
  };
  if (fm.connector !== connector.id) refuse("connector", `connector must name ${connector.id}`);
  const source = connector.sources.find((s) => s.name === fm.source);
  if (!source) refuse("source", `source must name a source of ${connector.id}`);
  const bound = source!;
  for (const key of ["target_kind", "completeness", "profile"] as const) {
    if (fm[key] !== undefined && fm[key] !== null && fm[key] !== bound[key]) refuse(key, `${key} must be the source's ${bound[key]} when present`);
  }
  if (typeof fm.url !== "string" || fm.url.length > MAX_TEMPLATE) refuse("url", "url is required");
  for (const key of ["owned_fields", "auto_apply", "needs_review"]) {
    const v = fm[key];
    if (v !== undefined && v !== null && typeof v !== "string" && !(Array.isArray(v) && v.every((item) => typeof item === "string"))) refuse(key, `${key} must be a list of field or change names`);
  }
  for (const key of ["missing_threshold", "exclude_pattern", "wall_time_zone"]) {
    const v = fm[key];
    if (v !== undefined && v !== null && typeof v !== "string" && typeof v !== "number") refuse(key, `${key} must be a single value`);
  }
  const url = fm.url as string;
  const template = parseResourceTemplate(bound.identity.resource);
  if (!template.ok) refuse("url", "the source's identity template is invalid");
  const { parts, matcher } = (template as { ok: true; value: ResourceTemplate }).value;
  const match = matcher.exec(url);
  if (!match) refuse("url", "url is not a resource the source's identity template admits");
  const parameters: Record<string, string> = {};
  let group = 1;
  for (const part of parts) {
    if (!("name" in part)) continue;
    const value = match![group++]!;
    if (value === "." || value === "..") refuse("url", `parameter ${part.name} may not be '.' or '..'`);
    parameters[part.name] = value;
  }
  const resource = parts.map((part) => ("name" in part ? parameters[part.name] : part.literal)).join("");
  if (resource !== url) refuse("url", "url must equal the rendered identity template byte for byte");
  // The policy reader owns the feed keys' grammar; the Kind-aware read follows the binding checks.
  const owned = readOverlayPolicy(feed).owned_fields;
  const outside = owned.filter((field) => !Object.hasOwn(bound.fields, field));
  if (outside.length) refuse("owned_fields", `owned_fields outside the source's mapping: ${outside.join(", ")}`, { fields: outside });
  const kind = kinds.kinds.get(bound.target_kind);
  if (!kind) refuse("target_kind", `${bound.target_kind} is not declared in this bundle`);
  const kindErrors = sourceKindErrors(bound, connector.sources.indexOf(bound), kind!);
  if (kindErrors.length) refuse("connector", `the source does not fit ${bound.target_kind}: ${kindErrors.map((e) => e.code).join(", ")}`, { codes: kindErrors.map((e) => e.code) });
  const policy = readOverlayPolicy(feed, { targetKind: kind! });
  const ownedLists = policy.owned_fields.filter((field) => policy.list_fields?.includes(field));
  const edition = options.okfVersion ?? "0.1";
  if (ownedLists.length && edition !== "0.2") {
    refuse("owned_fields", `owned list fields need an OKF v0.2 bundle, and this bundle is v${edition}: ${ownedLists.join(", ")}`, { fields: ownedLists, okf_version: edition });
  }
  return { policy: { ...policy, target_kind: bound.target_kind, completeness: bound.completeness }, source: bound, kind: kind!, parameters, resource };
}

// ----------------------------------------------------------------------------------------- mapping

export type MappingDiagnosticCode = "VALUE_UNMAPPED" | "VALUE_NOT_SCALAR" | "VALUE_NOT_LIST" | "VALUE_MISSING" | "RECORD_REFUSED" | "IDENTITY_MISSING" | "IDENTITY_INVALID";

/** Why a record's value was not written; `native` is the provider value, `external_id` the record's. */
export interface MappingDiagnostic {
  code: MappingDiagnosticCode;
  /** The target field, or `identity`. */
  field: string;
  /** The record path read. */
  from: string;
  native: unknown;
  external_id: string | null;
}

export type MappedRecord =
  | {
    kind: "mapped";
    external_id: string;
    /** Values to write. */
    fields: Record<string, unknown>;
    /** Not observed this time: carried from the last accepted value, never removed. */
    unobserved: string[];
    /** Optional fields the provider says are empty: removed. */
    cleared: string[];
    diagnostics: MappingDiagnostic[];
  }
  | { kind: "refused"; present: boolean; external_id: string | null; diagnostics: MappingDiagnostic[] };

export type IdentityResult = { ok: true; resource: string; id: string } | { ok: false; diagnostic: MappingDiagnostic };

/** Own properties only, through plain mappings, never a prototype name. */
function readPath(value: unknown, path: string): { found: false } | { found: true; value: unknown } {
  let current = value;
  for (const segment of path.split(".")) {
    if (PROTOTYPE_KEYS.has(segment) || !record(current) || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}

const MAX_ID = 2048;

/**
 * Render the id template. A missing, blank or non-scalar value is `IDENTITY_MISSING`; a value holding
 * any character of a literal that separates two placeholders (so two records could share one id, for
 * multi-character separators too), or an id past {@link MAX_ID} characters, is `IDENTITY_INVALID`. A finite number renders as `String(n)`, so a
 * profile emits one type per id.
 */
function renderId(template: string, value: unknown): { ok: true; id: string } | { ok: false; code: "IDENTITY_MISSING" | "IDENTITY_INVALID"; path: string } {
  const parsed = parseIdTemplate(template);
  if (!parsed.ok) return { ok: false, code: "IDENTITY_INVALID", path: template };
  const separators = parsed.paths.length > 1
    ? parsed.parts.filter((p, i): p is { literal: string } => "literal" in p && i > 0 && i < parsed.parts.length - 1).map((p) => p.literal)
    : [];
  let id = "";
  for (const part of parsed.parts) {
    if ("literal" in part) { id += part.literal; continue; }
    const read = readPath(value, part.path);
    const v = read.found ? read.value : undefined;
    const text = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
    if (text === undefined || !isPresent(text)) return { ok: false, code: "IDENTITY_MISSING", path: part.path };
    if (text.length > MAX_ID || separators.some((separator) => [...separator].some((ch) => text.includes(ch)))) {
      return { ok: false, code: "IDENTITY_INVALID", path: part.path };
    }
    id += text;
  }
  if (id.length > MAX_ID) return { ok: false, code: "IDENTITY_INVALID", path: template };
  return { ok: true, id };
}

/** The record's identity: the bound resource and the id template rendered over the record. */
export function renderIdentity(source: ConnectorSource, bound: Pick<BoundFeed, "resource">, value: unknown): IdentityResult {
  const id = renderId(source.identity.id, value);
  if (!id.ok) return { ok: false, diagnostic: { code: id.code, field: "identity", from: id.path, native: null, external_id: null } };
  return { ok: true, resource: bound.resource, id: id.id };
}

const scalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** A list of nonblank text, deduplicated and in code point order; undefined for anything else. */
function textSet(native: unknown): string[] | undefined {
  if (!Array.isArray(native) || !native.every((member) => typeof member === "string" && isPresent(member))) return undefined;
  return [...new Set(native as string[])].sort(compareCodePoints);
}

/**
 * Map one normalized record onto the target Kind's fields. An absent path leaves the field
 * unobserved. An empty value (`null` or blank text) clears an optional field and leaves a
 * required one, or `title`, unobserved with `VALUE_MISSING`. A list or mapping is unobserved with
 * `VALUE_NOT_SCALAR`. A native outside a values table is looked up as its string (a number as
 * `String(n)`, a boolean as `true` or `false`) and then follows `unmapped`: `keep` leaves the field
 * unobserved with `VALUE_UNMAPPED`; `refuse` refuses the whole record, which still counts as present.
 * A record whose identity cannot be rendered is refused and not present.
 *
 * A field the Kind declares as `string-list` or `https-url-list` is always a list: a list of
 * nonblank text is written deduplicated and in code point order, and `null` is `[]` (empty, so the
 * owned list empties). An empty list on a required field is `VALUE_MISSING`; anything else, a
 * member that is not nonblank text included, is unobserved with `VALUE_NOT_LIST`.
 */
export function mapRecord(source: ConnectorSource, value: unknown, kind: Pick<KindConvention, "fields">): MappedRecord {
  const id = renderId(source.identity.id, value);
  if (!id.ok) return { kind: "refused", present: false, external_id: null, diagnostics: [{ code: id.code, field: "identity", from: id.path, native: null, external_id: null }] };
  const externalId = id.id;
  // `title` counts as declared by every Kind, so an empty value never clears it either.
  const required = new Set([...kind.fields.required, "title"]);
  const fields: Record<string, unknown> = {};
  const unobserved: string[] = [];
  const cleared: string[] = [];
  const refused: string[] = [];
  const diagnostics: MappingDiagnostic[] = [];
  const note = (code: MappingDiagnosticCode, field: string, from: string, native: unknown): void => {
    diagnostics.push({ code, field, from, native, external_id: externalId });
  };
  for (const [field, mapping] of Object.entries(source.fields)) {
    const read = readPath(value, mapping.from);
    if (!read.found) { unobserved.push(field); continue; }
    const native = read.value;
    if (isKindListField(kind, field)) {
      const members = native === null ? [] : textSet(native);
      if (members === undefined) { unobserved.push(field); note("VALUE_NOT_LIST", field, mapping.from, native); }
      else if (members.length === 0 && required.has(field)) { unobserved.push(field); note("VALUE_MISSING", field, mapping.from, native); }
      else fields[field] = members;
      continue;
    }
    const empty = (): void => {
      if (required.has(field)) { unobserved.push(field); note("VALUE_MISSING", field, mapping.from, native); }
      else cleared.push(field);
    };
    if (native === null) { empty(); continue; }
    if (!scalar(native)) { unobserved.push(field); note("VALUE_NOT_SCALAR", field, mapping.from, native); continue; }
    if (mapping.values) {
      const key = typeof native === "string" ? native : String(native);
      if (Object.hasOwn(mapping.values, key)) { fields[field] = mapping.values[key]; continue; }
      if (!isPresent(native)) { empty(); continue; }
      if (mapping.unmapped === "refuse") { refused.push(field); note("RECORD_REFUSED", field, mapping.from, native); }
      else { unobserved.push(field); note("VALUE_UNMAPPED", field, mapping.from, native); }
      continue;
    }
    if (!isPresent(native)) { empty(); continue; }
    fields[field] = native;
  }
  if (refused.length) return { kind: "refused", present: true, external_id: externalId, diagnostics };
  return { kind: "mapped", external_id: externalId, fields, unobserved, cleared, diagnostics };
}

/**
 * The record-overlay change between the last accepted `after` of this record (carried values
 * included; null for a first observation) and a new mapping. An unobserved field is carried from
 * `previous` and left out of `changed_fields`, so no write and no removal is planned for it; a
 * cleared field is absent from `after`. Only the source's mapping keys can change.
 */
export function changeBetween(
  previous: Readonly<Record<string, unknown>> | null,
  next: Extract<MappedRecord, { kind: "mapped" }>,
  meta: { external_id: string; change_kind: string },
): RecordChange {
  const before = previous ? { ...previous } : null;
  const after: Record<string, unknown> = { ...next.fields };
  for (const field of next.unobserved) {
    if (previous && Object.hasOwn(previous, field) && previous[field] !== undefined) after[field] = previous[field];
  }
  const unobserved = new Set(next.unobserved);
  const mapped = [...new Set([...Object.keys(next.fields), ...next.unobserved, ...next.cleared])].sort();
  return {
    external_id: meta.external_id,
    change_kind: meta.change_kind,
    changed_fields: mapped.filter((field) => !unobserved.has(field) && !same(before?.[field], after[field])),
    before,
    after,
    content_digest: `sha256:${sha256Hex(overlayCanonicalJson(after)!)}`,
  };
}

const clip = (text: string, n: number): string => (text.length > n ? text.slice(0, n - 1) + "…" : text);
const shown = (native: unknown): string | null => (native === null || native === undefined ? null : clip(typeof native === "string" ? native : JSON.stringify(native) ?? String(native), 80));

const FINDING_TEXT: Record<MappingDiagnosticCode, (field: string, native: string | null) => string> = {
  VALUE_UNMAPPED: (field, native) => `${field}: value ${JSON.stringify(native)} has no row in the values table; the stored value was kept`,
  RECORD_REFUSED: (field, native) => `${field}: value ${JSON.stringify(native)} has no row in the values table; the record was refused and left unchanged`,
  VALUE_NOT_SCALAR: (field) => `${field}: the provider sent a list or mapping; the stored value was kept`,
  VALUE_NOT_LIST: (field) => `${field}: the provider sent something other than a list of text; the stored value was kept`,
  VALUE_MISSING: (field) => `${field}: required, and the provider sent no value; the stored value was kept`,
  IDENTITY_MISSING: () => "records without a value for the identity template were skipped",
  IDENTITY_INVALID: () => "records whose identity could collide with another's or is too long were skipped",
};

function* take<T>(items: Iterable<T>, n: number): Generator<T> {
  if (n <= 0) return;
  for (const item of items) { yield item; if (--n === 0) return; }
}

/** A native named by its shape: `list`, `mapping`, `empty` (absent, `null` or blank text) or `scalar`. */
function nativeShape(native: unknown): string {
  if (Array.isArray(native)) return "list";
  if (record(native)) return "mapping";
  return native === null || native === undefined || (typeof native === "string" && !isPresent(native)) ? "empty" : "scalar";
}

/**
 * Findings for `planFindings`, so one problem across many records raises one Signal: an unknown
 * value one per source, field, code and native value; a value of the wrong shape or an empty one
 * one per source, field, code and shape; identity gaps one per source. `facts` hold the code, field
 * and the clipped native value or the shape, never a record id, so a dismissed finding stays
 * dismissed until they change; the summary names the count and a sample of record ids.
 */
export function findingsFor(diagnostics: readonly MappingDiagnostic[], scope: { source: string }): Finding[] {
  const groups = new Map<string, { diagnostic: MappingDiagnostic; ids: Set<string> }>();
  for (const d of diagnostics) {
    const identity = d.code === "IDENTITY_MISSING" || d.code === "IDENTITY_INVALID";
    const key = identity
      ? `mapping:${scope.source}:${d.code}`
      : d.code === "VALUE_NOT_SCALAR" || d.code === "VALUE_NOT_LIST" || d.code === "VALUE_MISSING"
        ? `mapping:${scope.source}:${d.field}:${d.code}:${nativeShape(d.native)}`
        // The string the values table was searched with, so 7 and "7" are one finding as one lookup.
        : `mapping:${scope.source}:${d.field}:${d.code}:${sha256Hex(typeof d.native === "string" ? d.native : String(d.native)).slice(0, 16)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { diagnostic: d, ids: new Set() });
    if (d.external_id !== null) group.ids.add(d.external_id);
  }
  return [...groups].map(([key, { diagnostic: d, ids }]) => {
    const byShape = d.code === "VALUE_NOT_SCALAR" || d.code === "VALUE_NOT_LIST" || d.code === "VALUE_MISSING";
    const native = d.code === "IDENTITY_MISSING" || d.code === "IDENTITY_INVALID" || byShape ? null : shown(d.native);
    const sample = [...take(ids, 3)].map((id) => clip(id, 60)).join(", ");
    const records = ids.size ? `${ids.size} record${ids.size === 1 ? "" : "s"} (${sample}${ids.size > 3 ? ", …" : ""})` : "records";
    return {
      key,
      title: clip(`Mapping ${d.code} on ${scope.source}.${d.field}`, 140),
      summary: clip(`${FINDING_TEXT[d.code](d.field, native)}: ${records}`, 600),
      priority: d.code === "RECORD_REFUSED" || d.code === "IDENTITY_MISSING" || d.code === "IDENTITY_INVALID" ? "normal" : "low",
      facts: byShape ? { code: d.code, field: d.field, shape: nativeShape(d.native) } : { code: d.code, field: d.field, native },
    };
  });
}
