/** Read-only retirement evidence. No plan returned here is an instruction or token for mutation. */
import { backendFor, readBundleOkfVersion, readDocVersioned } from "../bundle-ops.js";
import { declaredBundleId, BUNDLE_NAME_DOC_ID } from "../dependencies.js";
import { parseMarkdown } from "../frontmatter.js";
import { buildKindRegistry, isConventionId, kindDeprecationProblems, parseConventionDoc, inspectKindDeprecatedUsage } from "../kinds.js";
import { isOkfRecord, okfValuesEqual } from "../okf-authored-values.js";
import { parseRecipeFiles, type LoadedRecipe } from "../recipes.js";
import { preflightRecipeSet, recipePreflightDigest, type RecipePreflightInput, type PreflightResult } from "../recipe-set-preflight.js";
import type { Bundle, OkfDocument, ReadResult } from "../types.js";
import { contentVersion } from "../versioning.js";
import { materializeRecipeForEdition, prepareRecipeInstall, sameInstalledDoc, type PreparedRecipeInstall } from "./install.js";
import { planRecipeEvolution } from "./evolution.js";
import { conventionStampState, definitionDigest, readRecipeStamp, recipeSourceDigest } from "./stamp.js";

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sorted = (ids: readonly string[]): string[] => [...ids].sort(compare);
const record = (value: unknown): Record<string, unknown> => isOkfRecord(value) ? value : {};
const own = (value: Record<string, unknown>, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined;
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

export interface RetirementIssue { code: string; id: string; message: string; field?: string }
export interface RetirementDeclaration {
  definition: string;
  kind: string;
  coordinate: "field" | "value" | "link";
  name: string;
  value?: string;
  installed_version: string;
  proposed_definition_digest: string;
  usage: Array<{ id: string; count: number; unknown?: true }>;
}
export interface RecipeDeclarationRetirementPlan {
  recipe: "declaration retirement inspection";
  id: string;
  version: string;
  source: string;
  source_digest: string;
  scope: "observed-local-concepts-and-supplied-structural-consumers";
  can_apply: false;
  apply_blocker: "RETIREMENT_APPLY_NOT_IMPLEMENTED";
  analysis: "complete" | "partial" | "refused";
  declarations: RetirementDeclaration[];
  blockers: RetirementIssue[];
  local: {
    verdict: "complete-clean" | "used" | "unknown";
    complete: boolean;
    consistency: "observed-stable-reads-not-an-atomic-snapshot";
    target_root: string;
    bundle_id?: string;
    okf_version: string;
    root_index_version: string | null;
    initial_ids: string[];
    final_ids: string[];
    inventory: Array<{ id: string; version: string | null }>;
    observation_digest: string;
    issues: RetirementIssue[];
  };
  consumers: {
    status: "unassessed" | "valid" | "partial" | "refused";
    scope: "supplied-declared-structural-only";
    model: "final-selected-source-hypothesis";
    evidence_digest?: string;
    binding_issues: Array<{ level: "partial" | "refused"; code: string; at: string }>;
    result?: PreflightResult;
    unsupported_semantics: readonly ["enum-value-compatibility", "type-compatibility", "write-intent-compatibility"];
  };
  external_consumers: "unknown-unenumerated-offline-and-arbitrary-code";
  proposed_definitions: Array<{ id: string; definition_digest: string; hypothetical_content_version: string }>;
}

/** Restore only each approved omission for the existing additive engine to inspect every OTHER
 * change. This comparison recipe is never returned as an apply plan or passed to an apply API. */
function restoreOmission(target: OkfDocument, current: OkfDocument, coordinate: RetirementDeclaration["coordinate"], name: string, value?: string): void {
  const child = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
    const next = { ...record(own(parent, key)) }; put(parent, key, next); return next;
  };
  const restoreMap = (parent: Record<string, unknown>, key: string, previous: unknown, field: string): void => {
    const old = record(previous);
    if (!Object.hasOwn(old, field)) return;
    const next = child(parent, key);
    if (!Object.hasOwn(next, field)) put(next, field, structuredClone(old[field]));
  };
  const append = (parent: Record<string, unknown>, key: string, entry: unknown): void => {
    const list = own(parent, key);
    put(parent, key, [...(Array.isArray(list) ? list : []), structuredClone(entry)]);
  };
  const currentFields = record(current.frontmatter.fields);
  const fields = child(target.frontmatter, "fields");
  const deprecated = child(target.frontmatter, "deprecated");
  if (coordinate === "field") {
    append(fields, "optional", name);
    for (const key of ["values", "types", "descriptions", "value_descriptions"]) restoreMap(fields, key, own(currentFields, key), name);
    append(deprecated, "fields", name);
    restoreMap(deprecated, "values", record(current.frontmatter.deprecated).values, name);
  } else if (coordinate === "value") {
    const values = child(fields, "values");
    const original = own(record(currentFields.values), name);
    const member = Array.isArray(original) ? original.find(v => String(v) === value) : value;
    append(values, name, member);
    const descriptions = record(own(record(currentFields.value_descriptions), name));
    if (Object.hasOwn(descriptions, value!)) restoreMap(child(fields, "value_descriptions"), name, descriptions, value!);
    append(child(deprecated, "values"), name, value);
  } else {
    restoreMap(target.frontmatter, "links", current.frontmatter.links, name);
    restoreMap(target.frontmatter, "link_descriptions", current.frontmatter.link_descriptions, name);
    append(deprecated, "links", name);
  }
}

