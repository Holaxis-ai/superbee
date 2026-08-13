/**
 * The doc reader's injection battery + rendering pins (designs/doc-reader rev 2). THE INVARIANT
 * (HIGH-2) first: anchor attributes are BUILT from the resolver's output — a raw markdown
 * href/src NEVER reaches a DOM attribute. Scheme vectors are first-class alongside the raw-HTML
 * set; gfm tables/task-lists render; raw HTML renders as literal TEXT; bounds degrade honestly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MAX_BODY_CHARS, MAX_NODES, renderMarkdown } from "@superbee/markdown-renderer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("markdown renderer", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onNavigateDoc = vi.fn();

  beforeEach(() => {
    onNavigateDoc.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(body: string, fromId = "tasks/alpha", titleFor?: (id: string) => string | undefined): Promise<{ bounded: boolean }> {
    const result = renderMarkdown(body, { fromId, onNavigateDoc, titleFor });
    await act(async () => {
      root.render(<div className="doc-body">{result.element}</div>);
    });
    return { bounded: result.bounded };
  }

  /** Every attribute of every element — the invariant's audit surface. */
  function allAttributes(): Array<{ tag: string; name: string; value: string }> {
    const out: Array<{ tag: string; name: string; value: string }> = [];
    for (const el of container.querySelectorAll("*")) {
      for (const attr of el.attributes) {
        out.push({ tag: el.tagName.toLowerCase(), name: attr.name, value: attr.value });
      }
    }
    return out;
  }

  const SCHEME_VECTORS = [
    "<javascript:alert(1)>",
    "[x](javascript:alert(1))",
    "[x](javascript:alert(1).md)",
    "[x](vbscript:msgbox(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](&#106;avascript:alert(1))",
    "[x](java\tscript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "<data:text/html;base64,PHNjcmlwdD4=>",
  ].join("\n\n");

  it("THE INVARIANT: no raw href reaches an attribute — every anchor href is a ?view=doc route", async () => {
    await render(SCHEME_VECTORS);
    for (const { tag, name, value } of allAttributes()) {
      const lowered = value.toLowerCase().replace(/\s/g, "");
      expect(lowered, `${tag}[${name}]`).not.toContain("javascript:");
      expect(lowered, `${tag}[${name}]`).not.toContain("vbscript:");
      expect(lowered, `${tag}[${name}]`).not.toContain("data:");
      if (tag === "a" && name === "href") {
        expect(value).toMatch(/^\?view=doc&id=/);
      }
    }
    // `javascript:alert(1).md` RESOLVES to an internal concept id → a safe route, never the scheme.
    const anchors = [...container.querySelectorAll("a")];
    for (const a of anchors) expect(a.getAttribute("href")).toMatch(/^\?view=doc&id=/);
  });

  const RAW_HTML_VECTORS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)></svg>',
    '<math><mtext></mtext></math>',
    '<iframe src="https://evil.example"></iframe>',
    '<style>*{background:url(https://evil.example)}</style>',
    "<!-- --><img src=x onerror=alert(2)> -->",
    "<template><img src=x onerror=alert(3)></template>",
    "<noscript><img src=x onerror=alert(4)></noscript>",
  ].join("\n\n");

  it("reference-style links and footnotes with hostile targets stay inert (review completeness LOW-1)", async () => {
    await render(
      [
        "A [ref link][evil] and a [footnote][^1].",
        "",
        "[evil]: javascript:alert(1)",
        "[^1]: javascript:alert(2)",
      ].join("\n"),
    );
    for (const { tag, name, value } of allAttributes()) {
      const lowered = value.toLowerCase().replace(/\s/g, "");
      expect(lowered, `${tag}[${name}]`).not.toContain("javascript:");
      if (tag === "a" && name === "href") expect(value).toMatch(/^\?view=doc&id=/);
    }
    expect(container.querySelector("script")).toBeNull();
  });

  it("raw HTML renders as LITERAL TEXT — no elements, no handlers, visibly source", async () => {
    await render(RAW_HTML_VECTORS);
    for (const tag of ["script", "img", "svg", "math", "iframe", "style", "template", "noscript"]) {
      expect(container.querySelector(tag), `<${tag}> must not exist`).toBeNull();
    }
    for (const { name } of allAttributes()) {
      expect(name.startsWith("on"), `event-handler attribute ${name}`).toBe(false);
    }
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("frontmatter-adjacent text nodes stay text (React escapes children)", async () => {
    await render('# <img src=x onerror=alert(1)>\n\n**<script>x</script>**');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("h1")!.textContent).toContain("<img");
  });

  it("resolved links navigate through the shell, never through the raw href", async () => {
    await render("[design](../designs/home-surface.md) and [ext](https://example.com/x)");
    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("?view=doc&id=designs%2Fhome-surface");
    await act(async () => {
      anchor.click();
    });
    expect(onNavigateDoc).toHaveBeenCalledWith("designs/home-surface");
    // The external link is inert text, not an anchor.
    const inert = container.querySelector(".doc-link-inert")!;
    expect(inert.textContent).toBe("ext");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("images are inert in v1 (figures are the next PR; raster images a recorded deferral)", async () => {
    await render("![diagram](../views/chart.html) ![photo](x.png)");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[image: diagram]");
  });

  it("gfm renders: tables (with alignment classes), strikethrough, task lists", async () => {
    await render(
      "| a | b |\n|:--|--:|\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] open",
    );
    const table = container.querySelector(".doc-table-wrap table");
    expect(table, "table renders").not.toBeNull();
    expect(table!.querySelectorAll("th")).toHaveLength(2);
    expect(table!.querySelector("td.doc-cell-right")).not.toBeNull();
    expect(container.querySelector("del")!.textContent).toBe("gone");
    const checks = [...container.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.disabled)).toBe(true);
    expect(checks[0]!.checked).toBe(true);
  });

  it("ordinary structure renders: headings, code fences, blockquotes, lists, rules", async () => {
    await render("# H\n\n```ts\nconst x = 1;\n```\n\n> q\n\n1. one\n2. two\n\n---\n");
    expect(container.querySelector("h1")!.textContent).toBe("H");
    expect(container.querySelector("pre.doc-code code")!.textContent).toContain("const x = 1;");
    expect(container.querySelector("blockquote")).not.toBeNull();
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("hr")).not.toBeNull();
  });

  describe("inline edge rows (bare concept-link blocks render as 'verb → target')", () => {
    const titleFor = (id: string): string | undefined =>
      id === "tasks/a" ? "Inventory the resources" : id === "tasks/b" ? "Verify the package" : undefined;

    it("renders a bare concept-link block as an aligned edge list: verb → target-title, routed to the target", async () => {
      await render("Ships it.\n\n[contains](../tasks/a.md)\n\n[depends on](../tasks/b.md)", "roadmap-items/x", titleFor);
      expect(container.textContent).toContain("Ships it.");
      const rows = [...container.querySelectorAll(".doc-edge-list .doc-edge-row")];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.querySelector(".doc-edge-verb")!.textContent).toBe("contains");
      expect(rows[0]!.querySelector(".doc-edge-target")!.textContent).toBe("Inventory the resources");
      expect(rows[0]!.getAttribute("href")).toBe("?view=doc&id=tasks%2Fa");
      expect(rows[1]!.querySelector(".doc-edge-verb")!.textContent).toBe("depends on");
      expect(rows[1]!.querySelector(".doc-edge-target")!.textContent).toBe("Verify the package");
    });

    it("falls back to the target id when no title is known", async () => {
      await render("[contains](../tasks/z.md)", "roadmap-items/x", titleFor);
      expect(container.querySelector(".doc-edge-target")!.textContent).toBe("tasks/z");
    });

    it("merges a run of consecutive single-link paragraphs into ONE edge list", async () => {
      await render("[contains](../tasks/a.md)\n\n[contains](../tasks/b.md)\n\n[contains](../tasks/c.md)", "roadmap-items/x");
      expect(container.querySelectorAll(".doc-edge-list")).toHaveLength(1);
      expect(container.querySelectorAll(".doc-edge-row")).toHaveLength(3);
    });

    it("also collapses a multi-link block joined by soft breaks into rows", async () => {
      await render("[contains](../tasks/a.md)\n[depends on](../tasks/b.md)", "roadmap-items/x");
      expect(container.querySelectorAll(".doc-edge-list")).toHaveLength(1);
      expect(container.querySelectorAll(".doc-edge-row")).toHaveLength(2);
    });

    it("REGRESSION: a concept link EMBEDDED in a sentence is prose, not an edge row", async () => {
      // The exact objection: "the archive contains the history" must not lose its verb.
      await render("The archive [contains](../refs/history.md) the history.", "docs/x");
      expect(container.querySelector(".doc-edge-list")).toBeNull();
      const anchor = container.querySelector("a")!;
      expect(anchor.textContent).toBe("contains");
      expect(anchor.getAttribute("href")).toBe("?view=doc&id=refs%2Fhistory");
      expect(container.textContent).toBe("The archive contains the history.");
    });

    it("a NON-concept bare link (external / #anchor / non-.md) is NOT an edge row and stays visible", async () => {
      await render(
        "[the upstream spec](https://example.com/spec)\n\n[see the appendix](#appendix)\n\n[the raw file](../data/table.csv)",
        "docs/x",
      );
      expect(container.querySelector(".doc-edge-list")).toBeNull();
      const text = container.textContent ?? "";
      expect(text).toContain("the upstream spec");
      expect(text).toContain("see the appendix");
      expect(text).toContain("the raw file");
    });

    it("a paragraph mixing a concept and a non-concept link is left as prose (not an edge list)", async () => {
      await render("[contains](../tasks/a.md) [the spec](https://example.com)", "roadmap-items/x");
      expect(container.querySelector(".doc-edge-list")).toBeNull();
      expect(container.textContent).toContain("contains");
      expect(container.textContent).toContain("the spec");
    });

    it("an image-only paragraph is not an edge list (an image is not a link)", async () => {
      await render("![a diagram](../views/chart.png)", "tasks/x");
      expect(container.querySelector(".doc-edge-list")).toBeNull();
      expect(container.textContent).toContain("[image: a diagram]");
    });

    it("a bare concept-link nested in a blockquote is NOT lifted — the edge list is TOP-LEVEL only", async () => {
      await render("> [contains](../tasks/a.md)", "roadmap-items/x");
      expect(container.querySelector(".doc-edge-list")).toBeNull();
      expect(container.querySelector("blockquote a")!.getAttribute("href")).toBe("?view=doc&id=tasks%2Fa");
    });
  });

  /**
   * Bounds. Degrading AT a budget is behavior independent of how big the budget is, so the two
   * node-flood cases run at an injected small budget: sizing a fixture off the real MAX_NODES
   * (20K nodes parsed and walked) cost ~1s locally and TIMED OUT against vitest's 5s default on a
   * loaded CI runner — tasks/ui-markdown-bounds-test-timeout. The production constants are pinned
   * separately below, and the body cap still runs on the real default, so nothing is only ever
   * exercised at a test-only number.
   */
  describe("resource bounds", () => {
    // The two bounds are isolated ON PURPOSE. Shrinking BOTH at once made the node-flood cases pass
    // for the wrong reason: a ~120-char fixture tripped a 64-char body cap before the walk was ever
    // consulted, so breaking the node budget outright kept them green (caught by probing red).
    // Each budget is therefore shrunk alone, leaving the other at its production default.
    const NODE_BUDGET = { maxNodes: 20 };
    const BODY_BUDGET = { maxBodyChars: 64 };

    it("pins the production budgets — the constants the default path applies", () => {
      expect(MAX_BODY_CHARS).toBe(262_144);
      expect(MAX_NODES).toBe(20_000);
    });

    it("an OMITTED limit resolves to the production constant — the default WIRING, not just its value", () => {
      // Asserting MAX_NODES === 20_000 does not prove the renderer still USES it. Every
      // flood case injects a budget, so the production fallback could be changed to Infinity with
      // all of them green. Reporting the resolved bounds makes the omitted path assertable cheaply.
      const { limits } = renderMarkdown("hello", { fromId: "docs/x", onNavigateDoc });
      expect(limits).toEqual({ maxBodyChars: MAX_BODY_CHARS, maxNodes: MAX_NODES });
    });

    it("the seam only ever TIGHTENS — over-max, non-finite, and non-positive overrides fail closed", () => {
      // This renderer is a resource-security boundary, so the test seam must not be able
      // to relax it. NaN is the dangerous one: `count >= NaN` is always false, which would remove
      // the walk bound entirely rather than merely widening it.
      const render = (limits: { maxBodyChars?: number; maxNodes?: number }) =>
        renderMarkdown("hello", { fromId: "docs/x", onNavigateDoc, limits }).limits;

      for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, 0, -5]) {
        expect(render({ maxNodes: bad }).maxNodes, `maxNodes override ${bad} must fail closed`).toBe(MAX_NODES);
        expect(render({ maxBodyChars: bad }).maxBodyChars, `maxBodyChars override ${bad} must fail closed`).toBe(
          MAX_BODY_CHARS,
        );
      }
      // A request ABOVE the maximum clamps down to it, never up.
      expect(render({ maxNodes: MAX_NODES * 10 }).maxNodes).toBe(MAX_NODES);
      expect(render({ maxBodyChars: MAX_BODY_CHARS * 10 }).maxBodyChars).toBe(MAX_BODY_CHARS);
      // A SMALLER request — the only thing the seam exists for — is honored.
      expect(render({ maxNodes: 20 }).maxNodes).toBe(20);
      expect(render({ maxBodyChars: 64 }).maxBodyChars).toBe(64);
    });

    it("an oversized body degrades on the REAL default cap, with no injected limit", async () => {
      expect((await render("a".repeat(MAX_BODY_CHARS + 10))).bounded).toBe(true);
    });

    it("ordinary content under the budgets is NOT reported bounded", async () => {
      expect((await render("# title\n\nsome prose\n")).bounded).toBe(false);
    });

    it("a node flood degrades — on the NODE budget, with the body cap left at its default", () => {
      const flood = Array.from({ length: NODE_BUDGET.maxNodes + 10 }, (_, i) => `p${i}`).join("\n\n");
      expect(flood.length).toBeLessThan(MAX_BODY_CHARS); // the body cap must NOT be what trips
      expect(renderMarkdown(flood, { fromId: "docs/x", onNavigateDoc, limits: NODE_BUDGET }).bounded).toBe(true);
    });

    it("an all-EDGE flood degrades too — inline edge rows count against the node budget", () => {
      // Bare concept-link paragraphs all merge into ONE edge list; that path must still charge the
      // node budget rather than render every row unbounded.
      const flood = Array.from({ length: NODE_BUDGET.maxNodes + 10 }, () => "[a](b.md)").join("\n\n");
      expect(flood.length).toBeLessThan(MAX_BODY_CHARS);
      expect(renderMarkdown(flood, { fromId: "docs/x", onNavigateDoc, limits: NODE_BUDGET }).bounded).toBe(true);
    });

    it("an oversized body degrades on the BODY cap, with the node budget left at its default", () => {
      const body = "a".repeat(BODY_BUDGET.maxBodyChars + 1); // one paragraph — far under MAX_NODES
      expect(renderMarkdown(body, { fromId: "docs/x", onNavigateDoc, limits: BODY_BUDGET }).bounded).toBe(true);
    });
  });
});
