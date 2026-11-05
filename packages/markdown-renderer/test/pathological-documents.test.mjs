import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { renderToStaticMarkup } from "react-dom/server";

import { MAX_BODY_CHARS, renderMarkdown } from "../dist/index.js";
import {
  MAX_BLOCK_EMPHASIS,
  MAX_LINE_MARKERS,
  MAX_LINE_NESTING,
  MAX_LINE_PREFIX,
  MAX_PIPES,
  MAX_TABLES,
  isCallStackExhausted,
  parseWithinLimits,
} from "../dist/parse.js";
import { renderDocumentToStaticHtml, renderMarkdownToStaticHtml } from "../dist/static.js";

// A generous limit so a slow runner stays green.
const RENDER_LIMIT_MS = 30_000;
const FALLBACK = "doc-code doc-markdown-fallback";

function fill(unit, length = MAX_BODY_CHARS) {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function timedRender(body) {
  const start = performance.now();
  const interactive = renderMarkdown(body, { fromId: "notes/a", onNavigateDoc: () => {} });
  const interactiveHtml = renderToStaticMarkup(interactive.element);
  const interactiveMs = performance.now() - start;
  const staticStart = performance.now();
  const rendered = renderDocumentToStaticHtml({ id: "notes/a", body });
  const staticMs = performance.now() - staticStart;
  return { interactive, interactiveHtml, interactiveMs, rendered, staticMs };
}

function unguardedTree(body) {
  return fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function indentedList(depth) {
  return Array.from({ length: depth }, (_, level) => `${"  ".repeat(level)}- a`).join("\n");
}

const overLimit = {
  "nested link brackets": "[a".repeat(15_000) + "](https://x)".repeat(12_000),
  "nested image brackets": "![a".repeat(9_000) + "](https://x)".repeat(9_000),
  "deep block quotes": "> ".repeat(25_000) + "x",
  "deep block quotes without spaces": ">".repeat(25_000) + "x",
  "deep bullet lists": "- ".repeat(25_000) + "x",
  "deep ordered lists": "1. ".repeat(20_000) + "x",
  "deep mixed containers": "> - ".repeat(15_000) + "x",
  "deep footnote definitions": "[^a]: ".repeat(10_000) + "x",
  "lists nested by indentation": indentedList(511),
  "repeated deep list lines": fill("- ".repeat(100) + "x\n"),
  "unmatched closing brackets": fill("]"),
  "closing brackets across lines of one paragraph": fill("]\n"),
  "closing brackets across many paragraphs": fill("]".repeat(4_000) + "\n\n"),
  "unmatched emphasis": fill("*a"),
  "one long emphasis run": fill("*", MAX_BODY_CHARS / 2) + "a" + fill("*", MAX_BODY_CHARS / 2 - 1),
  "many long emphasis runs": fill("*".repeat(3_000) + "a" + "*".repeat(3_000) + "\n\n"),
  "unclosed link targets": fill("[a]("),
  "autolink followed by entities": "http://a" + fill("&a;", MAX_BODY_CHARS - 8),
  "lines continuing a quote": "> a\n" + fill("b\n", MAX_BODY_CHARS - 4),
  "lines continuing a list item": "- a\n" + fill("b\n", MAX_BODY_CHARS - 4),
  "lines continuing a nested list item": "- ".repeat(MAX_LINE_NESTING) + "a\n" + fill("b\n", MAX_BODY_CHARS / 2),
  "unclosed processing instructions": "a" + fill("<?", MAX_BODY_CHARS - 1),
  "unclosed comments": "a" + fill("<!--", MAX_BODY_CHARS - 1),
  "unclosed character data": "a" + fill("<![CDATA[", MAX_BODY_CHARS - 1),
  "words ending in a dot": fill("a."),
  "words ending in a hyphen": fill("a-"),
  "words ending in a plus": fill("a+"),
  "hard line breaks": fill("a  \n"),
  "list items": fill("- a\n"),
  "list items with bare carriage returns": fill("- a\r"),
  "table rows": "|a|b|\n|-|-|\n" + fill("|c|d|\n", MAX_BODY_CHARS - 12),
  "table rows without pipes": "a|b\n-|-\n" + fill("c\n", MAX_BODY_CHARS - 8),
  "table columns": "|" + fill("a|", 60_000) + "\n|" + fill("-|", 60_000) + "\n",
  "many tables": fill("a|b\n-|-\nc\n\n"),
  "many tables with no rows": fill("a|b\n-|-\n\n"),
};
for (const [name, body] of Object.entries(overLimit)) {
  if (body.includes("\n")) overLimit[`${name} with CRLF line ends`] = body.replace(/\n/g, "\r\n");
}

for (const [name, body] of Object.entries(overLimit)) {
  test(`over the limit, ${name} render as escaped text within the bound through both entries`, () => {
    const { interactive, interactiveHtml, interactiveMs, rendered, staticMs } = timedRender(body);
    assert.equal(interactive.bounded, true);
    assert.equal(rendered.bounded, true);
    assert.ok(interactiveMs < RENDER_LIMIT_MS, `interactive took ${interactiveMs} ms`);
    assert.ok(staticMs < RENDER_LIMIT_MS, `static took ${staticMs} ms`);
    assert.ok(interactiveHtml.includes(FALLBACK));
    assert.equal(rendered.html, `<div data-aslite-rendered-document="">${interactiveHtml}</div>`);
    const code = new JSDOM(rendered.html).window.document.querySelector("pre code");
    assert.equal(code.textContent.replace(/\r\n?/g, "\n"), body.slice(0, MAX_BODY_CHARS).replace(/\r\n?/g, "\n"));
  });
}

const justInside = {
  "an emphasis run": "*".repeat(MAX_BLOCK_EMPHASIS / 2) + "a" + "*".repeat(MAX_BLOCK_EMPHASIS / 2),
  "nested emphasis": "*a ".repeat(MAX_BLOCK_EMPHASIS / 2) + "a* ".repeat(MAX_BLOCK_EMPHASIS / 2),
  "nested images": "![".repeat(3_000) + "a" + "](x)".repeat(3_000),
  "nested links": "[a".repeat(3_000) + "](x)".repeat(3_000),
  "closing brackets": "]".repeat(10_000),
  "an autolink followed by entities": `http://a${"&a;".repeat(10_000)}&`,
  "lines continuing a quote": "> a\n" + "b\n".repeat(6_000),
  "list items": "- a\n\n".repeat(MAX_LINE_MARKERS - 1),
  "many tables": "a|b\n-|-\nc\n\n".repeat(MAX_TABLES - 1),
  "many blocks of closing brackets": ("]".repeat(2_500) + "\n\n").repeat(16),
};
for (const [name, body] of Object.entries(justInside)) {
  justInside[`${name} with CRLF line ends`] = body.replace(/\n/g, "\r\n");
}

for (const [name, body] of Object.entries(justInside)) {
  test(`just inside the limit, ${name} parse and render within the bound`, () => {
    const start = performance.now();
    const { html } = renderDocumentToStaticHtml({ id: "notes/a", body });
    const elapsed = performance.now() - start;
    assert.ok(!html.includes(FALLBACK));
    assert.ok(elapsed < RENDER_LIMIT_MS, `took ${elapsed} ms`);
  });
}

test("the escaped text of a document over the limit stays inert", () => {
  const body = `${"]".repeat(15_000)}\n\n<script>globalThis.ran = true</script>\n\n[x](javascript:alert(1)) ![y](https://example.invalid/y.png)`;
  const { html, bounded } = renderMarkdownToStaticHtml(body, { fromId: "notes/a" });
  assert.equal(bounded, true);
  const { document } = new JSDOM(html).window;
  assert.equal(document.querySelector("script,a,img"), null);
  assert.match(document.body.textContent, /<script>globalThis\.ran = true<\/script>/);
});

test("a CRLF document counts each line end once", () => {
  const body = "a|b\n-|-\n" + "c\n".repeat(1_000);
  assert.notEqual(parseWithinLimits(body), null);
  assert.deepEqual(parseWithinLimits(body.replace(/\n/g, "\r\n")).children.map((node) => node.type), ["table"]);
  const over = "|a|\r\n|-|\r\n" + "|c|\r\n".repeat(MAX_PIPES / 2);
  assert.equal(parseWithinLimits(over), null);
});

test("each document total stops at its limit", () => {
  assert.notEqual(parseWithinLimits("- a\n\n".repeat(MAX_LINE_MARKERS)), null);
  assert.equal(parseWithinLimits("- a\n\n".repeat(MAX_LINE_MARKERS + 1)), null);
  assert.notEqual(parseWithinLimits("a|b\n-|-\n\n".repeat(MAX_TABLES)), null);
  assert.equal(parseWithinLimits("a|b\n-|-\n\n".repeat(MAX_TABLES + 1)), null);
  assert.equal(parseWithinLimits(("|".repeat(100) + "\n\n").repeat(Math.ceil(MAX_PIPES / 100) + 1)), null);
});

test("each nesting limit stops one marker past it", () => {
  assert.notEqual(parseWithinLimits("> ".repeat(MAX_LINE_NESTING) + "x"), null);
  assert.equal(parseWithinLimits("> ".repeat(MAX_LINE_NESTING + 1) + "x"), null);
  assert.notEqual(parseWithinLimits(`${" ".repeat(MAX_LINE_PREFIX - 1)}- x`), null);
  assert.equal(parseWithinLimits(`${" ".repeat(MAX_LINE_PREFIX)}- x`), null);
  assert.notEqual(parseWithinLimits("*".repeat(MAX_BLOCK_EMPHASIS)), null);
  assert.equal(parseWithinLimits("*".repeat(MAX_BLOCK_EMPHASIS + 1)), null);
});

test("a host with a small call stack still renders a bounded document", () => {
  const script = `
    import { renderDocumentToStaticHtml } from "./dist/static.js";
    let body = "";
    for (let level = 0; level < 255; level++) body += "  ".repeat(level) + "- a\\n";
    const { bounded, html } = renderDocumentToStaticHtml({ id: "notes/a", body });
    console.log(JSON.stringify({ bounded, fallback: html.includes("${FALLBACK}") }));
  `;
  const result = spawnSync(process.execPath, ["--stack-size=70", "--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bounded: true, fallback: true });
});

test("only an exhausted call stack counts as a parse limit", () => {
  assert.equal(isCallStackExhausted(new RangeError("Maximum call stack size exceeded")), true);
  const internal = new Error("too much recursion");
  internal.name = "InternalError";
  assert.equal(isCallStackExhausted(internal), true);
  assert.equal(isCallStackExhausted(new RangeError("Invalid array length")), false);
  assert.equal(isCallStackExhausted(new TypeError("call stack")), false);
  assert.equal(isCallStackExhausted("Maximum call stack size exceeded"), false);
});

/** A long working document: sections of prose, links, quotes, lists, tables, code and footnotes. */
function realisticDocument(targetLength) {
  const sections = [];
  let length = 0;
  for (let i = 0; length < targetLength; i++) {
    const section = [
      `## Section ${i}: review of *item ${i}* and [its design](../designs/d${i}.md)`,
      "",
      `The change in [task ${i}](../tasks/t${i}.md) follows [the plan](../plans/p${i}.md) and **keeps** the _existing_ `,
      `behavior of snake_case_names, see [the docs](https://example.com/docs/${i}#part) and ~~the old note~~[^n${i}]. `,
      `A stray ] or [ can appear, 2 * 3 * 4 = 24, and a path like a_b_c.md stays literal! ![figure](/assets/f${i}.png)`,
      "",
      `> Reviewer note on [item ${i}](../reviews/r${i}.md): the *first* pass found **no** defect.`,
      ">",
      "> - quoted detail",
      "> - another [quoted link](../notes/n.md)",
      "",
      `1. Step one of ${i}`,
      "   - nested [detail](../notes/a.md)",
      "     - deeper *detail*",
      "2. Step two",
      "",
      "- [x] done item",
      "- [ ] open item with `inline_code` and [a link](../notes/b.md)",
      "",
      "| Name | Status | Link |",
      "| --- | :--: | ---: |",
      `| alpha_${i} | *open* | [a](../a.md) |`,
      `| beta_${i} | **shut** | [b](../b.md) |`,
      "",
      "```ts",
      `const value_${i} = items[${i}] * 2 | 0; // [not] a *link*`,
      "```",
      "",
      `[^n${i}]: Footnote text for section ${i}.`,
      "",
      `[related](../notes/r${i}.md)`,
      "",
      `[blocked by](../tasks/b${i}.md)`,
      "",
    ].join("\n");
    sections.push(section);
    length += section.length;
  }
  return sections.join("\n").slice(0, targetLength);
}

const ordinaryLarge = {
  "a long working document": realisticDocument(MAX_BODY_CHARS),
  "a long sequence of link paragraphs": fill("[relates to](../notes/document-name.md)\n\n"),
  "many quotes": fill("> A short quoted paragraph with a [link](../notes/x.md).\n\n"),
  "a long quote of many paragraphs": fill(`${"> A quoted line with a [link](../notes/x.md) and *emphasis* in it\n".repeat(8)}\n`),
  "a long list of loose items": fill("- [Document title here](../notes/document-name.md) with a short note\n\n"),
  "a table of two thousand rows": "| a | b | c | d | e |\n|---|---|---|---|---|\n"
    + "| lorem ipsum dolor | sit amet consectetur | adipiscing elit | sed do | eiusmod tempor |\n".repeat(2_000),
  "many small tables": fill(`| a | b |\n|---|---|\n| one [x](../x.md) | two |\n| three | *four* |\n\n${"Some prose between the tables. ".repeat(12)}\n\n`),
  "a list nested as deep as the walk renders": Array.from({ length: 40 }, (_, depth) => `${"  ".repeat(depth)}- level ${depth}`).join("\n"),
  "a long plain paragraph": fill("A plain wrapped line of prose, with a comma and a [link](../x.md).\n", 66_000),
  "a paragraph of non-Latin text": fill("\u8FD9\u662F\u4E00\u6BB5\u5F88\u957F\u7684\u6587\u5B57\u3002"),
};

for (const [name, body] of Object.entries(ordinaryLarge)) {
  test(`${name} parses to the same tree as the unguarded parser`, () => {
    const tree = parseWithinLimits(body);
    assert.notEqual(tree, null);
    assert.deepEqual(tree, unguardedTree(body));
    assert.ok(!renderDocumentToStaticHtml({ id: "notes/a", body }).html.includes(FALLBACK));
  });
}

test("a long working document under the node bound renders unbounded and unchanged", () => {
  const body = realisticDocument(120_000);
  const { interactive, rendered, interactiveMs } = timedRender(body);
  assert.equal(interactive.bounded, false);
  assert.equal(rendered.bounded, false);
  assert.ok(interactiveMs < RENDER_LIMIT_MS);
  const { document } = new JSDOM(rendered.html).window;
  assert.equal(document.querySelector(".doc-markdown-fallback.doc-code"), null);
  assert.ok(document.querySelectorAll("blockquote").length > 100);
  assert.ok(document.querySelectorAll("table").length > 100);
  assert.ok(document.querySelectorAll("[data-aslite-doc-id]").length > 1_000);
});

test("an error from the parser that is not a resource limit still surfaces", () => {
  assert.throws(() => parseWithinLimits({ length: 0 }), TypeError);
});
