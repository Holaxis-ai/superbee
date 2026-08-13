/**
 * Activity feed (designs/home-surface): the home surface's live pulse — the most recent docs by
 * timestamp, each attributed (actor · kind · title · when). Data is HEAD projections only
 * (`listAllHeads` — frontmatter, never bodies), so a render costs one cheap scan.
 *
 * LIVE SEMANTICS ARE INVALIDATE-AND-REFETCH, not event append: the SSE `ChangeEvent` carries only
 * `{id, version}` (no frontmatter), so a change/removal DEBOUNCES into one refetch of the head
 * list (chatty bundles collapse to one scan); a reconnect (`subscribeToResync`) refetches
 * immediately — the stream carries no replay, so "trust the stream caught you up" is never an
 * option. Rows whose id/version is new since the previous snapshot get a `fresh` marker (a
 * cosmetic land animation; best-effort by set-membership, never claimed as an authoritative verb).
 *
 * FILTERED, so first-run reads as knowledge rather than plumbing: `conventions/` docs (kind
 * declarations) and the View/Page registry docs (the views grid already shows those) stay out of
 * the feed.
 *
 * Beneath the SSE mechanism, the query also inherits the app-wide 5s visible-tab poll
 * (queryClient.ts's default `refetchInterval`) — the same SSE-fallback posture the pages query
 * rides; heads-only and local, so the cost is one cheap scan.
 */
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listAllHeads } from "../api/client.js";
import type { DocHead } from "../api/types.js";
import { subscribeToChanges, subscribeToResync } from "../pages/pageEvents.js";
import { PAGE_TYPE_NAMES } from "../pages/registry.js";
import { navigate } from "../routing.js";
import { formatWhen } from "./format.js";
import { meaningfulChangeTimeValue } from "@superbee/core/meaningful-change-time";

/** How many rows the feed shows — recent pulse, not a history browser. */
export const FEED_LIMIT = 8;
/** Collapse a burst of SSE change frames into ONE head-list refetch. */
export const FEED_REFETCH_DEBOUNCE_MS = 300;
/** Id prefixes the feed hides (kind declarations are plumbing, not knowledge). */
const HIDDEN_PREFIXES = ["conventions/"] as const;

export interface FeedRow {
  id: string;
  version: string;
  kind: string;
  title: string;
  /**
   * The doc's `actor` label: WHOEVER WROTE LAST. Not the creator, not the claimer, and not the
   * owner — a later write by anyone replaces it, and an unattributed write keeps the previous name
   * while bumping the timestamp. Rendered as provenance ("attributed to …"), never as the subject
   * of the row, because the row cannot honestly say this actor did any particular thing.
   *
   * The wording is load-bearing. "signed by" was rejected: in software that reads as
   * CRYPTOGRAPHICALLY signed, and this label is self-declared, unverified, and explicitly not an
   * authentication or authorization credential — the one field where implying verification is the
   * specific failure mode. "attributed to" claims neither verification nor a particular action,
   * and matches the vocabulary the rest of the codebase already uses for this field.
   */
  actor?: string;
  /** Lifecycle state, when the doc's kind declares one (e.g. a Task's `status`). */
  status?: string;
  /** Who the work belongs to, when declared — the field a reader means by "who is on this". */
  assignee?: string;
  when: string | null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** True iff a head belongs in the feed — not a convention doc, not a View/Page registry doc. */
export function isFeedHead(head: DocHead): boolean {
  if (HIDDEN_PREFIXES.some((p) => head.id.startsWith(p))) return false;
  const type = String(head.frontmatter.type ?? "");
  if ((PAGE_TYPE_NAMES as readonly string[]).includes(type)) return false;
  return true;
}

/** Project heads into display rows: filtered, newest-first by `timestamp` (undated last), capped at {@link FEED_LIMIT}. Pure — the unit-tested core. */
export function feedRows(heads: DocHead[]): FeedRow[] {
  return heads
    .filter(isFeedHead)
    .map((h) => {
      const timestamp = stringField(meaningfulChangeTimeValue(h.frontmatter));
      return {
        id: h.id,
        version: h.version,
        kind: String(h.frontmatter.type ?? "Doc"),
        title: stringField(h.frontmatter.title) ?? h.id,
        actor: stringField(h.frontmatter.actor),
        // Read GENERICALLY off frontmatter — any kind that declares these gets them; no Task
        // special-casing, and a bundle whose kinds declare neither renders exactly as before.
        status: stringField(h.frontmatter.status),
        assignee: stringField(h.frontmatter.assignee),
        when: formatWhen(timestamp),
        timestamp: timestamp ?? "",
      };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.title.localeCompare(b.title))
    .slice(0, FEED_LIMIT)
    .map(({ timestamp: _timestamp, ...row }) => row);
}

/** Ids whose row is NEW or CHANGED relative to the previous snapshot (best-effort freshness marker). `null` previous = first load, nothing is "fresh". Pure. */
export function freshIds(rows: FeedRow[], previous: Map<string, string> | null): Set<string> {
  const fresh = new Set<string>();
  if (previous === null) return fresh;
  for (const row of rows) {
    if (previous.get(row.id) !== row.version) fresh.add(row.id);
  }
  return fresh;
}

export function ActivityFeed() {
  const queryClient = useQueryClient();
  const feedQuery = useQuery({ queryKey: ["activity"], queryFn: () => listAllHeads({}) });
  const previousRef = useRef<Map<string, string> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = subscribeToChanges((e) => {
      if (e.docs.changed.length === 0 && e.docs.removed.length === 0) return;
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined;
        void queryClient.invalidateQueries({ queryKey: ["activity"] });
      }, FEED_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    };
  }, [queryClient]);

