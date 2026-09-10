/**
 * Recorded outcomes of identified writes: the store behind the wire's `Idempotency-Key` header
 * and `GET /operations/{key}` route (`docs/WIRE-PROTOCOL.md`, "Identified writes").
 *
 * A key is claimed before its write is applied. The claim answers in one of three ways: the
 * key already has a recorded operation, so the caller replays it; another application of the
 * same key is in progress, so the caller waits for it; or the key is now the caller's, who
 * either records the response it produced or releases the claim when the application threw
 * before any response existed. Recording binds the outcome to the method and document id it
 * was produced for, so a resubmission under the same key that names a different operation can
 * be refused instead of replayed.
 *
 * Keys are scoped: the reference router scopes by canonical bundle id, so two bundles cannot
 * share or collide on a key. The memory store keeps each record for a retention window and
 * forgets it lazily on access, pruning on every record so the map stays bounded by what was
 * written inside one window. The module imports no Node builtin: the Worker-safe router
 * subpath consumes it unchanged.
 */

import type { Outcome } from "@superbee/core/storage";

/** The outcome kinds an authority can record; `unknown` is the client's word, never the store's. */
export type RecordedOutcome = Exclude<Outcome, { kind: "unknown" }>;

/** The parts of a response that replay verbatim to a duplicate submission. */
export interface RecordedResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

/** One identified write the authority applied, as recorded under its key. */
export interface RecordedOperation {
  /** The HTTP method the outcome was recorded for. */
  method: string;
  /** The decoded document id the outcome was recorded for. */
  id: string;
  response: RecordedResponse;
  outcome: RecordedOutcome;
  /** Milliseconds since the epoch on the store's clock; retention counts from here. */
  recordedAt: number;
}

/** What a caller learns when it claims a key. */
export type OperationClaim =
  | { kind: "recorded"; operation: RecordedOperation }
  | {
      kind: "in_progress";
      /** Resolves with the record once the other application records, or `null` if it released instead. */
      settled: Promise<RecordedOperation | null>;
    }
  | {
      kind: "claimed";
      /** Record the application's response under the key; the key stays claimed until this or `release` runs. */
      record(operation: Omit<RecordedOperation, "recordedAt">): RecordedOperation;
      /** Give the key back with nothing recorded, so a later submission applies fresh. */
      release(): void;
    };

export interface OperationOutcomeStore {
  /** Claim `key` within `scope` ahead of applying the write it identifies. */
  claim(scope: string, key: string): Promise<OperationClaim>;
  /** The record under `key` within `scope`, or `null` when nothing is recorded (never, or no longer). */
  lookup(scope: string, key: string): Promise<RecordedOperation | null>;
}

export interface MemoryOperationOutcomeStoreOptions {
  /** How long a record stays answerable after it is recorded. Default 24 hours. */
  retentionMs?: number;
  /** The clock retention is measured on; injectable so a test can expire records deterministically. */
  now?: () => number;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

interface InProgress {
  settled: Promise<RecordedOperation | null>;
  resolve: (value: RecordedOperation | null) => void;
}

/** The reference store: one map per process, bounded by the retention window. */
export class MemoryOperationOutcomeStore implements OperationOutcomeStore {
  private readonly recorded = new Map<string, RecordedOperation>();
  private readonly inProgress = new Map<string, InProgress>();
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: MemoryOperationOutcomeStoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Records currently held, expired ones included until they are next touched. */
  get size(): number {
    return this.recorded.size;
  }

  async claim(scope: string, key: string): Promise<OperationClaim> {
    // No await precedes the map reads and writes below, so a claim is atomic against every
    // other claim in this process: two concurrent submissions cannot both be handed the key.
    const slot = slotKey(scope, key);
    const existing = this.live(slot);
    if (existing) return { kind: "recorded", operation: existing };
    const running = this.inProgress.get(slot);
    if (running) return { kind: "in_progress", settled: running.settled };

    let resolve!: (value: RecordedOperation | null) => void;
    const settled = new Promise<RecordedOperation | null>((done) => {
      resolve = done;
    });
    const entry: InProgress = { settled, resolve };
    this.inProgress.set(slot, entry);
    let open = true;
    const assertOpen = (): void => {
      if (!open) throw new Error(`operation outcome for '${key}' was already recorded or released`);
    };
    const finish = (value: RecordedOperation | null): void => {
      assertOpen();
      open = false;
      if (this.inProgress.get(slot) === entry) this.inProgress.delete(slot);
      entry.resolve(value);
    };
    return {
      kind: "claimed",
      record: (operation) => {
        // A settled claim is refused before any map is touched, so a second record cannot land
        // a row the caller was told was rejected. The clock is injected, so it can throw; a
        // record that never lands still gives the key back, or every waiter on this claim would
        // hang and the key would stay unusable until the process restarts.
        assertOpen();
        try {
          const record: RecordedOperation = { ...operation, recordedAt: this.now() };
          this.prune();
          this.recorded.set(slot, record);
          finish(record);
          return record;
        } catch (err) {
          if (open) finish(null);
          throw err;
        }
      },
      release: () => finish(null),
    };
  }

  async lookup(scope: string, key: string): Promise<RecordedOperation | null> {
    return this.live(slotKey(scope, key));
  }

  /** The record at `slot` if it is inside the window; an expired record is dropped on the way. */
  private live(slot: string): RecordedOperation | null {
    const record = this.recorded.get(slot);
    if (!record) return null;
    if (this.expired(record)) {
      this.recorded.delete(slot);
      return null;
    }
    return record;
  }

  private expired(record: RecordedOperation): boolean {
    return this.now() - record.recordedAt >= this.retentionMs;
  }

  /**
   * Drop expired records from the front of the map. Records are inserted in clock order (a
   * record always lands as a fresh key, since `live` removes an expired one before a new claim
   * can be handed out), so the scan stops at the first live record and each record is visited
   * once over its life. A clock that moves backwards can leave an expired record behind a live
   * one; `live` still drops it on its next touch, so correctness never depends on this scan.
   */
  private prune(): void {
    for (const [slot, record] of this.recorded) {
      if (!this.expired(record)) break;
      this.recorded.delete(slot);
    }
  }
}

/** Scope and key joined on a separator no key can contain (keys are printable ASCII, so no NUL). */
function slotKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}
