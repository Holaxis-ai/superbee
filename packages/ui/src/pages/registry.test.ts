import { describe, expect, it } from "vitest";
import {
  isAnyEntryKey,
  isAnyRegistryId,
  isPageEntryKey,
  isPageRegistryId,
  isViewEntryKey,
  isViewRegistryId,
  parseRegisteredPage,
  resolveBridgeCapability,
} from "./registry.js";

describe("Page registry authority", () => {
  it("accepts nested ids and ordinary dots, but rejects malformed or escaping ids", () => {
    for (const valid of ["pages-registry/about", "pages-registry/reviews/architecture.v2"]) {
      expect(isPageRegistryId(valid), valid).toBe(true);
    }
    for (const invalid of [
      "", "pages-registry/", "pages-registryevil/x", "docs/x", "/pages-registry/x",
      "pages-registry/x.md", "pages-registry/./x", "pages-registry/../x", "pages-registry/x//y",
      "pages-registry/.hidden", "pages-registry/reviews/.draft",
      "pages-registry/x\\y", "pages-registry/x%2fy", "pages-registry/x?y", "pages-registry/x#y",
      "pages-registry/http:x", "pages-registry/has space", "https://example.test/pages-registry/x",
      // A MID-PATH `.md` segment, checked case-insensitively, must be rejected too — not just a
      // trailing one.
      "pages-registry/x.md/y",
    ]) expect(isPageRegistryId(invalid), invalid).toBe(false);
  });

  it("applies the same segment grammar to entries strictly under pages/", () => {
    expect(isPageEntryKey("pages/about.html")).toBe(true);
    expect(isPageEntryKey("pages/reviews/architecture.v2.html")).toBe(true);
    for (const invalid of [
      "pages/", "pagesevil/x", "/pages/x", "pages/../x", "pages/.hidden.html",
      "pages/reviews/.draft.html", "pages/x%2f.html", "pages/x?raw",
      // Pin the same mid-path literal on the entry-key side too.
      "pages/x.MD/y.html",
    ]) {
      expect(isPageEntryKey(invalid), invalid).toBe(false);
    }
  });

  it("requires the registry namespace, type View, and safe entry — a legacy Page-typed doc is NOT a registration", () => {
    const fm = { type: "View", title: "About", entry: "pages/about.html", access: "bundle-read" };
    // Legacy LOCATIONS survive: a View doc under pages-registry//pages/ still registers.
    expect(parseRegisteredPage("pages-registry/about", fm)).toMatchObject({ title: "About", entry: "pages/about.html", bridge: "bundle-read", type: "View" });
    expect(parseRegisteredPage("docs/about", fm)).toBeNull();
    expect(parseRegisteredPage("pages-registry/about", { ...fm, type: "Design" })).toBeNull();
    // REJECTION PIN (tasks/remove-legacy-page-bridge-support): the legacy kind NAME is retired.
    expect(parseRegisteredPage("pages-registry/about", { ...fm, type: "Page" })).toBeNull();
    expect(parseRegisteredPage("pages-registry/about", { ...fm, entry: "other/about.html" })).toBeNull();
    // In-prefix but malformed entries fail the SAME core predicate the server allowlist uses.
    expect(parseRegisteredPage("pages-registry/about", { ...fm, entry: "pages/has space.html" })).toBeNull();
    expect(parseRegisteredPage("notes/about", fm)).toBeNull();
  });

  it("projects edition-neutral mutation attribution with shared precedence and trimming", () => {
    const base = { type: "View", title: "About", entry: "views/about.html" };
    expect(parseRegisteredPage("views-registry/about", {
      ...base,
      superbee_updated_by: "  carol  ",
      updated_by: "alice",
      actor: "mike",
    })?.actor).toBe("carol");
    expect(parseRegisteredPage("views-registry/about", { ...base, updated_by: " alice ", actor: "mike" })?.actor).toBe("alice");
    expect(parseRegisteredPage("views-registry/about", { ...base, actor: " mike " })?.actor).toBe("mike");
    expect(parseRegisteredPage("views-registry/about", base)?.actor).toBeUndefined();
  });

  it("accepts type View over the views-registry//views/ namespaces with the same strictness", () => {
    const fm = { type: "View", title: "Board", entry: "views/board.html", access: "bundle-read" };
    expect(parseRegisteredPage("views-registry/board", fm)).toMatchObject({
      id: "views-registry/board",
      title: "Board",
      entry: "views/board.html",
      bridge: "bundle-read",
      type: "View",
    });
    // The kind name and the prefixes are accepted independently — ids never moved during the
    // rename, so a legacy-located doc registers under the current name.
    expect(parseRegisteredPage("pages-registry/board", { ...fm, entry: "pages/board.html" })).toMatchObject({ type: "View" });
    // REJECTION PIN: the legacy name registers nowhere, current location included.
    expect(parseRegisteredPage("views-registry/board", { ...fm, type: "Page" })).toBeNull();
    // Same strictness: no trimming, no case-folding, no other kind names.
    expect(parseRegisteredPage("views-registry/board", { ...fm, type: "view" })).toBeNull();
    expect(parseRegisteredPage("views-registry/board", { ...fm, type: "View " })).toBeNull();
    expect(parseRegisteredPage("views-registry/../x", fm)).toBeNull();
    expect(parseRegisteredPage("views-registry/board", { ...fm, entry: "views/../x.html" })).toBeNull();
  });

  it("REJECTION PIN: a bridge-only doc registers with bridge (capability) NONE — the legacy field grants nothing", () => {
    const fm = { type: "View", title: "Board", entry: "views/board.html", bridge: "bundle-propose" };
    expect(parseRegisteredPage("views-registry/board", fm)).toMatchObject({ bridge: "none", type: "View" });
    // access alone decides when both are present.
    expect(parseRegisteredPage("views-registry/board", { ...fm, access: "bundle-read" })).toMatchObject({ bridge: "bundle-read" });
  });

  it("exposes the view-prefix grammar wrappers alongside the legacy ones (one helper, two prefixes)", () => {
    expect(isViewRegistryId("views-registry/board")).toBe(true);
    expect(isViewRegistryId("pages-registry/board")).toBe(false);
    expect(isViewEntryKey("views/board.html")).toBe(true);
    expect(isViewEntryKey("pages/board.html")).toBe(false);
    expect(isAnyRegistryId("pages-registry/board")).toBe(true);
    expect(isAnyRegistryId("views-registry/board")).toBe(true);
    expect(isAnyEntryKey("pages/board.html")).toBe(true);
    expect(isAnyEntryKey("views/board.html")).toBe(true);
  });

  it("parses bridge grants fail-closed", () => {
    expect(resolveBridgeCapability("bundle-read")).toBe("bundle-read");
    expect(resolveBridgeCapability("bundle-propose")).toBe("bundle-propose");
    for (const value of [undefined, "none", "Bundle-Read", "bundle-write", true]) {
      expect(resolveBridgeCapability(value)).toBe("none");
    }
  });
});
