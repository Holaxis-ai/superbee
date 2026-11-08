/**
 * The one answer to "does this Kind declare this frontmatter key?" for stored documents, and the
 * write-time undeclared-field check built on it. `kindCoverage` reports the same keys after the
 * fact; the CLI's flag parser resolves flags through the same {@link resolveKindFieldCoordinate}.
 */
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";
import { okfValuesEqual } from "./okf-authored-values.js";
import { isOkfStandardField } from "./okf-standard-fields.js";
import {
  projectKindForAuthoring,
  resolveKindFieldCoordinate,
  SUPERBEE_PROGRESS_STATUS_FIELD,
  type KindConvention,
} from "./kinds.js";
import type { ValidationWarning } from "./validation.js";
import type { Frontmatter } from "./types.js";

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

/**
 * One finding per undeclared key the write adds or changes. Keys the write leaves exactly as
 * stored never count, so existing drift stays editable and `kinds --coverage` remains its report.
 */
export function undeclaredFieldWarnings(
  okfVersion: string | undefined,
  kind: KindConvention,
  candidate: Frontmatter,
  existing?: Frontmatter,
): ValidationWarning[] {
  const declared = kindDeclaredFieldNames(okfVersion, kind);
  const list = declared.length > 0 ? declared.join(", ") : "none";
  return undeclaredFrontmatterKeys(okfVersion, kind, candidate)
    .filter((key) => !existing || !Object.hasOwn(existing, key) || !okfValuesEqual(existing[key], candidate[key]))
    .sort()
    .map((key) => ({
      code: KIND_FIELD_UNDECLARED,
      message: `'${key}' is not declared by kind '${kind.governs}' (declared: ${list}).`,
      field: key,
      severity: "warning" as const,
    }));
}
