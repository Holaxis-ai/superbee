/** Browser/Worker-safe parsing for the bundle-root OKF edition marker. */

import { loadBoundedYaml } from "./bounded-yaml.js";
import { FrontmatterRefusedError } from "./errors.js";
import { MalformedDocumentError } from "./frontmatter-contract.js";
import { parseFrontmatter } from "./frontmatter.js";
import { splitLeadingFrontmatter } from "./frontmatter-splitter.js";
import type { Frontmatter } from "./types.js";

/**
 * Parse only a leading YAML frontmatter block. This deliberately avoids gray-matter: that package
 * constructs a Node Buffer while parsing even a string, so it cannot execute in a Worker runtime.
 */
export function parseLeadingFrontmatter(raw: string, context?: string): Frontmatter {
  const split = splitLeadingFrontmatter(raw, context);
  if (!("yamlSource" in split)) return {} as Frontmatter;

  try {
    const parsed = loadBoundedYaml(split.yamlSource);
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

/**
 * Refuse markdown whose leading frontmatter a frontmatter limit refuses, before it is stored as
 * is. Throws {@link FrontmatterRefusedError} carrying the limit's code. Invalid YAML is not refused
 * here: readers of reserved files already treat it as an unreadable marker and fall back.
 */
export function assertStorableFrontmatter(raw: string): void {
  try {
    parseLeadingFrontmatter(raw);
    // Reserved files are also read with the document schema, which keeps timestamps as strings
    // and so measures them differently; refuse whatever either reader would refuse.
    const split = splitLeadingFrontmatter(raw);
    if ("yamlSource" in split) parseFrontmatter(split.yamlSource);
  } catch (error) {
    if (error instanceof MalformedDocumentError && error.code !== "FRONTMATTER_MALFORMED") {
      throw new FrontmatterRefusedError(error.code, error.detail);
    }
    if (!(error instanceof MalformedDocumentError)) throw error;
  }
}
