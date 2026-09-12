/** Explicit frontmatter intent. Collection construction is owned here, before CAS metadata. */
import { InvalidInputError } from "./errors.js";
import { okfValuesEqual } from "./okf-authored-values.js";
import { kindInputFieldNames, resolveKindFieldCoordinate, PROGRESS_STATUS_FIELD, SUPERBEE_PROGRESS_STATUS_FIELD, type KindRegistry } from "./kinds.js";
import type { Frontmatter, OkfDocument } from "./types.js";
import type { DocumentMutationCandidate } from "./document-mutation.js";

export type Scalar = string | number | boolean;
export type SourceEntry = { resource: string; id?: string; [property: string]: unknown };
export type SourceSelector = { id: string; resource?: never } | { resource: string; id?: never };
export interface SourceCandidateIdentity { id?: string; resource?: string; title?: string }
export interface FieldActionErrorDetails {
  reason: "ambiguous-source" | "source-has-id" | "source-not-found" | "source-id-conflict" | "invalid-source-id" | "unsupported-set-field";
  field: string;
  supportedFields?: string[];
  selector?: SourceSelector;
  recommendedSelector?: SourceSelector;
  candidates?: SourceCandidateIdentity[];
  total?: number;
}
/** Adapters can render corrective commands without parsing prose or repeating selection. */
export class FieldActionError extends InvalidInputError {
  readonly details: FieldActionErrorDetails;
  constructor(message: string, details: FieldActionErrorDetails) {
    super(message);
    this.name = "FieldActionError";
    this.details = details;
  }
}
export type FieldAction =
  | { action: "set"; field: string; value: unknown }
  | { action: "add"; field: "tags"; value: string }
  | { action: "add"; field: "sources"; value: SourceEntry }
  | { action: "add"; field: string; value: Scalar }
  | { action: "remove"; field: "tags"; value: string }
  | { action: "remove"; field: "sources"; selector: SourceSelector }
  | { action: "remove"; field: string; value: Scalar }
  | { action: "edit"; field: "sources"; selector: SourceSelector; patch: Record<string, unknown> }
  | { action: "replace-all"; field: "tags"; value: string[] }
  | { action: "replace-all"; field: "sources"; value: SourceEntry[] }
  | { action: "replace-all"; field: string; value: Scalar[] };
export interface FieldActionScope {
  field: string;
  action: FieldAction["action"];
  outcome: "added" | "removed" | "edited" | "unchanged" | "replaced";
  selector?: SourceSelector;
  affectedSourceIds?: string[];
}
export interface FieldActionContext { registry: KindRegistry; okfVersion: "0.1" | "0.2"; now?: () => string }
export interface PreparedDocumentFieldAction {
  candidate: DocumentMutationCandidate;
  scope: FieldActionScope;
  storageField: string;
}

