/** Finite, data-only acquisition over the existing observation and overlay owners. */
import { findingsFor, isPrototypeKey, mapRecord, parseRecordSourceDeclaration, renderIdentity, type BoundFeed } from "../connectors.js";
import type { KindRegistry } from "../kinds.js";
import { readOverlayPolicyForResource } from "../record-overlay/policy.js";
import type { SourceIndex } from "../record-overlay/source-index.js";
import type { ConceptId, Frontmatter } from "../types.js";
import { blobVersion, sha256Hex } from "../versioning.js";
import { definitionCanonicalJson } from "../recipe-lifecycle/stamp.js";
import { driveObservation, isJsonData } from "./driver.js";
import { parseSnapshotEvidence, SNAPSHOT_SHA256, type SnapshotEvidence } from "./evidence.js";
import { isSourceState, type MachineState, type SourceState } from "./machine-state.js";
import { isSourceOverlaySnapshot, type SourceOverlaySnapshot } from "./overlay.js";
import type { CommitResult, PageCommit, ProfileDiagnostic, SourceRunReceipt } from "./types.js";

export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_MAX_RECORDS = 10_000;
export const SNAPSHOT_PROFILE = Object.freeze({ id: "local-snapshot", version: 1 });
export const SNAPSHOT_REFUSAL_CODES = ["SNAPSHOT_DECLARATION_INVALID", "SNAPSHOT_INPUT_INVALID", "SNAPSHOT_TOO_LARGE", "SNAPSHOT_RESOURCE_MISMATCH",
  "SNAPSHOT_SCOPE_MISMATCH", "SNAPSHOT_IDENTITY_INVALID", "SNAPSHOT_IDENTITY_DUPLICATE", "SNAPSHOT_STATE_INVALID", "SNAPSHOT_BINDING_CHANGED",
  "SNAPSHOT_GENERATION_ROLLBACK", "SNAPSHOT_GENERATION_COLLISION", "SNAPSHOT_CAPACITY_EXCEEDED", "SNAPSHOT_CAPACITY_INVALID"] as const;
export type SnapshotRefusalCode = typeof SNAPSHOT_REFUSAL_CODES[number];
export class SnapshotRefusal extends Error {
  readonly code: SnapshotRefusalCode;
  constructor(code: SnapshotRefusalCode) { super(code); this.code = code; this.name = "SnapshotRefusal"; }
}
const refuse = (code: SnapshotRefusalCode): never => { throw new SnapshotRefusal(code); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const closed = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).every(k => keys.includes(k));
const resourceValid = (v: unknown): v is string => typeof v === "string" && v.length <= 2048 && /^urn:[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._~:%-]*$/.test(v);
const scopeValid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).byteLength;

export interface BoundSnapshotSource extends BoundFeed {
  acquisition: "local-snapshot";
  bindingDigest: string;
  scope?: string;
}
export interface SnapshotDocument {
  v: 1;
  resource: string;
  generation: number;
  complete: boolean;
  scope?: string;
  records: Record<string, unknown>[];
  diagnostics?: ProfileDiagnostic[];
  evidence?: SnapshotEvidence;
}
export interface DecodedSnapshot {
  /** Copied exact input. Admission re-decodes these bytes, never trusting mutable derived fields. */
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
  data: SnapshotDocument;
}

