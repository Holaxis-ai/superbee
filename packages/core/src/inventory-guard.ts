import { InvalidInputError } from "./errors.js";
import { parseLeadingFrontmatter } from "./portable-frontmatter.js";
import { assertSafeConceptId, compareStorageKeys, isReservedFile, pathFromConceptId } from "./paths.js";
import { sha256HexOfUtf8 } from "./sha256.js";
import type { OkfDocument, StorageBackend, Version, WriteOptions } from "./types.js";

/** Current writers using this exact store/root and namespace; excludes independently rooted overlap. */
export const INVENTORY_GUARD_DOMAIN = "cooperating-local-writers-v1" as const;
export interface InventoryGuardTarget {
  contract: "inventory-guard/v1";
  domain: typeof INVENTORY_GUARD_DOMAIN;
  adapter: "memory" | "filesystem";
  store: string;
  root_version: Version;
  edition: "0.1" | "0.2";
}
export interface InventoryEntry { id: string; version: Version }
export interface InventoryGuardRequest {
  target: InventoryGuardTarget;
  domain: typeof INVENTORY_GUARD_DOMAIN;
  inventory: InventoryEntry[];
  id: string;
  expectedVersion: Version;
  doc: OkfDocument;
  options?: Pick<WriteOptions, "actor" | "agent">;
}
export interface InventoryGuardResult {
  version: Version;
  target: InventoryGuardTarget;
  inventory_digest: string;
}
/**
 * Data-only operation. A mismatch never falls back to target-only CAS. Filesystem closure covers
 * current mediated writers using the same physical root and runtime namespace only. Independently
 * rooted overlap, raw editors/imports/Git projections, older binaries and other users are outside it.
 * This is storage comparison, not schema validation or proof of present/future policy admission.
 */
export interface InventoryGuard {
  observeTarget(): Promise<InventoryGuardTarget>;
  compareInventoryAndWrite(request: InventoryGuardRequest): Promise<InventoryGuardResult>;
}
export class InventoryGuardUnsupported extends Error {
  readonly written = false;
  readonly reason: string;
  constructor(reason: string) { super(`Inventory guard unsupported: ${reason}`); this.name = "InventoryGuardUnsupported"; this.reason = reason; }
}
export class InventoryGuardConflict extends Error {
  readonly written = false;
  readonly reason: "identity" | "root_metadata" | "edition" | "membership" | "version" | "target_version";
  constructor(reason: InventoryGuardConflict["reason"]) {
    super(`Inventory guard premise changed: ${reason}`); this.name = "InventoryGuardConflict"; this.reason = reason;
  }
}
const capabilityOwners = new WeakMap<InventoryGuard, StorageBackend>();
/** Internal adapter binding, deliberately absent from public entrypoint exports. */
export function bindInventoryGuard(owner: StorageBackend, guard: InventoryGuard): InventoryGuard {
  capabilityOwners.set(guard, owner);
  return guard;
}
export function inventoryGuardFor(backend: StorageBackend): InventoryGuard {
  let guard: InventoryGuard | undefined;
  try { guard = backend.inventoryGuard; } catch (error) {
    if (error instanceof InventoryGuardUnsupported) throw error;
    throw new InventoryGuardUnsupported("adapter_guard_unavailable");
  }
  if (!guard) throw new InventoryGuardUnsupported("adapter_has_no_inventory_guard");
  if (capabilityOwners.get(guard) !== backend) throw new InventoryGuardUnsupported("unqualified_wrapper");
  return guard;
}
export function assertInventoryGuardBound(count: number): void {
  if (count > 10_000) throw new InventoryGuardUnsupported("inventory_document_bound");
}

