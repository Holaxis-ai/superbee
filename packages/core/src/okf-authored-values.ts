/** Structural preservation policy shared by authored standard fields and timestamp diagnostics. */
export type OkfRecord = Readonly<Record<string, unknown>>;
export function isOkfRecord(value: unknown): value is OkfRecord {
  if (value === null || typeof value !== "object") return false;
  // Runtime objects such as Date serialize as scalars, not YAML mappings. Only ordinary
  // records (including null-prototype dictionaries) establish the shape authoring relies on.
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function okfValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Unknown producer fields may retain native timestamp scalars in in-memory backends.
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && Array.from(a).every((value, i) => okfValuesEqual(value, b[i]));
  if (!isOkfRecord(a) || !isOkfRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && okfValuesEqual(a[key], b[key]));
}
export function okfRows(value: unknown, allowBare: boolean): unknown[] {
  return Array.isArray(value) ? Array.from(value) : allowBare && isOkfRecord(value) ? [value] : [];
}
/** Each exact old row can exempt one candidate row; edits and additional copies are newly authored. */
export function authoredOkfRows(value: unknown, previous: unknown, allowBare: boolean): Array<{ entry: unknown; index: number }> {
  const prior = okfRows(previous, allowBare);
  const used = new Set<number>();
  return okfRows(value, allowBare).flatMap((entry, index) => {
    const match = prior.findIndex((old, i) => !used.has(i) && okfValuesEqual(entry, old));
    if (match === -1) return [{ entry, index }];
    used.add(match);
    return [];
  });
}
