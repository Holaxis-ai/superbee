/**
 * The browser-local working copy's runtime: one {@link JournaledBackend} per bundle name (an
 * {@link IndexedDbBackend} unless the caller supplies another adapter), handed to the engine as
 * `bundle.backend` so every read, query, validation, and compare-and-swap write runs against
 * the page's own store, plus the synchronization verbs that relate that copy to a shared
 * authority. Every verb here is written against the seam, never the IndexedDB class: any
 * adapter that passes the journal rows of the core contract kit can host the working copy.
 *
 * Ownership of meaning: the shared authority admits writes; the working copy records intent.
 * Every local document write goes through {@link commitLocal}, which journals a pending intent
 * in the same store transaction as the record change, so no committed local edit exists
 * without its pending-change record. {@link push} delivers intents through the core
 * uncertain-write primitive and marks one synchronized only when the authority's matching
 * outcome is known. {@link pull} refreshes documents that carry no unsettled intent and records
 * their new shared base; the "no unsettled intent" check is part of the refresh's own store
 * transaction, so a local edit committed during the network round trip is never replaced, and
 * a changed shared head is discovered by push as an explicit conflict that preserves base,
 * local, and remote.
 *
 * Against a wire authority that reports the `snapshot` and `heads` capabilities
 * (`docs/WIRE-PROTOCOL.md`, "Heads and snapshot"), {@link bootstrap} hydrates from one streamed
 * snapshot and {@link pull} reconciles from one conditional heads request: the digest the last
 * bootstrap or pull recorded travels as `If-None-Match`, a `304` means nothing changed and
 * nothing else is fetched, and a `200` is diffed against the working copy so only changed
 * documents are read and documents the authority no longer lists are removed (or, when a local
 * edit holds one, retained and flagged). A listing is trusted only after the wire adapter has
 * recomputed its digest over the rows it served, and even a verified listing never removes,
 * in one step, eight or more documents that amount to more than half of the working copy, or
 * all of it: such a listing (a misrouted or emptied bundle) is refused as a whole, reported
 * with the listing's digest, and no digest is recorded ({@link DeletionRefusal}), so the next
 * pull asks unconditionally. Documents a local edit holds are never counted against the bound;
 * they are retained whatever the listing says. Fewer than eight deletions always apply, so a
 * small working copy follows ordinary deletions and may be emptied by an emptied authority.
 * A genuine shrink beyond the bound never reconciles on its own: the caller passes the
 * recorded refusal back as {@link PullOptions.acceptRefusedDeletions}, and the pull applies
 * the deletions only while the authority still lists the very state that was refused. Any
 * other authority, and any caller that disables a feature through {@link FetchOptions.wire},
 * takes the list plus `readMany` path unchanged; the capabilities are read once per opened
 * bundle and kept on it.
 *
 * The trust model is the authority's word. A forged listing that is internally consistent
 * and within the bound is applied: its deletions land and its refreshes are read from the
 * same authority, and the working copy self-heals at the next honest pull, which lists the
 * real state and fetches what the forgery removed or changed. A forged snapshot can likewise
 * plant documents that read as shared-confirmed until an honest pull no longer lists them.
 * Neither the digest nor the bound is an integrity proof against the authority itself; they
 * catch a listing that is not what its digest names and a listing that is not this bundle.
 *
 * Delivery is recorded before it happens: claiming an intent for push increments its attempts
 * durably, so a page that dies mid-push leaves a record that says "possibly delivered", the
 * next push starts with a lookup, and a later local edit chains behind it instead of replacing
 * its request identity.
 *
 * Meta rows this module owns: `bootstrap` (the completion marker), `sync` (the pause flag),
 * `pull` (the last pull's progress), and `base:<id>` (the shared version and serialized content
 * a document was last known to share with the authority).
 *
 * Coordination across realms: {@link pushWithRole} runs push only while holding the store's
 * push role (a Web Lock in a browser, see `push-role.ts`), so concurrent tabs over one store
 * never race delivery; the intent journal's own compare-and-swap remains the last line.
 */

import type { Bundle, ConceptId, OkfDocument, ReadResult, StorageBackend, Version, WriteOptions } from "@superbee/core";
import { stringifyDoc } from "@superbee/core/document-codec";
import { performBodyDelivery, prepareBodyDelivery, reconcileBodyReceipt, assertSameBodyDelivery, type BodyDeliveryTransport } from "@superbee/core/governed-body-write";
import { parseIsoInstant } from "@superbee/core/verification";
import { versionOfBytes } from "@superbee/core/versioning";
import { JournalGuardConflict, JournalSnapshotConflict } from "@superbee/core/journaled-backend";
import { admitBodyMode, bodyBackend, bodyMode, selectBodyMode, bodyDatabaseName, bodySnapshot, bodyRecordKey, bodyDocument, projectBodyGuard, assertBodyEdition, isBoundedBody, retiredDescriptorKeys,
  validateBodyResolutionReceipt, validateBodyRecord, BODY_MODE_KEY, BODY_RUNTIME_LIMITS, jsonBytes, BodyRuntimeError,
  type BodyDeliveryOptions, type BodyRecord, type BodyMode, type BodyResolutionReceipt, type BodySnapshot } from "./body-journal.js";
import { mutateDocument, type DocumentMutationMode, type DocumentMutationResult, type MutateDocumentOptions } from "@superbee/core/document-mutation";
import { IndexedDbBackend, type IdbFactoryLike } from "@superbee/core/indexeddb-backend";
import {
  DELETION_CONTENT,
  DELETION_VERSION,
  DOCUMENT_DELETE_KIND,
  IntentHoldConflict,
  IntentStateConflict,
  assertJournalSnapshot,
  type IntentRecord,
  type JournaledBackend,
  type JournaledReadResult,
  type MetaRecord,
  type NewIntentRecord,
} from "@superbee/core/journaled-backend";
import type { KindRegistry } from "@superbee/core/kinds";
import type { RefusedDeletions, RefusedDeletionsReason } from "@superbee/core/platform";
import type { RemoteBackend, WireCapabilities } from "@superbee/core/remote";
import { InvalidInputError } from "@superbee/core/storage";
import {
  AUTHORIZATION_REFUSAL_CODES,
  isAuthorizationRefusal,
  mintRequestId,
  performUncertainWrite,
  settleAgainstIntent,
  type OperationState,
  type OperationTransport,
  type Outcome,
  type UncertainWriteOptions,
} from "@superbee/core/uncertain-write";

import { pushRoleName, withPushRole, type PushRoleOptions, type PushRoleResult } from "./push-role.js";
import { captureBodyRefresh, seedBodyRoot, assertBodyRemoteEdition, type BodyRefreshPremises } from "./body-journal.js";

export interface OpenLocalBundleOptions {
  /** Explicit isolated body-delivery store. Custom adapters must be dedicated to this mode. */
  bodyDelivery?: BodyDeliveryOptions;
  /** The IndexedDB factory to open the working copy with. Defaults to the page's `indexedDB`. */
  indexedDB?: IdbFactoryLike;
  /**
   * The adapter holding the working copy. Omitted, an {@link IndexedDbBackend} over `name`. Any
   * adapter that implements the journaled-backend seam serves; `close` is called by the bundle's
   * own `close` when the adapter has one.
   */
  backend?: JournaledBackend & { close?(): void };
}

export interface LocalBundle {
  /** The working copy's name: the IndexedDB database name by default, and what names its push role. */
  name: string;
  /** The engine-facing bundle: a synthetic root label plus the working copy's backend. */
  bundle: Bundle;
  backend: JournaledBackend;
  /**
   * The authority's wire capabilities, read once by the first sync verb that needs them and
   * kept here for the bundle's lifetime; a read that fails is not kept, so the next verb asks
   * again. Absent until a verb over a wire authority has run.
   */
  capabilities?: Promise<WireCapabilities>;
  /** Release the store handle; a later operation reopens it lazily. */
  close(): void;
}

/**
 * Open (or lazily create) the browser-local working copy stored under `name`. The bundle root
 * is a label, not a path: the engine routes every operation through `bundle.backend`.
 */
export function openLocalBundle(name: string, options: OpenLocalBundleOptions = {}): LocalBundle {
  const mode = options.bodyDelivery === undefined ? null : bodyMode(options.bodyDelivery);
  if (mode && options.backend && options.bodyDelivery?.dedicated !== true) throw new BodyRuntimeError("A custom body backend must be explicitly dedicated.");
  const backend = options.backend ?? new IndexedDbBackend({ databaseName: mode ? bodyDatabaseName(name, mode) : name, indexedDB: options.indexedDB });
  if (mode) selectBodyMode(backend, mode);
  const bundle: Bundle = { root: `${options.backend ? "local" : "indexeddb"}://${name}`, backend };
  return { name, bundle, backend, close: () => backend.close?.() };
}

/** Every verb below accepts the opened bundle or its backend directly. */
export type LocalTarget = LocalBundle | JournaledBackend;

/**
 * Structural, not `instanceof`: the seam is an interface, and an opened bundle is the shape that
 * carries one. The discriminator is the pair no adapter has, `bundle` plus the `backend` this
 * function dereferences; `name` and `close` are shapes an adapter may share.
 */
function isLocalBundle(target: LocalTarget): target is LocalBundle {
  const candidate = target as Partial<LocalBundle>;
  return typeof candidate.bundle === "object" && candidate.bundle !== null && typeof candidate.backend === "object" && candidate.backend !== null;
}

function backendOf(target: LocalTarget): JournaledBackend {
  return isLocalBundle(target) ? target.backend : target;
}

async function runtimeBackend(target: LocalTarget): Promise<JournaledBackend> {
  const backend = backendOf(target), mode = await admitBodyMode(backend);
  if (mode) {
    for (const id of new Set((await backend.listIntents()).map(row => row.target))) await bodySnapshot(backend, id, mode);
  }
  return mode ? bodyBackend(backend, mode) : backend;
}

/** The engine-facing bundle for a target: the opened bundle's own, or a labelled one over a bare backend. */
function bundleOf(target: LocalTarget): Bundle {
  return isLocalBundle(target) ? target.bundle : { root: "local://working-copy", backend: target };
}

// ── meta rows ──────────────────────────────────────────────────────────────────────────────

const BOOTSTRAP_KEY = "bootstrap";
const SYNC_KEY = "sync";
const PULL_KEY = "pull";
const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

/** Meta key for the shared base of one document. */
export function baseKey(id: ConceptId): string {
  return `base:${id}`;
}

/** The shared version and serialized content a document was last known to hold at the authority. */
export interface SharedBase {
  version: Version | null;
  content: string | null;
  /**
   * With `version: null`: the deletion that removed the document at the authority, when the
   * working copy knows it. On a base record it is the working copy's own committed delete (the
   * authority's answer), which a create recorded afterwards acknowledges automatically; on a
   * conflict review it is the deletion the authority named, which `keep-local` acknowledges.
   */
  tombstone?: Version;
}

/**
 * Why a pull or a snapshot bootstrap applied none of the deletions a listing implied. The
 * listing was whole and its digest verified, and still it is not trusted to remove documents:
 * `empty-listing` names no document while the working copy holds some, `over-half` names so few
 * that more than half of the working copy would go. A misrouted, emptied or replaced bundle
 * looks exactly like that. Only a listing that would remove at least
 * {@link MIN_BOUNDED_DELETIONS} unheld documents is bounded. Everything else in the verb
 * applied; no digest was recorded, so the next pull asks unconditionally. The shape is the
 * platform contract's, so a presentation can pass a refusal back unchanged.
 */
export type DeletionRefusalReason = RefusedDeletionsReason;

/**
 * The deletions a pull or bootstrap refused to apply, on its marker and its report, with the
 * digest of the listing that implied them; see {@link PullOptions.acceptRefusedDeletions}.
 */
