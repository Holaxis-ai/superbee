/** Read-only projection of a caller-built canonical Superbee KindRegistry. No parsing or I/O. */

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function invalid(path, expected) {
  throw new TypeError(`Invalid canonical Kind registry: ${path} must be ${expected}`);
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(path, "a plain record");
  }
  return value;
}

function string(value, path) {
  if (typeof value !== "string") invalid(path, "a string");
  return value;
}

function strings(value, path) {
  if (!Array.isArray(value)) invalid(path, "an array of strings");
  return Object.freeze(Array.from(value, (entry, i) => string(entry, `${path}[${i}]`)));
}

function dictionary(value, path, convert) {
  record(value, path);
  return Object.freeze(Object.fromEntries(Object.keys(value).sort(compare)
    .map((key) => [key, convert(value[key], `${path}[${JSON.stringify(key)}]`)])));
}

function textMap(value, path) { return dictionary(value, path, string); }
function listMap(value, path) { return dictionary(value, path, strings); }

// Canonical warnings are preserved, including future JSON metadata. Never parse their messages.
function jsonCopy(value, path, ancestors = new Set()) {
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

function kindCopy(input) {
  record(input, "kind");
  const id = string(input.id, "kind.id");
  const governs = string(input.governs, `${id}.governs`);
  if (!id.trim() || !governs.trim()) invalid("kind.id and governs", "non-empty strings");
  const fields = record(input.fields, `${id}.fields`);
  const node = {
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
export function projectDomainModelV0(registry) {
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
  const relationships = [];
  const diagnostics = [];
  for (const node of kinds) {
    for (const [key, kind] of [["links", "outbound"], ["expectsInbound", "inbound-expectation"]]) {
      for (const [label, other] of Object.entries(node[key] ?? {}).sort(([a], [b]) => compare(a, b))) {
        const fromKind = kind === "outbound" ? node.governs : other;
        const toKind = kind === "outbound" ? other : node.governs;
        const id = JSON.stringify([kind, node.id, label]);
        // Source paths address canonical declarations, not JS property names or filesystem paths.
        const path = Object.freeze([key === "links" ? "links" : "expects_inbound", label]);
        const edge = {
          id, kind, declaredBy: node.id, path, label, fromKind, toKind,
          fromId: byName.get(fromKind)?.id ?? null,
          toId: byName.get(toKind)?.id ?? null,
        };
        if (kind === "outbound" && Object.hasOwn(node.linkDescriptions ?? {}, label)) {
          edge.description = node.linkDescriptions[label];
        }
        relationships.push(Object.freeze(edge));
        for (const [endpoint, name] of [["from", fromKind], ["to", toKind]]) {
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