function candidateOwned(prepared: PreparedRecipeInstall): OkfDocument[] {
  return [...prepared.docs, ...prepared.connectors.map(c => c.doc), ...prepared.references.map(r => r.doc)];
}

/** Optional supplied evidence is evaluated by the existing preflight, then bound to THIS source
 * and this observed local store. A plausible but unrelated preflight cannot certify this report. */
async function consumersFor(
  supplied: unknown, present: boolean, source: LoadedRecipe, prepared: PreparedRecipeInstall | undefined,
  snapshots: ReadonlyMap<string, ReadResult>, local: RecipeDeclarationRetirementPlan["local"],
): Promise<RecipeDeclarationRetirementPlan["consumers"]> {
  const out: RecipeDeclarationRetirementPlan["consumers"] = { status: "unassessed", scope: "supplied-declared-structural-only", model: "final-selected-source-hypothesis", binding_issues: [],
    unsupported_semantics: ["enum-value-compatibility", "type-compatibility", "write-intent-compatibility"] };
  if (!present) return out;
  const issue = (level: "partial" | "refused", code: string, at: string): void => { out.binding_issues.push({ level, code, at }); };
  out.result = await preflightRecipeSet(supplied);
  try { out.evidence_digest = recipePreflightDigest(supplied); } catch { issue("refused", "RETIREMENT_EVIDENCE_SHAPE", "input"); }
  if (out.result.issues.some(i => i.code === "INPUT_SHAPE")) { out.status = "refused"; return out; }
  const input = supplied as RecipePreflightInput;
  if (!prepared || local.okf_version !== "0.2") issue("partial", "RETIREMENT_PREFLIGHT_EDITION_UNSUPPORTED", local.okf_version);
  if (!local.complete) issue("partial", "RETIREMENT_LOCAL_INVENTORY_UNKNOWN", "local");
  const providers = input.selected.filter(s => s.recipeId === source.id && s.release === source.version);
  if (providers.length !== 1) issue("refused", "RETIREMENT_CANDIDATE_PROVIDER", source.id);
  const provider = providers[0];
  if (provider && !provider.artifact) issue("partial", "RETIREMENT_CANDIDATE_ARTIFACT_UNAVAILABLE", provider.key);
  else if (provider?.artifact) {
    const parsed = parseRecipeFiles(provider.artifact.files, "retirement:supplied-candidate", { okfVersion: "0.2" });
    if (!parsed.ok || recipeSourceDigest(parsed.recipe) !== recipeSourceDigest(source)) issue("refused", "RETIREMENT_CANDIDATE_SOURCE_MISMATCH", provider.key);
  }
  if (provider && prepared) {
    const observations = input.observations.filter(o => o.provider === provider.key && o.scope === "local");
    if (observations.length !== 1) issue(observations.length ? "refused" : "partial", "RETIREMENT_CANDIDATE_OBSERVATION", provider.key);
    for (const observed of observations) {
      if (observed.availability !== "available" || !observed.complete) { issue("partial", "RETIREMENT_CANDIDATE_OBSERVATION_UNKNOWN", observed.id); continue; }
      const expected = candidateOwned(prepared);
      if (!okfValuesEqual(sorted(observed.definitions.map(d => d.id)), sorted(expected.map(d => d.id)))) issue("refused", "RETIREMENT_CANDIDATE_DEFINITION_SET", observed.id);
      for (const def of observed.definitions) {
        const wanted = expected.find(d => d.id === def.id);
        try {
          const actual = { id: def.id, ...parseMarkdown(def.bytes, def.id, { okfVersion: "0.2" }) };
          if (!wanted || definitionDigest(actual) !== definitionDigest(wanted)) issue("refused", "RETIREMENT_CANDIDATE_DEFINITION", `${observed.id}:${def.id}`);
        } catch { issue("refused", "RETIREMENT_CANDIDATE_DEFINITION", `${observed.id}:${def.id}`); }
      }
    }
    const expected = new Map([...snapshots].map(([id, read]) => [`${id}.md`, read.doc]));
    for (const doc of [...candidateOwned(prepared), ...prepared.pages.map(p => p.registry)]) expected.set(`${doc.id}.md`, doc);
    const placements = (input.placementInventories ?? []).filter(p => p.scope === "local");
    if (placements.length !== 1) issue(placements.length ? "refused" : "partial", "RETIREMENT_LOCAL_PLACEMENT", "local");
    for (const placement of placements) {
      if (placement.availability !== "available" || !placement.complete) issue("partial", "RETIREMENT_LOCAL_PLACEMENT_UNKNOWN", placement.id);
      const docs = placement.files.filter(f => f.path.endsWith(".md"));
      if (!okfValuesEqual(sorted(docs.map(f => f.path)), sorted([...expected.keys()]))) issue("refused", "RETIREMENT_LOCAL_PLACEMENT_SET", placement.id);
      for (const file of docs) {
        const wanted = expected.get(file.path);
        try {
          const actual = { id: file.path.slice(0, -3), ...parseMarkdown(file.bytes, undefined, { okfVersion: "0.2" }) };
          const candidate = candidateOwned(prepared).some(d => `${d.id}.md` === file.path);
          if (!wanted || (candidate ? !sameInstalledDoc(actual, wanted, "0.2") : contentVersion(actual) !== contentVersion(wanted))) issue("refused", "RETIREMENT_LOCAL_PLACEMENT_CONTENT", file.path);
        } catch { issue("refused", "RETIREMENT_LOCAL_PLACEMENT_CONTENT", file.path); }
      }
      // Concept inventory does not establish ordinary blob bytes. Preserve that missing scope.
      if (placement.files.some(f => !f.path.endsWith(".md"))) issue("partial", "RETIREMENT_BLOB_BINDING_UNSUPPORTED", placement.id);
    }
  }
  for (const row of [...input.observations, ...(input.placementInventories ?? [])].filter(row => row.scope === "local")) {
    if (!row.observedVersion) issue("partial", "RETIREMENT_OBSERVATION_VERSION_UNKNOWN", row.id);
    else if (row.observedVersion !== local.observation_digest) issue("refused", "RETIREMENT_OBSERVATION_VERSION_MISMATCH", row.id);
    if (row.bundleId && row.bundleId !== local.bundle_id) issue("refused", "RETIREMENT_BUNDLE_IDENTITY", row.id);
  }
  out.binding_issues.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  out.status = out.result.verdict === "refused" || out.binding_issues.some(i => i.level === "refused") ? "refused"
    : out.result.verdict === "partial" || out.binding_issues.length ? "partial" : input.consumers.length ? "valid" : "unassessed";
  return out;
}

