/**
 * Apply a plan. Every write goes through `mutateDocument`, and every write step carries a guard
 * that core builds itself and runs through `assertCandidate` on the fresh read, so the check and
 * the compare-and-swap commit or refuse together:
 *
 * - `apply-owned-fields`: the ownership guard admits only owned and derived fields (and, in the
 *   grouped shape, the record's own `sources` entry), never the body, and requires the identity;
 * - `create-signal`: the Signal create guard admits only a new document of the attention Kind,
 *   under its path, with a fixed key set and the claim state `todo`;
 * - `collapse-signal`: the Signal update guard admits only an existing attention Kind document,
 *   a fixed key set and one appended observation line.
 *
 * Nothing else is ever created, and nothing is ever deleted.
 */
import { readBundleOkfVersion } from "../bundle-ops.js";
import {
  containsCollection,
  FieldActionError,
  prepareDocumentFieldAction,
  type FieldAction,
} from "../document-field-actions.js";
import {
  DocumentNotFoundError,
  KindConformanceError,
  mutateDocument,
  type DocumentMutationCandidate,
  type DocumentMutationInput,
  type DocumentMutationResult,
} from "../document-mutation.js";
import { PreconditionFailed } from "../document-precondition.js";
import { InvalidInputError } from "../errors.js";
import type { KindRegistry } from "../kinds.js";
import { isManagedDocumentMetadataField } from "../managed-document-metadata.js";
import { okfValuesEqual } from "../okf-authored-values.js";
import { assertSafeConceptId } from "../paths.js";
import { isOkfActor } from "../okf-actor.js";
import { hasSourceIdentity, matchesSourceIdentity } from "../query-filter.js";
import type { OkfDocument } from "../types.js";
import { VersionConflict } from "../versioning.js";
import { same } from "./canonical.js";
import { CORE_VALUE_CODES, OverlayRefusal, REFUSAL_CODES, type RefusalCode } from "./errors.js";
import { NEVER_OWNED, workStateFields } from "./policy.js";
import { redactUrl } from "./redact.js";
import { resolveAttentionKind, type AttentionResolution } from "./signal-kind.js";
import type {
  ApplyContext,
  ApplyOwnedFieldsStep,
  AssertCandidate,
  CollapseSignalStep,
  CreateSignalStep,
  OverlayPlan,
  OverlayReceipt,
  OverlayStep,
  StepResult,
} from "./types.js";

const STEP_OPS = new Set(["apply-owned-fields", "create-signal", "collapse-signal", "signal-duplicate", "record-only"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The owned and derived lists may never name a never-owned field, core's managed metadata, or the
 * target's work state (the progress storage fields always; the target Kind's claim fields when known).
 */
function assertAdmissibleFields(ownedFields: readonly unknown[], derivedFields: readonly unknown[], workState: ReadonlySet<string> = workStateFields(undefined, [])): void {
  for (const [list, name] of [[ownedFields, "owned_fields"], [derivedFields, "deriveFields.fields"]] as const) {
    if (list.some((field) => typeof field !== "string")) {
      throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, `${name} must be a list of field names`, { list: name });
    }
    const bad = (list as readonly string[]).filter((field) => NEVER_OWNED.has(field) || isManagedDocumentMetadataField(field) || workState.has(field));
    if (bad.length) {
      throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, `${name} names fields a feed can never own: ${bad.join(", ")}`, { list: name, fields: bad });
    }
  }
}

/**
 * In the grouped shape `sources` may change only by the step's own upsert: the fresh list carries
 * (provider, external id) exactly once, removing that position from both lists leaves two equal
 * lists, and the candidate's entry there is the fresh entry merged with the step's properties and
 * nothing else. A moved, duplicated or added identity entry leaves the remainders unequal.
 */
