import { InvalidInputError } from "./errors.js";
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";
import type { OkfDocument } from "./types.js";
// Storage-neutral Kind inference and guarded authoring. Pure derivations consume already-read
// documents; the public operations below acquire state and share mutation specifications with
// presentation adapters. Host-specific prose, command formatting and receipts stay with callers.
//
// The one invariant this module exists to protect: an INFERRED draft applies with zero new
// conformance warnings ("zero-debt by construction"). That holds only because the inference
// predicates below are pinned to core's OWN validation predicates — presence is core's
// `isPresent` (never bare key existence: a `title: ""` on one instance must not become a
// required field), and enum proposal is scalar-string-only (an array-valued key would fire
// KIND_FIELD_ARITY on every instance). The apply-then-validate property test in
// kind-draft.test.ts pins this predicate equality; drift there fails the suite loudly.
import { sha256HexOfUtf8 } from "./sha256.js";
import {
  isPresent,
  RESERVED_KIND_FIELD_NAMES,
  SUPERBEE_PROGRESS_STATUS_FIELD,
  splitSections,
  validateAgainstKind,
  type KindConvention,
  type KindFields,
} from "./kinds.js";

/** Enum inference gates: 100% presence, at least this many instances, 2-6 distinct scalar strings. */
export const ENUM_MIN_INSTANCES = 10;
export const ENUM_MIN_DISTINCT = 2;
export const ENUM_MAX_DISTINCT = 6;
/**
 * Floor for a sub-100% H1 heading to appear as a PRICED promotion (mirrors the 60% descriptive
 * threshold the modeling signal's status block uses). Headings below it are noise, not candidates.
 */
export const SECTION_PROMOTION_FLOOR = 0.6;

/** Inference omits ownership metadata and receipts, without changing field-action policy. */
const EXCLUDED_FIELDS = new Set<string>([...RESERVED_KIND_FIELD_NAMES, "head_version"]);
function excludedInferenceField(field: string): boolean {
  return EXCLUDED_FIELDS.has(field) || isManagedDocumentMetadataField(field) ||
    (field.startsWith("superbee_") && field !== SUPERBEE_PROGRESS_STATUS_FIELD);
}

/**
 * The keys of a `KindConvention` that carry NO declaration: the record's own identity, its display
 * title, and human prose. `description` is deliberately here — a dismissal record carries one
 * naming the decline, so counting it would make every dismissal look declaration-bearing and break
 * `kind dismiss`'s idempotency.
 */
type NonDeclaringKey = "id" | "title" | "governs" | "description";

/** Every remaining key, each answering: does this convention declare anything through it? */
type DeclarationKey = Exclude<keyof KindConvention, NonDeclaringKey>;

/**
 * One predicate per declaring key. The `Record<DeclarationKey, ...>` type is the point: adding a
 * key to `KindConvention` in core makes this object structurally incomplete and FAILS THE BUILD
 * until the new key is classified. This predicate was previously a hand-written chain of `||`,
 * and an enumeration maintained by hand goes stale silently — it omitted `path`, and then
 * `browseCollapsed`, each found only by someone probing for it. A missing entry here is not a
 * cosmetic gap: it makes a real convention read as a dismissal record, so a draft will overwrite
 * the declaration it could not see.
 */
/**
 * The same exhaustiveness, one level down. `fields` is a structured sub-object, and the first
 * version of this classifier enumerated four of its six keys by hand — missing `descriptions`
 * and `valueDescriptions`, so a convention carrying only field guidance read as declaration-free
 * and could be drafted over. Every key of `KindFields` declares something (a dismissal record has
 * an EMPTY fields block, not a partially-filled one), so nothing is excluded here; adding a key to
 * `KindFields` in core fails the build until it is classified.
 */
const FIELDS_DECLARES: Record<keyof KindFields, (fields: KindFields) => boolean> = {
  required: (f) => f.required.length > 0,
  optional: (f) => f.optional.length > 0,
  values: (f) => Object.keys(f.values).length > 0,
  valueDescriptions: (f) => f.valueDescriptions !== undefined && Object.keys(f.valueDescriptions).length > 0,
  terminal: (f) => Object.keys(f.terminal).length > 0,
  descriptions: (f) => Object.keys(f.descriptions).length > 0,
  types: (f) => f.types !== undefined && Object.keys(f.types).length > 0,
};

