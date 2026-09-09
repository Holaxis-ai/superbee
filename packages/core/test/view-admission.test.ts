import test from "node:test";
import assert from "node:assert/strict";
import { admitActiveView, MAX_ACTIVE_VIEW_BYTES, ACTIVE_VIEW_CONTENT_TYPE } from "../src/view-admission.js";

// One row table owns byte-format behavior; other surfaces forward this primitive.
const enc = new TextEncoder();
const rows = [
  { name: "plain HTML", bytes: enc.encode("<h1>Hello</h1>"), type: "text/html", valid: true },
  { name: "empty", bytes: new Uint8Array(), type: "text/html", valid: true },
  { name: "exact limit", bytes: new Uint8Array(MAX_ACTIVE_VIEW_BYTES).fill(32), type: "text/html", valid: true },
  { name: "oversized", bytes: new Uint8Array(MAX_ACTIVE_VIEW_BYTES + 1), type: "text/html", valid: false },
  { name: "quoted charset and casing", bytes: enc.encode("é"), type: ' TEXT/HTML ; CHARSET="UTF-8" ', valid: true },
  { name: "empty parameters", bytes: enc.encode("x"), type: "text/html;;", valid: true },
  { name: "repeated allowed charset", bytes: enc.encode("x"), type: 'text/html;charset=utf-8;charset="utf-8"', valid: true },
  { name: "wrong MIME", bytes: enc.encode("x"), type: "text/plain", valid: false },
  { name: "non-UTF8 charset", bytes: enc.encode("x"), type: "text/html;charset=latin1", valid: false },
  { name: "unknown parameter", bytes: enc.encode("x"), type: "text/html;boundary=x", valid: false },
  { name: "malformed UTF8", bytes: new Uint8Array([0xc3, 0x28]), type: "text/html", valid: false },
  { name: "UTF8 surrogate encoding", bytes: new Uint8Array([0xed, 0xa0, 0x80]), type: "text/html", valid: false },
  { name: "BOM preserved", bytes: new Uint8Array([0xef, 0xbb, 0xbf, 120]), type: "text/html", valid: true },
];
for (const row of rows) test(`View byte admission: ${row.name}`, () => {
  if (!row.valid) { assert.throws(() => admitActiveView(row.bytes, row.type)); return; }
  const admitted = admitActiveView(row.bytes, row.type);
  assert.equal(admitted.contentType, ACTIVE_VIEW_CONTENT_TYPE);
  assert.deepEqual(admitted.bytes, row.bytes);
  assert.notEqual(admitted.bytes, row.bytes);
  assert.notEqual(admitted.bytes.buffer, row.bytes.buffer);
});

test("admitted Uint8Array bytes do not alias caller mutations", () => {
  const bytes = enc.encode("original"), result = admitActiveView(bytes, "text/html");
  bytes.fill(0);
  assert.equal(new TextDecoder().decode(result.bytes), "original");
});