function sourcesUpsertOnly(
  fresh: unknown,
  next: unknown,
  provider: string,
  externalId: string,
  properties: Record<string, unknown>,
): boolean {
  if (!Array.isArray(fresh) || !Array.isArray(next)) return false;
  const identity = { resource: provider, id: externalId };
  const at = fresh.flatMap((row, index) => (matchesSourceIdentity(row, identity) ? [index] : []));
  if (at.length !== 1) return false;
  const index = at[0]!;
  const rest = (rows: unknown[]): unknown[] => rows.filter((_, i) => i !== index);
  return same(rest(fresh), rest(next)) && same(next[index], { ...(fresh[index] as Record<string, unknown>), ...properties, ...identity });
}

/**
 * The ownership guard: refuse any candidate that differs from the fresh document outside the
 * admitted fields (`FIELD_NOT_OWNED`), whose fresh read lost the provider identity
 * (`OVERLAY_IDENTITY_LOST`), or whose owned field no longer holds the value the plan was decided
 * against (`OVERLAY_DOC_CONFLICT`). Synchronous. Refuses at construction (`POLICY_INVALID`) when
 * a list names a never-owned field or managed metadata.
 */
export function ownershipGuard(o: {
  ownedFields: readonly string[];
  provider: string;
  externalId: string;
  expectedFrom?: Record<string, unknown>;
  derivedFields?: readonly string[];
  sourceProperties?: Record<string, unknown>;
  /** The Kind the plan was derived for; a fresh document of any other type is refused. */
  targetKind?: string;
}): AssertCandidate {
  const { ownedFields, provider, externalId, expectedFrom = {}, derivedFields = [], sourceProperties, targetKind } = o;
  assertAdmissibleFields(ownedFields, derivedFields);
  const admitted = new Set([...ownedFields, ...derivedFields]);
  return (existing, candidate) => {
    if (!existing) throw new OverlayRefusal(REFUSAL_CODES.OVERLAY_IDENTITY_LOST, "overlay document no longer exists", { external_id: externalId });
    if (targetKind !== undefined && existing.frontmatter.type !== targetKind) {
      throw new OverlayRefusal(REFUSAL_CODES.FIELD_NOT_OWNED, `owned-field writes reach ${targetKind} documents only`, { field: "type", external_id: externalId });
    }
    const before = existing.frontmatter as unknown as Record<string, unknown>;
    const after = candidate.frontmatter as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const touched = [...keys].filter((k) => !same(before[k], after[k]));
    const notOwned = touched.filter((k) => !admitted.has(k)
      && !(k === "sources" && sourceProperties !== undefined && sourcesUpsertOnly(before.sources, after.sources, provider, externalId, sourceProperties)));
    if (candidate.body !== existing.body) notOwned.push("(body)");
    if (notOwned.length) throw new OverlayRefusal(REFUSAL_CODES.FIELD_NOT_OWNED, `write would change non-owned fields: ${notOwned.join(", ")}`, { fields: notOwned, external_id: externalId });
    if (!hasSourceIdentity(before.sources, { resource: provider, id: externalId })) {
      throw new OverlayRefusal(REFUSAL_CODES.OVERLAY_IDENTITY_LOST, "document no longer carries the provider identity", { external_id: externalId });
    }
    for (const [f, from] of Object.entries(expectedFrom)) {
      if (!same(before[f], from)) throw new OverlayRefusal(REFUSAL_CODES.OVERLAY_DOC_CONFLICT, `owned field ${f} changed since planning`, { field: f, external_id: externalId });
    }
  };
}

/** Run every guard in order on the same fresh read; the first refusal wins. Synchronous guards stay synchronous. */
export function composeGuards(...guards: Array<AssertCandidate | undefined>): AssertCandidate {
  const list = guards.filter((guard): guard is AssertCandidate => typeof guard === "function");
  return (existing, candidate) => {
    const run = (from: number): void | Promise<void> => {
      for (let i = from; i < list.length; i++) {
        const outcome = list[i]!(existing, candidate);
        if (outcome && typeof (outcome as Promise<void>).then === "function") return (outcome as Promise<void>).then(() => run(i + 1));
      }
    };
    return run(0);
  };
}

