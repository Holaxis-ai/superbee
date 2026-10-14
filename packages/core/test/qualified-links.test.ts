import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { query, queryEdges } from "../src/bundle.js";
import { InvalidInputError } from "../src/errors.js";
import { isExternalHref, maskMarkdownCode, parseLinksFromDoc } from "../src/links.js";
import {
  isQualifiedHref,
  parseQualifiedHref,
  parseQualifiedKindTarget,
  parseQualifiedLinks,
  qualifiedHref,
  qualifiedLinkEdge,
} from "../src/qualified-links.js";
import type { OkfDocument } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The plan's grammar table, plus every refused form it lists. */
const VALID: Array<[string, { alias: string; id: string }, string | undefined]> = [
  ["okf://beers/beers/little-whale-boat.md", { alias: "beers", id: "beers/little-whale-boat" }, undefined],
  ["okf://listings/houses/12-elm-st.md", { alias: "listings", id: "houses/12-elm-st" }, undefined],
  ["okf://beers/x.md#tasting-notes", { alias: "beers", id: "x" }, "tasting-notes"],
  ["okf://a/x.md", { alias: "a", id: "x" }, undefined],
  [`okf://${"a".repeat(63)}/x.md`, { alias: "a".repeat(63), id: "x" }, undefined],
  ["okf://hm-beer-2/Deep/Path/Doc.md", { alias: "hm-beer-2", id: "Deep/Path/Doc" }, undefined],
];

const INVALID: Array<[string, string]> = [
  ["dot-dot segment", "okf://beers/../x.md"],
  ["nested dot-dot segment", "okf://beers/a/../x.md"],
  ["dot segment", "okf://beers/./x.md"],
  ["upper-case alias", "okf://Beers/x.md"],
  ["no .md target", "okf://beers/x"],
  ["non-.md target", "okf://beers/x.png"],
  ["leading slash in the path", "okf://beers//x.md"],
  ["empty alias with a leading slash", "okf:///x.md"],
  ["query", "okf://beers/x.md?v=1"],
  ["percent", "okf://beers/x%20y.md"],
  ["index.md", "okf://beers/index.md"],
  ["nested log.md", "okf://beers/beers/log.md"],
  ["upper-case INDEX.md", "okf://beers/INDEX.md"],
  ["mixed-case nested Log.md", "okf://beers/a/Log.md"],
  ["dot-prefixed directory", "okf://beers/.hidden/x.md"],
  ["dot-prefixed file", "okf://beers/a/.x.md"],
  ["no path", "okf://beers"],
  ["empty path", "okf://beers/"],
  ["alias starting with a digit", "okf://1beers/x.md"],
  ["alias too long", `okf://${"a".repeat(64)}/x.md`],
  ["alias with underscore", "okf://hm_beers/x.md"],
  ["upper-case scheme", "OKF://beers/x.md"],
  ["non-final .md segment", "okf://beers/a.md/b.md"],
  ["backslash", "okf://beers/a\\b.md"],
  ["empty segment", "okf://beers/a//b.md"],
];

for (const [href, ref, fragment] of VALID) {
  test(`grammar: ${href} parses to ${ref.alias} / ${ref.id}`, () => {
    assert.equal(isQualifiedHref(href), true);
    const parsed = parseQualifiedHref(href);
    assert.deepEqual(parsed, fragment === undefined ? { ok: true, ref } : { ok: true, ref, fragment });
    assert.equal(qualifiedHref(ref, fragment), href);
  });
}

for (const [name, href] of INVALID) {
  test(`grammar: ${name} (${href}) is invalid_ref`, () => {
    assert.equal(isQualifiedHref(href), true, "an okf: href is always recognized, so a malformed one is reported");
    const parsed = parseQualifiedHref(href);
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.detail.length > 0);
  });
}

test("grammar: other schemes and local hrefs are not qualified", () => {
  for (const href of ["https://example.com/x.md", "/beers/x.md", "../x.md", "x.md", "#frag", "mailto:a@b.c", "okfx://beers/x.md"]) {
    assert.equal(isQualifiedHref(href), false, href);
  }
});

test("qualifiedHref refuses a ref that would not parse back", () => {
  for (const ref of [
    { alias: "Beers", id: "x" },
    { alias: "beers", id: "../x" },
    { alias: "beers", id: "index" },
    { alias: "beers", id: "a?b" },
    { alias: "beers", id: "" },
  ]) {
    assert.throws(() => qualifiedHref(ref), InvalidInputError, JSON.stringify(ref));
  }
});

