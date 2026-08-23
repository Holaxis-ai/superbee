/**
 * The home's "Documents" browser (designs/document-discovery Decision 1): every bundle doc grouped
 * by kind, so the human can find ANY doc — not just the recent pulse the activity feed shows. Data
 * is head projections only (`listAllHeads` — frontmatter, never bodies), shared with the reader's
 * `["all-heads"]` cache, so a render costs one cheap scan.
 *
 * Each group is collapsible; a kind whose convention declares `browse_collapsed: true`
 * (`KindConvention.browseCollapsed`) starts CLOSED — a bundle-declared marker, so the shell never
 * privileges a kind by name. Within a group, the newest {@link GROUP_CAP} show, with a
 * "show all N" expander. Typing in the filter FLATTENS to a recency-sorted match list across every
 * kind. Live: any doc change refetches the head list (invalidate-and-refetch, like the feed).
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listAllHeads } from "../api/client.js";
import { fetchKinds } from "../api/pages.js";
import { subscribeToChanges, subscribeToResync } from "../pages/pageEvents.js";
import { navigate } from "../routing.js";
import { browseGroups, searchRows, type BrowseGroup, type BrowseRow } from "./browse.js";

/** Rows shown per kind before the "show all N" expander. */
export const GROUP_CAP = 6;
/** Max rows in the flattened search result (with an honest "N of M" when more match). */
export const SEARCH_LIMIT = 40;

export function DocumentBrowser() {
  const queryClient = useQueryClient();
  const headsQuery = useQuery({ queryKey: ["all-heads"], queryFn: () => listAllHeads({}) });
  const kindsQuery = useQuery({ queryKey: ["kinds"], queryFn: fetchKinds, refetchInterval: false });
  const [query, setQuery] = useState("");

  useEffect(() => {
    return subscribeToChanges((e) => {
      if (e.docs.changed.length > 0 || e.docs.removed.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["all-heads"] });
      }
    });
  }, [queryClient]);
  useEffect(() => {
    return subscribeToResync(() => void queryClient.invalidateQueries({ queryKey: ["all-heads"] }));
  }, [queryClient]);

  const heads = headsQuery.data ?? [];
  const collapsedKinds = new Set((kindsQuery.data ?? []).filter((k) => k.browseCollapsed).map((k) => k.governs));

  // Wait for BOTH heads AND kinds: collapsedKinds derives from kinds, and a group's collapsed-start
  // is initial-state-only, so rendering groups before kinds lands would leave a browse_collapsed kind
  // OPEN until remount in --remote mode. fetchKinds
  // best-efforts to [] and never rejects, so this can't hang.
  if (headsQuery.isPending || kindsQuery.isPending) return <p className="view-status">Loading documents…</p>;
  if (headsQuery.isError) {
    return <p className="view-status view-status-error">Could not load documents: {(headsQuery.error as Error).message}</p>;
  }

  const groups = browseGroups(heads, collapsedKinds);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total === 0) {
    return <p className="browse-empty">No documents yet. Everything your agents write shows up here, grouped by kind.</p>;
  }

  const search = query.trim() ? searchRows(heads, query, SEARCH_LIMIT) : null;

  return (
    <div className="browse">
      <input
        type="search"
        className="browse-filter"
        placeholder={`Filter ${total} documents…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Filter documents"
      />
      {search ? (
        search.total === 0 ? (
          <p className="browse-empty">No documents match “{query.trim()}”.</p>
        ) : (
          <div className="browse-results">
            <p className="browse-results-count">
              {search.total > search.rows.length ? `${search.rows.length} of ${search.total} matches` : `${search.total} match${search.total === 1 ? "" : "es"}`}
            </p>
            <ul className="browse-rows">
              {search.rows.map((row) => (
                <DocRow key={row.id} row={row} showKind />
              ))}
            </ul>
          </div>
        )
      ) : (
        <div className="browse-groups">
          {groups.map((group) => (
            <KindGroup key={group.kind} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function KindGroup({ group }: { group: BrowseGroup }) {
  const [open, setOpen] = useState(!group.collapsed);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? group.rows : group.rows.slice(0, GROUP_CAP);
  return (
    <section className="browse-group">
      <h4>
        <button type="button" className="browse-group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="browse-group-kind">{group.kind}</span>
          <span className="browse-count">{group.rows.length}</span>
          <span className="browse-caret" aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h4>
      {open && (
        <>
          <ul className="browse-rows">
            {shown.map((row) => (
              <DocRow key={row.id} row={row} />
            ))}
          </ul>
          {group.rows.length > GROUP_CAP && !showAll && (
            <button type="button" className="browse-show-all" onClick={() => setShowAll(true)}>
              show all {group.rows.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function DocRow({ row, showKind = false }: { row: BrowseRow; showKind?: boolean }) {
  return (
    <li className="browse-item">
      <button type="button" className="browse-row" onClick={() => navigate({ view: "doc", id: row.id })}>
        {showKind && <span className="browse-row-kind">{row.kind}</span>}
        <span className="browse-title">{row.title}</span>
        {row.when && <span className="browse-when">{row.when}</span>}
      </button>
    </li>
  );
}
