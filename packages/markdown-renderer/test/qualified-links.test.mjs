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