function notOwned(message: string, details: Record<string, unknown> = {}): OverlayRefusal {
  return new OverlayRefusal(REFUSAL_CODES.FIELD_NOT_OWNED, message, details);
}

/**
 * The Signal create guard: a new attention Kind document under its path, fixed keys, state `todo`.
 * Exported for this package's tests only; the subpath entry does not re-export it.
 */
export function signalCreateGuard(attention: AttentionResolution, step: CreateSignalStep, run: { observedAt: string; provider: string }): AssertCandidate {
  return (_existing, candidate) => {
    if (!attention.ok) throw notOwned(`record-overlay creates documents of an attention Kind only: ${attention.reason}`, { external_id: step.external_id });
    const { name, prefix, stateField } = attention.value;
    if (!step.target.startsWith(prefix)) throw notOwned(`create-signal target is outside ${prefix}`, { external_id: step.external_id });
    const fm = candidate.frontmatter as unknown as Record<string, unknown>;
    if (fm.type !== name) throw notOwned(`record-overlay may only create ${name} documents`, { external_id: step.external_id });
    const allowed = new Set(["type", "title", stateField, "change_kind", "observed_at", "provider", "external_id", "diff_summary", "priority", "about_doc", "sources", "content_digest", "expires_at"]);
    const outside = Object.keys(fm).filter((key) => !allowed.has(key));
    if (outside.length) throw notOwned(`create-signal would write fields outside the attention record: ${outside.join(", ")}`, { fields: outside, external_id: step.external_id });
    if (fm[stateField] !== "todo") throw notOwned(`create-signal must create an unclaimed ${name} (${stateField}: todo)`, { field: stateField, external_id: step.external_id });
    if (!Array.isArray(fm.sources) || !fm.sources.every((entry) => record(entry) && typeof entry.resource === "string")) {
      throw notOwned("create-signal sources must be a list of entries naming a resource", { field: "sources", external_id: step.external_id });
    }
    if (fm.provider !== redactUrl(run.provider)) throw notOwned("create-signal must name the run's provider", { field: "provider", external_id: step.external_id });
    if (fm.external_id !== step.external_id) throw notOwned("create-signal must name the step's record", { field: "external_id", external_id: step.external_id });
    if (!plannedSignalBody(candidate.body, run.observedAt)) throw notOwned("create-signal body is not a planned Signal body", { fields: ["(body)"], external_id: step.external_id });
  };
}

const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
/** One observation line of this observation: no line break of any kind, the planner's prefix. */
function observationLineOf(text: string, observedAt: string): boolean {
  return !LINE_BREAK.test(text) && text.startsWith(`- ${observedAt} · `);
}
const PREAMBLE_LINES = [
  /^\[[^\]]+\]\([^)\s]+\)$/,
  /^Overlay document \(content bundle\): `[^`]+`$/,
  /^Related document \(content bundle\): `[^`]+`(?: \(.*\))?$/,
  /^To overlay this record, give a document of Kind "[^"]*" the source entry `resource: [^`]*`, `id: [^`]*`\.$/,
];
/**
 * The planner's Signal body: link and hint lines (at most eight), a `# Observations` heading and
 * exactly one observation line of this observation.
 */
function plannedSignalBody(body: string, observedAt: string): boolean {
  const match = /^([\s\S]*?)# Observations\n\n([^\n]*)\n$/.exec(body);
  if (!match || !observationLineOf(match[2]!, observedAt)) return false;
  const lines = match[1]!.split("\n").filter((text) => text !== "");
  return lines.length <= 8 && lines.every((text) => !LINE_BREAK.test(text) && PREAMBLE_LINES.some((pattern) => pattern.test(text)));
}

const UPDATE_FIELDS = new Set(["change_kind", "priority", "observed_at", "diff_summary", "title", "external_id", "about_doc", "content_digest", "expires_at"]);

