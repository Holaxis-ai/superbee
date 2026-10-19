/** Tuple acceptance belongs to the overlay, separately from the engine's observation baseline. */
import { changeBetween } from "../connectors.js";
import { applyRecordOverlay } from "../record-overlay/apply.js";
import { HOLD_STORE, RETRYABLE } from "../record-overlay/errors.js";
import { planFindings } from "../record-overlay/findings.js";
import { planRecordOverlay } from "../record-overlay/plan.js";
import type { SourceIndex } from "../record-overlay/source-index.js";
import type { Finding, OverlayBundle, OverlayHooks, OverlayPolicy, OverlayReceipt, RecordChange } from "../record-overlay/types.js";
import type { SourceState } from "./machine-state.js";
import type { CommitResult, PageCommit } from "./types.js";

export const MAX_SOURCE_OVERLAY_ENTRIES = 10_000;
export interface SourceOverlayEntry {
  feed: string;
  resource: string;
  external_id: string;
  target: string;
  after: Record<string, unknown>;
}
export interface SourceOverlaySnapshot { v: 1; entries: SourceOverlayEntry[] }
export interface SourceOverlayResult extends CommitResult { receipt: OverlayReceipt; changes: RecordChange[] }
export interface SourceOverlayOptions {
  content: OverlayBundle;
  ops?: OverlayBundle;
  policy: OverlayPolicy;
  actor: string;
  overlays: SourceIndex;
  accepted?: SourceOverlaySnapshot;
  slug?: string;
  sameBundle?: boolean;
  hooks?: OverlayHooks;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const key = (e: Omit<SourceOverlayEntry, "after">): string => JSON.stringify([e.feed, e.resource, e.external_id, e.target]);
/** Validate before admitting private persisted acceptance; never silently reset malformed state. */
export function isSourceOverlaySnapshot(value: unknown): value is SourceOverlaySnapshot {
  if (!object(value) || value.v !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_SOURCE_OVERLAY_ENTRIES) return false;
  const keys = new Set<string>();
  return value.entries.every((entry: unknown) => {
    if (!object(entry) || ![entry.feed, entry.resource, entry.external_id, entry.target].every(v => typeof v === "string" && v.length > 0) || !object(entry.after)) return false;
    const k = key(entry as unknown as SourceOverlayEntry);
    if (keys.has(k)) return false;
    keys.add(k); return true;
  });
}

/**
 * One adapter per run with one fresh index shared by planning and application. Its staged
 * snapshot must be co-published with the supplying observation, then consumed. Failure discards
 * the stage; the caller must stop the run. This object owns no durable state or cursor.
 */
export function createSourceOverlayAdapter(options: SourceOverlayOptions) {
  const { content, policy, actor, overlays } = options;
  const ops = options.ops ?? content;
  if (options.accepted !== undefined && !isSourceOverlaySnapshot(options.accepted)) throw new Error("invalid source overlay snapshot");
  let committed = new Map<string, SourceOverlayEntry>();
  for (const entry of options.accepted?.entries ?? []) {
    if (entry.feed === policy.feed && entry.resource === policy.provider
      && overlays.lookup(entry.resource, entry.external_id, { type: policy.target_kind }).some(h => h.id === entry.target)) {
      committed.set(key(entry), structuredClone(entry));
    }
  }
  let staged: Map<string, SourceOverlayEntry> | null = null;
  const snapshotOf = (entries: Map<string, SourceOverlayEntry>): SourceOverlaySnapshot => ({ v: 1, entries: structuredClone([...entries.values()].sort((a,b) => key(a).localeCompare(key(b)))) });
  const context = { content, ops, policy, actor, overlays, hooks: options.hooks };

  async function apply(changes: readonly RecordChange[], observedAt: string, page?: PageCommit): Promise<SourceOverlayResult> {
    if (staged !== null) throw new Error("source overlay acceptance awaits publication");
    const candidates: SourceOverlayEntry[] = [];
    const adjusted = changes.map(change => {
      if (change.after === null || change.change_kind === "disappeared") return change;
      const matches = overlays.lookup(policy.provider, change.external_id, { type: policy.target_kind });
      if (matches.length !== 1) return change;
      const entry = { feed: policy.feed, resource: policy.provider, external_id: change.external_id, target: matches[0]!.id, after: change.after };
      const previous = committed.get(key(entry))?.after ?? {};
      const diff = changeBetween(previous, { kind: "mapped", external_id: change.external_id, fields: change.after, unobserved: [], cleared: Object.keys(previous).filter(f => !Object.hasOwn(change.after!, f)), diagnostics: [] }, { external_id: change.external_id, change_kind: "changed" });
      candidates.push({ ...entry, after: diff.after! });
      return { ...change, ...diff };
    });
    if (committed.size + candidates.filter(e => !committed.has(key(e))).length > MAX_SOURCE_OVERLAY_ENTRIES) throw new Error("source overlay acceptance limit exceeded");
    const plan = await planRecordOverlay({ content, ops, policy, changes: adjusted, observedAt, overlays,
      sameBundle: options.sameBundle ?? ops === content, hooks: options.hooks,
      ...(page ? { records: { ...page.records }, observation: { baseline: page.baseline, replay: page.replay } } : {}) });
    const receipt = await applyRecordOverlay(plan, context);
    const retry = new Set<string>(); const hold = new Set<string>();
    const refused = [...receipt.refusals, ...receipt.results.filter(r => r.outcome === "refused" && r.code !== undefined)];
    for (const row of refused) {
      if (row.code && RETRYABLE.has(row.code)) retry.add(row.external_id);
      else if (row.code && HOLD_STORE.has(row.code)) hold.add(row.external_id);
    }
    staged = new Map(committed);
    for (const candidate of candidates) {
      const id = candidate.external_id;
      const failed = receipt.results.some(r => r.external_id === id && r.outcome === "refused")
        || receipt.refusals.some(r => r.external_id === id && r.code !== "OVERLAY_DOC_CONFLICT");
      if (!failed) staged.set(key(candidate), structuredClone(candidate));
    }
    return { receipt, changes: adjusted, retry: [...retry], hold: [...hold] };
  }
  return {
    snapshot: (): SourceOverlaySnapshot => snapshotOf(committed),
    stagedSnapshot: (): SourceOverlaySnapshot | null => staged === null ? null : snapshotOf(staged),
    consume(): void { if (staged !== null) committed = staged; staged = null; },
    discard(): void { staged = null; },
    commit: (page: PageCommit): Promise<SourceOverlayResult> => apply(page.changes, page.observed_at, page),
    async reconcile(state: SourceState, observedAt: string): Promise<SourceOverlayResult> {
      const changes: RecordChange[] = [];
      for (const [id, entry] of Object.entries(state.records)) {
        if (entry.gone || Object.hasOwn(state.pending ?? {}, id)) continue;
        const matches = overlays.lookup(policy.provider, id, { type: policy.target_kind });
        if (matches.length === 0) continue;
        changes.push({ external_id: id, change_kind: "changed", before: null, after: entry.after, changed_fields: Object.keys(entry.after), content_digest: entry.digest });
      }
      return apply(changes, observedAt);
    },
    async applyFindings(findings: readonly Finding[], observedAt: string): Promise<OverlayReceipt> {
      if (staged !== null) throw new Error("source overlay acceptance awaits publication");
      const steps = await planFindings({ ops, provider: policy.provider, feed: policy.feed,
        slug: options.slug ?? `${policy.feed.split("/").pop()}-source`, findings, observedAt });
      return applyRecordOverlay({ feed: policy.feed, provider: policy.provider, observed_at: observedAt, steps, refusals: [] }, context);
    },
  };
}
export type SourceOverlayAdapter = ReturnType<typeof createSourceOverlayAdapter>;
