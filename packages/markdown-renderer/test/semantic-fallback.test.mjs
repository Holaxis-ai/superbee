import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { renderMarkdown, MAX_DEPTH } from "../dist/index.js";

function rendered(body, profile = "interactive", limits) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const result = renderMarkdown(body, { fromId: "docs/one", onNavigateDoc() {}, profile, limits });
    const html = renderToStaticMarkup(result.element);
    assert.deepEqual(errors, [], "actual React render has no key or construction warnings");
    return { ...result, document: new JSDOM(html).window.document };
  } finally {
    console.error = original;
  }
}

const cases = [
  { name: "footnote definition", body: "Prose[^note]\n\n[^note]: quoted `opaque[0]`", selector: ".doc-markdown-fallback", token: "opaque[0]" },
  { name: "nested reference link", body: "Prose [read **nested `opaque[1]`**][ref]\n\n[ref]: target.md", selector: ".doc-markdown-fallback", token: "opaque[1]" },
  { name: "flattened relationship verb", body: "[uses `opaque[2]`](target.md)", selector: ".doc-edge-verb.doc-markdown-fallback", token: "opaque[2]" },
];
for (const profile of ["interactive", "inert"]) {
  for (const row of cases) {
    test(`${profile}: ${row.name} retains a generic semantic opacity boundary`, () => {
      const { document, bounded } = rendered(row.body, profile);
      assert.equal(bounded, false);
      const opaque = [...document.querySelectorAll(row.selector)].find(node => node.textContent.includes(row.token));
      assert.ok(opaque, "flattened code is inside the owning renderer's marker");
      assert.equal(opaque.tagName, "SPAN");
      assert.equal(opaque.querySelector("code,a,input,button"), null);
      assert.ok(document.body.textContent.includes(row.token), "visible fallback text is preserved");
      if (row.name === "flattened relationship verb") {
        const edge = document.querySelector(".doc-edge-row");
        assert.equal(profile === "inert" ? edge.getAttribute("data-aslite-doc-id") : edge.getAttribute("href"),
          profile === "inert" ? "docs/target" : "?view=doc&id=docs%2Ftarget");
      }
    });
  }
}

test("normal prose and mapped code, quote and link semantics stay unchanged", () => {
  const { document } = rendered("Normal opaque[3], `opaque[4]` and [read](target.md).\n\n> quoted `opaque[5]`");
  assert.equal(document.querySelector(".doc-markdown-fallback"), null);
  assert.equal(document.querySelector("p").textContent, "Normal opaque[3], opaque[4] and read.");
  assert.deepEqual([...document.querySelectorAll("code")].map(node => node.textContent), ["opaque[4]", "opaque[5]"]);
  assert.equal(document.querySelector("blockquote").textContent, "quoted opaque[5]");
  assert.equal(document.querySelector("a").getAttribute("href"), "?view=doc&id=docs%2Ftarget");
});

test("depth degradation is marked opaque without weakening resource bounds", () => {
  const { document, bounded } = rendered(`${"> ".repeat(MAX_DEPTH + 5)}deep \`opaque[6]\``, "inert");
  assert.equal(bounded, true);
  assert.equal(document.querySelectorAll("blockquote").length, MAX_DEPTH);
  assert.equal(document.querySelector(".doc-markdown-fallback").textContent, "deep opaque[6]");
  assert.equal(document.querySelector("a,input,form,button,img,script,style,iframe"), null);
  const tightened = rendered("one **two** three", "inert", { maxBodyChars: 7, maxNodes: 2 });
  assert.equal(tightened.bounded, true);
  assert.deepEqual(tightened.limits, { maxBodyChars: 7, maxNodes: 2 });
});