/**
 * The Signal update guard: an existing attention Kind document of this plan's provider, fixed keys,
 * and one appended observation line of this observation.
 * Exported for this package's tests only; the subpath entry does not re-export it.
 */
export function signalUpdateGuard(attention: AttentionResolution, step: CollapseSignalStep, observation: { observedAt: string; provider: string }): AssertCandidate {
  return (existing, candidate) => {
    if (!attention.ok) throw notOwned(`record-overlay updates documents of an attention Kind only: ${attention.reason}`, { external_id: step.external_id });
    const { name, prefix } = attention.value;
    if (!existing || existing.frontmatter.type !== name || !step.target.startsWith(prefix)) {
      throw notOwned(`collapse-signal target is not a ${name} under ${prefix}`, { external_id: step.external_id });
    }
    const before = existing.frontmatter as unknown as Record<string, unknown>;
    if (before.provider !== redactUrl(observation.provider)) throw notOwned("collapse-signal target belongs to another provider", { field: "provider", external_id: step.external_id });
    if (!observationLineOf(step.observation_line, observation.observedAt)) {
      throw notOwned("collapse-signal observation line must be one line of this observation", { fields: ["(body)"], external_id: step.external_id });
    }
    const after = candidate.frontmatter as unknown as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !same(before[k], after[k]));
    const outside = changed.filter((k) => !UPDATE_FIELDS.has(k));
    const appended = existing.body.replace(/\n*$/, "\n") + step.observation_line + "\n";
    if (candidate.body !== existing.body && candidate.body !== appended) outside.push("(body)");
    if (outside.length) throw notOwned(`collapse-signal would change fields outside the attention update: ${outside.join(", ")}`, { fields: outside, external_id: step.external_id });
  };
}

/** A FIELD_TYPE_VIOLATION refusal: field, type and code only (the value came from the feed and may carry a token). */
function typeRefusal(kind: string, violations: Array<{ field: unknown; type: unknown; code: string }>): { code: RefusalCode; message: string; details: Record<string, unknown> } {
  return { code: REFUSAL_CODES.FIELD_TYPE_VIOLATION, message: `candidate violates declared field types: ${violations.map((v) => `${v.field} (${v.type})`).join(", ")}`, details: { kind, violations } };
}

type Refusal = { code: RefusalCode; message: string; details?: Record<string, unknown> };

