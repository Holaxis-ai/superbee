/**
 * The browser-local implementation of the platform contract: every read, query, and validation
 * is answered from the working copy (an IndexedDB store by default, any journaled backend), every commit goes through `commitLocal` (the
 * document write and its pending intent in one transaction), and `sync` delivers intents under
 * the store's push role and refreshes the working copy from the authority.
 *
 * Provenance is derived from the intent journal for the document, never from the write that
 * produced it. The document, its intents, and its shared base are read in one readonly
 * transaction (`readWithJournal`), so a pull or a commit in another realm can never show this
 * derivation a document of one moment beside a journal of another. Over that snapshot: any
 * `conflict` intent for the id decides, giving `local-conflict` with the shared head that intent
 * recorded and its request identity, even when a later local edit is chained behind it (push
 * holds the chained edit until the conflict is resolved, so the document is in conflict, not
 * merely pending). Otherwise the latest unsettled intent in `pending`, `in_flight`, `unknown`,
 * or `refused` gives `local-pending`, because in each of those states the working copy holds an
 * edit the authority has not accepted (a refusal is reported through `syncStatus`, as the pause
 * and the refused count; in body mode a content refusal at the head of the chain is the
 * recoverable case `inspectConflict` and `resolveConflict` accept, while the provenance stays
 * `local-pending`, since no shared head moved). With no unsettled intent the document is
 * `shared-confirmed` when its recorded shared base (`base:<id>`, written only by bootstrap,
 * pull, or an acknowledgement) names the document's bytes: the same version token, or the same
 * serialized content when the authority mints a different token for identical bytes.
 *
 * Two token spaces meet here. `version` in every provenance is the working copy's own document
 * version, the premise a commit takes back; `acknowledged` in `shared-confirmed` is the
 * authority's token from the base. They differ when the authority hashed bytes the working copy
 * normalizes differently (a filesystem authority over hand-authored files).
 *
 * `shared-confirmed` means the authority acknowledged or served exactly this content at this
 * runtime's last exchange with it (its last sync), not that the authority holds it now. A
 * document the authority has since deleted stays `shared-confirmed` until the next sync, whose
 * pull removes it from the working copy. If a local edit holds it, the pull retains it and
 * rewrites its base to an absent shared version, and the document reads `local-pending`; the
 * conflict is recorded by push, which delivers the edit and settles the authority's 412 with
 * actual `null` as a conflict against an absent remote, so after a sync (push then pull) it
 * reads `local-conflict` with `remote: null`.
 *
 * A document with no unsettled intent whose bytes its base does not name is a defect in the
 * working copy (every local write journals an intent): `read` rejects with
 * {@link UnconfirmedWorkingCopyError} rather than guess, `query` omits the row, and
 * `syncStatus` counts such documents as `unconfirmed`.
 *
 * `query` and that count read the working copy through the seam's heads listing: one
 * transaction over every record with its journal and its base, parsing only leading
 * frontmatter, each row's provenance derived exactly as a read derives it. A listing at the
 * working-copy bound therefore costs one transaction and no body parse, and every row
 * describes the same moment.
 */

import type { ConceptId, Frontmatter, QueryFilter, StorageBackend, Version } from "@superbee/core";
import { assertReadableConceptId } from "@superbee/core/engine";
import type { IntentRecord, JournaledReadResult } from "@superbee/core/journaled-backend";
import { matchesFilter } from "@superbee/core/query-filter";
import { InvalidInputError } from "@superbee/core/storage";
import {
  localConflict,
  localPending,
  sharedConfirmed,
  type PlatformCapabilities,
  type PlatformCommit,
  type PlatformDocument,
  type PlatformEdit,
  type PlatformQueryRow,
  type PlatformRuntime,
  type PlatformSyncOptions,
  type PlatformSyncOutcome,
  type PlatformSyncStatus,
  type PlatformValidation,
  type Provenance,
} from "@superbee/core/platform";
import type { OperationTransport, UncertainWriteOptions } from "@superbee/core/uncertain-write";
import type { BodyDeliveryTransport } from "@superbee/core/governed-body-write";
import { admitBodyMode, assertBodyEdition, BODY_MODE_KEY, bodyEvidenceKeys, bodySnapshot, validateBodyEvidence } from "../body-journal.js";

