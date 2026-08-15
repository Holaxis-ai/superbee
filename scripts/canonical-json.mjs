/**
 * The one canonicalizer for values whose BYTES carry meaning: digest preimages and
 * structural equality checks.
 *
 * Key order must not change the result, so object keys are sorted at every depth. This is
 * distinct from the pretty-printers elsewhere in scripts/, which preserve insertion order
 * because they exist to be read by a human, not hashed. Do not substitute one for the other:
 * a pretty-printer used as a digest preimage hashes the same value two ways depending on the
 * key order it happened to be written in.
 */

/** Sort object keys at every depth; arrays keep their order, scalars pass through. */
export function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeJsonValue(value[key])]));
}

/**
 * The digest preimage: compact, key-sorted JSON. `label` names the caller in the error a
 * non-encodable value raises, since a silently dropped undefined would change the digest
 * without changing the input a reviewer sees.
 */
export function canonicalJsonString(value, label = "value") {
  const encoded = JSON.stringify(canonicalizeJsonValue(value));
  if (encoded === undefined) throw new Error(`${label} cannot encode ${typeof value}`);
  return encoded;
}

/** Structural equality that ignores key order. */
export function sameJsonValue(left, right) {
  return JSON.stringify(canonicalizeJsonValue(left)) === JSON.stringify(canonicalizeJsonValue(right));
}
