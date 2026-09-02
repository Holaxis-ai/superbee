import { describe, expect, it, vi } from "vitest";
import { getDoc } from "./client.js";
import { fetchDocumentOpenCommand, listPages, pageFromFrontmatter, resolvePageTarget } from "./pages.js";
import type { Frontmatter } from "./types.js";

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, getDoc: vi.fn() };
});

describe("pageFromFrontmatter", () => {
  it("defaults 'bridge' (capability) to none when the access field is absent", () => {
    const fm: Frontmatter = { type: "View", title: "About", entry: "pages/about.html" };
    expect(pageFromFrontmatter("pages-registry/about", "v1", fm)?.bridge).toBe("none");
  });

  it("honors only the two exact shell capabilities, read from 'access'", () => {
    const fm: Frontmatter = { type: "View", title: "Pulse", entry: "pages/pulse.html", access: "bundle-read" };
    expect(pageFromFrontmatter("pages-registry/pulse", "v1", fm)?.bridge).toBe("bundle-read");
    expect(pageFromFrontmatter("pages-registry/pulse", "v1", { ...fm, access: "bundle-propose" })?.bridge).toBe("bundle-propose");
  });

  it("FAIL-CLOSED: a malformed or unrecognized 'access' value denies (none), same as absent", () => {
    for (const bad of ["Bundle-Read", "bundle-write", "", 1, true, {}, ["bundle-read"]]) {
      const fm: Frontmatter = { type: "View", title: "X", entry: "pages/x.html", access: bad };
      expect(pageFromFrontmatter("pages-registry/x", "v1", fm)?.bridge, `access=${JSON.stringify(bad)}`).toBe("none");
    }
  });

  it("REJECTION PIN: the legacy 'bridge' field is never read — bridge-only docs deny, and access alone decides beside it", () => {
    const fm: Frontmatter = { type: "View", title: "X", entry: "views/x.html", access: "bundle-read" };
    expect(pageFromFrontmatter("views-registry/x", "v1", fm)?.bridge).toBe("bundle-read");
    // A bridge-only doc resolves none — the DOWNGRADE is the pin.
    expect(pageFromFrontmatter("views-registry/x", "v1", { type: "View", title: "X", entry: "views/x.html", bridge: "bundle-propose" })?.bridge).toBe("none");
    expect(pageFromFrontmatter("views-registry/x", "v1", { ...fm, access: "none", bridge: "bundle-propose" })?.bridge).toBe("none");
    // A present-but-unrecognized access fail-closes even when the legacy field is permissive.
    expect(pageFromFrontmatter("views-registry/x", "v1", { ...fm, access: "bundle-write", bridge: "bundle-read" })?.bridge).toBe("none");
  });

  it("still returns null when 'entry' is missing, regardless of capability fields", () => {
    const fm: Frontmatter = { type: "View", title: "No entry", access: "bundle-read" };
    expect(pageFromFrontmatter("pages-registry/bad", "v1", fm)).toBeNull();
  });

  it("filters launcher entries through the complete registered-View definition — legacy Page-typed docs are rejected", () => {
    const valid: Frontmatter = { type: "View", title: "P", entry: "pages/p.html", access: "none" };
    expect(pageFromFrontmatter("pages-registry/p", "v1", valid)).not.toBeNull();
    expect(pageFromFrontmatter("docs/p", "v1", valid)).toBeNull();
    expect(pageFromFrontmatter("pages-registry/p", "v1", { ...valid, type: "Design" })).toBeNull();
    expect(pageFromFrontmatter("pages-registry/p", "v1", { ...valid, type: "Page" })).toBeNull();
    expect(pageFromFrontmatter("pages-registry/p", "v1", { ...valid, entry: "other/p.html" })).toBeNull();
  });
});

describe("listPages", () => {
  it("consumes the server-owned shared View catalog without browser-side registry discovery", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ views: [
      { id: "pages-registry/legacy", version: "v1", title: "Legacy located", access: "none" },
      { id: "views-registry/board", version: "v2", title: "Board", access: "bundle-read", presentation: "workspace" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const pages = await listPages();
    expect(fetchMock).toHaveBeenCalledWith("/__ui/views", { credentials: "same-origin" });
    expect(pages.map((p) => p.id)).toEqual(["pages-registry/legacy", "views-registry/board"]);
    expect(pages[1]).toMatchObject({ bridge: "bundle-read", presentation: "workspace" });
    vi.unstubAllGlobals();
  });
});

describe("fetchDocumentOpenCommand", () => {
  it("asks the session-gated shell endpoint with an encoded document id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ command: "superbee doc open 'docs/a b'" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDocumentOpenCommand("docs/a b")).resolves.toBe("superbee doc open 'docs/a b'");
    expect(fetchMock).toHaveBeenCalledWith("/__ui/document-open-command?id=docs%2Fa+b", {
      credentials: "same-origin",
    });
    vi.unstubAllGlobals();
  });
});

describe("pageFromFrontmatter (View)", () => {
  it("projects a type View doc under views-registry//views/ for the launcher", () => {
    const fm: Frontmatter = { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" };
    expect(pageFromFrontmatter("views-registry/board", "v1", fm)).toMatchObject({
      id: "views-registry/board",
      bridge: "bundle-read",
    });
  });
});

describe("resolvePageTarget", () => {
  it("returns only a boolean from the same registered-View authority", async () => {
    vi.mocked(getDoc).mockResolvedValue({ doc: { id: "pages-registry/p", frontmatter: { type: "View", entry: "pages/p.html", access: "none" }, body: "secret" }, version: "v1" });
    expect(await resolvePageTarget("pages-registry/p")).toBe(true);
    vi.mocked(getDoc).mockResolvedValue({ doc: { id: "pages-registry/p", frontmatter: { type: "Page", entry: "pages/p.html" }, body: "" }, version: "v2" });
    expect(await resolvePageTarget("pages-registry/p")).toBe(false);
  });

  it("turns missing documents into a false target result", async () => {
    vi.mocked(getDoc).mockRejectedValue(new Error("not found"));
    expect(await resolvePageTarget("pages-registry/missing")).toBe(false);
  });
});
