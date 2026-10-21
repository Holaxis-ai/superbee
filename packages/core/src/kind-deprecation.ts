/** Explicit-registry declaration lifecycle policy. Reads describe usage; transitions refuse only
 * newly authored usage. Import-like writes with an empty registry retain their existing posture. */
import type { KindConvention, KindRegistry } from "./kinds.js";
import type { OkfDocument } from "./types.js";
import type { ValidationWarning } from "./validation.js";
import { okfValuesEqual, isOkfRecord } from "./okf-authored-values.js";
import { isOkfStandardField } from "./okf-standard-fields.js";
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";
import { parseLinksFromDoc } from "./links.js";
import { parseQualifiedLinks } from "./qualified-links.js";

export interface KindDeprecation {
  fields: string[];
  values: Record<string, string[]>;
  links: string[];
  /** An invalid recognized policy stays visible and refuses admitted authoring, never skips its Kind. */
  problems?: ValidationWarning[];
  /** Preserve invalid author bytes through convention serialization rather than silently repairing. */
  raw?: unknown;
}

const problem = (field: string, message: string): ValidationWarning => ({
  code: "KIND_DEPRECATION_INVALID", field, message: `${field}: ${message}`, severity: "warning",
});

export function parseKindDeprecation(raw: unknown, kind: KindConvention, reserved: readonly string[], claimFields: readonly string[]): KindDeprecation {
  const result: KindDeprecation = { fields: [], values: {}, links: [] };
  const problems: ValidationWarning[] = [];
  const fail = (field: string, message: string): void => { problems.push(problem(field, message)); };
  const names = (value: unknown, path: string): string[] => {
    if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim() || v !== v.trim())) {
      fail(path, "expected a list of nonempty exact names"); return [];
    }
    return [...new Set(value as string[])];
  };
  const protectedField = (field: string): boolean => reserved.includes(field) || isOkfStandardField(field)
    || isManagedDocumentMetadataField(field) || claimFields.includes(field);
  if (!isOkfRecord(raw)) fail("deprecated", "expected a map of fields, values and links");
  else {
    for (const key of Object.keys(raw)) if (!["fields", "values", "links"].includes(key)) fail(`deprecated.${key}`, "unknown policy coordinate");
    if (Object.hasOwn(raw, "fields")) result.fields = names(raw.fields, "deprecated.fields");
    for (const field of result.fields) {
      if (!kind.fields.optional.includes(field) || kind.fields.required.includes(field) || protectedField(field)) {
        fail(`deprecated.fields.${field}`, "only an optional, nonstandard, nonreserved, nonclaim field can be deprecated");
      }
    }
    if (Object.hasOwn(raw, "values")) {
      if (!isOkfRecord(raw.values)) fail("deprecated.values", "expected a field-to-values map");
      else for (const [field, value] of Object.entries(raw.values)) {
        const path = `deprecated.values.${field}`;
        // Reuse the Kind enum's scalar-to-string membership vocabulary; structured values cannot name a member.
        const values = Array.isArray(value) && value.every(v => ["string", "number", "boolean"].includes(typeof v))
          ? [...new Set(value.map(String))] : undefined;
        if (!values || values.some(v => !v.trim())) { fail(path, "expected a list of enum members"); continue; }
        Object.defineProperty(result.values, field, { value: values, enumerable: true, writable: true, configurable: true });
        const allowed = Object.hasOwn(kind.fields.values, field) ? kind.fields.values[field] : undefined;
        if (protectedField(field) || ![...kind.fields.required, ...kind.fields.optional].includes(field)
          || !allowed || values.some(v => !allowed.includes(v)) || kind.fields.types?.[field] === "https-url-list") {
          fail(path, "expected members of a declared, nonstandard, nonclaim vocabulary");
        }
        const terminal = Object.hasOwn(kind.fields.terminal, field) ? kind.fields.terminal[field]! : [];
        if (values.some(v => terminal.includes(v))) fail(path, "terminal members require a separate migration");
        if (kind.fields.required.includes(field) && allowed && !allowed.some(v => !values.includes(v))) fail(path, "a required field must retain an active member");
      }
    }
    if (Object.hasOwn(raw, "links")) result.links = names(raw.links, "deprecated.links");
    for (const label of result.links) if (!kind.links || !Object.hasOwn(kind.links, label)) fail(`deprecated.links.${label}`, "expected an existing outbound label");
  }
  if (problems.length) { result.problems = problems; result.raw = structuredClone(raw); }
  return result;
}

