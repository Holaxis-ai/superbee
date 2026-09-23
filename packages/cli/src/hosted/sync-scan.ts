// The checkout folder's side of hosted sync: what the folder holds relative to the private store.
//
// The projection record (`projection.json` beside the binding) says, per document, which bytes
// the folder file was last accounted to hold (`digest`) and which store version those bytes
// correspond to (`version`). Two directions follow from it:
//
// - **Scan (import).** A file whose bytes differ from its record is a local edit: it becomes one
//   whole-document `commitLocal` in the store, or it is **held** when sync cannot send it (the
//   held backstop of the client contract, section 3.4). Held files stay as they are and nothing is
//   journaled for them. A managed-only difference is not a change.
// - **Export.** A settled store document whose version moved past its record (a pull refresh, or
//   a conflict taken from the host) is placed in the folder without overwriting anything
//   (`placeNew`, `replaceGuarded`). A file edited in between is kept as it is.
//
// A kept file is never sent as it stands. Its edit was made against the version its record names,
// not the one the host has now, so it is a **folder conflict** (`folderConflictFor`): the host
// changed or deleted the document while the file was being edited (during a sync, or while sync
// held the file). Nothing is sent for it until the person resolves it; sending it against the
// refreshed version would silently overwrite the host's change, and sending a deleted document
// as a create would silently re-create it.
import { promises as fs } from "node:fs";
import path from "node:path";

import { commitLocal, UNSETTLED_STATES, type LocalBundle } from "@superbee/browser-local";
import { assertSafeConceptId, conceptIdFromPath, InvalidInputError, isReservedFile, MalformedDocumentError, parseMarkdown, type Frontmatter, type JournaledBackend } from "@superbee/core";
import { FRONTMATTER_KEY_LIMIT, HOSTED_MANAGED_FIELDS, WHOLE_DOCUMENT_BOUNDS, wholeDocumentRequest, WholeDocumentInputError } from "@superbee/core/hosted-transport";

import { readUserStateFile, writeUserStateFileAtomic0600 } from "../user-state.js";
import { checkoutDir } from "./binding.js";
import { digestOf, placeNew, replaceGuarded, ROOT_INDEX } from "./projection.js";

export const PROJECTION_FILE = "projection.json";
const PROJECTION_SCHEMA = 2;
const PROJECTION_BYTES = 8 * 1024 * 1024;
/** The kernel's bound on a document's frontmatter, as JSON. */
export const FRONTMATTER_JSON_BYTES = 16 * 1024;
/** Folders whose documents are conventions the app edits; sync holds them. */
const HELD_PREFIXES = ["conventions/", "views/"] as const;

/** One document's accounting: the bytes the file was last known to hold, and the store version they match. */
export interface ProjectionEntry {
  readonly digest: string;
  readonly version: string;
  /** Set when the host deleted the document while the file held an edit: the file was kept. */
  readonly deleted?: true;
}

export interface ProjectionRecord {
  /** Document id to its entry. */
  files: Record<string, ProjectionEntry>;
  /** The digest of the root `index.md` as exported, or null without one. */
  root: string | null;
}

/** Why a file is held: it stays in the folder and nothing is sent for it. */
export type HeldReason =
  | "reserved_file"
  | "convention_folder"
  | "not_a_document"
  | "symlink"
  | "unsafe_path"
  | "deleted_locally"
  | "type_change"
  | "too_large"
  | "not_sendable";

export interface HeldFile {
  /** The document id, or the folder-relative path when the file is not a document. */
  readonly id: string;
  readonly path: string;
  readonly reason: HeldReason;
  readonly message: string;
}

export interface ScanReport {
  /** Documents whose edits were journaled by this scan. */
  readonly committed: string[];
  /** Documents whose only differences were managed fields. */
  readonly managedOnly: string[];
  readonly held: HeldFile[];
}