/** Ordinary document policy; no Kind, executable profile or Connector registration is installed. */
export function bindSnapshotSource(doc: { id: ConceptId; frontmatter: Frontmatter }, kinds: KindRegistry,
  options: { okfVersion?: "0.1" | "0.2" } = {}): BoundSnapshotSource {
  const fm = (doc.frontmatter ?? {}) as unknown as Record<string, unknown>;
  if (!resourceValid(fm.resource) || typeof fm.target_kind !== "string" || !object(fm.identity)
    || !closed(fm.identity, ["id"]) || ["url", "connector", "source", "profile", "request", "auth", "domains", "credential"].some(k => Object.hasOwn(fm, k))
    || fm.scope !== undefined && !scopeValid(fm.scope) || fm.completeness === "complete" && !scopeValid(fm.scope)) return refuse("SNAPSHOT_DECLARATION_INVALID");
  const kind = kinds.kinds.get(fm.target_kind);
  if (!kind) return refuse("SNAPSHOT_DECLARATION_INVALID");
  const parsed = parseRecordSourceDeclaration({ name: "snapshot", profile: SNAPSHOT_PROFILE.id, target_kind: fm.target_kind,
    identity: { resource: fm.resource, id: fm.identity.id }, fields: fm.fields, completeness: fm.completeness }, kind, fm.resource);
  if (!parsed.ok) return refuse("SNAPSHOT_DECLARATION_INVALID");
  for (const key of ["owned_fields", "auto_apply", "needs_review"]) {
    const value = fm[key];
    if (value !== undefined && value !== null && typeof value !== "string" && !(Array.isArray(value) && value.every(item => typeof item === "string"))) return refuse("SNAPSHOT_DECLARATION_INVALID");
  }
  for (const key of ["missing_threshold", "exclude_pattern", "wall_time_zone"]) {
    const value = fm[key];
    if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number") return refuse("SNAPSHOT_DECLARATION_INVALID");
  }
  let policy: BoundFeed["policy"];
  try { policy = readOverlayPolicyForResource(doc, fm.resource, { targetKind: kind }); }
  catch { return refuse("SNAPSHOT_DECLARATION_INVALID"); }
  if (policy.owned_fields.some(field => !Object.hasOwn(parsed.source.fields, field))
    || (options.okfVersion ?? "0.1") !== "0.2" && policy.owned_fields.some(field => policy.list_fields?.includes(field))) return refuse("SNAPSHOT_DECLARATION_INVALID");
  const bound = { acquisition: "local-snapshot" as const, policy: { ...policy, target_kind: fm.target_kind, completeness: parsed.source.completeness },
    source: parsed.source, kind, parameters: {}, resource: fm.resource, ...(fm.scope !== undefined ? { scope: fm.scope as string } : {}) };
  // The accepted binding includes Kind shape and edition as well as mapping and policy.
  const bindingDigest = `sha256:${sha256Hex(definitionCanonicalJson({ ...bound, policy: { ...bound.policy, exclude: bound.policy.exclude?.source ?? null }, okfVersion: options.okfVersion ?? "0.1" }))}`;
  return structuredClone({ ...bound, bindingDigest });
}

/** Closed JSON v1, exact-byte identity, UTF-8/depth/finite/count bounds; never accesses a path. */
export function decodeSnapshot(input: Uint8Array): DecodedSnapshot {
  if (!(input instanceof Uint8Array)) return refuse("SNAPSHOT_INPUT_INVALID");
  if (input.byteLength > SNAPSHOT_MAX_BYTES) return refuse("SNAPSHOT_TOO_LARGE");
  const copy = new Uint8Array(input);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy)); }
  catch { return refuse("SNAPSHOT_INPUT_INVALID"); }
  if (!isJsonData(value) || !object(value) || !closed(value, ["v", "resource", "generation", "complete", "scope", "records", "diagnostics", "evidence"])
    || value.v !== 1 || !resourceValid(value.resource) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || typeof value.complete !== "boolean" || !Array.isArray(value.records) || value.records.length > SNAPSHOT_MAX_RECORDS
    || !value.records.every(object) || value.scope !== undefined && !scopeValid(value.scope)) return refuse("SNAPSHOT_INPUT_INVALID");
  if (value.diagnostics !== undefined && (!Array.isArray(value.diagnostics) || value.diagnostics.length > 100
    || !value.diagnostics.every(d => object(d) && closed(d, ["code", "message", "count"])
      && typeof d.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(d.code) && typeof d.message === "string" && d.message.length <= 512
      && (d.count === undefined || Number.isSafeInteger(d.count) && (d.count as number) >= 0)))) return refuse("SNAPSHOT_INPUT_INVALID");
  if (value.evidence !== undefined) value.evidence = parseSnapshotEvidence(value.evidence);
  return { bytes: copy, sha256: blobVersion(copy), byteLength: copy.byteLength, data: value as unknown as SnapshotDocument };
}

