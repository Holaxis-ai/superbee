/**
 * Grep gate for THE INVARIANT's attribute surface: in the renderer source, an `href` attribute is
 * assigned from exactly two producers, the same-origin document route builder and the external
 * allowlist's admitted value, and a URL's serialization (`.href`) is read only inside the allowlist
 * function. A third producer, or a `.href` read anywhere else, is a new path from markdown to an
 * attribute and fails here before any rendering test has to notice.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const files = readdirSync(src).filter((name) => /\.tsx?$/.test(name)).map((name) => path.join(src, name));

/** Source with block and line comments blanked, so prose about `.href` does not count as a read. */
function code(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/^(\s*)\/\/.*$/gm, "$1");
}

test("every href attribute in the renderer source is built by documentHref or admitted by the allowlist", () => {
  const seen = [];
  for (const file of files) {
    for (const match of code(file).matchAll(/\bhref=\{\s*([^\s}]+)/g)) {
      seen.push(`${path.basename(file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(seen.sort(), [
    "index.tsx: documentHref(resolved,",
    "index.tsx: documentHref(to,",
    "index.tsx: external",
  ]);
});

test("the allowlist's `external` binding comes only from admitExternalLink", () => {
  const content = code(path.join(src, "index.tsx"));
  const bindings = [...content.matchAll(/\bconst external\s*=\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.deepEqual(bindings, ["admitExternalLink(raw, state.options.externalLinkHosts)"]);
});

test("a URL serialization (.href) is read only inside admitExternalLink and its entry normalizer", () => {
  for (const file of files) {
    const lines = code(file).split("\n");
    let fn = null;
    for (const [i, line] of lines.entries()) {
      const started = /^(export )?function (\w+)\(/.exec(line);
      if (started) fn = started[2];
      if (/^}/.test(line)) fn = null;
      if (/\.href\b/.test(line)) {
        assert.ok(
          fn === "admitExternalLink" || fn === "normalizeAllowedHost",
          `${path.basename(file)}:${i + 1} reads .href outside the allowlist: ${line.trim()}`,
        );
      }
    }
  }
});
