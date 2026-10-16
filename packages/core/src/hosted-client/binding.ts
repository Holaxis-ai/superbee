import { sha256HexOfUtf8 } from "../sha256.js";

/**
 * `sha256:<hex>` of a checkout's random id: the recovery binding (`X-Superbee-Checkout`) an
 * identified write and its outcome lookup are pinned to, never the id itself. The CLI derives a
 * checkout's binding with it, and a hosted client mints its own from a fresh id.
 */
export function checkoutBindingDigest(checkoutId: string): string {
  return `sha256:${sha256HexOfUtf8(checkoutId)}`;
}