export interface SnapshotCapacityInput {
  /** Capture before reconciliation and retain unchanged through observation admission. */
  accepted: SourceOverlaySnapshot;
  /** One fresh index, also supplied unchanged to the overlay adapter for this run. */
  overlays: SourceIndex;
  /** CLI-owned ceiling for all envelope/binding/summary punctuation and version overhead. */
  envelopeOverheadBytes: number;
  maxEnvelopeBytes: number;
}
export interface SnapshotCapacityFacts {
  retainedIds: number;
  acceptedTuples: number;
  upperBoundBytes: number;
  maxEnvelopeBytes: number;
}
export interface SnapshotAdmissionOptions {
  bound: BoundSnapshotSource;
  snapshot: DecodedSnapshot;
  state: SourceState | null;
  /** Existing envelope binding, or null before binding. A history can never be silently rebound. */
  previousBindingDigest: string | null;
  capacity: SnapshotCapacityInput;
}
export interface SnapshotAdmission {
  observation: "new" | "replay";
  generation: number;
  currentGeneration: number | null;
  sha256: string;
  records: number;
  capacity: SnapshotCapacityFacts;
}

/**
 * Conservative upper bound over every possible stage, without simulating overlay decisions.
 * Each ID can retain an after plus a pending before/after/entry; each indexed tuple can retain
 * another after. A per-field maximum over old, mapped and accepted values bounds carrying and
 * clearing. Four copies of the original state cover retained extensions and metadata copied
 * from an old entry into a record, pending entry and change during retry/missing transitions.
 */
function capacityFacts(bound: BoundSnapshotSource, snapshot: DecodedSnapshot, state: SourceState | null, input: SnapshotCapacityInput): SnapshotCapacityFacts {
  if (!isSourceOverlaySnapshot(input.accepted) || !isJsonData(input.accepted)
    || !Number.isSafeInteger(input.envelopeOverheadBytes) || input.envelopeOverheadBytes < 0
    || !Number.isSafeInteger(input.maxEnvelopeBytes) || input.maxEnvelopeBytes < 1 || !input.overlays || typeof input.overlays.lookup !== "function") return refuse("SNAPSHOT_CAPACITY_INVALID");
  const bags = new Map<string, Record<string, unknown>>();
  const add = (id: string, values: Record<string, unknown> | null | undefined): void => {
    const bag = bags.get(id) ?? Object.create(null) as Record<string, unknown>;
    bags.set(id, bag);
    for (const [field, value] of Object.entries(values ?? {})) if (!Object.hasOwn(bag, field) || bytes(value) > bytes(bag[field])) bag[field] = value;
  };
  for (const [id, entry] of Object.entries(state?.records ?? {})) add(id, entry.after);
  for (const [id, pending] of Object.entries(state?.pending ?? {})) { add(id, pending.entry.after); add(id, pending.change.before); add(id, pending.change.after); }
  for (const entry of input.accepted.entries) add(entry.external_id, entry.after);
  for (const raw of snapshot.data.records) {
    const mapped = mapRecord(bound.source, raw, bound.kind);
    if (mapped.external_id !== null) add(mapped.external_id, mapped.kind === "mapped" ? mapped.fields : undefined);
  }
  const tupleKeys = new Set(input.accepted.entries.map(e => JSON.stringify([e.feed, e.resource, e.external_id, e.target])));
  const candidates: Array<{ feed: string; resource: string; external_id: string; target: string; after: Record<string, unknown> }> = [];
  for (const [id, after] of bags) {
    const matches = input.overlays.lookup(bound.resource, id, { type: bound.source.target_kind });
    if (matches.length !== 1) continue;
    const tuple = { feed: bound.policy.feed, resource: bound.resource, external_id: id, target: matches[0]!.id, after };
    tupleKeys.add(JSON.stringify([tuple.feed, tuple.resource, id, tuple.target]));
    candidates.push(tuple);
  }
  const time = "x".repeat(32), digest = `sha256:${"f".repeat(64)}`;
  const records: Record<string, unknown> = Object.create(null), pending: Record<string, unknown> = Object.create(null);
  for (const [id, after] of bags) {
    const entry = { after, digest, missing: Number.MAX_SAFE_INTEGER, first_missing_at: time, gone: true, seen_at: time };
    records[id] = entry;
    pending[id] = { change: { external_id: id, change_kind: "disappeared", changed_fields: Object.keys(after), before: after, after,
      content_digest: digest, missing_count: Number.MAX_SAFE_INTEGER, first_missing_at: time }, entry, held_at: time, replay_failures: Number.MAX_SAFE_INTEGER };
  }
  const upperBoundBytes = input.envelopeOverheadBytes + 4 * bytes(state) + bytes(input.accepted)
    + bytes({ v: 1, profile: SNAPSHOT_PROFILE, cursor: { v: 1, generation: Number.MAX_SAFE_INTEGER, sha256: snapshot.sha256 }, open: false,
      records, pending, complete_observations: Number.MAX_SAFE_INTEGER, last_complete_at: time }) + bytes({ v: 1, entries: candidates });
  const facts = { retainedIds: bags.size, acceptedTuples: tupleKeys.size, upperBoundBytes, maxEnvelopeBytes: input.maxEnvelopeBytes };
  if (facts.retainedIds > SNAPSHOT_MAX_RECORDS || facts.acceptedTuples > SNAPSHOT_MAX_RECORDS || facts.upperBoundBytes > facts.maxEnvelopeBytes) return refuse("SNAPSHOT_CAPACITY_EXCEEDED");
  return facts;
}

