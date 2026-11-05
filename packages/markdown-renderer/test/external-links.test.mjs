/**
 * The external link policy, both profiles. THE INVARIANT holds under every policy: the one href the
 * policy emits is `new URL(raw).href`, the canonical serialization, and every refused form stays
 * the inert span that the no-option render produces byte for byte.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { admitExternalLink, renderMarkdown } from "../dist/index.js";
import { renderDocumentToStaticHtml, renderMarkdownToStaticHtml } from "../dist/static.js";

const HOSTS = { hosts: ["example.com", "Docs.Example.org"] };

function interactive(body, externalLinks) {
  const html = renderToStaticMarkup(
    renderMarkdown(body, { fromId: "tasks/alpha", onNavigateDoc() {}, externalLinks }).element,
  );
  return { html, document: new JSDOM(html).window.document };
}

function inert(body, externalLinks) {
  const { html } = renderMarkdownToStaticHtml(body, { fromId: "tasks/alpha", externalLinks });
  return { html, document: new JSDOM(html).window.document };
}

const PROFILES = [
  ["interactive", interactive],
  ["inert", inert],
];

const ADMITTING = [["https", "https"], ["{ hosts }", HOSTS]];

/**
 * Each refusal row: a raw markdown target that `{ hosts }` must keep inert. The list names
 * `example.com`, so every row is a near miss of that host.
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

/** Targets outside `https:` or carrying userinfo: no policy may admit these, on any host. */
const NEVER_ADMITTED = [
  "http://example.com/x",
  `HTTP:${""}//example.com/upper`,
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "<java\tscript:alert(1)>",
  "< javascript:alert(1)>",
  "data:text/html;base64,PHNjcmlwdD4=",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "ftp://example.com/x",
  "mailto:a@example.com",
  "tel:+15551234",
  "blob:https://example.com/x",
  "ws://example.com/x",
  "wss://example.com/x",
  "okf://example.com/x.md",
  "//example.com/x",
  "example.com/x",
  "https://user@example.com/x",
  "https://user:pw@example.com/x",
  "https://:pw@example.com/x",
  "https://example.com@other.example/x",
  `HTTPS:${""}//user@example.com/upper`,
  "https://",
  "https://exa%%20mple.com/x",
].map((raw) => raw.replace("%%", "%"));

const UNKNOWN_POLICIES = [
  null, "", "HTTPS", "Https", " https", "all", "http", "hosts", "example.com", true, false, 0, 1,
  [], ["example.com"], ["https"], {}, { hosts: null }, { hosts: "example.com" }, { hosts: {} },
  { host: ["example.com"] }, { hosts: [] }, new String("https"),
];

