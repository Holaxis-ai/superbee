/**
 * The machine-state port: one JSON document per Source Feed holding the stored cursor, the last
 * accepted values of every record and the changes still pending a write, written with a
 * compare-and-swap on its version. The managed runner keeps it in its own store;
 * `MemoryMachineState` serves tests and local runs.
 */
import { parseIsoInstant } from "../verification.js";
import { isSourceEstablishment } from "./target-descriptor.js";
import type { SourceEstablishment } from "./target.js";
import type { RecordChange } from "../record-overlay/types.js";

/** One record's last accepted state. */
export interface RecordEntry {
  /** The last accepted `after`, carried values included. */
  after: Record<string, unknown>;
  digest: string;
  /** Consecutive complete observations without the record. */
  missing: number;
  first_missing_at?: string;
  /** Reported `disappeared`; a later sighting is `new` again. */
  gone?: true;
  seen_at: string;
}

/** A change a commit asked to retry: planned again at the start of every run until written. */
export interface PendingChange {
  establishment?: SourceEstablishment;
  change: RecordChange;
  /** The record's entry once the change is written. */
  entry: RecordEntry;
  held_at: string;
  /** Replays whose commit threw. */
  replay_failures?: number;
}

/** One acknowledged, engine-owned supplying page; effect identities belong to the host. */
export interface PendingSourceCommit {
  v: 1;
  /** Original change order, independent of JSON object-key enumeration. */
  order: string[];
  page: number;
  baseline: boolean;
  complete: boolean;
}

export interface SourceState {
  v: 1;
  /** The profile that wrote `cursor`; a cursor from another id or version is never handed back. */
  profile: { id: string; version: number };
  cursor: unknown;
  /** The last committed page left its pass open. */
  open: boolean;
  validators?: Record<string, string>;
  records: Record<string, RecordEntry>;
  pending?: Record<string, PendingChange>;
  /** Protected whole-page pending from the registered target consumer. Original time is the
   * entries' shared held_at; order names their exact membership (at most 100). Unsupported or
   * malformed contexts refuse. Legacy pending without this context retains its existing policy;
   * old establishment descriptors remain protected but do not assert this original-order contract.
   * Hosts co-publish accepted overlay state through the same MachineState acknowledgment. */
  pending_commit?: PendingSourceCommit;
  complete_observations: number;
  last_complete_at?: string;
}

export interface MachineState {
  /** The state stored under `key` and the version a write must name, or null. */
  read(key: string): Promise<{ state: SourceState; version: string } | null>;
  /**
   * Store `state` when the stored version is still `expected` (null: nothing stored) and return the
   * new version; otherwise throw a {@link MachineStateConflict}.
   */
  write(key: string, state: SourceState, expected: string | null): Promise<string>;
}

export class MachineStateConflict extends Error {
  readonly code = "MACHINE_STATE_CONFLICT";
  constructor(key: string) {
    super(`machine state for ${key} changed since it was read`);
    this.name = "MachineStateConflict";
  }
}

/** Machine state in memory. Values are copied in and out, so a caller never aliases the store. */
export class MemoryMachineState implements MachineState {
  private readonly entries = new Map<string, { json: string; version: string }>();
  private counter = 0;

  async read(key: string): Promise<{ state: SourceState; version: string } | null> {
    const entry = this.entries.get(key);
    return entry ? { state: JSON.parse(entry.json) as SourceState, version: entry.version } : null;
  }

  async write(key: string, state: SourceState, expected: string | null): Promise<string> {
    const current = this.entries.get(key)?.version ?? null;
    if (current !== expected) throw new MachineStateConflict(key);
    const version = String(++this.counter);
    this.entries.set(key, { json: JSON.stringify(state), version });
    return version;
  }

  /** Every key stored. */
  keys(): string[] {
    return [...this.entries.keys()].sort();
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether a stored value has the shape the engine writes. */
const isEntry = (entry: unknown): boolean => record(entry) && record(entry.after) && typeof entry.digest === "string"
  && Number.isInteger(entry.missing) && typeof entry.seen_at === "string";

/** Establishments written by older consumers remain protected without inventing page context. */
export function hasProtectedSourcePending(state: SourceState): boolean {
  return state.pending_commit !== undefined || Object.values(state.pending ?? {}).some(p => p.establishment !== undefined);
}

const scalarId = (id: unknown): id is string => typeof id === "string" && id.length > 0
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(id);

function pendingCommitValid(state: Record<string, unknown>): boolean {
  const context = state.pending_commit;
  if (context === undefined) return true;
  if (!record(context) || Object.keys(context).some(k => !["v", "order", "page", "baseline", "complete"].includes(k))
    || context.v !== 1 || !Array.isArray(context.order) || context.order.length < 1 || context.order.length > 100
    || !context.order.every(scalarId) || new Set(context.order).size !== context.order.length
    || !Number.isSafeInteger(context.page) || (context.page as number) < 1
    || typeof context.baseline !== "boolean" || typeof context.complete !== "boolean" || !record(state.pending)
    || Object.keys(state.pending).length !== context.order.length) return false;
  let at: string | undefined;
  for (const id of context.order) {
    if (!Object.hasOwn(state.pending, id)) return false;
    const pending = state.pending[id];
    if (!record(pending) || typeof pending.held_at !== "string" || parseIsoInstant(pending.held_at) === null
      || at !== undefined && pending.held_at !== at) return false;
    if (pending.establishment !== undefined && (!isSourceEstablishment(pending.establishment)
      || pending.establishment.observed_at !== pending.held_at)) return false;
    at = pending.held_at;
  }
  try { return new TextEncoder().encode(JSON.stringify(state)).length <= 4194304; }
  catch { return false; }
}

export function isSourceState(value: unknown): value is SourceState {
  if (!record(value) || value.v !== 1 || typeof value.open !== "boolean" || !record(value.records)) return false;
  if (!record(value.profile) || typeof value.profile.id !== "string" || !Number.isInteger(value.profile.version)) return false;
  if (!Number.isInteger(value.complete_observations)) return false;
  if (value.validators !== undefined && !record(value.validators)) return false;
  if (value.pending !== undefined && !(record(value.pending) && Object.entries(value.pending).every(([id, pending]) => record(pending)
    && isEntry(pending.entry) && typeof pending.held_at === "string" && record(pending.change) && pending.change.external_id === id
    && typeof pending.change.change_kind === "string"
    && (pending.establishment === undefined || isSourceEstablishment(pending.establishment))))) return false;
  return Object.values(value.records).every(isEntry) && pendingCommitValid(value);
}