/** Snapshot history has one fixed state format; malformed retry data cannot reach a commit. */
function snapshotStateValid(value: unknown): value is SourceState {
  if (!isSourceState(value) || !isJsonData(value)) return false;
  const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
  const idValid = (id: string): boolean => id.length > 0 && id.length <= 2048 && !isPrototypeKey(id) && !/[\x00-\x1f\x7f]/.test(id);
  const entryValid = (entry: unknown): boolean => object(entry) && object(entry.after) && typeof entry.digest === "string" && SNAPSHOT_SHA256.test(entry.digest)
    && count(entry.missing) && typeof entry.seen_at === "string" && (entry.gone === undefined || entry.gone === true)
    && (entry.first_missing_at === undefined || typeof entry.first_missing_at === "string");
  if (!count(value.complete_observations) || value.last_complete_at !== undefined && typeof value.last_complete_at !== "string"
    || !Object.entries(value.records).every(([id, entry]) => idValid(id) && entryValid(entry))) return false;
  return Object.entries(value.pending ?? {}).every(([id, pending]) => {
    const change = pending.change;
    return idValid(id) && entryValid(pending.entry) && typeof pending.held_at === "string" && (pending.replay_failures === undefined || count(pending.replay_failures))
      && ["new", "changed", "disappeared"].includes(change.change_kind) && Array.isArray(change.changed_fields) && change.changed_fields.every(f => typeof f === "string")
      && (change.before === null || object(change.before)) && (change.after === null || object(change.after))
      && typeof change.content_digest === "string" && SNAPSHOT_SHA256.test(change.content_digest)
      && (change.missing_count === undefined || count(change.missing_count)) && (change.first_missing_at === undefined || typeof change.first_missing_at === "string");
  });
}

/** All refusal checks are pure and precede reconciliation, pending retries, Findings and writes. */
export function admitSnapshot(options: SnapshotAdmissionOptions): SnapshotAdmission {
  const { bound, state } = options;
  const snapshot = decodeSnapshot(options.snapshot.bytes);
  if (bound.acquisition !== "local-snapshot" || bound.source.profile !== SNAPSHOT_PROFILE.id || !resourceValid(bound.resource)
    || bound.policy.provider !== bound.resource || bound.source.identity.resource !== bound.resource) return refuse("SNAPSHOT_DECLARATION_INVALID");
  if (snapshot.data.resource !== bound.resource) return refuse("SNAPSHOT_RESOURCE_MISMATCH");
  if (snapshot.data.complete && (bound.source.completeness !== "complete" || bound.scope === undefined || snapshot.data.scope !== bound.scope)
    || snapshot.data.scope !== undefined && snapshot.data.scope !== bound.scope) return refuse("SNAPSHOT_SCOPE_MISMATCH");
  let currentGeneration: number | null = null;
  let observation: "new" | "replay" = "new";
  if (state !== null) {
    if (!snapshotStateValid(state) || state.profile.id !== SNAPSHOT_PROFILE.id || state.profile.version !== SNAPSHOT_PROFILE.version
      || !closed(state.profile, ["id", "version"]) || state.open !== false || state.validators !== undefined || !object(state.cursor)
      || !closed(state.cursor, ["v", "generation", "sha256"]) || state.cursor.v !== 1 || !Number.isSafeInteger(state.cursor.generation)
      || (state.cursor.generation as number) < 1 || typeof state.cursor.sha256 !== "string" || !SNAPSHOT_SHA256.test(state.cursor.sha256)) return refuse("SNAPSHOT_STATE_INVALID");
    if (options.previousBindingDigest !== bound.bindingDigest) return refuse("SNAPSHOT_BINDING_CHANGED");
    currentGeneration = state.cursor.generation as number;
    if (snapshot.data.generation < currentGeneration) return refuse("SNAPSHOT_GENERATION_ROLLBACK");
    if (snapshot.data.generation === currentGeneration) {
      if (snapshot.sha256 !== state.cursor.sha256) return refuse("SNAPSHOT_GENERATION_COLLISION");
      observation = "replay";
    }
  }
  const ids = new Set<string>();
  for (const raw of snapshot.data.records) {
    const identity = renderIdentity(bound.source, bound, raw);
    if (!identity.ok || isPrototypeKey(identity.id) || /[\x00-\x1f\x7f]/.test(identity.id)) return refuse("SNAPSHOT_IDENTITY_INVALID");
    if (ids.has(identity.id)) return refuse("SNAPSHOT_IDENTITY_DUPLICATE");
    ids.add(identity.id);
  }
  return { observation, generation: snapshot.data.generation, currentGeneration, sha256: snapshot.sha256, records: ids.size,
    capacity: capacityFacts(bound, snapshot, state, options.capacity) };
}

