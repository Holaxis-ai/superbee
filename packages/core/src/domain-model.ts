// Copyright 2026 Holaxis. Licensed under Apache-2.0.
/** Consumed structural shape of Superbee's canonical KindConvention; not a convention schema. */
export interface CanonicalKindInputV0 {
  readonly id: string;
  readonly title: string;
  readonly governs: string;
  readonly description?: string;
  readonly path?: string;
  readonly fields: {
    readonly required: readonly string[];
    readonly optional: readonly string[];
    readonly values: Readonly<Record<string, readonly string[]>>;
    readonly terminal: Readonly<Record<string, readonly string[]>>;
    readonly descriptions: Readonly<Record<string, string>>;
    readonly valueDescriptions?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
  readonly links?: Readonly<Record<string, string>>;
  readonly linkDescriptions?: Readonly<Record<string, string>>;
  readonly expectsInbound?: Readonly<Record<string, string>>;
  readonly sections?: readonly string[];
  readonly freshnessHorizon?: string;
  readonly browseCollapsed?: boolean;
  readonly claim?: { readonly ownerField?: string; readonly stateField?: string };
}

/** Pass buildKindRegistry/loadKinds output; CLI `kinds --json` is not a lossless substitute. */
export interface CanonicalKindRegistryInputV0 {
  readonly kinds: ReadonlyMap<string, CanonicalKindInputV0>;
  readonly warnings: readonly { readonly code: string; readonly message: string; readonly field?: string; readonly severity?: string }[];
}

export interface DomainRelationshipV0 {
  readonly id: string;
  readonly kind: "outbound" | "inbound-expectation";
  readonly declaredBy: string;
  /** Declaration key and exact relationship label, relative to its Convention frontmatter. */
  readonly path: readonly ["links" | "expects_inbound", string];
  readonly label: string;
  readonly fromKind: string;
  readonly toKind: string;
  /** Null means undeclared within this input scope, not globally invalid. */
  readonly fromId: string | null;
  readonly toId: string | null;
  readonly description?: string;
}

export interface DomainModelDiagnosticV0 {
  readonly code: "KIND_OUTSIDE_SCOPE";
  readonly severity: "info";
  readonly relationshipId: string;
  readonly declaredBy: string;
  readonly path: DomainRelationshipV0["path"];
  readonly endpoint: "from" | "to";
  readonly kind: string;
  readonly message: string;
}

export interface DomainModelV0 {
  readonly schemaVersion: 0;
  readonly kinds: readonly CanonicalKindInputV0[];
  readonly relationships: readonly DomainRelationshipV0[];
  readonly registryWarnings: CanonicalKindRegistryInputV0["warnings"];
  readonly diagnostics: readonly DomainModelDiagnosticV0[];
}


/** Read-only projection of a caller-built canonical Superbee KindRegistry. No parsing or I/O. */

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function invalid(path: string, expected: string): never {
  throw new TypeError(`Invalid canonical Kind registry: ${path} must be ${expected}`);
}

function record(value: unknown, path: string): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(path, "a plain record");
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "a string");
  return value;
}

function strings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) invalid(path, "an array of strings");
  return Object.freeze(Array.from(value, (entry, i) => string(entry, `${path}[${i}]`)));
}

function dictionary(value: any, path: string, convert: (value: any, path: string) => any): any {
  record(value, path);
  return Object.freeze(Object.fromEntries(Object.keys(value).sort(compare)
    .map((key) => [key, convert(value[key], `${path}[${JSON.stringify(key)}]`)])));
}

function textMap(value: unknown, path: string): Readonly<Record<string, string>> { return dictionary(value, path, string); }
function listMap(value: unknown, path: string): Readonly<Record<string, readonly string[]>> { return dictionary(value, path, strings); }

// Canonical warnings are preserved, including future JSON metadata. Never parse their messages.
function jsonCopy(value: any, path: string, ancestors = new Set<object>()): any {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") invalid(path, "JSON data");
  if (ancestors.has(value)) invalid(path, "acyclic JSON data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(Array.from(value, (item, i) => jsonCopy(item, `${path}[${i}]`, ancestors)));
    record(value, path);
    return Object.freeze(Object.fromEntries(Object.keys(value).sort(compare)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, jsonCopy(value[key], `${path}[${JSON.stringify(key)}]`, ancestors)])));
  } finally { ancestors.delete(value); }
}

