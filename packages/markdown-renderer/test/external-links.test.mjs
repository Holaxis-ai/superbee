/**
 * The opt-in external-link allowlist, both profiles. THE INVARIANT still holds with the option on:
 * the one href the allowlist emits is `new URL(raw).href`, the canonical serialization, and every
 * refused form stays the inert span that the no-option render produces byte for byte.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { admitExternalLink, renderMarkdown } from "../dist/index.js";
import { renderDocumentToStaticHtml, renderMarkdownToStaticHtml } from "../dist/static.js";

const HOSTS = ["example.com", "Docs.Example.org"];

function interactive(body, externalLinkHosts) {
  const html = renderToStaticMarkup(
    renderMarkdown(body, { fromId: "tasks/alpha", onNavigateDoc() {}, externalLinkHosts }).element,
  );
  return { html, document: new JSDOM(html).window.document };
}

function inert(body, externalLinkHosts) {
  const { html } = renderMarkdownToStaticHtml(body, { fromId: "tasks/alpha", externalLinkHosts });
  return { html, document: new JSDOM(html).window.document };
}

const PROFILES = [
  ["interactive", interactive],
  ["inert", inert],
];

/**
 * Each refusal row: a raw markdown target that must stay inert even with the allowlist on. The
 * allowlist names `example.com`, so every row is a near miss of that host.
 */
const REFUSED = [
  ["host not listed", "https://other.example/x"],
  ["subdomain of a listed host", "https://www.example.com/x"],
  ["listed host as a suffix", "https://notexample.com/x"],
  ["http scheme", "http://example.com/x"],
  ["userinfo", "https://user@example.com/x"],
  ["userinfo with password", "https://user:pw@example.com/x"],
  ["userinfo forged to look like the host", "https://example.com@other.example/x"],
  ["non-default port", "https://example.com:8443/x"],
  ["IPv4 literal", "https://93.184.216.34/x"],
  ["IPv4 literal in an alternate form", "https://0x5db8d822/x"],
  ["IPv6 literal", "https://[2606:2800:220:1:248:1893:25c8:1946]/x"],
  ["Cyrillic homoglyph host", "https://exаmple.com/x"],
  ["relative target", "docs/x"],
  ["scheme-less target", "//example.com/x"],
  ["scheme-less host", "example.com/x"],
  ["fragment only", "#section"],
  ["javascript scheme", "javascript:alert(1)"],
  ["data scheme", "data:text/html;base64,PHNjcmlwdD4="],
  ["unparsable string", "https://exa%20mple.com/x"],
  ["https with no host", "https://"],
];