  useEffect(() => {
    return subscribeToResync(() => {
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
    });
  }, [queryClient]);

  const rows = feedRows(feedQuery.data ?? []);
  const fresh = freshIds(rows, previousRef.current);

  // Snapshot AFTER computing freshness so the next data change diffs against this render's rows.
  useEffect(() => {
    if (feedQuery.data === undefined) return;
    previousRef.current = new Map(rows.map((r) => [r.id, r.version]));
    // rows derives from feedQuery.data; keying the effect on the data identity is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedQuery.data]);

  if (feedQuery.isPending) return <p className="view-status">Loading activity…</p>;
  if (feedQuery.isError) {
    return <p className="view-status view-status-error">Could not load activity: {(feedQuery.error as Error).message}</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="feed-empty">
        You don’t have any activity in this bundle yet. Think of this feed like Superbee's pulse; it shows you who is
        working on what. For example it might show you that a task was created by a Claude agent on behalf of a human
        user, or that a Codex agent wrote up how a part of the system works.
      </p>
    );
  }
  return (
    <ul className="feed-list">
      {rows.map((row) => (
        <li key={row.id} className={fresh.has(row.id) ? "feed-item feed-row-fresh" : "feed-item"}>
          {/* The reader is the row's destination (designs/doc-reader): the feed announces a doc, clicking reads it. */}
          <button type="button" className="feed-row" onClick={() => navigate({ view: "doc", id: row.id })}>
            <span className="feed-meta">
              <span className="feed-kind">{row.kind}</span>
              {row.status && (
                <>
                  <span className="feed-sep"> · </span>
                  <span className="feed-status">{row.status}</span>
                </>
              )}
              {row.assignee && (
                <>
                  <span className="feed-sep"> · </span>
                  <span className="feed-assignee">for {row.assignee}</span>
                </>
              )}
            </span>
            <span className="feed-title">“{row.title}”</span>
            {(row.actor || row.when) && (
              <span className="feed-provenance">
                {row.actor && (
                  <>
                    attributed to <span className="feed-actor">{row.actor}</span>
                  </>
                )}
                {row.actor && row.when && <span className="feed-sep"> · </span>}
                {row.when && <span className="feed-when">{row.when}</span>}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
