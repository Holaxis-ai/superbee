// Signal ids and finding digests. Synchronous and Node-free through core's pure SHA-256, which
// encodes strings as UTF-8 exactly as `node:crypto` does.
import { sha256Hex } from "../versioning.js";

export function sha256(input: string): string {
  return "sha256:" + sha256Hex(input);
}

/** Short stable token for ids (never a provider value used as a path). */
export function shortHash(...parts: unknown[]): string {
  return sha256Hex(parts.map(String).join("\u0000")).slice(0, 12);
}