for (const [name, render] of PROFILES) {
  for (const [label, policy] of ADMITTING) {
    test(`${name} ${label}: an admitted target renders exactly the external anchor`, () => {
      const { document } = render("See [the spec](https://example.com/spec?v=2#top).", policy);
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

    test(`${name} ${label}: the href is the canonical serialization, never the raw string`, () => {
      for (const [raw, canonical] of [
        ["https://EXAMPLE.com:443/Path/../spec#Frag", "https://example.com/spec#Frag"],
        [`HTTPS:${""}//example.com/upper-scheme`, "https://example.com/upper-scheme"],
        ["<  https://example.com/leading-space>", "https://example.com/leading-space"],
        ["<https://example.com/in side>", "https://example.com/in%20side"],
        ["https://example.com/quote\"><script>alert(1)</script>", "https://example.com/quote%22%3E%3Cscript%3Ealert(1)%3C/script%3E"],
      ]) {
        const { html, document } = render(`[spec](${raw})`, policy);
        assert.equal(document.querySelector("a.doc-link-external")?.getAttribute("href"), canonical, raw);
        assert.equal(document.querySelector("script"), null, raw);
        assert.doesNotMatch(html, /EXAMPLE\.com:443|HTTPS:|<script/, raw);
      }
    });
  }

  test(`${name} https: any host and port is admitted, in canonical form`, () => {
    for (const [raw, canonical] of [
      ["https://other.example/x", "https://other.example/x"],
      ["https://www.example.com/x", "https://www.example.com/x"],
      ["https://example.com:8443/x", "https://example.com:8443/x"],
      ["https://93.184.216.34/x", "https://93.184.216.34/x"],
      ["https://0x5db8d822/x", "https://93.184.216.34/x"],
      ["https://[2606:2800:220:1:248:1893:25c8:1946]/x", "https://[2606:2800:220:1:248:1893:25c8:1946]/x"],
      ["https://exаmple.com/x", "https://xn--exmple-4nf.com/x"],
      ["https://example.com/a.md", "https://example.com/a.md"],
      [`HTTPS:${""}//example.com/a.md`, "https://example.com/a.md"],
      ["https:example.com/x", "https://example.com/x"],
      ["https:/example.com/x", "https://example.com/x"],
      ["https:\\\\example.com\\x", "https://example.com/x"],
      ["<ht\ttps://example.com/x>", "https://example.com/x"],
    ]) {
      const { document } = render(`[t](${raw})`, "https");
      assert.equal(document.querySelector("a.doc-link-external")?.getAttribute("href"), canonical, raw);
    }
  });

  test(`${name}: a target no policy may admit stays the inert span, byte for byte`, () => {
    for (const raw of NEVER_ADMITTED) {
      const body = `[t](${raw})`;
      const without = render(body, undefined);
      assert.equal(without.document.querySelector("a[target]"), null, raw);
      for (const policy of ["none", "https", HOSTS]) {
        const rendered = render(body, policy);
        assert.equal(rendered.html, without.html, `${JSON.stringify(policy)}: ${raw}`);
      }
    }
  });

  test(`${name}: an unknown policy means none, and the retired option name does nothing`, () => {
    const body = "[s](https://example.com/s)";
    const blocked = render(body, undefined).html;
    assert.equal(render(body, "none").html, blocked);
    for (const unknown of UNKNOWN_POLICIES) {
      assert.equal(render(body, unknown).html, blocked, String(JSON.stringify(unknown)));
    }
    const retired = name === "inert"
      ? renderMarkdownToStaticHtml(body, { fromId: "tasks/alpha", externalLinkHosts: ["example.com"] }).html
      : renderToStaticMarkup(renderMarkdown(body, { fromId: "tasks/alpha", onNavigateDoc() {}, externalLinkHosts: ["example.com"] }).element);
    assert.equal(retired, blocked);
  });

  test(`${name}: images, raw HTML and reference-style links are unaffected by every policy`, () => {
    const body = "![p](https://example.com/p.png) <a href=\"https://example.com/raw\">r</a> [t][ref]\n\n[ref]: https://example.com/ref\n";
    const blocked = render(body, undefined);
    for (const policy of ["https", HOSTS]) {
      const rendered = render(body, policy);
      assert.equal(rendered.html, blocked.html);
      assert.equal(rendered.document.querySelector("a, img"), null);
    }
  });

  test(`${name}: a bare https URL becomes an anchor under https, and a bare www URL parses as http and stays inert`, () => {
    const { document } = render("Go https://example.com/bare or www.example.com now.", "https");
    assert.deepEqual([...document.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["https://example.com/bare"]);
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

  test(`${name}: an empty host list equals no option, and no option keeps today's render`, () => {
    const body = "[spec](https://example.com/spec) and [doc](../docs/a.md)";
    const none = render(body, undefined);
    assert.equal(render(body, { hosts: [] }).html, none.html);
    assert.equal(none.document.querySelector("a.doc-link-external"), null);
    assert.ok(none.document.querySelector("span.doc-link-inert"));
  });

  test(`${name}: a malformed allowlist entry admits nothing`, () => {
    for (const entry of ["https://example.com", "example.com/", "example.com:443", "user@example.com", "93.184.216.34", "[::1]", "", "exa mple.com"]) {
      const { document } = render("[t](https://example.com/x)", { hosts: [entry] });
      assert.equal(document.querySelector("a"), null, `entry ${JSON.stringify(entry)}`);
    }
  });

  test(`${name}: a host list can't name an IP address, even for a link to that address`, () => {
    for (const entry of ["93.184.216.34", "127.0.0.1", "0x7f.1", "2130706433", "[::1]", "[::ffff:127.0.0.1]"]) {
      const { document } = render(`[t](https://${entry}/x)`, { hosts: [entry] });
      assert.equal(document.querySelector("a"), null, `entry ${JSON.stringify(entry)}`);
    }
  });

  for (const [label, policy] of ADMITTING) {
    test(`${name} ${label}: the resolver is consulted first, so a concept link is never routed externally`, () => {
      const { document } = render("[doc](../docs/a.md) [ext](https://example.com/a.md)", policy);
      assert.equal(document.querySelectorAll("a.doc-link-external").length, 1);
      assert.equal(document.querySelector("a.doc-link-external")?.getAttribute("href"), "https://example.com/a.md");
      const concept = name === "inert"
        ? document.querySelector("[data-aslite-doc-id]")
        : document.querySelector("a:not(.doc-link-external)");
      assert.ok(concept);
      assert.equal(concept.textContent, "doc");
    });
  }

  test(`${name} https: a slashless https spelling of a .md path stays a concept link`, () => {
    const { document } = render("[t](https:foo.md)", "https");
    assert.equal(document.querySelector("a.doc-link-external"), null);
    assert.equal(render("[t](https:foo.md)", "https").html, render("[t](https:foo.md)", undefined).html);
  });

  test(`${name} https: a same-origin relative or fragment target is untouched by the policy`, () => {
    for (const raw of ["docs/x", "#section", "/guide/x", "../a.txt"]) {
      assert.equal(render(`[t](${raw})`, "https").html, render(`[t](${raw})`, undefined).html, raw);
    }
  });
}

test("the interactive external anchor has no click handler: the browser navigates it natively", () => {
  function anchors(node) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(anchors);
    return [...(node.type === "a" ? [node] : []), ...anchors(node.props?.children)];
  }
  const { element } = renderMarkdown("[s](https://example.com/s)", { fromId: "tasks/a", onNavigateDoc() { throw new Error("must not run"); }, externalLinks: HOSTS });
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

test("the document adapter takes no options, so it can never carry a policy", () => {
  const document = { id: "docs/one", body: "[s](https://example.com/s)" };
  const blocked = renderDocumentToStaticHtml(document);
  assert.doesNotMatch(blocked.html, /<a /);
  assert.equal(renderDocumentToStaticHtml.length, 1);
  for (const stray of [{ externalLinks: "https" }, { externalLinkHosts: ["example.com"] }, "https"]) {
    assert.deepEqual(Reflect.apply(renderDocumentToStaticHtml, undefined, [document, stray]), blocked);
  }
});

test("admitExternalLink returns url.href for an admitted target and null for every refusal", () => {
  assert.equal(admitExternalLink("https://Example.COM:443/a/../b?q#f", HOSTS), "https://example.com/b?q#f");
  assert.equal(admitExternalLink("https://Example.COM:443/a/../b?q#f", "https"), "https://example.com/b?q#f");
  assert.equal(admitExternalLink("https://example.com/x", { hosts: [] }), null);
  assert.equal(admitExternalLink("https://example.com/x", undefined), null);
  assert.equal(admitExternalLink("https://example.com/x", "none"), null);
  assert.equal(admitExternalLink("https://example.com/x", ["example.com"]), null, "a bare list is the retired shape");
  for (const unknown of UNKNOWN_POLICIES) assert.equal(admitExternalLink("https://example.com/x", unknown), null);
  for (const [label, raw] of REFUSED) {
    assert.equal(admitExternalLink(raw, HOSTS), null, `${label}: ${raw}`);
  }
  for (const raw of NEVER_ADMITTED) {
    const target = raw.replace(/^<|>$/g, "");
    assert.equal(admitExternalLink(target, "https"), null, raw);
    assert.equal(admitExternalLink(target, HOSTS), null, raw);
  }
});

/**
 * Output captured from the last renderer before the option was named. Every existing caller passes
 * no policy, so these literals pin their bytes, including for the static document adapter that
 * every View's `render-document` goes through.
 */
const NO_POLICY_BODY = `# Title

See [spec](https://example.com/spec), [plain](http://example.com/), [script](javascript:alert(1)) and [peer](../docs/a.md).

[anchor](#some-heading) https://example.com/bare <b>raw</b> ![pic](https://example.com/p.png)

[edge](./b.md)
`;
const NO_POLICY_STATIC = "<div data-aslite-rendered-document=\"\"><h1>Title</h1><p>See <span class=\"doc-link-inert\">spec</span>, <span class=\"doc-link-inert\">plain</span>, <span class=\"doc-link-inert\">script</span> and <span class=\"doc-link-inert\" data-aslite-doc-id=\"docs/a\">peer</span>.</p><p><span class=\"doc-link-inert\" data-aslite-fragment=\"some-heading\">anchor</span> <span class=\"doc-link-inert\">https://example.com/bare</span> <span class=\"doc-raw-html\">&lt;b&gt;</span>raw<span class=\"doc-raw-html\">&lt;/b&gt;</span> <span class=\"doc-link-inert\">[image: pic]</span></p><div class=\"doc-edge-list\"><span class=\"doc-edge-row\" data-aslite-doc-id=\"tasks/b\"><span class=\"doc-edge-verb doc-markdown-fallback\">edge</span><span class=\"doc-edge-arrow\" aria-hidden=\"true\">→</span><span class=\"doc-edge-target\">tasks/b</span></span></div></div>";
const NO_POLICY_INTERACTIVE = "<h1>Title</h1><p>See <span class=\"doc-link-inert\" title=\"external or unresolved target\">spec</span>, <span class=\"doc-link-inert\" title=\"external or unresolved target\">plain</span>, <span class=\"doc-link-inert\" title=\"external or unresolved target\">script</span> and <a href=\"?view=doc&amp;id=docs%2Fa\">peer</a>.</p><p><span class=\"doc-link-inert\" data-aslite-fragment=\"some-heading\" title=\"external or unresolved target\">anchor</span> <span class=\"doc-link-inert\" title=\"external or unresolved target\">https://example.com/bare</span> <span class=\"doc-raw-html\">&lt;b&gt;</span>raw<span class=\"doc-raw-html\">&lt;/b&gt;</span> <span class=\"doc-link-inert\" title=\"images render in a later version\">[image: pic]</span></p><div class=\"doc-edge-list\"><a class=\"doc-edge-row\" href=\"?view=doc&amp;id=tasks%2Fb\"><span class=\"doc-edge-verb doc-markdown-fallback\">edge</span><span class=\"doc-edge-arrow\" aria-hidden=\"true\">→</span><span class=\"doc-edge-target\">tasks/b</span></a></div>";

test("every existing caller's output is byte-identical with no policy", () => {
  const options = { fromId: "tasks/alpha" };
  assert.equal(renderDocumentToStaticHtml({ id: "tasks/alpha", body: NO_POLICY_BODY }).html, NO_POLICY_STATIC);
  assert.equal(renderMarkdownToStaticHtml(NO_POLICY_BODY, options).html, NO_POLICY_STATIC);
  assert.equal(renderMarkdownToStaticHtml(NO_POLICY_BODY, { ...options, externalLinks: "none" }).html, NO_POLICY_STATIC);
  assert.equal(interactive(NO_POLICY_BODY, undefined).html, NO_POLICY_INTERACTIVE);
  assert.equal(interactive(NO_POLICY_BODY, "none").html, NO_POLICY_INTERACTIVE);
});

test("a link inside a link never yields nested anchors", () => {
  for (const md of ["[<https://a.example/>](https://b.example/)", "See [<https://a.example/>](other.md) now"]) {
    const { html } = renderMarkdownToStaticHtml(md, { fromId: "x", externalLinks: "https" });
    assert.ok((html.match(/<a[\s>]/g) ?? []).length <= 1, html);
    assert.doesNotMatch(html, /data-aslite-doc-id="[^"]*"><a /, html);
  }
});

test("a link with no words stays inert, and an image link keeps its anchor", () => {
  for (const md of ["[](https://example.com/a)", "[ ](https://example.com/b)"]) {
    const { html } = renderMarkdownToStaticHtml(md, { fromId: "x", externalLinks: "https" });
    assert.doesNotMatch(html, /<a[\s>]/, md);
  }
  const { html } = renderMarkdownToStaticHtml("[![alt](i.png)](https://example.com/c)", { fromId: "x", externalLinks: "https" });
  assert.match(html, /<a [^>]*href="https:\/\/example\.com\/c"/);
});