/** Snapshot data without invoking caller accessors, toJSON, or transaction callbacks. */
function copyData(value: unknown, active = new Set<object>(), budget = { nodes: 100_000 }): unknown {
  if (--budget.nodes < 0) throw new InvalidInputError("Inventory guard input exceeds its data bound.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new InvalidInputError("Inventory guard accepts finite plain data only.");
  if (active.has(value)) throw new InvalidInputError("Inventory guard input is cyclic.");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) && Object.getPrototypeOf(value) !== null) {
    throw new InvalidInputError("Inventory guard accepts plain objects and arrays only.");
  }
  active.add(value);
  const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
  if (array && Object.keys(value).length !== (value as unknown[]).length) throw new InvalidInputError("Inventory guard input cannot carry sparse arrays or extra keys.");
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (array && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key))) throw new InvalidInputError("Inventory guard arrays require indexed data only.");
    if (typeof key !== "string") throw new InvalidInputError("Inventory guard input cannot carry symbol keys.");
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !("value" in property)) throw new InvalidInputError("Inventory guard input cannot carry accessors or hidden data.");
    Object.defineProperty(result, key, { value: copyData(property.value, active, budget), enumerable: true, configurable: true, writable: true });
  }
  if (array && (result as unknown[]).length !== (value as unknown[]).length) throw new InvalidInputError("Inventory guard input cannot carry sparse arrays.");
  active.delete(value);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidInputError("Inventory guard expected an object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new InvalidInputError("Inventory guard input has unsupported fields.");
}
function version(value: unknown): asserts value is Version {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new InvalidInputError("Inventory guard requires exact content versions.");
}
export function captureInventoryGuardRequest(input: InventoryGuardRequest): InventoryGuardRequest {
  const data = record(copyData(input));
  keys(data, ["target", "domain", "inventory", "id", "expectedVersion", "doc", "options"]);
  const target = record(data.target);
  keys(target, ["contract", "domain", "adapter", "store", "root_version", "edition"]);
  if (target.contract !== "inventory-guard/v1" || target.domain !== INVENTORY_GUARD_DOMAIN || data.domain !== INVENTORY_GUARD_DOMAIN) {
    throw new InventoryGuardUnsupported("domain_or_contract");
  }
  if (!["memory", "filesystem"].includes(String(target.adapter)) || typeof target.store !== "string" || target.store.length === 0 || !["0.1", "0.2"].includes(String(target.edition))) throw new InvalidInputError("Invalid inventory guard target.");
  version(target.root_version);
  if (typeof data.id !== "string") throw new InvalidInputError("Inventory guard requires a target id.");
  assertSafeConceptId(data.id);
  if (isReservedFile(pathFromConceptId(data.id))) throw new InvalidInputError("Inventory guard target must be a concept.");
  version(data.expectedVersion);
  if (!Array.isArray(data.inventory)) throw new InvalidInputError("Inventory guard requires a complete inventory.");
  assertInventoryGuardBound(data.inventory.length);
  let previous: string | undefined;
  for (const raw of data.inventory) {
    const row = record(raw);
    keys(row, ["id", "version"]);
    if (typeof row.id !== "string") throw new InvalidInputError("Inventory guard inventory id is invalid.");
    assertSafeConceptId(row.id);
    if (isReservedFile(pathFromConceptId(row.id)) || (previous !== undefined && compareStorageKeys(previous, row.id) >= 0)) throw new InvalidInputError("Inventory guard inventory must be sorted, unique concepts.");
    version(row.version);
    previous = row.id;
  }
  if (!data.inventory.some(row => row.id === data.id && row.version === data.expectedVersion)) throw new InvalidInputError("Inventory guard target/version is missing from inventory.");
  const doc = record(data.doc);
  keys(doc, ["id", "frontmatter", "body"]);
  if (doc.id !== data.id || typeof doc.body !== "string") throw new InvalidInputError("Inventory guard candidate identity/body is invalid.");
  record(doc.frontmatter);
  if (data.options !== undefined) {
    const options = record(data.options);
    keys(options, ["actor", "agent"]);
    if (Object.values(options).some(value => typeof value !== "string")) throw new InvalidInputError("Inventory guard attribution must be strings.");
  }
  return data as unknown as InventoryGuardRequest;
}
export function guardEdition(content: string | null): "0.1" | "0.2" {
  if (content === null) throw new InventoryGuardUnsupported("root_metadata_absent");
  const edition = parseLeadingFrontmatter(content, "index.md").okf_version;
  if (edition !== "0.1" && edition !== "0.2") throw new InventoryGuardUnsupported("root_edition_unestablished");
  return edition;
}
export function compareInventoryPremises(expected: InventoryGuardRequest, current: InventoryGuardTarget, inventory: InventoryEntry[]): void {
  if (expected.target.adapter !== current.adapter || expected.target.store !== current.store) throw new InventoryGuardConflict("identity");
  if (expected.target.edition !== current.edition) throw new InventoryGuardConflict("edition");
  if (expected.target.root_version !== current.root_version) throw new InventoryGuardConflict("root_metadata");
  if (expected.inventory.length !== inventory.length || expected.inventory.some((row, index) => row.id !== inventory[index]?.id)) throw new InventoryGuardConflict("membership");
  if (expected.inventory.some((row, index) => row.version !== inventory[index]!.version)) throw new InventoryGuardConflict("version");
  if (!inventory.some(row => row.id === expected.id && row.version === expected.expectedVersion)) throw new InventoryGuardConflict("target_version");
}
export function inventoryDigest(inventory: InventoryEntry[]): string {
  return `sha256:${sha256HexOfUtf8(JSON.stringify(inventory.map(row => [row.id, row.version])))}`;
}
