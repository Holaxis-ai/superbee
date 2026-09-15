/**
 * Capture structural host policy: public fields, nested records/arrays, and prototype methods.
 * Methods compose through the captured receiver, never through the caller's mutable object.
 * Getters are evaluated once. Callbacks may still observe external OS facts. Policies must not
 * require opaque internal slots/private fields or functions pre-bound to a mutable receiver;
 * those cannot be reconstructed from a structural interface. Caller objects are never frozen.
 */
export function snapshotHostPolicy<T extends object>(input: T, seen = new WeakMap<object, object>()): T {
  const existing = seen.get(input);
  if (existing) return existing as T;
  const result = (Array.isArray(input) ? [] : {}) as Record<PropertyKey, unknown>;
  seen.set(input, result);
  const keys = new Set<PropertyKey>();
  for (let owner: object | null = input;
    owner && owner !== Object.prototype && owner !== Array.prototype;
    owner = Object.getPrototypeOf(owner)) {
    for (const key of Reflect.ownKeys(owner)) {
      if (key !== "constructor" && !(Array.isArray(input) && key === "length")) keys.add(key);
    }
  }
  for (const key of keys) {
    const value = (input as Record<PropertyKey, unknown>)[key];
    Object.defineProperty(result, key, {
      value: typeof value === "function" ? value.bind(result)
        : value && typeof value === "object" ? snapshotHostPolicy(value, seen) : value,
      enumerable: true,
    });
  }
  if (Array.isArray(input)) (result as unknown as unknown[]).length = input.length;
  return Object.freeze(result) as T;
}