export type DeletionRefusal = RefusedDeletions;

export interface BootstrapMarker {
  generation: number;
  startedAt: string;
  complete: boolean;
  completedAt?: string;
  documentCount?: number;
  /**
   * The heads digest the snapshot announced and the working copy now matches; the first
   * `If-None-Match` a later pull sends. Absent when hydrated by list, and absent when the
   * snapshot's deletions were refused, since the working copy then holds more than the digest names.
   */
  headsDigest?: string;
  /**
   * Documents left as a local edit made them: not hydrated because the edit was committed to
   * them during this bootstrap, or not removed because the edit holds a document the snapshot
   * did not carry.
   */
  held?: ConceptId[];
  /** Documents a snapshot bootstrap removed because an earlier generation held them and the snapshot did not carry them. */
  deleted?: ConceptId[];
  /** The deletions a snapshot bootstrap refused to apply; see {@link DeletionRefusal}. */
  refused?: DeletionRefusal;
  /** Observations recorded during hydration, such as a local token differing from the shared one. */
  findings?: string[];
}

export interface SyncControl {
  paused: boolean;
  reason?: string;
  since?: string;
}

export interface PullMarker {
  startedAt: string;
  completedAt: string | null;
  refreshed: number;
  /** True when the authority answered the conditional heads request with `304`: nothing changed, nothing was fetched. */
  unchanged: boolean;
  /** The heads digest the working copy matched when this pull completed. Absent for a pull by list, and when deletions were refused. */
  headsDigest?: string;
  /** The deletions this pull refused to apply; see {@link DeletionRefusal}. */
  refused?: DeletionRefusal;
}

/** States in which an intent still describes a local edit the authority has not accepted. */
export const UNSETTLED_STATES: readonly OperationState[] = ["pending", "in_flight", "conflict", "refused", "unknown"];

function baseRow(id: ConceptId, base: SharedBase): MetaRecord {
  return { key: baseKey(id), value: base };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** Documents fetched per `readMany` round trip unless the caller says otherwise. */
const DEFAULT_BATCH_SIZE = 25;
/** Batches in flight at once unless the caller says otherwise. */
const DEFAULT_CONCURRENCY = 8;

/**
 * Which wire features a fetching verb may use when the authority reports them. `false`
 * disables one; the list plus `readMany` path is then taken. Omitted, whatever the authority's
 * capabilities report.
 */
export interface WireOptions {
  heads?: boolean;
  snapshot?: boolean;
}

/** Options both fetching verbs share: how the remote document set is split and how many splits travel at once. */
export interface FetchOptions {
  /** Documents fetched per `readMany` round trip, and written per batch as a snapshot streams. */
  batchSize?: number;
  /** Wire features to use or refuse; see {@link WireOptions}. */
  wire?: WireOptions;
  /**
   * Batches fetched concurrently, at most; default 8, minimum 1. Wall time is then bounded by
   * transfer and a few round trips instead of the batch count times the latency. A value below
   * 1 or not an integer is refused with {@link InvalidInputError} before anything is written.
   */
  concurrency?: number;
}

function concurrencyOf(options: FetchOptions): number {
  const value = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1) throw new InvalidInputError(`concurrency must be an integer of at least 1, got ${String(value)}`);
  return value;
}

/**
 * Run `work` over every batch with at most `concurrency` calls in flight: a bounded pool of
 * workers pulling from one shared cursor, so batches start in list order and each batch is
 * fetched and written by the worker that took it. A worker's failure stops the others from
 * taking further batches, but every batch already in flight runs to its own end (fetched, then
 * written) before the first failure is rethrown; nothing is left pending and no rejection goes
 * unobserved. Which batch fails first under concurrency is not deterministic; that the caller
 * sees exactly one rejection, after the pool has drained, is.
 */
