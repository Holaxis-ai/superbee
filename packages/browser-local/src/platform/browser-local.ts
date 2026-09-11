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
 * and the refused count). With no unsettled intent the document is `shared-confirmed` when its
 * recorded shared base (`base:<id>`, written only by bootstrap, pull, or an acknowledgement)
 * names the document's bytes: the same version token, or the same serialized content when the
 * authority mints a different token for identical bytes.
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
 */

import type { ConceptId, QueryFilter, RemoteBackend, StorageBackend } from "@superbee/core";
import { queryHeads } from "@superbee/core/bundle-ops";
import { assertReadableConceptId } from "@superbee/core/engine";
import type { IntentRecord, JournaledReadResult } from "@superbee/core/journaled-backend";
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
  type PlatformSyncStatus,
  type PlatformValidation,
  type Provenance,
} from "@superbee/core/platform";
import type { OperationTransport, UncertainWriteOptions } from "@superbee/core/uncertain-write";

import { baseKey, commitLocal, pull, pushWithRole, syncStatus as localSyncStatus, UNSETTLED_STATES, type LocalBundle, type SharedBase } from "../local-bundle.js";
import type { LockManagerLike } from "../push-role.js";
import { isAuthorityAnswer, isInputError, kindWarningsFor } from "./shared.js";

export interface BrowserLocalRuntimeOptions {
  /** The opened working copy; the caller bootstraps it (or resumes one that is complete). */
  local: LocalBundle;
  /** The authority's read side, used by pull and to fetch a conflict's shared head. */
  remote: RemoteBackend;
  /** Carries intents to the authority as identified writes. */
  transport: OperationTransport;
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
 * The provenance of one snapshot, or `null` when the snapshot is unconfirmed (no unsettled
 * intent, and no base naming the bytes). `raw` are the stored bytes `version` names.
 */
function deriveProvenance(snapshot: JournaledReadResult & { document: NonNullable<JournaledReadResult["document"]>; raw: string }): Provenance | null {
  const { version } = snapshot.document;
  const unsettled = snapshot.intents.filter((row) => UNSETTLED.has(row.state));
  const conflict = unsettled.find((row) => row.state === "conflict");
  if (conflict) return localConflict(version, conflict.base, conflict.remote?.version ?? null, conflict.requestId);
  const latest: IntentRecord | undefined = unsettled[unsettled.length - 1];
  if (latest) return localPending(version, latest.base, latest.requestId);
  const base = snapshot.meta.get(baseKey(snapshot.document.doc.id)) as SharedBase | undefined;
  if (base?.version !== null && base?.version !== undefined) {
    if (base.version === version || base.content === snapshot.raw) return sharedConfirmed(version, base.version);
  }
  return null;
}

export function createBrowserLocalRuntime(options: BrowserLocalRuntimeOptions): PlatformRuntime {
  const { local, remote, transport, actor, now } = options;
  const { bundle, backend } = local;
  let online: boolean | null = null;

  const capabilities = (): PlatformCapabilities => ({ mode: "browser-local", offlineCommits: true, localPersistence: true });

  /** One document with its journal and base, from one transaction; `null` when the store holds no record. */
  const snapshotOf = async (id: ConceptId): Promise<(JournaledReadResult & { document: NonNullable<JournaledReadResult["document"]>; raw: string }) | null> => {
    const snapshot = await backend.readWithJournal(id, { meta: [baseKey(id)] });
    if (snapshot.document === null || snapshot.raw === null) return null;
    return { ...snapshot, document: snapshot.document, raw: snapshot.raw };
  };

  const readWithProvenance = async (id: ConceptId): Promise<PlatformDocument> => {
    assertReadableConceptId(id);
    const snapshot = await snapshotOf(id);
    if (!snapshot) throw notFound(id);
    const provenance = deriveProvenance(snapshot);
    if (!provenance) throw new UnconfirmedWorkingCopyError(id);
    return { doc: snapshot.document.doc, provenance };
  };

  /** Documents the working copy holds that neither a base nor an intent accounts for. */
  const countUnconfirmed = async (): Promise<number> => {
    let count = 0;
    for (const id of await backend.list()) {
      const snapshot = await snapshotOf(id);
      if (snapshot && deriveProvenance(snapshot) === null) count += 1;
    }
    return count;
  };

  const status = async (): Promise<PlatformSyncStatus> => {
    const local = await localSyncStatus(backend);
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
    };
  };

  return {
    capabilities,

    read: readWithProvenance,

    query: async (filter: QueryFilter = {}): Promise<PlatformQueryRow[]> => {
      const heads = await queryHeads(bundle, filter);
      const rows: PlatformQueryRow[] = [];
      for (const head of heads) {
        // The row is built from the snapshot, not the head, so its version, frontmatter, and
        // provenance describe one moment; a document removed since the scan simply has no row.
        const snapshot = await snapshotOf(head.id);
        if (!snapshot) continue;
        const provenance = deriveProvenance(snapshot);
        if (!provenance) continue;
        rows.push({ id: head.id, version: snapshot.document.version, frontmatter: snapshot.document.doc.frontmatter, provenance });
      }
      return rows;
    },

    validate: async (id: ConceptId): Promise<PlatformValidation> => {
      const { doc, provenance } = await readWithProvenance(id);
      return { id, warnings: await kindWarningsFor(bundle, doc), provenance };
    },

    commit: async (id: ConceptId, edit: PlatformEdit): Promise<PlatformCommit> => {
      const result = await commitLocal(local, id, {
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

    sync: async (): Promise<PlatformSyncStatus> => {
      const readSide: StorageBackend = remote;
      await pushWithRole(local, transport, { remote: readSide, ...(options.write === undefined ? {} : { write: options.write }) }, options.locks === undefined ? {} : { locks: options.locks });
      try {
        // The opened bundle, not its backend: the pull keeps the authority's capabilities on it.
        await pull(local, readSide);
        online = true;
      } catch (error) {
        if (isInputError(error) || isAuthorityAnswer(error)) throw error;
        online = false;
      }
      return status();
    },
  };
}
