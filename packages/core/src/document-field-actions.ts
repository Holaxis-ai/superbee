import { assertTypedListPatch } from "./body-replace-guards.js";
/** Explicit frontmatter intent. Collection construction is owned here, before CAS metadata. */
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";
import { InvalidInputError } from "./errors.js";
import { okfValuesEqual } from "./okf-authored-values.js";
import { KindConformanceError } from "./kind-conformance-error.js";
import { isKindListField, kindInputFieldNames, resolveKindFieldCoordinate, validateAgainstKind, type KindConvention, type KindRegistry } from "./kinds.js";
import { matchesSourceIdentity } from "./query-filter.js";
import type { Frontmatter, OkfDocument } from "./types.js";
import type { DocumentMutationCandidate } from "./document-mutation.js";

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
  /**
   * Remove one field: any field `set` admits apart from `type` and the fields the document's Kind
   * requires (refused with that Kind's `KIND_FIELD_MISSING`). A no-op when the field is absent.
   */
  | { action: "unset"; field: string }
  | { action: "add"; field: "tags"; value: string }
  | { action: "add"; field: "sources"; value: SourceEntry }
  | { action: "remove"; field: "tags"; value: string }
  | { action: "remove"; field: "sources"; selector: SourceSelector }
  | { action: "edit"; field: "sources"; selector: SourceSelector; patch: Record<string, unknown> }
  /**
   * Select the one entry whose (`resource`, `id`) pair equals the value's, by the shared
   * `sources[]` identity rule, and merge the value's properties into it; append the value when
   * no entry carries the pair. The ID must be nonempty because an upsert may mint it, and it
   * may not already name an entry under another resource.
   */
  | { action: "upsert"; field: "sources"; value: SourceEntry & { id: string } }
  | { action: "replace-all"; field: "tags"; value: string[] }
  | { action: "replace-all"; field: "sources"; value: SourceEntry[] }
  /**
   * The complete list of a field the document's Kind declares as `string-list` or `https-url-list`,
   * kept in the given order: a Kind cannot say whether its list is a set, so ordering and
   * deduplication belong to the caller (the Kind's type check refuses repeats on a strict write).
   */
  | { action: "replace-all"; field: string; value: string[] };
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
export function assertNonCollectionAssignment(field: string, previous: unknown, value: unknown): void {
  if (containsCollection(previous) || containsCollection(value)) {
    const correction = field === "tags" || field === "sources"
      ? `Use an explicit ${field} add/remove/replace-all collection action.`
      : "Use complete-document replacement: pull --doc-key <id>.md --out <file>, edit that file, then promote <file> --doc-key <id>.md --expected-version <version-from-pull>.";
    throw new InvalidInputError(`Cannot assign '${field}': the old or new subtree contains a list. ${correction}`);
  }
}
export function assertOrdinaryPatch(existing: Frontmatter, proposed: Frontmatter): void {
  for (const field of new Set([...Object.keys(existing), ...Object.keys(proposed)])) {
    if (!okfValuesEqual(existing[field], proposed[field])) assertNonCollectionAssignment(field, existing[field], proposed[field]);
  }
}
function assertAssignmentName(field: string): void {
  if (isManagedDocumentMetadataField(field)) throw new InvalidInputError(`'${field}' is managed metadata and cannot be assigned by a field action.`);
  if (field === "tags" || field === "sources") throw new InvalidInputError(`'${field}' requires an explicit collection add/remove/replace-all action.`);
}
/** Semantic legacy assignments retain input intent, including explicitly equal assignments. */
export function prepareDocumentAssignments(existing: OkfDocument, assignments: Record<string, unknown>): DocumentMutationCandidate {
  if (!record(assignments)) throw new InvalidInputError("assignments must be a mapping");
  for (const [field, value] of Object.entries(assignments)) {
    assertAssignmentName(field);
    assertNonCollectionAssignment(field, existing.frontmatter[field], value);
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

/**
 * The field `set` (and `unset`) may name on this document, resolved to its storage name: a standard
 * set field of the edition or a field the document's Kind declares. Anything else is
 * `unsupported-set-field`, listing what the action would accept.
 */
function admittedField(existing: OkfDocument, field: string, context: FieldActionContext, action: "set" | "unset"): { kind: KindConvention | undefined; storageField: string } {
  const kind = context.registry.kinds.get(String(existing.frontmatter.type)) ?? undefined;
  const coordinate = kind && resolveKindFieldCoordinate(context.okfVersion, kind, field);
  if (context.okfVersion === "0.1" && (field === "stale_after" || field === "usage_window")) throw new InvalidInputError(`'${field}' requires OKF v0.2.`);
  if (!isStandardDocumentSetField(field, context.okfVersion) && !coordinate) {
    const supportedFields = [...new Set([
      ...standard,
      ...(context.okfVersion === "0.2" ? v02 : []),
      ...(kind ? kindInputFieldNames(context.okfVersion, kind) : []),
    ])].filter(name => {
      if (isManagedDocumentMetadataField(name) || name === "tags" || name === "sources") return false;
      if (context.okfVersion === "0.1" && (name === "stale_after" || name === "usage_window")) return false;
      const storage = kind && resolveKindFieldCoordinate(context.okfVersion, kind, name);
      if (action === "unset") return name !== "type" && !(kind && kind.fields.required.includes(storage?.storageField ?? name));
      return !containsCollection(existing.frontmatter[storage?.storageField ?? name]);
    }).sort();
    throw new FieldActionError(`Unsupported ${action} field '${field}'; supported fields: ${supportedFields.join(", ")}.`, {
      reason: "unsupported-set-field", field, supportedFields,
    });
  }
  return { kind, storageField: coordinate?.storageField ?? field };
}
const timestampFor = (context: FieldActionContext): string => (context.now ?? (() => new Date().toISOString()))();

export function prepareDocumentFieldAction(existing: OkfDocument, action: FieldAction, context: FieldActionContext): PreparedDocumentFieldAction {
  if (!record(action) || typeof action.field !== "string") throw new InvalidInputError("A field action requires a field name.");
  if (action.action === "set" || action.action === "unset") assertAssignmentName(action.field);
  const keys = action.action === "edit" ? ["action", "field", "selector", "patch"]
    : action.action === "remove" && action.field === "sources" ? ["action", "field", "selector"]
    : action.action === "unset" ? ["action", "field"]
    : ["action", "field", "value"];
  if (Object.keys(action).some(key => !keys.includes(key)) || keys.some(key => !has(action, key))) throw new InvalidInputError("Field action has missing or incompatible input properties.");
  if ("value" in action && action.value === undefined) throw new InvalidInputError("A field action value must be supplied; remove a field with unset.");
  let storageField = action.field;
  let candidate: DocumentMutationCandidate = { frontmatter: structuredClone(existing.frontmatter), body: existing.body };
  const scope: FieldActionScope = { field: action.field, action: action.action, outcome: "unchanged" };
  if (action.action === "set") {
    const admitted = admittedField(existing, action.field, context, "set");
    storageField = admitted.storageField;
    if (admitted.kind) assertTypedListPatch(admitted.kind, storageField);
    candidate = prepareDocumentAssignments(existing, { [storageField]: action.value });
    if (!okfValuesEqual(existing.frontmatter[storageField], action.value)) scope.outcome = "edited";
    if (scope.outcome !== "unchanged" && context.okfVersion === "0.1") candidate.frontmatter.timestamp = timestampFor(context);
    return { candidate, scope, storageField };
  }
  const prototypeName = (): never => { throw new InvalidInputError("'__proto__' is not a writable frontmatter field."); };
  if (action.action === "unset") {
    if (action.field === "__proto__") prototypeName();
    if (action.field === "type") throw new InvalidInputError("'type' cannot be removed; a document keeps its type.");
    const admitted = admittedField(existing, action.field, context, "unset");
    storageField = admitted.storageField;
    const fields = candidate.frontmatter as Record<string, unknown>;
    if (has(fields, storageField)) { delete fields[storageField]; scope.outcome = "removed"; }
    const kind = admitted.kind;
    if (kind && kind.fields.required.includes(storageField)) {
      // The Kind's own finding for the candidate, so every consumer reads the code it already maps.
      const missing = validateAgainstKind({ id: existing.id, ...candidate }, kind).filter(warning => warning.code === "KIND_FIELD_MISSING" && warning.field === storageField);
      throw new KindConformanceError(existing.id, kind.governs, missing, context.okfVersion);
    }
    if (scope.outcome !== "unchanged" && context.okfVersion === "0.1") candidate.frontmatter.timestamp = timestampFor(context);
    return { candidate, scope, storageField };
  }
  if (action.action === "replace-all" && action.field !== "tags" && action.field !== "sources") {
    if (action.field === "__proto__") prototypeName();
    const kind = context.registry.kinds.get(String(existing.frontmatter.type)) ?? undefined;
    const coordinate = kind && resolveKindFieldCoordinate(context.okfVersion, kind, action.field);
    if (isManagedDocumentMetadataField(action.field) || isStandardDocumentSetField(action.field, context.okfVersion) || !coordinate || !isKindListField(kind, coordinate.storageField)) {
      throw new InvalidInputError(`replace-all supports tags, sources, and fields the document's Kind declares as string-list or https-url-list; '${action.field}' is none of these.`);
    }
    storageField = coordinate.storageField;
    if (!Array.isArray(action.value)) throw new InvalidInputError("replace-all requires a complete list (including [] to empty it).");
    if (action.value.some(member => typeof member !== "string")) throw new InvalidInputError(`'${action.field}' must be a list of strings.`);
    const rows = structuredClone(action.value);
    if (!okfValuesEqual(existing.frontmatter[storageField], rows)) {
      (candidate.frontmatter as Record<string, unknown>)[storageField] = rows;
      scope.outcome = "replaced";
      if (context.okfVersion === "0.1") candidate.frontmatter.timestamp = timestampFor(context);
    }
    return { candidate, scope, storageField };
  }
  if (action.field !== "tags" && action.field !== "sources") throw new InvalidInputError("add, remove and edit support only tags and sources; replace a Kind-declared list field whole with replace-all.");
  if (!["add", "remove", "edit", "replace-all", "upsert"].includes(action.action)) throw new InvalidInputError("Unknown field action.");
  if (action.field === "sources" && context.okfVersion !== "0.2") throw new InvalidInputError("sources actions require OKF v0.2.");
  const previous = existing.frontmatter[action.field];
  let rows: unknown[];
  if (action.action === "replace-all") {
    if (!Array.isArray(action.value)) throw new InvalidInputError("replace-all requires a complete list (including [] to empty it).");
    // Authored-value validation owns row compatibility; replacement permits deliberate duplicates.
    rows = structuredClone(action.value);
    if (action.field === "tags" && rows.some(value => typeof value !== "string")) throw new InvalidInputError("tags must be a list of strings.");
    scope.outcome = okfValuesEqual(previous, rows) ? "unchanged" : "replaced";
  } else {
    if (previous !== undefined && !Array.isArray(previous)) throw new InvalidInputError(`'${action.field}' is not a list; repair it with version-guarded replace-all.`);
    rows = structuredClone(previous ?? []) as unknown[];
    if (action.field === "tags") {
      if (["edit", "upsert"].includes((action as { action: string }).action)) throw new InvalidInputError(`tags supports add/remove/replace-all, not ${(action as { action: string }).action}.`);
      if (typeof action.value !== "string") throw new InvalidInputError("A tag must be a string.");
      if (action.action === "add" && !rows.includes(action.value)) { rows.push(action.value); scope.outcome = "added"; }
      if (action.action === "remove" && rows.includes(action.value)) { rows = rows.filter(row => row !== action.value); scope.outcome = "removed"; }
    } else if (action.action === "upsert") {
      sourceRow(action.value);
      const value = action.value;
      if (typeof value.id !== "string" || value.id.trim() === "") throw new InvalidInputError("A source upsert requires a nonempty id.");
      for (const [property, entry] of Object.entries(value)) {
        if (entry === undefined) throw new InvalidInputError("Source upsert properties must have values.");
        if (containsCollection(entry)) throw new InvalidInputError(`Cannot assign source property '${property}': the new subtree contains a list. Use sources replace-all with an observed version.`);
      }
      const identity = { resource: value.resource, id: value.id };
      const matches = rows.flatMap((row, index) => matchesSourceIdentity(row, identity) ? [index] : []);
      if (matches.length > 1) throw new FieldActionError(`Source identity is ambiguous (${matches.length} matches); repair duplicates with version-guarded replace-all.`, {
        reason: "ambiguous-source", field: "sources", selector: { id: value.id }, ...sourceCandidates(matches.map(index => rows[index])),
      });
      scope.affectedSourceIds = [value.id];
      if (matches.length === 1) {
        const old = rows[matches[0]!] as SourceEntry;
        for (const property of Object.keys(value)) {
          if (containsCollection(old[property])) throw new InvalidInputError(`Cannot assign source property '${property}': the old subtree contains a list. Use sources replace-all with an observed version.`);
        }
        const next = { ...old, ...structuredClone(value) };
        if (!okfValuesEqual(old, next)) { rows[matches[0]!] = next; scope.outcome = "edited"; }
      } else {
        const sameId = rows.filter(row => record(row) && row.id === value.id);
        if (sameId.length > 0) throw new FieldActionError(`Source ID '${value.id}' already names an entry under another resource; a document-local ID is never minted twice.`, {
          reason: "source-id-conflict", field: "sources", selector: { id: value.id }, recommendedSelector: { id: value.id }, ...sourceCandidates(sameId),
        });
        rows.push(structuredClone(value));
        scope.outcome = "added";
      }
    } else if (action.action === "add") {
      sourceRow(action.value);
      if (has(action.value, "id")) {
        const matches = rows.filter(row => record(row) && row.id === action.value.id);
        if (matches.length > 1) throw new FieldActionError("Source ID is ambiguous; repair duplicate IDs with replace-all.", {
          reason: "ambiguous-source", field: "sources", selector: { id: action.value.id! }, ...sourceCandidates(matches),
        });
        if (matches.length === 1 && !okfValuesEqual(matches[0], action.value)) throw new FieldActionError("Source ID conflicts with an existing entry; use edit with its observed version.", {
          reason: "source-id-conflict", field: "sources", selector: { id: action.value.id! }, recommendedSelector: { id: action.value.id! }, ...sourceCandidates(matches),
        });
      }
      if (!rows.some(row => okfValuesEqual(row, action.value))) { rows.push(structuredClone(action.value)); scope.outcome = "added"; }
      if (action.value.id !== undefined) scope.affectedSourceIds = [action.value.id];
    } else {
      const index = selectorIndex(rows, action.selector, action.action === "edit");
      scope.selector = structuredClone(action.selector);
      if (index >= 0) {
        const old = rows[index] as SourceEntry;
        if (typeof old.id === "string") scope.affectedSourceIds = [old.id];
        if (action.action === "remove") { rows.splice(index, 1); scope.outcome = "removed"; }
        else {
          if (!record(action.patch)) throw new InvalidInputError("A source edit requires a property mapping.");
          for (const [property, value] of Object.entries(action.patch)) {
            if (value === undefined) throw new InvalidInputError("Source edit properties must have values.");
            if (containsCollection(old[property]) || containsCollection(value)) throw new InvalidInputError(`Cannot assign source property '${property}': the old or new subtree contains a list. Use sources replace-all with an observed version.`);
          }
          if (has(action.patch, "id")) {
            if (has(old, "id")) {
              if (action.patch.id !== old.id) throw new InvalidInputError("An existing source ID cannot change or be removed; use replace-all.");
            } else {
              if (typeof action.patch.id !== "string" || action.patch.id.trim() === "") throw new InvalidInputError("The first source ID must be a nonempty string.");
              if (rows.some((row, i) => i !== index && record(row) && row.id === action.patch.id)) throw new InvalidInputError("The first source ID collides with an existing ID.");
              scope.affectedSourceIds = [action.patch.id];
            }
          }
          const next = { ...old, ...structuredClone(action.patch) };
          if (!okfValuesEqual(old, next)) { rows[index] = next; scope.outcome = "edited"; }
        }
      }
    }
  }
  // A missing collection removed from remains missing: a membership no-op writes no normalization.
  if (scope.outcome !== "unchanged") (candidate.frontmatter as Record<string, unknown>)[action.field] = rows;
  if (action.field === "sources" && action.action === "replace-all") {
    scope.affectedSourceIds = [...new Set([...(Array.isArray(previous) ? previous : []), ...rows].flatMap(row => record(row) && typeof row.id === "string" ? [row.id] : []))];
  }
  if (scope.outcome !== "unchanged" && context.okfVersion === "0.1") candidate.frontmatter.timestamp = timestampFor(context);
  return { candidate, scope, storageField };
}