/** Eligibility that needs the whole explicitly admitted registry, without foreign reads. */
export function kindDeprecationProblems(kind: KindConvention, registry?: KindRegistry): ValidationWarning[] {
  const problems = [...(kind.deprecated?.problems ?? [])];
  for (const label of kind.deprecated?.links ?? []) {
    if ([...(registry?.kinds.values() ?? [kind])].some(k => k.expectsInbound && Object.hasOwn(k.expectsInbound, label))) {
      problems.push(problem(`deprecated.links.${label}`, "the admitted registry still declares an inbound expectation for this label"));
    }
  }
  return problems;
}

export interface DeprecatedUsage {
  code: "KIND_DEPRECATED_FIELD" | "KIND_DEPRECATED_VALUE" | "KIND_DEPRECATED_LINK";
  field: string;
  /** Stable occurrence identity; qualified identities include the alias and remain distinct from local edges. */
  identity: string;
  count: number;
  /** The matched enum member, when this row describes value usage. */
  value?: string;
  unknown?: true;
}

/** Stored deprecated usage is information, deliberately separate from ordinary strict conformance. */
export function inspectKindDeprecatedUsage(doc: OkfDocument, kind: KindConvention): DeprecatedUsage[] {
  if (!kind.deprecated) return [];
  const rows = new Map<string, DeprecatedUsage>();
  const add = (code: DeprecatedUsage["code"], field: string, identity: unknown[], unknown = false): void => {
    const key = JSON.stringify([code, field, ...identity]);
    const previous = rows.get(key);
    if (previous) previous.count += 1;
    else rows.set(key, { code, field, identity: key, count: 1, ...(code === "KIND_DEPRECATED_VALUE" ? { value: String(identity[0]) } : {}), ...(unknown ? { unknown: true as const } : {}) });
  };
  for (const field of kind.deprecated.fields) if (Object.hasOwn(doc.frontmatter, field)) add("KIND_DEPRECATED_FIELD", field, ["field"]);
  for (const [field, values] of Object.entries(kind.deprecated.values)) {
    if (!Object.hasOwn(doc.frontmatter, field)) continue;
    const raw = doc.frontmatter[field];
    if (raw === null || raw === undefined) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) if (values.includes(String(value))) add("KIND_DEPRECATED_VALUE", field, [String(value)]);
  }
  if (kind.deprecated.links.length) {
    for (const edge of parseLinksFromDoc(doc)) if (kind.deprecated.links.includes(edge.text)) add("KIND_DEPRECATED_LINK", edge.text, ["local", edge.to, edge.text]);
    for (const edge of parseQualifiedLinks(doc)) if (kind.deprecated.links.includes(edge.text)) {
      if (edge.ref) add("KIND_DEPRECATED_LINK", edge.text, ["qualified", edge.ref.alias, edge.ref.id, edge.text]);
      else add("KIND_DEPRECATED_LINK", edge.text, ["malformed-qualified", edge.href, edge.text], true);
    }
  }
  return [...rows.values()].sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
}

/** One transition authority shared by every admitted mutation posture and each fresh CAS head. */
export function kindDeprecationTransition(existing: OkfDocument | undefined, candidate: OkfDocument, registry: KindRegistry): ValidationWarning[] {
  const kind = registry.kinds.get(String(candidate.frontmatter.type));
  if (!kind?.deprecated) return [];
  const invalid = kindDeprecationProblems(kind, registry);
  if (invalid.length) return invalid;
  const previous = existing?.id === candidate.id && existing.frontmatter.type === candidate.frontmatter.type ? existing : undefined;
  const oldRows = new Map((previous ? inspectKindDeprecatedUsage(previous, kind) : []).map(row => [row.identity, row]));
  return inspectKindDeprecatedUsage(candidate, kind).filter(row => {
    if (row.code === "KIND_DEPRECATED_FIELD") return !previous || !Object.hasOwn(previous.frontmatter, row.field)
      || !okfValuesEqual(previous.frontmatter[row.field], candidate.frontmatter[row.field]);
    return row.count > (oldRows.get(row.identity)?.count ?? 0);
  }).map(row => ({ code: row.code, field: row.field,
    message: `'${kind.governs}' declaration '${row.field}' is deprecated; preserve unchanged existing usage or remove it, but do not introduce or change deprecated usage (see ${kind.id}).`, severity: "warning" }));
}
