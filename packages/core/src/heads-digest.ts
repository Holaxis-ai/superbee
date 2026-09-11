/**
 * The heads digest: one content-addressed token over every document id and version a bundle
 * holds, so a client can learn in one round trip whether anything changed
 * (`docs/WIRE-PROTOCOL.md`, "Heads and snapshot").
 *
 * The recipe is fixed so any host computes the same token from the same heads: sort the heads by
 * id with `localeCompare` (the order every list route uses), concatenate `id`, `\n`, `version`,
 * `\n` for each head, hash the UTF-8 bytes with SHA-256, and prefix the lowercase hex with
 * `sha256:`. An empty bundle digests the empty byte string. The digest changes whenever a
 * document is created, updated (its version changes) or deleted (its id disappears).
 *
 * Runtime-neutral: the reference router, a Worker host and a browser working copy all mint the
 * same token through the one pure SHA-256 in `sha256.ts`.
 */

import { sha256HexOfUtf8 } from "./sha256.js";
import type { ConceptId, Version } from "./types.js";

/** One document's identity on the wire: its id and current content-addressed version. */
export interface DocumentHead {
  id: ConceptId;
  version: Version;
}

const HEADS_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Sort heads into the wire's id order without mutating the input. */
export function sortHeads<Head extends DocumentHead>(heads: readonly Head[]): Head[] {
  return [...heads].sort((a, b) => a.id.localeCompare(b.id));
}

/** The digest of `heads` by the documented recipe; the input is sorted first, so order does not matter. */
export function headsDigest(heads: readonly DocumentHead[]): string {
  let input = "";
  for (const head of sortHeads(heads)) input += `${head.id}\n${head.version}\n`;
  return `sha256:${sha256HexOfUtf8(input)}`;
}

/** True for a well-formed heads digest token (`sha256:` plus 64 lowercase hex characters). */
export function isHeadsDigest(value: unknown): value is string {
  return typeof value === "string" && HEADS_DIGEST_RE.test(value);
}
