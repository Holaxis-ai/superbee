/**
 * Cross-bundle links (`okf://<alias>/<path>.md`) have no renderer route yet. Until one exists they
 * must render exactly like any other unresolvable target: an inert span, with the raw `okf:` href
 * in no attribute, in both profiles and with or without the external-link allowlist.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { renderMarkdown } from "../dist/index.js";
import { renderMarkdownToStaticHtml } from "../dist/static.js";
import { parseQualifiedLinks } from "@superbee/core/qualified-links";

function interactive(body, externalLinkHosts) {
  return renderToStaticMarkup(
    renderMarkdown(body, { fromId: "menus/tap-1", onNavigateDoc() {}, externalLinkHosts }).element,
  );
}

function inert(body, externalLinkHosts) {
  return renderMarkdownToStaticHtml(body, { fromId: "menus/tap-1", externalLinkHosts }).html;
}

const BODIES = [
  "[x](okf://beers/beers/y.md)",
  "[pours](okf://beers/beers/little-whale-boat.md#notes)",
  "[bad](okf://Beers/../y.md)",
  "[upper](OKF://beers/y.md)",
  "[n](okf:beers/y.md)",
  "[n](OKF:beers/z.md)",
];

for (const [profile, render] of [["interactive", interactive], ["inert", inert]]) {
  for (const hosts of [undefined, ["beers", "example.com"]]) {
    for (const body of [...BODIES, ...BODIES.map((b) => `see ${b} here`)]) {
      test(`${profile}${hosts ? " with an allowlist" : ""}: ${body} renders inert with no okf: attribute`, () => {
        const html = render(body, hosts);
        const document = new JSDOM(html).window.document;
        assert.equal(document.querySelectorAll("a").length, 0, html);
        const spans = document.querySelectorAll("span.doc-link-inert");
        assert.equal(spans.length, 1, html);
        assert.equal(spans[0].textContent, body.slice(body.indexOf("[") + 1, body.indexOf("]")));
        for (const element of document.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            assert.equal(/okf:/i.test(attribute.value), false, `${attribute.name}="${attribute.value}" in ${html}`);
          }
        }
      });
    }
  }
}

/** The same link written as code: it renders as code, never as a link, and core counts no edge. */
const CODE_BODIES = [
  "see `[x](okf://beers/beers/span.md)` here",
  "```\n[x](okf://beers/beers/fenced.md)\n```",
  "~~~\n[x](okf://beers/beers/tilde.md)\n~~~",
  "para\n\n    [x](okf://beers/beers/indent.md)",
];

for (const [profile, render] of [["interactive", interactive], ["inert", inert]]) {
  for (const hosts of [undefined, ["beers", "example.com"]]) {
    for (const body of CODE_BODIES) {
      test(`${profile}${hosts ? " with an allowlist" : ""}: ${JSON.stringify(body)} stays code with no okf: attribute, as core parses it`, () => {
        const html = render(body, hosts);
        const document = new JSDOM(html).window.document;
        assert.equal(document.querySelectorAll("a, span.doc-link-inert").length, 0, html);
        const code = document.querySelector("code");
        assert.ok(code && code.textContent.includes("](okf://beers/"), html);
        for (const element of document.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            assert.equal(/okf:/i.test(attribute.value), false, `${attribute.name}="${attribute.value}" in ${html}`);
          }
        }
        assert.deepEqual(parseQualifiedLinks({ id: "menus/tap-1", frontmatter: {}, body }), []);
      });
    }
  }
}