function kindCopy(input: any): CanonicalKindInputV0 {
  record(input, "kind");
  const id = string(input.id, "kind.id");
  const governs = string(input.governs, `${id}.governs`);
  if (!id.trim() || !governs.trim()) invalid("kind.id and governs", "non-empty strings");
  const fields = record(input.fields, `${id}.fields`);
  const node: any = {
    id,
    title: string(input.title, `${id}.title`),
    governs,
    fields: {
      required: strings(fields.required, `${id}.fields.required`),
      optional: strings(fields.optional, `${id}.fields.optional`),
      values: listMap(fields.values, `${id}.fields.values`),
      terminal: listMap(fields.terminal, `${id}.fields.terminal`),
      descriptions: textMap(fields.descriptions, `${id}.fields.descriptions`),
    },
  };
  if (fields.valueDescriptions !== undefined) {
    node.fields.valueDescriptions = dictionary(fields.valueDescriptions, `${id}.fields.valueDescriptions`, textMap);
  }
  Object.freeze(node.fields);
  for (const key of ["description", "path", "freshnessHorizon"]) {
    if (input[key] !== undefined) node[key] = string(input[key], `${id}.${key}`);
  }
  for (const key of ["links", "linkDescriptions", "expectsInbound"]) {
    if (input[key] !== undefined) node[key] = textMap(input[key], `${id}.${key}`);
  }
  if (input.sections !== undefined) node.sections = strings(input.sections, `${id}.sections`);
  if (input.browseCollapsed !== undefined) {
    if (typeof input.browseCollapsed !== "boolean") invalid(`${id}.browseCollapsed`, "a boolean");
    node.browseCollapsed = input.browseCollapsed;
  }
  if (input.claim !== undefined) {
    record(input.claim, `${id}.claim`);
    node.claim = Object.freeze(Object.fromEntries(["ownerField", "stateField"]
      .filter((key) => input.claim[key] !== undefined)
      .map((key) => [key, string(input.claim[key], `${id}.claim.${key}`)])));
  }
  return Object.freeze(node);
}

/**
 * Project admitted canonical definitions, not CLI authoring rows or raw Markdown.
 * Structural checks protect the projection boundary; core remains semantic authority.
 */
export function projectDomainModelV0(registry: CanonicalKindRegistryInputV0): DomainModelV0 {
  record(registry, "registry");
  if (!(registry.kinds instanceof Map)) invalid("registry.kinds", "a Map");
  if (!Array.isArray(registry.warnings)) invalid("registry.warnings", "an array");
  const byName = new Map();
  const ids = new Set();
  for (const [name, input] of registry.kinds) {
    const node = kindCopy(input);
    if (name !== node.governs) invalid(`Map key ${String(name)}`, "equal to its Kind's governs");
    if (ids.has(node.id)) invalid(`kind.id ${node.id}`, "unique in the registry");
    ids.add(node.id);
    byName.set(name, node);
  }
  const kinds = Object.freeze([...byName.values()].sort((a, b) => compare(a.id, b.id)));
  const relationships: DomainRelationshipV0[] = [];
  const diagnostics: DomainModelDiagnosticV0[] = [];
  for (const node of kinds) {
    for (const [key, kind] of [["links", "outbound"], ["expectsInbound", "inbound-expectation"]] as const) {
      for (const [label, other] of Object.entries(node[key] ?? {}).sort(([a], [b]) => compare(a, b))) {
        const fromKind = kind === "outbound" ? node.governs : other;
        const toKind = kind === "outbound" ? other : node.governs;
        const id = JSON.stringify([kind, node.id, label]);
        // Source paths address canonical declarations, not JS property names or filesystem paths.
        const path = Object.freeze([key === "links" ? "links" : "expects_inbound", label] as const);
        const edge: any = {
          id, kind, declaredBy: node.id, path, label, fromKind, toKind,
          fromId: byName.get(fromKind)?.id ?? null,
          toId: byName.get(toKind)?.id ?? null,
        };
        if (kind === "outbound" && Object.hasOwn(node.linkDescriptions ?? {}, label)) {
          edge.description = node.linkDescriptions[label];
        }
        relationships.push(Object.freeze(edge));
        for (const [endpoint, name] of [["from", fromKind], ["to", toKind]] as const) {
          if (byName.has(name)) continue;
          diagnostics.push(Object.freeze({
            code: "KIND_OUTSIDE_SCOPE", severity: "info", relationshipId: id,
            declaredBy: node.id, path, endpoint, kind: name,
            message: `Kind ${JSON.stringify(name)} is not declared in the supplied registry.`,
          }));
        }
      }
    }
  }
  const registryWarnings = Object.freeze(Array.from(registry.warnings, (warning, i) => {
    record(warning, `warnings[${i}]`);
    string(warning.code, `warnings[${i}].code`);
    string(warning.message, `warnings[${i}].message`);
    for (const key of ["field", "severity"]) {
      if (warning[key] !== undefined) string(warning[key], `warnings[${i}].${key}`);
    }
    return jsonCopy(warning, `warnings[${i}]`);
  }));
  return Object.freeze({
    schemaVersion: 0, kinds,
    relationships: Object.freeze(relationships),
    registryWarnings,
    diagnostics: Object.freeze(diagnostics),
  });
}
