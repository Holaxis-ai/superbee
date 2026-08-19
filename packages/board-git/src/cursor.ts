// Neutral per-checkout store for sync cursors, awareness caches, pending markers, self actors,
// and the opportunistic-pull throttle. It owns schemas and serialization only: git inspection and
// document enrichment stay in the porcelain/diff layer, while disk location and atomic writes are
// injected by the CLI.
//
// State is keyed by remote URL, bundle subpath, and checkout root (or by the absolute bundle root
// without a remote). Checkout identity is load-bearing: two clones of one remote must not share a
// cursor or erase each other's unpushed backstop. The full key is stored inside the hashed file so
// a collision or recycled path reads as foreign. Old key shapes are ignored and naturally
// re-derived from git rather than destructively migrated.
//
// Writes use the injected atomic seam. Cross-process last-writer-wins is acceptable because this
// state is advisory and re-derivable. Reads never throw: absent, malformed, foreign, unreadable,
// or stale state returns `null`, and missing state must never turn into an `init` recommendation.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

/**
 * The honest re-anchor note recorded when the stored cursor can no longer be diffed from —
 * either its commit is gone (history rewritten under it) or it is no longer an ancestor of the
 * comparison tip (a branch switch repositioned it) — surfaced by the next `home` render instead
 * of the delta. NEVER a silent skip, never fatal.
 */
export const REANCHOR_NOTE = "delta unavailable (history rewritten or repositioned)";

// ── per-bundle key ────────────────────────────────────────────────────────────

/**
 * What identifies a bundle CHECKOUT for state-keying: the repo's remote URL + the bundle's
 * subpath within the repo + this checkout's absolute root (the caller — sync's command layer —
 * knows all three), or, for a repo with no remote, the absolute bundle root alone. Deliberately
 * per-CLONE, not per-remote-per-machine: two checkouts of the same shared board on one machine
 * get two keys, because the cursor and the unpushed/uncommitted backstop counts are facts about
 * ONE checkout's worktree; otherwise one clone's clean sync can erase another's stranded-unpushed
 * state. The awareness story is per-checkout too: "since
 * this checkout last synced" is the delta a session sitting in that checkout can act on.
 */
export type BundleKeySource =
  | { remoteUrl: string; subpath: string; checkoutRoot: string }
  | { root: string };

/**
 * Light, lossless-in-spirit normalization so trivially-equivalent URL spellings key together.
 * Known caveats (recorded on tasks/sync-cursor-store): ssh-vs-https spellings of one repo still
 * FALSE-SPLIT, and `.git`-stripping can FALSE-MERGE two genuinely distinct remote paths. With the
 * checkout root now in the key, both are far less load-bearing: a false-split only bites when the
 * SAME checkout's own origin URL spelling changes (the state honestly re-derives from the
 * first-sync baseline), and a false-merge can no longer merge two different clones' state — only
 * the same checkout across a `repo`↔`repo.git` remote flip, which IS the same bundle.
 */
function normalizeRemoteUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.endsWith(".git")) u = u.slice(0, -".git".length);
  return u;
}

