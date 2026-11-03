/** Browser/Worker-safe parsing for the bundle-root OKF edition marker. */

import { loadBoundedYaml } from "./bounded-yaml.js";
import { FrontmatterRefusedError } from "./errors.js";
import { MalformedDocumentError } from "./frontmatter-contract.js";
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
 * Refuse markdown whose leading frontmatter the reader would refuse, before it is stored as is.
 * Throws {@link FrontmatterRefusedError} carrying the reader's code.
 */
export function assertStorableFrontmatter(raw: string): void {
  try {
    parseLeadingFrontmatter(raw);
  } catch (error) {
    if (error instanceof MalformedDocumentError) throw new FrontmatterRefusedError(error.code, error.detail);
    throw error;
  }
}
