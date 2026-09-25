// The portable export archive a hosted bundle's `/sync/v1/export` answers: an ordinary OKF bundle
// directory in one store-only zip, with `superbee-export.json` at the root naming the source and
// the byte length and SHA-256 of every entry (superbee-hosted `docs/portable-bundle-export-design.md`).
//
// Nothing here writes. The archive is read whole, then verified before a single file is placed:
// the end record must be there (an export the host stopped after its first byte ends without one),
// every entry must be stored, uncompressed and laid end to end with nothing hidden between them,
// every CRC and every manifest digest must match, the entries must be exactly the manifest's, and
// every path must be one a bundle can hold. A path that could escape the folder, land in a
// dot-folder (`.git` among them), or meet another path under case folding is refused, so the files
// placed from a verified archive are exactly the bundle's and nothing else.
import { createHash } from "node:crypto";

import {
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  assertSafeReservedFilename,
  isReservedFile,
  pathFromConceptId,
} from "@superbee/core";

export const EXPORT_MANIFEST = "superbee-export.json";

/**
 * Where `export --in-place` stages the files it adds, with its journal, inside the checkout folder:
 * a dot-folder, so the sync scan and the bundle walk never read it.
 */
export const IN_PLACE_STAGING = ".superbee-export-partial";
export const IN_PLACE_JOURNAL = "journal.json";
export const EXPORT_FORMAT = "superbee-export/1";

/** The host's own bounds (20,000 objects, 64 MiB stored), plus room for headers and the manifest. */
export const MAX_EXPORT_ENTRIES = 20_001;
export const MAX_EXPORT_BYTES = 128 * 1024 * 1024;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_NAMES = 0x0800;

/** Why an archive was refused: `incomplete` is an export the host stopped; the rest are contract failures. */
export type ArchiveProblem = "incomplete" | "malformed" | "unsafe_path" | "manifest_mismatch" | "wrong_bundle" | "unsupported_format";

export class ExportArchiveError extends Error {
  override readonly name = "ExportArchiveError";
  readonly problem: ArchiveProblem;
  constructor(problem: ArchiveProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

export type EntryKind = "document" | "reserved" | "blob";

export interface ArchiveEntry {
  /** The bundle-relative path the entry is placed at. */
  readonly path: string;
  readonly kind: EntryKind;
  readonly bytes: Uint8Array;
}

export interface ExportSource {
  readonly tenantId: string;
  readonly bundleId: string;
  readonly revision: number;
  readonly okfEdition: string | null;
}

export interface VerifiedExport {
  readonly source: ExportSource;
  readonly exportedAt: string;
  readonly counts: { readonly documents: number; readonly reserved: number; readonly blobs: number };
  /** Every entry but the manifest, in archive order. */
  readonly entries: readonly ArchiveEntry[];
  /** Stored bytes, the manifest excluded. */
  readonly bytes: number;
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

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function malformed(message: string): ExportArchiveError {
  return new ExportArchiveError("malformed", message);
}

interface RawEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * The entries of a store-only zip, strictly: one end record at the very end, a central directory
 * that ends where it starts it, and local records laid end to end from offset zero, each stored,
 * uncompressed, with no data descriptor and a matching CRC.
 */
export function readStoredZip(archive: Uint8Array): RawEntry[] {
  if (archive.byteLength > MAX_EXPORT_BYTES) throw malformed("the archive is larger than an export carries");
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.byteLength - 22;
  if (end < 0 || view.getUint32(end, true) !== END) {
    throw new ExportArchiveError("incomplete", "the export ended before its central directory: the host stopped it part way");
  }
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw malformed("a multi-disk archive");
  const count = view.getUint16(end + 8, true);
  if (count !== view.getUint16(end + 10, true)) throw malformed("the end record's counts disagree");
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 20, true) !== 0) throw malformed("an archive comment");
  if (directoryOffset + directorySize !== end) throw malformed("the central directory does not end at the end record");
  if (count > MAX_EXPORT_ENTRIES) throw malformed("more entries than an export carries");

  const entries: RawEntry[] = [];
  let central = directoryOffset;
  let expectedLocal = 0;
  for (let index = 0; index < count; index += 1) {
    if (central + 46 > end || view.getUint32(central, true) !== CENTRAL) throw malformed("a truncated central directory");
    const flags = view.getUint16(central + 8, true);
    const method = view.getUint16(central + 10, true);
    const crc = view.getUint32(central + 16, true);
    const compressed = view.getUint32(central + 20, true);
    const size = view.getUint32(central + 24, true);
    const nameLength = view.getUint16(central + 28, true);
    const extraLength = view.getUint16(central + 30, true);
    const commentLength = view.getUint16(central + 32, true);
    const localOffset = view.getUint32(central + 42, true);
    if ((flags & ~UTF8_NAMES) !== 0) throw malformed("an entry with flags a stored export never sets");
    if (extraLength !== 0 || commentLength !== 0) throw malformed("an entry with extra fields or a comment");
    if (method !== 0 || compressed !== size) throw malformed("a compressed entry");
    const nameEnd = central + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > end) throw malformed("a truncated central directory");
    const nameBytes = archive.subarray(central + 46, nameEnd);
    central = nameEnd + extraLength + commentLength;

    if (localOffset !== expectedLocal) throw malformed("entries that are not laid end to end");
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== LOCAL) throw malformed("a missing local header");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (
      localFlags !== flags ||
      localMethod !== 0 ||
      view.getUint32(localOffset + 14, true) !== crc ||
      view.getUint32(localOffset + 18, true) !== size ||
      view.getUint32(localOffset + 22, true) !== size ||
      localNameLength !== nameLength ||
      localExtraLength !== 0
    ) {
      throw malformed("a local header that disagrees with the central directory");
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + size;
    if (dataEnd > directoryOffset) throw malformed("an entry that runs into the central directory");
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (Buffer.compare(Buffer.from(localName), Buffer.from(nameBytes)) !== 0) throw malformed("a local name that disagrees with the central directory");
    const data = archive.subarray(dataStart, dataEnd);
    if (crc32(data) !== crc) throw malformed("an entry whose CRC does not match its bytes");
    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      throw malformed("an entry name that is not UTF-8");
    }
    entries.push({ name, data });
    expectedLocal = dataEnd;
  }
  if (central !== end) throw malformed("the central directory holds more than its entries");
  if (expectedLocal !== directoryOffset) throw malformed("bytes between the last entry and the central directory");
  return entries;
}