const managed = new Set(["generated", "verified", "superbee_updated_by", "actor", "timestamp"]);
const standard = new Set(["title", "description", "type", "resource"]);
const v02 = new Set(["status", "stale_after", "usage_window"]);
export function isStandardDocumentSetField(field: string, okfVersion: "0.1" | "0.2"): boolean {
  return standard.has(field) || (okfVersion === "0.2" && v02.has(field));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function has(object: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(object, key); }
function sourceCandidates(rows: unknown[]): Pick<FieldActionErrorDetails, "candidates" | "total"> {
  return {
    total: rows.length,
    candidates: rows.slice(0, 5).map(row => {
      const identity: SourceCandidateIdentity = {};
      for (const key of ["id", "resource", "title"] as const) {
        if (record(row) && has(row, key) && typeof row[key] === "string") identity[key] = row[key];
      }
      return identity;
    }),
  };
}
export function containsCollection(value: unknown): boolean {
  return Array.isArray(value) || (record(value) && Object.values(value).some(containsCollection));
}
function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function isScalarList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isScalar);
}
/** Workflow progress is scalar lifecycle state in every edition, whichever name stores it. */
function scalarLifecycleField(field: string, okfVersion: "0.1" | "0.2"): boolean {
  return field === PROGRESS_STATUS_FIELD || field === SUPERBEE_PROGRESS_STATUS_FIELD
    || (field === "status" && okfVersion === "0.1");
}
export interface AssignmentContext { registry: KindRegistry; okfVersion: "0.1" | "0.2"; kindName?: string }
const WHOLE_DOCUMENT_REPAIR = "Use complete-document replacement: pull --doc-key <id>.md --out <file>, edit that file, then promote <file> --doc-key <id>.md --expected-version <version-from-pull>.";
/** The one answer to "an explicit collection action can reach this field on this document". */
function collectionActionField(field: string, context: AssignmentContext | undefined, previous: unknown, value: unknown): boolean {
  if (field === "tags" || field === "sources") return true;
  if (context === undefined || managed.has(field) || isStandardDocumentSetField(field, context.okfVersion) || scalarLifecycleField(field, context.okfVersion)) return false;
  const kind = context.registry.kinds.get(String(context.kindName));
  return kind !== undefined
    && resolveKindFieldCoordinate(context.okfVersion, kind, field) !== undefined
    && (isScalarList(previous) || isScalarList(value));
}
export function assertNonCollectionAssignment(field: string, previous: unknown, value: unknown, context?: AssignmentContext): void {
  if (containsCollection(previous) || containsCollection(value)) {
    const correction = field === "tags" || field === "sources"
      ? `Use an explicit ${field} add/remove/replace-all collection action.`
      : collectionActionField(field, context, previous, value)
        ? `Use doc field add/remove/replace-all <id> ${field}.`
        : WHOLE_DOCUMENT_REPAIR;
    throw new InvalidInputError(`Cannot assign '${field}': the old or new subtree contains a list. ${correction}`);
  }
}
export function assertOrdinaryPatch(existing: Frontmatter, proposed: Frontmatter, context?: Omit<AssignmentContext, "kindName">): void {
  // The correction must be actionable on the CURRENT document: a refused patch changes
  // nothing, so the existing type's kind (not a proposed retype) is the authority.
  const kindName = existing.type;
  for (const field of new Set([...Object.keys(existing), ...Object.keys(proposed)])) {
    if (!okfValuesEqual(existing[field], proposed[field])) assertNonCollectionAssignment(field, existing[field], proposed[field], context === undefined ? undefined : { ...context, kindName });
  }
}
function assertAssignmentName(field: string): void {
  if (managed.has(field)) throw new InvalidInputError(`'${field}' is managed metadata and cannot be assigned by a field action.`);
  if (field === "tags" || field === "sources") throw new InvalidInputError(`'${field}' requires an explicit collection add/remove/replace-all action.`);
}
/** Semantic legacy assignments retain input intent, including explicitly equal assignments. */
export function prepareDocumentAssignments(existing: OkfDocument, assignments: Record<string, unknown>, context?: Omit<AssignmentContext, "kindName">): DocumentMutationCandidate {
  if (!record(assignments)) throw new InvalidInputError("assignments must be a mapping");
  const assignmentContext: AssignmentContext | undefined = context === undefined ? undefined : { ...context, kindName: String(existing.frontmatter.type) };
  for (const [field, value] of Object.entries(assignments)) {
    assertAssignmentName(field);
    assertNonCollectionAssignment(field, existing.frontmatter[field], value, assignmentContext);
  }
  return { frontmatter: { ...existing.frontmatter, ...structuredClone(assignments) }, body: existing.body };
}
function sourceRow(value: unknown): asserts value is SourceEntry {
  if (!record(value) || typeof value.resource !== "string" || value.resource.trim() === "") throw new InvalidInputError("A source entry requires a nonempty resource string.");
  if (has(value, "id") && typeof value.id !== "string") throw new InvalidInputError("A supplied source ID must be a string.");
}
function selectorIndex(rows: unknown[], selector: SourceSelector, edit: boolean): number {
  if (!record(selector) || Object.keys(selector).length !== 1 || !(has(selector, "id") || has(selector, "resource"))) throw new InvalidInputError("Select one source by exactly one id or resource.");
  const key = has(selector, "id") ? "id" : "resource";
  const value = selector[key];
  // An imported empty ID is still an existing ID; it may be selected exactly but is never minted.
  if (typeof value !== "string" || (key === "resource" && value.trim() === "")) throw new InvalidInputError(`Source ${key} selector must be a string.`);
  const matches = rows.flatMap((row, index) => record(row) && has(row, key) && row[key] === value ? [index] : []);
  if (matches.length > 1) throw new FieldActionError(`Source selector is ambiguous (${matches.length} matches); inspect sources and use a unique ID or version-guarded replace-all.`, {
    reason: "ambiguous-source", field: "sources", selector: structuredClone(selector), ...sourceCandidates(matches.map(index => rows[index])),
  });
  if (matches.length === 0) {
    if (edit) throw new FieldActionError(`Source ${key} '${value}' was not found.`, {
      reason: "source-not-found", field: "sources", selector: structuredClone(selector), ...sourceCandidates([]),
    });
    return -1;
  }
  const index = matches[0]!;
  if (key === "resource" && has(rows[index] as object, "id")) {
    const id = (rows[index] as SourceEntry).id;
    if (typeof id !== "string") throw new FieldActionError("This source has a malformed ID; repair it with version-guarded replace-all.", {
      reason: "invalid-source-id", field: "sources", selector: structuredClone(selector), ...sourceCandidates([rows[index]]),
    });
    throw new FieldActionError(`This resource has source ID '${id}'; select it with --id.`, {
      reason: "source-has-id", field: "sources", selector: structuredClone(selector), recommendedSelector: { id }, ...sourceCandidates([rows[index]]),
    });
  }
  return index;
}

