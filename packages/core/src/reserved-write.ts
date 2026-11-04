/** The one admission check every backend applies before storing a reserved file. */

import { assertSafeReservedDir, assertSafeReservedFilename } from "./paths.js";
import { assertStorableFrontmatter } from "./portable-frontmatter.js";
import type { ReservedFilename } from "./types.js";

/**
 * Admit a reserved-file write: a safe directory and name, and for a markdown file, leading
 * frontmatter within the frontmatter limits. Throws `InvalidInputError` for an unsafe location and
 * `FrontmatterRefusedError` for frontmatter a limit refuses, before anything is stored.
 */
export function assertStorableReservedWrite(dir: string, name: unknown, content: string): asserts name is ReservedFilename {
  assertSafeReservedDir(dir);
  assertSafeReservedFilename(name);
  if (name.endsWith(".md")) assertStorableFrontmatter(content);
}
