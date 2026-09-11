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

import type { Bundle, ConceptId, OkfDocument, StorageBackend, Version, WriteOptions } from "@superbee/core";
import { stringifyDoc } from "@superbee/core/document-codec";
import { mutateDocument, type DocumentMutationMode, type DocumentMutationResult, type MutateDocumentOptions } from "@superbee/core/document-mutation";
import { IndexedDbBackend, type IdbFactoryLike } from "@superbee/core/indexeddb-backend";
import {
  IntentHoldConflict,
  IntentStateConflict,
  type IntentRecord,
  type JournaledBackend,
  type MetaRecord,
  type NewIntentRecord,
} from "@superbee/core/journaled-backend";
import type { KindRegistry } from "@superbee/core/kinds";
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

export interface OpenLocalBundleOptions {
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
  /** Release the store handle; a later operation reopens it lazily. */
  close(): void;
}

/**
 * Open (or lazily create) the browser-local working copy stored under `name`. The bundle root
 * is a label, not a path: the engine routes every operation through `bundle.backend`.
 */
export function openLocalBundle(name: string, options: OpenLocalBundleOptions = {}): LocalBundle {
  const backend = options.backend ?? new IndexedDbBackend({ databaseName: name, indexedDB: options.indexedDB });
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
}

export interface BootstrapMarker {
  generation: number;
  startedAt: string;
  complete: boolean;
  completedAt?: string;
  documentCount?: number;
  /** Documents not hydrated because a local edit was committed to them during this bootstrap. */
  held?: ConceptId[];
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

/** The version of the document currently stored locally, or `null` when absent. */
async function localVersion(backend: JournaledBackend, id: ConceptId): Promise<Version | null> {
  try {
    return (await backend.read(id)).version;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return null;
    throw error;
  }
}

// ── bootstrap ──────────────────────────────────────────────────────────────────────────────

export interface BootstrapOptions {
  /** Called after each document is hydrated; a progress hook for a page, a fault point for a test. */
  onHydrated?: (id: ConceptId, index: number, total: number) => void | Promise<void>;
  /** Documents fetched per `readMany` round trip. */
  batchSize?: number;
}

/**
 * Hydrate the working copy from the authority: every remote document is written locally with
 * the shared version recorded as its base, the root `index.md` is copied so the local edition
 * matches, and only after every write has committed does the marker say `complete`. The marker
 * is written incomplete first, so an interruption at any point leaves a bundle that reports
 * itself incomplete rather than an apparently complete, partially hydrated one.
 *
 * Bootstrap refuses to run over unsettled intents: rewriting their targets would discard local
 * edits the authority has not accepted. An edit committed while bootstrap is already fetching is
 * caught by the hydrating write's own transaction: that document is left as the edit made it,
 * listed in the marker as `held`, and push discovers the divergence.
 */
export async function bootstrap(remote: StorageBackend, local: LocalTarget, options: BootstrapOptions = {}): Promise<BootstrapMarker> {
  const backend = backendOf(local);
  const unsettled = await backend.listIntents(UNSETTLED_STATES);
  if (unsettled.length > 0) {
    throw new Error(`bootstrap refused: ${unsettled.length} unsettled intent(s) would be discarded; push or resolve them first.`);
  }
  const previous = await backend.readMeta<BootstrapMarker>(BOOTSTRAP_KEY);
  const generation = (previous?.generation ?? 0) + 1;
  const startedAt = new Date().toISOString();
  await backend.writeMeta(BOOTSTRAP_KEY, { generation, startedAt, complete: false } satisfies BootstrapMarker);

  const rootIndex = await remote.readReserved("", "index.md");
  if (rootIndex) await backend.writeReserved("", "index.md", rootIndex.content);

  const ids = await remote.list();
  const findings: string[] = [];
  const held: ConceptId[] = [];
  let index = 0;
  for (const batch of chunked(ids, options.batchSize ?? 25)) {
    const heads = await remote.readMany(batch);
    for (const head of heads) {
      const id = head.doc.id;
      try {
        const { version } = await backend.writeJournaled(id, head.doc, {
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
      await options.onHydrated?.(id, index, ids.length);
      index += 1;
    }
  }

  const marker: BootstrapMarker = {
    generation,
    startedAt,
    complete: true,
    completedAt: new Date().toISOString(),
    documentCount: ids.length,
    ...(held.length > 0 ? { held } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  };
  await backend.writeMeta(BOOTSTRAP_KEY, marker);
  return marker;
}

/** True only when the last bootstrap wrote its completion marker after every document committed. */
export async function isComplete(local: LocalTarget): Promise<boolean> {
  const marker = await backendOf(local).readMeta<BootstrapMarker>(BOOTSTRAP_KEY);
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
    return {
      intent: {
        requestId: mintRequestId(),
        kind: "document.write",
        target: id,
        base: shared?.version ?? null,
        baseContent: shared?.content ?? null,
        createdAt: now,
      },
    };
  }
  const neverDelivered = latest.state === "pending" && latest.attempts === 0;
  if (neverDelivered || latest.state === "refused") {
    return {
      intent: {
        requestId: mintRequestId(),
        kind: "document.write",
        target: id,
        base: latest.base,
        baseContent: latest.baseContent,
        createdAt: now,
        ...(latest.after !== undefined ? { after: latest.after } : {}),
      },
      supersede: { requestId: latest.requestId, expectedState: latest.state, expectedAttempts: latest.attempts },
    };
  }
  return {
    intent: {
      requestId: mintRequestId(),
      kind: "document.write",
      target: id,
      base: latest.local,
      baseContent: latest.content,
      createdAt: now,
      after: latest.requestId,
    },
  };
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

// ── push ───────────────────────────────────────────────────────────────────────────────────

export interface PushOptions {
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
  const current = await backend.readIntent(requestId);
  if (!current) throw new IntentStateConflict(requestId, "in_flight", null);
  // The primitive already settles a conflict at the intent's own version as committed; applying
  // the same rule here keeps this exported function correct for a caller that passes a raw
  // transport outcome, so no path can land the client's own commit as a concurrent edit.
  outcome = settleAgainstIntent(outcome, current);
  switch (outcome.kind) {
    case "committed": {
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
      const remote = await remoteHead(options.remote, current.target, outcome.actual);
      return backend.updateIntent(requestId, "in_flight", { state: "conflict", attempts, remote });
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
  const backend = backendOf(local);
  const report: PushReport = { paused: false, settled: [], skipped: [] };
  const control = await backend.readMeta<SyncControl>(SYNC_KEY);
  if (control?.paused) {
    report.paused = true;
    return report;
  }
  for (const intent of await backend.listIntents("pending")) {
    if (intent.after !== undefined) {
      const predecessor = await backend.readIntent(intent.after);
      if (predecessor && predecessor.state !== "acknowledged") {
        report.skipped.push({ requestId: intent.requestId, target: intent.target, reason: "blocked" });
        continue;
      }
    }
    let claimed: IntentRecord;
    try {
      claimed = await backend.updateIntent(intent.requestId, "pending", { state: "in_flight", attempts: intent.attempts + 1 });
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
  return withPushRole(pushRoleName(local.name), () => push(local.backend, transport, options), role);
}

// ── pull ───────────────────────────────────────────────────────────────────────────────────

export interface PullOptions {
  batchSize?: number;
}

export interface PullReport {
  refreshed: ConceptId[];
  /** Documents left alone because an unsettled intent targets them; push discovers any divergence. */
  held: ConceptId[];
  unchanged: ConceptId[];
}

/**
 * Refresh every document that carries no unsettled intent to the authority's head and record
 * that head as its shared base. Documents with an unsettled intent are held: their base is the
 * one the edit was made against, and a moved shared head is push's conflict to report, never a
 * silent base replacement here. The intents known before the network round trip only save
 * fetching held documents; the hold that decides is the one the refreshing write checks inside
 * its own transaction, so an edit committed during the round trip holds its document too.
 */
export async function pull(local: LocalTarget, remote: StorageBackend, options: PullOptions = {}): Promise<PullReport> {
  const backend = backendOf(local);
  const startedAt = new Date().toISOString();
  await backend.writeMeta(PULL_KEY, { startedAt, completedAt: null, refreshed: 0 } satisfies PullMarker);
  const report: PullReport = { refreshed: [], held: [], unchanged: [] };
  const heldTargets = new Set((await backend.listIntents(UNSETTLED_STATES)).map((row) => row.target));
  const ids = await remote.list();
  const candidates: ConceptId[] = [];
  for (const id of ids) {
    if (heldTargets.has(id)) report.held.push(id);
    else candidates.push(id);
  }
  for (const batch of chunked(candidates, options.batchSize ?? 25)) {
    const heads = await remote.readMany(batch);
    for (const head of heads) {
      const id = head.doc.id;
      const base = await backend.readMeta<SharedBase>(baseKey(id));
      if (base?.version === head.version) {
        report.unchanged.push(id);
        continue;
      }
      const expectedVersion = await localVersion(backend, id);
      try {
        await backend.writeJournaled(id, head.doc, {
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
          continue;
        }
        throw error;
      }
    }
  }
  await backend.writeMeta(PULL_KEY, { startedAt, completedAt: new Date().toISOString(), refreshed: report.refreshed.length } satisfies PullMarker);
  return report;
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
  const backend = backendOf(local);
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
 * authority never admitted those requests, so their identities carry no recorded outcome and a
 * redelivery under the same identity is a first delivery. Any other refusal was recorded under
 * the identity and would be answered the same way again; only a new local edit, which
 * supersedes it with a fresh identity, changes that.
 */
export async function resume(local: LocalTarget): Promise<ResumeReport> {
  const backend = backendOf(local);
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
  const backend = backendOf(local);
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
