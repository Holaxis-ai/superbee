/**
 * The doc reader page (designs/doc-reader rev 2): one concept doc rendered in the SHELL —
 * frontmatter as a header card (kind pill, kind-declared field chips, actor, freshness), the body
 * through the bounded AST→React pipeline (`markdown.tsx` — the security boundary lives there), and
 * the derived "Cited by" list off the edges endpoint. OUTBOUND edges are not a separate section:
 * they are the doc's own body links, rendered IN PLACE — a bare concept-link block becomes an
 * inline "verb → target-title" edge list (markdown.tsx). Blue bar = shell surface (PageFrame's
 * teal bar means "inside a sandboxed View"; this page is trusted chrome).
 *
 * Live: SSE doc changes for THIS id invalidate-and-refetch (the stream carries no frontmatter);
 * resync refetches unconditionally. A doc REMOVED while open lands in an honest terminal state
 * (PageFrame's revoke posture); an id that never existed renders not-found with a way home.
 * Kind-declared chips and the inline edge titles are display-only projections of the bundle's own
 * docs — mechanism in the shell, meaning from the bundle (gate 3).
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getDoc, listAllHeads, ApiError } from "../api/client.js";
import { fetchEdges, fetchKinds } from "../api/pages.js";
import { subscribeToChanges, subscribeToResync } from "../pages/pageEvents.js";
import { navigate } from "../routing.js";
import { formatWhen } from "./format.js";
import { renderMarkdown } from "@superbee/markdown-renderer";
import { meaningfulChangeTimeValue } from "@superbee/core/meaningful-change-time";

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Frontmatter fields the header card shows as chips: kind-DECLARED fields with scalar values (status and friends), excluding the standard identity fields the card already presents. */
const STANDARD_FIELDS = new Set(["type", "title", "actor", "timestamp", "description", "tags"]);

