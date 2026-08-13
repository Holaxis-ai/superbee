/**
 * The home surface (designs/home-surface; historically "the launcher", tasks/ui-pages-spike —
 * the working name is provisional pending test users, see the design's Naming section). The `ui`
 * command's SOLE landing surface: bundle identity, a first-run orientation, ONE flat
 * recency-sorted grid of every `type: View` registry doc, and the live
 * activity feed ({@link ActivityFeed}).
 *
 * The grid is FLAT by design: the former Dashboards/Interactive/Documents sections grouped by the
 * enforced `access` capability, which projected the security model into the information
 * architecture (and "Documents" collided with the product's core doc noun). Capability is now a
 * BADGE on each card — `live data` / `can edit` / `artifact` — still derived from the SAME
 * enforced field the bridge broker reads (core's `resolveDeclaredAccess` over `access`; the
 * legacy `bridge` spelling is no longer read), so the card can never claim a page is one thing while the bridge treats it as
 * another; it is just no longer the organizing principle.
 *
 * Orientation: a 4-panel walkthrough (What is it? + problems / How do I use it? / Views +
 * recipes / Collaborating via sync) navigated with Back/Next; "Got it" appears only on the last panel and is the
 * one dismissal path. Shown until dismissed, tracked in localStorage keyed by the bundle root
 * (accepted caveat: a stable-port fallback to an ephemeral port changes the origin, which may
 * resurface it once), and REOPENABLE afterwards via the "what is this?" affordance — the
 * overview and the example view prompts must stay reachable, not vanish after one reading.
 * Copy rules (designs/home-surface + the 2026-07-24 landing rethink): agent-first framing —
 * Superbee is a cognitive ecosystem used THROUGH agents, and this window exists for the human to
 * see what agents are doing; the privacy promise is worded to cover the in-tree mode; the
 * try-it hook carries a no-agent-yet fallback.
 *
 * Live: a doc change over SSE may add/remove/retitle a View doc, so the grid refetches on any
 * doc change — a freshly-promoted view shows up without a manual reload.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchConfig, listPages, invalidateKinds, type PageEntry, type SharingSummary, type WorkspaceSummaryEntry } from "../api/pages.js";
import { subscribeToChanges, subscribeToResync } from "../pages/pageEvents.js";
import type { BridgeCapability } from "../pages/registry.js";
import { getInterceptorStatus, type InterceptorStatus } from "../query/interceptor.js";
import { navigate } from "../routing.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { DocumentBrowser } from "./DocumentBrowser.js";
import { formatWhen } from "./format.js";

/** Capability badge per enforced `access` value — role-based wording (the design's content model). */
export const BRIDGE_BADGES: Record<BridgeCapability, { label: string; className: string }> = {
  "bundle-read": { label: "live data", className: "badge badge-read" },
  "bundle-propose": { label: "can edit", className: "badge badge-propose" },
  none: { label: "artifact", className: "badge badge-artifact" },
};

export const MIN_SHARING_REFRESH_DELAY_MS = 250;
export const MAX_SHARING_REFRESH_DELAY_MS = 5 * 60_000;

/** Remaining lifetime of one sharing reading; false means this config must not poll. */
export function sharingRefreshDelay(
  sharing: SharingSummary | null | undefined,
  nowMs: number = Date.now(),
  interceptorStatus: InterceptorStatus = getInterceptorStatus(),
): number | false {
  if (interceptorStatus !== "ok") return false;
  if (!sharing) return false;
  const refreshMs = sharing.refresh_after_ms;
  if (typeof refreshMs !== "number" || !Number.isFinite(refreshMs) || refreshMs <= 0) return false;
  const boundedRefreshMs = Math.min(refreshMs, MAX_SHARING_REFRESH_DELAY_MS);
  const asOfMs = Date.parse(sharing.as_of);
  if (!Number.isFinite(asOfMs)) return boundedRefreshMs;
  const ageMs = Math.max(0, nowMs - asOfMs);
  return Math.max(MIN_SHARING_REFRESH_DELAY_MS, Math.min(boundedRefreshMs, refreshMs - ageMs));
}