export interface ObserveSnapshotOptions {
  bound: BoundSnapshotSource;
  snapshot: DecodedSnapshot;
  previousBindingDigest: string | null;
  state: MachineState;
  capacity: SnapshotCapacityInput;
  now?: () => Date;
  signal?: AbortSignal;
  commit(page: PageCommit): Promise<CommitResult | void>;
}
export interface SnapshotRunReceipt extends SourceRunReceipt {
  observation: "new" | "replay";
  generation: number;
  sha256: string;
  capacity: SnapshotCapacityFacts;
}
/** One finite acquisition. Admission refusals throw; runtime commit/store failures use the receipt. */
export async function observeSnapshot(options: ObserveSnapshotOptions): Promise<SnapshotRunReceipt> {
  const bound = structuredClone(options.bound), snapshot = decodeSnapshot(options.snapshot.bytes);
  const stored = await options.state.read(bound.policy.feed);
  const admission = admitSnapshot({ bound, snapshot, state: stored?.state ?? null, previousBindingDigest: options.previousBindingDigest, capacity: options.capacity });
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const receipt: SnapshotRunReceipt = { feed: bound.policy.feed, provider: bound.resource, source: bound.source.name, profile: { ...SNAPSHOT_PROFILE },
    mode: "complete", observed_at: observedAt, outcome: "observed", retry: true, pages: 0, held: 0, pending: Object.keys(stored?.state.pending ?? {}).length,
    requests: [], pass: { resumed: false, ended: false, complete: false }, changes: { new: 0, changed: 0, disappeared: 0 }, cursor: stored?.state.cursor ?? null,
    diagnostics: [], profile_diagnostics: [], findings: [], observation: admission.observation, generation: admission.generation, sha256: admission.sha256, capacity: admission.capacity };
  const extraFindings: SourceRunReceipt["findings"] = [];
  await driveObservation({ bound, state: options.state, initial: stored?.state ?? { v: 1, profile: { ...SNAPSHOT_PROFILE }, cursor: null, open: false, records: {}, complete_observations: 0 },
    version: stored?.version ?? null, receipt, observedAt, mode: "complete", resumed: false, signal: options.signal ?? new AbortController().signal,
    pages: 1, replayOnly: admission.observation === "replay", extraFindings, commit: options.commit,
    acquire: async () => ({ records: snapshot.data.records, more: false, complete: snapshot.data.complete,
      nextCursor: { v: 1, generation: snapshot.data.generation, sha256: snapshot.sha256 }, diagnostics: snapshot.data.diagnostics }),
    stop: stop => { receipt.outcome = stop.outcome; receipt.retry = stop.retry; if (stop.reason !== undefined) receipt.reason = stop.reason; },
  });
  receipt.findings = [...extraFindings, ...findingsFor(receipt.diagnostics, { source: bound.source.name })];
  return receipt;
}