test("parseQualifiedLinks returns okf: links in order, malformed ones with a detail; local links are left alone", () => {
  const doc: OkfDocument = {
    id: "menus/tap-1",
    frontmatter: { type: "Menu Item" },
    body: "[pours](okf://beers/beers/x.md) then [local](../y.md) and [bad](okf://Beers/z.md) and [web](https://e.com/a.md) ![img](okf://beers/img.md)",
  };
  const links = parseQualifiedLinks(doc);
  assert.deepEqual(links.map(({ detail, ...rest }) => rest), [
    { from: "menus/tap-1", text: "pours", href: "okf://beers/beers/x.md", ref: { alias: "beers", id: "beers/x" } },
    { from: "menus/tap-1", text: "bad", href: "okf://Beers/z.md", ref: null },
  ]);
  assert.equal(links[0]!.detail, undefined);
  assert.ok(links[1]!.detail);
  assert.deepEqual(qualifiedLinkEdge(links[0]!), {
    from: "menus/tap-1", to: "beers/x", text: "pours", href: "okf://beers/beers/x.md", bundle: "beers",
  });
  assert.equal(qualifiedLinkEdge(links[1]!), null);
  // The local resolver is unchanged: okf: is external to it, so no local edge is minted.
  assert.equal(isExternalHref("okf://beers/beers/x.md"), true);
  assert.deepEqual(parseLinksFromDoc(doc), [{ from: "menus/tap-1", to: "y", text: "local", href: "../y.md" }]);
});

/** One okf: link written as example code in each form a reader sees as code, and once in prose. */
const CODE_FORMS: Array<[string, string]> = [
  ["inline code span", "Write `[pours](okf://beers/beers/code-span.md)` to link.\n"],
  ["double-backtick code span", "Write `` [pours](okf://beers/beers/double-tick.md) `` to link.\n"],
  ["backtick fence", "Example:\n\n```md\n[pours](okf://beers/beers/tick-fence.md)\n```\n"],
  ["tilde fence", "Example:\n\n~~~\n[pours](okf://beers/beers/tilde-fence.md)\n~~~\n"],
  ["unclosed fence", "```\n[pours](okf://beers/beers/open-fence.md)\n"],
  ["indented block", "Example:\n\n    [pours](okf://beers/beers/indented.md)\n"],
  ["fence in a list item", "- example\n  ```\n  [pours](okf://beers/beers/list-fence.md)\n  ```\n"],
  ["fence in a block quote", "> ```\n> [pours](okf://beers/beers/quote-fence.md)\n> ```\n"],
];

for (const [form, body] of CODE_FORMS) {
  test(`parseQualifiedLinks: an okf: link in a ${form} is not a link; the same link in prose is`, () => {
    const inCode: OkfDocument = { id: "menus/tap-1", frontmatter: { type: "Menu Item" }, body };
    assert.deepEqual(parseQualifiedLinks(inCode), []);
    const href = /\((okf:[^)]+)\)/.exec(body)![1]!;
    const prose: OkfDocument = { id: "menus/tap-1", frontmatter: { type: "Menu Item" }, body: `On tap: [pours](${href})\n\n${body}` };
    const links = parseQualifiedLinks(prose);
    assert.equal(links.length, 1);
    assert.equal(qualifiedLinkEdge(links[0]!)?.href, href);
  });
}

test("parseQualifiedLinks: code inside a link's text keeps the link, sliced from the original body", () => {
  const doc: OkfDocument = { id: "menus/tap-1", frontmatter: { type: "Menu Item" }, body: "[pours `cask`](okf://beers/beers/cask.md)" };
  assert.deepEqual(parseQualifiedLinks(doc).map((l) => [l.text, l.href]), [["pours `cask`", "okf://beers/beers/cask.md"]]);
});