const DECLARES: Record<DeclarationKey, (kind: KindConvention) => boolean> = {
  deprecated: kind => Boolean(kind.deprecated && (kind.deprecated.fields.length || Object.keys(kind.deprecated.values).length || kind.deprecated.links.length || kind.deprecated.problems?.length)),
  path: (kind) => kind.path !== undefined && kind.path !== "",
  fields: (kind) => Object.values(FIELDS_DECLARES).some((declares) => declares(kind.fields)),
  links: (kind) => kind.links !== undefined && Object.keys(kind.links).length > 0,
  linkDescriptions: (kind) =>
    kind.linkDescriptions !== undefined && Object.keys(kind.linkDescriptions).length > 0,
  expectsInbound: (kind) =>
    kind.expectsInbound !== undefined && Object.keys(kind.expectsInbound).length > 0,
  sections: (kind) => kind.sections !== undefined && kind.sections.length > 0,
  freshnessHorizon: (kind) => kind.freshnessHorizon !== undefined,
  // Core parses only a strict `true` here; a declared `false` never reaches this predicate, so the
  // `!== undefined` form is the whole check rather than a distinction between true and false.
  browseCollapsed: (kind) => kind.browseCollapsed !== undefined,
  // A reading-order placement is authored on purpose; a draft must never overwrite it.
  order: (kind) => kind.order !== undefined,
  claim: (kind) => kind.claim !== undefined,
};

/**
 * Whether `kind` declares ANY schema obligation or behavior. The ONE predicate shared by
 * `kind draft`'s refusal (a declaration-bearing kind is never silently redrafted), `kind
 * dismiss`'s idempotency check, and `new`'s registry-lookup guard (a declaration-free kind — a
 * dismissal record — must leave `new`'s command surface exactly as it was before the dismissal).
 */
export function kindDeclaresAnything(kind: KindConvention): boolean {
  return Object.values(DECLARES).some((declares) => declares(kind));
}

/** `"Context Note"` -> `"context-note"` — the same slug shape the builtin conventions use. */
export function conventionSlugForType(type: string): string {
  const slug = type
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug === "" ? "kind" : slug;
}

/** Per-key/per-heading presence over one type's instances — the stats the token binds. */
export interface DraftInstanceStats {
  count: number;
  /** key -> number of instances where the value passes core's `isPresent`. Sorted by key. */
  keyPresence: Record<string, number>;
  /** H1 heading -> number of instances whose body carries it. Sorted by heading. */
  headingPresence: Record<string, number>;
}