/** Internal reusable preparation for future guarded lifecycle application. The report alone
 * remains non-authoritative; this data carries no permission or committing operation. */
export interface PreparedRecipeDeclarationRetirement {
  report: RecipeDeclarationRetirementPlan;
  source: LoadedRecipe;
  installation?: PreparedRecipeInstall;
  snapshots: ReadonlyMap<string, ReadResult>;
  bundle: Bundle;
}

export async function prepareRecipeDeclarationRetirement(
  bundle: Bundle, recipe: LoadedRecipe, options: { consumerEvidence?: unknown } = {},
): Promise<PreparedRecipeDeclarationRetirement> {
  const source = structuredClone(recipe);
  const backend = backendFor(bundle), selected = { root: bundle.root, backend };
  const evidencePresent = Object.hasOwn(options, "consumerEvidence");
  let evidence = options.consumerEvidence;
  try { if (evidencePresent) evidence = structuredClone(evidence); } catch { /* Existing preflight returns the shape refusal. */ }
  const issues: RetirementIssue[] = [], blockers: RetirementIssue[] = [];
  const snapshots = new Map<string, ReadResult>();
  const inventory: Array<{ id: string; version: string | null }> = [];
  let initial: string[] = [], final: string[] = [], indexVersion: string | null = null, edition = "0.1";
  const unknown = (code: string, id: string, error: unknown): void => { issues.push({ code, id, message: error instanceof Error ? error.message : String(error) }); };
  try { indexVersion = (await backend.readReserved("", "index.md"))?.version ?? null; edition = await readBundleOkfVersion(selected) ?? "0.1"; }
  catch (error) { unknown("RETIREMENT_EDITION_UNREADABLE", "index.md", error); }
  try { initial = sorted(await backend.list()); } catch (error) { unknown("RETIREMENT_INVENTORY_UNAVAILABLE", "*", error); }
  if (new Set(initial).size !== initial.length) unknown("RETIREMENT_INVENTORY_AMBIGUOUS", "*", "duplicate concept IDs");
  for (const id of [...new Set(initial)]) {
    try { const read = await readDocVersioned(selected, id); if (read.doc.id !== id || typeof read.version !== "string" || !read.version) throw new Error("backend returned an invalid concept identity/version"); snapshots.set(id, read); inventory.push({ id, version: read.version }); }
    catch (error) { inventory.push({ id, version: null }); unknown("RETIREMENT_CONCEPT_UNREADABLE", id, error); }
  }
  const currentDocs = [...snapshots.values()].map(r => r.doc);
  const registry = buildKindRegistry(currentDocs.filter(d => isConventionId(d.id) && d.frontmatter.type === "Convention"), [], { okfVersion: edition });
  for (const warning of registry.warnings) blockers.push({ code: warning.code, id: "conventions/", message: warning.message, ...(warning.field ? { field: warning.field } : {}) });
  const declarations: RetirementDeclaration[] = [];
  let prepared: PreparedRecipeInstall | undefined;
  try {
    if (edition !== "0.1" && edition !== "0.2") throw new Error(`unsupported bundle edition '${edition}'`);
    prepared = prepareRecipeInstall(source, { okfVersion: edition, now: "1970-01-01T00:00:00.000Z" });
    const comparison = materializeRecipeForEdition(structuredClone(source), edition);
    const proposed = buildKindRegistry(prepared.docs, [], { okfVersion: edition });
    for (const warning of proposed.warnings) blockers.push({ code: warning.code, id: source.id, message: warning.message, ...(warning.field ? { field: warning.field } : {}) });
    for (const target of comparison.docs) {
      const installed = snapshots.get(target.id), current = installed?.doc;
      const next = parseConventionDoc(target, { okfVersion: edition });
      if (!current || !installed || !next.ok) { blockers.push({ code: "RETIREMENT_DEFINITION_UNAVAILABLE", id: target.id, message: "retirement requires a readable installed and proposed convention" }); continue; }
      const parsed = parseConventionDoc(current, { okfVersion: edition });
      if (!parsed.ok || current.frontmatter.type !== "Convention" || parsed.kind.governs !== next.kind.governs) { blockers.push({ code: "RETIREMENT_DEFINITION_IDENTITY", id: target.id, message: "installed and proposed convention identities differ" }); continue; }
      const kind = parsed.kind;
      if (readRecipeStamp(current)?.id !== source.id || conventionStampState(current) !== "current") { blockers.push({ code: "RETIREMENT_OWNERSHIP_UNPROVEN", id: target.id, message: "an unchanged readable same-recipe ownership stamp is required" }); continue; }
      if (kindDeprecationProblems(kind, registry).length) continue;
      const retiredFields = new Set<string>();
      const add = (coordinate: RetirementDeclaration["coordinate"], name: string, value?: string): void => {
        const candidate: RetirementDeclaration = { definition: target.id, kind: kind.governs, coordinate, name, ...(value === undefined ? {} : { value }), installed_version: installed.version,
          proposed_definition_digest: definitionDigest(prepared!.docs.find(d => d.id === target.id)!), usage: [] };
        for (const doc of currentDocs.filter(d => d.frontmatter.type === kind.governs)) {
          for (const row of inspectKindDeprecatedUsage(doc, kind)) {
            if (row.field !== name || row.code !== (coordinate === "field" ? "KIND_DEPRECATED_FIELD" : coordinate === "value" ? "KIND_DEPRECATED_VALUE" : "KIND_DEPRECATED_LINK")) continue;
            if (coordinate === "value" && row.value !== value) continue;
            candidate.usage.push({ id: doc.id, count: row.count, ...(row.unknown ? { unknown: true as const } : {}) });
          }
        }
        declarations.push(candidate);
        restoreOmission(target, current, coordinate, name, value);
      };
      const desiredFields = new Set([...next.kind.fields.required, ...next.kind.fields.optional]);
      for (const name of kind.fields.optional) if (!desiredFields.has(name) && kind.deprecated?.fields.includes(name)) {
        if (Object.hasOwn(kind.fields.terminal, name) && kind.fields.terminal[name]!.length) { blockers.push({ code: "RETIREMENT_TERMINAL_CHANGE_UNSUPPORTED", id: target.id, field: name, message: "terminal coordinates require a separate migration" }); continue; }
        retiredFields.add(name); add("field", name);
      }
      for (const [name, values] of Object.entries(kind.fields.values)) if (!retiredFields.has(name)) {
        const remaining = Object.hasOwn(next.kind.fields.values, name) ? next.kind.fields.values[name] : undefined;
        if (!remaining) continue; // Whole vocabulary removal remains the additive owner's unsupported omission.
        const deprecatedValues = kind.deprecated && Object.hasOwn(kind.deprecated.values, name) ? kind.deprecated.values[name]! : [];
        for (const value of values) if (!remaining.includes(value) && deprecatedValues.includes(value)) add("value", name, value);
      }
      for (const name of Object.keys(kind.links ?? {})) if (!Object.hasOwn(next.kind.links ?? {}, name) && kind.deprecated?.links.includes(name)) add("link", name);
      const restored = parseConventionDoc(target, { okfVersion: edition });
      if (restored.ok) for (const [field, before, after] of [
        ["fields.types", kind.fields.types ?? {}, restored.kind.fields.types ?? {}],
        ["fields.required", sorted(kind.fields.required), sorted(restored.kind.fields.required)],
        ["fields.terminal", kind.fields.terminal, restored.kind.fields.terminal], ["claim", kind.claim ?? {}, restored.kind.claim ?? {}],
        ["sections", kind.sections ?? [], restored.kind.sections ?? []],
      ] as const) if (!okfValuesEqual(before, after)) blockers.push({ code: "RETIREMENT_MIGRATION_UNSUPPORTED", id: target.id, field, message: "retirement inspection does not authorize unrelated type, required, terminal or claim migrations" });
    }
    for (const doc of currentDocs.filter(d => isConventionId(d.id) && readRecipeStamp(d)?.id === source.id)) {
      if (!comparison.docs.some(d => d.id === doc.id)) blockers.push({ code: "RETIREMENT_DEFINITION_OMISSION_UNSUPPORTED", id: doc.id, message: "whole convention removal is not declaration retirement" });
    }
    // Existing evolution owns all non-retirement omissions, replacements, source warnings and instance validation.
    const compatibility = await planRecipeEvolution(selected, comparison);
    blockers.push(...compatibility.blockers);
  } catch (error) { blockers.push({ code: "RETIREMENT_SOURCE_UNVERIFIABLE", id: source.id, message: error instanceof Error ? error.message : String(error) }); }
  try {
    final = sorted(await backend.list());
    if (!okfValuesEqual(initial, final)) unknown("RETIREMENT_INVENTORY_CHANGED", "*", "concept membership changed while scanning");
    for (const row of inventory) if (row.version !== null) {
      try { if ((await readDocVersioned(selected, row.id)).version !== row.version) unknown("RETIREMENT_CONCEPT_CHANGED", row.id, "concept version changed while scanning"); }
      catch (error) { unknown("RETIREMENT_CONCEPT_CHANGED", row.id, error); }
    }
    if (((await backend.readReserved("", "index.md"))?.version ?? null) !== indexVersion) unknown("RETIREMENT_EDITION_CHANGED", "index.md", "root index changed while scanning");
  } catch (error) { unknown("RETIREMENT_INVENTORY_UNVERIFIABLE", "*", error); }
  issues.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  blockers.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const bundleId = declaredBundleId(snapshots.get(BUNDLE_NAME_DOC_ID)?.doc);
  const complete = issues.length === 0;
  const localBase = { complete, consistency: "observed-stable-reads-not-an-atomic-snapshot" as const, target_root: selected.root,
    ...(bundleId ? { bundle_id: bundleId } : {}), okf_version: edition, root_index_version: indexVersion, initial_ids: initial, final_ids: final, inventory, issues };
  const local: RecipeDeclarationRetirementPlan["local"] = { ...localBase,
    verdict: declarations.some(d => d.usage.some(u => !u.unknown)) ? "used" : !complete || blockers.length > 0 || declarations.some(d => d.usage.some(u => u.unknown)) ? "unknown" : "complete-clean",
    observation_digest: recipePreflightDigest(localBase) };
  const consumers = await consumersFor(evidence, evidencePresent, source, prepared, snapshots, local);
  const report: RecipeDeclarationRetirementPlan = { recipe: "declaration retirement inspection", id: source.id, version: source.version, source: source.source, source_digest: recipeSourceDigest(source),
    scope: "observed-local-concepts-and-supplied-structural-consumers", can_apply: false, apply_blocker: "RETIREMENT_APPLY_NOT_IMPLEMENTED",
    analysis: blockers.length || consumers.status === "refused" ? "refused" : !complete || local.verdict === "unknown" || consumers.status === "partial" ? "partial" : "complete",
    declarations, blockers, local, consumers, external_consumers: "unknown-unenumerated-offline-and-arbitrary-code",
    proposed_definitions: (prepared ? candidateOwned(prepared) : []).map(doc => ({ id: doc.id, definition_digest: definitionDigest(doc), hypothetical_content_version: contentVersion(doc) })) };
  return { report, source, ...(prepared ? { installation: prepared } : {}), snapshots, bundle: selected };
}

export async function planRecipeDeclarationRetirement(
  bundle: Bundle, source: LoadedRecipe, options: { consumerEvidence?: unknown } = {},
): Promise<RecipeDeclarationRetirementPlan> {
  return (await prepareRecipeDeclarationRetirement(bundle, source, options)).report;
}