async function forEachBatch<T>(batches: readonly T[][], concurrency: number, work: (batch: T[]) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < batches.length) {
      const batch = batches[next]!;
      next += 1;
      try {
        await work(batch);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  // Workers catch their own work; a rejection here would be a defect in the pool itself, and it
  // is still surfaced rather than dropped.
  for (const outcome of outcomes) if (outcome.status === "rejected") failure ??= { error: outcome.reason };
  if (failure !== null) throw failure.error;
}

/** The version of the document currently stored locally, or `null` when absent. */
async function localVersion(backend: JournaledBackend, id: ConceptId): Promise<Version | null> {
  try {
    return (await backend.read(id)).version;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return null;
    throw error;
  }
}

// ── deletions ──────────────────────────────────────────────────────────────────────────────

/**
 * Deletions below this count are applied on a verified listing's word without the bound: a
 * small working copy must follow ordinary deletions (three documents, two removed), and a
 * misrouted bundle is a mass event, not a handful.
 */
const MIN_BOUNDED_DELETIONS = 8;

/**
 * The bound a verified listing must stay within before any document is removed on its word:
 * `undefined` when the deletions may apply, otherwise the refusal to report. `listedCount` is
 * the number of documents the listing names, `presentCount` how many the working copy holds
 * now, `candidates` how many of those the listing does not name and no local edit holds, and
 * `digest` names the listing so the refusal can be passed back.
 */
function deletionBound(listedCount: number, presentCount: number, candidates: number, digest: string): DeletionRefusal | undefined {
  if (candidates < MIN_BOUNDED_DELETIONS) return undefined;
  if (listedCount === 0) return { deletions: candidates, reason: "empty-listing", digest };
  if (candidates * 2 > presentCount) return { deletions: candidates, reason: "over-half", digest };
  return undefined;
}

/** True when `accepted` is the very refusal `refused` describes: same listing, same count, same reason. */
function acceptsRefusal(refused: DeletionRefusal, accepted: DeletionRefusal | undefined): boolean {
  return accepted !== undefined && accepted.digest === refused.digest && accepted.deletions === refused.deletions && accepted.reason === refused.reason;
}

/**
 * Remove from the working copy every document a verified listing no longer names, each with
 * its base in one journaled operation that checks the hold inside its own transaction, or
 * refuse the whole set when it is out of bounds ({@link deletionBound}). Documents an unsettled
 * intent targets are excluded from the bound's count before it is applied: they are held
 * whatever the listing says, so a batch of offline creates never turns one real deletion into
 * a refusal. A refusal the caller has already seen and passes back as `accept`, for the same
 * listing digest, is applied instead of refused ({@link PullOptions.acceptRefusedDeletions}).
 * A document a local edit holds is retained, reported as held, and its base rewritten to
 * version `null` in the same transaction as the refusing hold check (the seam's `onHeld`), so
 * the base agrees with the absent remote; the conflict itself is recorded by push when the
 * authority answers the edit with a conflict whose actual version is `null`. A document whose
 * version moved under a plain local write between the read and the deletion is likewise held,
 * as a refresh treats it. This is the one reconciliation pull and a snapshot bootstrap share.
 */
async function reconcileDeletions(
  backend: JournaledBackend,
  listed: ReadonlySet<ConceptId>,
  digest: string,
  accept?: DeletionRefusal,
  premises?: BodyRefreshPremises,
  beforeDelete?: () => Promise<void>,
): Promise<{ deleted: ConceptId[]; held: ConceptId[]; refused?: DeletionRefusal }> {
  const present = await backend.list();
  const candidates = present.filter((id) => !listed.has(id));
  const heldTargets = new Set((await backend.listIntents(UNSETTLED_STATES)).map((row) => row.target));
  const unheld = candidates.filter((id) => !heldTargets.has(id)).length;
  const refused = deletionBound(listed.size, present.length, unheld, digest);
  if (refused && !acceptsRefusal(refused, accept)) return { deleted: [], held: [], refused };
  const deleted: ConceptId[] = [];
  const held: ConceptId[] = [];
  for (const id of candidates) {
    const previous = await backend.readMeta<SharedBase>(baseKey(id));
    // The premise is the version just listed; a document gone since is answered as absent.
    const expectedVersion = await localVersion(backend, id);
    try {
      await beforeDelete?.();
      const result = await backend.deleteJournaled(id, {
        ...(premises ? { guard: premises.guard(id) } : {}),
        ...(expectedVersion === null ? {} : { expectedVersion }),
        requireSettled: true,
        removeMeta: [baseKey(id)],
        onHeld: { meta: [baseRow(id, { version: null, content: previous?.content ?? null })] },
      });
      if (result.outcome === "held") held.push(id);
      else if (result.outcome === "deleted") deleted.push(id);
    } catch (error) {
      if ((error as { name?: unknown })?.name !== "VersionConflict") throw error;
      held.push(id);
    }
  }
  return { deleted, held };
}

// ── wire features ──────────────────────────────────────────────────────────────────────────

/**
 * Structural, not `instanceof`: the read side may be the core class, a subclass, or a proxy
 * over one. The three members the fetching verbs use beyond the storage seam are the shape.
 */
function asWireRemote(remote: StorageBackend): RemoteBackend | null {
  const candidate = remote as Partial<RemoteBackend>;
  return typeof candidate.heads === "function" && typeof candidate.snapshot === "function" && typeof candidate.wireCapabilities === "function"
    ? (remote as RemoteBackend)
    : null;
}

/** The authority's capabilities: kept on the opened bundle; a bare adapter has nowhere to keep them, so they are read per call. */
function capabilitiesOf(local: LocalTarget, remote: RemoteBackend): Promise<WireCapabilities> {
  if (!isLocalBundle(local)) return remote.wireCapabilities();
  if (!local.capabilities) {
    const pending = remote.wireCapabilities();
    local.capabilities = pending;
    pending.catch(() => {
      if (local.capabilities === pending) delete local.capabilities;
    });
  }
  return local.capabilities;
}

/**
 * The wire read side when `feature` may be used: the remote is a wire adapter, the caller has
 * not refused the feature, and the authority reports it. Otherwise `null`, and the caller takes
 * the list path. A refused feature costs no request.
 */
async function wireFor(remote: StorageBackend, local: LocalTarget, feature: keyof WireOptions, options: FetchOptions): Promise<RemoteBackend | null> {
  if (options.wire?.[feature] === false) return null;
  const wire = asWireRemote(remote);
  if (!wire) return null;
  return (await capabilitiesOf(local, wire))[feature] ? wire : null;
}

// ── bootstrap ──────────────────────────────────────────────────────────────────────────────

export interface BootstrapOptions extends FetchOptions {
  /**
   * Called after each document is hydrated; a progress hook for a page, a fault point for a
   * test. `index` counts hydrated documents in completion order, which under concurrency is not
   * the authority's list order.
   */
  onHydrated?: (id: ConceptId, index: number, total: number) => void | Promise<void>;
}

/**
 * Hydrate the working copy from the authority: every remote document is written locally with
 * the shared version recorded as its base. Legacy mode copies the root `index.md`; body mode
 * seeds only an absent local root and validates the remote edition without mirroring metadata.
 * Only after every write has committed does the marker say `complete`. The marker
 * is written incomplete first, so an interruption at any point leaves a bundle that reports
 * itself incomplete rather than an apparently complete, partially hydrated one.
 *
 * Bootstrap refuses to run over unsettled intents: rewriting their targets would discard local
 * edits the authority has not accepted. An edit committed while bootstrap is already fetching is
 * caught by the hydrating write's own transaction: that document is left as the edit made it,
 * listed in the marker as `held`, and push discovers the divergence.
 *
 * Over a wire authority that reports `snapshot`, the documents arrive as one streamed response
 * and are written in batches of `batchSize` as they arrive; a snapshot the authority cuts short
 * rejects with the wire adapter's `SNAPSHOT_TRUNCATED`, one whose rows do not digest to its
 * header with `SNAPSHOT_DIGEST_MISMATCH`, and either leaves the marker incomplete. Once the
 * stream has ended whole and verified, the documents an earlier generation left in the working
 * copy that the snapshot did not carry are reconciled exactly as a pull reconciles deletions
 * (removed with their base, retained when a local edit holds them, refused as a whole when out
 * of bounds), and the marker records the digest the snapshot announced as `headsDigest` only
 * when the working copy now matches it. Otherwise the ids are listed and fetched in batches
 * that travel concurrently (see {@link FetchOptions}); each batch is written as it arrives,
 * through the same per-document write, and nothing is removed. A failed batch leaves the
 * marker incomplete and its error propagates once the batches in flight have finished.
 */
export async function bootstrap(remote: StorageBackend, local: LocalTarget, options: BootstrapOptions = {}): Promise<BootstrapMarker> {
  const concurrency = concurrencyOf(options);
  const backend = await runtimeBackend(local);
  const bodyMode = await admitBodyMode(backendOf(local));
  const validateReadSide = bodyMode ? () => assertBodyRemoteEdition(remote, bodyMode) : undefined;
  const unsettled = await backend.listIntents(UNSETTLED_STATES);
  if (unsettled.length > 0) {
    throw new Error(`bootstrap refused: ${unsettled.length} unsettled intent(s) would be discarded; push or resolve them first.`);
  }
  const previous = await backend.readMeta<BootstrapMarker>(BOOTSTRAP_KEY);
  const generation = (previous?.generation ?? 0) + 1;
  const startedAt = new Date().toISOString();
  await backend.writeMeta(BOOTSTRAP_KEY, { generation, startedAt, complete: false } satisfies BootstrapMarker);

  if (bodyMode) {
    await seedBodyRoot(backendOf(local), bodyMode);
    await assertBodyRemoteEdition(remote, bodyMode);
  } else {
    const rootIndex = await remote.readReserved("", "index.md");
    if (rootIndex) await backend.writeReserved("", "index.md", rootIndex.content);
  }

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const findings: string[] = [];
  const held: ConceptId[] = [];
  let index = 0;
  /** One document as the authority served it, into the working copy, with the marker's bookkeeping. */
  const hydrate = async (head: ReadResult, total: number, premises?: BodyRefreshPremises): Promise<void> => {
    if (bodyMode) await assertBodyRemoteEdition(remote, bodyMode);
    const id = head.doc.id;
    try {
      const { version } = await backend.writeJournaled(id, head.doc, {
        ...(premises ? { guard: premises.guard(id) } : {}),
        requireSettled: true,
        meta: ({ raw }) => [baseRow(id, { version: head.version, content: raw })],
      });
      if (version !== head.version) {
        findings.push(`'${id}': local token ${version} differs from shared token ${head.version}`);
      }
    } catch (error) {
      if (!(error instanceof IntentHoldConflict)) throw error;
      held.push(id);
    }
    // Take the index before awaiting the hook: another worker's completion can interleave
    // with an awaiting hook, and the index must stay unique per hydrated document.
    const hydrated = index;
    index += 1;
    await options.onHydrated?.(id, hydrated, total);
  };

  let documentCount: number;
  let headsDigest: string | undefined;
  let deleted: ConceptId[] = [];
  let refused: DeletionRefusal | undefined;
  const wire = await wireFor(remote, local, "snapshot", options);
  if (wire) {
    const premises = bodyMode ? await captureBodyRefresh(backendOf(local), bodyMode) : undefined;
    // One stream: concurrency does not apply. Each batch is written as soon as it has arrived,
    // so a cut stream leaves whole batches behind and the marker incomplete.
    const { header, docs } = await wire.snapshot();
    await validateReadSide?.();
    const listed = new Set<ConceptId>();
    let batch: ReadResult[] = [];
    for await (const doc of docs) {
      listed.add(doc.id);
      batch.push({ doc: { id: doc.id, frontmatter: doc.frontmatter, body: doc.body }, version: doc.version });
      if (batch.length < batchSize) continue;
      for (const head of batch) await hydrate(head, header.count, premises);
      batch = [];
    }
    for (const head of batch) await hydrate(head, header.count, premises);
    // The loop ended normally, so the stream was whole and its rows digest to the header: the
    // listing may now say what the working copy should not hold.
    await validateReadSide?.();
    const reconciled = await reconcileDeletions(backend, listed, header.digest, undefined, premises, validateReadSide);
    deleted = reconciled.deleted;
    held.push(...reconciled.held);
    refused = reconciled.refused;
    documentCount = header.count;
    if (refused === undefined) headsDigest = header.digest;
  } else {
    const ids = await remote.list();
    await forEachBatch(chunked(ids, batchSize), concurrency, async (batch) => {
      const premises = bodyMode ? await captureBodyRefresh(backendOf(local), bodyMode, batch) : undefined;
      for (const head of await remote.readMany(batch)) await hydrate(head, ids.length, premises);
    });
    documentCount = ids.length;
  }

  await validateReadSide?.();
  const marker: BootstrapMarker = {
    generation,
    startedAt,
    complete: true,
    completedAt: new Date().toISOString(),
    documentCount,
    ...(headsDigest === undefined ? {} : { headsDigest }),
    ...(held.length > 0 ? { held } : {}),
    ...(deleted.length > 0 ? { deleted } : {}),
    ...(refused === undefined ? {} : { refused }),
    ...(findings.length > 0 ? { findings } : {}),
  };
  await backend.writeMeta(BOOTSTRAP_KEY, marker);
  return marker;
}

/** True only when the last bootstrap wrote its completion marker after every document committed. */
export async function isComplete(local: LocalTarget): Promise<boolean> {
  const marker = await (await runtimeBackend(local)).readMeta<BootstrapMarker>(BOOTSTRAP_KEY);
  return marker?.complete === true;
}

// ── local commits ──────────────────────────────────────────────────────────────────────────

/** The engine mutation to apply; `patch` over an empty registry, non-strict, unless overridden. */
export type LocalMutation = Omit<MutateDocumentOptions, "bundle" | "id" | "mode" | "registry" | "strict"> & {
  mode?: DocumentMutationMode;
  registry?: KindRegistry;
  strict?: boolean;
};

export interface CommitResult extends DocumentMutationResult {
  /** The intent journaled with this write, or `null` when the engine found nothing to change. */
  intent: IntentRecord | null;
}

/**
 * How a new local edit relates to the intents already journaled for its target.
 *
 * Compose-per-id: when the latest intent for the id is `pending` and has never been submitted
 * (`attempts === 0`), or is `refused` (the authority definitely did not apply it), the new
 * write supersedes it in the same transaction: the old record is deleted, and the new one
 * carries a fresh request identity, the ORIGINAL base, and the new content. One intent per id
 * then describes the cumulative change against the shared base.
 *
 * When the latest intent may already have reached the authority (`in_flight`, or `pending`
 * with `attempts > 0`, which includes an intent reclaimed after a crash mid-push because the
 * claim records the attempt before delivery), or holds an explicit `conflict` awaiting
 * resolution, its content and identity are frozen: the new edit becomes a separate intent whose
 * base is the predecessor's local version and whose `after` names it. Push delivers it only
 * once the predecessor is acknowledged, and the predecessor's acknowledgement can never clear
 * it, because it is its own record with its own identity.
 */
async function composeIntent(backend: JournaledBackend, id: ConceptId, now: string): Promise<{ intent: NewIntentRecord; supersede?: { requestId: string; expectedState: OperationState; expectedAttempts: number } }> {
  const unsettled = (await backend.listIntents(UNSETTLED_STATES)).filter((row) => row.target === id);
  const latest = unsettled[unsettled.length - 1];
  if (!latest) {
    const shared = await backend.readMeta<SharedBase>(baseKey(id));
    // A document this working copy itself deleted, and the authority acknowledged: a create
    // recorded after that acknowledges the deletion it re-creates (design binding decision 3).
    const recreates = (shared?.version ?? null) === null ? shared?.tombstone : undefined;
    return {
      intent: {
        requestId: mintRequestId(),
        kind: "document.write",
        target: id,
        base: shared?.version ?? null,
        baseContent: shared?.content ?? null,
        createdAt: now,
        ...(recreates !== undefined ? { recreates } : {}),
      },
    };
  }
  const neverDelivered = latest.state === "pending" && latest.attempts === 0;
  if (neverDelivered || latest.state === "refused") {
    // A write over a never-delivered delete collapses the two into one change against the base:
    // a replace, never a delete and a re-create.
    return {
      intent: {
        requestId: mintRequestId(),
        kind: "document.write",
        target: id,
        base: latest.base,
        baseContent: latest.baseContent,
        createdAt: now,
        ...(latest.after !== undefined ? { after: latest.after } : {}),
        ...(latest.recreates !== undefined && latest.base === null ? { recreates: latest.recreates } : {}),
      },
      supersede: { requestId: latest.requestId, expectedState: latest.state, expectedAttempts: latest.attempts },
    };
  }
  // After a delete that may have landed, the document is absent: the next write is a create.
  const deleting = latest.kind === DOCUMENT_DELETE_KIND;
  return {
    intent: {
      requestId: mintRequestId(),
      kind: "document.write",
      target: id,
      base: deleting ? null : latest.local,
      baseContent: deleting ? null : latest.content,
      createdAt: now,
      after: latest.requestId,
    },
  };
}

/**
 * What a chained intent, never yet sent, must carry once its predecessor is acknowledged: the
 * version the authority actually committed it at, not the one the working copy computed. An
 * authority that stores its own serialization (a hosted checkout's managed fields) commits a
 * write at another version than its `local`, and a successor sent against `local` would conflict
 * with the person's own edit. After the working copy's own acknowledged deletion, a create
 * chained behind it acknowledges that deletion's tombstone, as a create recorded afterwards does.
 * The identity was never used, so nothing recorded under it changes meaning.
 */
function chainedPremise(intent: IntentRecord, predecessor: IntentRecord): Pick<IntentRecord, "base"> | Pick<IntentRecord, "recreates"> | Record<string, never> {
  const committed = predecessor.acknowledgedVersion;
  if (committed === undefined) return {};
  if (predecessor.kind === DOCUMENT_DELETE_KIND) {
    return intent.base === null && intent.recreates === undefined && intent.kind !== DOCUMENT_DELETE_KIND && committed !== DELETION_VERSION ? { recreates: committed } : {};
  }
  return intent.base === predecessor.local && committed !== predecessor.local ? { base: committed } : {};
}

/** The base a chained intent's successor holds: its local version, or none after a deletion. */
function chainedBase(intent: IntentRecord): Version | null {
  return intent.kind === DOCUMENT_DELETE_KIND ? null : intent.local;
}

const COMPOSE_ATTEMPTS = 3;

/**
 * A backend the engine writes through: every method is the working copy's own except `write`,
 * which journals the intent in the same transaction as the record. The engine keeps every
 * policy it has (kinds, clocks, no-op detection, CAS retry); only persistence is redirected.
 */
function journalingBackend(backend: JournaledBackend, id: ConceptId, recorded: { intent: IntentRecord | null }): StorageBackend {
  const write = async (target: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> => {
    if (target !== id) throw new Error(`commitLocal for '${id}' cannot write '${target}'`);
    for (let attempt = 0; ; attempt++) {
      const composed = await composeIntent(backend, id, new Date().toISOString());
      try {
        const written = await backend.writeJournaled(id, doc, { ...options, ...composed });
        recorded.intent = written.intent;
        return written.version;
      } catch (error) {
        // Another realm moved the superseded intent between the read and the transaction; the
        // document CAS still holds, so recompose against the journal as it is now.
        if (error instanceof IntentStateConflict && attempt < COMPOSE_ATTEMPTS - 1) continue;
        throw error;
      }
    }
  };
  return new Proxy(backend, {
    get(inner, prop) {
      if (prop === "write") return write;
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  }) as unknown as StorageBackend;
}

/**
 * Apply an engine mutation to the working copy and journal it as a pending intent in the same
 * store transaction as the document write. The intent's base is the shared base the edit
 * was made against (see {@link composeIntent}), never the local head.
 */
export async function commitLocal(local: LocalTarget, id: ConceptId, mutation: LocalMutation): Promise<CommitResult> {
  const backend = backendOf(local);
  if (await admitBodyMode(backend)) throw new BodyRuntimeError("Use the explicit body commit for this working copy.");
  const recorded: { intent: IntentRecord | null } = { intent: null };
  const { mode, registry, strict, ...rest } = mutation;
  const result = await mutateDocument({
    ...rest,
    bundle: { root: bundleOf(local).root, backend: journalingBackend(backend, id, recorded) },
    id,
    mode: mode ?? "patch",
    registry: registry ?? EMPTY_REGISTRY,
    strict: strict ?? false,
  });
  return { ...result, intent: recorded.intent };
}

export interface DeleteLocalResult {
  /** True when the working copy held the document and removed it. */
  deleted: boolean;
  /**
   * The deletion journaled with it, or `null` when there is nothing to delete at the authority:
   * the document never reached it (a create that never left collapses to nothing), or the
   * working copy never held a shared version of it.
   */
  intent: IntentRecord | null;
}

/**
 * Remove a document from the working copy and journal its deletion (`document.delete`) in the
 * same store transaction, compare-and-swap on the local version (`expectedVersion`, the current
 * one by default). The deletion is against the shared base the local change was made against,
 * composed as {@link composeIntent} composes a write:
 * - over a never-delivered or refused change, it supersedes it, keeping its base; a create that
 *   never left collapses to nothing (no intent);
 * - after a change that may have landed, it is chained after it (`after`), against its version;
 * - over a recorded conflict it is refused: resolve the conflict first.
 * An absent document is not an error: nothing changes and `deleted` is false.
 */
export async function deleteLocal(local: LocalTarget, id: ConceptId, options: { expectedVersion?: Version } = {}): Promise<DeleteLocalResult> {
  const backend = backendOf(local);
  if (await admitBodyMode(backend)) throw new BodyRuntimeError("Body delivery does not delete documents.");
  for (let attempt = 0; ; attempt++) {
    const read = await backend.readWithJournal(id, { meta: [baseKey(id)] });
    if (!read.document) return { deleted: false, intent: null };
    const unsettled = read.intents.filter((row) => row.state !== "acknowledged");
    const latest = unsettled[unsettled.length - 1];
    const now = new Date().toISOString();
    let intent: NewIntentRecord | undefined;
    let supersede: { requestId: string; expectedState: OperationState; expectedAttempts: number } | undefined;
    if (!latest) {
      const shared = read.meta.get(baseKey(id)) as SharedBase | undefined;
      if (shared?.version) intent = { requestId: mintRequestId(), kind: DOCUMENT_DELETE_KIND, target: id, base: shared.version, baseContent: shared.content, createdAt: now };
    } else if ((latest.state === "pending" && latest.attempts === 0) || latest.state === "refused") {
      supersede = { requestId: latest.requestId, expectedState: latest.state, expectedAttempts: latest.attempts };
      if (latest.base !== null) {
        intent = { requestId: mintRequestId(), kind: DOCUMENT_DELETE_KIND, target: id, base: latest.base, baseContent: latest.baseContent, createdAt: now, ...(latest.after !== undefined ? { after: latest.after } : {}) };
      }
    } else if (latest.state === "conflict") {
      throw new InvalidInputError(`'${id}' has a conflict to resolve before it can be deleted.`);
    } else {
      intent = { requestId: mintRequestId(), kind: DOCUMENT_DELETE_KIND, target: id, base: latest.local, baseContent: latest.content, createdAt: now, after: latest.requestId };
    }
    try {
      const result = await backend.deleteJournaled(id, {
        expectedVersion: options.expectedVersion ?? read.document.version,
        ...(intent ? { intent } : {}),
        ...(supersede ? { supersede } : {}),
      });
      return { deleted: result.outcome === "deleted", intent: result.outcome === "held" ? null : result.intent ?? null };
    } catch (error) {
      // Another realm moved the superseded intent between the read and the transaction.
      if (error instanceof IntentStateConflict && attempt < COMPOSE_ATTEMPTS - 1) continue;
      throw error;
    }
  }
}

export interface BodyLocalMutation { body: string; expectedVersion?: Version; actor?: string; now?: () => string }
/** Explicit body intent, authored by the existing engine and journaled in its document CAS. */
export async function commitBodyLocal(local: LocalTarget, id: ConceptId, mutation: BodyLocalMutation): Promise<CommitResult> {
  const allowed = ["body", "expectedVersion", "actor", "now"];
  if (!mutation || ![Object.prototype, null].includes(Object.getPrototypeOf(mutation)) || Reflect.ownKeys(mutation).some(key => typeof key !== "string" || !allowed.includes(key)) || Object.values(Object.getOwnPropertyDescriptors(mutation)).some(row => !("value" in row) || !row.enumerable) || !isBoundedBody(mutation.body) || (mutation.actor !== undefined && typeof mutation.actor !== "string") || (mutation.now !== undefined && typeof mutation.now !== "function")) throw new BodyRuntimeError("Expected a bounded body-only update.");
  const input = { ...mutation };
  const backend = backendOf(local), mode = await admitBodyMode(backend);
  if (!mode) throw new BodyRuntimeError("Body delivery mode was not selected.");
  await assertBodyEdition(backend, mode);
  if (!(await isComplete(local))) throw new BodyRuntimeError("Bootstrap must complete before local body commits.");
  const initial = await bodySnapshot(backend, id, mode);
  if (!initial.read.document) throw new BodyRuntimeError("Body delivery does not create documents.");
  let recorded: IntentRecord | null = null;
  const write = async (target: string, candidate: OkfDocument, options: WriteOptions = {}): Promise<Version> => {
    if (target !== id) throw new BodyRuntimeError("Body commit changed target.");
    const requestId = mintRequestId(), key = bodyRecordKey(requestId);
    const doc = bodyDocument(stringifyDoc(candidate.frontmatter, candidate.body ?? ""), id, mode);
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? ""), version = versionOfBytes(raw);
    for (let retry = 0; retry < COMPOSE_ATTEMPTS; retry++) {
      const snap = await bodySnapshot(backend, id, mode, [key]);
      const unsettled = snap.read.intents.filter(row => row.state !== "acknowledged"), latest = unsettled.at(-1);
      const evidence = latest ? snap.records.get(latest.requestId)! : undefined;
      const supersede = latest?.state === "pending" && latest.attempts === 0 && !evidence?.prepared && !evidence?.receipt ? latest : undefined;
      const after = supersede ? supersede.after : latest?.requestId;
      const shared = snap.read.meta.get(baseKey(id)) as SharedBase | undefined;
      const base = latest ? (supersede ? latest.base : latest.local) : shared?.version;
      if (!after && !base) throw new BodyRuntimeError("Body updates require a known authority premise.");
      const createdAt = new Date().toISOString();
      const intent: NewIntentRecord = { requestId, kind: "document.body.update", target: id, base: base ?? null, baseContent: latest ? (supersede ? latest.baseContent : latest.content) : shared?.content ?? null, createdAt, ...(after ? { after } : {}) };
      const descriptor: BodyRecord = { schema: 1, requestId, target: id, scope: mode.scope, okfVersion: mode.okfVersion, body: input.body, initialVersion: after ? null : base! };
      const meta = [{ key, value: descriptor }], removeMeta = supersede ? retiredDescriptorKeys([supersede]) : [];
      const projected: IntentRecord = { ...intent, sequence: Number.MAX_SAFE_INTEGER, local: version, content: raw, updatedAt: createdAt, attempts: 0, state: "pending" };
      projectBodyGuard(snap.guard, { document: { version, raw }, intents: [...snap.read.intents.filter(row => row.requestId !== supersede?.requestId), projected], meta, removeMeta });
      try {
        const result = await backend.writeJournaled(id, doc, { ...options, guard: snap.guard, intent, meta, removeMeta, ...(supersede ? { supersede: { requestId: supersede.requestId, expectedState: supersede.state, expectedAttempts: 0 } } : {}) });
        recorded = result.intent;
        return result.version;
      } catch (error) { if (!(error instanceof JournalGuardConflict) || retry === COMPOSE_ATTEMPTS - 1) throw error; }
    }
    throw new JournalGuardConflict(id);
  };
  const persistence = new Proxy(backend, { get(inner, key) { if (key === "write") return write; const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value; } });
  const result = await mutateDocument({ bundle: { ...bundleOf(local), backend: persistence }, id, mode: "patch", registry: EMPTY_REGISTRY, strict: false,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), actor: input.actor, now: input.now,
    buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: input.body }) });
  return { ...result, intent: recorded };
}

