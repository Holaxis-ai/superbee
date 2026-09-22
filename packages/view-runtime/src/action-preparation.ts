import {
  parseLinksFromDoc,
  prepareDocumentFieldAction,
  prepareDocumentMutationCandidate,
  resolveKindFieldCoordinate,
  type KindRegistry,
  type OkfDocument,
} from "@superbee/core";
import { parseDocumentAction, MAX_ACTION_BODY_BYTES, type ActionScalar } from "./action-bridge.js";

export interface ViewActionPreparationContext {
  registry: KindRegistry;
  okfVersion: string | undefined;
  actor: string;
  timestamp: string;
}

function isActionScalar(value: unknown): value is ActionScalar {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/** Host-neutral proposal policy. Hosts retain authority, confirmation, and final CAS. */
export function prepareViewDocumentAction(doc: OkfDocument, rawAction: unknown, options: ViewActionPreparationContext) {
  const action = parseDocumentAction(rawAction);
  const { registry, okfVersion, timestamp } = options;
  const actor = options.actor.trim();
  if (!actor) throw new Error("set an action actor for this View host before proposing writes");
  if (doc.id !== action.docId) throw new Error("the action target does not match the loaded document");
  if (["type", "timestamp", "actor"].includes(action.field)) throw new Error(`field '${action.field}' is shell-managed and cannot be proposed`);
  const targetType = String(doc.frontmatter.type ?? "");
  const kind = registry.kinds.get(targetType);
  if (!kind) throw new Error(`document '${action.docId}' is not governed by a declared Kind`);
  const update = action.kind === "document.update";
  const bodyAction = action.kind !== "document.set-field";
  const proposedBody = action.kind === "document.update" ? action.value.body : bodyAction ? action.value as string : doc.body;
  const updates = action.kind === "document.update" ? Object.entries(action.value.fields) : [];
  const beforeFields: Record<string, ActionScalar | null> = {};
  const mapped = new Set<string>();
  for (const [field] of updates) {
    const coordinate = resolveKindFieldCoordinate(okfVersion, kind, field);
    if (["type", "timestamp", "actor"].includes(field) || !coordinate || mapped.has(coordinate.storageField))
      throw new Error("update fields must be distinct declared scalar fields, not shell-managed fields");
    mapped.add(coordinate.storageField);
    const prior = doc.frontmatter[coordinate.storageField];
    if (prior != null && (!isActionScalar(prior) || (typeof prior === "string" && new TextEncoder().encode(prior).byteLength > 4096))) throw new Error("updates cannot replace non-scalar fields");
    beforeFields[field] = prior == null ? null : prior as ActionScalar;
  }
  const fieldCoordinate = bodyAction ? { storageField: action.field } : resolveKindFieldCoordinate(okfVersion, kind, action.field);
  if (!fieldCoordinate) {
    throw new Error(`field '${action.field}' is not declared by the '${kind.governs}' Kind`);
  }
  if (bodyAction && new TextEncoder().encode(doc.body).byteLength > MAX_ACTION_BODY_BYTES)
    throw new Error("the existing body exceeds the 64 KiB confirmation limit");
  if (bodyAction) {
    const proposed = new Set(parseLinksFromDoc({ ...doc, body: proposedBody }).map(link => JSON.stringify([link.to, link.text])));
    if (parseLinksFromDoc(doc).some(link => !proposed.has(JSON.stringify([link.to, link.text]))))
      throw new Error("body proposals must preserve existing cross-links; use the canonical link tools to change relationships");
  }
  const beforeRaw = update ? JSON.stringify({ fields: beforeFields, body: doc.body }, null, 2) : bodyAction ? doc.body : doc.frontmatter[fieldCoordinate.storageField];
  let before: ActionScalar | null;
  if (beforeRaw === undefined || beforeRaw === null) {
    before = null;
  } else if (!isActionScalar(beforeRaw)) {
    throw new Error(`field '${action.field}' currently contains a non-scalar value; trusted scalar actions cannot replace it`);
  } else {
    before = beforeRaw;
  }
  let prepared: ReturnType<typeof prepareDocumentMutationCandidate>;
  {
    if (okfVersion !== undefined && okfVersion !== "0.1" && okfVersion !== "0.2") {
      throw new Error(`unsupported bundle OKF edition '${okfVersion}'`);
    }
    const context = { registry, okfVersion: okfVersion ?? "0.1", now: () => timestamp } as const;
    let candidate = action.kind === "document.set-field"
      ? prepareDocumentFieldAction(doc, { action: "set", field: action.field, value: action.value }, context).candidate
      : { frontmatter: doc.frontmatter, body: proposedBody };
    for (const [field, value] of updates)
      candidate = prepareDocumentFieldAction({ ...doc, ...candidate }, { action: "set", field, value }, context).candidate;
    prepared = prepareDocumentMutationCandidate(doc, candidate, {
      ...context, id: action.docId, strict: true, actor, persistActor: true,
    });
  }
  const storageFields = Object.fromEntries(updates.map(([field]) => [field, resolveKindFieldCoordinate(okfVersion, kind, field)!.storageField]));
  return {
    ...prepared, action, kind, storageField: fieldCoordinate.storageField, storageFields, before,
    after: action.kind === "document.update" ? JSON.stringify({ fields: action.value.fields, body: prepared.candidate.body }, null, 2) : bodyAction ? prepared.candidate.body : action.value as ActionScalar,
  };
}
