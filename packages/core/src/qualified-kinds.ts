import { normalizeDocumentBodyForStorage } from "./frontmatter.js";
/** Versioned, data-only qualified profile. Labels are presentation; exact references govern. */
import { definitionCanonicalJson } from "./recipe-lifecycle/stamp.js";
import { sha256Hex } from "./versioning.js";
import {
  parseConventionDoc,
  validateAgainstKind,
  type KindConvention,
  type KindRegistry,
} from "./kinds.js";
import { assertAuthoredOkfStandardFields } from "./okf-standard-fields.js";
import { InvalidInputError } from "./errors.js";
import type { OkfDocument } from "./types.js";
import { isReservedFile, pathFromConceptId } from "./paths.js";

export const QUALIFIED_PROFILE = "qualified-kinds/v1";
export const QUALIFIED_PREFIX = "conventions/qualified/";
export type KindIdentity =
  | {
      authority: "github.com";
      repository_id: string;
      recipe_id: string;
      kind_id: string;
    }
  | { authority: "bundle"; bundle_origin: string; kind_id: string };
export interface KindReference {
  identity: KindIdentity;
  source_revision: string;
  materializer: "qualified-v1";
  edition: "0.2";
  definition_digest: string;
}
export interface QualifiedArtifact {
  format: "superbee-recipe/v2";
  identity: {
    authority: "github.com";
    repository_id: string;
    recipe_id: string;
  };
  release: string;
  commit: string;
  owner_id: string;
  kinds: Array<{ kind_id: string; doc: OkfDocument }>;
}
export interface QualifiedApproval {
  repository_id: string;
  owner_id: string;
  commit: string;
  release: string;
  source_revision: string;
  actor: string;
  approved_at: string;
}
export interface QualifiedEntry {
  ref: KindReference;
  doc: OkfDocument;
  source: OkfDocument;
  approval?: QualifiedApproval;
  artifact?: QualifiedArtifact;
  derived_from?: KindReference;
}
export interface QualifiedLock {
  format: "qualified-registry/v1";
  origin: string;
  entries: QualifiedEntry[];
}
export interface QualifiedState {
  lock: QualifiedLock;
  generation: string;
  rootVersion: string;
  byReference: Map<string, { entry: QualifiedEntry; kind: KindConvention }>;
  byLabel: Map<string, string[]>;
  byIdentity: Map<string, string>;
}
export function qualifiedFailure(reason: string): never {
  throw new InvalidInputError(`Qualified profile: ${reason}`);
}
export function qualifiedDigest(value: unknown): string {
  return `sha256:${sha256Hex(definitionCanonicalJson(value))}`;
}
export function qualifiedArtifactDigest(artifact: QualifiedArtifact): string {
  return qualifiedDigest(["superbee-recipe/v2", artifact]);
}
export function referenceKey(ref: KindReference): string {
  return qualifiedDigest(["qualified-reference/v1", ref]);
}
export function qualifiedSelector(ref: KindReference): string {
  return `kind:${referenceKey(ref).slice(7)}`;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(
  value: unknown,
  keys: string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    qualifiedFailure(`invalid ${name}`);
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.normalize("NFC")
  );
}
export function assertKindReference(
  value: unknown,
): asserts value is KindReference {
  exactKeys(
    value,
    [
      "identity",
      "source_revision",
      "materializer",
      "edition",
      "definition_digest",
    ],
    "Kind reference",
  );
  if (!object(value.identity)) qualifiedFailure("invalid Kind identity");
  const identity = value.identity;
  if (identity.authority === "github.com") {
    exactKeys(
      identity,
      ["authority", "repository_id", "recipe_id", "kind_id"],
      "publisher identity",
    );
    if (
      !/^[1-9]\d*$/.test(String(identity.repository_id)) ||
      !text(identity.recipe_id)
    )
      qualifiedFailure("invalid publisher identity");
  } else if (identity.authority === "bundle") {
    exactKeys(
      identity,
      ["authority", "bundle_origin", "kind_id"],
      "local identity",
    );
    if (!/^[a-f0-9-]{36}$/.test(String(identity.bundle_origin)))
      qualifiedFailure("invalid bundle origin");
  } else qualifiedFailure("unsupported Kind authority");
  if (
    !text(identity.kind_id) ||
    value.materializer !== "qualified-v1" ||
    value.edition !== "0.2" ||
    !/^sha256:[a-f0-9]{64}$/.test(String(value.source_revision)) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(value.definition_digest))
  )
    qualifiedFailure("invalid exact Kind binding");
}
export function qualifiedDefinitionPath(
  ref: Omit<KindReference, "definition_digest">,
): string {
  return `${QUALIFIED_PREFIX}${qualifiedDigest(["qualified-placement/v1", { identity: ref.identity, source_revision: ref.source_revision, materializer: ref.materializer, edition: ref.edition }]).slice(7)}`;
}
export function parseQualifiedDefinition(doc: OkfDocument): KindConvention {
  assertAuthoredOkfStandardFields(doc.frontmatter);
  if (
    doc.frontmatter.type !== "Convention" ||
    !doc.id.startsWith(QUALIFIED_PREFIX)
  )
    qualifiedFailure("definition must be an admitted Convention");
  const allowed = new Set([
    "type",
    "title",
    "description",
    "governs",
    "path",
    "fields",
    "sections",
    "freshness_horizon",
    "browse_collapsed",
    "order",
    "undeclared_fields",
    "generated",
    "timestamp",
    "actor",
    "verified",
    "status",
    "tags",
    "sources",
    "superbee_updated_by",
  ]);
  for (const key of Object.keys(doc.frontmatter)) {
    if (!allowed.has(key))
      qualifiedFailure(`unsupported definition operator '${key}'`);
  }
  const parsed = parseConventionDoc(doc, { okfVersion: "0.2" });
  if (!parsed.ok) qualifiedFailure(`invalid definition: ${parsed.reason}`);
  if (parsed.warnings.length || parsed.reservedFieldsIgnored.length)
    qualifiedFailure(
      `unsupported or malformed definition: ${parsed.warnings.map((w) => w.message).join("; ")}`,
    );
  const kind = parsed.kind;
  // Typed links and lifecycle operators require their own exact-binding qualification.
  for (const key of [
    "links",
    "inbound_links",
    "expects_inbound",
    "claim",
    "deprecated",
    "x_recipe",
  ])
    if (Object.hasOwn(doc.frontmatter, key))
      qualifiedFailure(`unsupported definition operator '${key}'`);
  const names = [
    ...kind.fields.required,
    ...kind.fields.optional,
    ...Object.keys(kind.fields.types ?? {}),
    ...Object.keys(kind.fields.values),
  ];
  if (
    names.some(
      (n) => n.startsWith("superbee_") && n !== "superbee_progress_status",
    )
  )
    qualifiedFailure("superbee_ fields are engine-managed");
  return kind;
}
export function materializeQualifiedEntry(
  identity: KindIdentity,
  source_revision: string,
  source: OkfDocument,
  extra: Pick<QualifiedEntry, "approval" | "artifact" | "derived_from"> = {},
): QualifiedEntry {
  const address = {
    identity,
    source_revision,
    materializer: "qualified-v1" as const,
    edition: "0.2" as const,
  };
  const doc: OkfDocument = {
    id: qualifiedDefinitionPath(address),
    frontmatter: structuredClone(source.frontmatter),
    body: normalizeDocumentBodyForStorage(source.body),
  };
  if (
    Object.keys(doc.frontmatter).some(
      (k) => k.startsWith("superbee_") && k !== "superbee_updated_by",
    )
  )
    qualifiedFailure("source contains managed qualified metadata");
  parseQualifiedDefinition(doc);
  const ref: KindReference = {
    ...address,
    definition_digest: qualifiedDigest(["qualified-definition/v1", doc]),
  };
  assertKindReference(ref);
  return {
    ref,
    doc,
    source: structuredClone(source),
    ...structuredClone(extra),
  };
}
export function approvedRecipeEntries(
  artifact: QualifiedArtifact,
  approval: QualifiedApproval,
): QualifiedEntry[] {
  exactKeys(
    artifact,
    ["format", "identity", "release", "commit", "owner_id", "kinds"],
    "recipe artifact",
  );
  exactKeys(
    artifact.identity,
    ["authority", "repository_id", "recipe_id"],
    "recipe identity",
  );
  exactKeys(
    approval,
    [
      "repository_id",
      "owner_id",
      "commit",
      "release",
      "source_revision",
      "actor",
      "approved_at",
    ],
    "source approval",
  );
  if (
    artifact.format !== "superbee-recipe/v2" ||
    artifact.identity.authority !== "github.com" ||
    !Array.isArray(artifact.kinds) ||
    artifact.kinds.length === 0 ||
    artifact.kinds.length > 100 ||
    !/^[a-f0-9]{40}$/.test(artifact.commit)
  )
    qualifiedFailure("unsupported recipe artifact");
  if (
    approval.repository_id !== artifact.identity.repository_id ||
    approval.owner_id !== artifact.owner_id ||
    approval.commit !== artifact.commit ||
    approval.release !== artifact.release ||
    approval.source_revision !== qualifiedArtifactDigest(artifact)
  )
    qualifiedFailure("explicit source approval does not match pinned artifact");
  assertAuthoredOkfStandardFields({
    type: "Reference",
    generated: { by: approval.actor, at: approval.approved_at },
  });
  return artifact.kinds.map((row) => {
    exactKeys(row, ["kind_id", "doc"], "Kind declaration");
    return materializeQualifiedEntry(
      { ...artifact.identity, kind_id: row.kind_id },
      approval.source_revision,
      row.doc,
      { artifact, approval },
    );
  });
}
export function qualifiedRegistry(
  lock: QualifiedLock,
  rootVersion: string,
): KindRegistry {
  if (
    lock.format !== "qualified-registry/v1" ||
    !/^[a-f0-9-]{36}$/.test(lock.origin) ||
    !Array.isArray(lock.entries) ||
    lock.entries.length > 1000
  )
    qualifiedFailure("invalid registry");
  exactKeys(lock, ["format", "origin", "entries"], "registry lock");
  const byReference: QualifiedState["byReference"] = new Map();
  const byLabel: QualifiedState["byLabel"] = new Map();
  const identities = new Map<string, string>();
  for (const entry of lock.entries) {
    assertKindReference(entry.ref);
    if (
      entry.doc.id !== qualifiedDefinitionPath(entry.ref) ||
      entry.ref.definition_digest !==
        qualifiedDigest(["qualified-definition/v1", entry.doc])
    )
      qualifiedFailure("definition digest or placement mismatch");
    const identity = qualifiedDigest(entry.ref.identity);
    if (identities.has(identity))
      qualifiedFailure("Kind already installed; upgrades are unsupported");
    identities.set(identity, referenceKey(entry.ref));
    const expected =
      entry.ref.identity.authority === "github.com"
        ? entry.artifact && entry.approval
          ? approvedRecipeEntries(entry.artifact, entry.approval).find(
              (e) => referenceKey(e.ref) === referenceKey(entry.ref),
            )
          : undefined
        : materializeQualifiedEntry(
            entry.ref.identity,
            qualifiedDigest([
              "local-source/v1",
              entry.source,
              entry.derived_from ?? null,
            ]),
            entry.source,
            entry.derived_from ? { derived_from: entry.derived_from } : {},
          );
    if (
      !expected ||
      definitionCanonicalJson(expected) !== definitionCanonicalJson(entry) ||
      (entry.ref.identity.authority === "bundle" &&
        entry.ref.identity.bundle_origin !== lock.origin)
    )
      qualifiedFailure("unproven definition provenance");
    const kind = parseQualifiedDefinition(entry.doc);
    const key = referenceKey(entry.ref);
    byReference.set(key, { entry, kind });
    byLabel.set(kind.governs, [...(byLabel.get(kind.governs) ?? []), key]);
  }
  const recipes = new Map<string, string>();
  for (const entry of lock.entries) {
    if (entry.artifact && entry.approval) {
      const recipe = qualifiedDigest(entry.artifact.identity);
      const pin = qualifiedDigest([
        entry.artifact.release,
        entry.artifact.commit,
        entry.artifact.owner_id,
        entry.ref.source_revision,
      ]);
      if (recipes.has(recipe) && recipes.get(recipe) !== pin)
        qualifiedFailure("multiple current recipe releases are unsupported");
      recipes.set(recipe, pin);
      for (const required of approvedRecipeEntries(
        entry.artifact,
        entry.approval,
      )) {
        if (!byReference.has(referenceKey(required.ref)))
          qualifiedFailure("incomplete recipe inventory");
      }
    }
    if (entry.derived_from) {
      assertKindReference(entry.derived_from);
      if (!byReference.has(referenceKey(entry.derived_from)))
        qualifiedFailure("missing derivation source binding");
    }
  }
  const denied = new Proxy(new Map<string, KindConvention>(), {
    get() {
      return qualifiedFailure(
        "legacy label lookup unsupported; use qualified kinds and exact selectors",
      );
    },
  });
  return {
    kinds: denied,
    warnings: [],
    qualified: {
      lock: structuredClone(lock),
      generation: qualifiedDigest(lock),
      rootVersion,
      byReference,
      byLabel,
      byIdentity: identities,
    },
  };
}
export function resolveQualifiedDocument(
  registry: KindRegistry,
  doc: Pick<OkfDocument, "frontmatter">,
): KindConvention | undefined {
  if (!registry.qualified) {
    if (Object.hasOwn(doc.frontmatter, "superbee_kind_ref"))
      qualifiedFailure("binding without admitted profile");
    return registry.kinds.get(String(doc.frontmatter.type));
  }
  assertKindReference(doc.frontmatter.superbee_kind_ref);
  const selected = registry.qualified.byReference.get(
    referenceKey(doc.frontmatter.superbee_kind_ref),
  );
  if (!selected || selected.kind.governs !== doc.frontmatter.type)
    qualifiedFailure("unknown reference or type/ref mismatch");
  return selected.kind;
}
export function selectQualifiedKind(
  registry: KindRegistry,
  selector: string,
): { entry: QualifiedEntry; kind: KindConvention } {
  const state = registry.qualified;
  if (!state) qualifiedFailure("qualified registry required");
  const keys = selector.startsWith("kind:")
    ? [`sha256:${selector.slice(5)}`]
    : (state.byLabel.get(selector) ?? []);
  if (keys.length !== 1)
    qualifiedFailure(
      `${keys.length ? "ambiguous" : "unknown"} Kind '${selector}'; run qualified kinds and use its selector`,
    );
  const result = state.byReference.get(keys[0]!);
  if (!result) qualifiedFailure("unknown exact Kind selector");
  return result;
}
/** Ordinary records must remain visible to the inventory used by reads and export. */
export function assertQualifiedRecordLocation(id: string): void {
  const rel = pathFromConceptId(id);
  if (id.startsWith(QUALIFIED_PREFIX))
    qualifiedFailure("installed definition targets are immutable");
  if (isReservedFile(rel))
    qualifiedFailure("record target is a reserved OKF file");
}

export function assertQualifiedRecord(
  registry: KindRegistry,
  doc: OkfDocument,
): void {
  assertQualifiedRecordLocation(doc.id);
  const kind = resolveQualifiedDocument(registry, doc)!;
  assertAuthoredOkfStandardFields(doc.frontmatter);
  const warnings = validateAgainstKind(doc, kind);
  if (warnings.length)
    qualifiedFailure(warnings.map((w) => w.message).join("; "));
}

/** Capture a bounded data request without invoking caller-supplied accessors. */
export function captureQualifiedData<T>(input: T): T {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 200000 || depth > 40)
      qualifiedFailure("request exceeds structural bounds");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === undefined
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || active.has(value))
      qualifiedFailure("request must be acyclic plain data");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      qualifiedFailure("request must be plain data");
    active.add(value);
    const result: any = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== "string" ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        qualifiedFailure(
          "request accessors and non-data properties are unsupported",
        );
      result[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(value);
    return result;
  };
  return visit(input, 0) as T;
}