async function readProjectionJson(home: string, checkoutId: string): Promise<unknown> {
  try {
    return JSON.parse(await readUserStateFile(home, path.join(checkoutDir(home, checkoutId), PROJECTION_FILE), PROJECTION_BYTES)) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The checkout's projection record. A checkout written before sync (schema 1) recorded only the
 * exported digests; each such document was exported from the store as it still is, so its
 * version is the store's current one.
 */
export async function readProjection(home: string, checkoutId: string, store: JournaledBackend): Promise<ProjectionRecord> {
  const value = (await readProjectionJson(home, checkoutId)) as
    | { schema?: unknown; files?: unknown; root?: unknown; exported?: unknown }
    | null;
  if (value && value.schema === PROJECTION_SCHEMA && typeof value.files === "object" && value.files !== null) {
    const files: Record<string, ProjectionEntry> = {};
    for (const [id, entry] of Object.entries(value.files as Record<string, { digest?: unknown; version?: unknown }>)) {
      if (typeof entry?.digest === "string" && typeof entry.version === "string") {
        files[id] = { digest: entry.digest, version: entry.version, ...((entry as { deleted?: unknown }).deleted === true ? { deleted: true as const } : {}) };
      }
    }
    return { files, root: typeof value.root === "string" ? value.root : null };
  }
  const exported = value && value.schema === 1 && typeof value.exported === "object" && value.exported !== null ? (value.exported as Record<string, unknown>) : {};
  const versions = new Map((await store.readHeads({ project: (head) => [head.id, head.version] as const })).map(([id, version]) => [id, version]));
  const files: Record<string, ProjectionEntry> = {};
  for (const [id, digest] of Object.entries(exported)) {
    const version = versions.get(id);
    if (id !== ROOT_INDEX && typeof digest === "string" && version) files[id] = { digest, version };
  }
  return { files, root: typeof exported[ROOT_INDEX] === "string" ? (exported[ROOT_INDEX] as string) : null };
}

export async function writeProjection(home: string, checkoutId: string, record: ProjectionRecord): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(record.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await writeUserStateFileAtomic0600(home, checkoutDir(home, checkoutId), PROJECTION_FILE, `${JSON.stringify({ schema: PROJECTION_SCHEMA, files: sorted, root: record.root })}\n`);
}

/** Every file under the folder, relative and POSIX-spelled; dot-files and dot-folders are skipped. */
async function walk(folder: string, prefix = ""): Promise<{ rel: string; symlink: boolean }[]> {
  const out: { rel: string; symlink: boolean }[] = [];
  let entries;
  try {
    entries = await fs.readdir(path.join(folder, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) out.push({ rel, symlink: true });
    else if (entry.isDirectory()) out.push(...(await walk(folder, rel)));
    else if (entry.isFile()) out.push({ rel, symlink: false });
  }
  return out;
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** Frontmatter without the fields the host owns, for comparing what a person authored. */
function authored(frontmatter: Frontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(frontmatter).sort()) if (!HOSTED_MANAGED_FIELDS.has(key)) out[key] = (frontmatter as Record<string, unknown>)[key];
  return out;
}

function sameAuthored(a: { frontmatter: Frontmatter; body: string }, b: { frontmatter: Frontmatter; body: string }): boolean {
  return a.body === b.body && JSON.stringify(authored(a.frontmatter)) === JSON.stringify(authored(b.frontmatter));
}

export interface ScanContext {
  readonly folder: string;
  readonly bundleId: string;
  readonly okfVersion: "0.1" | "0.2" | undefined;
  readonly local: LocalBundle;
  readonly projection: ProjectionRecord;
  /** Scan only these document ids (the resolve path); every file otherwise. */
  readonly only?: ReadonlySet<string>;
}

function held(id: string, rel: string, reason: HeldReason, message: string): HeldFile {
  return { id, path: rel, reason, message };
}

/**
 * Why sync cannot send this document as it stands, or null. The checks mirror the kernel's
 * bounds and the transport's own refusal (`wholeDocumentRequest`), so a document the host would
 * refuse outright is held here instead of journaled and refused.
 */
export function unsendable(
  id: string,
  rel: string,
  bytes: Uint8Array,
  stored: { frontmatter: Frontmatter } | null,
  context: Pick<ScanContext, "bundleId" | "okfVersion">,
): HeldFile | null {
  if (bytes.byteLength > WHOLE_DOCUMENT_BOUNDS.payloadBytes) {
    return held(id, rel, "too_large", `'${id}' is over the ${WHOLE_DOCUMENT_BOUNDS.payloadBytes / 1024} KiB a sync write carries`);
  }
  const content = Buffer.from(bytes).toString("utf8");
  let request;
  try {
    request = wholeDocumentRequest(context.bundleId, { kind: "document.write", target: id, base: null, content }, context.okfVersion);
  } catch (error) {
    if (error instanceof WholeDocumentInputError) return held(id, rel, "not_sendable", error.message);
    throw error;
  }
  const { frontmatter } = request.payload;
  if (Buffer.byteLength(JSON.stringify(request.payload)) > WHOLE_DOCUMENT_BOUNDS.payloadBytes) {
    return held(id, rel, "too_large", `'${id}' is over the ${WHOLE_DOCUMENT_BOUNDS.payloadBytes / 1024} KiB a sync write carries`);
  }
  if (Buffer.byteLength(JSON.stringify(frontmatter)) > FRONTMATTER_JSON_BYTES || Object.keys(frontmatter).length > FRONTMATTER_KEY_LIMIT) {
    return held(id, rel, "too_large", `'${id}' has more frontmatter than the host accepts (${FRONTMATTER_JSON_BYTES / 1024} KiB, ${FRONTMATTER_KEY_LIMIT} fields)`);
  }
  const storedType = stored?.frontmatter.type;
  if (typeof storedType === "string" && storedType !== frontmatter.type) {
    return held(id, rel, "type_change", `'${id}' changes type from '${storedType}' to '${String(frontmatter.type)}', which sync cannot send`);
  }
  return null;
}

/**
 * Journal every local edit in the folder, and report every file sync holds. A committed edit
 * updates the projection record in place (the caller writes it); a held file leaves it alone, so
 * the file is held again on the next scan until it changes or the person resolves it.
 */
export async function scanCheckout(context: ScanContext): Promise<ScanReport> {
  const { folder, local, projection } = context;
  const report: ScanReport = { committed: [], managedOnly: [], held: [] };
  const seen = new Set<string>();
  for (const { rel, symlink } of await walk(folder)) {
    const isMarkdown = rel.endsWith(".md");
    const id = isMarkdown ? conceptIdFromPath(rel) : rel;
    if (context.only && !context.only.has(id)) continue;
    if (symlink) {
      report.held.push(held(id, rel, "symlink", `${rel} is a symbolic link; sync sends only plain files`));
      continue;
    }
    if (rel === ROOT_INDEX) {
      const bytes = await fs.readFile(path.join(folder, rel));
      if (digestOf(bytes) !== projection.root) report.held.push(held(rel, rel, "reserved_file", "the bundle's root index is edited in the Superbee app"));
      continue;
    }
    if (isReservedFile(rel)) {
      report.held.push(held(rel, rel, "reserved_file", `${rel} is a reserved OKF file, which sync does not send`));
      continue;
    }
    if (!isMarkdown) {
      report.held.push(held(rel, rel, "not_a_document", `${rel} is not a .md document; files other than documents do not sync`));
      continue;
    }
    try {
      assertSafeConceptId(id);
    } catch (error) {
      report.held.push(held(id, rel, "unsafe_path", `${rel} cannot be a document id (${(error as Error).message})`));
      continue;
    }
    seen.add(id);
    const file = path.join(folder, rel);
    const bytes = await fs.readFile(file);
    const digest = digestOf(bytes);
    const entry = projection.files[id];
    if (entry?.digest === digest) continue;
    // Edited against a version the host has since changed or deleted: reported as a conflict by
    // the run's closing pass, never journaled against the host's newer state.
    if ((await folderConflictFor(id, bytes, entry, local.backend)) !== null) continue;
    if (HELD_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
      report.held.push(held(id, rel, "convention_folder", `${rel} is under ${rel.split("/")[0]}/, which holds conventions edited in the Superbee app`));
      continue;
    }
    const stored = await local.backend.readWithJournal(id);
    const refusal = unsendable(id, rel, bytes, stored.document?.doc ?? null, context);
    if (refusal) {
      report.held.push(refusal);
      continue;
    }
    const parsed = parseMarkdown(bytes.toString("utf8"), id, { okfVersion: context.okfVersion });
    if (stored.document && sameAuthored(parsed, { frontmatter: stored.document.doc.frontmatter, body: stored.document.doc.body ?? "" })) {
      projection.files[id] = { digest, version: stored.document.version };
      report.managedOnly.push(id);
      continue;
    }
    let committed;
    try {
      committed = await commitLocal(local, id, {
        mode: "replace-document",
        onAbsent: "create",
        buildCandidate: () => ({ frontmatter: parsed.frontmatter, body: parsed.body }),
      });
    } catch (error) {
      // The document breaks a rule of its OKF edition: the file stays as it is, for the person to fix.
      if (error instanceof InvalidInputError || error instanceof MalformedDocumentError) {
        report.held.push(held(id, rel, "not_sendable", `'${id}' is not a valid document: ${error.message}`));
        continue;
      }
      throw error;
    }
    projection.files[id] = { digest, version: committed.version };
    if (committed.intent) report.committed.push(id);
  }
  // A recorded document whose file is gone is a local deletion, which does not sync yet.
  for (const [id, entry] of Object.entries(projection.files)) {
    if (seen.has(id) || (context.only && !context.only.has(id))) continue;
    const rel = `${id}.md`;
    if (entry.deleted) {
      // Deleted on both sides: nothing is left to decide.
      delete projection.files[id];
      continue;
    }
    if ((await readIfPresent(path.join(folder, rel))) === null) {
      report.held.push(held(id, rel, "deleted_locally", `${rel} was deleted; deleting a document does not sync yet`));
    }
  }
  return report;
}

export interface ExportReport {
  /** Documents whose file now holds the store's bytes. */
  readonly placed: string[];
  /** Documents whose file was removed because the host no longer has them. */
  readonly removed: string[];
  /** Documents whose file was edited in the meantime and so was kept; the next scan sends it. */
  readonly kept: string[];
}

/**
 * Bring the folder up to the store for every settled document whose version moved past its
 * record, and remove the files of recorded documents the store no longer holds. Never
 * overwrites: a file is replaced or removed only while it still holds its recorded bytes.
 * `only` restricts the pass to some ids; `placeMissing` lets a missing file be placed again (the
 * resolve path's "take", which is how a person discards a local deletion).
 */
export async function exportCheckout(
  folder: string,
  store: JournaledBackend,
  projection: ProjectionRecord,
  options: { only?: ReadonlySet<string>; placeMissing?: boolean } = {},
): Promise<ExportReport> {
  const report: ExportReport = { placed: [], removed: [], kept: [] };
  const unsettled = new Set((await store.listIntents(UNSETTLED_STATES)).map((row) => row.target));
  const heads = await store.readHeads({ project: (head) => ({ id: head.id, version: head.version, raw: head.raw }) });
  const present = new Set<string>();
  for (const head of heads) {
    present.add(head.id);
    if (options.only && !options.only.has(head.id)) continue;
    if (unsettled.has(head.id)) continue;
    const entry = projection.files[head.id];
    if (entry?.version === head.version) continue;
    const file = path.join(folder, `${head.id}.md`);
    const next = Buffer.from(head.raw, "utf8");
    const found = await readIfPresent(file);
    if (found === null) {
      // A recorded document whose file is gone was deleted locally: it stays gone.
      if (entry && !options.placeMissing) continue;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await assertInside(folder, file);
      const outcome = await placeNew(file, next);
      if (outcome.placed) {
        projection.files[head.id] = { digest: digestOf(next), version: head.version };
        report.placed.push(head.id);
      } else report.kept.push(head.id);
      continue;
    }
    if (!entry || digestOf(found) !== entry.digest) {
      report.kept.push(head.id);
      continue;
    }
    await assertInside(folder, file);
    const outcome = await replaceGuarded(file, found, next);
    if (outcome.placed) {
      projection.files[head.id] = { digest: digestOf(next), version: head.version };
      report.placed.push(head.id);
    } else report.kept.push(head.id);
  }
  for (const [id, entry] of Object.entries(projection.files)) {
    if (present.has(id) || (options.only && !options.only.has(id))) continue;
    const file = path.join(folder, `${id}.md`);
    const found = await readIfPresent(file);
    if (found === null) {
      delete projection.files[id];
      continue;
    }
    if (entry.deleted) continue;
    if (digestOf(found) !== entry.digest) {
      // Edited while the host deleted it: the file stays and is a conflict until resolved, never a
      // new document to the next scan.
      projection.files[id] = { ...entry, deleted: true };
      report.kept.push(id);
      continue;
    }
    if (await removeGuarded(file, found)) {
      delete projection.files[id];
      report.removed.push(id);
    } else report.kept.push(id);
  }
  return report;
}

/** Refuse a placement whose parent resolves outside the folder (a symlinked directory inside it). */
async function assertInside(folder: string, file: string): Promise<void> {
  const parent = await fs.realpath(path.dirname(file));
  if (parent !== folder && !parent.startsWith(`${folder}${path.sep}`)) {
    throw Object.assign(new Error(`${path.relative(folder, file)} resolves outside the checkout folder`), { code: "EXDEV" });
  }
}

/** Remove a file only while it holds exactly `expected`: move it aside, verify, then unlink. */
export async function removeGuarded(file: string, expected: Uint8Array): Promise<boolean> {
  const aside = path.join(path.dirname(file), `.${path.basename(file)}.superbee-del-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const found = await fs.readFile(aside);
  if (!Buffer.from(expected).equals(found)) {
    try {
      await fs.link(aside, file);
      await fs.unlink(aside);
    } catch {
      // Another file took the name: both are kept, the moved-aside bytes under their dot-name.
    }
    return false;
  }
  await fs.unlink(aside);
  return true;
}

export type FolderConflictReason = "changed_remotely" | "deleted_remotely";

/**
 * Why a file's current bytes cannot be sent as they stand, or null. A file is judged against its
 * projection record: its edit was made against the version the record names. When the store,
 * with no local change journaled for the document, has since moved to another version (a pull
 * refreshed it) or no longer has the document (the host deleted it), the host changed that
 * document concurrently with the edit: a conflict. A file with no record where the store holds
 * the document is a concurrent creation, the same conflict.
 */
export async function folderConflictFor(
  id: string,
  bytes: Uint8Array | null,
  entry: ProjectionEntry | undefined,
  store: JournaledBackend,
): Promise<FolderConflictReason | null> {
  if (bytes === null) return null;
  if (entry && !entry.deleted && digestOf(bytes) === entry.digest) return null;
  const read = await store.readWithJournal(id);
  if (read.intents.some((row) => row.state !== "acknowledged")) return null;
  if (!read.document) return entry ? "deleted_remotely" : null;
  if (!entry) return "changed_remotely";
  return entry.deleted || entry.version !== read.document.version ? "changed_remotely" : null;
}

export interface FolderConflict {
  readonly id: string;
  readonly reason: FolderConflictReason;
}

/** Every folder conflict in the checkout now: the closing pass of a run, after export and push. */
export async function folderConflicts(folder: string, store: JournaledBackend, projection: ProjectionRecord): Promise<FolderConflict[]> {
  const out: FolderConflict[] = [];
  for (const { rel, symlink } of await walk(folder)) {
    if (symlink || !rel.endsWith(".md") || isReservedFile(rel)) continue;
    const id = conceptIdFromPath(rel);
    try {
      assertSafeConceptId(id);
    } catch {
      continue;
    }
    const reason = await folderConflictFor(id, await readIfPresent(path.join(folder, rel)), projection.files[id], store);
    if (reason) out.push({ id, reason });
  }
  return out;
}
