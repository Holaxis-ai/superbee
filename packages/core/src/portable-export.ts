// The portable export archive a hosted bundle's `/sync/v1/export` answers: an ordinary OKF bundle
// directory in one store-only zip, with `superbee-export.json` at the root naming the source and
// the byte length and SHA-256 of every entry (superbee-hosted `docs/portable-bundle-export-design.md`).
//
// Verification never writes. Explicit materialization reads the archive whole before placing files:
// the end record must be there (an export the host stopped after its first byte ends without one),
// every entry must be stored, uncompressed and laid end to end with nothing hidden between them,
// every CRC and every manifest digest must match, the entries must be exactly the manifest's, and
// every path must be one a bundle can hold. A path that could escape the folder, land in a
// dot-folder (`.git` among them), or meet another path under case folding is refused, so the files
// placed from a verified archive are exactly the bundle's and nothing else.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { foldPath } from "./path-fold.js";

import {
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  assertSafeReservedFilename,
  isReservedFile,
  pathFromConceptId,
} from "./paths.js";

export const EXPORT_MANIFEST = "superbee-export.json";

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
  /** A paged export's page; absent on the whole archive (and on pages once joined). */
  readonly page?: ExportPage;
}

/** What one page of a paged export states (`page` in its manifest). */
export interface ExportPage {
  /** The inventory position of the page's first object. */
  readonly from: number;
  /** Objects the page carries. */
  readonly count: number;
  /** Objects in the whole bundle. */
  readonly total: number;
  /** The cursor of the next page; absent on the last. */
  readonly next?: string;
  /** The whole bundle's counts, as every page's manifest states them. */
  readonly counts: VerifiedExport["counts"];
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
    // One spelling per path under `foldPath`: two entries that fold together would overwrite one another.
    const key = segments.map(foldPath).join("/");
    const file = files.get(key) ?? dirs.get(key)?.by;
    if (file !== undefined) return [file, entryPath];
    files.set(key, entryPath);
    for (let depth = 1; depth < segments.length; depth += 1) {
      const spelling = segments.slice(0, depth).join("/");
      const dirKey = segments.slice(0, depth).map(foldPath).join("/");
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
export function verifyExport(archive: Uint8Array, bundleId: string, options: { readonly paged?: boolean } = {}): VerifiedExport {
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
    throw new ExportArchiveError("unsupported_format", `the export format is ${JSON.stringify(manifest.format)}; this reader accepts ${EXPORT_FORMAT}`);
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
  // A page states its place in the whole; the whole archive states none.
  let page: ExportPage | undefined;
  if (options.paged) {
    const raw = manifest.page;
    const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
    if (!isRecord(raw) || !count(raw.from) || !count(raw.count) || !count(raw.total) || (raw.next !== undefined && (typeof raw.next !== "string" || raw.next === ""))) {
      throw new ExportArchiveError("manifest_mismatch", "the page's manifest does not state its page");
    }
    if (raw.from + raw.count > raw.total || (raw.next === undefined) !== (raw.from + raw.count === raw.total) || (raw.next !== undefined && raw.count === 0)) {
      throw new ExportArchiveError("manifest_mismatch", "the page's manifest states a page outside the bundle");
    }
    page = {
      from: raw.from,
      count: raw.count,
      total: raw.total,
      ...(raw.next !== undefined ? { next: raw.next } : {}),
      counts: { documents: counts.documents as number, reserved: counts.reserved as number, blobs: counts.blobs as number },
    };
  } else if (manifest.page !== undefined) {
    throw new ExportArchiveError("manifest_mismatch", "the archive is one page, not the whole bundle");
  }

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
  if (page) {
    // A page's `counts` are the whole bundle's: the page holds its own count, and the pages are
    // checked against `counts` once joined (`joinExportPages`).
    if (entries.length !== page.count) throw new ExportArchiveError("manifest_mismatch", "the page holds a different number of entries than it states");
  } else if (tally.documents !== counts.documents || tally.reserved !== counts.reserved || tally.blobs !== counts.blobs) {
    throw new ExportArchiveError("manifest_mismatch", "the manifest's counts do not match the archive");
  }
  const collision = findEntryCollision(entries.map((entry) => entry.path));
  if (collision) {
    throw new ExportArchiveError("unsafe_path", `the archive holds paths one folder cannot keep apart: ${JSON.stringify(collision[0])} and ${JSON.stringify(collision[1])}`);
  }
  return rememberVerified({
    source: { tenantId: source.tenantId, bundleId: source.bundleId, revision: source.revision as number, okfEdition: source.okfEdition as string | null },
    exportedAt: manifest.exportedAt,
    counts: tally,
    entries,
    bytes,
    ...(page ? { page } : {}),
  }, [{ sha256: sha256Hex(manifests[0]!.data), bytes: manifests[0]!.data.byteLength }], archive.byteLength);
}

/**
 * The pages of one paged export, checked as each arrives and joined once the last has: every page
 * must name the first page's source (one revision, one edition), state the same whole (its total,
 * at most an export's entries, and its counts), start where the one before ended, and only the
 * last may name no next page. So a host that repeats or skips a page is refused at that page, and
 * a run of pages is at most `total` long. Joined, the pages must hold every object once, add up to
 * the bundle's counts, and keep every path apart from the others in one folder.
 */
export class ExportPageChain {
  readonly #pages: VerifiedExport[] = [];
  #from = 0;
  #ended = false;
  #archiveBytes = 0;

  /** Adds the next page; answers its next cursor, or undefined once the export is whole. */
  add(verified: VerifiedExport): string | undefined {
    exportProvenance(verified);
    const state = verifiedStates.get(verified)!;
    const accepted = state.snapshot;
    const page = accepted.page;
    const first = this.#pages[0] ?? accepted;
    if (!page || !first.page || this.#ended) throw new ExportArchiveError("manifest_mismatch", "a paged export answered a page outside its run");
    const counts = first.page.counts;
    if (
      accepted.source.tenantId !== first.source.tenantId ||
      accepted.source.bundleId !== first.source.bundleId ||
      accepted.source.revision !== first.source.revision ||
      accepted.source.okfEdition !== first.source.okfEdition ||
      page.counts.documents !== counts.documents ||
      page.counts.reserved !== counts.reserved ||
      page.counts.blobs !== counts.blobs ||
      page.total !== first.page.total ||
      page.total !== counts.documents + counts.reserved + counts.blobs ||
      page.total > MAX_EXPORT_ENTRIES - 1
    ) {
      throw new ExportArchiveError("manifest_mismatch", "the pages do not describe one export of one revision");
    }
    if (page.from !== this.#from) throw new ExportArchiveError("manifest_mismatch", "the pages leave a gap or overlap");
    // Charge exact ZIP bytes, including headers and manifests, before retaining another page.
    if (state.archiveBytes > MAX_EXPORT_BYTES - this.#archiveBytes) throw malformed("the pages are larger than an export carries");
    this.#archiveBytes += state.archiveBytes;
    this.#pages.push(accepted);
    this.#from += page.count;
    if (page.next === undefined) this.#ended = true;
    return page.next;
  }

  /** The whole bundle, as one archive would have carried it. */
  joined(): VerifiedExport {
    const first = this.#pages[0];
    if (!first?.page || !this.#ended) throw new ExportArchiveError("manifest_mismatch", "the pages end before the last");
    const { counts } = first.page;
    const entries: ArchiveEntry[] = [];
    const tally = { documents: 0, reserved: 0, blobs: 0 };
    let bytes = 0;
    for (const verified of this.#pages) {
      for (const entry of verified.entries) {
        entries.push({ ...entry, bytes: Uint8Array.from(entry.bytes) });
        tally[entry.kind === "document" ? "documents" : entry.kind === "reserved" ? "reserved" : "blobs"] += 1;
        bytes += entry.bytes.byteLength;
      }
    }
    if (this.#from !== first.page.total || entries.length !== first.page.total) throw new ExportArchiveError("manifest_mismatch", "the pages do not add up to the bundle");
    if (tally.documents !== counts.documents || tally.reserved !== counts.reserved || tally.blobs !== counts.blobs) {
      throw new ExportArchiveError("manifest_mismatch", "the manifest's counts do not match the pages");
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.path)) throw new ExportArchiveError("manifest_mismatch", `the pages hold ${entry.path} twice`);
      seen.add(entry.path);
    }
    const collision = findEntryCollision(entries.map((entry) => entry.path));
    if (collision) {
      throw new ExportArchiveError("unsafe_path", `the archive holds paths one folder cannot keep apart: ${JSON.stringify(collision[0])} and ${JSON.stringify(collision[1])}`);
    }
    return rememberVerified({ source: { ...first.source }, exportedAt: first.exportedAt, counts: tally, entries, bytes }, this.#pages.flatMap((verified) => exportProvenance(verified).manifests), this.#archiveBytes);
  }
}

/** Join the verified pages of one paged export ({@link ExportPageChain}). */
export function joinExportPages(pages: readonly VerifiedExport[]): VerifiedExport {
  const chain = new ExportPageChain();
  for (const page of pages) chain.add(page);
  return chain.joined();
}

/** Exact transport evidence, kept outside any materialized OKF bundle. */
export interface ExportProvenance {
  readonly source: ExportSource;
  readonly exportedAt: string;
  /** SHA-256 and byte length of each accepted raw manifest, in page order. */
  readonly manifests: readonly { readonly sha256: string; readonly bytes: number }[];
  /** SHA-256 of UTF-8 JSON for path-sorted {path,kind,bytes,sha256} inventory rows. */
  readonly inventorySha256: string;
}

interface VerifiedState {
  readonly fingerprint: string;
  readonly archiveBytes: number;
  readonly snapshot: VerifiedExport;
  readonly provenance: ExportProvenance;
}
const verifiedStates = new WeakMap<VerifiedExport, VerifiedState>();

function inventoryOf(verified: VerifiedExport) {
  return verified.entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    bytes: entry.bytes.byteLength,
    sha256: sha256Hex(entry.bytes),
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function fingerprintOf(verified: VerifiedExport): string {
  return JSON.stringify({ source: verified.source, exportedAt: verified.exportedAt,
    counts: verified.counts, bytes: verified.bytes, page: verified.page,
    entries: verified.entries.map((entry) => ({ path: entry.path, kind: entry.kind,
      bytes: entry.bytes.byteLength, sha256: sha256Hex(entry.bytes) })),
  });
}

function rememberVerified(verified: VerifiedExport, manifests: ExportProvenance["manifests"], archiveBytes: number): VerifiedExport {
  const snapshot: VerifiedExport = {
    source: { ...verified.source }, exportedAt: verified.exportedAt, counts: { ...verified.counts },
    entries: verified.entries.map((entry) => ({ ...entry, bytes: Uint8Array.from(entry.bytes) })), bytes: verified.bytes,
    ...(verified.page ? { page: { ...verified.page, counts: { ...verified.page.counts } } } : {}),
  };
  const state: VerifiedState = {
    snapshot, archiveBytes,
    fingerprint: fingerprintOf(verified),
    provenance: {
      source: { ...verified.source }, exportedAt: verified.exportedAt,
      manifests: manifests.map((manifest) => ({ ...manifest })),
      inventorySha256: sha256Hex(new TextEncoder().encode(JSON.stringify(inventoryOf(verified)))),
    },
  };
  verifiedStates.set(verified, state);
  verifiedStates.set(snapshot, state);
  return verified;
}

/** Evidence for an accepted handle; refuses forged or subsequently mutated values. */
export function exportProvenance(verified: VerifiedExport): ExportProvenance {
  const state = verifiedStates.get(verified);
  if (!state || state.fingerprint !== fingerprintOf(verified)) {
    throw new ExportArchiveError("manifest_mismatch", "the verified export handle is absent or changed");
  }
  return { ...state.provenance, source: { ...state.provenance.source },
    manifests: state.provenance.manifests.map((manifest) => ({ ...manifest })),
  };
}

/**
 * Materialize a complete verified export in a fresh private child of an existing caller-owned
 * parent. Returns only after every file is written. The caller owns cleanup of the returned
 * directory and must keep that parent private while using the result. No target is overwritten,
 * no transport metadata is written, and failure removes only this call's newly created child.
 */
export async function materializeExport(verified: VerifiedExport, parentDirectory: string): Promise<string> {
  exportProvenance(verified);
  const accepted = verifiedStates.get(verified)!.snapshot;
  if (accepted.page) throw new ExportArchiveError("manifest_mismatch", "one page is not a complete export");
  if (![null, "0.1", "0.2"].includes(accepted.source.okfEdition)) {
    throw new ExportArchiveError("unsupported_format", "the exported OKF edition is not supported");
  }
  // Snapshot before the first await: caller mutation cannot change the files written below.
  const entries = accepted.entries;
  const parent = await realpath(parentDirectory);
  const folder = await mkdtemp(path.join(parent, ".superbee-verified-export-"));
  try {
    for (const entry of entries) {
      const file = path.join(folder, ...entry.path.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, entry.bytes, { flag: "wx", mode: 0o600 });
    }
    return folder;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