function sortedRecord(entries: Iterable<[string, number]>): Record<string, number> {
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

/** Fold `instances` into the presence stats. Presence is core's `isPresent`, never key existence. */
export function collectInstanceStats(instances: readonly OkfDocument[]): DraftInstanceStats {
  const keys = new Map<string, number>();
  const headings = new Map<string, number>();
  for (const doc of instances) {
    for (const [key, value] of Object.entries(doc.frontmatter)) {
      if (!isPresent(value)) continue;
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    for (const heading of Object.keys(splitSections(doc.body))) {
      headings.set(heading, (headings.get(heading) ?? 0) + 1);
    }
  }
  return {
    count: instances.length,
    keyPresence: sortedRecord(keys),
    headingPresence: sortedRecord(headings),
  };
}

/** True when every observed value for `key` across `instances` is a scalar string. */
function everyValueScalarString(instances: readonly OkfDocument[], key: string): boolean {
  for (const doc of instances) {
    const value = (doc.frontmatter as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return false;
  }
  return true;
}

/** Distinct observed (string) values for `key`, in first-seen order. */
function distinctValues(instances: readonly OkfDocument[], key: string): string[] {
  const seen = new Set<string>();
  for (const doc of instances) {
    const value = (doc.frontmatter as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") seen.add(value);
  }
  return [...seen];
}

/**
 * Infer the candidate convention for `type` from its instances:
 * - required  = keys `isPresent` on 100% of instances (minus reserved + attribution)
 * - optional  = every other key `isPresent` on >=1 instance
 * - values    = only at 100% presence, >= {@link ENUM_MIN_INSTANCES} instances, 2-6 distinct
 *               values, every observed value a scalar string
 * - sections  = H1 headings on 100% of instances (H1-only: core's ONE heading splitter)
 * - path      = the common leading id segment, only when ALL instances share exactly one — a
 *               split (`plans/` + `designs/`) is the finding; silently blessing one prefix
 *               would orphan the rest, so no `path` is proposed there
 */
export function inferKindCandidate(
  type: string,
  instances: readonly OkfDocument[],
  stats: DraftInstanceStats = collectInstanceStats(instances),
  description = `Drafted from ${stats.count} existing instances.`,
): KindConvention {
  const count = stats.count;
  const required: string[] = [];
  const optional: string[] = [];
  const values: Record<string, string[]> = {};
  for (const [key, present] of Object.entries(stats.keyPresence)) {
    if (excludedInferenceField(key)) continue;
    if (present === count && count > 0) {
      required.push(key);
      if (count >= ENUM_MIN_INSTANCES && everyValueScalarString(instances, key)) {
        const distinct = distinctValues(instances, key);
        if (distinct.length >= ENUM_MIN_DISTINCT && distinct.length <= ENUM_MAX_DISTINCT) {
          values[key] = distinct.sort((a, b) => a.localeCompare(b));
        }
      }
    } else {
      optional.push(key);
    }
  }
  const sections = Object.entries(stats.headingPresence)
    .filter(([, present]) => present === count && count > 0)
    .map(([heading]) => heading);

  const prefixes = new Set<string>();
  let allPrefixed = instances.length > 0;
  for (const doc of instances) {
    const slash = doc.id.indexOf("/");
    if (slash <= 0) {
      allPrefixed = false;
      break;
    }
    prefixes.add(doc.id.slice(0, slash));
  }
  const path = allPrefixed && prefixes.size === 1 ? `${[...prefixes][0]!}/` : undefined;

  return {
    id: `conventions/${conventionSlugForType(type)}`,
    title: type,
    governs: type,
    description,
    ...(path === undefined ? {} : { path }),
    fields: { required, optional, values, terminal: {}, descriptions: {} },
    ...(sections.length > 0 ? { sections } : {}),
  };
}

/** One priced promotion row: a declaration the human MAY add, with its measured cost. */
export interface DraftPromotion {
  declaration: string;
  present: string;
  warnings_if_added: number;
}

/**
 * Price the candidate promotions: every sub-100% optional field, plus every H1 heading at or
 * above {@link SECTION_PROMOTION_FLOOR} but below 100%. `warnings_if_added` is exactly the
 * instances the added declaration would newly warn on.
 */
export function draftPromotions(kind: KindConvention, stats: DraftInstanceStats): DraftPromotion[] {
  const rows: DraftPromotion[] = [];
  for (const key of kind.fields.optional) {
    const present = stats.keyPresence[key] ?? 0;
    rows.push({
      declaration: `field ${key} (optional -> required)`,
      present: `${present}/${stats.count}`,
      warnings_if_added: stats.count - present,
    });
  }
  for (const [heading, present] of Object.entries(stats.headingPresence)) {
    if (present === stats.count) continue; // already in the draft
    if (present / stats.count < SECTION_PROMOTION_FLOOR) continue;
    rows.push({
      declaration: `section "# ${heading}"`,
      present: `${present}/${stats.count}`,
      warnings_if_added: stats.count - present,
    });
  }
  rows.sort((a, b) => a.warnings_if_added - b.warnings_if_added || a.declaration.localeCompare(b.declaration));
  return rows;
}

/**
 * The MEASURED post-apply warning count: run core's validator over every instance against the
 * candidate and sum the violations. Zero by construction for an inferred candidate (see module
 * comment); the true — possibly large — number for an adopted catalog candidate. Never assumed.
 */
export function warningsAfterApply(kind: KindConvention, instances: readonly OkfDocument[]): number {
  let total = 0;
  for (const doc of instances) total += validateAgainstKind(doc, kind).length;
  return total;
}

/**
 * The state-bound plan token `--apply` must present: sha256 of the canonical JSON of everything
 * the human inspected — the exact candidate document, the bundle edition, and the instance stats
 * it was inferred from. Any change to WHAT THE TOKEN BINDS between draft and apply refuses:
 * a presence-stat change (new/removed instances, a key appearing or emptying), an edition
 * change, or a candidate difference. It ALSO binds the measured warning count, because that count
 * is what the human accepted: an instance edit that changes the forecast (a value leaving a
 * declared enum) must not apply under a token issued against a different number. An edit changing
 * neither the candidate, the presence stats, nor the warning count keeps the token valid — the
 * written bytes are identical either way.
 */
export function draftPlanToken(input: {
  target: string;
  candidate: { id: string; frontmatter: unknown; body: string };
  okfVersion: string;
  stats: DraftInstanceStats;
  warnings: number;
}): string {
  return `sha256:${sha256HexOfUtf8(JSON.stringify(input))}`;
}

import { CONVENTION_TYPE, parseConventionDoc } from "./kinds.js";
import { loadKinds } from "./kinds-load.js";
import { query, readBundleOkfVersion } from "./bundle-ops.js";
import { builtinNames, resolveBuiltinSync } from "./builtin-recipes.js";
import { materializeRecipeForEdition } from "./recipe-lifecycle/install.js";
import { droppedLinks } from "./body-replace-guards.js";
import { mutateDocument, type MutateDocumentOptions, type DocumentMutationResult } from "./document-mutation.js";
import type { Bundle, Frontmatter, Link } from "./types.js";
import type { KindRegistry } from "./kinds.js";

export type KindAuthoringFailure = "already-governed" | "no-instances" | "plan-changed" | "edition-changed" | "redraft-changed" | "dismiss-governed";
/** Adapters render recovery commands from these typed facts, never from parsed prose. */
export class KindAuthoringError extends Error {
  readonly reason: KindAuthoringFailure;
  readonly type: string;
  readonly details: { id?: string; expected?: string; current?: string };
  constructor(reason: KindAuthoringFailure, type: string, details: KindAuthoringError["details"] = {}) {
    super(`Kind authoring for '${type}' refused: ${reason}.`);
    this.name = "KindAuthoringError";
    this.reason = reason; this.type = type; this.details = details;
  }
}
export interface KindAuthoringText {
  /** Optional explanatory prose; supplied by the presentation and bound into the plan token. */
  inferredBody?: (type: string, count: number) => string;
  inferredDescription?: (type: string, count: number) => string;
}
export interface CatalogConvention {
  recipeId: string;
  doc: OkfDocument;
  kind: KindConvention;
  siblings: string[];
}

/** The builtin convention governing `type`, materialized for this bundle's edition, if any. */
function catalogConventionForType(type: string, okfVersion: string): CatalogConvention | undefined {
  for (const name of builtinNames()) {
    const recipe = resolveBuiltinSync(name);
    if (!recipe.governs.includes(type)) continue;
    const materialized = materializeRecipeForEdition(recipe, okfVersion);
    const doc = materialized.docs.find((d) => {
      const governs = d.frontmatter.governs;
      return typeof governs === "string" && governs.trim() === type;
    });
    if (!doc) continue;
    const parsed = parseConventionDoc(doc);
    if (!parsed.ok) continue;
    return {
      recipeId: recipe.id,
      doc,
      kind: parsed.kind,
      siblings: recipe.governs.filter((governs) => governs !== type),
    };
  }
  return undefined;
}

export interface KindDraftPlan {
  type: string;
  okfVersion: string;
  registry: KindRegistry;
  /** The declaration-free convention this draft would upgrade in place (redraft), if any. */
  redraftOver: KindConvention | undefined;
  candidateDoc: { id: string; frontmatter: Frontmatter; body: string };
  candidateKind: KindConvention;
  catalog: CatalogConvention | undefined;
  stats: DraftInstanceStats;
  instances: OkfDocument[];
  warnings: number;
  token: string;
}

/** Candidate frontmatter WITHOUT a timestamp — the engine stamps one at write time. */
function candidateDocFor(kind: KindConvention, body: string): KindDraftPlan["candidateDoc"] {
  const fields: Record<string, unknown> = {};
  if (kind.fields.required.length > 0) fields.required = kind.fields.required;
  if (kind.fields.optional.length > 0) fields.optional = kind.fields.optional;
  if (Object.keys(kind.fields.values).length > 0) fields.values = kind.fields.values;
  const frontmatter: Frontmatter = {
    type: CONVENTION_TYPE,
    title: kind.title,
    governs: kind.governs,
  };
  if (kind.description !== undefined) frontmatter.description = kind.description;
  if (kind.path !== undefined) frontmatter.path = kind.path;
  if (Object.keys(fields).length > 0) frontmatter.fields = fields;
  if (kind.sections !== undefined && kind.sections.length > 0) frontmatter.sections = kind.sections;
  return { id: kind.id, frontmatter, body };
}

/** Match convention parsing: type names are trimmed strings with nonempty content. */
function normalizeKindAuthoringType(type: unknown): string {
  const normalized = typeof type === "string" ? type.trim() : "";
  if (!isPresent(normalized)) throw new InvalidInputError("Kind authoring requires a nonempty type name.");
  return normalized;
}

/** Build the whole read-only plan: registry + instances -> candidate + forecast + token. */
export async function prepareKindDraft(bundle: Bundle, type: string, text: KindAuthoringText = {}): Promise<KindDraftPlan> {
  type = normalizeKindAuthoringType(type);
  const [registry, okfVersionRead] = await Promise.all([loadKinds(bundle), readBundleOkfVersion(bundle)]);
  const okfVersion = okfVersionRead ?? "0.1";
  const existing = registry.kinds.get(type);
  if (existing && kindDeclaresAnything(existing)) {
    throw new KindAuthoringError("already-governed", type, { id: existing.id });
  }
  const instances = (await query(bundle, { type })).sort((a, b) => a.id.localeCompare(b.id));
  if (instances.length === 0) {
    throw new KindAuthoringError("no-instances", type);
  }
  const stats = collectInstanceStats(instances);
  const catalog = catalogConventionForType(type, okfVersion);
  let candidateKind: KindConvention;
  let candidateDoc: KindDraftPlan["candidateDoc"];
  if (catalog) {
    // Adopt the builtin definition VERBATIM — the recipe's schema is better than an inference,
    // and landing it at its canonical id keeps the recipes surface consistent. The forecast
    // below then reports the REAL (possibly large) warning count against existing instances —
    // the priced route `recipe add` cannot offer when instances already exist.
    candidateKind = catalog.kind;
    const { timestamp: _timestamp, ...frontmatter } = catalog.doc.frontmatter;
    candidateDoc = { id: catalog.doc.id, frontmatter, body: catalog.doc.body };
  } else {
    candidateKind = inferKindCandidate(type, instances, stats, text.inferredDescription?.(type, stats.count));
    candidateDoc = candidateDocFor(candidateKind, text.inferredBody?.(type, stats.count) ?? `Drafted from ${stats.count} existing '${type}' instances.\n`);
  }
  // A redraft upgrades the EXISTING governing record in place, wherever it lives — a
  // hand-authored governs-only convention at a non-canonical id keeps its id (never two
  // conventions for one kind; the slug id is only for true creates).
  if (existing) candidateDoc = { ...candidateDoc, id: existing.id };
  const warnings = warningsAfterApply(candidateKind, instances);
  const token = draftPlanToken({ target: candidateDoc.id, candidate: candidateDoc, okfVersion, stats, warnings });
  return {
    type,
    okfVersion,
    registry,
    redraftOver: existing,
    candidateDoc,
    candidateKind,
    catalog,
    stats,
    instances,
    warnings,
    token,
  };
}


export interface KindAuthoringWriteOptions { actor?: string; now?: () => string }
export interface PreparedKindDraftMutation {
  options: MutateDocumentOptions;
  /** Updated from the deciding fresh read, including after a CAS retry. */
  droppedLinks: Link[];
}
/** The one guarded mutation specification used by public apply and presentation adapters. */
export function prepareKindDraftMutation(bundle: Bundle, plan: KindDraftPlan, expectedToken: string, options: KindAuthoringWriteOptions = {}): PreparedKindDraftMutation {
  const expected = expectedToken.trim();
  if (plan.token !== expected) throw new KindAuthoringError("plan-changed", plan.type, { expected, current: plan.token });
  const prepared: PreparedKindDraftMutation = {
    droppedLinks: [],
    options: {
      seedGenerationClock: false, bundle, id: plan.candidateDoc.id,
      mode: plan.redraftOver ? "replace-document" : "create-only",
      registry: plan.registry, strict: false, actor: options.actor, now: options.now,
      // An accepted redraft replaces the decline prose; report any removed links explicitly.
      bodyReplace: { replaceLinks: true },
      buildCandidate: (existing, context) => {
        if (context.okfVersion !== plan.okfVersion) throw new KindAuthoringError("edition-changed", plan.type);
        if (plan.redraftOver) {
          const parsed = existing && parseConventionDoc(existing);
          if (!parsed || !parsed.ok || parsed.kind.governs !== plan.type || kindDeclaresAnything(parsed.kind)) {
            throw new KindAuthoringError("redraft-changed", plan.type, { id: plan.redraftOver.id });
          }
        }
        prepared.droppedLinks = existing ? droppedLinks(bundle, existing, plan.candidateDoc.body) : [];
        return { frontmatter: structuredClone(plan.candidateDoc.frontmatter), body: plan.candidateDoc.body };
      },
    },
  };
  return prepared;
}

export async function appliedKindDraftWarnings(bundle: Bundle, plan: KindDraftPlan): Promise<number> {
  const applied = (await loadKinds(bundle)).kinds.get(plan.type);
  return applied ? warningsAfterApply(applied, plan.instances) : plan.warnings;
}
/** Recompute what was inspected before applying; callers never reproduce the stale-plan checks. */
export async function applyKindDraft(bundle: Bundle, type: string, expectedToken: string, options: KindAuthoringWriteOptions & KindAuthoringText = {}): Promise<DocumentMutationResult & { droppedLinks: Link[]; warningsAfterApply: number }> {
  const plan = await prepareKindDraft(bundle, type, options);
  const prepared = prepareKindDraftMutation(bundle, plan, expectedToken, options);
  const result = await mutateDocument(prepared.options);
  return { ...result, droppedLinks: prepared.droppedLinks, warningsAfterApply: await appliedKindDraftWarnings(bundle, plan) };
}

export interface PreparedKindDismissal {
  id: string;
  catalog?: CatalogConvention;
  /** Absent for an existing declaration-free record: dismiss is an idempotent no-op. */
  options?: MutateDocumentOptions;
}
export interface KindDismissalOptions extends KindAuthoringWriteOptions {
  /** Presentation-owned explanatory prose; cannot supply declarations or alter the governed type. */
  body?: (type: string, catalog: CatalogConvention | undefined) => string;
  description?: string;
}
export async function prepareKindDismissal(bundle: Bundle, type: string, options: KindDismissalOptions = {}): Promise<PreparedKindDismissal> {
  type = normalizeKindAuthoringType(type);
  const [registry, edition] = await Promise.all([loadKinds(bundle), readBundleOkfVersion(bundle)]);
  const existing = registry.kinds.get(type);
  if (existing && kindDeclaresAnything(existing)) throw new KindAuthoringError("dismiss-governed", type, { id: existing.id });
  if (existing) return { id: existing.id };
  const id = `conventions/${conventionSlugForType(type)}`;
  const catalog = catalogConventionForType(type, edition ?? "0.1");
  return {
    id, catalog,
    options: {
      seedGenerationClock: false, bundle, id, mode: "create-only", registry, strict: false,
      actor: options.actor, now: options.now,
      buildCandidate: () => ({
        frontmatter: { type: CONVENTION_TYPE, title: type, governs: type,
          description: options.description ?? `Declined: '${type}' is deliberately unconstrained.` },
        body: options.body?.(type, catalog) ?? `A Kind for '${type}' was deliberately declined.\n`,
      }),
    },
  };
}
export async function dismissKind(bundle: Bundle, type: string, options: KindDismissalOptions = {}): Promise<{ id: string; changed: boolean; result?: DocumentMutationResult; catalog?: CatalogConvention }> {
  const prepared = await prepareKindDismissal(bundle, type, options);
  if (!prepared.options) return { id: prepared.id, changed: false };
  const result = await mutateDocument(prepared.options);
  return { id: prepared.id, changed: result.changed, result, catalog: prepared.catalog };
}

/** Typed values are already authored by the caller; existing core validation owns their meaning.
 * Undefined body scaffolds headings, while an explicit empty body remains deliberately empty. */
export function kindInstanceCandidate(kind: KindConvention, fields: Record<string, unknown>, body?: string): { frontmatter: Frontmatter; body: string } {
  const frontmatter: Frontmatter = { type: kind.governs };
  for (const [field, value] of Object.entries(fields)) {
    if (field !== "type") Object.defineProperty(frontmatter, field, { value, writable: true, enumerable: true, configurable: true });
  }
  return { frontmatter, body: body ?? (kind.sections ?? []).map(heading => `# ${heading}\n`).join("\n") };
}