/** A reviewable snapshot, not permission to overwrite a later local or shared version. */
export interface ConflictReview {
  id: ConceptId;
  /** The working copy's side: its document, or, for a journaled deletion, `deleted` with no content. */
  local: { version: Version; content: string; deleted?: true };
  base: SharedBase;
  remote: SharedBase;
  intents: IntentRecord[];
}

export type ConflictChoice =
  | { kind: "keep-local" }
  | { kind: "take-remote" }
  | { kind: "revise"; body: string; frontmatter?: OkfDocument["frontmatter"] };

/** Retained in the same transaction as the resolution, including all replaced local intents. */
export interface ConflictResolutionReceipt {
  id: string;
  reviewed: ConflictReview;
  choice: ConflictChoice["kind"];
  resolvedAt: string;
  replacementRequestId: string | null;
}

export interface ConflictResolutionResult {
  /** The exact-mode review receipt, or in body mode the bounded {@link BodyResolutionReceipt}. */
  receipt: ConflictResolutionReceipt | BodyResolutionReceipt;
  intent: IntentRecord | null;
  version: Version | null;
}

export class ConflictReviewStaleError extends Error {
  constructor() {
    super("The conflict changed since review. Inspect it again before choosing a resolution.");
    this.name = "ConflictReviewStaleError";
  }
}

/**
 * Durable recovery receipt key; receipts are retained, not silently pruned with pending edits.
 * Exact mode keeps the whole review; body mode a bounded record without content. Either way one
 * row remains per resolution, so the store grows with resolutions.
 */
export function conflictResolutionKey(id: string): string { return `conflict-resolution:${id}`; }

async function readConflictRemote(remote: StorageBackend, id: ConceptId): Promise<{ base: SharedBase; doc: OkfDocument | null }> {
  try {
    const read = await remote.read(id);
    return { base: { version: read.version, content: stringifyDoc(read.doc.frontmatter, read.doc.body ?? "") }, doc: read.doc };
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return { base: { version: null, content: null }, doc: null };
    throw error;
  }
}

/** A refused head is resolvable only when the refusal was about the content; lost permission keeps the resume path. */
function isContentRefusal(row: IntentRecord): boolean {
  return row.state === "refused" && row.refusal !== undefined && !AUTHORIZATION_REFUSAL_CODES.has(row.refusal.code);
}

/**
 * The resolvable chain in one journal snapshot: the complete unsettled journal, headed by a
 * recorded conflict (or, with `admitRefused`, a content refusal), continued only by dependent
 * edits, whose latest bytes are the working document. Body mode admits the refused head, since
 * a refused body update cannot be superseded by a later edit; exact mode keeps its rule, where
 * a later edit supersedes a refused request.
 */
