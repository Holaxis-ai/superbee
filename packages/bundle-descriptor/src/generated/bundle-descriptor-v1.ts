/* GENERATED from schema/bundle-descriptor-v1.schema.json - do not edit. */

/**
 * A stable authority-qualified identity. The publisher controls the first segment; directory policy owns collision handling.
 *
 * This interface was referenced by `SuperbeeBundleDescriptorV1`'s JSON-Schema
 * via the `definition` "bundleId".
 */
export type BundleId = string;
/**
 * Untrusted display text. Presenters must still escape it for their output context.
 *
 * This interface was referenced by `SuperbeeBundleDescriptorV1`'s JSON-Schema
 * via the `definition` "displayText".
 */
export type DisplayText = string;

/**
 * A bundle's minimal, portable self-description. This contract conveys no access, authority, ownership, lifecycle, policy, routing, or resolution claims.
 */
export interface SuperbeeBundleDescriptorV1 {
  schema: "https://getsuperbee.com/schemas/bundle-descriptor/v1";
  bundleId: BundleId;
  /**
   * Untrusted display text. Presenters must still escape it for their output context.
   */
  name: string;
  /**
   * Untrusted display text. Presenters must still escape it for their output context.
   */
  purpose: string;
}
