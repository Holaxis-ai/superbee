/**
 * DocumentBrowser projection pins (designs/document-discovery Decision 1): grouping by kind with the
 * bundle-declared `browse_collapsed` marker deciding which groups start collapsed, and the flat
 * search that flattens across kinds. The plumbing filter (conventions + Views out) is inherited from
 * isFeedHead, exercised here so the browser and the feed can never diverge on what "a document" is.
 */
import { describe, expect, it } from "vitest";
import { OWN_RECORDS_GROUP, browseGroups, searchRows } from "./browse.js";
import type { DocHead } from "../api/types.js";

const head = (id: string, type: string, title: string, timestamp: string): DocHead => ({
  id,
  version: "v1",
  frontmatter: { type, title, timestamp },
});

const HEADS: DocHead[] = [
  head("designs/a", "Design", "Design A", "2026-07-20T00:00:00Z"),
  head("designs/b", "Design", "Design B", "2026-07-21T00:00:00Z"),
  head("tasks/x", "Task", "Task X", "2026-07-19T00:00:00Z"),
  head("notes/n", "Context Note", "Note N", "2026-07-22T00:00:00Z"), // newest overall
  head("conventions/task", "Convention", "Task", "2026-07-01T00:00:00Z"), // plumbing → excluded
  head("views/v", "View", "A View", "2026-07-01T00:00:00Z"), // registry doc → excluded
];

describe("browseGroups", () => {
  it("groups by kind, newest-first within a group, excluding conventions and Views", () => {
    const groups = browseGroups(HEADS, new Set(["Context Note"]));
    expect(groups.map((g) => g.kind)).toEqual(["Design", "Task", "Context Note"]);
    const design = groups.find((g) => g.kind === "Design")!;
    expect(design.rows.map((r) => r.id)).toEqual(["designs/b", "designs/a"]); // newest first
    expect(design.collapsed).toBe(false);
  });

  it("a browse_collapsed kind carries the flag and sorts AFTER expanded ones (durable on top)", () => {
    const groups = browseGroups(HEADS, new Set(["Context Note"]));
    const note = groups.find((g) => g.kind === "Context Note")!;
    expect(note.collapsed).toBe(true);
    // Context Note has the newest doc, but it sorts LAST because it is collapsed — not by time.
    expect(groups[groups.length - 1]!.kind).toBe("Context Note");
  });

  it("orders expanded groups by size (larger first), then kind name", () => {
    const groups = browseGroups(HEADS, new Set());
    // Design(2) first; Task(1) and Context Note(1) tie on size → kind name ("Context Note" < "Task").
    expect(groups.map((g) => g.kind)).toEqual(["Design", "Context Note", "Task"]);
  });

  it("keeps Superbee's own records apart, in one trailing collapsed group; marker pairs decide", () => {
    const groups = browseGroups([
      ...HEADS,
      head("docs/bundle", "Bundle Name", "My bundle", "2026-07-30T00:00:00Z"),
      head("connectors/feed", "Connector", "Feed", "2026-07-29T00:00:00Z"),
      head("conventions/notes", "Design", "Not a Convention", "2026-07-02T00:00:00Z"), // a person's document
    ], new Set(["Context Note"]));
    expect(groups.map((g) => g.kind)).toEqual(["Design", "Task", "Context Note", OWN_RECORDS_GROUP]);
    expect(groups.find((g) => g.kind === "Design")!.rows.map((r) => r.id)).toContain("conventions/notes");
    const own = groups.at(-1)!;
    expect(own).toMatchObject({ collapsed: true, own: true });
    expect(own.rows.map((r) => r.id)).toEqual(["docs/bundle", "connectors/feed"]);
    expect(searchRows([head("docs/bundle", "Bundle Name", "My bundle", "2026-07-30T00:00:00Z")], "bundle", 40).total).toBe(0);
  });

  it("returns [] when nothing is browsable (only plumbing)", () => {
    expect(browseGroups([head("conventions/x", "Convention", "X", "2026-01-01T00:00:00Z")], new Set())).toEqual([]);
  });
});

describe("searchRows", () => {
  const searchable: DocHead[] = [
    head("designs/reader", "Design", "The doc reader", "2026-07-20T00:00:00Z"),
    head("tasks/reader-build", "Task", "Build the reader", "2026-07-21T00:00:00Z"),
    head("notes/misc", "Context Note", "Something else", "2026-07-22T00:00:00Z"),
  ];

  it("matches title OR id, case-insensitive, newest-first", () => {
    const { rows, total } = searchRows(searchable, "ReAdEr", 40);
    expect(total).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["tasks/reader-build", "designs/reader"]);
  });

  it("caps at the limit but reports the TRUE total", () => {
    const many = Array.from({ length: 10 }, (_, i) => head(`notes/n${i}`, "Context Note", `note ${i}`, `2026-07-${10 + i}T00:00:00Z`));
    const { rows, total } = searchRows(many, "note", 4);
    expect(total).toBe(10);
    expect(rows).toHaveLength(4);
  });

  it("a blank query returns nothing (the caller shows the grouped view instead)", () => {
    expect(searchRows(searchable, "   ", 40)).toEqual({ rows: [], total: 0 });
  });
});