function conflictChain(id: ConceptId, snapshot: JournaledReadResult, admitRefused: boolean) {
  const intents = snapshot.intents.filter(row => row.state !== "acknowledged");
  // Exact mode keeps the seam's earlier answer for a set with no conflict row, so its refusal
  // of a refused head is the class it always was.
  if (!admitRefused && !intents.some(row => row.state === "conflict")) throw new JournalSnapshotConflict(id);
  assertJournalSnapshot(id, intents, snapshot.intents);
  const head = intents[0];
  // A chain that ends in a journaled deletion describes an absent working document.
  const deleting = intents[intents.length - 1]?.kind === DOCUMENT_DELETE_KIND;
  if ((deleting ? snapshot.document !== null : !snapshot.document || snapshot.raw === null) || !head || !(head.state === "conflict" || (admitRefused && isContentRefusal(head)))) {
    throw new InvalidInputError(admitRefused
      ? "Conflict recovery requires an existing local document and a first pending edit the authority answered with a conflict or a content refusal; lost permission is resumed, not resolved."
      : "Conflict recovery requires an existing local document and a conflicted first pending edit.");
  }
  for (let index = 1; index < intents.length; index++) {
    if (intents[index]!.after !== intents[index - 1]!.requestId || intents[index]!.base !== chainedBase(intents[index - 1]!)) {
      throw new InvalidInputError("Conflict recovery requires one dependent edit chain.");
    }
  }
  const latest = intents[intents.length - 1]!;
  if (!deleting && (latest.local !== snapshot.document!.version || latest.content !== snapshot.raw)) {
    throw new InvalidInputError("The working document is not the latest journaled edit; preserve and reconcile it before resolving.");
  }
  return { snapshot, intents, document: snapshot.document, deleting };
}

async function conflictLocal(backend: JournaledBackend, id: ConceptId, admitRefused = false) {
  return conflictChain(id, await backend.readWithJournal(id), admitRefused);
}

/** Fetch the shared head explicitly; authorization/network failure is never treated as deletion. */
export async function inspectConflict(local: LocalTarget, remote: StorageBackend, id: ConceptId): Promise<ConflictReview> {
  const backend = await runtimeBackend(local);
  const mode = await admitBodyMode(backendOf(local));
  if (mode) await bodySnapshot(backendOf(local), id, mode);
  const { snapshot, intents, document } = await conflictLocal(backend, id, mode !== null);
  const shared = await readConflictRemote(remote, id);
  return {
    id,
    local: document ? { version: document.version, content: snapshot.raw! } : { version: DELETION_VERSION, content: DELETION_CONTENT, deleted: true },
    base: { version: intents[0]!.base, content: intents[0]!.baseContent },
    remote: reviewedRemote(shared.base, intents[0]!),
    intents,
  };
}

/**
 * The shared head a review shows: the fresh read, and, when it serves no document, the deletion
 * the authority named when the conflict was recorded. That tombstone is what `keep-local`
 * acknowledges; if the document was deleted again since, the authority refuses it and the
 * refusal is recorded as a new conflict naming the newer one.
 */
function reviewedRemote(shared: SharedBase, head: IntentRecord): SharedBase {
  const tombstone = shared.version === null && head.remote?.version === null ? head.remote.tombstone : undefined;
  return tombstone !== undefined ? { ...shared, tombstone } : shared;
}

/** The mutation options a resolution honours when it authors a fresh local edit. */
export type ConflictResolutionOptions = Pick<LocalMutation, "actor" | "producer" | "now" | "registry" | "strict">;

/**
 * Resolve exactly the reviewed local chain against the reviewed shared head. A fresh remote
 * read verifies the decision; a later remote edit is still protected by the replacement's CAS
 * on push. Taking remote adopts that served snapshot, not a promise it can never change.
 * No network write occurs here. Old content and identities remain in the recovery receipt.
 * Body mode resolves through {@link resolveBodyConflict}: the same choices over a chain whose
 * head is a recorded conflict or content refusal, with the retirement rules of that mode.
 */
export async function resolveConflict(
  local: LocalTarget,
  remote: StorageBackend,
  reviewed: ConflictReview,
  choice: ConflictChoice,
  options: ConflictResolutionOptions = {},
): Promise<ConflictResolutionResult> {
  const review = structuredClone(reviewed);
  const selected = structuredClone(choice);
  if (!["keep-local", "take-remote", "revise"].includes(selected.kind)) throw new InvalidInputError("Unknown conflict resolution choice.");
  const mode = await admitBodyMode(backendOf(local));
  if (mode) return resolveBodyConflict(local, mode, remote, review, selected, options);
  const backend = await runtimeBackend(local);
  const current = await conflictLocal(backend, review.id);
  assertJournalSnapshot(review.id, review.intents, current.intents);
  const localVersion = current.document?.version ?? DELETION_VERSION;
  const localContent = current.document ? current.snapshot.raw : DELETION_CONTENT;
  if (localVersion !== review.local.version || localContent !== review.local.content || current.deleting !== (review.local.deleted === true)) throw new ConflictReviewStaleError();
  const shared = await readConflictRemote(remote, review.id);
  const reviewedShared = reviewedRemote(shared.base, current.intents[0]!);
  if (reviewedShared.version !== review.remote.version || reviewedShared.content !== review.remote.content || reviewedShared.tombstone !== review.remote.tombstone) throw new ConflictReviewStaleError();
  if (current.deleting && selected.kind === "revise") throw new InvalidInputError("A deletion in conflict is resolved by keeping the deletion or taking the shared version.");
  const resolvedAt = options.now?.() ?? new Date().toISOString();
  const requestId = selected.kind === "take-remote" ? null : mintRequestId();
  const receipt: ConflictResolutionReceipt = {
    // The original conflict identity lets a caller recover the receipt after a lost local reply.
    id: current.intents[0]!.requestId,
    reviewed: { ...review, base: { version: current.intents[0]!.base, content: current.intents[0]!.baseContent }, intents: current.intents },
    choice: selected.kind, resolvedAt, replacementRequestId: requestId,
  };
  const resolveIntents = { expected: current.intents };
  const meta: MetaRecord[] = [
    { key: conflictResolutionKey(receipt.id), value: receipt },
    // Someone else's deletion is never remembered as this working copy's own: a later create of
    // the id acknowledges nothing and meets the conflict again, until an explicit keep.
    { key: baseKey(review.id), value: { version: shared.base.version, content: shared.base.content } satisfies SharedBase },
  ];
  // A deletion chain holds no working document: its compare-and-swap is on absence.
  const common = { expectedVersion: (current.document ? review.local.version : null) as Version, resolveIntents, meta, actor: options.actor };
  if (current.deleting && selected.kind === "keep-local") {
    // Keep the deletion: delete again against the shared head as it is now, under a new identity.
    // A head that is already gone has nothing to delete, so the chain simply retires.
    if (shared.base.version === null) {
      await backend.deleteJournaled(review.id, common);
      return { receipt: { ...receipt, replacementRequestId: null }, version: null, intent: null };
    }
    const deleted = await backend.deleteJournaled(review.id, {
      ...common,
      intent: { requestId: requestId!, kind: DOCUMENT_DELETE_KIND, target: review.id, base: shared.base.version, baseContent: shared.base.content, createdAt: resolvedAt },
    });
    return { receipt, version: null, intent: deleted.outcome === "held" ? null : deleted.intent ?? null };
  }
  if (selected.kind === "take-remote") {
    if (!shared.doc) {
      await backend.deleteJournaled(review.id, common);
      return { receipt, version: null, intent: null };
    }
    const written = await backend.writeJournaled(review.id, shared.doc, common);
    return { receipt, version: written.version, intent: null };
  }
  // Keeping or revising over a deletion re-creates the document: the create acknowledges the
  // deletion the review showed, and only that one (a newer one refuses it into a new conflict).
  const recreates = shared.base.version === null ? review.remote.tombstone : undefined;
  const intent: NewIntentRecord = {
    requestId: requestId!, kind: "document.write", target: review.id,
    base: shared.base.version, baseContent: shared.base.content, createdAt: resolvedAt,
    ...(recreates !== undefined ? { recreates } : {}),
  };
  let written: Awaited<ReturnType<JournaledBackend["writeJournaled"]>> | undefined;
  const write = async (id: ConceptId, doc: OkfDocument): Promise<Version> => {
    if (id !== review.id) throw new InvalidInputError("Conflict resolution cannot write another document.");
    written = await backend.writeJournaled(id, doc, { ...common, intent });
    return written.version;
  };
  const persistence = new Proxy(backend, { get(inner, key) {
    if (key === "write") return write;
    const value = Reflect.get(inner, key, inner);
    return typeof value === "function" ? value.bind(inner) : value;
  } });
  const result = await mutateDocument({
    ...options, bundle: { ...bundleOf(local), backend: persistence }, id: review.id,
    mode: "patch", expectedVersion: review.local.version,
    registry: options.registry ?? EMPTY_REGISTRY, strict: options.strict ?? false,
    buildCandidate: existing => selected.kind === "keep-local"
      ? { frontmatter: existing!.frontmatter, body: existing!.body }
      : { frontmatter: selected.frontmatter ?? existing!.frontmatter, body: selected.body },
  });
  // A validated semantic no-op still resolves the rejected identity and records a fresh one.
  if (!written) await write(review.id, result.doc);
  return { receipt, version: written!.version, intent: written!.intent };
}

/**
 * Body mode's resolution. The reviewed chain (its head a recorded conflict or content refusal,
 * its successors never attempted) retires with the descriptors of its rows and a bounded
 * receipt, in one guarded write that also adopts the served head (`take-remote`; a served
 * absence deletes the working copy's document and its base row) or journals one fresh
 * body update at the served head (`keep-local`, `revise`). Body mode cannot create a
 * document, so the fresh update needs a served head. The complete state after the resolution,
 * receipt and removals included, is projected through the capacity check before anything is
 * written; a journal that moves under the guard is retried up to the compose limit, after
 * which the review is reported stale. The head is never rewritten to reach the exact-mode
 * rule: a refused head retires as refused, and the receipt records it so.
 */
