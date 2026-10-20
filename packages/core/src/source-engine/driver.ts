/** Internal observation owner shared by network and finite acquisition wrappers. */
import { changeBetween, mapRecord, type BoundFeed, type MappingDiagnostic } from "../connectors.js";
import { overlayCanonicalJson } from "../record-overlay/canonical.js";
import type { Finding, RecordChange } from "../record-overlay/types.js";
import { SourceStop, type Stop } from "./guard.js";
import type { MachineState, PendingChange, RecordEntry, SourceState } from "./machine-state.js";
import type { CommitResult, ObservePage, PageCommit, ProfileDiagnostic, SourceRunReceipt } from "./types.js";

export const DEFAULT_MISSING_THRESHOLD = 2;
export const MAX_CURSOR_CHARS = 8192;
export const MAX_REPLAY_FAILURES = 5;
export const UNSUPPORTED_CONTENT = "SOURCE_UNSUPPORTED_CONTENT";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const clip = (text: string, n: number): string => (text.length > n ? text.slice(0, n - 1) + "…" : text);

/** JSON data only: finite numbers, plain objects and arrays, no undefined members. */
export function isJsonData(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonData(item, depth + 1));
  if (!record(value)) return false;
  // A plain object from any realm: its prototype is null or a prototype that itself has none.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;
  return Object.values(value).every((item) => item !== undefined && isJsonData(item, depth + 1));
}

/** The page as the engine accepts it, or why not. */
function pageProblem(page: unknown): string | undefined {
  if (!record(page)) return "page_invalid";
  if (!Array.isArray(page.records) || typeof page.more !== "boolean" || typeof page.complete !== "boolean") return "page_invalid";
  if (page.diagnostics !== undefined && !(Array.isArray(page.diagnostics) && page.diagnostics.every((d) => record(d) && typeof d.code === "string" && typeof d.message === "string"))) return "page_invalid";
  if (page.validators !== undefined && !(record(page.validators) && Object.values(page.validators).every((v) => typeof v === "string"))) return "page_invalid";
  const cursor = page.nextCursor === undefined ? null : page.nextCursor;
  if (!isJsonData(cursor) || (overlayCanonicalJson(cursor) ?? "").length > MAX_CURSOR_CHARS) return "cursor_invalid";
  return undefined;
}

interface PageDiff {
  changes: RecordChange[];
  entries: Map<string, RecordEntry>;
  seen: Set<string>;
  diagnostics: MappingDiagnostic[];
  profileDiagnostics: ProfileDiagnostic[];
}

/**
 * Diff one page against the stored records. Within a page the last occurrence of an id wins and is
 * diffed against the stored entry, so every change's `before` is what the overlay last accepted.
 */
function diffPage(state: SourceState, page: ObservePage<unknown>, bound: BoundFeed, observedAt: string): PageDiff {
  const diagnostics: MappingDiagnostic[] = [];
  const profileDiagnostics: ProfileDiagnostic[] = [...(page.diagnostics ?? [])].map((d) => ({ ...d }));
  const last = new Map<string, ReturnType<typeof mapRecord>>();
  const seen = new Set<string>();
  let notObjects = 0;
  let duplicates = 0;
  for (const raw of page.records) {
    if (!record(raw)) { notObjects += 1; continue; }
    const mapped = mapRecord(bound.source, raw, bound.kind);
    diagnostics.push(...mapped.diagnostics);
    const id = mapped.external_id;
    if (id === null) continue;
    seen.add(id);
    if (last.has(id)) duplicates += 1;
    last.set(id, mapped);
  }
  if (notObjects) profileDiagnostics.push({ code: "RECORD_NOT_OBJECT", message: "records that are not JSON objects were skipped", count: notObjects });
  if (duplicates) profileDiagnostics.push({ code: "RECORD_DUPLICATE", message: "a page listed the same record more than once; the last one was used", count: duplicates });
  const changes: RecordChange[] = [];
  const entries = new Map<string, RecordEntry>();
  for (const [id, mapped] of last) {
    const stored = Object.hasOwn(state.records, id) ? state.records[id] : undefined;
    if (mapped.kind === "refused") {
      // Refused but present: still observed, so never missing; its accepted values stay.
      if (stored) entries.set(id, { ...stored, missing: 0, seen_at: observedAt, first_missing_at: undefined });
      continue;
    }
    const previous = stored && !stored.gone ? stored.after : null;
    const change = changeBetween(previous, mapped, { external_id: id, change_kind: previous === null ? "new" : "changed" });
    entries.set(id, { after: change.after!, digest: change.content_digest, missing: 0, seen_at: observedAt });
    if (previous === null || change.changed_fields.length > 0) changes.push(change);
  }
  return { changes, entries, seen, diagnostics, profileDiagnostics };
}