function normalizeSubpath(subpath: string): string {
  return subpath
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Derive the canonical per-clone key string. Newline-separated fields (a newline can appear in
 * neither a git URL nor a path in practice), prefixed with the key kind so a remote-keyed and a
 * path-keyed bundle can never collide textually. The checkout root is `resolve`d (one absolute
 * spelling) but NOT realpath'd here — the store stays a pure serialization layer; a caller that
 * can sit behind symlinks (sync does, via its board-path resolution) realpaths before keying.
 */
export function bundleKey(src: BundleKeySource): string {
  if ("remoteUrl" in src) {
    return `remote\n${normalizeRemoteUrl(src.remoteUrl)}\n${normalizeSubpath(src.subpath)}\n${resolve(src.checkoutRoot)}`;
  }
  return `path\n${resolve(src.root)}`;
}

/** The truncated sha256 digest that names this key's on-disk artifacts (ONE hashing locus). */
function keyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

// ── schema ────────────────────────────────────────────────────────────────────

/**
 * The OPAQUE awareness cursor. `tier` names the sync backend that minted the token; `token` is
 * meaningful ONLY to that tier (git: a commit SHA string; a future d1 tier: a sequence number).
 * The store validates shape, never meaning, and preserves any extra fields a future tier adds —
 * so a new tier swaps in without CLI changes.
 */
export interface SyncCursor {
  readonly tier: string;
  readonly token: string | number;
  readonly [extra: string]: unknown;
}

/**
 * One enriched delta row — THE single feed shape produced by `changesSince` and rendered by sync,
 * home, and the activity feed. `actor` is sourced
 * per-doc from frontmatter, never from a commit subject — this store only
 * persists it.
 */
export interface AwarenessDeltaRow {
  docId: string;
  /** "added" | "updated" | "deleted" — minted by the producer; persisted verbatim here. */
  verb: string;
  kind: string;
  title: string;
  actor: string;
  [extra: string]: unknown;
}

/**
 * The awareness cache `home` renders fs-only: the since-last-session delta plus the
 * backstop counts (BOTH unpushed board commits AND uncommitted board changes — catching the agent
 * that never ran sync at all, not just the failed-push one). `note` carries an honest condition
 * to surface instead of/alongside the delta (e.g. {@link REANCHOR_NOTE}).
 */
export interface AwarenessCache {
  /** ISO timestamp of the pull step that refreshed this cache (staleness labeling/expiry). */
  updatedAt: string;
  delta: AwarenessDeltaRow[];
  /** Local board commits not yet pushed to origin. */
  unpushedCount: number;
  /** Uncommitted changes sitting in the board worktree. */
  uncommittedCount: number;
  note?: string;
  [extra: string]: unknown;
}

/**
 * The board-pending marker: presence = "a board exists for this repo" (fs-only first-contact
 * signal); `updatedAt` is refreshed by every pull step. Absence is ALWAYS a valid state —
 * consumers must treat a missing marker as "unknown", never as an error.
 */
export interface BoardPendingMarker {
  updatedAt: string;
  [extra: string]: unknown;
}

/**
 * The actors THIS CLONE has committed to the board — how the home render
 * knows which awareness-delta rows are self-authored and filters them from the human count). There
 * is no machine-level identity to derive "self" from, and git authorship is not document
 * attribution, so self is defined operationally: every actor that appeared in a doc this
 * checkout's own `sync` committed is recorded here at commit time. A clone that never committed
 * anything has an empty list and filters nothing — honest for a read-only session. `"unknown"`
 * (core's absent-actor placeholder) is deliberately NEVER recorded: filtering it would also hide a
 * TEAMMATE's unattributed changes, and hiding real incoming work is worse than showing your own
 * unattributed rows. Capped ({@link SELF_ACTORS_CAP}, newest kept) so a pathological bundle cannot
 * grow the state file unboundedly.
 */
export const SELF_ACTORS_CAP = 64;

/** The whole per-bundle state record. Every piece is independently nullable. */
export interface SyncState {
  cursor: SyncCursor | null;
  cache: AwarenessCache | null;
  marker: BoardPendingMarker | null;
  /** See {@link SELF_ACTORS_CAP}'s doc — the actors this clone's own syncs have committed. */
  selfActors: string[] | null;
  /**
   * ISO timestamp of the last OPPORTUNISTIC auto-pull ATTEMPT (autopull.ts — the stale-cache pull
   * board-reading commands run). Recorded at attempt time, success or not, so a pull that CANNOT
   * refresh the cache (offline, diverged, dirty) still backs the trigger off for a full staleness
   * window instead of re-paying the network budget on every subsequent read. The cache's own
   * `updatedAt` stays the success-side signal (written only by a successful pull — that contract
   * is unchanged); this is the attempt-side throttle next to it.
   */
  autoPullAttemptAt: string | null;
  /**
   * ISO timestamp of the one-time hook-install onboarding hint (sync's receipt hints
   * `hook install` when no SessionStart hook is installed — once per clone, never nagging).
   * Presence = "already hinted"; the hint also self-suppresses once a hook IS installed.
   */
  hookHintedAt: string | null;
}

const EMPTY_STATE: SyncState = {
  cursor: null,
  cache: null,
  marker: null,
  selfActors: null,
  autoPullAttemptAt: null,
  hookHintedAt: null,
};

// ── validation (malformed → null, section-independent) ───────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string that parses to a real date — the schema's timestamp requirement. */
function isTimestamp(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Validate a cursor SHAPE (tier + token present and sane) while preserving it verbatim. */
function asCursor(v: unknown): SyncCursor | null {
  if (!isRecord(v)) return null;
  if (typeof v.tier !== "string" || v.tier.length === 0) return null;
  const token = v.token;
  const tokenOk =
    (typeof token === "string" && token.length > 0) ||
    (typeof token === "number" && Number.isFinite(token));
  if (!tokenOk) return null;
  return { ...v } as SyncCursor;
}

function asDeltaRow(v: unknown): AwarenessDeltaRow | null {
  if (!isRecord(v)) return null;
  for (const field of ["docId", "verb", "kind", "title", "actor"] as const) {
    if (typeof v[field] !== "string") return null;
  }
  return { ...v } as AwarenessDeltaRow;
}

function asCache(v: unknown): AwarenessCache | null {
  if (!isRecord(v)) return null;
  if (!isTimestamp(v.updatedAt)) return null;
  if (!Array.isArray(v.delta)) return null;
  const delta: AwarenessDeltaRow[] = [];
  for (const raw of v.delta) {
    const row = asDeltaRow(raw);
    if (row === null) return null; // one malformed row poisons the cache — a partial delta would lie
    delta.push(row);
  }
  if (!isCount(v.unpushedCount) || !isCount(v.uncommittedCount)) return null;
  if (v.note !== undefined && typeof v.note !== "string") return null;
  return { ...v, delta } as AwarenessCache;
}

function asMarker(v: unknown): BoardPendingMarker | null {
  if (!isRecord(v)) return null;
  if (!isTimestamp(v.updatedAt)) return null;
  return { ...v } as BoardPendingMarker;
}

/** Validate the self-actors SHAPE (an array of non-empty strings) — malformed reads as null. */
function asSelfActors(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((a) => typeof a === "string" && a.length > 0)) return null;
  return [...v];
}

/** `null` when `updatedAt` is older than `maxAgeMs` (or unbounded when no max age is given). */
function freshOrNull<T extends { updatedAt: string }>(
  value: T | null,
  opts?: ReadOptions,
): T | null {
  if (value === null) return null;
  if (opts?.maxAgeMs === undefined) return value;
  const now = (opts.now ?? (() => new Date()))();
  const age = now.getTime() - Date.parse(value.updatedAt);
  return age > opts.maxAgeMs ? null : value;
}

// ── the store factory (board-git A0: injection point for the future package) ──

/** Staleness policy for timestamped reads — the CONSUMER decides how old is too old. */
export interface ReadOptions {
  /** When set, a cache/marker older than this reads as `null` (stale = absent). */
  maxAgeMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** The injected seams: WHERE state lives and HOW it is written. No CLI/credentials knowledge. */
export interface SyncStoreOptions {
  /**
   * The state directory, or a thunk resolved PER OPERATION — the default store passes a thunk so
   * a `HOME` change between calls (the test-suite pattern) is honored, exactly like the old
   * per-call `home` parameters were.
   */
  stateDir: string | (() => string);
  /** Optional product-owned exact-record reader; defaults to ordinary UTF-8 file reads. */
  readText?: (file: string) => Promise<string>;
  /** The product-owned atomic 0600 write discipline. */
  writeAtomic: (dir: string, fileName: string, content: string) => Promise<void>;
}

/**
 * The one spelling of the conflict-export subdirectory under a sync state directory. Exported so a
 * consumer can name the whole export tree without re-spelling it.
 */
export const SYNC_EXPORTS_DIR_NAME = "exports";

/** The per-bundle sync state store — ONE owning implementation behind {@link createSyncStore}. */
export interface SyncStore {
  /** The absolute state-file path for `key`. */
  statePath(key: string): string;
  /** The per-bundle conflict-export directory for `key` (path naming only — git creates it). */
  exportsDir(key: string): string;
  readSyncState(key: string): Promise<SyncState>;
  readCursor(key: string): Promise<SyncCursor | null>;
  readCache(key: string, opts?: ReadOptions): Promise<AwarenessCache | null>;
  readMarker(key: string, opts?: ReadOptions): Promise<BoardPendingMarker | null>;
  writeSyncState(key: string, patch: Partial<SyncState>): Promise<SyncState>;
  writeCursor(key: string, cursor: SyncCursor): Promise<void>;
  writeCache(key: string, cache: AwarenessCache): Promise<void>;
  refreshMarker(key: string, now?: () => Date): Promise<BoardPendingMarker>;
  readSelfActors(key: string): Promise<string[]>;
  recordSelfActors(key: string, actors: string[]): Promise<string[]>;
  recordReanchor(
    key: string,
    cursor: SyncCursor,
    counts: { unpushedCount: number; uncommittedCount: number },
    now?: () => Date,
  ): Promise<AwarenessCache>;
  readAutoPullAttemptAt(key: string): Promise<string | null>;
  recordAutoPullAttempt(key: string, now?: () => Date): Promise<void>;
  readHookHintedAt(key: string): Promise<string | null>;
  recordHookHinted(key: string, now?: () => Date): Promise<void>;
}

/**
 * Build a sync store over an injected state directory + atomic write. This is THE implementation
 * — `cursor.ts`'s module-level functions are per-home projections of it, and its
 * `defaultSyncStore` is the instance every production consumer uses. Semantics (unchanged from
 * the free-function era): reads NEVER throw (absent/malformed/foreign state reads as null/empty);
 * writes are atomic read-merge-write and CAN throw; invalid write input is a programmer error
 * (TypeError).
 */
export function createSyncStore(options: SyncStoreOptions): SyncStore {
  const stateDir = (): string =>
    typeof options.stateDir === "function" ? options.stateDir() : options.stateDir;
  const statePath = (key: string): string => join(stateDir(), `${keyDigest(key)}.json`);
  const exportsDir = (key: string): string => join(stateDir(), SYNC_EXPORTS_DIR_NAME, keyDigest(key));
  const readText = options.readText ?? ((file: string) => readFile(file, "utf8"));

  /**
   * Read the whole per-bundle state record. NEVER throws: absent file, unreadable file, invalid
   * JSON, or a foreign key all read as the empty record; each SECTION is validated independently,
   * so one malformed section reads null without taking the others down.
   */
  async function readSyncState(key: string): Promise<SyncState> {
    let raw: string;
    try {
      raw = await readText(statePath(key));
    } catch {
      return { ...EMPTY_STATE }; // absent or unreadable — both are just "no state yet"
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...EMPTY_STATE };
    }
    if (!isRecord(parsed)) return { ...EMPTY_STATE };
    // Foreign-file guard: the key is stored INSIDE the file too; a truncated-hash collision (or a
    // hand-copied file) must read as absent for this key, never as another bundle's state.
    if (parsed.key !== key) return { ...EMPTY_STATE };
    return {
      cursor: asCursor(parsed.cursor),
      cache: asCache(parsed.cache),
      marker: asMarker(parsed.marker),
      selfActors: asSelfActors(parsed.selfActors),
      autoPullAttemptAt: isTimestamp(parsed.autoPullAttemptAt) ? parsed.autoPullAttemptAt : null,
      hookHintedAt: isTimestamp(parsed.hookHintedAt) ? parsed.hookHintedAt : null,
    };
  }

  /**
   * Merge `patch` into the stored record and write the whole file atomically. An explicit `null`
   * in the patch CLEARS that section; an absent field preserves it. Returns the state as written.
   */
  async function writeSyncState(key: string, patch: Partial<SyncState>): Promise<SyncState> {
    const next: SyncState = { ...(await readSyncState(key)), ...patch };
    const dir = stateDir();
    // Product-root creation and permission enforcement belong to the injected writer. This
    // neutral package must not create or chmod a product-state parent before that owner validates
    // its namespace and migration marker.
    const record = {
      key,
      cursor: next.cursor ?? undefined,
      cache: next.cache ?? undefined,
      marker: next.marker ?? undefined,
      selfActors: next.selfActors ?? undefined,
      autoPullAttemptAt: next.autoPullAttemptAt ?? undefined,
      hookHintedAt: next.hookHintedAt ?? undefined,
    };
    await options.writeAtomic(dir, basename(statePath(key)), JSON.stringify(record, null, 2) + "\n");
    return next;
  }

  return {
    statePath,
    exportsDir,
    readSyncState,
    writeSyncState,

    /** The stored cursor, or `null` (absent/malformed — never throws). Cursors do not age out. */
    async readCursor(key: string): Promise<SyncCursor | null> {
      return (await readSyncState(key)).cursor;
    },

    /** The awareness cache, or `null` (absent/malformed/stale-past-`maxAgeMs` — never throws). */
    async readCache(key: string, opts?: ReadOptions): Promise<AwarenessCache | null> {
      return freshOrNull((await readSyncState(key)).cache, opts);
    },

    /** The board-pending marker, or `null` (absent/malformed/stale-past-`maxAgeMs` — never throws). */
    async readMarker(key: string, opts?: ReadOptions): Promise<BoardPendingMarker | null> {
      return freshOrNull((await readSyncState(key)).marker, opts);
    },

    /** Persist the cursor (verbatim — opaque token, unknown tiers untouched). */
    async writeCursor(key: string, cursor: SyncCursor): Promise<void> {
      if (asCursor(cursor) === null) {
        throw new TypeError("cursor must be { tier: non-empty string, token: non-empty string | finite number }");
      }
      await writeSyncState(key, { cursor });
    },

    /** Persist the awareness cache the next `home` render reads. */
    async writeCache(key: string, cache: AwarenessCache): Promise<void> {
      if (asCache(cache) === null) {
        throw new TypeError(
          "cache must carry { updatedAt: ISO timestamp, delta: AwarenessDeltaRow[], unpushedCount, uncommittedCount }",
        );
      }
      await writeSyncState(key, { cache });
    },

    /**
     * Refresh the board-pending marker's timestamp (called by every pull step). Preserves any
     * extra fields a prior writer stored on the marker. Returns the marker as written.
     */
    async refreshMarker(key: string, now: () => Date = () => new Date()): Promise<BoardPendingMarker> {
      const current = (await readSyncState(key)).marker;
      const marker: BoardPendingMarker = { ...(current ?? {}), updatedAt: now().toISOString() };
      await writeSyncState(key, { marker });
      return marker;
    },

    /** The self-actor list for a bundle key, or `[]` (absent/malformed — never throws). */
    async readSelfActors(key: string): Promise<string[]> {
      return (await readSyncState(key)).selfActors ?? [];
    },

    /**
     * Record actors THIS CLONE just committed (sync's commit step calls this — see
     * {@link SELF_ACTORS_CAP}'s doc for the whole "self" identity story). Merge-union with the
     * stored list, newest-last, deduped, capped to the NEWEST {@link SELF_ACTORS_CAP} entries.
     * `"unknown"` and empty strings are dropped at this one chokepoint (recording the placeholder
     * would make the home render hide a teammate's unattributed changes too). A call that changes
     * nothing skips the write.
     */
    async recordSelfActors(key: string, actors: string[]): Promise<string[]> {
      const current = (await readSyncState(key)).selfActors ?? [];
      const merged = [...current];
      for (const a of actors) {
        if (typeof a !== "string" || a.length === 0 || a === "unknown") continue;
        if (!merged.includes(a)) merged.push(a);
      }
      const capped = merged.slice(-SELF_ACTORS_CAP);
      if (capped.length === current.length && capped.every((a, i) => a === current[i])) {
        return current;
      }
      await writeSyncState(key, { selfActors: capped });
      return capped;
    },

    /**
     * Re-anchor after the CALLER's `git cat-file -e` existence guard finds
     * the stored token gone — history was rewritten under the cursor. Atomically records the NEW
     * cursor (HEAD, minted by the caller) AND an awareness cache whose `note` is the honest
     * {@link REANCHOR_NOTE} with an EMPTY delta (the real delta is unknowable across a rewrite)
     * plus the caller's current backstop counts — so the miss is reported on the next render,
     * never a silent skip, and never fatal. Returns the cache as written.
     */
    async recordReanchor(
      key: string,
      cursor: SyncCursor,
      counts: { unpushedCount: number; uncommittedCount: number },
      now: () => Date = () => new Date(),
    ): Promise<AwarenessCache> {
      if (asCursor(cursor) === null) {
        throw new TypeError("cursor must be { tier: non-empty string, token: non-empty string | finite number }");
      }
      const cache: AwarenessCache = {
        updatedAt: now().toISOString(),
        delta: [],
        unpushedCount: counts.unpushedCount,
        uncommittedCount: counts.uncommittedCount,
        note: REANCHOR_NOTE,
      };
      await writeSyncState(key, { cursor, cache });
      return cache;
    },

    /** The last opportunistic auto-pull ATTEMPT timestamp, or `null` (absent/malformed — never throws). */
    async readAutoPullAttemptAt(key: string): Promise<string | null> {
      return (await readSyncState(key)).autoPullAttemptAt;
    },

    /**
     * Record an opportunistic auto-pull ATTEMPT (autopull.ts calls this BEFORE its network op —
     * see {@link SyncState.autoPullAttemptAt}: a failing/hanging pull must still back off for the
     * window).
     */
    async recordAutoPullAttempt(key: string, now: () => Date = () => new Date()): Promise<void> {
      await writeSyncState(key, { autoPullAttemptAt: now().toISOString() });
    },

    /** The one-time hook-install hint's shown-at timestamp, or `null` (absent/malformed — never throws). */
    async readHookHintedAt(key: string): Promise<string | null> {
      return (await readSyncState(key)).hookHintedAt;
    },

    /** Record that sync's one-time hook-install hint was shown for this clone (never shown again). */
    async recordHookHinted(key: string, now: () => Date = () => new Date()): Promise<void> {
      await writeSyncState(key, { hookHintedAt: now().toISOString() });
    },
  };
}