async function resolveBodyConflict(
  local: LocalTarget,
  mode: BodyMode,
  remote: StorageBackend,
  review: ConflictReview,
  selected: ConflictChoice,
  options: ConflictResolutionOptions,
): Promise<ConflictResolutionResult> {
  const backend = backendOf(local);
  // The input is checked before any read of the target's journal, as the body commit checks it before any write.
  if (selected.kind === "revise") {
    if (Object.hasOwn(selected, "frontmatter")) throw new BodyRuntimeError("Body conflict resolution revises the body only; the authority owns the metadata.");
    if (!isBoundedBody(selected.body)) throw new BodyRuntimeError("Expected a bounded body-only revision.");
  }
  const isRecord = (value: unknown): boolean => typeof value === "object" && value !== null;
  if (typeof review.id !== "string" || !isRecord(review.local) || !isRecord(review.remote) || !Array.isArray(review.intents) || review.intents.length === 0 ||
      review.intents.some(row => !isRecord(row) || typeof row.requestId !== "string" || !Number.isSafeInteger(row.sequence))) throw new InvalidInputError("Conflict resolution requires the review its inspection returned.");
  const id = review.id;
  const reviewedHead = review.intents.reduce((lowest, row) => row.sequence < lowest.sequence ? row : lowest);
  const receiptKey = conflictResolutionKey(reviewedHead.requestId);
  const requestId = selected.kind === "take-remote" ? null : mintRequestId();
  await assertBodyEdition(backend, mode);
  /** The working copy's side of the review, read fresh: the reviewed chain, at the reviewed bytes. */
  const verifyLocal = async (): Promise<{ snap: BodySnapshot; chain: IntentRecord[]; expectedVersion: Version }> => {
    const snap = await bodySnapshot(backend, id, mode, requestId === null ? [receiptKey] : [receiptKey, bodyRecordKey(requestId)]);
    const current = conflictChain(id, snap.read, true);
    assertJournalSnapshot(id, review.intents, current.intents);
    // Body mode never journals a deletion, so its chain always holds a working document.
    if (!current.document) throw new ConflictReviewStaleError();
    if (current.document.version !== review.local.version || snap.read.raw !== review.local.content) throw new ConflictReviewStaleError();
    return { snap, chain: current.intents, expectedVersion: current.document.version };
  };
  // The local premise is checked before the authority is asked, as in exact mode: a review that
  // no longer describes the working copy is refused without a network read.
  await verifyLocal();
  await assertBodyRemoteEdition(remote, mode);
  const shared = await readConflictRemote(remote, id);
  if (shared.base.version !== review.remote.version || shared.base.content !== review.remote.content) throw new ConflictReviewStaleError();
  // The served content enters the working copy in its own serialization, as a pull records it.
  const served = shared.doc ? bodyDocument(shared.base.content!, id, mode) : null;
  const servedRaw = served ? stringifyDoc(served.frontmatter, served.body ?? "") : null;
  const servedBase: SharedBase = { version: shared.base.version, content: servedRaw };
  if (selected.kind !== "take-remote" && !served) throw new BodyRuntimeError("The authority holds no document for this id and body delivery cannot create one; take the served deletion or export the retained work.");
  const resolvedAt = options.now?.() ?? new Date().toISOString();
  // The clock stamps the fresh row's createdAt, which the delivery grammar reads on every later snapshot.
  if (typeof resolvedAt !== "string" || parseIsoInstant(resolvedAt) === null) throw new BodyRuntimeError("The resolution clock must produce an ISO-8601 instant with an explicit UTC offset.");

  /** One fresh local verification plus the receipt the resolution will keep, composed against that snapshot. */
  const prepare = async (): Promise<{ snap: BodySnapshot; chain: IntentRecord[]; expectedVersion: Version; receipt: BodyResolutionReceipt }> => {
    const { snap, chain, expectedVersion } = await verifyLocal();
    const receipt = validateBodyResolutionReceipt({
      schema: 1, mode: "document.body.update", id: chain[0]!.requestId, target: id, choice: selected.kind, resolvedAt,
      replacementRequestId: requestId, served: { version: shared.base.version }, expectedLocalVersion: expectedVersion,
      chain: chain.map(row => ({
        requestId: row.requestId, sequence: row.sequence, state: row.state, attempts: row.attempts, base: row.base, local: row.local,
        ...(row.acknowledgedVersion === undefined ? {} : { acknowledgedVersion: row.acknowledgedVersion }),
        ...(row.refusal === undefined ? {} : { refusalCode: row.refusal.code }),
        ...(row.remote === undefined ? {} : { remoteVersion: row.remote.version }),
      })),
    });
    return { snap, chain, expectedVersion, receipt };
  };
  const remaining = (snap: BodySnapshot, chain: IntentRecord[]): IntentRecord[] => snap.read.intents.filter(row => !chain.some(retired => retired.requestId === row.requestId));
  const retry = (error: unknown, attempt: number): void => {
    if (!(error instanceof JournalGuardConflict)) throw error;
    if (attempt === COMPOSE_ATTEMPTS - 1) throw new ConflictReviewStaleError();
  };

  if (selected.kind === "take-remote") {
    for (let attempt = 0; ; attempt++) {
      try {
        const { snap, chain, expectedVersion, receipt } = await prepare();
        const receiptRow: MetaRecord = { key: receiptKey, value: receipt };
        const retired = retiredDescriptorKeys(chain);
        const common = { guard: snap.guard, expectedVersion, resolveIntents: { expected: chain } };
        if (!served) {
          // A served absence leaves no base row behind, as a pull's own deletion leaves none: the
          // refresh premise for an id with neither document nor intents expects the row absent,
          // and the receipt's `served.version` already records the absence.
          const meta = [receiptRow], removeMeta = [...retired, baseKey(id)];
          projectBodyGuard(snap.guard, { document: null, intents: remaining(snap, chain), meta, removeMeta });
          await backend.deleteJournaled(id, { ...common, meta, removeMeta });
          return { receipt, version: null, intent: null };
        }
        const meta = [receiptRow, baseRow(id, servedBase)], removeMeta = retired;
        projectBodyGuard(snap.guard, { document: { version: versionOfBytes(servedRaw!), raw: servedRaw! }, intents: remaining(snap, chain), meta, removeMeta });
        const written = await backend.writeJournaled(id, served, { ...common, meta, removeMeta, ...(options.actor === undefined ? {} : { actor: options.actor }) });
        return { receipt, version: written.version, intent: null };
      } catch (error) { retry(error, attempt); }
    }
  }

  let written: { version: Version; intent: IntentRecord | null; receipt: BodyResolutionReceipt } | undefined;
  const write = async (target: ConceptId, candidate: OkfDocument, writeOptions: WriteOptions = {}): Promise<Version> => {
    if (target !== id) throw new BodyRuntimeError("Conflict resolution cannot write another document.");
    const doc = bodyDocument(stringifyDoc(candidate.frontmatter, candidate.body ?? ""), id, mode);
    const raw = stringifyDoc(doc.frontmatter, doc.body ?? ""), version = versionOfBytes(raw);
    for (let attempt = 0; ; attempt++) {
      try {
        const { snap, chain, expectedVersion, receipt } = await prepare();
        // Keeping the local edit re-journals the retained edit's own body text; its bytes are the working document.
        const body = selected.kind === "revise" ? selected.body : snap.records.get(chain[chain.length - 1]!.requestId)!.body;
        const intent: NewIntentRecord = { requestId: requestId!, kind: "document.body.update", target: id, base: shared.base.version, baseContent: servedRaw, createdAt: resolvedAt };
        const descriptor: BodyRecord = { schema: 1, requestId: requestId!, target: id, scope: mode.scope, okfVersion: mode.okfVersion, body, initialVersion: shared.base.version };
        const meta: MetaRecord[] = [{ key: receiptKey, value: receipt }, baseRow(id, servedBase), { key: bodyRecordKey(requestId!), value: descriptor }];
        const removeMeta = retiredDescriptorKeys(chain);
        const projected: IntentRecord = { ...intent, sequence: Number.MAX_SAFE_INTEGER, local: version, content: raw, updatedAt: resolvedAt, attempts: 0, state: "pending" };
        // The fresh row must pass the validator every later snapshot runs over it, before it is
        // written: a resolution clock or body outside the delivery grammar is the caller's input.
        try { validateBodyRecord(mode, projected, descriptor); }
        catch (error) { throw error instanceof BodyRuntimeError ? error : new BodyRuntimeError(`The fresh body update is outside the delivery grammar: ${(error as Error).message}`); }
        projectBodyGuard(snap.guard, { document: { version, raw }, intents: [...remaining(snap, chain), projected], meta, removeMeta });
        const result = await backend.writeJournaled(id, doc, { ...writeOptions, guard: snap.guard, expectedVersion, resolveIntents: { expected: chain }, intent, meta, removeMeta });
        written = { version: result.version, intent: result.intent, receipt };
        return result.version;
      } catch (error) { retry(error, attempt); }
    }
  };
  const persistence = new Proxy(backend, { get(inner, key) {
    if (key === "write") return write;
    const value = Reflect.get(inner, key, inner);
    return typeof value === "function" ? value.bind(inner) : value;
  } });
  const result = await mutateDocument({
    ...options, bundle: { ...bundleOf(local), backend: persistence }, id,
    mode: "patch", expectedVersion: review.local.version,
    registry: options.registry ?? EMPTY_REGISTRY, strict: options.strict ?? false,
    buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: selected.kind === "keep-local" ? existing!.body : (selected as { body: string }).body }),
  });
  // A validated semantic no-op still retires the chain and records a fresh identity.
  if (!written) await write(id, result.doc, { expectedVersion: review.local.version, ...(options.actor === undefined ? {} : { actor: options.actor }) });
  return { receipt: written!.receipt, version: written!.version, intent: written!.intent };
}

// ── push ───────────────────────────────────────────────────────────────────────────────────

export interface PushOptions {
  /** Explicit transport; never inferred from the exact-document transport. */
  bodyTransport?: BodyDeliveryTransport;
  /** Used to fetch the shared head's content when an intent enters conflict. */
  remote?: StorageBackend;
  write?: UncertainWriteOptions;
}

export interface PushReport {
  paused: boolean;
  settled: Array<{ requestId: string; target: ConceptId; state: OperationState }>;
  skipped: Array<{ requestId: string; target: ConceptId; reason: "blocked" | "claimed-elsewhere" | "settled-elsewhere" }>;
}

/** Read the shared head for a conflict record; absence is a real answer (`null`), a failure is unknown. */
async function remoteHead(remote: StorageBackend | undefined, id: ConceptId, actual: Version | null): Promise<{ version: Version | null; content: string | null }> {
  if (!remote) return { version: actual, content: null };
  try {
    const head = await remote.read(id);
    return { version: head.version, content: stringifyDoc(head.doc.frontmatter, head.doc.body ?? "") };
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return { version: null, content: null };
    return { version: actual, content: null };
  }
}

/** The shared head a conflict records, with the deletion the authority named when it serves none. */
async function conflictRemote(remote: StorageBackend | undefined, id: ConceptId, outcome: Extract<Outcome, { kind: "conflict" }>): Promise<{ version: Version | null; content: string | null; tombstone?: Version }> {
  const head = await remoteHead(remote, id, outcome.actual);
  return head.version === null && outcome.actual === null && outcome.tombstone !== undefined ? { ...head, tombstone: outcome.tombstone } : head;
}

/**
 * Settle an in-flight intent against the authority's outcome, as one compare-and-swap on the
 * intent's state. A committed outcome marks it acknowledged and moves the document's shared
 * base to the acknowledged version in the same transaction; a conflict stores the shared head
 * beside base and local and leaves the local content alone; a refusal records its code and,
 * when it reports lost permission, pauses the bundle; an unknown outcome returns the intent to
 * `pending` with its attempts recorded, so the next push starts with a lookup. Rejects with
 * {@link IntentStateConflict} when another realm settled it first.
 */
export async function settleIntent(
  local: LocalTarget,
  requestId: string,
  outcome: Outcome,
  attempts: number,
  options: PushOptions = {},
): Promise<IntentRecord> {
  const backend = backendOf(local);
  if (await admitBodyMode(backend)) throw new BodyRuntimeError("Body outcomes require committed content evidence.");
  const current = await backend.readIntent(requestId);
  if (!current) throw new IntentStateConflict(requestId, "in_flight", null);
  // The primitive already settles a conflict at the intent's own version as committed; applying
  // the same rule here keeps this exported function correct for a caller that passes a raw
  // transport outcome, so no path can land the client's own commit as a concurrent edit.
  outcome = settleAgainstIntent(outcome, current);
  switch (outcome.kind) {
    case "committed": {
      if (current.kind === DOCUMENT_DELETE_KIND) {
        // The document left the authority. Its version is the deletion's tombstone, which a
        // create recorded later acknowledges; the deletion version itself says none is known.
        const tombstone = outcome.version !== DELETION_VERSION ? outcome.version : undefined;
        return backend.updateIntent(
          requestId,
          "in_flight",
          { state: "acknowledged", attempts, acknowledgedVersion: outcome.version },
          { meta: [baseRow(current.target, { version: null, content: null, ...(tombstone !== undefined ? { tombstone } : {}) })] },
        );
      }
      const finding = outcome.version === current.local ? undefined : `acknowledged version ${outcome.version} differs from local version ${current.local}`;
      return backend.updateIntent(
        requestId,
        "in_flight",
        { state: "acknowledged", attempts, acknowledgedVersion: outcome.version, ...(finding ? { finding } : {}) },
        { meta: [baseRow(current.target, { version: outcome.version, content: current.content })] },
      );
    }
    case "conflict": {
      // What reaches this branch is a moved head: a conflict naming the intent's own version was
      // settled as committed above.
      return backend.updateIntent(requestId, "in_flight", { state: "conflict", attempts, remote: await conflictRemote(options.remote, current.target, outcome) });
    }
    case "refused": {
      const authorization = isAuthorizationRefusal(outcome);
      const control: SyncControl = { paused: true, reason: `${outcome.code}: ${outcome.message}`, since: new Date().toISOString() };
      return backend.updateIntent(
        requestId,
        "in_flight",
        { state: "refused", attempts, refusal: { code: outcome.code, message: outcome.message } },
        authorization ? { meta: [{ key: SYNC_KEY, value: control }] } : {},
      );
    }
    case "unknown":
      return backend.updateIntent(requestId, "in_flight", { state: "pending", attempts });
  }
}