/** Disappearances at the end of a complete observation: every present record the pass did not list. */
function missingAfterComplete(records: Readonly<Record<string, RecordEntry>>, seen: ReadonlySet<string>, threshold: number, observedAt: string): { changes: RecordChange[]; entries: Map<string, RecordEntry> } {
  const changes: RecordChange[] = [];
  const entries = new Map<string, RecordEntry>();
  for (const [id, entry] of Object.entries(records)) {
    if (entry.gone || seen.has(id)) continue;
    const missing = entry.missing + 1;
    const firstMissingAt = entry.first_missing_at ?? observedAt;
    if (missing >= threshold) {
      entries.set(id, { ...entry, missing, first_missing_at: firstMissingAt, gone: true });
      changes.push({
        external_id: id, change_kind: "disappeared", changed_fields: [], before: { ...entry.after }, after: null,
        content_digest: entry.digest, missing_count: missing, first_missing_at: firstMissingAt,
      });
    } else {
      entries.set(id, { ...entry, missing, first_missing_at: firstMissingAt });
    }
  }
  return { changes, entries };
}

/** Drop `undefined` members so the stored state is plain JSON. */
function entryJson(entry: RecordEntry): RecordEntry {
  const { first_missing_at: firstMissingAt, gone, ...rest } = entry;
  return { ...rest, ...(firstMissingAt !== undefined ? { first_missing_at: firstMissingAt } : {}), ...(gone ? { gone } : {}) };
}

/** The ids a commit did not write, read defensively. */
function commitResult(result: unknown): { hold: Set<string>; retry: Set<string> } {
  const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  const retry = new Set(record(result) ? ids(result.retry) : []);
  const hold = new Set((record(result) ? ids(result.hold) : []).filter((id) => !retry.has(id)));
  return { hold, retry };
}


