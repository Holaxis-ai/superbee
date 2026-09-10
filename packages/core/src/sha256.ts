/**
 * Synchronous SHA-256 (FIPS 180-4) with no runtime dependency.
 *
 * Version tokens are minted by {@link contentVersion}, {@link versionOfBytes} and
 * {@link blobVersion} in `versioning.ts`, and every host that holds a working copy of a
 * bundle must mint byte-identical tokens: the Node engine, the in-memory adapter, and a
 * browser-local working copy in SaaS mode. A `node:crypto` import cannot be bundled for the
 * browser, and WebCrypto's `subtle.digest` is asynchronous, which would change the
 * synchronous version contract every backend relies on. One pure implementation shared by
 * every runtime removes the divergence risk entirely; `test/sha256-parity.test.ts` proves it
 * against `node:crypto` byte for byte.
 *
 * UTF-8 encoding goes through `TextEncoder`, which is a global in Node 18+ and in browsers.
 * It encodes a lone surrogate as U+FFFD (EF BF BD), exactly as Node's `"utf8"` string
 * encoding does, so string hashes agree across runtimes for malformed input as well.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const encoder = new TextEncoder();

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Absorb one 64-byte block at `offset` of `view` into the running state `h`. */
function compress(h: Uint32Array, w: Uint32Array, view: DataView, offset: number): void {
  for (let i = 0; i < 16; i++) {
    w[i] = view.getUint32(offset + i * 4);
  }
  for (let i = 16; i < 64; i++) {
    const w15 = w[i - 15]!;
    const w2 = w[i - 2]!;
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }
  let a = h[0]!;
  let b = h[1]!;
  let c = h[2]!;
  let d = h[3]!;
  let e = h[4]!;
  let f = h[5]!;
  let g = h[6]!;
  let hh = h[7]!;
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0]! + a) >>> 0;
  h[1] = (h[1]! + b) >>> 0;
  h[2] = (h[2]! + c) >>> 0;
  h[3] = (h[3]! + d) >>> 0;
  h[4] = (h[4]! + e) >>> 0;
  h[5] = (h[5]! + f) >>> 0;
  h[6] = (h[6]! + g) >>> 0;
  h[7] = (h[7]! + hh) >>> 0;
}

/** Lowercase hex SHA-256 of exact bytes. Works on any `Uint8Array` view, including a pooled Node `Buffer`. */
export function sha256HexOfBytes(bytes: Uint8Array): string {
  const h = new Uint32Array(INITIAL_STATE);
  const w = new Uint32Array(64);
  const length = bytes.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);

  // Full blocks are absorbed in place so a large blob is never copied.
  const fullBlocks = length >>> 6;
  for (let block = 0; block < fullBlocks; block++) {
    compress(h, w, view, block * 64);
  }

  // The tail carries the remaining bytes, the 0x80 terminator, zero padding, and the
  // 64-bit big-endian bit length, in one or two blocks.
  const remaining = length - fullBlocks * 64;
  const tail = new Uint8Array(remaining + 1 + 8 > 64 ? 128 : 64);
  tail.set(bytes.subarray(fullBlocks * 64));
  tail[remaining] = 0x80;
  const tailView = new DataView(tail.buffer);
  const bitLengthHigh = Math.floor(length / 0x20000000);
  const bitLengthLow = (length << 3) >>> 0;
  tailView.setUint32(tail.length - 8, bitLengthHigh);
  tailView.setUint32(tail.length - 4, bitLengthLow);
  for (let offset = 0; offset < tail.length; offset += 64) {
    compress(h, w, tailView, offset);
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += h[i]!.toString(16).padStart(8, "0");
  }
  return hex;
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes. */
export function sha256HexOfUtf8(input: string): string {
  return sha256HexOfBytes(encoder.encode(input));
}