import { baseKey, commitLocal, commitBodyLocal, pull, pushWithRole, syncStatus as localSyncStatus, UNSETTLED_STATES, type LocalBundle, type SharedBase } from "../local-bundle.js";
import type { LockManagerLike } from "../push-role.js";
import { isAuthorityAnswer, isInputError, kindWarningsFor } from "./shared.js";

export interface BrowserLocalRuntimeOptions {
  /** The opened working copy; the caller bootstraps it (or resumes one that is complete). */
  local: LocalBundle;
  /** The authority's read side, used by pull and to fetch a conflict's shared head. */
  remote: StorageBackend;
  /**
   * Carries intents to the authority as identified writes. May be omitted only with
   * `bodyTransport`, for a working copy in body mode, whose push never calls it; a working copy
   * in any other mode needs it, and a runtime built without it rejects its first `sync` rather
   * than delivering nothing.
   */
  transport?: OperationTransport;
  /** Carries body intents; required by a body-mode working copy, never inferred from `transport`. */
  bodyTransport?: BodyDeliveryTransport;
  /** The lock manager that owns the push role; omitted, the host's. See `withPushRole`. */
  locks?: LockManagerLike | null;
  /** Options for the uncertain-write primitive each push runs. */
  write?: UncertainWriteOptions;
  /** Write attribution for local commits. */
  actor?: string;
  /** Clock for the edition metadata a commit stamps; the contract kit fixes it so both modes mint one version. */
  now?: () => string;
}

/** The working copy holds bytes no authority read confirmed and no intent journals. */
export class UnconfirmedWorkingCopyError extends Error {
  readonly id: ConceptId;
  constructor(id: ConceptId) {
    super(`working copy holds '${id}' with no shared base naming its bytes and no intent recording a local edit`);
    this.name = "UnconfirmedWorkingCopyError";
    this.id = id;
  }
}