export function prepareDocumentFieldAction(existing: OkfDocument, action: FieldAction, context: FieldActionContext): PreparedDocumentFieldAction {
  if (!record(action) || typeof action.field !== "string") throw new InvalidInputError("A field action requires a field name.");
  if (action.action === "set") assertAssignmentName(action.field);
  const keys = action.action === "edit" ? ["action", "field", "selector", "patch"]
    : action.action === "remove" && action.field === "sources" ? ["action", "field", "selector"]
    : ["action", "field", "value"];
  if (Object.keys(action).some(key => !keys.includes(key)) || keys.some(key => !has(action, key))) throw new InvalidInputError("Field action has missing or incompatible input properties.");
  if ("value" in action && action.value === undefined) throw new InvalidInputError("A field action value must be supplied; removing a field is not supported.");
  let storageField = action.field;
  let candidate: DocumentMutationCandidate = { frontmatter: structuredClone(existing.frontmatter), body: existing.body };
  const scope: FieldActionScope = { field: action.field, action: action.action, outcome: "unchanged" };
  const kind = context.registry.kinds.get(String(existing.frontmatter.type));
  if (action.action === "set") {
    const coordinate = kind && resolveKindFieldCoordinate(context.okfVersion, kind, action.field);
    if (context.okfVersion === "0.1" && (action.field === "stale_after" || action.field === "usage_window")) throw new InvalidInputError(`'${action.field}' requires OKF v0.2.`);
    if (!isStandardDocumentSetField(action.field, context.okfVersion) && !coordinate) {
      const supportedFields = [...new Set([
        ...standard,
        ...(context.okfVersion === "0.2" ? v02 : []),
        ...(kind ? kindInputFieldNames(context.okfVersion, kind) : []),
      ])].filter(field => {
        if (managed.has(field) || field === "tags" || field === "sources") return false;
        if (context.okfVersion === "0.1" && (field === "stale_after" || field === "usage_window")) return false;
        const storage = kind && resolveKindFieldCoordinate(context.okfVersion, kind, field);
        return !containsCollection(existing.frontmatter[storage?.storageField ?? field]);
      }).sort();
      throw new FieldActionError(`Unsupported set field '${action.field}'; supported fields: ${supportedFields.join(", ")}.`, {
        reason: "unsupported-set-field", field: action.field, supportedFields,
      });
    }
    storageField = coordinate?.storageField ?? action.field;
    candidate = prepareDocumentAssignments(existing, { [storageField]: action.value }, { registry: context.registry, okfVersion: context.okfVersion });
    if (!okfValuesEqual(existing.frontmatter[storageField], action.value)) scope.outcome = "edited";
    if (scope.outcome !== "unchanged" && context.okfVersion === "0.1") candidate.frontmatter.timestamp = (context.now ?? (() => new Date().toISOString()))();
    return { candidate, scope, storageField };
  }
  // A `field: string` union member cannot be discriminated by literal comparison, so the
  // collection section below reads a typed view; the raw shape was already validated above.
  const act = action as {
    action: "add" | "remove" | "edit" | "replace-all";
    field: string;
    value?: unknown;
    selector?: SourceSelector;
    patch?: Record<string, unknown>;
  };
  if (!["add", "remove", "edit", "replace-all"].includes(act.action)) throw new InvalidInputError("Unknown field action.");
  if (act.field !== "tags" && act.field !== "sources") {
    // Kind-declared scalar-list fields share the tags membership contract.
    if (act.action === "edit") throw new InvalidInputError("edit supports sources only.");
    if (managed.has(act.field)) throw new InvalidInputError(`'${act.field}' is managed metadata and cannot be assigned by a field action.`);
    if (isStandardDocumentSetField(act.field, context.okfVersion)) throw new InvalidInputError(`'${act.field}' is a scalar document field; use doc field set.`);
    if (scalarLifecycleField(act.field, context.okfVersion)) throw new InvalidInputError(`'${act.field}' is a scalar lifecycle field; use doc field set.`);
    const declared = kind && resolveKindFieldCoordinate(context.okfVersion, kind, act.field);
    if (declared === undefined) throw new InvalidInputError(`'${act.field}' is not a collection target; collection actions support tags, sources, and Kind-declared list fields.`);
    storageField = declared.storageField;
    const previous = existing.frontmatter[storageField];
    let rows: unknown[];
    if (act.action === "replace-all") {
      if (!Array.isArray(act.value)) throw new InvalidInputError("replace-all requires a complete list (including [] to empty it).");
      if (act.value.some(member => !isScalar(member))) throw new InvalidInputError(`'${act.field}' requires scalar members; for a list of mappings ${WHOLE_DOCUMENT_REPAIR}`);
      rows = structuredClone(act.value);
      scope.outcome = okfValuesEqual(previous, rows) ? "unchanged" : "replaced";
    } else {
      if (!isScalar(act.value)) throw new InvalidInputError(`A '${act.field}' member must be a scalar string, number or boolean.`);
      if (previous !== undefined && !Array.isArray(previous)) throw new InvalidInputError(`'${act.field}' is not a list; repair it with version-guarded replace-all.`);
      if (previous !== undefined && previous.some(member => !isScalar(member))) throw new InvalidInputError(`'${act.field}' holds non-scalar members; ${WHOLE_DOCUMENT_REPAIR}`);
      rows = structuredClone(previous ?? []) as unknown[];
      if (act.action === "add" && !rows.includes(act.value)) { rows.push(act.value); scope.outcome = "added"; }
      if (act.action === "remove" && rows.includes(act.value)) { rows = rows.filter(row => row !== act.value); scope.outcome = "removed"; }
    }
    if (scope.outcome !== "unchanged") (candidate.frontmatter as Record<string, unknown>)[storageField] = rows;
    if (scope.outcome !== "unchanged" && context.okfVersion === "0.1") candidate.frontmatter.timestamp = (context.now ?? (() => new Date().toISOString()))();
    return { candidate, scope, storageField };
  }
  if (act.field === "sources" && context.okfVersion !== "0.2") throw new InvalidInputError("sources actions require OKF v0.2.");
  const previous = existing.frontmatter[act.field];
  let rows: unknown[];
  if (act.action === "replace-all") {
    if (!Array.isArray(act.value)) throw new InvalidInputError("replace-all requires a complete list (including [] to empty it).");
    // Authored-value validation owns row compatibility; replacement permits deliberate duplicates.
    rows = structuredClone(act.value);
    if (act.field === "tags" && rows.some(value => typeof value !== "string")) throw new InvalidInputError("tags must be a list of strings.");
    scope.outcome = okfValuesEqual(previous, rows) ? "unchanged" : "replaced";
  } else {
    if (previous !== undefined && !Array.isArray(previous)) throw new InvalidInputError(`'${act.field}' is not a list; repair it with version-guarded replace-all.`);
    rows = structuredClone(previous ?? []) as unknown[];
    if (act.field === "tags") {
      if (act.action === "edit") throw new InvalidInputError("tags supports add/remove/replace-all, not edit.");
      if (typeof act.value !== "string") throw new InvalidInputError("A tag must be a string.");
      if (act.action === "add" && !rows.includes(act.value)) { rows.push(act.value); scope.outcome = "added"; }
      if (act.action === "remove" && rows.includes(act.value)) { rows = rows.filter(row => row !== act.value); scope.outcome = "removed"; }
    } else if (act.action === "add") {
      sourceRow(act.value);
      const entry = act.value as SourceEntry;
      if (has(entry, "id")) {
        const matches = rows.filter(row => record(row) && row.id === entry.id);
        if (matches.length > 1) throw new FieldActionError("Source ID is ambiguous; repair duplicate IDs with replace-all.", {
          reason: "ambiguous-source", field: "sources", selector: { id: entry.id! }, ...sourceCandidates(matches),
        });
        if (matches.length === 1 && !okfValuesEqual(matches[0], entry)) throw new FieldActionError("Source ID conflicts with an existing entry; use edit with its observed version.", {
          reason: "source-id-conflict", field: "sources", selector: { id: entry.id! }, recommendedSelector: { id: entry.id! }, ...sourceCandidates(matches),
        });
      }
      if (!rows.some(row => okfValuesEqual(row, entry))) { rows.push(structuredClone(entry)); scope.outcome = "added"; }
      if (entry.id !== undefined) scope.affectedSourceIds = [entry.id];
    } else {
      const index = selectorIndex(rows, act.selector!, act.action === "edit");
      scope.selector = structuredClone(act.selector);
      if (index >= 0) {
        const old = rows[index] as SourceEntry;
        if (typeof old.id === "string") scope.affectedSourceIds = [old.id];
        if (act.action === "remove") { rows.splice(index, 1); scope.outcome = "removed"; }
        else {
          if (!record(act.patch)) throw new InvalidInputError("A source edit requires a property mapping.");
          const patch = act.patch;
          for (const [property, value] of Object.entries(patch)) {
            if (value === undefined) throw new InvalidInputError("Source edit properties must have values.");
            if (containsCollection(old[property]) || containsCollection(value)) throw new InvalidInputError(`Cannot assign source property '${property}': the old or new subtree contains a list. Use sources replace-all with an observed version.`);
          }
          if (has(patch, "id")) {
            if (has(old, "id")) {
              if (patch.id !== old.id) throw new InvalidInputError("An existing source ID cannot change or be removed; use replace-all.");
            } else {
              if (typeof patch.id !== "string" || patch.id.trim() === "") throw new InvalidInputError("The first source ID must be a nonempty string.");
              if (rows.some((row, i) => i !== index && record(row) && row.id === patch.id)) throw new InvalidInputError("The first source ID collides with an existing ID.");
              scope.affectedSourceIds = [patch.id];
            }
          }
          const next = { ...old, ...structuredClone(patch) };
          if (!okfValuesEqual(old, next)) { rows[index] = next; scope.outcome = "edited"; }
        }
      }
    }
  }
  // A missing collection removed from remains missing: a membership no-op writes no normalization.
  if (scope.outcome !== "unchanged") (candidate.frontmatter as Record<string, unknown>)[act.field] = rows;
  if (act.field === "sources" && act.action === "replace-all") {
    scope.affectedSourceIds = [...new Set([...(Array.isArray(previous) ? previous : []), ...rows].flatMap(row => record(row) && typeof row.id === "string" ? [row.id] : []))];
  }
  if (scope.outcome !== "unchanged" && context.okfVersion === "0.1") candidate.frontmatter.timestamp = (context.now ?? (() => new Date().toISOString()))();
  return { candidate, scope, storageField };
}
