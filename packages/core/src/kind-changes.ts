import type { KindConvention, KindFieldType } from "./kinds.js";

export interface KindRelationshipChange {
  readonly field: string;
  readonly previous: string;
  readonly next?: string;
}

/** Parsed declaration facts only. Callers retain their own approval and proof policies. */
export interface KindDeclarationChanges {
  readonly requiredAdded: readonly string[];
  readonly enumsAdded: ReadonlyArray<{ field: string; values: readonly string[]; currentDeclared: boolean; desiredDeclared: boolean }>;
  readonly enumsNarrowed: ReadonlyArray<{ field: string; removedValues: readonly string[] }>;
  readonly sectionsAdded: readonly string[];
  readonly outboundAdded: readonly string[];
  readonly outboundChanged: readonly KindRelationshipChange[];
  readonly inboundAdded: readonly string[];
  readonly inboundChanged: readonly KindRelationshipChange[];
  /** Additions and changes interleaved in desired declaration order. */
  readonly typesUpdated: ReadonlyArray<{ change: "added" | "changed"; field: string; previousType?: KindFieldType; nextType: KindFieldType }>;
  readonly typesRemoved: readonly string[];
  /** Ordered string arrays; map key order is irrelevant. Malformed runtime maps compare unequal. */
  readonly terminalChanged: boolean;
  /** Same occurrence counts per field, ignoring array order. */
  readonly terminalOccurrencesChanged: boolean;
}

function relationships(current: Record<string, string> = {}, desired: Record<string, string> = {}) {
  const added = Object.keys(desired).filter(field => !Object.hasOwn(current, field));
  const changed: KindRelationshipChange[] = [];
  for (const [field, previous] of Object.entries(current)) {
    if (Object.hasOwn(desired, field) && desired[field] === previous) continue;
    changed.push({ field, previous, ...(Object.hasOwn(desired, field) ? { next: desired[field]! } : {}) });
  }
  return { added, changed };
}

/** No accessors, sparse/inherited indices or exotic array representations establish equality. */
function terminalRows(value: unknown): Map<string, string[]> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const result = new Map<string, string[]>();
  for (const key of Reflect.ownKeys(value)) {
    const entry = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !entry.enumerable || !("value" in entry)) return undefined;
    const values: unknown = entry.value;
    if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype
      || Reflect.ownKeys(values).length !== values.length + 1) return undefined;
    const row: string[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(values, index);
      if (!item || !item.enumerable || !("value" in item) || typeof item.value !== "string") return undefined;
      row.push(item.value);
    }
    result.set(key, row);
  }
  return result;
}

function sameTerminalRows(current: Map<string, string[]>, desired: Map<string, string[]>, ordered: boolean): boolean {
  return current.size === desired.size && [...current].every(([field, values]) => {
    const next = desired.get(field);
    if (!next || values.length !== next.length) return false;
    const left = ordered ? values : [...values].sort();
    const right = ordered ? next : [...next].sort();
    return left.every((value, index) => value === right[index]);
  });
}

/**
 * Compare parsed Kind declarations without storage, recipe ownership, host approval or instance
 * validation. Required/section and removed-enum occurrences keep their authored order and count.
 * Relationship maps use own parsed keys. This is not arbitrary document/YAML equality: hosts may
 * impose stricter representation and resource bounds before admitting a definition change.
 */
export function classifyKindChanges(current: KindConvention, desired: KindConvention): KindDeclarationChanges {
  const currentDeclared = new Set([...current.fields.required, ...current.fields.optional]);
  const desiredDeclared = new Set([...desired.fields.required, ...desired.fields.optional]);
  const required = new Set(current.fields.required);
  const sections = new Set(current.sections ?? []);
  const enumsAdded: KindDeclarationChanges["enumsAdded"][number][] = [];
  const enumsNarrowed: KindDeclarationChanges["enumsNarrowed"][number][] = [];
  for (const [field, values] of Object.entries(desired.fields.values)) {
    if (!Object.hasOwn(current.fields.values, field)) {
      enumsAdded.push({ field, values: [...values], currentDeclared: currentDeclared.has(field), desiredDeclared: desiredDeclared.has(field) });
      continue;
    }
    const allowed = new Set(values);
    const removedValues = current.fields.values[field]!.filter(value => !allowed.has(value));
    if (removedValues.length) enumsNarrowed.push({ field, removedValues });
  }
  const outbound = relationships(current.links, desired.links);
  const inbound = relationships(current.expectsInbound, desired.expectsInbound);
  const typesUpdated: KindDeclarationChanges["typesUpdated"][number][] = [];
  const currentTypes = current.fields.types ?? {};
  const desiredTypes = desired.fields.types ?? {};
  for (const [field, nextType] of Object.entries(desiredTypes)) {
    const previousType = Object.hasOwn(currentTypes, field) ? currentTypes[field] : undefined;
    if (previousType === nextType) continue;
    typesUpdated.push({ change: previousType === undefined ? "added" : "changed", field,
      ...(previousType === undefined ? {} : { previousType }), nextType });
  }
  const currentTerminal = terminalRows(current.fields.terminal);
  const desiredTerminal = terminalRows(desired.fields.terminal);
  return {
    requiredAdded: desired.fields.required.filter(field => !required.has(field)),
    enumsAdded, enumsNarrowed,
    sectionsAdded: (desired.sections ?? []).filter(section => !sections.has(section)),
    outboundAdded: outbound.added, outboundChanged: outbound.changed,
    inboundAdded: inbound.added, inboundChanged: inbound.changed,
    typesUpdated, typesRemoved: Object.keys(currentTypes).filter(field => !Object.hasOwn(desiredTypes, field)),
    terminalChanged: !currentTerminal || !desiredTerminal || !sameTerminalRows(currentTerminal, desiredTerminal, true),
    terminalOccurrencesChanged: !currentTerminal || !desiredTerminal || !sameTerminalRows(currentTerminal, desiredTerminal, false),
  };
}
