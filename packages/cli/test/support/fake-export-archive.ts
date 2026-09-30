// The hosted portable export archive, written the way superbee-hosted's `src/portable-export.ts`
// writes it (at PR 650, merged as ff3f2858): a store-only zip with UTF-8 names, version 2.0, the
// export instant as the MS-DOS time of every entry, reserved files first (sorted by `dir/name`),
// then documents, then blobs, and `superbee-export.json` last, whose entries are sorted by path.
// The fake host serves it for `/sync/v1/export`, and `hosted-fake-contract.test.ts` holds it byte
// for byte to the archive the real gateway answered.
import { createHash } from "node:crypto";

import { compareStorageKeys, isReservedFile, parseMarkdown } from "@superbee/core";

export interface ExportState {
  readonly tenantId: string;
  readonly bundleId: string;
  readonly revision: number;
  /** Bundle-relative path to stored bytes: documents, reserved files and blobs together. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, at.getUTCFullYear()));
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | Math.max(1, at.getUTCDate());
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  return { time, date };
}

function fields(length: number) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const api = {
    bytes,
    u16(value: number) {
      view.setUint16(at, value, true);
      at += 2;
      return api;
    },
    u32(value: number) {
      view.setUint32(at, value >>> 0, true);
      at += 4;
      return api;
    },
    raw(value: Uint8Array) {
      bytes.set(value, at);
      at += value.byteLength;
      return api;
    },
  };
  return api;
}

const UTF8_NAMES = 0x0800;
const VERSION = 20;

export interface ZipEntryInput {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A store-only zip of these entries, in this order, exactly as the host lays one out. */
export function storedZip(entries: readonly ZipEntryInput[], at: Date): Uint8Array {
  const stamp = dosDateTime(at);
  const parts: Uint8Array[] = [];
  const records: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.byteLength;
    const header = fields(30 + name.byteLength).u32(0x04034b50).u16(VERSION).u16(UTF8_NAMES).u16(0).u16(stamp.time).u16(stamp.date).u32(crc).u32(size).u32(size).u16(name.byteLength).u16(0).raw(name).bytes;
    records.push({ name, crc, size, offset });
    parts.push(header, entry.bytes);
    offset += header.byteLength + size;
  }
  const directoryOffset = offset;
  for (const record of records) {
    const central = fields(46 + record.name.byteLength)
      .u32(0x02014b50)
      .u16(VERSION)
      .u16(VERSION)
      .u16(UTF8_NAMES)
      .u16(0)
      .u16(stamp.time)
      .u16(stamp.date)
      .u32(record.crc)
      .u32(record.size)
      .u32(record.size)
      .u16(record.name.byteLength)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(record.offset)
      .raw(record.name).bytes;
    parts.push(central);
    offset += central.byteLength;
  }
  parts.push(fields(22).u32(0x06054b50).u16(0).u16(0).u16(records.length).u16(records.length).u32(offset - directoryOffset).u32(directoryOffset).u16(0).bytes);
  return Buffer.concat(parts);
}

function declaredEdition(root: Uint8Array | undefined): string | null {
  if (!root) return null;
  try {
    const value = parseMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(root), "index.md").frontmatter.okf_version;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** The archive entries (manifest last) for a bundle state, in the host's order. */
export function exportEntries(state: ExportState, exportedAt: Date): ZipEntryInput[] {
  const reservedKey = (file: string) => {
    const slash = file.lastIndexOf("/");
    return slash < 0 ? `/${file}` : `${file.slice(0, slash)}/${file.slice(slash + 1)}`;
  };
  const paths = [...state.files.keys()];
  const reserved = paths.filter((file) => isReservedFile(file)).sort((a, b) => compareStorageKeys(reservedKey(a), reservedKey(b)));
  const documents = paths.filter((file) => file.endsWith(".md") && !isReservedFile(file)).sort((a, b) => compareStorageKeys(a.slice(0, -3), b.slice(0, -3)));
  const blobs = paths.filter((file) => !file.endsWith(".md")).sort(compareStorageKeys);
  const ordered = [...reserved, ...documents, ...blobs];
  const manifest = {
    format: "superbee-export/1",
    source: { tenantId: state.tenantId, bundleId: state.bundleId, revision: state.revision, okfEdition: declaredEdition(state.files.get("index.md")) },
    exportedAt: exportedAt.toISOString(),
    counts: { documents: documents.length, reserved: reserved.length, blobs: blobs.length },
    entries: ordered
      .map((file) => ({ path: file, bytes: state.files.get(file)!.byteLength, sha256: createHash("sha256").update(state.files.get(file)!).digest("hex") }))
      .sort((a, b) => compareStorageKeys(a.path, b.path)),
  };
  return [
    ...ordered.map((file) => ({ name: file, bytes: state.files.get(file)! })),
    { name: "superbee-export.json", bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
  ];
}

export function exportArchive(state: ExportState, exportedAt: Date): Uint8Array {
  return storedZip(exportEntries(state, exportedAt), exportedAt);
}