/**
 * The trust chip's WORDS — the SPA owns wording over ui-server's state vocabulary
 * (designs/home-surface truth table; every row pinned by Launcher.test.tsx). Rules: never
 * fabricate in either direction; `unavailable` is honest refusal, never a guessed "private";
 * `unscoped` (a non-conventional --dir bundle) makes NO claim at all (null — no chip).
 */
export function sharingChip(sharing: SharingSummary | null): { text: string; className: string; title?: string } | null {
  if (sharing === null) return null;
  switch (sharing.kind) {
    case "private":
      return { text: "private — this computer only", className: "chip chip-private" };
    case "private_local_branch":
      return { text: "private — local board branch, not yet shared", className: "chip chip-private" };
    case "private_intree_no_remote":
      return { text: "private — committed with code, no remote", className: "chip chip-private" };
    case "private_intree_not_pushed":
      return { text: "private — committed with code, not yet pushed", className: "chip chip-private" };
    case "shared_branch":
      return { text: `shared · ${sharing.remote ?? "remote"}`, className: "chip chip-shared" };
    case "shared_intree":
      return { text: `shared with the code · ${sharing.remote ?? "remote"}`, className: "chip chip-shared" };
    case "hosted":
      return { text: `hosted · ${sharing.remote ?? "remote"}`, className: "chip chip-shared" };
    case "unavailable":
      return { text: "sharing status unavailable", className: "chip chip-unavailable", title: sharing.reason };
    case "unscoped":
      return null;
    default:
      // An unknown future kind must not fabricate a claim — same posture as unavailable.
      return { text: "sharing status unavailable", className: "chip chip-unavailable" };
  }
}

/** The "where is this?" panel's sharing detail sentence (fuller than the chip; same truth rules). */
function sharingDetail(sharing: SharingSummary | null): string {
  if (sharing === null) return "no sharing information for this bundle";
  switch (sharing.kind) {
    case "private":
      return "not shared — stays here until you run superbee sync --establish, or commit it with your code";
    case "private_local_branch":
      return "a local board branch exists but has never been pushed — superbee sync shares it";
    case "private_intree_no_remote":
      return "committed with the code, but this repo has no remote — pushing the repo shares it";
    case "private_intree_not_pushed":
      return "committed with the code, but no upstream evidence it has been shared — your next git push shares it";
    case "shared_branch":
      return `git — ${sharing.remote ?? "the repo's remote"}, on a dedicated board branch beside the code`;
    case "shared_intree":
      return `git — committed with the code and present on ${sharing.remote ?? "the tracking remote"} (as of the last fetch)`;
    case "hosted":
      return `served by ${sharing.remote ?? "a remote server"} — sharing is that server's policy`;
    case "unavailable":
      return `could not determine sharing state${sharing.reason ? ` — ${sharing.reason}` : ""}`;
    case "unscoped":
      return "no sharing claim — this folder is not the repo's conventional board";
    default:
      // Unknown future kind: refuse honestly, mirroring the chip.
      return "sharing status unavailable";
  }
}

/** localStorage key for the first-run orientation's dismissal, scoped per bundle root. */
export function orientationStorageKey(root: string): string {
  return `superbee-home-orientation:${root}`;
}

function readOrientationDismissed(root: string): boolean {
  try {
    return window.localStorage.getItem(orientationStorageKey(root)) === "dismissed";
  } catch {
    // Storage unavailable (privacy mode) — don't re-orient on every render forever.
    return true;
  }
}

