/** Explicit target establishment around the existing mutation and tuple-acceptance owners. */
import type { BoundFeed } from "../connectors.js";
import { readDocVersioned } from "../bundle-ops.js";
import { prepareDocumentMutationCandidate } from "../document-mutation.js";
import { stringifyDoc, parseMarkdown } from "../document-codec.js";
import { assertSafeConceptId } from "../paths.js";
import { isExcludedRecord, NEVER_OWNED, workStateFields } from "../record-overlay/policy.js";
import { overlayCanonicalJson } from "../record-overlay/canonical.js";
import type { Finding, OverlayReceipt, RecordChange } from "../record-overlay/types.js";
import type { ConceptId, Frontmatter, ReadResult, Version } from "../types.js";
import { isRequestIdentity, mintRequestId, type OperationIntent, type Outcome } from "../uncertain-write.js";
import { sha256Hex } from "../versioning.js";
import { createSourceOverlayAdapter, type SourceOverlayOptions, type SourceOverlayResult } from "./overlay.js";
import type { SourceState } from "./machine-state.js";
import type { PageCommit } from "./types.js";
import { registerSourceTargetConsumer } from "./target-consumer.js";
import { isSourceEstablishment } from "./target-descriptor.js";

export interface SourceTargetNamespace { contract: 1; authority: string; bundle: string }
/** Factory-local bounds. MachineState owns smaller host caps and the combined acceptance envelope on every write. */
export interface SourceTargetLimits { inventory: number; establishmentsPerPage: number; intentBytes: number }
export type SourceTargetAdmission = { kind: "admitted" } | { kind: "held"; code: "adoption_required" | "ownership_unproven" | "overlap_unsupported" | "scope_changed" };
/** The durable owner grants fresh exclusive send claims internally; recovery is lookup only. */
export interface SourceTargetDelivery {
  contract: 1;
  acceptsRequestId(requestId: string): boolean;
  deliver(intent: Readonly<OperationIntent>, input: Readonly<{ phase: "initial" | "recovery"; signal?: AbortSignal }>): Promise<Outcome>;
}
export interface SourceTargetAdapterOptions {
  overlay: SourceOverlayOptions; bound: BoundFeed; namespace: SourceTargetNamespace;
  generation: string; intentScope: string; limits: SourceTargetLimits;
  mintRequestId?: () => string; creation: SourceTargetDelivery;
  admit(input: Readonly<{ action: "create" | "adopt"; external_id: string; target: string; expectedVersion: Version | null; generation: string }>): Promise<SourceTargetAdmission>;
}
export interface SourceEstablishment {
  contract: 1; generation: string; group: string; target: ConceptId; kind: "create" | "adopt";
  expectedVersion: Version | null; observed_at: string; intent?: OperationIntent;
}
export interface SourceCommitPreparation { establishments: Readonly<Record<string, SourceEstablishment>> }
const bytes = (s: string): number => new TextEncoder().encode(s).length;
function scalar(s: string): void {
  if (typeof s !== "string" || !s.length || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)) throw new Error("source target identity must be nonempty Unicode scalar text");
}
export function sourceTargetId(input: { namespace: SourceTargetNamespace; targetKind: string; prefix: string; resource: string; externalId: string }): ConceptId {
  const { namespace, targetKind, prefix, resource, externalId } = input;
  if (namespace.contract !== 1) throw new Error("unsupported source target namespace");
  for (const s of [namespace.authority, namespace.bundle]) { scalar(s); if (bytes(s) > 512) throw new Error("source target namespace limit"); }
  if (externalId.length > 2048) throw new Error("source external identity limit");
  const parts = ["superbee/source-target/v1", namespace.authority, namespace.bundle, targetKind, resource, externalId];
  parts.forEach(scalar);
  // Prefix is pinned placement, deliberately outside the identity digest.
  if (!prefix.endsWith("/")) throw new Error("source target Convention requires a directory prefix");
  assertSafeConceptId(`${prefix}source-placeholder`);
  const id = `${prefix}source-${sha256Hex(parts.map(s => `${bytes(s)}:${s}`).join(""))}`;
  assertSafeConceptId(id); return id;
}
const ceilings: SourceTargetLimits = { inventory: 10000, establishmentsPerPage: 100, intentBytes: 262144 };
const protectedFields = new Set(["type", "sources", "body", "tags", "claims", "generated", "timestamp", "actor", "updated_by", "verification", "links"]);
export function createSourceTargetAdapter(input: SourceTargetAdapterOptions) {
  const options = { ...input, bound: structuredClone(input.bound), namespace: structuredClone(input.namespace), limits: structuredClone(input.limits),
    overlay: { ...input.overlay, content: { ...input.overlay.content, registry: structuredClone(input.overlay.content.registry) }, policy: structuredClone(input.overlay.policy), accepted: input.overlay.accepted === undefined ? undefined : structuredClone(input.overlay.accepted) } };
  const { bound, overlay: cfg, limits, generation, intentScope } = options;
  const kind = structuredClone(cfg.content.registry.kinds.get(bound.kind.governs));
  if (!kind || overlayCanonicalJson(kind) !== overlayCanonicalJson(bound.kind) || cfg.content.okfVersion !== "0.2"
    || !kind.path || !kind.path.endsWith("/") || kind.sections?.length || !generation || !intentScope
    || cfg.policy.provider !== bound.resource || bound.policy.provider !== bound.resource
    || bound.source.target_kind !== kind.governs || cfg.policy.target_kind !== kind.governs
    || overlayCanonicalJson(cfg.policy) !== overlayCanonicalJson(bound.policy) || options.creation.contract !== 1) throw new Error("source target binding/Kind/edition mismatch");
  for (const k of Object.keys(ceilings) as Array<keyof SourceTargetLimits>) if (!Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > ceilings[k]) throw new Error("source target limit invalid");
  if (cfg.overlays.size > limits.inventory) throw new Error("source target inventory limit");
  for (const field of cfg.policy.owned_fields) if (NEVER_OWNED.has(field) || workStateFields(kind, ["0.1", "0.2"]).has(field) || protectedFields.has(field) || ![...kind.fields.required, ...kind.fields.optional, "title"].includes(field)) throw new Error("source target ownership invalid");
  if (!cfg.policy.owned_fields.includes("title")) throw new Error("source target title ownership required");
  const overlay = createSourceOverlayAdapter(cfg);
  const canonical = (id: string) => sourceTargetId({ namespace: options.namespace, targetKind: kind.governs, prefix: kind.path!, resource: bound.resource, externalId: id });
  const accepted = (id: string, target: string) => overlay.snapshot().entries.some(e => e.feed === cfg.policy.feed && e.resource === bound.resource && e.external_id === id && e.target === target);
  async function read(id: string): Promise<ReadResult | null> {
    try { return await readDocVersioned(cfg.content.bundle, id); }
    catch (error) { if ((error as { code?: string })?.code === "ENOENT") return null; throw error; }
  }
  function identity(row: ReadResult, id: string): void {
    const fm = row.doc.frontmatter;
    const sources = Array.isArray(fm.sources) ? fm.sources : [];
    if (fm.type !== kind!.governs || !row.doc.id.startsWith(kind!.path!)
      || sources.filter(s => s && typeof s === "object" && (s as Record<string, unknown>).resource === bound.resource && (s as Record<string, unknown>).id === id).length !== 1) throw new Error("source target identity mismatch");
  }
  async function admit(action: "create" | "adopt", id: string, target: string, version: Version | null): Promise<void> {
    const decision = await options.admit(Object.freeze({ action, external_id: id, target, expectedVersion: version, generation }));
    if (decision.kind !== "admitted") throw new Error(`source target ${decision.code}`);
  }
  function projection(change: RecordChange): Frontmatter {
    const fields: Record<string, unknown> = { type: kind!.governs, sources: [{ resource: bound.resource, id: change.external_id }] };
    for (const f of cfg.policy.owned_fields) if (Object.hasOwn(change.after!, f)) fields[f] = structuredClone(change.after![f]);
    for (const f of kind!.fields.required) if (f !== "type" && f !== "sources" && (!cfg.policy.owned_fields.includes(f) || !Object.hasOwn(fields, f))) throw new Error("source target required field unavailable");
    return fields as Frontmatter;
  }
  async function prepareCommit(page: PageCommit): Promise<SourceCommitPreparation> {
    if (page.replay || page.establishments !== undefined || page.feed !== cfg.policy.feed || page.provider !== bound.resource) throw new Error("source target preparation scope");
    const group = `sha256:${sha256Hex(overlayCanonicalJson([intentScope, page.feed, generation, page.observed_at, page.page, page.changes])!)}`;
    const establishments: Record<string, SourceEstablishment> = Object.create(null);
    for (const change of page.changes) {
      if (!change.after || change.change_kind === "disappeared" || isExcludedRecord(cfg.policy, change.external_id, change.after.title)) continue;
      const id = change.external_id;
      const matches = cfg.overlays.lookup(bound.resource, id);
      if (matches.length > 1) throw new Error("source target ambiguous identity");
      let target = matches[0]?.id ?? canonical(id);
      let row = await read(target);
      if (matches.length && !row) throw new Error("source target disappeared");
      if (row) {
        identity(row, id);
        if (accepted(id, target)) continue;
        await admit("adopt", id, target, row.version);
        establishments[id] = { contract: 1, generation, group, target, kind: "adopt", expectedVersion: row.version, observed_at: page.observed_at };
      } else {
        await admit("create", id, target, null);
        const { candidate } = prepareDocumentMutationCandidate(undefined, { frontmatter: projection(change), body: "" }, {
          mode: "create-only", id: target, registry: cfg.content.registry, strict: true, okfVersion: "0.2", actor: cfg.actor, now: () => page.observed_at,
        });
        const content = stringifyDoc(candidate.frontmatter, candidate.body);
        const requestId = (options.mintRequestId ?? mintRequestId)();
        if (!isRequestIdentity(requestId) || !options.creation.acceptsRequestId(requestId)) throw new Error("source target request identity refused");
        const intent: OperationIntent = { requestId, kind: "document.write", target, base: null, local: `sha256:${sha256Hex(content)}`, content, createdAt: page.observed_at, attempts: 0, state: "pending" };
        if (bytes(JSON.stringify(intent)) > limits.intentBytes) throw new Error("source target intent limit");
        establishments[id] = { contract: 1, generation, group, target, kind: "create", expectedVersion: null, observed_at: page.observed_at, intent };
      }
    }
    if (Object.keys(establishments).length > limits.establishmentsPerPage) throw new Error("source target page limit");
    return { establishments };
  }
  async function commit(page: PageCommit): Promise<SourceOverlayResult> {
    if (page.feed !== cfg.policy.feed || page.provider !== bound.resource) throw new Error("source target commit scope");
    for (const change of page.changes) {
      if (!change.after || change.change_kind === "disappeared") continue;
      const id = change.external_id, e = page.establishments?.[id];
      if (!e) {
        if (isExcludedRecord(cfg.policy, id, change.after.title)) continue;
        const matches = cfg.overlays.lookup(bound.resource, id);
        if (matches.length !== 1 || !accepted(id, matches[0]!.id)) throw new Error("source target establishment required");
        continue;
      }
      if (!isSourceEstablishment(e) || e.generation !== generation) throw new Error("source target scope_changed");
      if (e.kind === "create") {
        if (e.target !== canonical(id) || !options.creation.acceptsRequestId(e.intent!.requestId)) throw new Error("source target intent scope");
        const parsed = parseMarkdown(e.intent!.content, e.target);
        const expected = prepareDocumentMutationCandidate(undefined, { frontmatter: projection(change), body: "" }, { mode: "create-only", id: e.target, registry: cfg.content.registry, strict: true, okfVersion: "0.2", actor: cfg.actor, now: () => e.observed_at }).candidate;
        if (stringifyDoc(expected.frontmatter, expected.body) !== e.intent!.content || parsed.body.trim() !== "") throw new Error("source target scope_changed");
        const outcome = await options.creation.deliver(structuredClone(e.intent!), { phase: page.replay ? "recovery" : "initial" });
        if (outcome.kind !== "committed" && outcome.kind !== "conflict") throw new Error("source target outcome unsettled");
        if (outcome.kind === "conflict" && (outcome.actual === null || outcome.tombstone !== undefined)) throw new Error("source target tombstone/conflict");
        const row = await read(e.target);
        if (!row) throw new Error("source target missing after settlement");
        identity(row, id);
        if (outcome.kind === "conflict") await admit("adopt", id, e.target, row.version);
        cfg.overlays.replace(row.doc, row.version);
      } else {
        const row = await read(e.target);
        if (!row || row.version !== e.expectedVersion) throw new Error("source target adoption changed");
        identity(row, id); await admit("adopt", id, e.target, row.version); cfg.overlays.replace(row.doc, row.version);
      }
    }
    const result = await overlay.commit(page);
    if (Object.keys(page.establishments ?? {}).some(id => result.hold?.includes(id) || result.retry?.includes(id))) { overlay.discard(); throw new Error("source target overlay held"); }
    return result;
  }
  registerSourceTargetConsumer(prepareCommit, commit);
  return { prepareCommit, commit, snapshot: overlay.snapshot, stagedSnapshot: overlay.stagedSnapshot, consume: overlay.consume, discard: overlay.discard,
    async reconcile(state: SourceState, at: string): Promise<SourceOverlayResult> {
      for (const [id, entry] of Object.entries(state.records)) {
        if (entry.gone || Object.hasOwn(state.pending ?? {}, id) || isExcludedRecord(cfg.policy, id, entry.after.title)) continue;
        const matches = cfg.overlays.lookup(bound.resource, id);
        if (matches.length > 1) throw new Error("source target ambiguous identity");
        if (matches.length === 1 && !accepted(id, matches[0]!.id)) { const row = await read(matches[0]!.id); if (!row) throw new Error("source target missing"); identity(row, id); await admit("adopt", id, row.doc.id, row.version); }
      }
      return overlay.reconcile(state, at);
    },
    applyFindings: (findings: readonly Finding[], at: string): Promise<OverlayReceipt> => overlay.applyFindings(findings, at),
  };
}