function toRefusal(err: unknown, step: OverlayStep, registries: KindRegistry[]): Refusal {
  if (err instanceof OverlayRefusal) return { code: err.code, message: err.message, details: err.details };
  if (err instanceof KindConformanceError && err.violations.some((v) => CORE_VALUE_CODES.includes(v.code))) {
    // Core refused a value for its declared type or vocabulary: held and value-free, named with
    // whatever else core found by code and field only.
    const kind = registries.map((r) => r?.kinds?.get(err.governs)).find(Boolean);
    const refusal = typeRefusal(err.governs, err.violations.filter((v) => CORE_VALUE_CODES.includes(v.code)).map((v) => ({ field: v.field, type: (v.field !== undefined ? kind?.fields?.types?.[v.field] : undefined) ?? "vocabulary", code: v.code })));
    const also = err.violations.filter((v) => !CORE_VALUE_CODES.includes(v.code)).map((v) => `${v.code}:${v.field ?? ""}`);
    return also.length ? { ...refusal, details: { ...refusal.details, also } } : refusal;
  }
  if (err instanceof VersionConflict) return { code: REFUSAL_CODES.STALE_VERSION, message: "document changed after planning (CAS lost)" };
  if (err instanceof PreconditionFailed) {
    const code = step.op === "collapse-signal" ? REFUSAL_CODES.SIGNAL_CLAIMED : REFUSAL_CODES.STALE_VERSION;
    return { code, message: `precondition on ${err.field} no longer holds`, details: { field: err.field } };
  }
  if (err instanceof KindConformanceError) {
    // Codes and fields only: core's sentences can quote a value that came from the feed.
    const violations = err.violations.map((v) => v.code + ":" + (v.field ?? ""));
    return { code: REFUSAL_CODES.KIND_REJECTED, message: `candidate does not satisfy the ${err.governs} kind: ${violations.join(", ")}`, details: { violations } };
  }
  if (err instanceof DocumentNotFoundError) return { code: REFUSAL_CODES.OVERLAY_IDENTITY_LOST, message: "document not found" };
  if (err instanceof FieldActionError) {
    // A fixed message and the reason and field only: core's sentences and candidates can echo a provider value.
    return { code: REFUSAL_CODES.INVALID_INPUT, message: "core refused the field actions for this step", details: { reason: err.details.reason, field: err.details.field } };
  }
  if (err instanceof InvalidInputError) {
    // A value core's write policy refuses (an OKF v0.2 field type, a hook's list): held and
    // value-free. The actor, editions and targets were checked before the first write.
    return { code: REFUSAL_CODES.INVALID_INPUT, message: "core refused a value in this step", details: { reason: "invalid-value" } };
  }
  throw err;
}

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** JSON data: strings, booleans, null, finite numbers other than -0, lists and plain mappings; `undefined` members only. */
function jsonData(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every((item) => item !== undefined && jsonData(item, depth + 1));
  if (typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]") {
    return Object.entries(value).every(([key, item]) => !PROTOTYPE_KEYS.has(key) && (item === undefined || jsonData(item, depth + 1)));
  }
  return false;
}
const scalar = (value: unknown): boolean => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && jsonData(value));

function malformed(index: number, op: unknown): OverlayRefusal {
  return new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, `plan step ${index} is not a well-formed ${typeof op === "string" ? op : "plan"} step`, { step: index });
}

/** The whole plan is checked before the first write: a malformed plan touches no document. */
function validatePlan(plan: OverlayPlan): void {
  if (!record(plan) || !Array.isArray(plan.steps)) throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, "a plan needs a steps list");
  plan.steps.forEach((step: unknown, index) => {
    if (!record(step) || typeof step.op !== "string" || !STEP_OPS.has(step.op)) {
      throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, `unknown plan step ${record(step) ? String(step.op) : typeof step}`, { step: index });
    }
    const str = (key: string): boolean => typeof step[key] === "string" && step[key] !== "";
    const target = (): boolean => {
      if (!str("target")) return false;
      try { assertSafeConceptId(step.target as string); return true; } catch { return false; }
    };
    if (step.op === "apply-owned-fields") {
      const fields = step.fields;
      if (!target() || !str("expected_version") || typeof step.external_id !== "string" || !record(fields) || Object.keys(fields).length === 0
        || !Object.entries(fields).every(([key, v]) => !PROTOTYPE_KEYS.has(key) && record(v) && (v.to === undefined || jsonData(v.to)))) throw malformed(index, step.op);
      if (step.sources !== undefined && (!record(step.sources) || Object.entries(step.sources).some(([key, value]) =>
        key === "resource" || key === "id" || PROTOTYPE_KEYS.has(key) || !scalar(value)))) throw malformed(index, step.op);
    } else if (step.op === "create-signal") {
      const candidate = step.candidate;
      if (!target() || !record(candidate) || !record(candidate.frontmatter) || typeof candidate.body !== "string" || !jsonData(candidate.frontmatter)) throw malformed(index, step.op);
    } else if (step.op === "collapse-signal") {
      if (!target() || !str("expected_version") || typeof step.observation_line !== "string" || !record(step.set) || !jsonData(step.set)) throw malformed(index, step.op);
    } else if (step.op === "signal-duplicate") {
      if (!target()) throw malformed(index, step.op);
    }
  });
}

