// Writes a document record into a closed FileJournaledBackend store, bypassing the write path, so a
// test can hold bytes the store's writes now refuse: what a store kept from before a limit existed.
// The frame is the store's documented log layout (`file-journaled-backend.ts`, "framing").
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

const HEADER = 44;
const RECORD_MAGIC = 0x53424a52;
const SNAPSHOT_MAGIC = 0x53424a53;

function frameFields(bytes: Buffer, at: number): { format: number; txn: number; end: number } {
  const length = bytes.readUInt32BE(at + 8);
  const end = at + HEADER + length;
  const payload = JSON.parse(bytes.subarray(at + HEADER, end).toString("utf8")) as unknown[];
  const txn = payload[payload.indexOf("txn") + 1];
  if (typeof txn !== "number") throw new TypeError("a store frame without a transaction number");
  return { format: bytes.readUInt32BE(at + 4), txn, end };
}

export async function plantStoredDocument(directory: string, id: string, raw: string, version: string): Promise<void> {
  let txn = 0;
  let format = 3;
  const snapshot = path.join(directory, "store.snapshot");
  if (existsSync(snapshot)) {
    const bytes = await readFile(snapshot);
    if (bytes.readUInt32BE(0) !== SNAPSHOT_MAGIC) throw new TypeError("not a store snapshot");
    ({ txn, format } = frameFields(bytes, 0));
  }
  const log = path.join(directory, "store.log");
  const bytes = existsSync(log) ? await readFile(log) : Buffer.alloc(0);
  for (let at = 0; at < bytes.byteLength; ) {
    const fields = frameFields(bytes, at);
    if (fields.txn > txn) ({ txn, format } = fields);
    at = fields.end;
  }
  const value = ["O", "raw", raw, "version", version, "updatedBy", "person:someone", "updatedAt", "2026-01-01T00:00:00.000Z"];
  const change = ["O", "family", "document", "key", id, "value", value];
  const payload = Buffer.from(JSON.stringify(["O", "format", format, "txn", txn + 1, "changes", ["A", change]]), "utf8");
  const header = Buffer.alloc(HEADER);
  header.writeUInt32BE(RECORD_MAGIC, 0);
  header.writeUInt32BE(format, 4);
  header.writeUInt32BE(payload.byteLength, 8);
  createHash("sha256").update(payload).digest().copy(header, 12);
  await appendFile(log, Buffer.concat([header, payload]));
}
