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

import { sha256HexOfBytes } from "./sha256.js";
import type { Version } from "./types.js";

/**
 * SHA-256 version of exact bytes, including binary data. Minted by the same pure
 * implementation as every other version token, so one digest owner serves Node and
 * browser runtimes; the async signature is kept for the codec's existing callers.
 */
export async function versionFromBytes(bytes: Uint8Array): Promise<Version> {
  return `sha256:${sha256HexOfBytes(bytes)}`;
}