test("parseQualifiedLinks: an indented continuation in a list item, a lazy paragraph line and an unmatched backtick stay prose", () => {
  const body = [
    "- item",
    "",
    "    [pours](okf://beers/beers/list-para.md)",
    "",
    "para",
    "    [pours](okf://beers/beers/lazy.md)",
    "",
    "a ` b [pours](okf://beers/beers/lone-tick.md)",
    "",
    "a `\n\n[pours](okf://beers/beers/split-span.md) `",
  ].join("\n");
  const doc: OkfDocument = { id: "menus/tap-1", frontmatter: { type: "Menu Item" }, body };
  assert.deepEqual(parseQualifiedLinks(doc).map((l) => l.ref?.id), [
    "beers/list-para", "beers/lazy", "beers/lone-tick", "beers/split-span",
  ]);
});

/** Review regressions: each body's surviving okf: ids, as micromark parses them (the renderer test pins the agreement). */
const CONTAINER_CASES: Array<[string, string, string[]]> = [
  ["a stray backtick does not pair across list items", "- a stray ` tick\n- see [x](okf://beers/beers/item-two.md) then `code`", ["beers/item-two"]],
  ["a tab after a list marker counts from the marker's column", "-\tx\n\n\t[x](okf://beers/beers/tab-item.md)", ["beers/tab-item"]],
  ["five spaces after a marker open indented code in the item", "-      [x](okf://beers/beers/wide-code.md)", []],
  ["after a wide marker the content column is marker + 1", "-      x\n\n  [y](okf://beers/beers/wide-para.md)", ["beers/wide-para"]],
  ["a fence in a block quote ends with the quote", "> ```\n[x](okf://beers/beers/after-quote.md)", ["beers/after-quote"]],
  ["a quoted fence closes inside its quote", "> ```\n> [x](okf://beers/beers/quoted.md)\n> ```\n[y](okf://beers/beers/unquoted.md)", ["beers/unquoted"]],
  ["a > line inside a top-level fence is fence content", "```\n> ```\n[x](okf://beers/beers/fenced-gt.md)\n```\n[y](okf://beers/beers/past-fence.md)", ["beers/past-fence"]],
];

for (const [name, body, ids] of CONTAINER_CASES) {
  test(`parseQualifiedLinks: ${name}`, () => {
    const doc: OkfDocument = { id: "menus/tap-1", frontmatter: { type: "Menu Item" }, body };
    assert.deepEqual(parseQualifiedLinks(doc).map((l) => l.ref?.id), ids);
  });
}

test("maskMarkdownCode keeps length and newlines, and stays linear on hostile backtick runs", () => {
  for (const [, body] of CODE_FORMS) {
    const masked = maskMarkdownCode(body);
    assert.equal(masked.length, body.length);
    assert.deepEqual([...masked].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0), [...body].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0));
  }
  let hostile = "";
  for (let run = 1; run < 2000; run++) hostile += "`".repeat(run) + "x";
  const started = performance.now();
  maskMarkdownCode(hostile.repeat(4));
  assert.ok(performance.now() - started < 2000, "masking hostile backtick runs should be linear");
});

test("parseQualifiedKindTarget: qualified only when the text before the first ':' is an alias", () => {
  assert.deepEqual(parseQualifiedKindTarget("beers:Beer"), { alias: "beers", kind: "Beer" });
  assert.deepEqual(parseQualifiedKindTarget("hm-beers: Beer Style"), { alias: "hm-beers", kind: "Beer Style" });
  assert.equal(parseQualifiedKindTarget("Beer"), null);
  assert.equal(parseQualifiedKindTarget("Beers:Beer"), null);
  assert.equal(parseQualifiedKindTarget("Some Kind: Thing"), null);
  assert.equal(parseQualifiedKindTarget(":Beer"), null);
  assert.equal(parseQualifiedKindTarget("beers:"), null);
  assert.equal(parseQualifiedKindTarget("beers:   "), null);
});

test("examples/sample-bundle: parseLinksFromDoc and queryEdges match the snapshot taken before cross-bundle links", async () => {
  const snapshot = JSON.parse(await readFile(path.join(here, "fixtures", "sample-bundle-links.snapshot.json"), "utf8"));
  const bundle = { root: path.resolve(here, "../../../examples/sample-bundle") };
  const docs = await query(bundle, {});
  const actual = {
    parseLinksFromDoc: docs.map((doc) => ({ id: doc.id, links: parseLinksFromDoc(doc) })),
    queryEdges: await queryEdges(bundle, {}),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), snapshot);
  assert.ok(snapshot.queryEdges.length > 0, "the snapshot must carry edges to be a meaningful pin");
});
