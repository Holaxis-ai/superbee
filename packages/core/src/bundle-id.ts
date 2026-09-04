/** Immutable hosted bundle id: 16 random bytes rendered as lowercase hexadecimal. */
export type BundleId = `bnd_${string}`;

const BUNDLE_ID_RE = /^bnd_[0-9a-f]{32}$/u;

/** True only for the exact opaque hosted bundle-id grammar. */
export function isCanonicalBundleId(value: string): value is BundleId {
  return BUNDLE_ID_RE.test(value);
}
