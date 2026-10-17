// Canonical JSON, code-unit order and strict base64url for the index identity and cursors. Moved from
// portal-webmcp 0.3.1 (`identity.ts`); private to the subpath. SHA-256 is core's (`../sha256.ts`).

/**
 * Canonical JSON for identity digests, cursor bodies, and byte measurement.
 * Keys sort by UTF-16 code unit, `undefined` members are dropped, and anything
 * outside plain JSON is rejected so a digest can never depend on host ordering.
 */
export function canonicalJson(value: unknown): string {
  const rendered = serialize(value);
  if (rendered === undefined) throw new TypeError("canonical JSON received an undefined root");
  return rendered;
}

function serialize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON received a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item) ?? "null").join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("canonical JSON received a non-plain object");
    const members: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort(codeUnitCompare)) {
      const rendered = serialize((value as Record<string, unknown>)[key]);
      if (rendered !== undefined) members.push(`${JSON.stringify(key)}:${rendered}`);
    }
    return `{${members.join(",")}}`;
  }
  throw new TypeError("canonical JSON received a non-JSON value");
}

/** Locale-independent UTF-16 code-unit ordering; canonical order never uses host collation. */
export function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += BASE64URL[a >> 2]! + BASE64URL[((a & 0b11) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += BASE64URL[((b & 0b1111) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += BASE64URL[c & 0b111111]!;
  }
  return out;
}

/** Strict unpadded base64url decoding; any stray character rejects the input. */
export function base64UrlDecode(value: string): Uint8Array | undefined {
  if (value.length % 4 === 1) return undefined;
  const bits: number[] = [];
  for (const character of value) {
    const index = BASE64URL.indexOf(character);
    if (index < 0) return undefined;
    bits.push(index);
  }
  const bytes = new Uint8Array(Math.floor((bits.length * 6) / 8));
  let accumulator = 0;
  let width = 0;
  let cursor = 0;
  for (const sextet of bits) {
    accumulator = (accumulator << 6) | sextet;
    width += 6;
    if (width >= 8) {
      width -= 8;
      bytes[cursor] = (accumulator >> width) & 0xff;
      cursor += 1;
    }
  }
  // Reject non-canonical trailing bits so one byte string has exactly one encoding.
  if (width > 0 && (accumulator & ((1 << width) - 1)) !== 0) return undefined;
  return bytes;
}
