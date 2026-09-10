/**
 * The browser-local implementation of the platform contract: every read, query, and validation
 * is answered from the IndexedDB working copy, every commit goes through `commitLocal` (the
 * document write and its pending intent in one transaction), and `sync` delivers intents under
 * the store's push role and refreshes the working copy from the authority.
 *
 * Provenance is derived from the intent journal for the document, never from the write that
 * produced it. The latest unsettled intent for the id decides: `conflict` gives
 * `local-conflict` (with the shared head the intent recorded), and `pending`, `in_flight`,
 * `unknown`, or `refused` gives `local-pending`, because in each of those states the working
 * copy holds an edit the authority has not accepted (a refusal is reported through
 * `syncStatus`, as the pause and the refused count). With no unsettled intent the document is
 * `shared-confirmed` at its recorded shared base (`base:<id>`, written only by bootstrap, pull,
 * or an acknowledgement) when that base names the document's bytes: the same version token, or
 * the same serialized content when an authority mints a different token for identical bytes.
 * A document with no unsettled intent whose bytes its base does not name is a defect in the
 * working copy (every local write journals an intent) and the read rejects rather than guess.
 *
 * `operations` defaults to `false` until the authority's capabilities have been read, which
 * happens on the first `sync` that reaches it; the working copy must open without the authority.
 */

import type { ConceptId, QueryFilter, RemoteBackend, StorageBackend, Version } from "@superbee/core";
import { queryHeads, readDocVersioned } from "@superbee/core/bundle-ops";
import { stringifyDoc } from "@superbee/core/document-codec";
import type { IntentRecord } from "@superbee/core/indexeddb-backend";
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

export function createBrowserLocalRuntime(options: BrowserLocalRuntimeOptions): PlatformRuntime {
  const { local, remote, transport, actor, now } = options;
  const { bundle, backend } = local;
  let operations: boolean | null = null;
  let online: boolean | null = null;

  const capabilities = (): PlatformCapabilities => ({ mode: "browser-local", offlineCommits: true, localPersistence: true, operations: operations === true });

  /** The latest unsettled intent per target, from one journal read. */
  const unsettledByTarget = async (): Promise<Map<ConceptId, IntentRecord>> => {
    const latest = new Map<ConceptId, IntentRecord>();
    for (const row of await backend.listIntents(UNSETTLED_STATES)) latest.set(row.target, row);
    return latest;
  };

  /**
   * Provenance for a document at its local `version`. `raw` is the serialized document when
   * the caller holds it; a query row does not, and reads it only when the tokens differ.
   */
  const provenanceFor = async (id: ConceptId, version: Version, intent: IntentRecord | undefined, raw: string | null): Promise<Provenance> => {
    if (intent) {
      if (intent.state === "conflict") return localConflict(version, intent.base, intent.remote?.version ?? null, intent.requestId);
      return localPending(version, intent.base, intent.requestId);
    }
    const base = await backend.readMeta<SharedBase>(baseKey(id));
    if (base?.version !== null && base?.version !== undefined) {
      if (base.version === version) return sharedConfirmed(base.version);
      const bytes = raw ?? (await serialized(id));
      if (base.content === bytes) return sharedConfirmed(base.version);
    }
    throw new UnconfirmedWorkingCopyError(id);
  };

  const serialized = async (id: ConceptId): Promise<string> => {
    const { doc } = await readDocVersioned(bundle, id);
    return stringifyDoc(doc.frontmatter, doc.body ?? "");
  };

  const readWithProvenance = async (id: ConceptId): Promise<PlatformDocument> => {
    const { doc, version } = await readDocVersioned(bundle, id);
    const intent = (await unsettledByTarget()).get(id);
    return { doc, provenance: await provenanceFor(id, version, intent, stringifyDoc(doc.frontmatter, doc.body ?? "")) };
  };

  const status = async (): Promise<PlatformSyncStatus> => {
    const local = await localSyncStatus(backend);
    return {
      mode: "browser-local",
      online,
      pending: local.counts.pending + local.counts.in_flight + local.counts.unknown,
      conflicts: local.counts.conflict,
      refused: local.counts.refused,
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
      const unsettled = await unsettledByTarget();
      const rows: PlatformQueryRow[] = [];
      for (const head of heads) {
        rows.push({ id: head.id, version: head.version, frontmatter: head.frontmatter, provenance: await provenanceFor(head.id, head.version, unsettled.get(head.id), null) });
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
      // A local write is pending by construction; only the journal, never this write, can say more.
      if (result.intent) return { id, changed: true, provenance: localPending(result.version, result.intent.base, result.intent.requestId) };
      const intent = (await unsettledByTarget()).get(id);
      return { id, changed: false, provenance: await provenanceFor(id, result.version, intent, null) };
    },

    syncStatus: status,

    sync: async (): Promise<PlatformSyncStatus> => {
      if (operations === null) {
        try {
          operations = (await remote.wireCapabilities()).operations;
        } catch (error) {
          if (isInputError(error) || isAuthorityAnswer(error)) throw error;
          // The authority is unreachable; the push below records that the same way.
        }
      }
      const readSide: StorageBackend = remote;
      await pushWithRole(backend, transport, { remote: readSide, ...(options.write === undefined ? {} : { write: options.write }) }, options.locks === undefined ? {} : { locks: options.locks });
      try {
        await pull(backend, readSide);
        online = true;
      } catch (error) {
        if (isInputError(error) || isAuthorityAnswer(error)) throw error;
        online = false;
      }
      return status();
    },
  };
}
