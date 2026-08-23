/**
 * The document browser's projection (designs/document-discovery Decision 1): the home's "Documents"
 * section — every bundle doc grouped by kind, so the human can find anything, not just the recent
 * pulse the activity feed shows. Reuses {@link isFeedHead}, the ONE plumbing filter (conventions and
 * the View/Page registry docs stay out — conventions are machinery; Views have their own grid).
 *
 * A kind renders COLLAPSED-by-default when its convention declares `browse_collapsed: true`
 * (core's `KindConvention.browseCollapsed`) — a bundle-DECLARED marker, so the shell never privileges
 * a kind by name. This replaced an earlier freshness-horizon tiering, which wrongly collapsed
 * Tasks (a 30d horizon) alongside transient Context Notes. Pure — the unit-tested core.
 */
import type { DocHead } from "../api/types.js";
import { isFeedHead } from "./ActivityFeed.js";
import { formatWhen } from "./format.js";
import { meaningfulChangeTimeValue } from "@superbee/core/meaningful-change-time";

export interface BrowseRow {
  id: string;
  kind: string;
  title: string;
  when: string | null;
}

export interface BrowseGroup {
  /** The `type` value this group collects. */
  kind: string;
  /** True when the kind's convention declared `browse_collapsed` — the group starts closed. */
  collapsed: boolean;
  /** This kind's docs, newest-first. */
  rows: BrowseRow[];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A display row plus the raw timestamp used only for sorting (stripped from the public shape). */
function toSortableRow(head: DocHead): BrowseRow & { timestamp: string } {
  const timestamp = stringField(meaningfulChangeTimeValue(head.frontmatter));
  return {
    id: head.id,
    kind: String(head.frontmatter.type ?? "Doc"),
    title: stringField(head.frontmatter.title) ?? head.id,
    when: formatWhen(timestamp),
    timestamp: timestamp ?? "",
  };
}

const byRecencyThenTitle = (a: { timestamp: string; title: string }, b: { timestamp: string; title: string }): number =>
  b.timestamp.localeCompare(a.timestamp) || a.title.localeCompare(b.title);

const strip = ({ timestamp: _timestamp, ...row }: BrowseRow & { timestamp: string }): BrowseRow => row;

/**
 * Group browsable heads by kind, newest-first within each group. Group order: EXPANDED kinds first
 * (larger groups before smaller, then by kind name), then the collapsed kinds — durable knowledge on
 * top, the transient/declared-collapsed kinds tucked below. Pure.
 */
export function browseGroups(heads: DocHead[], collapsedKinds: ReadonlySet<string>): BrowseGroup[] {
  const byKind = new Map<string, Array<BrowseRow & { timestamp: string }>>();
  for (const head of heads) {
    if (!isFeedHead(head)) continue;
    const row = toSortableRow(head);
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }
  const groups: BrowseGroup[] = [];
  for (const [kind, rows] of byKind) {
    rows.sort(byRecencyThenTitle);
    groups.push({ kind, collapsed: collapsedKinds.has(kind), rows: rows.map(strip) });
  }
  return groups.sort((a, b) => {
    if (a.collapsed !== b.collapsed) return a.collapsed ? 1 : -1; // expanded tier first
    return b.rows.length - a.rows.length || a.kind.localeCompare(b.kind);
  });
}

/**
 * Flat search across browsable heads: a case-insensitive substring of the title OR id, newest-first,
 * capped at `limit`. Returns the shown rows and the TOTAL match count (an honest "N of M"). A blank
 * query returns nothing — the caller shows the grouped view instead. Pure.
 */
export function searchRows(heads: DocHead[], query: string, limit: number): { rows: BrowseRow[]; total: number } {
  const q = query.trim().toLowerCase();
  if (q === "") return { rows: [], total: 0 };
  const matched = heads
    .filter(isFeedHead)
    .map(toSortableRow)
    .filter((row) => row.title.toLowerCase().includes(q) || row.id.toLowerCase().includes(q))
    .sort(byRecencyThenTitle);
  return { rows: matched.slice(0, limit).map(strip), total: matched.length };
}
