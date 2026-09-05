/**
 * Runtime-neutral document bytes for custom storage backends.
 * Uses the same parser and serializer as the Node adapters; no filesystem, default actor,
 * bundle selection, or mutation policy is implied by encoding or decoding a document.
 */
export {
  parseMarkdown,
  stringifyDoc,
  stringifyWithData,
  normalizeDocumentBodyForStorage,
  MalformedDocumentError,
} from "./frontmatter.js";
export { resolveContentType } from "./content-type.js";
export type { Frontmatter, OkfDocument, Version } from "./types.js";

import type { Version } from "./types.js";

/** SHA-256 version of exact bytes, including binary data, using Web Crypto. */
export async function versionFromBytes(bytes: Uint8Array): Promise<Version> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
