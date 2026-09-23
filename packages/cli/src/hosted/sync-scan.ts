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
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { commitLocal, deleteLocal, UNSETTLED_STATES, type LocalBundle } from "@superbee/browser-local";
import { DOCUMENT_DELETE_KIND } from "@superbee/core/journaled-backend";
import { assertSafeConceptId, conceptIdFromPath, InvalidInputError, isReservedFile, MalformedDocumentError, parseLinksFromDoc, parseMarkdown, type Frontmatter, type JournaledBackend } from "@superbee/core";
import { FRONTMATTER_KEY_LIMIT, HOSTED_MANAGED_FIELDS, WHOLE_DOCUMENT_BOUNDS, wholeDocumentRequest, WholeDocumentInputError } from "@superbee/core/hosted-transport";

import { readUserStateFile, writeUserStateFileAtomic0600 } from "../user-state.js";
import { checkoutDir } from "./binding.js";
import { digestOf, ensureParentInside, fold, parentUnsafe, placeNew, PLACEMENT_TEMP, replaceGuarded, ROOT_INDEX, UnsafePlacementError } from "./projection.js";

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
  /**
   * Document id to the digest of local bytes a `--resolve take` is replacing, recorded before the
   * replacement starts. A crash mid-take can leave those bytes moved aside; recovery drops them
   * because the person already chose to discard them. Cleared by the next recovery.
   */
  discarded?: Record<string, string>;
}

/** Why a file is held: it stays in the folder and nothing is sent for it. */
export type HeldReason =
  | "reserved_file"
  | "convention_folder"
  | "not_a_document"
  | "symlink"
  | "unsafe_path"
  | "deleted_locally"
  | "bulk_deletion"
  | "type_change"
  | "too_large"
  | "not_sendable"
  | "case_collision";

export interface HeldFile {
  /** The document id, or the folder-relative path when the file is not a document. */
  readonly id: string;
  readonly path: string;
  readonly reason: HeldReason;
  readonly message: string;
}

/** A document whose file was deleted and whose deletion this scan journaled, with the documents that still link to it. */
export interface ScannedDeletion {
  readonly id: string;
  /** Documents in the checkout whose body links to it; the deletion does not change them (the host never cascades). */
  readonly inbound: string[];
}

/**
 * The mass-delete hold. Deletions are counted over a window, not per sync, so batches cannot
 * walk around it, and from the journal, so a crash after the host accepted a delete never
 * forgets it:
 *
 *   D = this scan's new deletions
 *     + delete intents not yet settled
 *     + delete intents the host acknowledged in the last {@link DELETION_WINDOW_MS}
 *     (only those recorded after the last explicit `--accept-deletes`)
 *   B = the documents the checkout held when the window opened (its first counted delete), frozen
 *       for the window, so files created meanwhile never dilute it; before that, the projection's
 *       documents at the start of the scan (never files new in this scan) + the counted deletes
 *
 * This scan's new deletions are held, as a whole, when `2·D > B` and `D ≥ min(3, B)`. A held set
 * is recorded, keyed by its documents: while any of them is still deleted, every deletion stays
 * held whatever the counts do, until the person accepts exactly that set (`--accept-deletes
 * <n>:<digest>`, printed with the hold, for an agent to run only on the person's confirmation) or
 * restores the files (`--restore-deletes`). An acceptance closes the window.
 */
export const MIN_HELD_DELETIONS = 3;
export const DELETION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The store meta row that carries the hold's window. */
export const DELETION_WINDOW_KEY = "cli-deletion-window";

export interface DeletionWindow {
  /** Deletes recorded before this instant were admitted by an explicit acceptance and never count. */
  acceptedAt: string | null;
  /** The baseline frozen when the window opened, or null while it is closed. */
  baseline: number | null;
  /** The deletions held and not yet accepted or restored, with the token that accepts them. */
  hold: { ids: string[]; token: string } | null;
}

export async function readDeletionWindow(store: JournaledBackend): Promise<DeletionWindow> {
  const raw = await store.readMeta<Partial<DeletionWindow>>(DELETION_WINDOW_KEY);
  const hold = raw?.hold && Array.isArray(raw.hold.ids) && typeof raw.hold.token === "string" ? { ids: raw.hold.ids.filter((id): id is string => typeof id === "string"), token: raw.hold.token } : null;
  return {
    acceptedAt: typeof raw?.acceptedAt === "string" ? raw.acceptedAt : null,
    baseline: typeof raw?.baseline === "number" && Number.isSafeInteger(raw.baseline) ? raw.baseline : null,
    hold,
  };
}

