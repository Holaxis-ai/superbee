import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../dist/index.js";

import {
  renderDocumentToStaticHtml,
  renderMarkdownToStaticHtml,
} from "../dist/static.js";

function parsed(markdown, options = {}) {
  const rendered = renderMarkdownToStaticHtml(markdown, {
    fromId: "tasks/alpha",
    ...options,
  });
  return { rendered, document: new JSDOM(rendered.html).window.document };
}

test("the inert profile constructs only passive markup and normalized concept-id markers", () => {
  const { document } = parsed([
    "# Heading",
    "",
    "[internal](../designs/x.md) [missing](../tasks/missing.md) [scheme-shaped](javascript:alert(1).md) [external](https://example.invalid/x)",
    "",
    "- [x] done",
    "- [ ] open",
    "",
    "![remote](https://example.invalid/image.png)",
    "![local](/assets/screens/model.svg)",
    "",
    "<script>globalThis.pwned=true</script>",
  ].join("\n"));

  assert.ok(document.querySelector("[data-aslite-rendered-document]"));
  assert.equal(document.querySelector("a,input,form,button,img,script,style,iframe,object,embed"), null);
  assert.deepEqual(
    [...document.querySelectorAll("[data-aslite-doc-id]")].map((node) => node.getAttribute("data-aslite-doc-id")),
    ["designs/x", "tasks/missing", "tasks/javascript:alert(1)"],
  );
  assert.equal(document.querySelectorAll(".doc-task-marker").length, 2);
  assert.match(document.body.textContent ?? "", /<script>globalThis\.pwned=true<\/script>/);

  const root = document.querySelector("[data-aslite-rendered-document]");
  assert.ok(root);
  assert.doesNotMatch(root.outerHTML, /https:\/\/example\.invalid/);
  const allowedTags = new Set([
    "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
  ]);
  for (const element of [root, ...root.querySelectorAll("*")]) {
    assert.ok(allowedTags.has(element.tagName.toLowerCase()), `${element.tagName.toLowerCase()} is outside the inert tag allowlist`);
    for (const attribute of element.attributes) {
      assert.ok(
        attribute.name === "class" ||
          attribute.name === "start" ||
          attribute.name === "aria-hidden" ||
          attribute.name.startsWith("data-aslite-"),
        `${element.tagName.toLowerCase()}[${attribute.name}] is outside the inert attribute allowlist`,
      );
    }
  }
});

test("bare relationship rows use the same inert normalized-id contract", () => {
  const { document } = parsed("[contains](../tasks/one.md)\n\n[depends on](../tasks/two.md)", {
    fromId: "roadmap-items/alpha",
    titleFor: (id) => id === "tasks/one" ? "One" : undefined,
  });
  const rows = [...document.querySelectorAll(".doc-edge-row")];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute("data-aslite-doc-id"), "tasks/one");
  assert.equal(rows[0].querySelector(".doc-edge-target")?.textContent, "One");
  assert.equal(rows[1].getAttribute("data-aslite-doc-id"), "tasks/two");
  assert.equal(rows[1].querySelector(".doc-edge-target")?.textContent, "tasks/two");
  assert.equal(document.querySelector("a"), null);
});

test("static rendering reports the shared bounds it enforces", () => {
  const { rendered, document } = parsed("one two three four", {
    limits: { maxBodyChars: 7, maxNodes: 10 },
  });
  assert.equal(rendered.bounded, true);
  assert.deepEqual(rendered.limits, { maxBodyChars: 7, maxNodes: 10 });
  assert.equal(document.querySelector("[data-aslite-rendered-document]")?.textContent, "one two");
});

test("the document adapter preserves only the bridge's presentation contract", () => {
  const rendered = renderDocumentToStaticHtml({
    id: "docs/one",
    body: "# One",
  });
  assert.deepEqual(Object.keys(rendered).sort(), ["bounded", "html"]);
  assert.match(rendered.html, /data-aslite-rendered-document/);
  assert.match(rendered.html, /<h1>One<\/h1>/);
  assert.equal(rendered.bounded, false);
});

test("deep nesting collapses at the shared depth limit without introducing active markup", () => {
  const { rendered, document } = parsed(`${"> ".repeat(45)}deep`);
  assert.equal(rendered.bounded, true, "depth collapse is disclosed as a bounded render");
  assert.equal(document.querySelectorAll("blockquote").length, 40);
  assert.equal(document.querySelector("[data-aslite-rendered-document]")?.textContent, "deep");
  assert.equal(document.querySelector("a,input,form,button,img,script,style,iframe,object,embed"), null);
});


