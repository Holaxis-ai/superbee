import { BundleTransferError } from "./errors.js";

const encoder = new TextEncoder();

function assertScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new BundleTransferError("INVALID_ARTIFACT", "JSON strings must contain valid Unicode scalar sequences");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new BundleTransferError("INVALID_ARTIFACT", "JSON strings must contain valid Unicode scalar sequences");
    }
  }
}

export function compareUnsignedUtf8(left: string, right: string): number {
  assertScalarSequence(left);
  assertScalarSequence(right);
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertScalarSequence(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON permits safe integers only");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON rejects symbol fields");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON requires dense arrays without extra fields");
    }
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON rejects accessors and hidden fields");
      }
    }
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON requires plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON rejects symbol fields");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON rejects accessors and hidden fields");
      }
    }
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareUnsignedUtf8)
      .map((key) => `${canonical(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new BundleTransferError("INVALID_ARTIFACT", "canonical transfer JSON rejects non-JSON values");
}

export function canonicalTransferJson(value: unknown): string {
  return canonical(value);
}

export function canonicalTransferJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonical(value));
}