/**
 * What the window holds, read from the journal:
 * - `counted`: delete intents unsettled, or acknowledged within the window (a clock set back keeps
 *   counting them), recorded after the last acceptance, and not of a document this checkout
 *   itself created within the window;
 * - `created`: documents this checkout created within the window (an acknowledged create). They
 *   never join the baseline, and deleting them again never counts: removing what the checkout
 *   added today takes nothing that was in the bundle before.
 */
export async function deletionWindowStats(store: JournaledBackend, window: DeletionWindow, now = Date.now()): Promise<{ counted: number; created: Map<string, string> }> {
  const rows = await store.listIntents([...UNSETTLED_STATES, "acknowledged"]);
  const recent = (row: (typeof rows)[number]) => row.state !== "acknowledged" || now - Date.parse(row.updatedAt) < DELETION_WINDOW_MS;
  const created = new Map<string, string>();
  for (const row of rows) {
    if (row.state === "acknowledged" && row.kind !== DOCUMENT_DELETE_KIND && row.base === null && recent(row)) {
      if (!created.has(row.target) || created.get(row.target)! > row.createdAt) created.set(row.target, row.createdAt);
    }
  }
  const counted = rows.filter((row) => {
    if (row.kind !== DOCUMENT_DELETE_KIND || !recent(row)) return false;
    if (window.acceptedAt !== null && row.createdAt <= window.acceptedAt) return false;
    const since = created.get(row.target);
    return !(since !== undefined && since < row.createdAt);
  }).length;
  return { counted, created };
}

/** The token that accepts exactly this set of held deletions: its count and a digest of its sorted ids. */
export function acceptToken(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return `${sorted.length}:${createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 12)}`;
}

/** The hold's decision for `fresh` new deletions against the window; see {@link MIN_HELD_DELETIONS}. */
export function deletionHold(fresh: number, baseline: number, counted: number, frozen: number | null = null): { held: boolean; deletions: number; baseline: number } {
  const deletions = fresh + counted;
  const total = counted > 0 && frozen !== null ? Math.min(frozen, baseline + counted) : baseline + counted;
  return { held: fresh > 0 && deletions * 2 > total && deletions >= Math.min(MIN_HELD_DELETIONS, total), deletions, baseline: total };
}

/** A mass delete this scan held, with what releases it. */
export interface DeletionHold {
  /** The new deletions held, and the token `--accept-deletes` must name to send exactly them. */
  readonly count: number;
  readonly ids: string[];
  readonly token: string;
  /** True when the set is held because an earlier hold on these documents is still pending. */
  readonly pending: boolean;
  /** Deletions in the window, this scan's included, and the baseline they are counted against. */
  readonly deletions: number;
  readonly baseline: number;
  /** Set when `--accept-deletes` named another set. */
  readonly acceptMismatch?: string;
}

