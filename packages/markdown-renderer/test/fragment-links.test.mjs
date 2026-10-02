/**
 * Same-page fragment links, both profiles. A fragment-only target stays an inert span with no href;
 * when its decoded fragment has the strict anchor-id shape, the span names it in
 * `data-aslite-fragment` so a documentation adapter can link it to a heading anchor. Every other
 * form carries no attribute, so THE INVARIANT holds: no raw target reaches a DOM attribute.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { admitFragment, renderMarkdown } from "../dist/index.js";
import { renderMarkdownToStaticHtml } from "../dist/static.js";

function interactive(body) {
  const html = renderToStaticMarkup(renderMarkdown(body, { fromId: "tasks/alpha", onNavigateDoc() {} }).element);
  return new JSDOM(html).window.document;
}

function inert(body) {
  return new JSDOM(renderMarkdownToStaticHtml(body, { fromId: "tasks/alpha" }).html).window.document;
}

const PROFILES = [
  ["interactive", interactive],
  ["inert", inert],
];

const ADMITTED = [
  ["plain slug", "#executive-summary", "executive-summary"],
  ["roman-numeral section slug", "#ii-the-industry-and-the-firms", "ii-the-industry-and-the-firms"],
  ["underscores, dots and colons", "#a_b.c:d", "a_b.c:d"],
  ["percent-encoded safe characters", "#sec%2Dtion", "sec-tion"],
  ["slug of a heading that starts with a number", "#2026-outlook", "2026-outlook"],
  ["slug of a heading that starts with an underscore", "#_private-helpers", "_private-helpers"],
  ["slug that starts with a hyphen", "#-x", "-x"],
  ["short fragment written fully percent-encoded", `#${"%61".repeat(70)}`, "a".repeat(70)],
];

const REFUSED = [
  ["empty fragment", "#"],
  ["leading dot", "#.x"],
  ["leading colon", "#:x"],
  ["space", "#a b"],
  ["encoded space", "#a%20b"],
  ["double quote", '#a"b'],
  ["encoded double quote", "#a%22b"],
  ["single quote", "#a'b"],
  ["angle brackets", "#a<b>"],
  ["encoded angle bracket", "#a%3Cscript%3E"],
  ["parentheses", "#javascript:alert(1)"],
  ["second hash", "#a#b"],
  ["slash", "#a/b"],
  ["backslash", "#a\\b"],
  ["non-ASCII letter", "#café"],
  ["encoded bidi override", "#a%E2%80%AEb"],
  ["malformed percent encoding", "#a%E0%A4%A"],
  ["over the length limit", `#a${"b".repeat(200)}`],
  ["encoded form over the raw bound", `#${"%61".repeat(201)}`],
  ["fragment after a path", "notes/x.md#section"],
  ["fragment after a relative path", "x#section"],
  ["query then fragment", "?view=doc#section"],
  ["external URL with fragment", "https://example.com/#section"],
];

test("admitFragment returns the decoded fragment only for the strict anchor shape", () => {
  for (const [label, raw, expected] of ADMITTED) assert.equal(admitFragment(raw), expected, label);
  for (const [label, raw] of REFUSED) assert.equal(admitFragment(raw), null, label);
  assert.equal(admitFragment(`#a${"b".repeat(199)}`), `a${"b".repeat(199)}`, "exactly at the length limit");
  assert.equal(admitFragment(undefined), null);
});

for (const [profile, render] of PROFILES) {
  test(`${profile}: an admitted fragment is an inert span naming it, with no href anywhere`, () => {
    for (const [label, raw, expected] of ADMITTED) {
      const document = render(`See [the section](${raw}).`);
      assert.equal(document.querySelectorAll("a").length, 0, label);
      const span = document.querySelector("span.doc-link-inert");
      assert.ok(span, label);
      assert.equal(span.getAttribute("data-aslite-fragment"), expected, label);
      assert.equal(span.textContent, "the section", label);
      assert.equal(span.hasAttribute("href"), false, label);
    }
  });

  test(`${profile}: every refused target renders with no fragment attribute`, () => {
    for (const [label, raw] of REFUSED) {
      const document = render(`See [the section](<${raw}>).`);
      assert.equal(document.querySelector("[data-aslite-fragment]"), null, label);
      for (const a of document.querySelectorAll("a")) {
        assert.doesNotMatch(a.getAttribute("href") ?? "", /#/, `${label}: no fragment href`);
      }
    }
  });

  test(`${profile}: a table of contents keeps one fragment per entry in order`, () => {
    const document = render("- [Summary](#summary)\n- [I. Company](#i-company)\n- [Other](https://example.com/)\n");
    assert.deepEqual([...document.querySelectorAll("[data-aslite-fragment]")].map((s) => s.getAttribute("data-aslite-fragment")),
      ["summary", "i-company"]);
  });
}
