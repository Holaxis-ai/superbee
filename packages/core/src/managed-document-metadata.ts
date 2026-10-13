/** Exact managed fields shared by authoring ownership and domain inference.
 * Prefix and transport exclusions belong to their own consumers, not this authority. */
const MANAGED_DOCUMENT_METADATA_FIELDS = new Set([
  "generated", "verified", "superbee_updated_by", "actor", "timestamp",
]);

export function isManagedDocumentMetadataField(field: string): boolean {
  return MANAGED_DOCUMENT_METADATA_FIELDS.has(field);
}