async function pushBodyIntent(backend: JournaledBackend, mode: BodyMode, requestId: string, options: PushOptions): Promise<IntentRecord | null> {
  await assertBodyEdition(backend, mode);
  const original = await backend.readIntent(requestId);
  if (!original || original.state !== "pending") return null;
  const snap = await bodySnapshot(backend, original.target, mode);
  const intent = snap.read.intents.find(row => row.requestId === requestId);
  if (!intent || intent.state !== "pending") return null;
  const record = snap.records.get(requestId)!;
  let prepared = record.prepared;
  if (!prepared) {
    const input = { scope: mode.scope, requestId, target: intent.target, okfVersion: mode.okfVersion, operation: { kind: "document.body.update" as const, body: record.body }, local: intent.local, content: intent.content, createdAt: intent.createdAt };
    if (intent.after) {
      const priorIntent = snap.read.intents.find(row => row.requestId === intent.after), prior = snap.records.get(intent.after);
      if (priorIntent?.state !== "acknowledged" || !prior?.prepared || !prior.receipt) return null;
      prepared = prepareBodyDelivery(input, { prepared: prior.prepared, receipt: prior.receipt });
    } else {
      if (!record.initialVersion) throw new BodyRuntimeError("Body delivery has no authority premise.");
      prepared = prepareBodyDelivery(input, { expectedVersion: record.initialVersion });
    }
  }
  const attempts = intent.attempts + 1;
  if (!Number.isSafeInteger(attempts)) throw new BodyRuntimeError("Delivery attempt counter exhausted.");
  const key = bodyRecordKey(requestId), metadata = { ...record, prepared };
  const claimed = { ...intent, state: "in_flight" as const, attempts };
  projectBodyGuard(snap.guard, { intents: snap.read.intents.map(row => row.requestId === requestId ? claimed : row), meta: [{ key, value: metadata }] });
  try { await backend.updateIntent(requestId, "pending", { state: "in_flight", attempts }, { guard: snap.guard, meta: [{ key, value: metadata }] }); }
  catch (error) { if (error instanceof JournalGuardConflict || error instanceof IntentStateConflict) return null; throw error; }
  const result = await performBodyDelivery(options.bodyTransport!, prepared, intent.attempts, options.write);
  const durableAttempts = Math.max(attempts, result.attempts);
  for (let retry = 0; retry < 3; retry++) {
    const fresh = await bodySnapshot(backend, intent.target, mode);
    const current = fresh.read.intents.find(row => row.requestId === requestId), evidence = fresh.records.get(requestId);
    if (!current || current.state !== "in_flight" || !evidence?.prepared) return null;
    assertSameBodyDelivery(prepared, evidence.prepared);
    let patch: Parameters<JournaledBackend["updateIntent"]>[2] = { attempts: durableAttempts };
    const meta: MetaRecord[] = [];
    let document: OkfDocument | undefined;
    switch (result.outcome.kind) {
      case "committed": {
        const shared = fresh.read.meta.get(baseKey(intent.target)) as SharedBase | undefined;
        const proposal = reconcileBodyReceipt(prepared, result.outcome.receipt, { version: fresh.read.document?.version ?? null, intents: fresh.read.intents, shared: shared?.version && shared.content !== null ? { version: shared.version, content: shared.content } : null });
        patch = { ...patch, state: "acknowledged", acknowledgedVersion: proposal.receipt.version };
        meta.push({ key, value: { ...evidence, receipt: proposal.receipt } });
        if (proposal.shared.action === "replace-shared-under-CAS") {
          const canonical = bodyDocument(proposal.shared.content, intent.target, mode);
          meta.push(baseRow(intent.target, { version: proposal.shared.version, content: stringifyDoc(canonical.frontmatter, canonical.body ?? "") }));
        }
        if (proposal.action === "replace-local-under-CAS") document = bodyDocument(proposal.receipt.content, intent.target, mode);
        break;
      }
      case "conflict": {
        let remote = await remoteHead(options.remote, intent.target, result.outcome.actual);
        if (jsonBytes(remote) > 2 * 1024 * 1024) { remote = { version: result.outcome.actual, content: null }; patch.finding = "Remote content exceeds the retained evidence limit."; }
        patch = { ...patch, state: "conflict", remote };
        break;
      }
      case "refused": {
        patch = { ...patch, state: "refused", refusal: { code: result.outcome.code, message: result.outcome.message } };
        if (isAuthorizationRefusal(result.outcome)) {
          const control = fresh.read.meta.get(BODY_MODE_KEY) as BodyMode & { controls: Record<string, unknown> };
          meta.push({ key: BODY_MODE_KEY, value: { ...control, controls: { ...control.controls, sync: { paused: true, reason: `${result.outcome.code}: ${result.outcome.message}`, since: new Date().toISOString() } } } });
        }
        break;
      }
      case "unknown": patch = { ...patch, state: "pending", ...(result.diagnostic ? { finding: result.diagnostic } : {}) }; break;
    }
    const raw = document ? stringifyDoc(document.frontmatter, document.body ?? "") : undefined;
    projectBodyGuard(fresh.guard, { intents: fresh.read.intents.map(row => row.requestId === requestId ? { ...row, ...patch } : row), meta, ...(raw === undefined ? {} : { document: { version: versionOfBytes(raw), raw } }) });
    try { return await backend.updateIntent(requestId, "in_flight", patch, { guard: fresh.guard, meta, ...(document ? { document } : {}) }); }
    catch (error) { if (!(error instanceof JournalGuardConflict) || retry === 2) throw error; }
  }
  return null;
}

/**
 * Deliver pending intents in local commit order through the uncertain-write primitive. Each
 * intent is claimed (`pending` to `in_flight`) by compare-and-swap, so two realms cannot both
 * deliver it, and settled by {@link settleIntent}. A chained intent waits for its predecessor's
 * acknowledgement. A refusal that reports lost permission pauses the bundle and stops the run.
 *
 * The claim records `attempts + 1` in the same compare-and-swap, before anything leaves for the
 * authority: a page that dies between claim and settlement leaves an intent whose record says
 * it may have been delivered, so {@link reclaimInFlight} and the next push treat it that way.
 * The primitive itself receives the count of attempts completed before this claim, so a first
 * delivery is a submission and a repeated one starts with a lookup.
 */
export async function push(local: LocalTarget, transport: OperationTransport, options: PushOptions = {}): Promise<PushReport> {
  const mode = await admitBodyMode(backendOf(local));
  const backend = await runtimeBackend(local);
  if (mode && (!options.bodyTransport || typeof options.bodyTransport.submit !== "function" || typeof options.bodyTransport.lookup !== "function")) throw new BodyRuntimeError("An explicit body delivery transport is required.");
  const report: PushReport = { paused: false, settled: [], skipped: [] };
  const control = await backend.readMeta<SyncControl>(SYNC_KEY);
  if (control?.paused) {
    report.paused = true;
    return report;
  }
  for (const intent of await backend.listIntents("pending")) {
    if (mode) {
      const settled = await pushBodyIntent(backendOf(local), mode, intent.requestId, options);
      if (!settled) { report.skipped.push({ requestId: intent.requestId, target: intent.target, reason: "blocked" }); continue; }
      report.settled.push({ requestId: settled.requestId, target: settled.target, state: settled.state });
      if ((await backend.readMeta<SyncControl>(SYNC_KEY))?.paused) { report.paused = true; break; }
      continue;
    }
    let rebase: Pick<IntentRecord, "base"> | Pick<IntentRecord, "recreates"> | Record<string, never> = {};
    if (intent.after !== undefined) {
      const predecessor = await backend.readIntent(intent.after);
      if (predecessor && predecessor.state !== "acknowledged") {
        report.skipped.push({ requestId: intent.requestId, target: intent.target, reason: "blocked" });
        continue;
      }
      if (predecessor && intent.attempts === 0) rebase = chainedPremise(intent, predecessor);
    }
    let claimed: IntentRecord;
    try {
      claimed = await backend.updateIntent(intent.requestId, "pending", { state: "in_flight", attempts: intent.attempts + 1, ...rebase });
    } catch (error) {
      if (error instanceof IntentStateConflict) {
        report.skipped.push({ requestId: intent.requestId, target: intent.target, reason: "claimed-elsewhere" });
        continue;
      }
      throw error;
    }
    const { outcome, intent: advanced } = await performUncertainWrite(transport, { ...claimed, attempts: intent.attempts }, options.write);
    // Attempts never go below what the claim recorded: the durable count is the possibly
    // delivered one, and the primitive's count is higher only after a resubmission.
    const attempts = Math.max(advanced.attempts, claimed.attempts);
    let settled: IntentRecord;
    try {
      settled = await settleIntent(backend, claimed.requestId, outcome, attempts, options);
    } catch (error) {
      if (error instanceof IntentStateConflict) {
        report.skipped.push({ requestId: intent.requestId, target: intent.target, reason: "settled-elsewhere" });
        continue;
      }
      throw error;
    }
    report.settled.push({ requestId: settled.requestId, target: settled.target, state: settled.state });
    if (isAuthorizationRefusal(outcome)) {
      report.paused = true;
      break;
    }
  }
  return report;
}

/**
 * {@link push} under the store's push role: the one-writer-per-store coordination for the
 * browser-local working copy. A realm that finds the role held elsewhere delivers nothing and
 * leaves the journal untouched; the holder's push is the only one running over this store.
 * `role` selects the lock manager that owns the role (see {@link withPushRole}); a product
 * caller leaves it to the host. The role is named by the working copy, so this verb takes the
 * opened bundle rather than a bare backend: an adapter has no identity of its own on the seam.
 */
export async function pushWithRole(
  local: LocalBundle,
  transport: OperationTransport,
  options: PushOptions = {},
  role: PushRoleOptions = {},
): Promise<PushRoleResult<PushReport>> {
  return withPushRole(pushRoleName(local.name), async () => {
    if (await admitBodyMode(local.backend)) {
      if (!options.bodyTransport || typeof options.bodyTransport.submit !== "function" || typeof options.bodyTransport.lookup !== "function") throw new BodyRuntimeError("An explicit body delivery transport is required.");
      await reclaimInFlight(local);
    }
    return push(local.backend, transport, options);
  }, role);
}

// ── pull ───────────────────────────────────────────────────────────────────────────────────

export interface PullOptions extends FetchOptions {
  /**
   * The refusal the last pull recorded (`syncStatus().lastPull.refused`), passed back to say
   * the shrink it describes is genuine. The deletions apply only when the authority's current
   * listing carries the same digest, and the refusal the same count and reason, as the one
   * being accepted; a listing that has moved since is refused afresh with a new record. An
   * acceptance that matches nothing is ignored.
   */
  acceptRefusedDeletions?: DeletionRefusal;
}

