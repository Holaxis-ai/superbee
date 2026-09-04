/** Browser/Worker-safe parsing for the bundle-root OKF edition marker. */

import yaml from "js-yaml";

import { MalformedDocumentError } from "./frontmatter-contract.js";
import type { Frontmatter } from "./types.js";

/**
 * Parse only a leading YAML frontmatter block. This deliberately avoids gray-matter: that package
 * constructs a Node Buffer while parsing even a string, so it cannot execute in a Worker runtime.
 */
export function parseLeadingFrontmatter(raw: string, context?: string): Frontmatter {
  // Match the legacy parser's UTF-8 text behavior without pulling its Buffer-dependent package
  // into the portable graph. Only a single file-leading BOM is an encoding marker.
  const input = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  if (!/^---(?:\r?\n|$)/.test(input)) return {} as Frontmatter;

  const firstLineEnd = input.indexOf("\n");
  const afterOpening = firstLineEnd === -1 ? "" : input.slice(firstLineEnd + 1);
  const closing = /^---\r?$/m.exec(afterOpening);
  if (!closing) {
    throw new MalformedDocumentError(context, new Error("unterminated YAML frontmatter delimiter"));
  }

  try {
    const parsed = yaml.safeLoad(afterOpening.slice(0, closing.index));
    if (parsed === undefined || parsed === null) return {} as Frontmatter;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("YAML frontmatter must be a mapping");
    }
    return parsed as Frontmatter;
  } catch (error) {
    if (error instanceof MalformedDocumentError) throw error;
    throw new MalformedDocumentError(context, error);
  }
}