/** An ENOENT-shaped rejection, the shape every backend's read uses for an absent document. */
function notFound(id: ConceptId): Error & { code: string } {
  const err = new Error(`no concept document '${id}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

const UNSETTLED = new Set(UNSETTLED_STATES);

/**
 * Stands in for the exact-document transport of a body-mode runtime built without one. Body
 * mode delivers every intent through `bodyTransport`, so push never reaches this; a call is a
 * defect, refused rather than answered.
 */
const NO_EXACT_TRANSPORT: OperationTransport = {
  submit: async () => {
    throw new InvalidInputError("a body-mode working copy delivers no exact-document intents");
  },
  lookup: async () => {
    throw new InvalidInputError("a body-mode working copy delivers no exact-document intents");
  },
};

/** The one line a status carries for a rejected sync: the error's name and message. */
function describeFailure(failure: unknown): string {
  const err = failure as { name?: unknown; message?: unknown };
  const name = typeof err?.name === "string" ? err.name : "Error";
  const message = typeof err?.message === "string" ? err.message : String(failure);
  return `${name}: ${message}`;
}

/**
 * What a provenance is derived from: the working copy's stored bytes (`raw`, the bytes
 * `version` names) beside the journal and the base row read with them in one transaction,
 * whether for one document or for every row of a listing.
 */
interface ProvenanceEvidence {
  id: ConceptId;
  version: Version;
  raw: string;
  intents: readonly IntentRecord[];
  meta: ReadonlyMap<string, unknown>;
}

/**
 * The provenance of one document, or `null` when it is unconfirmed (no unsettled intent, and
 * no base naming the bytes).
 */
function deriveProvenance(evidence: ProvenanceEvidence): Provenance | null {
  const { id, version, raw, intents, meta } = evidence;
  const unsettled = intents.filter((row) => UNSETTLED.has(row.state));
  const conflict = unsettled.find((row) => row.state === "conflict");
  if (conflict) return localConflict(version, conflict.base, conflict.remote?.version ?? null, conflict.requestId);
  const latest: IntentRecord | undefined = unsettled[unsettled.length - 1];
  if (latest) return localPending(version, latest.base, latest.requestId);
  const base = meta.get(baseKey(id)) as SharedBase | undefined;
  if (base?.version !== null && base?.version !== undefined) {
    if (base.version === version || base.content === raw) return sharedConfirmed(version, base.version);
  }
  return null;
}

/** One row of the working copy's listing: what a query row carries, with `provenance` null for an unconfirmed document. */
interface Head {
  id: ConceptId;
  version: Version;
  frontmatter: Frontmatter;
  provenance: Provenance | null;
}

/** A row a read of the document would refuse: a leading block that does not parse, or body evidence that does not check. */
interface RefusedHead {
  id: ConceptId;
  refusal: Error;
}

function isRefused(row: Head | RefusedHead): row is RefusedHead {
  return "refusal" in row;
}

export function createBrowserLocalRuntime(options: BrowserLocalRuntimeOptions): PlatformRuntime {
  const { local, remote, transport, actor, now } = options;
  if (transport === undefined && options.bodyTransport === undefined) {
    throw new InvalidInputError("createBrowserLocalRuntime needs a transport: the exact-document transport, or bodyTransport for a working copy in body mode");
  }
  const { bundle, backend } = local;
  let online: boolean | null = null;
  /** How this runtime's last sync ended; `null` until one has run here. */
  let lastOutcome: { ok: boolean; error?: string } | null = null;

  const capabilities = (): PlatformCapabilities => ({ mode: "browser-local", offlineCommits: true, localPersistence: true });

  /**
   * The exact-document transport a push runs with. A body-mode working copy delivers only body
   * intents, so its host may omit `transport`; any other working copy needs the real one, and
   * the omission is reported here, before the push role is taken and before any intent is
   * claimed, so it never surfaces as a delivery that went nowhere.
   */
  const exactTransport = async (): Promise<OperationTransport> => {
    if (transport !== undefined) return transport;
    if (await admitBodyMode(backend)) return NO_EXACT_TRANSPORT;
    throw new InvalidInputError("this working copy is not in body mode, so createBrowserLocalRuntime needs the exact-document transport to sync");
  };

  /** One document with its journal and base, from one transaction; `null` when the store holds no record. */
  const snapshotOf = async (id: ConceptId): Promise<(JournaledReadResult & { document: NonNullable<JournaledReadResult["document"]>; raw: string }) | null> => {
    const mode = await admitBodyMode(backend);
    const snapshot = mode ? (await bodySnapshot(backend, id, mode)).read : await backend.readWithJournal(id, { meta: [baseKey(id)] });
    if (snapshot.document === null || snapshot.raw === null) return null;
    return { ...snapshot, document: snapshot.document, raw: snapshot.raw };
  };

  const readWithProvenance = async (id: ConceptId): Promise<PlatformDocument> => {
    assertReadableConceptId(id);
    const snapshot = await snapshotOf(id);
    if (!snapshot) throw notFound(id);
    const provenance = deriveProvenance({ id, version: snapshot.document.version, raw: snapshot.raw, intents: snapshot.intents, meta: snapshot.meta });
    if (!provenance) throw new UnconfirmedWorkingCopyError(id);
    return { doc: snapshot.document.doc, provenance };
  };

  /**
   * Every document the working copy holds, from one transaction: the admission `read` makes,
   * then the seam's listing with each row's journal and base, its provenance derived as a
   * read derives it. In body mode a row carries the evidence `bodySnapshot` reads for one
   * document and is checked the same way, so the listing refuses what a read refuses. A
   * document a read would refuse (a leading block that does not parse, or evidence that does
   * not check) is carried through the projection and the first in the returned order is thrown
   * once the rows are back, so the document named is the first in `list` order over any
   * adapter, whatever order it walks its store. Rows come in the store's `list` order.
   */
  const heads = async (): Promise<Head[]> => {
    const mode = await admitBodyMode(backend);
    if (mode) await assertBodyEdition(backend, mode);
    const rows = await backend.readHeads<Head | RefusedHead>({
      meta: mode ? (id, intents) => bodyEvidenceKeys(id, intents) : (id) => [baseKey(id)],
      ...(mode ? { shared: [BODY_MODE_KEY] } : {}),
      project: (head) => {
        if (head.frontmatter === null) return { id: head.id, refusal: head.malformed };
        if (mode) {
          try {
            validateBodyEvidence({ target: head.id, document: { version: head.version, raw: head.raw }, intents: head.intents, meta: head.meta, keys: bodyEvidenceKeys(head.id, head.intents) }, mode);
          } catch (error) {
            return { id: head.id, refusal: error instanceof Error ? error : new Error(String(error)) };
          }
        }
        return { id: head.id, version: head.version, frontmatter: head.frontmatter, provenance: deriveProvenance(head) };
      },
    });
    const refused = rows.find(isRefused);
    if (refused) throw refused.refusal;
    return rows as Head[];
  };

  /** Documents the working copy holds that neither a base nor an intent accounts for. */
  const countUnconfirmed = async (): Promise<number> => (await heads()).filter((head) => head.provenance === null).length;

  /**
   * The last sync as the contract reports it: this runtime's own outcome when it has synced,
   * otherwise what the pull marker says about the last pull over this store (complete or
   * interrupted), and in either case the deletions that marker still refuses. Absent when no
   * pull has ever run here.
   */
  const lastSyncOf = (marker: Awaited<ReturnType<typeof localSyncStatus>>["lastPull"]): PlatformSyncOutcome | undefined => {
    const outcome = lastOutcome ?? (marker === null ? undefined : { ok: marker.completedAt !== null });
    if (outcome === undefined) return undefined;
    return { ...outcome, ...(marker?.refused === undefined ? {} : { refusedDeletions: marker.refused }) };
  };

  const status = async (): Promise<PlatformSyncStatus> => {
    const local = await localSyncStatus(backend);
    const lastSync = lastSyncOf(local.lastPull);
    return {
      mode: "browser-local",
      online,
      pending: local.counts.pending + local.counts.in_flight + local.counts.unknown,
      conflicts: local.counts.conflict,
      refused: local.counts.refused,
      unconfirmed: await countUnconfirmed(),
      paused: local.paused,
      ...(local.pausedReason === undefined ? {} : { pausedReason: local.pausedReason }),
      complete: local.bootstrapComplete,
      ...(lastSync === undefined ? {} : { lastSync }),
    };
  };

  /**
   * One push-then-pull. When another realm holds the push role, this realm neither pushes nor
   * pulls: a pull listed while the holder's push is in flight can predate an acknowledgement the
   * holder is about to record, and would then remove the acknowledged document from the shared
   * working copy. The holder's own sync pulls into that same store, so this call returns the
   * current status and leaves `online` and `lastSync` as its last completed sync left them.
   */
  const syncOnce = async (syncOptions: PlatformSyncOptions): Promise<PlatformSyncStatus> => {
    const readSide: StorageBackend = remote;
    let pushed: Awaited<ReturnType<typeof pushWithRole>>;
    try {
      pushed = await pushWithRole(local, await exactTransport(), { remote: readSide, bodyTransport: options.bodyTransport, ...(options.write === undefined ? {} : { write: options.write }) }, options.locks === undefined ? {} : { locks: options.locks });
    } catch (error) {
      lastOutcome = { ok: false, error: describeFailure(error) };
      throw error;
    }
    if (!pushed.held) return status();
    try {
      // The opened bundle, not its backend: the pull keeps the authority's capabilities on it.
      await pull(local, readSide, syncOptions.acceptRefusedDeletions === undefined ? {} : { acceptRefusedDeletions: syncOptions.acceptRefusedDeletions });
      online = true;
      if (await admitBodyMode(backend)) {
        const remaining = await localSyncStatus(local);
        lastOutcome = { ok: remaining.counts.pending + remaining.counts.in_flight + remaining.counts.unknown + remaining.counts.refused + remaining.counts.conflict === 0 && !remaining.paused };
      } else lastOutcome = { ok: true };
    } catch (error) {
      lastOutcome = { ok: false, error: describeFailure(error) };
      if (isInputError(error) || isAuthorityAnswer(error)) throw error;
      online = false;
    }
    return status();
  };

  /** The sync this runtime is running, and the one follow-up that calls arriving meanwhile share. */
  let running: Promise<PlatformSyncStatus> | null = null;
  let rerun: Promise<PlatformSyncStatus> | null = null;
  let rerunOptions: PlatformSyncOptions = {};

  const start = (syncOptions: PlatformSyncOptions): Promise<PlatformSyncStatus> => {
    const run = syncOnce(syncOptions).finally(() => {
      if (running === run) running = null;
    });
    running = run;
    return run;
  };

  return {
    capabilities,

    read: readWithProvenance,

    query: async (filter: QueryFilter = {}): Promise<PlatformQueryRow[]> => {
      const rows: PlatformQueryRow[] = [];
      for (const head of await heads()) {
        // An unconfirmed document has no row. The filter is the engine's one predicate and the
        // order the engine's, so the rows are the ones a head scan over the store would select.
        if (head.provenance === null || !matchesFilter(head, filter)) continue;
        rows.push({ id: head.id, version: head.version, frontmatter: head.frontmatter, provenance: head.provenance });
      }
      rows.sort((a, b) => a.id.localeCompare(b.id));
      return rows;
    },

    validate: async (id: ConceptId): Promise<PlatformValidation> => {
      const { doc, provenance } = await readWithProvenance(id);
      return { id, warnings: await kindWarningsFor(bundle, doc), provenance };
    },

    commit: async (id: ConceptId, edit: PlatformEdit): Promise<PlatformCommit> => {
      const result = await admitBodyMode(backend) ? await commitBodyLocal(local, id, { body: edit.body, ...(edit.expectedVersion === undefined ? {} : { expectedVersion: edit.expectedVersion }), actor, now }) : await commitLocal(local, id, {
        ...(edit.expectedVersion === undefined ? {} : { expectedVersion: edit.expectedVersion }),
        ...(actor === undefined ? {} : { actor }),
        ...(now === undefined ? {} : { now }),
        buildCandidate: (existing) => ({ frontmatter: existing!.frontmatter, body: edit.body }),
      });
      // A local write is pending by construction; only the journal, never this write, says
      // which intent now describes the document (the one just recorded, or a conflict it chains
      // behind), so the answer is read back from the journal like any other.
      const { provenance } = await readWithProvenance(id);
      return { id, changed: result.changed, provenance };
    },

    syncStatus: status,

    /**
     * Push, then pull. `online` reports the carrier alone: it turns false on a carrier failure
     * and stays as it was on an authority answer. `lastSync` reports the verb: any rejection,
     * carrier or authority, records `ok: false` with the error's text before it propagates or
     * is absorbed, so a presentation can show that the sync failed even when the authority
     * answered.
     *
     * Syncs on one runtime never overlap. A call made while one is running waits for it and
     * shares a single follow-up run with every other call made meanwhile, resolving with that
     * run's result; the follow-up carries the latest `acceptRefusedDeletions` any of them passed.
     */
    sync: (syncOptions: PlatformSyncOptions = {}): Promise<PlatformSyncStatus> => {
      if (rerun !== null) {
        if (syncOptions.acceptRefusedDeletions !== undefined) rerunOptions = { acceptRefusedDeletions: syncOptions.acceptRefusedDeletions };
        return rerun;
      }
      if (running === null) return start(syncOptions);
      rerunOptions = syncOptions;
      const settled = (): void => {};
      rerun = running.then(settled, settled).then(() => {
        rerun = null;
        return start(rerunOptions);
      });
      return rerun;
    },
  };
}