const WINDOWS_DEVICE_NAMES = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

/** One spelling per path under NFC and case folding: two entries that fold together would overwrite one another. */
const fold = (segment: string) => segment.normalize("NFC").toLowerCase();

/** What an archive path is in a bundle, or an `unsafe_path` refusal. The core guards decide. */
export function classifyEntryPath(entryPath: string): EntryKind {
  const unsafe = (why: string) => new ExportArchiveError("unsafe_path", `the archive holds a path a bundle cannot keep (${why}): ${JSON.stringify(entryPath.slice(0, 200))}`);
  if (entryPath === "" || entryPath.length > 4096) throw unsafe("empty or too long");
  const segments = entryPath.split("/");
  for (const segment of segments) {
    // Dot-folders are invisible to the bundle walk, and `.git` among them would be Git's own.
    if (segment.startsWith(".")) throw unsafe("a dot-prefixed segment");
    if (segment.endsWith(".") || segment.endsWith(" ")) throw unsafe("a segment ending in a dot or a space");
    if (WINDOWS_DEVICE_NAMES.has(segment.split(".")[0]!.toUpperCase())) throw unsafe("a reserved device name");
  }
  try {
    if (isReservedFile(entryPath)) {
      const name = segments.at(-1)!;
      assertSafeReservedFilename(name);
      assertSafeReservedDir(segments.slice(0, -1).join("/"));
      return "reserved";
    }
    if (entryPath.endsWith(".md")) {
      const id = entryPath.slice(0, -3);
      assertSafeConceptId(id);
      if (pathFromConceptId(id) !== entryPath) throw new Error("not canonical");
      return "document";
    }
    assertSafeBlobKey(entryPath);
    return "blob";
  } catch (error) {
    throw unsafe(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The first two paths that one folder cannot hold apart: the same file under folding, a file where
 * a folder must be, or one folder spelled two ways (a case-insensitive disk would merge them, and
 * the files in it would no longer be at the paths their ids name).
 */
export function findEntryCollision(paths: readonly string[]): readonly [string, string] | null {
  const files = new Map<string, string>();
  /** Folded folder path to its spelling and the entry that first needed it. */
  const dirs = new Map<string, { spelling: string; by: string }>();
  for (const entryPath of paths) {
    const segments = entryPath.split("/");
    const key = segments.map(fold).join("/");
    const file = files.get(key) ?? dirs.get(key)?.by;
    if (file !== undefined) return [file, entryPath];
    files.set(key, entryPath);
    for (let depth = 1; depth < segments.length; depth += 1) {
      const spelling = segments.slice(0, depth).join("/");
      const dirKey = segments.slice(0, depth).map(fold).join("/");
      const asFile = files.get(dirKey);
      if (asFile !== undefined) return [asFile, entryPath];
      const seen = dirs.get(dirKey);
      if (seen === undefined) dirs.set(dirKey, { spelling, by: entryPath });
      else if (seen.spelling !== spelling) return [seen.by, entryPath];
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verify a whole export archive for `bundleId` and return its entries. Any failure is an
 * {@link ExportArchiveError}; nothing is returned for an archive that is not complete and exact.
 */
export function verifyExport(archive: Uint8Array, bundleId: string): VerifiedExport {
  const raw = readStoredZip(archive);
  const manifests = raw.filter((entry) => entry.name === EXPORT_MANIFEST);
  if (manifests.length !== 1) throw new ExportArchiveError("manifest_mismatch", `the archive holds ${manifests.length} manifests`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(utf8.decode(manifests[0]!.data));
  } catch {
    throw new ExportArchiveError("manifest_mismatch", "the manifest is not JSON");
  }
  if (!isRecord(manifest)) throw new ExportArchiveError("manifest_mismatch", "the manifest is not an object");
  if (manifest.format !== EXPORT_FORMAT) {
    throw new ExportArchiveError("unsupported_format", `the export format is ${JSON.stringify(manifest.format)}; this CLI reads ${EXPORT_FORMAT}`);
  }
  const source = manifest.source;
  const counts = manifest.counts;
  const listed = manifest.entries;
  if (
    !isRecord(source) ||
    typeof source.tenantId !== "string" ||
    typeof source.bundleId !== "string" ||
    !Number.isSafeInteger(source.revision) ||
    !(source.okfEdition === null || typeof source.okfEdition === "string") ||
    typeof manifest.exportedAt !== "string" ||
    !isRecord(counts) ||
    ![counts.documents, counts.reserved, counts.blobs].every((n) => Number.isSafeInteger(n) && (n as number) >= 0) ||
    !Array.isArray(listed)
  ) {
    throw new ExportArchiveError("manifest_mismatch", "the manifest is missing a field");
  }
  if (source.bundleId !== bundleId) throw new ExportArchiveError("wrong_bundle", `the export is of '${source.bundleId}', not '${bundleId}'`);

  const digests = new Map<string, { bytes: number; sha256: string }>();
  for (const row of listed) {
    if (!isRecord(row) || typeof row.path !== "string" || !Number.isSafeInteger(row.bytes) || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      throw new ExportArchiveError("manifest_mismatch", "a manifest entry is malformed");
    }
    if (digests.has(row.path)) throw new ExportArchiveError("manifest_mismatch", `the manifest lists ${row.path} twice`);
    digests.set(row.path, { bytes: row.bytes as number, sha256: row.sha256 });
  }

  const entries: ArchiveEntry[] = [];
  const tally = { documents: 0, reserved: 0, blobs: 0 };
  let bytes = 0;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry.name === EXPORT_MANIFEST) continue;
    if (seen.has(entry.name)) throw new ExportArchiveError("manifest_mismatch", `the archive holds ${entry.name} twice`);
    seen.add(entry.name);
    const kind = classifyEntryPath(entry.name);
    const digest = digests.get(entry.name);
    if (!digest) throw new ExportArchiveError("manifest_mismatch", `the archive holds ${entry.name}, which the manifest does not list`);
    if (digest.bytes !== entry.data.byteLength || digest.sha256 !== sha256Hex(entry.data)) {
      throw new ExportArchiveError("manifest_mismatch", `${entry.name} does not match its manifest digest`);
    }
    tally[kind === "document" ? "documents" : kind === "reserved" ? "reserved" : "blobs"] += 1;
    bytes += entry.data.byteLength;
    entries.push({ path: entry.name, kind, bytes: entry.data });
  }
  for (const listedPath of digests.keys()) {
    if (!seen.has(listedPath)) throw new ExportArchiveError("manifest_mismatch", `the manifest lists ${listedPath}, which the archive does not hold`);
  }
  if (tally.documents !== counts.documents || tally.reserved !== counts.reserved || tally.blobs !== counts.blobs) {
    throw new ExportArchiveError("manifest_mismatch", "the manifest's counts do not match the archive");
  }
  const collision = findEntryCollision(entries.map((entry) => entry.path));
  if (collision) {
    throw new ExportArchiveError("unsafe_path", `the archive holds paths one folder cannot keep apart: ${JSON.stringify(collision[0])} and ${JSON.stringify(collision[1])}`);
  }
  return {
    source: { tenantId: source.tenantId, bundleId: source.bundleId, revision: source.revision as number, okfEdition: source.okfEdition as string | null },
    exportedAt: manifest.exportedAt,
    counts: tally,
    entries,
    bytes,
  };
}