test("a static presentation can select only its explicitly admitted local image assets", () => {
  const png = "/assets/screens/example.png", svg = "/assets/screens/model.svg";
  const { document } = parsed(`![A screenshot](${png})\n\n![A diagram](${svg})\n\n![Not admitted](/assets/screens/other.png)`, {
    imageAssets: [png, svg],
  });
  assert.deepEqual([...document.querySelectorAll("img")].map(image => ({
    src: image.getAttribute("src"), alt: image.getAttribute("alt"),
    loading: image.getAttribute("loading"), referrer: image.getAttribute("referrerpolicy"),
  })), [
    { src: png, alt: "A screenshot", loading: "lazy", referrer: "no-referrer" },
    { src: svg, alt: "A diagram", loading: "lazy", referrer: "no-referrer" },
  ]);
  assert.match(document.body.textContent, /\[image: Not admitted\]/);
  assert.equal(document.querySelector("svg,object,embed,iframe,script"), null);
});

test("static image admission refuses noncanonical and nonasset URL inventories", () => {
  const rejected = [
    "https://example.invalid/image.png", "//example.invalid/image.svg", "data:image/png;base64,AA==",
    "blob:https://example.invalid/image", "/api/private.png", "/assets/../private.png",
    "/assets/screens/./model.svg", "/assets/screens//model.svg", "/assets/screens/%2e%2e/model.png",
    "/assets/screens/model.png?token=private", "/assets/screens/model.svg#fragment",
    "/assets/screens/model.png\n", "/assets/screens/model.png\r", "/assets/screens/model.png\u2028",
    "/assets/screens/model.png\u0000", "/assets/screens/model image.png", "/assets/screens/model.html",
    "/assets/screens\\model.png", "/assets/" + "a".repeat(2048) + ".png",
  ];
  for (const path of rejected) {
    assert.throws(() => parsed("![image](/assets/image.png)", { imageAssets: [path] }), TypeError, path);
  }
  for (const imageAssets of [null, {}, "image.png", [42], Array(4097).fill("/assets/image.png")]) {
    assert.throws(() => parsed("![image](/assets/image.png)", { imageAssets }), TypeError);
  }
});

test("unlisted or hostile Markdown image targets remain inert with an admitted lookup", () => {
  const targets = ["https://example.invalid/image.png", "//example.invalid/image.png", "data:image/png;base64,AA==",
    "javascript:alert(1)", "/assets/screens/unknown.png", "/assets/screens/../model.png",
    "/assets/screens/model.png?token=private", "/assets/screens/model.png#fragment", "/assets/screens/%6dodel.png"];
  for (const target of targets) {
    const { document } = parsed(`![image](${target})`, { imageAssets: ["/assets/screens/model.png"] });
    assert.equal(document.querySelector("img,svg,object,embed,iframe,script"), null, target);
  }
});

test("static image alt text is escaped by React, never interpreted as markup", () => {
  const alt = '<svg onload="alert(1)">&';
  const { document } = parsed(`![${alt}](/assets/screens/model.svg)`, { imageAssets: ["/assets/screens/model.svg"] });
  const image = document.querySelector("img");
  assert.equal(image.getAttribute("alt"), alt);
  assert.equal(image.getAttribute("onload"), null);
  assert.equal(document.querySelector("svg,script"), null);
});

test("interactive rendering and the bridge document adapter do not gain image loading", () => {
  const body = "![image](/assets/screens/model.svg)", imageAssets = ["/assets/screens/model.svg"];
  for (const profile of [undefined, "interactive"]) {
    const rendered = renderMarkdown(body, { fromId: "slides/example", onNavigateDoc: () => {}, profile, imageAssets });
    assert.equal(new JSDOM(renderToStaticMarkup(rendered.element)).window.document.querySelector("img"), null);
  }
  const rendered = renderDocumentToStaticHtml({ id: "slides/example", body }, { imageAssets });
  assert.equal(new JSDOM(rendered.html).window.document.querySelector("img"), null);
});

test("static image opt-in retains body, node and depth bounds", () => {
  const body = "![image](/assets/screens/model.svg)";
  const options = { imageAssets: ["/assets/screens/model.svg"] };
  for (const limits of [{ maxBodyChars: 8 }, { maxNodes: 1 }]) {
    const { rendered, document } = parsed(body, { ...options, limits });
    assert.equal(rendered.bounded, true);
    assert.equal(document.querySelector("img"), null);
  }
  const { rendered, document } = parsed(`${"> ".repeat(45)}${body}`, options);
  assert.equal(rendered.bounded, true);
  assert.equal(document.querySelector("img"), null);
});
