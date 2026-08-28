import { PublicationError } from "./errors.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PublicationError("UNSERIALIZABLE_VALUE", "publication data contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PublicationError("UNSERIALIZABLE_VALUE", "publication data contains a non-plain object");
    }
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new PublicationError("UNSERIALIZABLE_VALUE", "publication data contains a non-JSON value");
}

/** Deterministic JSON serialization used by snapshot and deployment contracts. */
export function canonicalJson(value: unknown): string {
  return canonical(value);
}