export function Launcher() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ["ui-config"],
    queryFn: fetchConfig,
    refetchInterval: (query) => sharingRefreshDelay(query.state.data?.sharing),
  });
  const pagesQuery = useQuery({ queryKey: ["pages"], queryFn: listPages });
  const [orientationDismissed, setOrientationDismissed] = useState<boolean | null>(null);
  const [orientationReopened, setOrientationReopened] = useState(false);
  const [orientationStep, setOrientationStep] = useState(0);
  const orientationCardRef = useRef<HTMLElement | null>(null);
  const orientationStepSeenRef = useRef(false);
  const [whereOpen, setWhereOpen] = useState(false);
  const [viewsHelpOpen, setViewsHelpOpen] = useState(false);
  const [orientationHelpOpen, setOrientationHelpOpen] = useState(false);

  useEffect(() => {
    return subscribeToChanges((e) => {
      invalidateKinds([...e.docs.changed.map((c) => c.id), ...e.docs.removed]);
      if (e.docs.changed.length > 0 || e.docs.removed.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["pages"] });
        // Board doc changes are how a mid-session `sync` manifests — refetch the config so the
        // sharing chip cannot freeze for a days-long server run (the server's
        // TTL caps the cost of these invalidations).
        void queryClient.invalidateQueries({ queryKey: ["ui-config"] });
      }
    });
  }, [queryClient]);

  // A reconnected SSE stream replays nothing — refetch the list so a page promoted/removed during
  // the gap shows up (tasks/ui-pages-spike P1, connection resilience). Config included: the chip's
  // truth may have moved during the gap.
  useEffect(() => {
    return subscribeToResync(() => {
      invalidateKinds();
      void queryClient.invalidateQueries({ queryKey: ["pages"] });
      void queryClient.invalidateQueries({ queryKey: ["ui-config"] });
    });
  }, [queryClient]);

  const config = configQuery.data;

  // The privacy promise describes a LOCAL bundle. Runtime mode is the authority; root may carry a
  // remote display value, so root presence alone must never enable orientation in hosted mode.
  useEffect(() => {
    setOrientationReopened(false);
    setOrientationStep(0);
    if (config?.mode !== "dir" || config.root == null) {
      setOrientationDismissed(null);
      return;
    }
    setOrientationDismissed(readOrientationDismissed(config.root));
  }, [config?.mode, config?.root]);

  const pages = pagesQuery.data ?? [];
  // The orientation is gated to local dir mode (its privacy promise describes a local bundle);
  // within that mode it shows on first run OR when explicitly reopened via "what is this?".
  const orientationAvailable = config?.mode === "dir" && config.root != null;
  const showOrientation = orientationAvailable && (orientationDismissed === false || orientationReopened);

  // On a step CHANGE (never the initial render — no focus stealing on load), move focus to the
  // entering panel's heading. This announces the panel and keeps a repeated Enter on the nav slot
  // from landing on the control that replaced Next.
  useEffect(() => {
    if (!orientationStepSeenRef.current) {
      orientationStepSeenRef.current = true;
      return;
    }
    orientationCardRef.current?.querySelector("h2")?.focus();
  }, [orientationStep]);

  const dismissOrientation = () => {
    if (config?.mode === "dir" && config.root != null) {
      try {
        window.localStorage.setItem(orientationStorageKey(config.root), "dismissed");
      } catch {
        // best-effort persistence; the dismissal still holds for this session
      }
    }
    setOrientationDismissed(true);
    setOrientationReopened(false);
    setOrientationStep(0);
    setOrientationHelpOpen(false);
  };

  const chip = config ? sharingChip(config.sharing ?? null) : null;

  return (
    <div className="launcher">
      <section className="launcher-summary">
        <h2>{config?.name ?? "bundle"}</h2>
        <p className="launcher-meta">
          {config ? (
            <>
              {/* Local is the default experience and needs no badge; only the remote exception
                  is worth flagging up front (mechanics live behind "where is this?"). */}
              {config.mode === "remote" && <span className="pill">remote</span>}
              {chip && (
                <span className={chip.className} title={chip.title ?? (config.sharing ? `as of ${formatWhen(config.sharing.as_of) ?? config.sharing.as_of}` : undefined)}>
                  {chip.text}
                </span>
              )}
              <button type="button" className="where-btn" aria-expanded={whereOpen} onClick={() => setWhereOpen((v) => !v)}>
                {whereOpen ? "hide details" : "where is this?"}
              </button>
              {orientationAvailable && orientationDismissed === true && !showOrientation && (
                <button type="button" className="where-btn about-btn" onClick={() => setOrientationReopened(true)}>
                  what is this?
                </button>
              )}
            </>
          ) : (
            "Loading bundle…"
          )}
        </p>
        {config && whereOpen && (
          <dl className="where-panel">
            <div>
              <dt>{config.mode === "remote" ? "Server" : "Folder"}</dt>
              <dd>
                <code>{config.root ?? config.remoteUrl ?? "unknown"}</code>
              </dd>
            </div>
            <div>
              <dt>Serving</dt>
              <dd>
                {config.mode === "remote"
                  ? "reverse proxy to the server above — this window only (127.0.0.1)"
                  : "local folder · this computer only (127.0.0.1, per-run session)"}
              </dd>
            </div>
            <div>
              <dt>Sharing</dt>
              <dd>{sharingDetail(config.sharing)}</dd>
            </div>
            {config.sharing && (
              <div>
                <dt>As of</dt>
                <dd>{formatWhen(config.sharing.as_of) ?? config.sharing.as_of}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      <div className="home-columns">
        <div className="home-main">
          {showOrientation && (
            <section className="orientation" ref={orientationCardRef}>
              {orientationStep === 0 && (
                <>
                  <h2 tabIndex={-1}>What is Superbee?</h2>
                  <p>
                    Superbee is a cognitive ecosystem for AI agents: a shared, versioned memory that lives in this
                    project as a folder of plain markdown — notes, decisions, tasks, and the links between them.
                    Agents read and write it as they work; conflict-safe writes keep concurrent agents from stepping
                    on each other; and everything they know stays in files you own and can read.{" "}
                    <button
                      type="button"
                      className="where-btn"
                      aria-expanded={orientationHelpOpen}
                      onClick={() => setOrientationHelpOpen((v) => !v)}
                    >
                      {orientationHelpOpen ? "hide details" : "learn more"}
                    </button>
                  </p>
                  {orientationHelpOpen && (
                    <div className="orientation-details">
                      <p>
                        The documents follow an open standard called OKF — the Open Knowledge Format. In practice it
                        means each file is ordinary markdown with a short header naming what the document is and what
                        it is called, and ordinary markdown links between files.
                      </p>
                      <p>
                        Nothing about it is proprietary or locked to this tool: any editor that opens markdown can
                        read your bundle, and Superbee can read a bundle some other program wrote.
                      </p>
                    </div>
                  )}
                  <h3>What problems does it solve?</h3>
                  <p>
                    On their own, agents forget important information between sessions, occasionally step on each
                    other’s writes, and often keep what they know invisible to you. A shared memory fixes all three —
                    and it is what makes long-horizon work possible: progress ratchets forward instead of slipping
                    back, because what one session settles becomes the floor the next one builds on. Decisions stay
                    decided, and work can span days, sessions, and many agents without resetting to zero.
                  </p>
                </>
              )}
              {orientationStep === 1 && (
                <>
                  <h2 tabIndex={-1}>How do I use Superbee?</h2>
                  <p>
                    Actually, agents are the main users of Superbee. In fact it was built <em>by</em> agents,{" "}
                    <em>for</em> agents, with features that make it easy for them to work together on long-horizon
                    problems. The Superbee skill provides agents with some basic instructions on how it all works, and
                    Superbee hooks start each new session with the bundle’s current state already in view. If they
                    aren’t set up yet, just ask your agent to install the Superbee skill and hooks — for this project
                    only, or globally for every project at once.
                  </p>
                  <p>
                    You may also want to add files into the bundle — for example, if you have context that will help
                    agents understand what you are building. Again, you’ll want to add these files through agents,
                    who will know how to add them so that they can find them when they need them. For example, you
                    can just say <em>“Add this Vision doc to the bundle”</em> and the agents will take care of it.
                    Beyond that, just work as you normally would. With the skill installed, your agents will write
                    their own notes and files into the bundle, and retrieve them as they are needed.
                  </p>
                </>
              )}
              {orientationStep === 2 && (
                <>
                  <h2 tabIndex={-1}>Views</h2>
                  <p>
                    Superbee also makes it extremely easy to create views so that you can see and interact with the
                    project and its bundle. Just tell the agents what you want to see, and they will create it. And
                    they are very good at anticipating what display formats are most useful. Here are a few examples
                    of views that might be helpful:
                  </p>
                  <ul className="orientation-examples">
                    <li>“Create me a view that shows all tasks that have not been completed, grouped by priority.”</li>
                    <li>“Show the decisions made this month, each linking to its full write-up.”</li>
                    <li>“Make a live map of how the documents in this bundle link together.”</li>
                  </ul>
                  <h3>Recipes</h3>
                  <p>
                    Superbee is not limited to what it ships with — it is flexible by design. You (or your agents) can
                    define your own document types, with their own fields and allowed values; your own typed
                    relationships between documents; and your own views over all of it. The bundle adapts to how your
                    project actually works, not the other way around.
                  </p>
                  <p>
                    Recipes are how that flexibility becomes reusable. A recipe packages a custom set of functionality
                    — document types, relationships, and the views that go with them — into a small, installable
                    definition you can apply to any bundle and share with others. Superbee ships with a few built in:
                    context notes (applied by default), work tracking (the Task type that powers a shared task board),
                    and roadmap. To use one, just ask your agent — e.g.{" "}
                    <em>“Set this project up for task tracking”</em> — and it will apply the right recipe.
                  </p>
                  <p>
                    Agents can help with recipes themselves, too: ask one to define a recipe for the way you work, or
                    to package what this bundle already does into a recipe you can share — and they may even suggest a
                    recipe on their own when they notice a pattern worth capturing.
                  </p>
                </>
              )}
              {orientationStep === 3 && (
                <>
                  <h2 tabIndex={-1}>Collaborating with others</h2>
                  <p>
                    The bundle stays local until you choose to share it. Sharing works through git, through the
                    repository you likely already have. As with other functionality, you can simply ask your agent to
                    share your bundle, and it will walk you through any necessary steps (for example, if you need to
                    initialize a git repo). Under the hood, a one-time establish step
                    publishes the bundle onto its own <code>board</code> branch beside your code, and teammates join
                    just by syncing from their clone.
                  </p>
                  <p>
                    From then on, syncing is the whole workflow: it commits your bundle changes, pulls your
                    teammates’, and pushes yours — touching nothing outside the bundle. Agents sync as they close out
                    work; new sessions pull the latest state as they start, and stale reads refresh
                    themselves — so humans and agents on every clone work from the same shared memory.
                  </p>
                  <p>
                    If both sides change the same document, sync converges instead of breaking: the incoming version
                    is kept, yours is saved to a file, and reconciling is an ordinary edit. (You can also skip the
                    separate branch entirely by committing the folder with your code — sharing then rides your normal
                    commits and pushes.)
                  </p>
                  <p>
                    <strong>Worth knowing:</strong> a shared bundle is exactly as visible as the repository that
                    carries it. If the repo is public, the bundle is public too — the tasks agents record, the notes
                    they keep, and the documents they generate all become part of the project’s public record. Apply
                    the same judgment to what lands in the bundle as you would to any commit, keeping in mind that
                    agents sync the bundle automatically as they work — sharing does not wait for any action from
                    you.
                  </p>
                  <p className="orientation-close">
                    <strong>That’s the tour.</strong> To see Superbee in action, ask your agent to write something down
                    — a decision you just made, or how some corner of this project works — and watch it land in the
                    activity feed.
                  </p>
                </>
              )}
              <div className="orientation-nav">
                <span className="orientation-step" aria-live="polite">
                  {orientationStep + 1} of 4
                </span>
                {orientationStep > 0 && (
                  <button
                    type="button"
                    className="orientation-nav-btn"
                    onClick={() => setOrientationStep((s) => Math.max(0, s - 1))}
                  >
                    Back
                  </button>
                )}
                {orientationStep < 3 ? (
                  <button
                    type="button"
                    className="orientation-nav-btn orientation-next"
                    onClick={() => setOrientationStep((s) => Math.min(3, s + 1))}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="button"
                    className="orientation-dismiss"
                    onClick={(e) => {
                      // The second click of a double-click (detail > 1) belongs to the Next that
                      // just advanced panels — never treat it as informed dismissal.
                      if (e.detail > 1) return;
                      dismissOrientation();
                    }}
                  >
                    Got it
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="launcher-section">
            <h3>Views</h3>
            {pages.length > 0 && (
              <div className="launcher-grid">
                {pages.map((page) => (
                  <PageCard key={page.id} page={page} />
                ))}
              </div>
            )}
            {pagesQuery.isPending && <p className="view-status">Loading views…</p>}
            {pagesQuery.isError && (
              <p className="view-status view-status-error">Could not load views: {(pagesQuery.error as Error).message}</p>
            )}
            {!pagesQuery.isPending && !pagesQuery.isError && pages.length === 0 && (
              <div className="launcher-empty">
                <p>
                  You haven’t created any views yet. Ask your agent for one in plain language — e.g.{" "}
                  <em>“create a view showing every open task, grouped by priority”</em> — and its card will appear
                  here.
                </p>
                <p>
                  Expected views here that have disappeared? They may still use retired legacy naming, which is no
                  longer read — see “learn more” below for how to restore them.
                </p>
                <p>
                  <button
                    type="button"
                    className="where-btn"
                    aria-expanded={viewsHelpOpen}
                    onClick={() => setViewsHelpOpen((v) => !v)}
                  >
                    {viewsHelpOpen ? "hide details" : "learn more"}
                  </button>
                </p>
                {viewsHelpOpen && (
                  <div className="launcher-empty-details">
                    <p>
                      A view is an HTML file stored in this bundle under <code>views/</code>, registered by a{" "}
                      <code>type: View</code> document that gives it a title, points at the file, and declares how much
                      of the bundle it may see. A live-data view is executable HTML, so its exact bytes must be
                      approved before it can see bundle data. It runs in a sandboxed frame with direct network and
                      data-API access restricted; approval is still the decision to trust that code. The declaration
                      is what the badge on its card reports:
                    </p>
                    <ul>
                      <li>
                        <strong>live data</strong> — reads documents through a narrow, read-only channel, so it redraws
                        itself as they change.
                      </li>
                      <li>
                        <strong>can edit</strong> — the same reads, plus it may propose one field change, which only
                        takes effect when you confirm it.
                      </li>
                      <li>
                        <strong>artifact</strong> — self-contained HTML; the shell refuses it bundle data entirely.
                      </li>
                    </ul>
                    <p>
                      Worked examples — including the bridge client to copy — ship with the CLI under{" "}
                      <code>examples/views/</code>. (Views used to be called pages; the legacy{" "}
                      <code>type: Page</code> name is no longer read — <code>superbee status</code> lists
                      leftover legacy-named documents, and the repo&apos;s migration script renames them in place.)
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="launcher-section">
            <h3>Browse</h3>
            <DocumentBrowser />
          </section>
        </div>

        <aside className="home-aside">
          <section className="launcher-section">
            <h3>Activity</h3>
            <ActivityFeed />
          </section>
          {config && (config.workspaces?.length ?? 0) > 0 && <WorkspacesBlock entries={config.workspaces} />}
        </aside>
      </div>
    </div>
  );
}

/**
 * The registered-workspaces block (tier 1: SEE, not switch — designs/home-surface). COLLAPSED by
 * default: the demo/screenshot mitigation standing in for the deferred catalog privacy flag. Each
 * row expands to its path + copy-paste open command; no availability probes ride this display.
 */
function WorkspacesBlock({ entries }: { entries: WorkspaceSummaryEntry[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <section className="launcher-section">
      <h3>
        <button type="button" className="workspaces-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Workspaces ({entries.length}) <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h3>
      {open && (
        <ul className="workspace-list">
          {entries.map((entry) => (
            <li key={entry.label} className="workspace">
              <button
                type="button"
                className="workspace-row"
                aria-expanded={!!expanded[entry.label]}
                onClick={() => setExpanded((prev) => ({ ...prev, [entry.label]: !prev[entry.label] }))}
              >
                <span className="workspace-name">{entry.label}</span>
                {entry.open && <span className="workspace-open">open</span>}
                <span className="workspace-caret" aria-hidden="true">
                  {expanded[entry.label] ? "−" : "+"}
                </span>
              </button>
              {expanded[entry.label] && (
                <>
                  <span className="workspace-path">{entry.path}</span>
                  {!entry.open && (
                    <span className="workspace-cmd">
                      open with <code>superbee ui --dir {entry.path}</code>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PageCard({ page }: { page: PageEntry }) {
  const when = formatWhen(page.timestamp);
  const badge = BRIDGE_BADGES[page.bridge];
  return (
    <button type="button" className="launcher-card" data-page-id={page.id} onClick={() => navigate({ view: "page", id: page.id })}>
      <h3>{page.title}</h3>
      {page.description && <p className="launcher-card-desc">{page.description}</p>}
      <p className="launcher-card-provenance">
        <span className={badge.className}>{badge.label}</span>
        {page.actor && <span className="launcher-card-actor">{page.actor}</span>}
        {when && <span className="launcher-card-when">{when}</span>}
      </p>
    </button>
  );
}
