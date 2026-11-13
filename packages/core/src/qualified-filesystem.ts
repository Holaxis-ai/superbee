import { preflightRecipeSetV2 } from "./recipe-set-preflight-v2.js";
export { preflightRecipeSetV2 } from "./recipe-set-preflight-v2.js";
/** Local qualified operations compose the existing registry, mutation engine and filesystem seam. */
import { randomUUID } from "node:crypto";
import { FilesystemBackend } from "./backend.js";
import { mutateDocument } from "./document-mutation.js";
import { loadQualifiedRegistry } from "./qualified-storage.js";
import {
  approvedRecipeEntries,
  qualifiedArtifactDigest,
  materializeQualifiedEntry,
  qualifiedDigest,
  qualifiedFailure,
  qualifiedSelector,
  assertQualifiedRecord,
  selectQualifiedKind,
  type QualifiedArtifact,
  type QualifiedApproval,
  type QualifiedLock,
  QUALIFIED_PREFIX,
} from "./qualified-kinds.js";
import type { OkfDocument } from "./types.js";
export { loadQualifiedRegistry } from "./qualified-storage.js";
export { qualifiedArtifactDigest } from "./qualified-kinds.js";
function supported(backend: FilesystemBackend): void {
  if (Object.getPrototypeOf(backend) !== FilesystemBackend.prototype)
    qualifiedFailure("unsupported backend");
}
export async function initializeQualifiedBundle(
  backend: FilesystemBackend,
  options: { actor: string },
): Promise<string> {
  supported(backend);
  if (!options.actor) qualifiedFailure("actor required");
  return backend.commitQualifiedGeneration({
    expectedRoot: null,
    lock: {
      format: "qualified-registry/v1",
      origin: randomUUID(),
      entries: [],
    },
  });
}
export async function installQualifiedRecipes(
  backend: FilesystemBackend,
  selections: Array<{
    artifact: QualifiedArtifact;
    approval: QualifiedApproval;
  }>,
): Promise<string> {
  supported(backend);
  const registry = await loadQualifiedRegistry(backend);
  const result = preflightRecipeSetV2({
    format: "recipe-set-preflight/v2",
    origin: registry.qualified!.lock.origin,
    retainedEntries: registry.qualified!.lock.entries,
    selections,
  });
  if (!result.valid) qualifiedFailure(result.diagnostics.join("; "));
  return backend.commitQualifiedGeneration({
    expectedRoot: registry.qualified!.rootVersion,
    lock: result.lock,
  });
}
export async function qualifiedKinds(backend: FilesystemBackend) {
  supported(backend);
  const registry = await loadQualifiedRegistry(backend);
  return [...registry.qualified!.byReference.values()].map(
    ({ entry, kind }) => ({
      selector: qualifiedSelector(entry.ref),
      label: kind.governs,
      identity: entry.ref.identity,
      reference: entry.ref,
      required: kind.fields.required,
      optional: kind.fields.optional,
    }),
  );
}
export async function addLocalQualifiedKind(
  backend: FilesystemBackend,
  input: { kind_id: string; doc?: OkfDocument; from?: string; actor: string },
) {
  supported(backend);
  const registry = await loadQualifiedRegistry(backend);
  const base = input.from
    ? selectQualifiedKind(registry, input.from).entry
    : undefined;
  const original = input.doc ?? base?.source;
  if (!original)
    qualifiedFailure("supply a local definition or a derivation selector");
  const source = structuredClone(original);
  source.frontmatter.generated = {
    by: input.actor,
    at: new Date().toISOString(),
  };
  source.frontmatter.superbee_updated_by = input.actor;
  const entry = materializeQualifiedEntry(
    {
      authority: "bundle",
      bundle_origin: registry.qualified!.lock.origin,
      kind_id: input.kind_id,
    },
    qualifiedDigest(["local-source/v1", source, base?.ref ?? null]),
    source,
    base ? { derived_from: base.ref } : {},
  );
  const lock = structuredClone(registry.qualified!.lock);
  lock.entries.push(entry);
  await backend.commitQualifiedGeneration({
    expectedRoot: registry.qualified!.rootVersion,
    lock,
  });
  return { selector: qualifiedSelector(entry.ref), reference: entry.ref };
}
function fields(value: Record<string, unknown>) {
  if (
    Object.keys(value).some(
      (k) =>
        (k.startsWith("superbee_") && k !== "superbee_progress_status") ||
        k === "type",
    )
  )
    qualifiedFailure("type and superbee_ fields are engine-managed");
  return structuredClone(value);
}
export async function createQualifiedDocument(
  backend: FilesystemBackend,
  input: {
    selector: string;
    id: string;
    fields: Record<string, unknown>;
    body?: string;
    actor: string;
  },
) {
  supported(backend);
  const registry = await loadQualifiedRegistry(backend);
  const selected = selectQualifiedKind(registry, input.selector);
  return mutateDocument({
    bundle: { root: "", backend },
    id: input.id,
    mode: "create-only",
    registry,
    strict: true,
    actor: input.actor,
    buildCandidate: () => ({
      frontmatter: {
        ...fields(input.fields),
        type: selected.kind.governs,
        superbee_kind_ref: selected.entry.ref,
      },
      body: input.body ?? "",
    }),
  });
}
export async function updateQualifiedDocument(
  backend: FilesystemBackend,
  input: {
    id: string;
    fields: Record<string, unknown>;
    body?: string;
    actor: string;
    expectedVersion: string;
  },
) {
  supported(backend);
  const registry = await loadQualifiedRegistry(backend);
  return mutateDocument({
    bundle: { root: "", backend },
    id: input.id,
    mode: "patch",
    registry,
    strict: true,
    actor: input.actor,
    expectedVersion: input.expectedVersion,
    input: {
      kind: "assign",
      assignments: fields(input.fields),
      ...(input.body === undefined ? {} : { body: input.body }),
    },
  });
}
export async function readQualifiedDocument(
  backend: FilesystemBackend,
  id: string,
) {
  supported(backend);
  const registry = await loadQualifiedRegistry(backend);
  const result = await backend.read(id);
  assertQualifiedRecord(registry, result.doc);
  return result;
}
export async function listQualifiedDocuments(
  backend: FilesystemBackend,
  selector?: string,
) {
  supported(backend);
  const registry = await loadQualifiedRegistry(backend);
  const selected = selector
    ? selectQualifiedKind(registry, selector)
    : undefined;
  const result = [];
  const ids = await backend.list();
  if (ids.length > 10000) qualifiedFailure("inventory exceeds 10000 documents");
  for (const id of ids) {
    if (id.startsWith(QUALIFIED_PREFIX)) continue;
    const row = await backend.read(id);
    assertQualifiedRecord(registry, row.doc);
    if (
      !selected ||
      qualifiedDigest(row.doc.frontmatter.superbee_kind_ref) ===
        qualifiedDigest(selected.entry.ref)
    )
      result.push(row);
  }
  if (
    (await backend.readReserved("", "index.md"))?.version !==
    registry.qualified!.rootVersion
  )
    qualifiedFailure("generation changed during list");
  return result;
}
export interface QualifiedPortable {
  format: "superbee-qualified-export/v1";
  lock: QualifiedLock;
  records: OkfDocument[];
}
export async function exportQualifiedBundle(
  backend: FilesystemBackend,
): Promise<QualifiedPortable> {
  supported(backend);
  return backend.snapshotQualified();
}
export async function importQualifiedBundle(
  backend: FilesystemBackend,
  portable: QualifiedPortable,
): Promise<string> {
  supported(backend);
  if (
    portable.format !== "superbee-qualified-export/v1" ||
    !Array.isArray(portable.records) ||
    portable.records.length > 10000
  )
    qualifiedFailure("unsupported portable format");
  return backend.commitQualifiedGeneration({
    expectedRoot: null,
    lock: portable.lock,
    records: portable.records,
  });
}

/** Inspection computes pins but makes no claim to independently authenticate source coordinates. */
export function inspectQualifiedArtifact(
  artifact: QualifiedArtifact,
  actor: string,
) {
  const approval = {
    repository_id: artifact.identity.repository_id,
    owner_id: artifact.owner_id,
    commit: artifact.commit,
    release: artifact.release,
    source_revision: qualifiedArtifactDigest(artifact),
    actor,
    approved_at: new Date().toISOString(),
  };
  const entries = approvedRecipeEntries(artifact, approval);
  return {
    source_verification:
      "unverified; independently verify source coordinates before explicit approval",
    approval_draft: approval,
    kinds: entries.map((entry) => ({
      identity: entry.ref.identity,
      label: entry.doc.frontmatter.governs,
      selector: qualifiedSelector(entry.ref),
    })),
  };
}
