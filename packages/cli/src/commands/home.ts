// `axi` (zero-arg) — the content-first home view.
//
// This is the SessionStart hook payload: it loads on EVERY new session, so it MUST render cheaply
// without awaiting the network. Per AXI §8 ("no-args shows live content, not a manual"), it leads
// with a compact, LIVE dashboard of the CWD's bundle when one is discoverable — total doc count, counts by type,
// and a small capped list of the most recent docs in the minimal list schema — and falls back to
// today's identity + command-reference view when no bundle is discoverable. It ALWAYS exits 0,
// whether a bundle is present OR not and whether the bundle read succeeds OR fails (it never
// throws).
//
// RENDER GUARANTEE: the dashboard path passes only a local directory to `openBundle`; an explicit
// `--remote` produces an offline pointer and never constructs a RemoteBackend here. The local read
// is CHEAP (ONE `query()` — the sanctioned single bundle walk, gate 3; NO `loadKinds`, NO
// `freshness`, NO graph/backlink walk) and DOUBLE-GUARDED: the default summarizer swallows any
// throw into `null` (no bundle, permissions, malformed bundle — all become "no bundle"), and
// `home()` wraps the call in its OWN try/catch too, so even an injected/misbehaving dep can never
// fail a session.
//
// BOARD AWARENESS: home additionally renders a `board` block — the
// strings ("since this machine last synced", per-doc human lines, the unpushed/uncommitted
// backstop, `board: up to date`) — read from the per-clone awareness CACHE (`cursor.ts`) that
// sync/session-start's pull steps write. The RENDER's OFFLINE GUARANTEE is preserved: the default
// board loader spawns git for LOCAL-ONLY plumbing (rev-parse/status against the checkout on disk —
// never fetch/pull/push, no network I/O of any kind), reuses sync.ts's exported
// `resolveBundleKey` (the one state-key derivation, preserving cache-per-clone identity), and is
// double-guarded like the summarizer: any throw (git missing, no repo, unreadable state) degrades
// to "no board block", never a failed session. The live "did a pull just happen / fail" signal is
// NEVER probed here — `session-start` (the pull-then-render hook command) passes its own pull
// outcome IN-PROCESS via `HomeDeps.boardPull`; a plain `home` render labels the cache with
// `as_of` instead of guessing at network state.
//
// OPPORTUNISTIC FRESHNESS — two deliberate, bounded amendments to "home never touches the
// network": (1) a plain LOCAL `home` invocation — a board-READING command — first
// runs autopull.ts's `maybeAutoPull`, the silent, time-boxed, ff-only, detection-gated stale-cache
// pull every board-reading command shares. Everything the old guarantee protected still holds
// structurally: the RENDER itself (everything below the trigger) is fs + local-git only and never
// blocked by the pull (the trigger is bounded and fail-soft, and with the network off it degrades
// to at most one bounded fetch attempt per staleness window); a `--remote`-scoped home never
// triggers it, and neither does ANY session-start-driven render — session-start passes a defined
// `deps.boardPull` on EVERY path, including its no-repo/no-board/pull-threw ones, precisely so
// its own budget race stays the only network bound in that flow (test-pinned). Home still NEVER
// provisions and still exits 0 in every case. (2) eligible default TOON may synchronously inspect
// private cached update state and launch one DETACHED worker; the render awaits neither its npm
// request nor child close. JSON and suppressor paths bypass that owner entirely.
//
// PROJECT-BINDING PEEK: home consults `.agentstate.json` only when no explicit flag is present. A
// local path scopes the dashboard; a URL binding is rejected by `resolveProjectBinding` and shown as
// a non-fatal `project_binding_error`, preserving SessionStart's render-always contract.
//
// Adapted from holaxis-agentstate `packages/cli/src/commands/home.ts`.
import { cliInvocation, binPath, collapseHomeDirectory, shellArg } from "../invocation.js";
import { DESCRIPTION, commandReference, compactCommandReference } from "../reference.js";
import { render } from "../output.js";
import {
  CONVENTIONAL_BUNDLE_DIR_NAME,
  findBundleRoot,
  openBundle,
  resolveProjectBinding,
} from "../bundle.js";
import {
  deriveBundleDisplayName,
  BUNDLE_NAME_DOC_ID,
  BUNDLE_NAME_DOC_TYPE,
  type BundleNameSource,
} from "../bundle-name.js";
import { queryHeads, type OkfDocument } from "@superbee/core";
import { meaningfulChangeTimeValue } from "@superbee/core/meaningful-change-time";
import { parseArgs } from "node:util";
import path from "node:path";
import {
  BOARD_BRANCH,
  BOARD_REF,
  BUNDLE_DIR,
  countUncommitted,
  folderTreeAtHead,
  hasWorktreeSignature,
  inTreeBehindCount,
  inTreeUnpushedCount,
  inTreeUpstreamSha,
  isProvisioned,
  repoTopLevel,
  resolveInTreeUpstream,
  runGit,
  unpushedCount,
  detectBoardChannel,
  isBoardGitError,
  resolveBundleKey,
  retargetBoardInterior,
} from "@superbee/board-git";
import { maybeAutoPull } from "../autopull.js";
import { parseLeafOrUsage } from "../args.js";
import { HOME_LEAF } from "../command-spec.js";
import { defaultSyncStore, type AwarenessCache, type AwarenessDeltaRow } from "../cursor.js";
import { hookNeedsUpdate } from "./hook.js";
import { loadCatalog } from "../catalog.js";
import { staticBuildIdentity, type ArtifactChannel } from "../build-identity.js";
import {
  isPassiveUpdateSuppressed,
  runPassiveUpdateOrientation,
  type UpdateNotice,
} from "../update-orientation.js";