export interface ScanReport {
  /** Documents whose edits were journaled by this scan. */
  readonly committed: string[];
  /** Set when this scan's deletions were held as a mass delete. */
  hold?: DeletionHold;
  /** Set when `--accept-deletes` admitted this many held deletions. */
  accepted?: number;
  /** Documents whose file deletion this scan journaled as a delete. */
  readonly deleted: ScannedDeletion[];
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
    const discarded: Record<string, string> = {};
    const rawDiscarded = (value as { discarded?: unknown }).discarded;
    if (typeof rawDiscarded === "object" && rawDiscarded !== null) {
      for (const [id, digest] of Object.entries(rawDiscarded as Record<string, unknown>)) if (typeof digest === "string") discarded[id] = digest;
    }
    return { files, root: typeof value.root === "string" ? value.root : null, ...(Object.keys(discarded).length > 0 ? { discarded } : {}) };
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

/**
 * True when every document file in the folder holds exactly the bytes the projection records and
 * no recorded file is missing: nothing a sync would send. Reads only; files sync never sends
 * (not `.md`, dot-files) are ignored.
 */
export async function folderMatchesProjection(folder: string, projection: ProjectionRecord): Promise<boolean> {
  const seen = new Set<string>();
  for (const entry of await walk(folder)) {
    if (!entry.rel.endsWith(".md")) continue;
    if (entry.symlink) return false;
    const bytes = await readIfPresent(path.join(folder, entry.rel));
    if (bytes === null) return false;
    if (entry.rel === ROOT_INDEX) {
      if (digestOf(bytes) !== projection.root) return false;
      continue;
    }
    const id = conceptIdFromPath(entry.rel);
    seen.add(id);
    const recorded = projection.files[id];
    if (!recorded || recorded.deleted || digestOf(bytes) !== recorded.digest) return false;
  }
  return Object.entries(projection.files).every(([id, entry]) => entry.deleted === true || seen.has(id));
}

export async function writeProjection(home: string, checkoutId: string, record: ProjectionRecord): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(record.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await writeUserStateFileAtomic0600(home, checkoutDir(home, checkoutId), PROJECTION_FILE, `${JSON.stringify({ schema: PROJECTION_SCHEMA, files: sorted, root: record.root, ...(record.discarded && Object.keys(record.discarded).length > 0 ? { discarded: record.discarded } : {}) })}\n`);
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

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The file's text, or null when its bytes are not UTF-8 (sending them would change what they say). */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** True when the file says exactly what the store's document says (managed fields aside). */
function sameAsStored(bytes: Uint8Array, id: string, doc: { frontmatter: Frontmatter; body?: string } | undefined, okfVersion?: "0.1" | "0.2"): boolean {
  if (!doc) return false;
  const text = utf8(bytes);
  if (text === null) return false;
  try {
    return sameAuthored(parseMarkdown(text, id, { okfVersion }), { frontmatter: doc.frontmatter, body: doc.body ?? "" });
  } catch {
    return false;
  }
}

/** A path spelling folded as a case-insensitive, normalizing filesystem equates it. */
function foldedPath(id: string): string {
  return id.split("/").map(fold).join("/");
}

export interface ScanContext {
  readonly folder: string;
  readonly bundleId: string;
  readonly okfVersion: "0.1" | "0.2" | undefined;
  readonly local: LocalBundle;
  readonly projection: ProjectionRecord;
  /** Scan only these document ids (the resolve path); every file otherwise. */
  readonly only?: ReadonlySet<string>;
  /** The person's `--accept-deletes <n>:<digest>`: admits held deletions when it names exactly their set. */
  readonly acceptDeletes?: string;
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
  const content = utf8(bytes);
  if (content === null) return held(id, rel, "not_sendable", `'${id}' is not UTF-8 text; sending it would change its bytes`);
  let request;
  try {
    request = wholeDocumentRequest(context.bundleId, { kind: "document.write", target: id, base: null, content }, context.okfVersion);
  } catch (error) {
    if (error instanceof WholeDocumentInputError) return held(id, rel, "not_sendable", error.message);
    throw error;
  }
  // A `document.write` is never a delete; the narrowing says so to the type checker.
  if (request.kind === "delete") throw new Error(`'${id}' became a delete request`);
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
  const report: ScanReport = { committed: [], deleted: [], managedOnly: [], held: [] };
  const seen = new Set<string>();
  // The baseline is what the checkout held before this scan: files new in it never dilute the hold.
  const baselineIds = Object.entries(projection.files).filter(([, entry]) => !entry.deleted).map(([id]) => id);
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
    if (entry && !entry.deleted && entry.digest === digest) continue;
    const stored = await local.backend.readWithJournal(id);
    // The file already says what the store holds (a crash after placing it, or a managed-only
    // edit): nothing to send; the record catches up.
    if (stored.document && sameAsStored(bytes, id, stored.document.doc, context.okfVersion)) {
      projection.files[id] = { digest, version: stored.document.version };
      report.managedOnly.push(id);
      continue;
    }
    // Edited against a version the host has since changed or deleted: reported as a conflict by
    // the run's closing pass, never journaled against the host's newer state.
    if ((await folderConflictFor(id, bytes, entry, local.backend, context.okfVersion)) !== null) continue;
    if (!entry && !stored.document) {
      const twin = (await caseTwins(local.backend, projection)).get(foldedPath(id));
      if (twin !== undefined && twin !== id) {
        report.held.push(held(id, rel, "case_collision", `'${id}' differs only in letter case from '${twin}', which a case-insensitive disk treats as the same file`));
        continue;
      }
    }
    if (HELD_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
      report.held.push(held(id, rel, "convention_folder", `${rel} is under ${rel.split("/")[0]}/, which holds conventions edited in the Superbee app`));
      continue;
    }
    const refusal = unsendable(id, rel, bytes, stored.document?.doc ?? null, context);
    if (refusal) {
      report.held.push(refusal);
      continue;
    }
    const parsed = parseMarkdown(utf8(bytes)!, id, { okfVersion: context.okfVersion });
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
  // A recorded document whose file is gone is a local deletion: a delete of exactly the version
  // the file held, compare-and-swap on the host.
  const deletions: { id: string; rel: string; version: string }[] = [];
  for (const [id, entry] of Object.entries(projection.files)) {
    if (seen.has(id) || (context.only && !context.only.has(id))) continue;
    const rel = `${id}.md`;
    if ((await readIfPresent(path.join(folder, rel))) !== null) continue;
    const stored = await local.backend.readWithJournal(id);
    if (entry.deleted || !stored.document) {
      // Deleted on both sides: nothing is left to decide.
      delete projection.files[id];
      continue;
    }
    if (stored.intents.some((row) => row.state === "conflict")) {
      report.held.push(held(id, rel, "deleted_locally", `${rel} was deleted while '${id}' has a conflict to resolve; resolve it first`));
      continue;
    }
    if (stored.document.version !== entry.version) {
      // The store moved past the version the file held (a pull refreshed it while the file was
      // gone): the person deleted a version the host no longer has. Deleting the newer one would
      // remove a change they never saw, so the host's version is placed back instead.
      delete projection.files[id];
      report.held.push(held(id, rel, "deleted_locally", `${rel} was deleted, but the host changed '${id}' since; its current version is placed back in the folder, and deleting the file again deletes it`));
      continue;
    }
    deletions.push({ id, rel, version: entry.version });
  }
  const window = await readDeletionWindow(local.backend);
  const { counted, created } = await deletionWindowStats(local.backend, window);
  const baseline = baselineIds.filter((id) => !created.has(id)).length;
  // Deleting what this checkout created within the window never counts, and is never held.
  const counting = deletions.filter(({ id }) => !created.has(id));
  const decision = deletionHold(counting.length, baseline, counted, window.baseline);
  const pendingHold = window.hold !== null && counting.some(({ id }) => window.hold!.ids.includes(id));
  const token = acceptToken(counting.map(({ id }) => id));
  const holding = counting.length > 0 && (pendingHold || decision.held);
  const accepting = holding && context.acceptDeletes === token;
  if (holding && !accepting) {
    const ids = counting.map(({ id }) => id).sort();
    await local.backend.writeMeta(DELETION_WINDOW_KEY, { ...window, hold: { ids, token } } satisfies DeletionWindow);
    report.hold = { count: counting.length, ids, token, pending: pendingHold && !decision.held, deletions: decision.deletions, baseline: decision.baseline, ...(context.acceptDeletes !== undefined ? { acceptMismatch: context.acceptDeletes } : {}) };
    for (const { id, rel } of counting) {
      report.held.push(held(id, rel, "bulk_deletion", `${rel} is one of ${counting.length} files deleted and held: with the deletes of the last day that is ${decision.deletions} of the ${decision.baseline} documents${pendingHold && !decision.held ? " (held since an earlier sync)" : ""}, so none is sent. Put the files back with sync --restore-deletes; removing them from the bundle needs the person's explicit confirmation (see deletions_held)`));
    }
    // Deleting what the checkout created today is not part of the hold; it goes out as usual.
    const heldIds = new Set(ids);
    deletions.splice(0, deletions.length, ...deletions.filter(({ id }) => !heldIds.has(id)));
  }
  if (!report.hold && (counting.length > 0 || window.hold !== null)) {
    // Opening the window freezes its baseline; an acceptance, or a hold whose files came back, closes it.
    const opening = counted === 0 && counting.length > 0 && !accepting;
    const next: DeletionWindow = { acceptedAt: window.acceptedAt, baseline: accepting ? null : opening ? baseline : window.baseline, hold: null };
    await local.backend.writeMeta(DELETION_WINDOW_KEY, next satisfies DeletionWindow);
  }
  const admitted: string[] = [];
  for (const { id, rel, version } of deletions) {
    try {
      const journaled = await deleteLocal(local, id, { expectedVersion: version });
      if (journaled.intent) admitted.push(journaled.intent.requestId);
    } catch (error) {
      if (error instanceof InvalidInputError) {
        report.held.push(held(id, rel, "deleted_locally", `${rel} was deleted, but sync cannot delete '${id}' now: ${error.message}`));
        continue;
      }
      throw error;
    }
    delete projection.files[id];
    report.deleted.push({ id, inbound: [] });
  }
  if (accepting) {
    // An explicit acceptance admits the whole window and starts a new one. It is written after the
    // deletes are journaled: a crash in between leaves them counted, which only holds more.
    await local.backend.writeMeta(DELETION_WINDOW_KEY, { acceptedAt: new Date().toISOString(), baseline: null, hold: null } satisfies DeletionWindow);
    report.accepted = admitted.length;
  }
  const inbound = await inboundLinks(local.backend, report.deleted.map((row) => row.id), context.okfVersion);
  for (const row of report.deleted) row.inbound.push(...(inbound.get(row.id) ?? []));
  return report;
}

/**
 * The documents the store holds that link to each of `ids`. The host never checks or cascades
 * links, so a person deleting a linked document is warned, never refused (design binding
 * decision 2).
 */
export async function inboundLinks(store: JournaledBackend, ids: Iterable<string>, okfVersion?: "0.1" | "0.2"): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>([...ids].map((id) => [id, []]));
  if (byId.size === 0) return byId;
  const rows = await store.readHeads({ project: (head) => ({ id: head.id, raw: head.raw }) });
  for (const { id, raw } of rows) {
    let links;
    try {
      const parsed = parseMarkdown(raw, id, { okfVersion });
      links = parseLinksFromDoc({ id, frontmatter: parsed.frontmatter, body: parsed.body });
    } catch {
      continue;
    }
    for (const link of links) {
      const inbound = byId.get(link.to);
      if (inbound && link.to !== id && !inbound.includes(id)) inbound.push(id);
    }
  }
  for (const inbound of byId.values()) inbound.sort();
  return byId;
}

export interface ExportReport {
  /** Documents whose file now holds the store's bytes. */
  readonly placed: string[];
  /** Documents whose file was removed because the host no longer has them. */
  readonly removed: string[];
  /** Documents whose file was edited in the meantime and so was kept, as it is. */
  readonly kept: string[];
  /** Host documents the folder cannot hold as they are (a case twin, or a symbolic link on the way). */
  readonly held: HeldFile[];
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
  const report: ExportReport = { placed: [], removed: [], kept: [], held: [] };
  const unsettled = new Set((await store.listIntents(UNSETTLED_STATES)).map((row) => row.target));
  const heads = await store.readHeads({ project: (head) => ({ id: head.id, version: head.version, raw: head.raw }) });
  const twins = await caseTwins(store, projection);
  const present = new Set<string>();
  for (const head of heads) {
    present.add(head.id);
    if (options.only && !options.only.has(head.id)) continue;
    if (unsettled.has(head.id)) continue;
    const entry = projection.files[head.id];
    if (entry && !entry.deleted && entry.version === head.version) continue;
    const rel = `${head.id}.md`;
    const file = path.join(folder, rel);
    if (!entry) {
      const twin = twins.get(foldedPath(head.id));
      if (twin !== undefined && twin !== head.id) {
        report.held.push(held(head.id, rel, "case_collision", `the host's '${head.id}' differs only in letter case from '${twin}', which a case-insensitive disk treats as the same file; rename one in the Superbee app`));
        continue;
      }
    }
    if (await parentUnsafe(folder, file)) {
      report.held.push(held(head.id, rel, "unsafe_path", `${rel} is under a symbolic link or a file, so sync does not place it`));
      continue;
    }
    const next = Buffer.from(head.raw, "utf8");
    const found = await readIfPresent(file);
    if (found !== null && digestOf(found) === digestOf(next)) {
      // Already placed (a run that stopped before recording it): the record catches up.
      projection.files[head.id] = { digest: digestOf(next), version: head.version };
      continue;
    }
    if (found === null) {
      // A recorded document whose file is gone was deleted locally: it stays gone.
      if (entry && !entry.deleted && !options.placeMissing) continue;
      try {
        await ensureParentInside(folder, file);
      } catch (error) {
        if (!(error instanceof UnsafePlacementError)) throw error;
        report.held.push(held(head.id, rel, "unsafe_path", error.message));
        continue;
      }
      const outcome = await placeNew(file, next);
      if (outcome.placed) {
        projection.files[head.id] = { digest: digestOf(next), version: head.version };
        report.placed.push(head.id);
      } else report.kept.push(head.id);
      continue;
    }
    if (!entry || entry.deleted || digestOf(found) !== entry.digest) {
      report.kept.push(head.id);
      continue;
    }
    const outcome = await replaceGuarded(file, found, next);
    if (outcome.placed) {
      projection.files[head.id] = { digest: digestOf(next), version: head.version };
      report.placed.push(head.id);
    } else report.kept.push(head.id);
  }
  for (const [id, entry] of Object.entries(projection.files)) {
    if (present.has(id) || (options.only && !options.only.has(id))) continue;
    const file = path.join(folder, `${id}.md`);
    if (await parentUnsafe(folder, file)) continue;
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
  okfVersion?: "0.1" | "0.2",
): Promise<FolderConflictReason | null> {
  if (bytes === null) return null;
  if (entry && !entry.deleted && digestOf(bytes) === entry.digest) return null;
  const read = await store.readWithJournal(id);
  if (read.intents.some((row) => row.state !== "acknowledged")) return null;
  if (!read.document) return entry ? "deleted_remotely" : null;
  // A file that already says what the store holds is in sync, whatever its record says.
  if (sameAsStored(bytes, id, read.document.doc, okfVersion)) return null;
  if (!entry) return "changed_remotely";
  return entry.deleted || entry.version !== read.document.version ? "changed_remotely" : null;
}

export interface FolderConflict {
  readonly id: string;
  readonly reason: FolderConflictReason;
}

/** Every folder conflict in the checkout now: the closing pass of a run, after export and push. */
export async function folderConflicts(folder: string, store: JournaledBackend, projection: ProjectionRecord, okfVersion?: "0.1" | "0.2"): Promise<FolderConflict[]> {
  const out: FolderConflict[] = [];
  for (const { rel, symlink } of await walk(folder)) {
    if (symlink || !rel.endsWith(".md") || isReservedFile(rel)) continue;
    const id = conceptIdFromPath(rel);
    try {
      assertSafeConceptId(id);
    } catch {
      continue;
    }
    if (await parentUnsafe(folder, path.join(folder, rel))) continue;
    const reason = await folderConflictFor(id, await readIfPresent(path.join(folder, rel)), projection.files[id], store, okfVersion);
    if (reason) out.push({ id, reason });
  }
  return out;
}

/** Every document spelling the store and the record know, by its case-folded path. */
async function caseTwins(store: JournaledBackend, projection: ProjectionRecord): Promise<Map<string, string>> {
  const twins = new Map<string, string>();
  for (const id of Object.keys(projection.files)) twins.set(foldedPath(id), id);
  for (const id of await store.readHeads({ project: (head) => head.id })) if (!twins.has(foldedPath(id))) twins.set(foldedPath(id), id);
  return twins;
}

/** Every file under the folder whose name is a placement temp, relative; symlinked folders are not entered. */
async function placementTemps(folder: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(path.join(folder, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory() && !entry.name.startsWith(".")) out.push(...(await placementTemps(folder, rel)));
    else if (entry.isFile() && PLACEMENT_TEMP.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Finish or undo a placement a crash interrupted, under the checkout lock, before anything reads
 * the folder. Every temp holds bytes that are either reproducible (a staged `new` copy of store
 * bytes) or a file's own bytes moved aside (`pre` for a replacement, `del` for a removal):
 * - a staged copy is dropped;
 * - moved-aside bytes go back under their name when the name is free, except that a removal of
 *   exactly the recorded bytes is completed instead (the document was deleted on the host);
 * - when the name is taken, moved-aside bytes that match it or the record are dropped, and so are
 *   bytes a `--resolve take` recorded as discarded; any other bytes are kept where they are, never
 *   deleted.
 * The discard records are cleared afterwards: a take the crash interrupted is either complete now
 * or its file is back, and the conflict still stands.
 */
export async function recoverPlacements(folder: string, projection: ProjectionRecord): Promise<void> {
  for (const rel of await placementTemps(folder)) {
    const temp = path.join(folder, rel);
    const [, name, label] = PLACEMENT_TEMP.exec(path.basename(rel))!;
    const target = path.join(path.dirname(temp), name!);
    if (label === "new") {
      await fs.unlink(temp).catch(() => {});
      continue;
    }
    const aside = await fs.readFile(temp);
    const relTarget = path.relative(folder, target).split(path.sep).join("/");
    const entry = relTarget.endsWith(".md") ? projection.files[conceptIdFromPath(relTarget)] : undefined;
    const recorded = entry !== undefined && digestOf(aside) === entry.digest;
    const discarded = relTarget.endsWith(".md") && projection.discarded?.[conceptIdFromPath(relTarget)] === digestOf(aside);
    const current = await readIfPresent(target);
    if (current === null) {
      if (label === "del" && recorded) {
        await fs.unlink(temp);
        continue;
      }
      try {
        await fs.link(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      await fs.unlink(temp);
      continue;
    }
    if (recorded || discarded || Buffer.from(current).equals(aside)) await fs.unlink(temp);
  }
  delete projection.discarded;
}