export function DocPage({ docId }: { docId: string }) {
  const queryClient = useQueryClient();
  const docQuery = useQuery({
    queryKey: ["doc", docId],
    queryFn: () => getDoc(docId),
    retry: false,
  });
  const kindsQuery = useQuery({ queryKey: ["kinds"], queryFn: fetchKinds, refetchInterval: false });
  const backlinksQuery = useQuery({
    queryKey: ["doc-backlinks", docId],
    queryFn: () => fetchEdges({ to: docId }),
  });
  // Head projections give id → title for the inline "verb → title" edge rows. Heads-only (cheap),
  // and the browse surface shares this cache.
  const headsQuery = useQuery({ queryKey: ["all-heads"], queryFn: () => listAllHeads({}) });

  useEffect(() => {
    return subscribeToChanges((e) => {
      if (e.docs.changed.some((c) => c.id === docId) || e.docs.removed.includes(docId)) {
        void queryClient.invalidateQueries({ queryKey: ["doc", docId] });
      }
      if (e.docs.changed.length > 0 || e.docs.removed.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["doc-backlinks", docId] });
        // A target's title may have changed — refresh the id→title map behind the inline edges.
        void queryClient.invalidateQueries({ queryKey: ["all-heads"] });
      }
    });
  }, [queryClient, docId]);

  useEffect(() => {
    return subscribeToResync(() => {
      void queryClient.invalidateQueries({ queryKey: ["doc", docId] });
      void queryClient.invalidateQueries({ queryKey: ["doc-backlinks", docId] });
      void queryClient.invalidateQueries({ queryKey: ["all-heads"] });
    });
  }, [queryClient, docId]);

  const bar = (
    <div className="page-frame-bar doc-bar">
      <button type="button" className="page-back" onClick={() => navigate({ view: "launcher" })}>
        ← Home
      </button>
      <span className="page-frame-title">{docId}</span>
    </div>
  );

  if (docQuery.isPending) {
    return (
      <div className="page-frame">
        {bar}
        <p className="view-status">Loading doc…</p>
      </div>
    );
  }

  if (docQuery.isError) {
    const err = docQuery.error;
    const gone = err instanceof ApiError && err.status === 404;
    return (
      <div className="page-frame">
        {bar}
        <div className="doc-terminal">
          <p className="view-status view-status-error">
            {gone
              ? `No doc '${docId}' exists in this bundle${docQuery.isFetched ? " — it may have been removed" : ""}.`
              : `Could not load '${docId}': ${err instanceof Error ? err.message : String(err)}`}
          </p>
          <button type="button" className="page-back" onClick={() => navigate({ view: "launcher" })}>
            Back to home
          </button>
        </div>
      </div>
    );
  }

  const { doc } = docQuery.data;
  const fm = doc.frontmatter;
  const kind = String(fm.type ?? "Doc");
  const title = stringField(fm.title) ?? doc.id;
  const actor = stringField(fm.actor);
  const when = formatWhen(stringField(meaningfulChangeTimeValue(fm)));
  // Chips show the KIND-DECLARED fields present on this doc (required first, then optional) —
  // mechanism in the shell, meaning from the bundle's own conventions. An ungoverned doc shows
  // no chips (its identity fields are already on the card).
  const declared = kindsQuery.data?.find((k) => k.governs === kind);
  const chips: Array<[string, string]> = [];
  for (const key of declared ? [...declared.fields.required, ...declared.fields.optional] : []) {
    if (STANDARD_FIELDS.has(key)) continue;
    const value = fm[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      chips.push([key, String(value)]);
    }
    if (chips.length >= 6) break;
  }

  const backlinks = backlinksQuery.data ?? [];
  // id → title for the inline edge rows; a target without a title (or not yet loaded) falls back to
  // its id in markdown.tsx.
  const titleById = new Map<string, string>();
  for (const head of headsQuery.data ?? []) {
    const t = head.frontmatter.title;
    if (typeof t === "string" && t.trim()) titleById.set(head.id, t);
  }
  const rendered = renderMarkdown(doc.body ?? "", {
    fromId: doc.id,
    onNavigateDoc: (id) => navigate({ view: "doc", id }),
    titleFor: (id) => titleById.get(id),
  });

  return (
    <div className="page-frame">
      {bar}
      <article className="doc-page">
        <header className="doc-head">
          <h1>{title}</h1>
          <p className="doc-head-meta">
            <span className="pill">{kind}</span>
            <span className="doc-id">{doc.id}</span>
            {chips.map(([key, value]) => (
              <span key={key} className="doc-chip">
                {key}: {value}
              </span>
            ))}
            {actor && <span>{actor}</span>}
            {when && <span className="doc-when">{when}</span>}
          </p>
        </header>
        <div className="doc-body">{rendered.element}</div>
        {rendered.bounded && (
          <p className="doc-bounded-note">
            This doc is large — the view above is truncated. The full content is in the bundle
            (read it with <code>superbee doc read {doc.id}</code>).
          </p>
        )}
        {/* Outbound edges render inline in the body above (markdown.tsx). Only "Cited by" —
            backlinks from OTHER docs, which are not in this body — needs a section. */}
        <section className="doc-relationships">
          <div className="doc-backlinks">
            <h2>Cited by</h2>
            {backlinks.length === 0 ? (
              <p className="doc-backlinks-empty">Nothing cites this doc yet.</p>
            ) : (
              <ul>
                {backlinks.map((edge, index) => (
                  // Index-suffixed key: one doc may cite a target twice with identical link text.
                  <li key={`${edge.from}:${edge.text}:${index}`}>
                    <a
                      href={`?view=doc&id=${encodeURIComponent(edge.from)}`}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate({ view: "doc", id: edge.from });
                      }}
                    >
                      {edge.from}
                    </a>
                    {edge.text && <span className="doc-bl-text"> — {edge.text}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </article>
    </div>
  );
}
