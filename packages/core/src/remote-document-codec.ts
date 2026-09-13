import { InvalidInputError } from "./errors.js";

/** Metadata cannot be represented by the JSON document transport without loss. */
export class RemoteDocumentValueError extends InvalidInputError {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`Remote document ${path}: ${reason}. Supply JSON-compatible metadata explicitly.`);
    this.name = "RemoteDocumentValueError";
    this.path = path;
  }
}

type JsonValue = null | string | boolean | number | JsonValue[] | { [key: string]: JsonValue };

/** Capture the wire value once, without invoking accessors or custom serialization hooks. */
export function captureRemoteFrontmatter(frontmatter: unknown): JsonValue {
  const ancestors = new Set<object>();
  const refuse = (path: string, reason: string): never => { throw new RemoteDocumentValueError(path, reason); };
  const visit = (value: unknown, path: string, depth: number): JsonValue => {
    if (depth > 512) return refuse(path, "metadata nesting exceeds the supported depth");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) return refuse(path, "number would change during JSON encoding");
      return value;
    }
    if (typeof value !== "object") return refuse(path, `${typeof value} is not a JSON value`);
    if (ancestors.has(value)) return refuse(path, "cyclic metadata cannot be represented in JSON");
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const hook = descriptors.toJSON;
    if (hook && (!("value" in hook) || typeof hook.value === "function")) {
      return refuse(`${path}["toJSON"]`, "custom serialization hooks are not supported");
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key === "symbol" && descriptor.enumerable) return refuse(path, "enumerable symbol keys would be omitted");
    }
    if (prototype === Date.prototype) {
      if (Object.values(descriptors).some(descriptor => descriptor.enumerable)) return refuse(path, "Date properties would be omitted");
      let instant: number;
      try {
        instant = Date.prototype.getTime.call(value);
      } catch {
        return refuse(path, "object has no Date value");
      }
      if (!Number.isFinite(instant)) return refuse(path, "invalid Date would become null");
      return Date.prototype.toISOString.call(value);
    }
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null) {
      return refuse(path, "only plain records, arrays, and valid Dates are supported");
    }
    ancestors.add(value);
    try {
      if (array) {
        const length = (value as unknown[]).length;
        const result: JsonValue[] = [];
        // Keep prototype serialization hooks out of the captured payload as well.
        Object.setPrototypeOf(result, null);
        for (const key of Object.keys(descriptors)) {
          if (descriptors[key]!.enumerable && !(String(Number(key)) === key && Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < length)) {
            return refuse(`${path}[${JSON.stringify(key)}]`, "extra array properties would be omitted");
          }
        }
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) return refuse(`${path}[${index}]`, "array holes would become null");
          if (!("value" in descriptor)) return refuse(`${path}[${index}]`, "accessors are not supported");
          result[index] = visit(descriptor.value, `${path}[${index}]`, depth + 1);
        }
        return result;
      }
      const result = Object.create(null) as { [key: string]: JsonValue };
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable) continue;
        const field = `${path}[${JSON.stringify(key)}]`;
        if (!("value" in descriptor)) return refuse(field, "accessors are not supported");
        result[key] = visit(descriptor.value, field, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(frontmatter, "frontmatter", 0);
}

/** Encode only the captured value, never the caller's live metadata a second time. */
export function encodeRemoteDocument(frontmatter: unknown, body: string): string {
  const payload = Object.assign(Object.create(null), { frontmatter: captureRemoteFrontmatter(frontmatter), body });
  return JSON.stringify(payload);
}
