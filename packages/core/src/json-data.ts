/** JSON data only: finite numbers, plain objects and arrays, no undefined members. */
export function isJsonData(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonData(item, depth + 1));
  if (value === null || typeof value !== "object") return false;
  // A plain object from any realm: its prototype is null or a prototype that itself has none.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;
  return Object.values(value).every((item) => item !== undefined && isJsonData(item, depth + 1));
}
