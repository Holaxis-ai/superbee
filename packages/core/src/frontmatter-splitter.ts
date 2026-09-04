/** Runtime-neutral recognition and extraction of an exact leading YAML frontmatter block. */

import { MalformedDocumentError } from "./frontmatter-contract.js";

export type LeadingFrontmatterSplit =
  | { body: string }
  | { yamlSource: string; body: string };

/** Return the offset after an exact delimiter line, including its line ending when present. */
function delimiterLineEnd(input: string, offset: number): number | null {
  if (!input.startsWith("---", offset)) return null;
  const suffix = offset + 3;
  if (suffix === input.length) return suffix;
  if (input[suffix] === "\n") return suffix + 1;
  if (input[suffix] === "\r" && input[suffix + 1] === "\n") return suffix + 2;
  return null;
}

/**
 * Normalize one leading UTF-8 BOM, then split only exact `---` delimiter lines. Schema selection
 * and parsed-value validation remain the responsibility of each parser surface.
 */
export function splitLeadingFrontmatter(raw: string, context?: string): LeadingFrontmatterSplit {
  const input = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const openingEnd = delimiterLineEnd(input, 0);
  if (openingEnd === null) return { body: input };

  let lineStart = openingEnd;
  while (lineStart < input.length) {
    const closingEnd = delimiterLineEnd(input, lineStart);
    if (closingEnd !== null) {
      return {
        yamlSource: input.slice(openingEnd, lineStart),
        body: input.slice(closingEnd),
      };
    }
    const nextLineFeed = input.indexOf("\n", lineStart);
    if (nextLineFeed === -1) break;
    lineStart = nextLineFeed + 1;
  }

  throw new MalformedDocumentError(context, new Error("unterminated YAML frontmatter delimiter"));
}