export interface PullReport {
  refreshed: ConceptId[];
  /** Documents left alone because an unsettled intent targets them; push discovers any divergence. */
  held: ConceptId[];
  unchanged: ConceptId[];
  /** Documents the authority no longer lists, removed from the working copy with their base. Only a pull by heads removes anything. */
  deleted: ConceptId[];
  /** Present when the heads listing implied deletions this pull refused to apply; see {@link DeletionRefusal}. */
  refused?: DeletionRefusal;
}

/**
 * The digest the working copy last matched, or `undefined` when the next pull must ask
 * unconditionally. The bootstrap's digest counts only while no pull has started since that
 * bootstrap completed; once one has, the latest pull marker is the whole answer, and a marker
 * without a digest (a refused listing, a pull by list, or an interrupted pull) means the
 * working copy no longer matches any digest the authority could be asked about. Falling back
 * to the bootstrap's digest there would let the authority answer `304` to a copy that has
 * moved past it.
 */
async function lastKnownDigest(backend: JournaledBackend): Promise<string | undefined> {
  const marker = await backend.readMeta<BootstrapMarker>(BOOTSTRAP_KEY);
  // An incomplete bootstrap has changed the working copy past whatever any digest described:
  // no conditional request until a bootstrap completes again.
  if (marker?.complete !== true || marker.completedAt === undefined) return undefined;
  const lastPull = await backend.readMeta<PullMarker>(PULL_KEY);
  if (lastPull !== undefined && lastPull.startedAt >= marker.completedAt) return lastPull.completedAt === null ? undefined : lastPull.headsDigest;
  return marker.headsDigest;
}

/**
 * Refresh every document that carries no unsettled intent to the authority's head and record
 * that head as its shared base. Documents with an unsettled intent are held: their base is the
 * one the edit was made against, and a moved shared head is push's conflict to report, never a
 * silent base replacement here. The intents known before the network round trip only save
 * fetching held documents; the hold that decides is the one the refreshing write checks inside
 * its own transaction, so an edit committed during the round trip holds its document too.
 *
 * Over a wire authority that reports `heads`, the round trip is one conditional heads request
 * carrying the digest the working copy last matched. A `304` completes the pull with nothing
 * fetched and the marker saying `unchanged`. A `200`, which the wire adapter admits only after
 * recomputing its digest over the rows it served, is diffed: a head whose version equals the
 * recorded base is unchanged, any other unheld head is fetched, and the local documents the
 * authority no longer lists are reconciled by {@link reconcileDeletions}: each deleted with its
 * base in one journaled operation that checks the hold inside its own transaction, a held one
 * retained with its base rewritten to version `null` in that same transaction, so that after
 * pull alone it reads as a local edit over an absent base and push records the conflict when
 * the authority answers with actual `null`. A verified listing that would still remove eight
 * or more unheld documents amounting to more than half of the working copy, or all of it, is
 * refused as a whole: the refreshes stand, no document is removed, no digest is recorded, and
 * the marker and report carry `refused` with the listing's digest, until the caller passes
 * that refusal back as {@link PullOptions.acceptRefusedDeletions} against the same listing.
 * Nothing is ever deleted on a `304`, and nothing on the list path, which fetches every unheld
 * id as before.
 *
 * Batches travel concurrently (see {@link FetchOptions}) and each is written as it arrives; the
 * pull marker records completion, and the digest now matched, only after every batch has been
 * written.
 */
export async function pull(local: LocalTarget, remote: StorageBackend, options: PullOptions = {}): Promise<PullReport> {
  const concurrency = concurrencyOf(options);
  const backend = await runtimeBackend(local);
  const bodyMode = await admitBodyMode(backendOf(local));
  const validateReadSide = bodyMode ? () => assertBodyRemoteEdition(remote, bodyMode) : undefined;
  // Read before the in-progress marker replaces the last pull's record, which may carry the digest.
  const known = await lastKnownDigest(backend);
  const startedAt = new Date().toISOString();
  await backend.writeMeta(PULL_KEY, { startedAt, completedAt: null, refreshed: 0, unchanged: false } satisfies PullMarker);
  if (bodyMode) { await assertBodyEdition(backendOf(local), bodyMode); await assertBodyRemoteEdition(remote, bodyMode); }
  const report: PullReport = { refreshed: [], held: [], unchanged: [], deleted: [] };
  const heldTargets = new Set((await backend.listIntents(UNSETTLED_STATES)).map((row) => row.target));
  const complete = async (headsDigest: string | undefined, unchanged: boolean): Promise<PullReport> => {
    await validateReadSide?.();
    await backend.writeMeta(PULL_KEY, {
      startedAt,
      completedAt: new Date().toISOString(),
      refreshed: report.refreshed.length,
      unchanged,
      ...(headsDigest === undefined ? {} : { headsDigest }),
      ...(report.refused === undefined ? {} : { refused: report.refused }),
    } satisfies PullMarker);
    return report;
  };

  /** Apply one fetched head to the working copy under the same guards, whichever path fetched it. */
  const apply = async (head: ReadResult, premises?: BodyRefreshPremises): Promise<void> => {
    if (bodyMode) await assertBodyRemoteEdition(remote, bodyMode);
    const id = head.doc.id;
    await premises?.check(id);
    const base = await backend.readMeta<SharedBase>(baseKey(id));
    if (base?.version === head.version) {
      report.unchanged.push(id);
      return;
    }
    const expectedVersion = await localVersion(backend, id);
    try {
      await backend.writeJournaled(id, head.doc, {
        ...(premises ? { guard: premises.guard(id) } : {}),
        expectedVersion,
        requireSettled: true,
        meta: ({ raw }) => [baseRow(id, { version: head.version, content: raw })],
      });
      report.refreshed.push(id);
    } catch (error) {
      // A local commit landed during the round trip: its intent holds this document now. The
      // version check is kept for a plain local write that journals nothing.
      if (error instanceof IntentHoldConflict || (error as { name?: unknown })?.name === "VersionConflict") {
        report.held.push(id);
        return;
      }
      throw error;
    }
  };
  const fetchAndApply = (candidates: ConceptId[]): Promise<void> =>
    forEachBatch(chunked(candidates, options.batchSize ?? DEFAULT_BATCH_SIZE), concurrency, async (batch) => {
      const premises = bodyMode ? await captureBodyRefresh(backendOf(local), bodyMode, batch) : undefined;
      for (const head of await remote.readMany(batch)) await apply(head, premises);
    });

  const wire = await wireFor(remote, local, "heads", options);
  if (!wire) {
    const candidates: ConceptId[] = [];
    for (const id of await remote.list()) {
      if (heldTargets.has(id)) report.held.push(id);
      else candidates.push(id);
    }
    await fetchAndApply(candidates);
    return complete(undefined, false);
  }

  const premises = bodyMode ? await captureBodyRefresh(backendOf(local), bodyMode) : undefined;
  const answer = await wire.heads(known === undefined ? {} : { ifNoneMatch: known });
  await validateReadSide?.();
  await premises?.checkAll();
  if (answer === null) {
    report.unchanged = await backend.list();
    return complete(known, true);
  }
  const candidates: ConceptId[] = [];
  const listed = new Set<ConceptId>();
  for (const head of answer.heads) {
    listed.add(head.id);
    if (heldTargets.has(head.id)) {
      report.held.push(head.id);
      continue;
    }
    const base = await backend.readMeta<SharedBase>(baseKey(head.id));
    if (base?.version === head.version) report.unchanged.push(head.id);
    else candidates.push(head.id);
  }
  await fetchAndApply(candidates);
  await validateReadSide?.();
  const reconciled = await reconcileDeletions(backend, listed, answer.digest, options.acceptRefusedDeletions, premises, validateReadSide);
  report.deleted = reconciled.deleted;
  report.held.push(...reconciled.held);
  if (reconciled.refused) {
    report.refused = reconciled.refused;
    return complete(undefined, false);
  }
  return complete(answer.digest, false);
}

// ── status and control ─────────────────────────────────────────────────────────────────────

export interface SyncStatus {
  counts: Record<OperationState, number>;
  paused: boolean;
  pausedReason?: string;
  bootstrapComplete: boolean;
  generation: number | null;
  lastPull: PullMarker | null;
}

/** Counts of intents by state plus the pause and bootstrap markers. */
export async function syncStatus(local: LocalTarget): Promise<SyncStatus> {
  const backend = await runtimeBackend(local);
  const mode = await admitBodyMode(backendOf(local));
  if (mode) for (const id of new Set((await backend.listIntents()).map(row => row.target))) await bodySnapshot(backendOf(local), id, mode);
  const counts: Record<OperationState, number> = { pending: 0, in_flight: 0, acknowledged: 0, conflict: 0, refused: 0, unknown: 0 };
  for (const row of await backend.listIntents()) counts[row.state] += 1;
  const control = await backend.readMeta<SyncControl>(SYNC_KEY);
  const marker = await backend.readMeta<BootstrapMarker>(BOOTSTRAP_KEY);
  const lastPull = await backend.readMeta<PullMarker>(PULL_KEY);
  return {
    counts,
    paused: control?.paused === true,
    ...(control?.reason !== undefined ? { pausedReason: control.reason } : {}),
    bootstrapComplete: marker?.complete === true,
    generation: marker?.generation ?? null,
    lastPull: lastPull ?? null,
  };
}

export interface ResumeReport {
  /** Intents refused for lost permission that are pending again. */
  requeued: number;
}

/**
 * Lift a pause after permission has been restored; an explicit decision, never automatic. The
 * intents the revocation refused return to `pending` with their attempts preserved, so the next
 * push redelivers them without a new local edit. Only authorization refusals are requeued: the
 * next delivery rechecks the same identity. Body delivery retains prior refusal evidence and
 * looks up first: a recorded refusal remains refused, whereas a positive never-recorded answer
 * can permit the identical submission. Resuming is scheduling, not an acceptance claim.
 */
export async function resume(local: LocalTarget): Promise<ResumeReport> {
  const backend = await runtimeBackend(local);
  await backend.writeMeta(SYNC_KEY, { paused: false } satisfies SyncControl);
  let requeued = 0;
  for (const row of await backend.listIntents("refused")) {
    if (!row.refusal || !AUTHORIZATION_REFUSAL_CODES.has(row.refusal.code)) continue;
    try {
      await backend.updateIntent(row.requestId, "refused", { state: "pending", attempts: row.attempts });
      requeued += 1;
    } catch (error) {
      if (!(error instanceof IntentStateConflict)) throw error;
    }
  }
  return { requeued };
}

/**
 * Return `in_flight` intents to `pending` so a later push can look them up. Only for a realm
 * that knows no other realm is mid-push over this store (a page that has just loaded and holds
 * the store's push role, see {@link withPushRole}); an intent reclaimed under a live push would
 * be delivered twice, which the authority's request identity tolerates but the journal should
 * not rely on.
 *
 * A reclaimed intent keeps its recorded attempts and never drops below one: the claim that put
 * it in flight may have delivered it, so the next push looks it up before submitting and a
 * later local edit chains behind it rather than superseding its request identity.
 */
export async function reclaimInFlight(local: LocalTarget): Promise<number> {
  const backend = await runtimeBackend(local);
  let reclaimed = 0;
  for (const row of await backend.listIntents("in_flight")) {
    try {
      await backend.updateIntent(row.requestId, "in_flight", { state: "pending", attempts: Math.max(1, row.attempts) });
      reclaimed += 1;
    } catch (error) {
      if (!(error instanceof IntentStateConflict)) throw error;
    }
  }
  return reclaimed;
}
