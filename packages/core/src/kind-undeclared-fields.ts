/**
 * The one answer to "does this Kind declare this frontmatter key?" for stored documents, and the
 * write-time undeclared-field check built on it. `kindCoverage` reports the same keys after the
 * fact; surfaces resolve caller-named fields through {@link unknownKindFieldNames} and report them
 * with {@link kindFieldsUndeclaredFinding}. The same "is it declared?" question for a document's
 * `type` is {@link undeclaredTypeFinding}.
 */
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";
import { okfValuesEqual } from "./okf-authored-values.js";
import { isOkfStandardField } from "./okf-standard-fields.js";
import { isSystemDocument } from "./system-documents.js";
import {
  progressStatusCoordinate,
  projectKindForAuthoring,
  resolveKindFieldCoordinate,
  SUPERBEE_PROGRESS_STATUS_FIELD,
  type KindConvention,
  type KindRegistry,
} from "./kinds.js";
import type { ValidationWarning } from "./validation.js";
import type { ConceptId, Frontmatter } from "./types.js";

export const KIND_FIELD_UNDECLARED = "KIND_FIELD_UNDECLARED";

/**
 * Keys no Kind needs to declare: OKF standard fields, Superbee-managed metadata, and Superbee's
 * own `superbee_*` keys. The progress coordinate is a domain field a Kind declares like any other.
 */
export function isKindEnvelopeField(key: string): boolean {
  return isOkfStandardField(key) || isManagedDocumentMetadataField(key) ||
    (key.startsWith("superbee_") && key !== SUPERBEE_PROGRESS_STATUS_FIELD);
}

/** Authoring names the Kind declares, as shown to authors (the edition's logical spelling). */
export function kindDeclaredFieldNames(okfVersion: string | undefined, kind: KindConvention): string[] {
  const authoring = projectKindForAuthoring(okfVersion, kind);
  return [...new Set([...authoring.fields.required, ...authoring.fields.optional])];
}

/** The frontmatter keys that store this Kind's declared fields in this edition. */
export function kindDeclaredStorageFields(okfVersion: string | undefined, kind: KindConvention): Set<string> {
  return new Set(kindDeclaredFieldNames(okfVersion, kind)
    .map((field) => resolveKindFieldCoordinate(okfVersion, kind, field)?.storageField ?? field));
}

/** Frontmatter keys that are neither declared by the Kind nor part of the standard envelope. */
export function undeclaredFrontmatterKeys(okfVersion: string | undefined, kind: KindConvention, frontmatter: Frontmatter): string[] {
  const declared = kindDeclaredStorageFields(okfVersion, kind);
  return Object.keys(frontmatter).filter((key) => !isKindEnvelopeField(key) && !declared.has(key));
}

export type KindFieldUndeclaredDetails = {
  /** The Kind's `governs` name. */
  kind: string;
  /** The named fields the Kind does not declare, in the caller's order. */
  fields: string[];
  /** The authoring names the Kind declares ({@link kindDeclaredFieldNames}). */
  declared: string[];
};

export interface KindFieldUndeclaredFinding extends ValidationWarning {
  code: typeof KIND_FIELD_UNDECLARED;
  details: KindFieldUndeclaredDetails;
}

/**
 * One finding per undeclared key the write adds or changes. Keys the write leaves exactly as
 * stored never count, so existing drift stays editable and `kinds --coverage` remains its report.
 * Each carries the same `details` as {@link kindFieldsUndeclaredFinding}, so `KIND_FIELD_UNDECLARED`
 * has one shape; its message keeps naming the key, as stored findings always have.
 */
export function undeclaredFieldWarnings(
  okfVersion: string | undefined,
  kind: KindConvention,
  candidate: Frontmatter,
  existing?: Frontmatter,
): KindFieldUndeclaredFinding[] {
  const declared = kindDeclaredFieldNames(okfVersion, kind);
  const list = declared.length > 0 ? declared.join(", ") : "none";
  // Authors see logical names; a raw key spelled with one stores nothing the Kind reads.
  const progress = progressStatusCoordinate(okfVersion, kind);
  const message = (key: string) => progress && key === progress.logicalField && key !== progress.storageField
    ? `'${key}' is the field name, not its stored key in this bundle; write it in frontmatter as '${progress.storageField}'.`
    : `'${key}' is not declared by kind '${kind.governs}' (declared: ${list}).`;
  return undeclaredFrontmatterKeys(okfVersion, kind, candidate)
    .filter((key) => !existing || !Object.hasOwn(existing, key) || !okfValuesEqual(existing[key], candidate[key]))
    .sort()
    .map((key) => ({
      code: KIND_FIELD_UNDECLARED,
      message: message(key),
      field: key,
      severity: "warning" as const,
      details: { kind: kind.governs, fields: [key], declared: [...declared] },
    }));
}

