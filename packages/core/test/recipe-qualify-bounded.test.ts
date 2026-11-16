import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A synchronous transform regression must fail its child deadline, not hang the test runner.
const program = `
import assert from 'node:assert/strict';
import { qualifyRecipeSet } from ${JSON.stringify(new URL("../src/recipes.ts", import.meta.url).href)};
import { extractMarkdownLinkSpans, rewriteMarkdownLinks } from ${JSON.stringify(new URL("../src/links.ts", import.meta.url).href)};
const mode = process.argv[1];
const body = mode === 'brackets' ? '['.repeat(1024 * 1024)
  : mode === 'angles' ? '<a'.repeat(512 * 1024)
  : mode === 'external' ? '[x](https://example.test/x)\\n'.repeat(70_000)
  : '[x](../../tasks/a.md)\\n'.repeat(80_000);
assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024);
if (mode === 'rewrite') {
  const spans = extractMarkdownLinkSpans(body);
  let callbacks = 0; let previous = Infinity;
  const result = rewriteMarkdownLinks(body, spans, span => {
    assert.ok(span.hrefStart < previous); previous = span.hrefStart; callbacks++;
    return '../../../tasks/a.md';
  });
  assert.equal(callbacks, 80_000);
  assert.equal(result, '[x](../../../tasks/a.md)\\n'.repeat(80_000));
} else {
  const result = qualifyRecipeSet([{ entry: { key: 'sample', source: './sample', namespace: 'github.com/123/sample' }, source: 'root/sample', files: [
    { path: 'recipe.md', bytes: '---\\ntype: Recipe\\nid: sample\\ntitle: Sample\\nversion: "1"\\nsummary: Synthetic\\n---\\n' },
    { path: 'conventions/nested/kind.md', bytes: '---\\ntype: Convention\\ngoverns: Example\\n---\\n' + body },
  ] }]);
  const output = result.recipes[0].recipe.docs[0].body;
  if (mode === 'relocated') assert.equal(output, '[x](../../../tasks/a.md)\\n'.repeat(80_000));
  else assert.equal(output, body.endsWith('\\n') ? body : body + '\\n');
}
process.stdout.write('complete');
`;
for (const mode of ["brackets", "angles", "external", "rewrite", "relocated"]) {
  test(`in-bounds ${mode} processing completes within a subprocess deadline`, () => {
    const result = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./ts-loader.mjs", import.meta.url)), "--input-type=module", "-e", program, mode], {
      timeout: 8_000, encoding: "utf8", maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined, `${mode}: ${result.error?.message}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "complete");
  });
}