interface DriverOptions {
  bound: BoundFeed;
  state: MachineState;
  initial: SourceState;
  version: string | null;
  receipt: SourceRunReceipt;
  observedAt: string;
  mode: "incremental" | "complete";
  resumed: boolean;
  signal: AbortSignal;
  pages: number;
  /** Replay admission ends after pending work, without manufacturing an observation page. */
  replayOnly?: boolean;
  acquire(input: { cursor: unknown; resumed: boolean; mode: "incremental" | "complete"; validators: Readonly<Record<string, string>> | null }): Promise<unknown>;
  stopped?(): Stop | undefined;
  lastUrl?(): string | undefined;
  stop(stop: Stop, url?: string): void;
  extraFindings: Finding[];
  commit(page: PageCommit): Promise<CommitResult | void>;
}
export async function driveObservation(options: DriverOptions): Promise<void> {
  const { bound, receipt, observedAt, mode, resumed, signal, extraFindings } = options;
  const key = bound.policy.feed;
  let state = options.initial;
  let version = options.version;
  const baseline = version === null;
  let cursor = mode === "complete" ? null : state.cursor;
  const threshold = bound.policy.missing_threshold ?? DEFAULT_MISSING_THRESHOLD;
  const sourceComplete = bound.source.completeness === "complete";
  let stop: Stop | undefined;
  let stopUrl: string | undefined;
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
  /** Store `next` after a commit; false when the store refused it and the run has stopped. */
  const store = async (next: SourceState): Promise<boolean> => {
    try {
      version = await options.state.write(key, next, version);
      state = next;
      receipt.pending = Object.keys(next.pending ?? {}).length;
      return true;
    } catch (error) {
      const conflict = record(error) && error.code === "MACHINE_STATE_CONFLICT";
      stop = { outcome: "failed", reason: conflict ? "state_conflict" : "state_unwritable", retry: true };
      return false;
    }
  };

  try {
    // Changes an earlier commit asked to retry are planned again before anything is fetched. A
    // record that has since disappeared has nothing left to write, unless the held change is the
    // record coming back.
    const pendingIds = signal.aborted ? [] : Object.keys(state.pending ?? {}).sort();
    if (pendingIds.length) {
      const pending = state.pending!;
      const live = pendingIds.filter((id) => !state.records[id]?.gone || pending[id]!.change.change_kind === "new");
      const changes = live.map((id) => pending[id]!.change);
      const records: Record<string, { fields: Record<string, unknown> }> = {};
      for (const change of changes) records[change.external_id] = { fields: { ...(change.after ?? change.before ?? {}) } };
      let result: { hold: Set<string>; retry: Set<string> } | undefined;
      let failure: string | undefined;
      if (live.length) {
        try {
          result = commitResult(await options.commit({
            feed: key, provider: bound.policy.provider, observed_at: observedAt, page: 0, replay: true, changes, records, baseline: false, complete: false,
          }));
        } catch (error) {
          failure = errorText(error);
        }
      }
      const nextRecords = { ...state.records };
      const nextPending: Record<string, PendingChange> = {};
      const dropped: string[] = [];
      for (const id of live) {
        const entry = pending[id]!;
        if (failure !== undefined) {
          // A replay the commit cannot take stays pending, so a later sighting can still supersede
          // it, until it has failed too often.
          const failures = (entry.replay_failures ?? 0) + 1;
          if (failures >= MAX_REPLAY_FAILURES) dropped.push(id);
          else nextPending[id] = { ...entry, replay_failures: failures };
        } else if (result!.retry.has(id)) {
          nextPending[id] = entry;
        } else if (!result!.hold.has(id)) {
          // The record's absence since the hold is newer than the change, so its count stays; a
          // record that comes back starts afresh.
          const current = state.records[id];
          nextRecords[id] = entryJson(current?.gone ? entry.entry : { ...entry.entry, missing: current?.missing ?? 0, first_missing_at: current?.first_missing_at });
        }
      }
      receipt.held += live.filter((id) => failure !== undefined || result!.retry.has(id) || result!.hold.has(id)).length;
      if (failure !== undefined) {
        extraFindings.push({
          key: `source:${bound.source.name}:replay_failed`,
          title: clip(`Source ${bound.source.name}: a held change could not be planned again`, 140),
          summary: clip(`Replaying ${live.length} pending change${live.length === 1 ? "" : "s"} failed (${failure}); they stay pending and the run went on to read the provider.`, 600),
          priority: "normal",
          facts: { outcome: "failed", reason: "replay_failed" },
        });
      }
      if (dropped.length) {
        extraFindings.push({
          key: `source:${bound.source.name}:replay_dropped`,
          title: clip(`Source ${bound.source.name}: held changes dropped after ${MAX_REPLAY_FAILURES} failed replays`, 140),
          summary: clip(`Dropped ${dropped.length} pending change${dropped.length === 1 ? "" : "s"} (${dropped.slice(0, 3).map((id) => clip(id, 60)).join(", ")}${dropped.length > 3 ? ", …" : ""}); each record is planned again when it is next observed.`, 600),
          priority: "normal",
          facts: { outcome: "failed", reason: "replay_dropped", count: dropped.length },
        });
      }
      const next: SourceState = { ...state, records: nextRecords };
      if (Object.keys(nextPending).length) next.pending = nextPending;
      else delete next.pending;
      if (!(await store(next))) return;
    }

    if (signal.aborted) { stop = { outcome: "deferred", reason: "deadline", retry: true }; return; }
    if (options.replayOnly) { receipt.pass.ended = true; return; }
    const seen = new Set<string>();
    /** The cursors this run has asked for; a page handing one back again has looped. */
    const asked = new Set<string>();
    const lastRequestUrl = (): string | undefined => options.lastUrl?.();
    for (let first = true; ; first = false) {
      if (signal.aborted) { stop = { outcome: "deferred", reason: "deadline", retry: true }; break; }
      // A resumed pass may restart from its first page, so the cursor it resumes from is not a loop.
      if (cursor !== null && !(first && resumed)) asked.add(overlayCanonicalJson(cursor)!);
      let raw: unknown;
      try {
        // The deadline bounds profile code too: a page still pending when it passes is discarded.
        raw = await options.acquire({ cursor, resumed: first && resumed, mode, validators: mode === "complete" ? null : state.validators ?? null });
      } catch (error) {
        stop = options.stopped?.() ?? (error instanceof SourceStop ? error.stop : undefined);
        if (!stop && signal.aborted) stop = { outcome: "deferred", reason: "deadline", retry: true };
        if (!stop) {
          const code = record(error) ? error.code : undefined;
          stop = code === UNSUPPORTED_CONTENT
            ? { outcome: "unsupported_content", retry: false, detail: String((error as { detail?: unknown }).detail ?? "") }
            : { outcome: "failed", reason: "profile_error", retry: false, detail: errorText(error) };
        }
        stopUrl = lastRequestUrl();
        break;
      }
      // A stop the profile caught and swallowed still ends the run, and its page is discarded.
      const guardStop = options.stopped?.();
      if (guardStop) { stop = guardStop; stopUrl = lastRequestUrl(); break; }
      let page: ObservePage<unknown>;
      try {
        const invalid = pageProblem(raw);
        if (invalid) { stop = { outcome: "failed", reason: invalid, retry: false }; break; }
        // One read of the profile's page, as JSON data, so no getter or later mutation reaches the diff.
        page = JSON.parse(JSON.stringify(raw)) as ObservePage<unknown>;
      } catch (error) {
        stop = { outcome: "failed", reason: "page_invalid", retry: false, detail: errorText(error) };
        break;
      }
      const nextCursor = page.nextCursor ?? null;
      // A page that promises more but hands back no cursor, or one this run already asked for, would
      // read the same pages until the budget runs out.
      if (page.more && (nextCursor === null || asked.has(overlayCanonicalJson(nextCursor)!))) {
        stop = { outcome: "failed", reason: "cursor_stuck", retry: false };
        break;
      }

      const diff = diffPage(state, page, bound, observedAt);
      for (const id of diff.seen) seen.add(id);
      const ended = !page.more;
      const complete = ended && mode === "complete" && page.complete && sourceComplete;
      const merged: Record<string, RecordEntry> = { ...state.records };
      for (const [id, entry] of diff.entries) merged[id] = entry;
      const missing = complete ? missingAfterComplete(merged, seen, threshold, observedAt) : { changes: [], entries: new Map<string, RecordEntry>() };
      const changes = [...diff.changes, ...missing.changes];
      const byId = new Map(changes.map((change) => [change.external_id, change]));
      // A newer observation of a record, its listing or its absence from a complete pass, supersedes
      // its pending change, whether or not the record was ever stored. Those entries are dropped and
      // stored before the commit, so a crash after the commit never replays a change older than what
      // the commit wrote.
      const unlisted = complete ? Object.keys(state.pending ?? {}).filter((id) => !seen.has(id)) : [];
      const superseded = [...new Set([...diff.seen, ...missing.entries.keys(), ...unlisted])].filter((id) => state.pending !== undefined && Object.hasOwn(state.pending, id));
      if (superseded.length) {
        const remaining: Record<string, PendingChange> = { ...state.pending };
        for (const id of superseded) delete remaining[id];
        const pre: SourceState = { ...state };
        if (Object.keys(remaining).length) pre.pending = remaining;
        else delete pre.pending;
        if (!(await store(pre))) break;
      }
      const records: Record<string, { fields: Record<string, unknown> }> = {};
      for (const change of changes) records[change.external_id] = { fields: { ...(change.after ?? change.before ?? {}) } };

      let result: { hold: Set<string>; retry: Set<string> };
      try {
        result = commitResult(await options.commit({
          feed: key, provider: bound.policy.provider, observed_at: observedAt, page: receipt.pages + 1, replay: false,
          changes, records, baseline, complete,
        }));
      } catch (error) {
        stop = { outcome: "failed", reason: "commit_failed", retry: true, detail: errorText(error) };
        break;
      }
      const notWritten = (id: string): boolean => byId.has(id) && (result.hold.has(id) || result.retry.has(id));

      // The page committed: now, and only now, its records and cursor are stored.
      const nextRecords: Record<string, RecordEntry> = { ...state.records };
      const nextPending: Record<string, PendingChange> = { ...state.pending };
      for (const [id, entry] of [...diff.entries, ...missing.entries]) {
        if (byId.has(id) && result.retry.has(id)) nextPending[id] = { change: byId.get(id)!, entry: entryJson(entry), held_at: observedAt };
        else if (!notWritten(id)) nextRecords[id] = entryJson(entry);
      }
      const next: SourceState = {
        ...state,
        cursor: nextCursor,
        open: page.more,
        records: nextRecords,
        complete_observations: state.complete_observations + (complete ? 1 : 0),
        ...(complete ? { last_complete_at: observedAt } : {}),
        ...(page.validators ? { validators: { ...page.validators } } : {}),
      };
      if (Object.keys(nextPending).length) next.pending = nextPending;
      else delete next.pending;
      if (!(await store(next))) break;
      receipt.pages += 1;
      receipt.cursor = nextCursor;
      receipt.diagnostics.push(...diff.diagnostics);
      receipt.profile_diagnostics.push(...diff.profileDiagnostics);
      for (const change of changes) {
        if (notWritten(change.external_id)) { receipt.held += 1; continue; }
        const kind = change.change_kind as keyof SourceRunReceipt["changes"];
        if (Object.hasOwn(receipt.changes, kind)) receipt.changes[kind] += 1;
      }
      if (ended) {
        receipt.pass.ended = true;
        receipt.pass.complete = complete;
        break;
      }
      if (receipt.pages >= options.pages) { stop = { outcome: "deferred", reason: "budget", retry: true }; break; }
      cursor = nextCursor;
    }
    return;
  } finally {
    if (stop) options.stop(stop, stopUrl);
  }
}
