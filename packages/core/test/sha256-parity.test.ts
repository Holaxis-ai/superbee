/**
 * Conformance gate for the pure SHA-256 behind every version token.
 *
 * `sha256.ts` exists so a browser-local working copy mints the same content-addressed
 * version strings as the Node engine. That claim is only true if the pure digest agrees
 * with `node:crypto` byte for byte, through every public token primitive, on inputs that
 * exercise the algorithm's edges: empty input, padding boundaries (55/56/63/64/65 and
 * 119/120 bytes), multi-byte UTF-8, a lone surrogate, bytes that are not valid UTF-8, a
 * multi-block random blob, the FIPS 180-4 known-answer vectors, and real fixture documents
 * round-tripped through `contentVersion`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMarkdown, stringifyDoc } from "../src/frontmatter.js";
import { sha256HexOfBytes, sha256HexOfUtf8 } from "../src/sha256.js";
import { blobVersion, contentVersion, sha256Hex, versionOfBytes } from "../src/versioning.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function nodeHexOfString(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function nodeHexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const STRING_VECTORS: Array<{ name: string; value: string }> = [
  { name: "empty", value: "" },
  { name: "ascii", value: "The quick brown fox jumps over the lazy dog" },
  { name: "cjk", value: "知識は力なり。知识就是力量。지식은 힘이다." },
  { name: "emoji with ZWJ and skin tone", value: "🐝 👩🏽‍🔬 🇯🇵" },
  { name: "combining marks", value: "éạ̈ñ" },
  { name: "lone high surrogate", value: "ab\uD83Dcd" },
  { name: "lone low surrogate", value: "ab\uDE00cd" },
  { name: "55 bytes (one block, no length room)", value: "a".repeat(55) },
  { name: "56 bytes (forces a second padding block)", value: "b".repeat(56) },
  { name: "63 bytes", value: "c".repeat(63) },
  { name: "64 bytes (exactly one block)", value: "d".repeat(64) },
  { name: "65 bytes", value: "e".repeat(65) },
  { name: "119 bytes", value: "f".repeat(119) },
  { name: "120 bytes", value: "g".repeat(120) },
  { name: "multi-byte crossing a block boundary", value: "x".repeat(62) + "€" + "y".repeat(10) },
  { name: "frontmatter-shaped text", value: "---\ntype: Note\ntitle: Ünïcödé\n---\n# Heading\n\nbody\n" },
];

for (const { name, value } of STRING_VECTORS) {
  test(`sha256Hex and versionOfBytes agree with node:crypto: ${name}`, () => {
    const expected = nodeHexOfString(value);
    assert.equal(sha256Hex(value), expected);
    assert.equal(sha256HexOfUtf8(value), expected);
    assert.equal(versionOfBytes(value), `sha256:${expected}`);
  });
}

test("a lone surrogate is encoded as U+FFFD by both TextEncoder and node utf8, so the tokens agree", () => {
  const encoded = new TextEncoder().encode("\uD83D");
  assert.deepEqual(Array.from(encoded), [0xef, 0xbf, 0xbd]);
  assert.deepEqual(Array.from(Buffer.from("\uD83D", "utf8")), [0xef, 0xbf, 0xbd]);
  assert.equal(sha256Hex("\uD83D"), nodeHexOfString("\uD83D"));
});

test("FIPS 180-4 known-answer vectors", () => {
  assert.equal(
    sha256HexOfUtf8("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256HexOfUtf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(
    sha256HexOfBytes(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

const BYTE_VECTORS: Array<{ name: string; bytes: () => Uint8Array }> = [
  { name: "empty", bytes: () => new Uint8Array(0) },
  { name: "invalid UTF-8 bytes", bytes: () => new Uint8Array([0x80, 0xff, 0xfe]) },
  { name: "single zero byte", bytes: () => new Uint8Array([0]) },
  { name: "all byte values", bytes: () => new Uint8Array(Array.from({ length: 256 }, (_, i) => i)) },
  { name: "55 bytes", bytes: () => new Uint8Array(55).fill(0x55) },
  { name: "56 bytes", bytes: () => new Uint8Array(56).fill(0x56) },
  { name: "63 bytes", bytes: () => new Uint8Array(63).fill(0x63) },
  { name: "64 bytes", bytes: () => new Uint8Array(64).fill(0x64) },
  { name: "65 bytes", bytes: () => new Uint8Array(65).fill(0x65) },
  { name: "119 bytes", bytes: () => new Uint8Array(119).fill(0x19) },
  { name: "120 bytes", bytes: () => new Uint8Array(120).fill(0x20) },
  { name: "2 MiB random blob", bytes: () => new Uint8Array(randomBytes(2 * 1024 * 1024)) },
  { name: "random length between 1 and 4096", bytes: () => new Uint8Array(randomBytes(1 + Math.floor(Math.random() * 4096))) },
];

for (const { name, bytes } of BYTE_VECTORS) {
  test(`blobVersion agrees with node:crypto: ${name}`, () => {
    const input = bytes();
    const expected = nodeHexOfBytes(input);
    assert.equal(sha256HexOfBytes(input), expected);
    assert.equal(blobVersion(input), `sha256:${expected}`);
  });
}

test("a Uint8Array view with a non-zero byteOffset hashes only its own window", () => {
  const backing = new Uint8Array(200);
  for (let i = 0; i < backing.length; i++) backing[i] = (i * 7) & 0xff;
  const window = backing.subarray(37, 37 + 100);
  assert.equal(sha256HexOfBytes(window), nodeHexOfBytes(window));
  assert.notEqual(sha256HexOfBytes(window), nodeHexOfBytes(backing));
  // A pooled Node Buffer is the same shape: a view into a larger ArrayBuffer.
  const pooled = Buffer.from("pooled buffer slice");
  assert.equal(sha256HexOfBytes(pooled), nodeHexOfBytes(pooled));
});

test("blobVersion hashes raw bytes, never a UTF-8 round trip", () => {
  const invalid = new Uint8Array([0x80, 0xff, 0xfe]);
  const decodedThenEncoded = new TextEncoder().encode(new TextDecoder().decode(invalid));
  assert.notDeepEqual(Array.from(decodedThenEncoded), Array.from(invalid));
  assert.equal(blobVersion(invalid), `sha256:${nodeHexOfBytes(invalid)}`);
  assert.notEqual(blobVersion(invalid), blobVersion(decodedThenEncoded));
});

for (const fixture of ["okf-v0.2/concepts/revenue.md", "okf-v0.2/concepts/source-data.md", "okf-v0.2/index.md", "security-advisory-convention.md"]) {
  test(`contentVersion of fixture ${fixture} equals node:crypto over stringifyDoc`, async () => {
    const raw = await readFile(path.join(here, "fixtures", fixture), "utf8");
    const parsed = parseMarkdown(raw);
    const doc = { id: fixture.replace(/\.md$/, ""), frontmatter: parsed.frontmatter, body: parsed.body };
    const serialized = stringifyDoc(doc.frontmatter, doc.body);
    assert.equal(contentVersion(doc), `sha256:${nodeHexOfString(serialized)}`);
    assert.equal(versionOfBytes(raw), `sha256:${nodeHexOfString(raw)}`);
  });
}

test("contentVersion of a document with an undefined body serializes the empty body", () => {
  const doc = { id: "empty-body", frontmatter: { type: "Note", title: "Bodiless" } };
  assert.equal(contentVersion(doc), `sha256:${nodeHexOfString(stringifyDoc(doc.frontmatter, ""))}`);
});