async function editionOf(bundle: ApplyContext["content"]["bundle"]): Promise<"0.1" | "0.2"> {
  const edition = await readBundleOkfVersion(bundle) ?? "0.1";
  if (edition !== "0.1" && edition !== "0.2") {
    throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, `record-overlay writes OKF 0.1 and 0.2 bundles, not ${edition}`);
  }
  return edition;
}

export async function applyRecordOverlay(plan: OverlayPlan, ctx: ApplyContext): Promise<OverlayReceipt> {
  const { content, ops, policy, actor, overlays, hooks = {} } = ctx;
  if (!isOkfActor(actor)) throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, "record-overlay writes need an OKF actor (human:<id>, process:<id> or producer/version)");
  validatePlan(plan);
  const contentEdition = await editionOf(content.bundle);
  const opsEdition = ops.bundle === content.bundle ? contentEdition : await editionOf(ops.bundle);
  const derive = hooks.deriveFields;
  // Owned and derived fields matter only to owned-field steps; a plan of Signal steps alone (a
  // presentation feed, a findings run) is not refused for a policy that owns record fields.
  if (plan.steps.some((step) => step.op === "apply-owned-fields")) {
    if (!Array.isArray(policy.owned_fields)) throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, "owned_fields must be a list of field names", { list: "owned_fields" });
    if (derive !== undefined && (!Array.isArray(derive.fields) || typeof derive.derive !== "function")) {
      throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, "deriveFields needs a fields list and a derive function", { list: "deriveFields.fields" });
    }
    const targetKind = policy.target_kind === undefined ? undefined : content.registry.kinds.get(policy.target_kind);
    assertAdmissibleFields(policy.owned_fields, derive?.fields ?? [], workStateFields(targetKind, [contentEdition]));
    if (typeof policy.provider !== "string" || policy.provider === "") throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, "owned-field steps need the policy's provider identity");
    if (targetKind === undefined) throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, "owned-field steps need a target Kind declared in the content bundle");
    if (policy.target_kind === (ctx.signals?.kind ?? "Signal")) throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, "the target Kind cannot be the attention Kind");
  }
  const signalSteps = plan.steps.some((step) => step.op === "create-signal" || step.op === "collapse-signal");
  // Signal writes are bound to the provider the caller runs for, never to a field of the plan.
  if (signalSteps && (typeof policy.provider !== "string" || policy.provider === "")) {
    throw new OverlayRefusal(REFUSAL_CODES.POLICY_INVALID, "Signal steps need the run's provider identity");
  }
  const run = { observedAt: plan.observed_at, provider: policy.provider };
  const attention: AttentionResolution = signalSteps
    ? resolveAttentionKind(ops.registry, opsEdition, ctx.signals?.kind ?? "Signal", policy.target_kind)
    : { ok: false, reason: "no Signal steps" };

  const common = { strict: true, actor, producer: actor, persistActor: true } as const;
  const siteHook = (step: OverlayStep, bundle: "content" | "ops"): AssertCandidate | undefined => {
    const hook = hooks.assertCandidate;
    return hook ? (existing, candidate) => hook(existing, candidate, { step: step.op, bundle }) : undefined;
  };

  const applyOwnedFields = async (step: ApplyOwnedFieldsStep): Promise<DocumentMutationResult> => {
    const derivedFields = derive?.fields ?? [];
    const admitted = new Set([...policy.owned_fields, ...derivedFields]);
    const expectedFrom = Object.fromEntries(Object.entries(step.fields).map(([f, v]) => [f, v.from]));
    const base = {
      ...common, bundle: content.bundle, registry: content.registry, id: step.target, mode: "patch" as const, onAbsent: "fail" as const,
      expectedVersion: step.expected_version,
      assertCandidate: composeGuards(
        ownershipGuard({ ownedFields: policy.owned_fields, provider: policy.provider, externalId: step.external_id, expectedFrom, derivedFields, sourceProperties: step.sources, targetKind: policy.target_kind }),
        siteHook(step, "content"),
      ),
    };
    // The subpath's own refusals for what core's patch would throw on: a changed field whose old or
    // new value holds a list. Owned, that is INVALID_INPUT (held); not owned, FIELD_NOT_OWNED.
    const assertNoListAssignment = (existing: OkfDocument, fields: Iterable<[string, unknown]>): void => {
      const fm = existing.frontmatter as unknown as Record<string, unknown>;
      for (const [f, to] of fields) {
        if (okfValuesEqual(fm[f], to) || !(containsCollection(fm[f]) || containsCollection(to))) continue;
        if (!admitted.has(f)) throw new OverlayRefusal(REFUSAL_CODES.FIELD_NOT_OWNED, `write would change non-owned fields: ${f}`, { fields: [f], external_id: step.external_id });
        throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, "an owned field holding a list cannot be written as a field value", { reason: "list-valued-field", field: f });
      }
    };
    const entries = (): Array<[string, unknown]> => Object.entries(step.fields).map(([f, v]) => [f, v.to]);

    if (step.sources !== undefined) {
      if (contentEdition !== "0.2") {
        throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, "the grouped sources write needs an OKF v0.2 bundle", { reason: "grouped-shape-needs-v0.2", field: "sources" });
      }
      const removed = Object.entries(step.fields).find(([, v]) => v.to === undefined);
      if (removed) throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, "the grouped sources write cannot remove a field", { reason: "grouped-shape-removes-field", field: removed[0] });
      const properties = step.sources;
      return mutateDocument({
        ...base,
        input: (existing): DocumentMutationInput => {
          // Core's field actions throw on metadata before any guard runs; refuse what the guard would.
          const outside = Object.keys(step.fields).filter((f) => !admitted.has(f));
          if (outside.length) throw new OverlayRefusal(REFUSAL_CODES.FIELD_NOT_OWNED, `write would change non-owned fields: ${outside.join(", ")}`, { fields: outside, external_id: step.external_id });
          assertNoListAssignment(existing, entries());
          const entry = Array.isArray(existing.frontmatter.sources)
            ? (existing.frontmatter.sources as unknown[]).filter((row) => matchesSourceIdentity(row, { resource: policy.provider, id: step.external_id }))
            : [];
          if (entry.length === 1) {
            for (const key of Object.keys(properties)) {
              if (containsCollection((entry[0] as Record<string, unknown>)[key])) {
                throw new OverlayRefusal(REFUSAL_CODES.INVALID_INPUT, "a source property holding a list cannot be written as a field value", { reason: "list-valued-source-property", field: "sources" });
              }
            }
          }
          const actions: FieldAction[] = entries().map(([field, value]) => ({ action: "set", field, value }));
          actions.push({ action: "upsert", field: "sources", value: { ...properties, resource: policy.provider, id: step.external_id } });
          if (derive) {
            let preview: OkfDocument = existing;
            for (const action of actions) {
              preview = { id: existing.id, ...prepareDocumentFieldAction(preview, action, { registry: content.registry, okfVersion: contentEdition }).candidate };
            }
            const derived = derive.derive(structuredClone(existing), { frontmatter: preview.frontmatter, body: preview.body });
            for (const [field, value] of Object.entries(derived ?? {})) actions.push({ action: "set", field, value });
          }
          return { kind: "field-actions", actions };
        },
      });
    }
    return mutateDocument({
      ...base,
      buildCandidate: (existing): DocumentMutationCandidate => {
        if (!existing) throw new DocumentNotFoundError(step.target);
        assertNoListAssignment(existing, entries());
        const fm = { ...existing.frontmatter } as Record<string, unknown>;
        for (const [f, { to }] of Object.entries(step.fields)) { if (to === undefined) delete fm[f]; else fm[f] = to; }
        let next: DocumentMutationCandidate = { frontmatter: fm as unknown as OkfDocument["frontmatter"], body: existing.body };
        if (derive) {
          const derived = derive.derive(structuredClone(existing), structuredClone(next));
          if (derived && Object.keys(derived).length) next = { frontmatter: { ...next.frontmatter, ...derived }, body: next.body };
        }
        return next;
      },
    });
  };

  const results: StepResult[] = [];
  for (const step of plan.steps) {
    if (step.op === "record-only" || step.op === "signal-duplicate") {
      // A quiet step's reason (a disappearance after the record's last known end) is kept for the receipt reader.
      results.push({ op: step.op, target: step.target ?? null, external_id: step.external_id, outcome: "skipped", ...("reason" in step && step.reason ? { reason: step.reason } : {}), ...("last_known_end" in step && step.last_known_end ? { last_known_end: step.last_known_end } : {}) });
      continue;
    }
    try {
      let r: DocumentMutationResult;
      if (step.op === "apply-owned-fields") {
        r = await applyOwnedFields(step);
        if (r.changed) overlays?.replace(r.doc, r.version);
      } else if (step.op === "create-signal") {
        r = await mutateDocument({
          ...common, bundle: ops.bundle, registry: ops.registry, id: step.target, mode: "patch", onAbsent: "create",
          // A create never overwrites. An existing Signal of this provider is the type precondition
          // the reference reports (retryable); another provider's Signal holding the id, or any
          // other document there, is refused outright.
          buildCandidate: (existing) => {
            if (existing) {
              const fm = existing.frontmatter as unknown as Record<string, unknown>;
              if (fm.type === undefined) throw notOwned("create-signal target already exists", { external_id: step.external_id });
              if (attention.ok && fm.type === attention.value.name && fm.provider !== redactUrl(run.provider)) {
                throw notOwned("create-signal target holds another provider's Signal", { field: "provider", external_id: step.external_id });
              }
              throw new OverlayRefusal(REFUSAL_CODES.STALE_VERSION, "precondition on type no longer holds", { field: "type" });
            }
            return structuredClone(step.candidate);
          },
          assertCandidate: composeGuards(signalCreateGuard(attention, step, run), siteHook(step, "ops")),
        });
      } else {
        const claim = attention.ok ? attention.value : undefined;
        r = await mutateDocument({
          ...common, bundle: ops.bundle, registry: ops.registry, id: step.target, mode: "patch", onAbsent: "fail",
          expectedVersion: step.expected_version,
          ...(claim ? { preconditions: [{ field: claim.stateField, expect: { equals: "todo" } }, { field: claim.ownerField, expect: "absent" as const }] } : {}),
          buildCandidate: (existing) => {
            const fm = existing!.frontmatter as unknown as Record<string, unknown>;
            // Core's patch refuses a list change before any guard runs; no attention update field holds one.
            const listed = Object.keys(step.set).filter((k) => !okfValuesEqual(fm[k], step.set[k]) && (containsCollection(fm[k]) || containsCollection(step.set[k])));
            if (listed.length) throw notOwned(`collapse-signal would change fields outside the attention update: ${listed.join(", ")}`, { fields: listed, external_id: step.external_id });
            return {
              frontmatter: { ...existing!.frontmatter, ...step.set },
              body: existing!.body.includes(step.observation_line) ? existing!.body : existing!.body.replace(/\n*$/, "\n") + step.observation_line + "\n",
            };
          },
          assertCandidate: composeGuards(signalUpdateGuard(attention, step, run), siteHook(step, "ops")),
        });
      }
      results.push({ op: step.op, target: step.target, external_id: step.external_id, outcome: r.changed ? "applied" : "unchanged", version: r.version });
    } catch (err) {
      results.push({ op: step.op, target: step.target, external_id: step.external_id, outcome: "refused", ...toRefusal(err, step, [content.registry, ops.registry]) });
    }
  }
  return {
    feed: plan.feed, provider: plan.provider, observed_at: plan.observed_at, results, refusals: plan.refusals ?? [],
    // Records the caller could not turn into records are part of the run's outcome, not just of the plan.
    diagnostics: plan.diagnostics ?? [],
  };
}