for (const [name, render] of PROFILES) {
  test(`${name}: an allowlisted https host renders exactly the external anchor`, () => {
    const { document } = render("See [the spec](https://example.com/spec?v=2#top).", HOSTS);
    const anchors = [...document.querySelectorAll("a")];
    assert.equal(anchors.length, 1);
    const anchor = anchors[0];
    assert.equal(anchor.textContent, "the spec");
    assert.deepEqual(
      [...anchor.attributes].map((attribute) => [attribute.name, attribute.value]).sort(),
      [
        ["class", "doc-link-external"],
        ["href", "https://example.com/spec?v=2#top"],
        ["rel", "noopener noreferrer"],
        ["target", "_blank"],
      ],
    );
    assert.equal(document.querySelector(".doc-link-inert"), null);
  });

  test(`${name}: the href is the canonical serialization, never the raw string`, () => {
    const raw = "https://EXAMPLE.com:443/Path/../spec#Frag";
    const { html, document } = render(`[spec](${raw})`, HOSTS);
    const anchor = document.querySelector("a.doc-link-external");
    assert.ok(anchor);
    assert.equal(anchor.getAttribute("href"), new URL(raw).href);
    assert.equal(anchor.getAttribute("href"), "https://example.com/spec#Frag");
    assert.doesNotMatch(html, /EXAMPLE\.com:443/);
  });

  test(`${name}: allowlist entries match case-insensitively after URL normalization`, () => {
    const { document } = render("[d](https://DOCS.example.ORG/a)", HOSTS);
    assert.equal(document.querySelector("a.doc-link-external")?.getAttribute("href"), "https://docs.example.org/a");
  });

  test(`${name}: every refused target stays the inert span, byte for byte as without the option`, () => {
    for (const [label, raw] of REFUSED) {
      const body = `[t](${raw})`;
      const withList = render(body, HOSTS);
      const without = render(body, undefined);
      assert.equal(withList.html, without.html, `${label}: ${raw}`);
      assert.equal(withList.document.querySelector("a"), null, `${label}: ${raw}`);
      const span = withList.document.querySelector("span.doc-link-inert");
      assert.ok(span, `${label}: ${raw} renders the inert span`);
      assert.equal(span.textContent, "t");
    }
  });

  test(`${name}: an empty list equals no option, and an undefined list keeps today's render`, () => {
    const body = "[spec](https://example.com/spec) and [doc](../docs/a.md)";
    const none = render(body, undefined);
    assert.equal(render(body, []).html, none.html);
    assert.equal(none.document.querySelector("a.doc-link-external"), null);
    assert.ok(none.document.querySelector("span.doc-link-inert"));
  });

  test(`${name}: a malformed allowlist entry admits nothing`, () => {
    for (const entry of ["https://example.com", "example.com/", "example.com:443", "user@example.com", "93.184.216.34", "[::1]", "", "exa mple.com"]) {
      const { document } = render("[t](https://example.com/x)", [entry]);
      assert.equal(document.querySelector("a"), null, `entry ${JSON.stringify(entry)}`);
    }
  });

  test(`${name}: the resolver is consulted first, so a concept link is never routed externally`, () => {
    const { document } = render("[doc](../docs/a.md) [ext](https://example.com/a.md)", HOSTS);
    assert.equal(document.querySelectorAll("a.doc-link-external").length, 1);
    assert.equal(document.querySelector("a.doc-link-external")?.getAttribute("href"), "https://example.com/a.md");
    const concept = name === "inert"
      ? document.querySelector("[data-aslite-doc-id]")
      : document.querySelector("a:not(.doc-link-external)");
    assert.ok(concept);
    assert.equal(concept.textContent, "doc");
  });
}

test("the interactive external anchor has no click handler: the browser navigates it natively", () => {
  function anchors(node) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(anchors);
    return [...(node.type === "a" ? [node] : []), ...anchors(node.props?.children)];
  }
  const { element } = renderMarkdown("[s](https://example.com/s)", { fromId: "tasks/a", onNavigateDoc() { throw new Error("must not run"); }, externalLinkHosts: HOSTS });
  const [anchor] = anchors(element);
  assert.equal(anchor.props.onClick, undefined);
  assert.equal(anchor.props.href, "https://example.com/s");
});

test("the inert profile keeps the span's title attribute unchanged with the option on", () => {
  const withList = inert("[t](https://other.example/x)", HOSTS);
  assert.equal(withList.document.querySelector("span.doc-link-inert")?.getAttribute("title"), null);
  const shell = interactive("[t](https://other.example/x)", HOSTS);
  assert.equal(shell.document.querySelector("span.doc-link-inert")?.getAttribute("title"), "external or unresolved target");
});

test("the document adapter forwards the allowlist and stays inert without it", () => {
  const document = { id: "docs/one", body: "[s](https://example.com/s)" };
  assert.doesNotMatch(renderDocumentToStaticHtml(document).html, /<a /);
  assert.match(renderDocumentToStaticHtml(document, { externalLinkHosts: HOSTS }).html, /<a href="https:\/\/example\.com\/s" rel="noopener noreferrer" target="_blank" class="doc-link-external">s<\/a>/);
});

test("admitExternalLink returns url.href for an admitted target and null for every refusal", () => {
  assert.equal(admitExternalLink("https://Example.COM:443/a/../b?q#f", HOSTS), "https://example.com/b?q#f");
  assert.equal(admitExternalLink("https://example.com/x", []), null);
  assert.equal(admitExternalLink("https://example.com/x", undefined), null);
  for (const [label, raw] of REFUSED) {
    assert.equal(admitExternalLink(raw, HOSTS), null, `${label}: ${raw}`);
  }
});