/**
 * The field names a caller addressed (flags, form inputs, tool arguments) that this Kind does not
 * declare, resolved through the one field resolver ({@link resolveKindFieldCoordinate}), in input
 * order. A logical name the edition stores under another key (`progress_status`) resolves.
 */
export function unknownKindFieldNames(okfVersion: string | undefined, kind: KindConvention, fields: Iterable<string>): string[] {
  return [...fields].filter((field) => resolveKindFieldCoordinate(okfVersion, kind, field) === undefined);
}

/**
 * The structured finding for fields a caller addressed that `kind` does not declare, or undefined
 * when `fields` is empty. Surfaces word the remedy (a CLI command, a tool name) from `details`.
 */
export function kindFieldsUndeclaredFinding(
  okfVersion: string | undefined,
  kind: KindConvention,
  fields: readonly string[],
): KindFieldUndeclaredFinding | undefined {
  if (fields.length === 0) return undefined;
  return {
    code: KIND_FIELD_UNDECLARED,
    message: "The document's Kind does not declare one or more of the named fields.",
    ...(fields.length === 1 ? { field: fields[0]! } : {}),
    severity: "warning",
    details: { kind: kind.governs, fields: [...fields], declared: kindDeclaredFieldNames(okfVersion, kind) },
  };
}

export const KIND_TYPE_UNDECLARED = "KIND_TYPE_UNDECLARED";

export type KindTypeUndeclaredDetails = {
  /** The document's `type`. */
  type: string;
  /** Every type the bundle's Kinds govern, sorted. */
  declaredTypes: string[];
  /** A declared type equal to `type` ignoring case, spacing, hyphens and underscores: probably the intended one. */
  suggestedType?: string;
};

export interface KindTypeUndeclaredFinding extends ValidationWarning {
  code: typeof KIND_TYPE_UNDECLARED;
  details: KindTypeUndeclaredDetails;
}

/** A type's spelling with case, spacing, hyphens and underscores ignored: `ContextNote`, `context-note` and `Context Note` agree. */
function typeKey(type: string): string {
  return type.replace(/[\s_-]+/g, "").toLowerCase();
}

/**
 * A finding when a document's `type` is not governed by any Kind in a bundle that declares Kinds.
 * Ungoverned types stay legal (they are how new Kinds are discovered), so this is `info`, raised to
 * `warning` when a declared type differs only in case, spacing, hyphens or underscores. A bundle with no Kinds, a
 * missing or non-string type, and Superbee's own documents ({@link isSystemDocument}) never
 * produce one.
 */
export function undeclaredTypeFinding(
  registry: KindRegistry,
  doc: { id: ConceptId; frontmatter: Frontmatter },
): KindTypeUndeclaredFinding | undefined {
  const type = doc.frontmatter.type;
  if (typeof type !== "string" || type.trim() === "" || registry.kinds.size === 0) return undefined;
  if (registry.kinds.has(type) || isSystemDocument(doc)) return undefined;
  const declaredTypes = [...registry.kinds.keys()].sort();
  const suggestedType = declaredTypes.find((declared) => typeKey(declared) === typeKey(type));
  return suggestedType === undefined
    ? {
      code: KIND_TYPE_UNDECLARED,
      message: "No Kind in this bundle governs this document's type, so the document is not checked against a Kind.",
      field: "type",
      severity: "info",
      details: { type, declaredTypes },
    }
    : {
      code: KIND_TYPE_UNDECLARED,
      message: "No Kind governs this document's type, but a declared type differs from it only in case or spacing.",
      field: "type",
      severity: "warning",
      details: { type, declaredTypes, suggestedType },
    };
}