export const HOME_USAGE = `superbee home — render the local orientation view

Usage:
  superbee home [--dir <path> | --remote <url>] [--json] [--no-update-check]

Default TOON output may display a previously validated latest-track release notice and launch one
detached refresh at most once per 24-hour attempt window. Rendering never waits for npm. The fixed
public npm request names only superbee; it sends no installed version, cwd, bundle, actor, or
usage data beyond ordinary network metadata.

Options:
  --dir <path>       Orient from this local directory
  --remote <url>     Show offline guidance for this explicit remote
  --json             Emit stable compact JSON; no notice or refresh work is performed
  --no-update-check  Disable both cached notice display and detached refresh for this run
  -h, --help         Show this help

Environment opt-outs (presence, including an empty value): SUPERBEE_NO_UPDATE_CHECK, legacy
ASLITE_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER, or CI.
`;

const HOME_OPTIONS = {
  remote: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean" },
  "no-update-check": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Shared home parser definition; internal home remains fail-soft while the explicit adapter is strict. */
export function parseHomeArgs(argv: string[]) {
  return parseArgs({ args: argv, options: HOME_OPTIONS, allowPositionals: true });
}

/** A dashboard row in the minimal list schema (AXI §2) — reuses `list.ts`'s exact projection. */
export interface HomeRow {
  id: string;
  type: string;
  title: string;
  timestamp: string;
}

/** A compact, cheap summary of the CWD's bundle — the home dashboard's content (AXI §4 aggregates). */
export interface BundleSummary {
  /**
   * Human display name from the one derivation in `bundle-name.ts` —
   * explicit `docs/bundle` doc, else the conventional dir's PARENT folder, else the root
   * basename — so a conventional bundle identifies its PROJECT, not the `.agentstate-lite`
   * folder every project shares. Optional: injected test fakes may omit it (block omits the
   * field then).
   */
  name?: string;
  /** Which chain rung produced `name` — `conventional-parent` gates the one-line rename hint. */
  nameSource?: BundleNameSource;
  /** Home-collapsed bundle root path (AXI §7 — WHICH bundle this dashboard reflects). */
  root: string;
  /** Total concept count. */
  docs: number;
  /** Count by frontmatter `type`, sorted by count desc then type asc (deterministic). */
  byType: Record<string, number>;
  /** The most-recent docs (timestamp desc, capped) in the minimal schema. Empty rows when docs===0. */
  recent: { shown: number; total: number; rows: HomeRow[] };
}

/**
 * A bundle root WAS discovered from the CWD, but reading it failed (e.g. a malformed/unreadable
 * doc). DISTINCT from "no bundle discoverable" (which is `null`): the home view must NOT tell an
 * agent to `init` over a bundle that already exists — see {@link buildHomeView}.
 */
export interface UnreadableBundle {
  root: string;
  unreadable: true;
}

/**
 * A committed `.agentstate.json` binding home resolved for ITSELF (see the module header's
 * PROJECT-BINDING PEEK) — surfaced as a `via` annotation on the local bundle block it drove, so the
 * view stays honest about where a non-cwd-walk resolution came
 * from without changing byte-identical output for the common no-binding case.
 */
export interface HomeBindingNote {
  file: string;
  target: string;
}

/** The deliberately small user-scoped catalog projection shown during agent orientation. */
export interface HomeWorkspace {
  label: string;
}

export type HomeWorkspacesBlock =
  | {
      count: number;
      shown: number;
      entries: HomeWorkspace[];
      help: string;
    }
  | {
      status: "unavailable";
      note: string;
      help: string;
    };

/** Cap on the home dashboard's "recent docs" list — small, every-session token budget (AXI §7). */
const HOME_RECENT_LIMIT = 5;
/** Catalog orientation must remain a cheap hint even when an entry points at a slow filesystem. */
export const HOME_WORKSPACES_BUDGET_MS = 500;
/** Cap the always-on workspace orientation block; the full catalog remains one explicit read away. */
const HOME_WORKSPACES_LIMIT = 15;

/** Injectable seam so the offline view is unit-testable without real I/O. */
export interface HomeDeps {
  /** The home-collapsed absolute path of the running executable (the `bin:` identity field). */
  binPath: () => string;
  /** The runnable command prefix for emitted next-step hints (bare bin, else `npx -y …`). */
  invocation: () => string;
  stdout: (s: string) => void;
  /**
   * Produce the live bundle dashboard for the CWD: a full {@link BundleSummary}, an
   * {@link UnreadableBundle} sentinel when a bundle exists but could not be read, or `null` when no
   * bundle is discoverable. Defaults to {@link defaultSummarizeBundle}. Tests inject a fake here
   * instead of doing real FS I/O.
   */
  summarizeBundle: () => Promise<BundleSummary | UnreadableBundle | null>;
  /**
   * The board-awareness probe — LOCAL git + the per-clone state file, never a
   * network op. Defaults to {@link defaultLoadBoardStatus}; tests inject a fake.
   */
  loadBoardStatus: (dir?: string) => Promise<BoardStatus | null>;
  /**
   * The in-process pull outcome from `session-start` (the pull-then-render hook command). Plain
   * `home` leaves it undefined — home itself NEVER pulls.
   */
  boardPull?: BoardPullOutcome;
  /**
   * True when an installed managed SessionStart hook predates `session-start`. Defaults to
   * hook.ts's {@link hookNeedsUpdate} (fs-only reads).
   */
  hookNeedsUpdate: () => boolean;
  /**
   * The opportunistic board-freshness trigger (see the module header's OPPORTUNISTIC FRESHNESS
   * note). Default: autopull.ts's `maybeAutoPull` with `requireBoardBundle: false` (home has no
   * single target bundle — it always renders the board block). Never runs when `boardPull` is
   * present — and session-start passes one on EVERY path, even no-board/failed ones — or for a
   * `--remote`-scoped view.
   */
  autoPull: (dir?: string) => Promise<unknown>;
  /** Read the machine-local workspace catalog. Fs-only; failures never fail the home render. */
  loadWorkspaces: (signal?: AbortSignal) => Promise<HomeWorkspace[]>;
  /** Maximum time catalog orientation may add to home/session-start. */
  workspaceBudgetMs: number;
  /** Synchronous, bounded private update-cache/lease/process owner. */
  updateOrientation: () => UpdateNotice | undefined;
  /** Passive suppression is key-presence based; injected so tests never mutate process-global env. */
  updateEnvironment: Readonly<Record<string, string | undefined>>;
}

/** A doc's `title` with the SAME fallback `list.ts` uses (frontmatter `title`, else the id's tail). */
function rowTitle(id: string, title: unknown): string {
  return typeof title === "string" ? title : (id.split("/").pop() ?? id);
}

/**
 * PURE: fold a scan result into the dashboard summary — count by `type` (count desc, type asc)
 * and the timestamp-desc / missing-last / id-asc-tiebreak `recent` list capped at
 * {@link HOME_RECENT_LIMIT}. Separated from the I/O in {@link defaultSummarizeBundle} so the sort +
 * cap is directly unit-testable with many docs (incl. missing/tied timestamps) without a real
 * bundle on disk. Input is structural (`id` + `frontmatter` only — the dashboard never reads a
 * body), so both full documents and `queryHeads` head projections fold identically.
 */
export function summarizeDocs(docs: Array<Pick<OkfDocument, "id" | "frontmatter">>, root: string): BundleSummary {
  const byType: Record<string, number> = {};
  for (const d of docs) {
    const t = typeof d.frontmatter.type === "string" ? d.frontmatter.type : "";
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const sortedByType = Object.fromEntries(
    Object.entries(byType).sort(([ta, ca], [tb, cb]) => cb - ca || ta.localeCompare(tb)),
  );

  const rows: HomeRow[] = docs.map((d) => {
    const timestamp = meaningfulChangeTimeValue(d.frontmatter);
    return {
      id: d.id,
      type: typeof d.frontmatter.type === "string" ? d.frontmatter.type : "",
      title: rowTitle(d.id, d.frontmatter.title),
      timestamp: typeof timestamp === "string" ? timestamp : "",
    };
  });
  // Timestamp desc; missing/empty timestamp sorts LAST; id asc as a deterministic tiebreak.
  rows.sort((a, b) => {
    if (a.timestamp && b.timestamp) {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
    } else if (a.timestamp !== b.timestamp) {
      return a.timestamp ? -1 : 1; // has-timestamp sorts before empty
    }
    return a.id.localeCompare(b.id);
  });

  return {
    root,
    docs: docs.length,
    byType: sortedByType,
    recent: {
      shown: Math.min(rows.length, HOME_RECENT_LIMIT),
      total: rows.length,
      rows: rows.slice(0, HOME_RECENT_LIMIT),
    },
  };
}

/**
 * The default `summarizeBundle`: a LOCAL-only bundle discovery (`openBundle(undefined, undefined)` —
 * never constructs a `RemoteBackend`) + ONE `queryHeads()` scan, folded by {@link summarizeDocs}
 * (the dashboard is a frontmatter-only consumer — head projections are its natural shape, and if
 * this path ever gains a remote variant, bodies stay off the wire by construction). The two
 * failure modes are DISTINGUISHED, not both collapsed to `null`: if discovery throws (no `index.md`
 * up-tree), return `null` (the "run init" fallback); if a bundle root IS found but the read throws
 * (a malformed/unreadable doc), return an {@link UnreadableBundle} sentinel so home never tells an
 * agent to `init` over a bundle that already exists. Cheap: ONE scan (the sanctioned single
 * bundle walk, gate 3), no kinds/freshness/graph load.
 */
export async function defaultSummarizeBundle(dir?: string): Promise<BundleSummary | UnreadableBundle | null> {
  let bundle;
  try {
    bundle = await openBundle(dir, undefined);
  } catch {
    return null; // no bundle discoverable up-tree (NOT_FOUND) — the offline "run init" fallback
  }
  try {
    const docs = await queryHeads(bundle);
    // ONE extra known-id read (absent-tolerant, never throws, fs-only for home's always-local
    // bundle) — the same display-name chain the ui server's config uses (bundle-name.ts).
    const { name, source } = await deriveBundleDisplayName(bundle);
    return { name, nameSource: source, ...summarizeDocs(docs, collapseHomeDirectory(bundle.root)) };
  } catch {
    // A bundle root exists but could not be read — DISTINCT from "no bundle" (see UnreadableBundle).
    return { root: collapseHomeDirectory(bundle.root), unreadable: true };
  }
}

/**
 * `defaultSummarizeBundle` with DISCOVERY semantics: walk up from `startDir` for the nearest
 * bundle root (a level's own `index.md`, else its conventional `.agentstate-lite/index.md` —
 * bundle.ts's one walk) and summarize THAT. session-start's `--dir` bridge uses this when no
 * board resolved because its `--dir` may name a nested run directory. Ordinary explicit `--dir`
 * accepts the requested bundle or its direct conventional child, but never selects an ancestor.
 */
export async function discoverSummarizeBundle(
  startDir: string,
): Promise<BundleSummary | UnreadableBundle | null> {
  try {
    const root = await findBundleRoot(path.resolve(startDir));
    return root ? defaultSummarizeBundle(root) : null;
  } catch {
    return null;
  }
}

/** Load labels without probing locators; paths, ids, and live availability stay behind catalog commands. */
export async function defaultLoadWorkspaces(home?: string, signal?: AbortSignal): Promise<HomeWorkspace[]> {
  return (await loadCatalog(home, signal)).entries
    .map(({ label }) => ({ label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── board awareness ───────────────────────────────────────────────────────────

/**
 * The IN-PROCESS pull outcome `session-start` hands the render (never persisted — the honest
 * "did THIS run reach the remote" signal only the process that just pulled can give).
 */
export interface BoardPullOutcome {
  /**
   * True when this run could NOT confirm the board's currency: the fetch failed (offline, auth,
   * a held lock), the pull lost its time box, or the pull step threw. Renders the pinned
   * {@link BOARD_OFFLINE_NOTE}.
   */
  offline: boolean;
  /**
   * True ONLY when this run's pull SUCCEEDED and rewrote the awareness cache (including the
   * re-anchor path — that writes a cache too). This is the explicit signal that lets the render
   * skip the `as_of` freshness label; every other outcome — offline, a local-state swallow
   * (diverged/dirty), a lost time box — leaves the cache as it was, so the label must attach.
   */
  refreshed?: boolean;
  /** Rider-2 provisioning announcements when THIS run provisioned/repaired the checkout. */
  announcement?: Record<string, string>;
  /** Additional honest condition lines (e.g. a non-network pull skip pointing at `sync`). */
  notes?: string[];
  /**
   * The provisioned board checkout the pull step resolved (absolute). session-start uses it to
   * point an explicit `--dir <project>` invocation's dashboard at the resolved board checkout;
   * that checkout is not necessarily the project's direct conventional child.
   */
  boardPath?: string;
}

/** What the fs+local-git board probe found for the render (see {@link defaultLoadBoardStatus}). */
export type BoardStatus =
  /** A board exists for this repo (local `board` branch or `origin/board`) but is NOT checked out. */
  | { state: "unprovisioned" }
  /**
   * The BOTH-WORLDS window (or its post-cleanup remnant): a fetched `origin/board` exists while
   * `.agentstate-lite/` is still committed at HEAD. `line` carries the ONE shared factory's truth
   * (the same message sync's refusal renders — pull-first, or the untrack escape), so home never
   * says "run sync" for a sync that would only refuse.
   */
  | { state: "window"; line: string }
  | {
      state: "provisioned";
      /** The last pull step's awareness cache (null: never pulled from this clone). */
      cache: AwarenessCache | null;
      /** Actors this clone's own syncs committed — filtered from the human count (cursor.ts). */
      selfActors: string[];
      /** LIVE local backstop counts (git plumbing against the checkout — network-free). */
      unpushed: number | null;
      uncommitted: number | null;
    }
  /** An IN-TREE board (board-git PR C): the bundle committed with code on the current branch. */
  | {
      state: "in-tree";
      /** The last in-tree fetch step's awareness cache (null: never checked from this clone). */
      cache: AwarenessCache | null;
      /** Actors this clone authored (sync commits + the post-persist doc-write hook). */
      selfActors: string[];
      /** PREFIX-SCOPED board commits on this branch not yet pushed; null = no upstream basis. */
      unpushed: number | null;
      /** PREFIX-SCOPED uncommitted board changes. */
      uncommitted: number | null;
      /** PREFIX-SCOPED upstream board commits not yet pulled; null = no upstream basis. */
      behind: number | null;
    };

// The board block's guidance-line templates live in THE sync-outcome table (../sync-outcomes.ts);
// these re-exports keep the module's historical import surface stable.
import {
  BOARD_IN_TREE_LINE,
  BOARD_OFFLINE_NOTE,
  BOARD_UP_TO_DATE,
  boardFirstContactLine,
  inTreePullHintLine,
  inTreeUncommittedLine,
  inTreeUnpushedLine,
  uncommittedLine,
  unpushedLine,
} from "../sync-outcomes.js";
export {
  BOARD_IN_TREE_LINE,
  BOARD_OFFLINE_NOTE,
  BOARD_UP_TO_DATE,
  boardFirstContactLine,
  inTreePullHintLine,
  inTreeUncommittedLine,
  inTreeUnpushedLine,
  uncommittedLine,
  unpushedLine,
} from "../sync-outcomes.js";

/** Cap on the rendered per-doc human lines (the since-line header carries the full count). */
export const BOARD_CHANGES_SHOWN_LIMIT = 10;

/** In-tree since-header: session-start's fetch is the "check", there is no sync verb here. */
export const IN_TREE_SINCE_FIELD = "since_this_machine_last_checked";

/** The hook-reinstall prompt: the installed hook predates `session-start`. */
export function hookUpdateNote(inv: string): string {
  return `the installed SessionStart hook predates \`session-start\` — re-run \`${inv} hook install\` to pick up the board-aware hook`;
}

/**
 * The actor phrase is built from the actual actors of visible rows rather than assuming one
 * teammate — unique, first-appearance order: "mike", "mike and sara",
 * "mike, sara and jo".
 */
export function actorPhrase(rows: Array<Pick<AwarenessDeltaRow, "actor">>): string {
  const actors: string[] = [];
  for (const r of rows) if (!actors.includes(r.actor)) actors.push(r.actor);
  if (actors.length <= 1) return actors[0] ?? "";
  return `${actors.slice(0, -1).join(", ")} and ${actors[actors.length - 1]}`;
}

/** "3 board changes from mike" — the machine-honest since-line's value (label = the field key). */
export function sinceLine(rows: Array<Pick<AwarenessDeltaRow, "actor">>): string {
  const n = rows.length;
  return `${n} board ${n === 1 ? "change" : "changes"} from ${actorPhrase(rows)}`;
}

/** One per-doc human line: `mike · updated Task "Seed one"` (kind omitted when unknown). */
export function docLine(row: Pick<AwarenessDeltaRow, "actor" | "verb" | "kind" | "title">): string {
  const kindPart = row.kind && row.kind !== "unknown" ? `${row.kind} ` : "";
  return `${row.actor} · ${row.verb} ${kindPart}"${row.title}"`;
}

/** `n` when it parses as a live count; the cache's persisted count otherwise (last-known fallback). */
function countOr(live: number | null, cached: number | undefined): number {
  return live ?? cached ?? 0;
}

/**
 * PURE: fold the board status + the (optional) in-process pull outcome into the rendered block.
 * Returns `block` (a string — the pinned "up to date" — or the record of moment-(e) lines) for a
 * provisioned board, or `firstContact` (the "run sync, never init" line) for a detected-but-
 * unprovisioned one. Self-authored rows (actor ∈ selfActors) are filtered from the human count;
 * `as_of` labels every render whose pull did NOT refresh the cache (plain home, an offline
 * session-start, a local-state-swallowed pull) so a stale cache never reads as current — only
 * `pull.refreshed` skips it.
 */
export function buildBoardBlock(
  status: BoardStatus | null,
  pull: BoardPullOutcome | undefined,
  inv: string,
): { block?: string | Record<string, unknown>; firstContact?: string } {
  if (!status) return {};
  if (status.state === "unprovisioned") return { firstContact: boardFirstContactLine(inv) };
  // The window line rides the firstContact slot: same above-the-fold placement, same init-hint
  // suppression — but the copy is the sync refusal's own truth, not a "run sync" that would refuse.
  if (status.state === "window") return { firstContact: status.line };
  const inTree = status.state === "in-tree";

  const rec: Record<string, unknown> = {};
  if (pull?.announcement) Object.assign(rec, pull.announcement);
  const rows = status.cache?.delta ?? [];
  const visible = rows.filter((r) => !status.selfActors.includes(r.actor));
  if (visible.length > 0) {
    // CURSOR HONESTY: labeled by MACHINE reality — the cursor is
    // per-clone state, not a cross-machine per-person one (that defers to the hosted tier). The
    // in-tree header says "checked", not "synced": the fetch step is the check there, and the
    // rows are UPSTREAM changes `git pull` delivers, not changes already merged locally.
    rec[inTree ? IN_TREE_SINCE_FIELD : "since_this_machine_last_synced"] = sinceLine(visible);
    rec.changes = visible.slice(0, BOARD_CHANGES_SHOWN_LIMIT).map(docLine);
  }
  const unpushed = countOr(status.unpushed, status.cache?.unpushedCount);
  const uncommitted = countOr(status.uncommitted, status.cache?.uncommittedCount);
  if (unpushed > 0) rec.unpushed = inTree ? inTreeUnpushedLine(unpushed) : unpushedLine(unpushed);
  if (uncommitted > 0) rec.uncommitted = inTree ? inTreeUncommittedLine(uncommitted) : uncommittedLine(uncommitted);
  const notes: string[] = [];
  if (inTree && (status.behind ?? 0) > 0) notes.push(inTreePullHintLine(status.behind!));
  if (pull?.offline) notes.push(BOARD_OFFLINE_NOTE);
  if (pull?.notes) notes.push(...pull.notes);
  if (status.cache?.note) notes.push(status.cache.note);
  if (notes.length > 0) rec.note = notes.join("; ");
  // Freshness labeling: only a render straight after a SUCCESSFUL pull (pull.refreshed — the
  // pull actually rewrote the cache) may skip it. Everything else — plain home, an offline pull,
  // AND a local-state swallow (diverged/dirty: offline:false but the cache was NOT refreshed) —
  // must label the cache's age; otherwise a swallowed local-state result can masquerade as fresh.
  if (status.cache && !pull?.refreshed && Object.keys(rec).length > 0) {
    rec.as_of = status.cache.updatedAt;
  }
  // The quiet in-tree state renders the mode line, not "up to date": a plain in-tree render never
  // fetched, so it cannot claim currency — the mode line is true either way (and doubles as the
  // first-contact copy: board rides this branch; pull normally).
  if (Object.keys(rec).length === 0) return { block: inTree ? BOARD_IN_TREE_LINE : BOARD_UP_TO_DATE };
  return { block: rec };
}

/**
 * The default board-status probe: LOCAL git plumbing only (never a fetch — the OFFLINE GUARANTEE
 * holds; see the module header). Unprovisioned first-contact detection is PROBE-GATED on the
 * board ref's existence (`origin/board` — present in any full clone's local refs — or a local
 * `board` branch), NEVER marker-only: under per-clone state keying a brand-new clone has no
 * marker until its first pull (sync-cache-per-clone rider), and the marker's key derivation needs
 * the same git calls anyway, so the ref probe is strictly stronger AND equally offline. Every
 * failure mode (no git binary, not a repo, unreadable state file) degrades to `null` — no board
 * block, never a failed session.
 */
export async function defaultLoadBoardStatus(dir?: string): Promise<BoardStatus | null> {
  try {
    // Retarget when sitting INSIDE the board worktree (exactly where an agent lands after
    // `doc write --dir .agentstate-lite`) — otherwise the worktree reads as its OWN repo top,
    // `<board>/.agentstate-lite` doesn't exist, and the shared refs would misreport the live
    // board as "unprovisioned".
    const top = repoTopLevel(retargetBoardInterior(dir ?? process.cwd()));
    if (!top) return null;
    const boardPath = path.join(top, BUNDLE_DIR);
    if (!isProvisioned(top)) {
      const remoteRefExists =
        runGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]).status === 0;
      const probed =
        remoteRefExists ||
        runGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${BOARD_BRANCH}`]).status === 0;
      // THE BOTH-WORLDS WINDOW, from LOCAL EVIDENCE ONLY: the folder is committed at HEAD
      // while a previously FETCHED origin/board ref exists. Sync would refuse this state with the
      // window/remnant/dual-board guidance — so home renders THAT truth instead of a "run sync"
      // dead end. The refusal copy is reused verbatim by running channel detection with an
      // INJECTED offline probe (the fetched ref IS the evidence — no network, the offline
      // guarantee holds) and catching the typed refusal it throws.
      if (remoteRefExists && folderTreeAtHead(top) !== null && !hasWorktreeSignature(boardPath)) {
        try {
          detectBoardChannel(top, { remoteBoardState: () => "exists" });
        } catch (err) {
          if (isBoardGitError(err)) return { state: "window", line: err.message };
          throw err; // the outer catch degrades to null — never a failed session
        }
      }
      if (probed) return { state: "unprovisioned" };
      // IN-TREE probe (board-git PR C) — ORDERED AFTER the board-ref probes, so every state that
      // rendered before PR C (branch/join/pre-share, all carrying board refs) keeps its exact
      // routing; only states that previously rendered NOTHING can newly render the in-tree block.
      // This is deliberately home's own LOCAL-EVIDENCE approximation, not `detectBoardChannel`:
      // the render's offline guarantee forbids the act-time remote probe, and the mode line it
      // gates is true regardless of what a live probe would add (the folder IS committed on the
      // branch). Mode-SENSITIVE decisions (sync's routing, establish) stay with act-time detection.
      if (folderTreeAtHead(top) !== null && !hasWorktreeSignature(boardPath)) {
        const key = resolveBundleKey(boardPath);
        const state = await defaultSyncStore.readSyncState(key);
        const upstream = resolveInTreeUpstream(top);
        const sha = upstream.state === "ok" ? inTreeUpstreamSha(top, upstream.config.ref) : null;
        return {
          state: "in-tree",
          cache: state.cache,
          selfActors: state.selfActors ?? [],
          unpushed: sha === null ? null : inTreeUnpushedCount(top, sha),
          uncommitted: countUncommitted(top, BUNDLE_DIR),
          behind: sha === null ? null : inTreeBehindCount(top, sha),
        };
      }
      return null;
    }
    const key = resolveBundleKey(boardPath);
    const state = await defaultSyncStore.readSyncState(key);
    let uncommitted: number | null;
    try {
      uncommitted = countUncommitted(boardPath);
    } catch {
      uncommitted = null;
    }
    return {
      state: "provisioned",
      cache: state.cache,
      selfActors: state.selfActors ?? [],
      unpushed: unpushedCount(boardPath),
      uncommitted,
    };
  } catch {
    return null;
  }
}

/**
 * Build the home view object (PURE — no I/O). Insertion order is the rendered TOON field order:
 * identity header FIRST (AXI §10 — identify the tool before live data; a one-line identity header
 * is not "the manual"), then the LIVE `bundle` dashboard (when present — AXI
 * §8, content above the manual), then the command reference (the manual, now demoted below live
 * content), then the static kind/remote-env pointers. When no bundle is discoverable, `bundle` is
 * omitted and a `getting_started` hint (pointing at `init`) is inserted just before `commands`.
 *
 * `binding` (when the caller's own project-binding peek resolved one — see the module header)
 * annotates whichever block it drove with a `via` field naming the `.agentstate.json` file, WITHOUT
 * changing that block's shape otherwise. `bindingError` (a malformed binding file — never a thrown
 * exception, since home must never crash) renders as a standalone `project_binding_error` note.
 */
export function buildHomeView(
  deps: {
    binPath: () => string;
    invocation: () => string;
    identity?: () => { version: string; channel: ArtifactChannel };
    /** Preserve an explicit home --dir selector in every emitted mutating follow-up command. */
    targetDir?: string;
  },
  summary?: BundleSummary | UnreadableBundle | null,
  remote?: string,
  binding?: HomeBindingNote,
  bindingError?: string,
  board?: { block?: string | Record<string, unknown>; firstContact?: string },
  hookUpdate?: string,
  workspaces?: HomeWorkspacesBlock,
  updateNotice?: UpdateNotice,
): Record<string, unknown> {
  const inv = deps.invocation();
  const ref = commandReference(inv);

  const projectedIdentity = deps.identity?.();
  const view: Record<string, unknown> = {
    superbee: {
      bin: deps.binPath(),
      ...(projectedIdentity
        ? { version: projectedIdentity.version, channel: projectedIdentity.channel }
        : {}),
      description: DESCRIPTION,
    },
  };
  if (updateNotice) view.update_notice = updateNotice;

  if (remote) {
    // Scoped to a remote bundle: an OFFLINE orientation pointer (home never fetches — it is the
    // every-session hook payload and must stay cheap). No local bundle block, no `init` nudge; point
    // the agent at the commands that DO read the remote. Resolves the #6 gap where the canonical
    // `superbee --remote <url>` invocation errored instead of orienting.
    const remoteBlock: Record<string, unknown> = {
      url: remote,
      help: [
        `${inv} list --remote ${remote}`,
        `${inv} status --remote ${remote}`,
      ],
    };
    if (binding && binding.target === remote) remoteBlock.via = binding.file;
    view.remote = remoteBlock;
  } else if (summary && "unreadable" in summary) {
    // A bundle EXISTS here but could not be read (a malformed doc) — NOT "no bundle". Never emit the
    // `getting_started`/`init` hint (that would tell an agent to init over an existing bundle);
    // point at `list`, which will surface the actual parse error.
    const bundleBlock: Record<string, unknown> = {
      root: summary.root,
      status: "unreadable",
      help: `a document in this bundle could not be read — run \`${deps.invocation()} list\` to surface the parse error`,
    };
    // `remote` is guaranteed falsy in this branch (the `if (remote)` branch above already returned),
    // so a present `binding` here can only be the directory-type half — see the module header.
    if (binding) bundleBlock.via = binding.file;
    view.bundle = bundleBlock;
  } else if (summary) {
    const bundleBlock: Record<string, unknown> = {};
    // Identity first: the derived project name, so a conventional
    // `.agentstate-lite` bundle reads as ITS project, not as the folder every project shares.
    if (summary.name) {
      bundleBlock.name = summary.name;
      // Progressive disclosure: when the name is merely derived from the parent
      // folder, one line teaches the explicit override — the only shipped surface that names the
      // exact command. Home-only (the ui config stays machine-clean), and only for rung (b), so
      // an explicitly named bundle never sees it.
      if (summary.nameSource === "conventional-parent") {
        bundleBlock.name_help = `name derived from the project folder — set it explicitly: ${deps.invocation()} doc write ${BUNDLE_NAME_DOC_ID} --type "${BUNDLE_NAME_DOC_TYPE}" --title "<name>"`;
      }
    }
    bundleBlock.root = summary.root;
    bundleBlock.docs = summary.docs;
    bundleBlock.by_type = summary.byType;
    if (summary.docs > 0) {
      bundleBlock.recent = summary.recent;
      bundleBlock.next = [
        `${deps.invocation()} list`,
        `${deps.invocation()} status`,
      ];
    } else {
      // Definitive empty state (AXI §5), distinct from "no bundle at all": the bundle exists but
      // has no docs yet.
      bundleBlock.help = `${deps.invocation()} new "Context Note" <id> … | ${deps.invocation()} doc write … — create the first doc`;
    }
    if (binding) bundleBlock.via = binding.file;
    view.bundle = bundleBlock;
  } else if (!bindingError && !board?.firstContact && board?.block === undefined) {
    // A live board block (or the first-contact line) supersedes the init hint entirely: a project
    // with a provisioned/detected board HAS its bundle — "run init" there is the divergent-
    // second-bundle footgun.
    if (binding) {
      // A reached binding is always local. Its target may have disappeared, but it remains the
      // committed selection: never suggest an unscoped init that would mint a divergent cwd bundle,
      // and do not advertise recipes until the broken binding is repaired (recipes fails closed).
      const target = ` --dir ${shellArg(binding.target)}`;
      view.getting_started =
        `project binding ${binding.file} -> ${binding.target} did not resolve to a bundle — ` +
        `run \`${deps.invocation()} init --recipe none${target}\` to recreate that bound bundle, ` +
        `or fix/remove the binding before browsing recipes`;
    } else {
      const createTarget = path.join(deps.targetDir ?? ".", CONVENTIONAL_BUNDLE_DIR_NAME);
      const target = ` --dir ${shellArg(createTarget)}`;
      view.getting_started =
        `no OKF bundle found in this directory — run \`${deps.invocation()} init --create-only --recipe none${target}\` ` +
        `to create a blank bundle, or \`${deps.invocation()} recipes\` to compare available workspace setups` +
        `; create your chosen setup here with \`${deps.invocation()} init --create-only --recipe <name>${target}\``;
    }
  }
  // The board block. FIRST-CONTACT footgun guard: when a board exists for this
  // repo but isn't provisioned, the line above the fold is "run sync" — and the `init` hint is
  // SUPPRESSED entirely (the else-if above), so a founder can never be told to init a divergent
  // second bundle by our own hint.
  if (board?.firstContact) {
    view.board = board.firstContact;
  } else if (board?.block !== undefined) {
    view.board = board.block;
  }
  if (hookUpdate) {
    // Re-install prompt: self-clearing (disappears once `hook install` is re-run).
    view.hook_update = hookUpdate;
  }
  if (bindingError) {
    // A malformed .agentstate.json — never a thrown exception (home must never crash the
    // SessionStart hook), surfaced instead as a visible, non-fatal note.
    view.project_binding_error =
      `${bindingError}; fix or remove the binding before initializing or browsing recipes`;
  }
  if (workspaces) view.workspaces = workspaces;

  // Compact command list (names per group + a `--help` pointer) — the home view is the SessionStart
  // hook payload, so it stays token-lean; the FULL usage/summary reference is the `--help` view.
  const compact = compactCommandReference(inv);
  view.commands = compact.commands;
  view.commands_help = compact.commands_help;
  view.kinds = ref.kinds;
  view.remote_env = ref.remoteEnv;
  return view;
}

/**
 * CLI entry for the zero-arg home view. Reads the live bundle summary (LOCAL only,
 * double-guarded), builds the view, and writes TOON. Exits 0 in EVERY case — bundle
 * present/absent/unreadable — so a SessionStart hook can never fail a session.
 */
export async function home(argv: string[], deps: Partial<HomeDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  // Exact-token pre-scan is deliberately independent of forgiving parsing: a malformed sibling
  // option must never accidentally re-enable passive work requested off by the caller.
  const passiveSuppressed = isPassiveUpdateSuppressed(
    argv,
    deps.updateEnvironment ?? process.env,
  );

  // Parse the home-compatible global flags. Best-effort — an unknown/bad flag just yields the bare
  // local view (home NEVER throws). `--remote <url>` scopes the view to a remote (offline: a pointer
  // + next-steps, NOT a fetch — the every-session hook payload must stay cheap); `--dir <path>`
  // summarizes THAT directory's bundle instead of the CWD.
  let remote: string | undefined;
  let dir: string | undefined;
  let explicitDir: string | undefined;
  let jsonMode = false;
  let helpMode = false;
  try {
    const parsed = parseHomeArgs(argv);
    remote = parsed.values.remote;
    explicitDir = parsed.values.dir;
    dir = explicitDir;
    jsonMode = Boolean(parsed.values.json);
    helpMode = Boolean(parsed.values.help);
  } catch {
    /* ignore — fall back to the bare local view */
  }
  if (helpMode) {
    stdout(HOME_USAGE);
    return;
  }

  // A committed project binding (see the module header's PROJECT-BINDING PEEK) is consulted ONLY
  // when the caller passed NEITHER --remote NOR --dir themselves — the same suppression rule every
  // other rung already follows. Fs-only; never a fetch, preserving the OFFLINE GUARANTEE regardless
  // of what the binding names. A local binding scopes the summarize() call; a URL or malformed file
  // must never crash the
  // SessionStart hook, so it is caught here and surfaced as a visible `bindingError` note instead.
  let binding: HomeBindingNote | undefined;
  let bindingError: string | undefined;
  if (!remote && !dir) {
    try {
      const found = await resolveProjectBinding();
      if (found) {
        binding = { file: found.file, target: found.target };
        dir = found.target;
      }
    } catch (err) {
      bindingError = err instanceof Error ? err.message : String(err);
    }
  }

  // Opportunistic board freshness (module header, OPPORTUNISTIC FRESHNESS): plain LOCAL home only —
  // never for a --remote scope, and never when session-start already pulled in-process
  // (deps.boardPull present). Double-guarded like everything else here: the default trigger never
  // throws, and an injected/misbehaving one is caught so it can never fail the session.
  if (!remote && deps.boardPull === undefined) {
    try {
      await (deps.autoPull ?? ((d?: string) => maybeAutoPull(d, { requireBoardBundle: false })))(dir);
    } catch {
      /* best-effort freshness only — the render must always appear */
    }
  }

  const summarize = deps.summarizeBundle ?? (() => defaultSummarizeBundle(dir));

  // A --remote scope does NOT summarize (offline guarantee — the remote block orients toward the
  // fetching commands instead). Local / `--dir` scopes read the bundle as before.
  let summary: BundleSummary | UnreadableBundle | null = null;
  if (!remote) {
    try {
      summary = await summarize();
    } catch {
      summary = null; // an injected/misbehaving summarizer throwing -> offline fallback (the default one never throws)
    }
  }

  const invocation = deps.invocation ?? cliInvocation;

  // User-scoped workspace orientation is independent of the current bundle. Empty catalogs stay
  // invisible; malformed/unreadable catalogs become a compact repair pointer and can never fail
  // home or session-start. The loader projects out paths and ids before this render boundary and
  // avoids locator probes; detailed availability remains explicit via `catalog list`.
  let workspaces: HomeWorkspacesBlock | undefined;
  let workspaceTimer: ReturnType<typeof setTimeout> | undefined;
  const workspaceAbort = new AbortController();
  const loadWorkspaces =
    deps.loadWorkspaces ?? ((signal?: AbortSignal) => defaultLoadWorkspaces(undefined, signal));
  try {
    const timedOut = Symbol("workspace catalog timed out");
    const outcome = await Promise.race([
      loadWorkspaces(workspaceAbort.signal),
      new Promise<typeof timedOut>((resolve) => {
        workspaceTimer = setTimeout(
          () => resolve(timedOut),
          deps.workspaceBudgetMs ?? HOME_WORKSPACES_BUDGET_MS,
        );
      }),
    ]);
    if (outcome === timedOut) {
      workspaceAbort.abort();
      workspaces = {
        status: "unavailable",
        note: "workspace catalog check timed out",
        help: `${invocation()} catalog list`,
      };
    } else if (outcome.length > 0) {
      const entries = [...outcome]
        .sort((a, b) => a.label.localeCompare(b.label))
        .slice(0, HOME_WORKSPACES_LIMIT);
      workspaces = {
        count: outcome.length,
        shown: entries.length,
        entries,
        help:
          outcome.length > entries.length
            ? `${invocation()} catalog list`
            : `${invocation()} catalog resolve <label-or-id> --field path`,
      };
    }
  } catch {
    workspaces = {
      status: "unavailable",
      note: "workspace catalog could not be read",
      help: `${invocation()} catalog list`,
    };
  } finally {
    if (workspaceTimer) clearTimeout(workspaceTimer);
  }

  // The board block — skipped for a --remote scope (the board is a git-tier LOCAL
  // concept). Double-guarded like everything else here: a throwing probe yields no board block.
  let board: { block?: string | Record<string, unknown>; firstContact?: string } | undefined;
  if (!remote) {
    try {
      const status = await (deps.loadBoardStatus ?? defaultLoadBoardStatus)(dir);
      board = buildBoardBlock(status, deps.boardPull, invocation());
    } catch {
      board = undefined;
    }
  }

  // Hook re-install prompt (fs-only reads; guarded — never fails the session).
  let hookUpdate: string | undefined;
  try {
    if ((deps.hookNeedsUpdate ?? hookNeedsUpdate)()) hookUpdate = hookUpdateNote(invocation());
  } catch {
    hookUpdate = undefined;
  }

  let updateNotice: UpdateNotice | undefined;
  if (!jsonMode && !passiveSuppressed) {
    try {
      updateNotice = (deps.updateOrientation ?? runPassiveUpdateOrientation)();
    } catch {
      updateNotice = undefined;
    }
  }

  stdout(
    render(
      buildHomeView(
        {
          binPath: deps.binPath ?? binPath,
          invocation,
          targetDir: explicitDir,
          identity: () => {
            const build = staticBuildIdentity();
            return { version: build.package.version, channel: build.artifact.channel };
          },
        },
        summary,
        remote,
        binding,
        bindingError,
        board,
        hookUpdate,
        workspaces,
        updateNotice,
      ),
      // Honor --json (JSON is equally offline/never-throw); default remains TOON, the format the
      // SessionStart hook ingests as ambient context.
      jsonMode ? "json" : "default",
    ),
  );
}

/** Strict SDK adapter for the hidden explicit `home` route. */
export async function homeCommand(argv: string[], deps: Partial<HomeDeps> = {}): Promise<void> {
  const parsed = parseLeafOrUsage(() => parseHomeArgs(argv), HOME_LEAF);
  if (parsed.values.help) {
    (deps.stdout ?? ((s: string) => void process.stdout.write(s)))(HOME_USAGE);
    return;
  }
  await home(argv, deps);
}
