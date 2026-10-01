// The plan `superbee publish --to hosted` shows and sends (hosted `docs/person-bundle-create.md`):
// the whole bundle as one `bundles.create.v1` request when it fits that request's bounds, and
// otherwise as a staged creation (a manifest, parts of about 1 MiB, raw blobs, then commits; the
// "Staged creation" section there), every bound the host enforces checked here first, and what
// will not travel. Reads the folder and local Git only.
//
// What travels:
//   documents       every `.md` file that is not a reserved file, as `{id, frontmatter, body}`
//   reserved        `index.md` and `log.md` at any level, as their exact text
//   blobs           every other plain file, with a content type from its extension (base64 in
//                   the one-shot request, raw bytes in a staged creation)
//   history         with `--with-history` on a Git board: each earlier Git version of each document,
//                   labeled `imported:git/<commit>` and unverified (Mike's decision D2)
// What does not: dot-files and dot-folders (`.git`, the checkout marker), symbolic links, and
// anything that is not a regular file. A document the host would refuse blocks the plan, and so does
// a Kind problem the host would refuse later writes over.
import { promises as fs } from "node:fs";
import path from "node:path";

import { readDocBytesAtRef, runGit } from "@superbee/board-git";
import {
  assertSafeBlobKey,
  blobVersion,
  assertSafeConceptId,
  buildKindRegistry,
  conceptIdFromPath,
  CONVENTION_TYPE,
  CONVENTIONS_PREFIX,
  InvalidInputError,
  isReservedFile,
  KindConformanceError,
  MalformedDocumentError,
  matchesFilter,
  MemoryBackend,
  OkfActorError,
  parseMarkdown,
  prepareDocumentMutationCandidate,
  readBundleOkfVersion,
  stringifyDoc,
  type OkfDocument,
} from "@superbee/core";
import { wholeDocumentRequest, WholeDocumentInputError } from "@superbee/core/hosted-transport";
import { versionOfBytes } from "@superbee/core/versioning";

import type { GitBoardFacts } from "../bundle-home.js";
import { digestOf, findPathCollision, fold } from "./projection.js";
import { unsendable, utf8 } from "./sync-scan.js";
import { stripHostText } from "@superbee/core";

const MiB = 1024 * 1024;

/** The host's bounds for one creation in one request (hosted `src/person-bundle-create.ts`). */
export const PUBLISH_BOUNDS = Object.freeze({
  objects: 1500,
  documents: 1000,
  reserved: 1000,
  blobs: 100,
  history: 1000,
  reservedBytes: 64 * 1024,
  blobBytes: 1_000_000,
  requestBytes: 3 * MiB,
});

/**
 * The host's bounds for a staged creation (hosted `src/person-bundle-stage.ts`,
 * `PERSON_BUNDLE_STAGE_BOUNDS`): a bundle past {@link PUBLISH_BOUNDS} is sent this way. Per
 * document, frontmatter and reserved file the bounds are the one-shot's. Byte totals count each
 * distinct version once, as the host does.
 */
export const STAGED_PUBLISH_BOUNDS = Object.freeze({
  documents: 10_000,
  reserved: 1_000,
  blobs: 1_000,
  history: 5_000,
  blobBytes: 16 * MiB,
  currentBytes: 64 * MiB,
  historyBytes: 64 * MiB,
  manifestBytes: 3 * MiB,
  /** The host's cap on one part's body; parts are packed to {@link partTargetBytes}. */
  partBytes: 3 * MiB,
  partTargetBytes: 1 * MiB,
  partObjects: 500,
  parts: 400,
});

export interface CreateDocument {
  readonly id: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}
export interface CreateReserved {
  readonly dir: string;
  readonly name: string;
  readonly content: string;
}
/** One file that is not a document, as the plan holds it. */
export interface PlannedBlob {
  readonly key: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}
export interface CreateHistory {
  readonly documentId: string;
  readonly label: string;
  readonly author: string;
  readonly authoredAt: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/** One reason the plan cannot be sent, naming the file. */
export interface PublishBlocker {
  readonly path: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * How the plan travels: `one-shot`, one `bundle-create` request, when it fits
 * {@link PUBLISH_BOUNDS}; `staged` otherwise, with `why` naming the first one-shot bound it passes.
 */
export type PublishPath = { readonly mode: "one-shot" } | { readonly mode: "staged"; readonly why: string };

export interface PublishPlan {
  readonly documents: CreateDocument[];
  readonly reserved: CreateReserved[];
  readonly blobs: PlannedBlob[];
  readonly history: CreateHistory[];
  readonly path: PublishPath;
  /** Files that stay in the folder and are not sent: dot-files, links, anything but a plain file. */
  readonly skipped: { path: string; reason: string }[];
  readonly blockers: PublishBlocker[];
  /** `current-only` (no history sent), `git` (imported rows planned), or why history cannot be sent. */
  readonly historyPlan: { mode: "current-only" | "git"; versions: number; skipped: number; note: string };
  /**
   * Folder files that travel but that a checkout does not hold as documents (blobs, reserved files
   * other than the root index), with their digests: after conversion sync leaves them be while
   * they are unchanged.
   */
  readonly extras: Record<string, string>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
};

function contentTypeOf(rel: string): string {
  return CONTENT_TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
}

function digest(bytes: Uint8Array): string {
  return digestOf(bytes);
}

/** Every entry under the folder; dot-entries are reported as skipped, never descended into. */
async function walkAll(folder: string, prefix = "", out: { rel: string; kind: "file" | "link" | "other" | "dot" }[] = []) {
  const entries = await fs.readdir(path.join(folder, prefix), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name.startsWith(".")) out.push({ rel, kind: "dot" });
    else if (entry.isSymbolicLink()) out.push({ rel, kind: "link" });
    else if (entry.isDirectory()) await walkAll(folder, rel, out);
    else if (entry.isFile()) out.push({ rel, kind: "file" });
    else out.push({ rel, kind: "other" });
  }
  return out;
}

/** How a hosted write prepares a candidate against its Kind (superbee-hosted `HOSTED_KIND_WRITE`). */
const HOSTED_KIND_WRITE = Object.freeze({ strict: true, persistActor: true, producer: "process:superbee-hosted" } as const);

/** The host refuses control and format characters (bidi overrides, zero-width) in an author. */
function cleanAuthor(author: string): string {
  // The host bounds it at 200 UTF-16 units.
  return stripHostText(author, 200) || "unknown";
}

interface HistoryOptions {
  readonly board: GitBoardFacts;
  readonly now: number;
}

/** Earlier Git versions of one document, oldest first, as import rows (the current version excluded). */
function gitVersions(board: GitBoardFacts, id: string, rel: string, current: string, okfVersion: "0.1" | "0.2" | undefined, now: number): { rows: CreateHistory[]; skipped: number } {
  const repoPath = board.prefix === "" ? rel : `${board.prefix}/${rel}`;
  const log = runGit(board.top, ["log", "--no-renames", "--format=%H%x1f%an <%ae>%x1f%aI", "HEAD", "--", repoPath]);
  if (log.status !== 0) return { rows: [], skipped: 0 };
  const rows: CreateHistory[] = [];
  let skipped = 0;
  let previous = current;
  for (const line of log.stdout.split("\n").filter(Boolean)) {
    const [sha, author, authoredAt] = line.split("\x1f");
    if (!sha || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) continue;
    const bytes = readDocBytesAtRef(board.top, sha, repoPath);
    if (bytes === null) continue; // deleted at that commit
    const text = utf8(bytes);
    if (text === null || text === previous) continue;
    previous = text;
    const when = Date.parse(authoredAt ?? "");
    if (!Number.isFinite(when) || when > now) {
      skipped += 1;
      continue;
    }
    if (unsendable(id, rel, bytes, null, { bundleId: "publish", okfVersion })) {
      skipped += 1;
      continue;
    }
    let parsed;
    try {
      parsed = parseMarkdown(text, id, { okfVersion });
    } catch {
      skipped += 1;
      continue;
    }
    rows.push({
      documentId: id,
      label: `imported:git/${sha}`,
      author: cleanAuthor(author ?? ""),
      authoredAt: new Date(when).toISOString(),
      frontmatter: parsed.frontmatter as Record<string, unknown>,
      body: parsed.body ?? "",
    });
  }
  // The host numbers imported versions oldest first, in the order sent.
  return { rows: rows.reverse(), skipped };
}

/**
 * The edition the root index declares, read by core's own `readBundleOkfVersion` (as
 * superbee-hosted `rootIndexEdition` reads it): undefined when it declares none (a write then uses
 * 0.1), `unsupported` for an `okf_version` other than 0.1 or 0.2 or root frontmatter that does not
 * parse, which no hosted write can use.
 */
async function okfVersionOf(rootIndex: string | null): Promise<"0.1" | "0.2" | "unsupported" | undefined> {
  if (rootIndex === null) return undefined;
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", rootIndex);
  let version: string | undefined;
  try {
    version = await readBundleOkfVersion({ root: "/edition", backend });
  } catch (error) {
    if (error instanceof MalformedDocumentError) return "unsupported";
    throw error;
  }
  if (version === undefined) return undefined;
  return version === "0.1" || version === "0.2" ? version : "unsupported";
}

const FORMAT_AT_EDGE = /^\p{Cf}|\p{Cf}$/u;
const FORMAT_INSIDE = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * The host's canonical spelling for a new document id (superbee-hosted
 * `packages/agent-operations/src/document-ids.ts`), mirrored so a folder the host would refuse
 * blocks before any request: no segment starts or ends with whitespace or a format character
 * (Unicode Cf, such as U+200B), no segment holds a format character other than ZERO WIDTH
 * NON-JOINER or ZERO WIDTH JOINER, and the id is NFC.
 */
function isHostCanonicalId(id: string): boolean {
  return (
    id.split("/").every((segment) => segment === segment.trim() && !FORMAT_AT_EDGE.test(segment) && !FORMAT_INSIDE.test(segment)) &&
    id === id.normalize("NFC")
  );
}

/**
 * Kind problems that would make the created bundle refuse edits, found with the rules of
 * superbee-hosted `packages/agent-operations/src/kind-conformance.ts` (`bundleKindFindings`), which
 * `bundles.create.v1` also applies: every hosted write refuses while the Kind registry has a
 * warning, and prepares its candidate strictly against the document's Kind. The registry is built
 * as `loadKinds` builds it, and each document is prepared as its first hosted edit, so a timestamp
 * or actor the write supplies is not a problem. Mirrored here because the host pins a released
 * core.
 */
function kindBlockers(documents: readonly CreateDocument[], okfVersion: "0.1" | "0.2" | undefined): PublishBlocker[] {
  // As the host will store them: serialized, then parsed back.
  const docs: OkfDocument[] = documents.map((doc) => ({ id: doc.id, ...parseMarkdown(stringifyDoc(doc.frontmatter as OkfDocument["frontmatter"], doc.body), doc.id) }));
  const ids = new Set(docs.map((doc) => doc.id));
  const registry = buildKindRegistry(docs.filter((doc) => matchesFilter(doc, { prefix: CONVENTIONS_PREFIX, type: CONVENTION_TYPE })), [], { okfVersion });
  const blockers: PublishBlocker[] = registry.warnings.map((warning) => ({
    path: warning.field !== undefined && ids.has(warning.field) ? `${warning.field}.md` : CONVENTIONS_PREFIX,
    reason: "kind_convention",
    message: `${warning.message}; the host refuses every write while a Kind convention has a problem`,
  }));
  for (const doc of docs) {
    try {
      // Its first edit: the stored document as the existing one and a body one line longer, so
      // unchanged values keep the leniency an edit gives them.
      prepareDocumentMutationCandidate(doc, { frontmatter: doc.frontmatter, body: `${doc.body ?? ""}\n` }, {
        ...HOSTED_KIND_WRITE,
        id: doc.id,
        registry,
        okfVersion: okfVersion ?? "0.1",
        // Stands in for the creating person, whom the preview does not know; only its presence matters.
        actor: "person:publish-preview",
      });
    } catch (error) {
      if (error instanceof KindConformanceError) {
        blockers.push({ path: `${doc.id}.md`, reason: "kind_conformance", message: `${error.message}; the host refuses edits to it until it does` });
        continue;
      }
      // Other input errors are not Kind problems; the checks above and the host own them.
      if (error instanceof InvalidInputError && !(error instanceof OkfActorError)) continue;
      throw error;
    }
  }
  return blockers;
}

/**
 * Read the bundle folder into a creation plan. `history` asks for Git history; it is planned only
 * for a Git board, and a local bundle's plan says `current-only`.
 */
export async function planPublish(folder: string, options: { history: false } | ({ history: true } & Partial<HistoryOptions>)): Promise<PublishPlan> {
  const documents: CreateDocument[] = [];
  const reserved: CreateReserved[] = [];
  const blobs: PlannedBlob[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const blockers: PublishBlocker[] = [];
  const extras: Record<string, string> = {};
  const documentFiles: { id: string; rel: string; text: string }[] = [];

  const entries = await walkAll(folder);
  let rootIndex: string | null = null;
  try {
    rootIndex = utf8(await fs.readFile(path.join(folder, "index.md")));
  } catch {
    rootIndex = null;
  }
  const edition = await okfVersionOf(rootIndex);
  const okfVersion = edition === "unsupported" ? undefined : edition;
  for (const entry of entries) {
    if (entry.kind === "dot") {
      skipped.push({ path: entry.rel, reason: "dot-file or dot-folder" });
      continue;
    }
    if (entry.kind === "link") {
      skipped.push({ path: entry.rel, reason: "symbolic link" });
      continue;
    }
    if (entry.kind === "other") {
      skipped.push({ path: entry.rel, reason: "not a plain file" });
      continue;
    }
    const bytes = await fs.readFile(path.join(folder, entry.rel));
    if (isReservedFile(entry.rel)) {
      const text = utf8(bytes);
      if (text === null) {
        blockers.push({ path: entry.rel, reason: "not_utf8", message: `${entry.rel} is a reserved file that is not UTF-8 text` });
        continue;
      }
      if (bytes.byteLength > PUBLISH_BOUNDS.reservedBytes) {
        blockers.push({ path: entry.rel, reason: "too_large", message: `${entry.rel} is over the ${PUBLISH_BOUNDS.reservedBytes / 1024} KiB a reserved file may hold` });
        continue;
      }
      const dir = path.posix.dirname(entry.rel);
      reserved.push({ dir: dir === "." ? "" : dir, name: path.posix.basename(entry.rel), content: text });
      if (entry.rel !== "index.md") extras[entry.rel] = digest(bytes);
      continue;
    }
    if (!entry.rel.endsWith(".md")) {
      try {
        assertSafeBlobKey(entry.rel);
      } catch (error) {
        blockers.push({ path: entry.rel, reason: "unsafe_path", message: `${entry.rel} cannot be a file key (${(error as Error).message})` });
        continue;
      }
      if (bytes.byteLength > STAGED_PUBLISH_BOUNDS.blobBytes) {
        blockers.push({ path: entry.rel, reason: "too_large", message: `${entry.rel} is over the 16 MiB a file may hold` });
        continue;
      }
      blobs.push({ key: entry.rel, contentType: contentTypeOf(entry.rel), bytes });
      extras[entry.rel] = digest(bytes);
      continue;
    }
    const id = conceptIdFromPath(entry.rel);
    try {
      assertSafeConceptId(id);
    } catch (error) {
      blockers.push({ path: entry.rel, reason: "unsafe_id", message: `${entry.rel} cannot be a document id (${(error as Error).message})` });
      continue;
    }
    if (!isHostCanonicalId(id)) {
      blockers.push({ path: entry.rel, reason: "document_id_not_canonical", message: `${entry.rel} is not in its canonical spelling (a segment starts or ends with a space or an invisible format character, holds a format character other than a joiner, or is not NFC); rename it` });
      continue;
    }
    const refusal = unsendable(id, entry.rel, bytes, null, { bundleId: "publish", okfVersion });
    if (refusal) {
      blockers.push({ path: entry.rel, reason: refusal.reason, message: refusal.message });
      continue;
    }
    let request;
    try {
      request = wholeDocumentRequest("publish", { kind: "document.write", target: id, base: null, content: utf8(bytes)! }, okfVersion);
    } catch (error) {
      if (error instanceof WholeDocumentInputError) {
        blockers.push({ path: entry.rel, reason: "not_sendable", message: error.message });
        continue;
      }
      throw error;
    }
    if (request.kind === "delete") throw new Error(`'${id}' became a delete request`);
    documents.push({ id, frontmatter: request.payload.frontmatter as Record<string, unknown>, body: request.payload.body ?? "" });
    documentFiles.push({ id, rel: entry.rel, text: utf8(bytes)! });
  }
  if (rootIndex === null) blockers.push({ path: "index.md", reason: "no_root_index", message: "a hosted bundle needs a root index.md" });
  if (edition === "unsupported") {
    blockers.push({ path: "index.md", reason: "unsupported_okf_version", message: "index.md declares an okf_version other than 0.1 or 0.2, or its frontmatter does not parse; the host could not write to the bundle" });
  } else blockers.push(...kindBlockers(documents, okfVersion));
  // Paths that would be one file on a case-insensitive disk: documents (and their folders), then
  // every path the host claims, documents, reserved files and files together.
  const collision = findPathCollision(documents.map((doc) => doc.id));
  if (collision) {
    blockers.push({ path: collision.first, reason: "path_collision", message: `'${collision.first}' and '${collision.second}' differ only in letter case` });
  } else {
    const claimed = new Map<string, string>();
    for (const file of [...documents.map((doc) => `${doc.id}.md`), ...reserved.map((r) => (r.dir === "" ? r.name : `${r.dir}/${r.name}`)), ...blobs.map((b) => b.key)]) {
      const key = file.split("/").map(fold).join("/");
      const other = claimed.get(key);
      if (other !== undefined) {
        blockers.push({ path: file, reason: "path_collision", message: `'${other}' and '${file}' would be one file on a case-insensitive disk` });
        break;
      }
      claimed.set(key, file);
    }
  }
  if (reserved.length > PUBLISH_BOUNDS.reserved) blockers.push({ path: ".", reason: "too_many_reserved", message: `${reserved.length} reserved files; at most ${PUBLISH_BOUNDS.reserved}` });

  let history: CreateHistory[] = [];
  let historyPlan: PublishPlan["historyPlan"] = { mode: "current-only", versions: 0, skipped: 0, note: "history starts at publish" };
  if (options.history) {
    if (!options.board) {
      historyPlan = { mode: "current-only", versions: 0, skipped: 0, note: "a local bundle has only its current versions: history starts at publish" };
    } else {
      let skippedVersions = 0;
      for (const file of documentFiles) {
        const versions = gitVersions(options.board, file.id, file.rel, file.text, okfVersion, options.now ?? Date.now());
        history.push(...versions.rows);
        skippedVersions += versions.skipped;
      }
      historyPlan = {
        mode: "git",
        versions: history.length,
        skipped: skippedVersions,
        note: "earlier Git versions are imported as labeled, unverified history (imported:git/<commit>); nothing reads them back yet",
      };
    }
  }
  const draft = { documents, reserved, blobs, history };
  const sendPath = publishPath(draft);
  if (sendPath.mode === "staged") blockers.push(...stagedBlockers(draft));
  return { documents, reserved, blobs, history, path: sendPath, skipped, blockers, historyPlan, extras };
}

export type PlanContent = Pick<PublishPlan, "documents" | "reserved" | "blobs" | "history">;

/** Placeholders as long as the host admits, so a size check holds for any target. */
const WIDEST_TARGET = Object.freeze({ workspace: "w".repeat(64), bundleId: "b".repeat(128), name: "n".repeat(128) });

/** Whether the plan fits one `bundle-create` request, and if not, the first bound it passes. */
function publishPath(plan: PlanContent): PublishPath {
  const bounds = PUBLISH_BOUNDS;
  const objects = plan.documents.length + plan.reserved.length + plan.blobs.length + plan.history.length;
  const why =
    plan.documents.length > bounds.documents
      ? `${plan.documents.length} documents (one request carries at most ${bounds.documents})`
      : plan.blobs.length > bounds.blobs
        ? `${plan.blobs.length} other files (one request carries at most ${bounds.blobs})`
        : plan.history.length > bounds.history
          ? `${plan.history.length} earlier versions (one request carries at most ${bounds.history})`
          : objects > bounds.objects
            ? `${objects} objects in all (one request carries at most ${bounds.objects})`
            : plan.blobs.some((blob) => blob.bytes.byteLength > bounds.blobBytes)
              ? `a file over 1 MB (${plan.blobs.find((blob) => blob.bytes.byteLength > bounds.blobBytes)!.key})`
              : null;
  if (why !== null) return { mode: "staged", why };
  // Base64 alone past the bound decides without building the request.
  const base64 = plan.blobs.reduce((sum, blob) => sum + Math.ceil(blob.bytes.byteLength / 3) * 4, 0);
  const bytes = base64 > bounds.requestBytes ? base64 : Buffer.byteLength(JSON.stringify(createBody(plan, WIDEST_TARGET)));
  if (bytes > bounds.requestBytes) return { mode: "staged", why: `${Math.ceil(bytes / 1024)} KiB as one request (one request carries at most ${bounds.requestBytes / MiB} MiB)` };
  return { mode: "one-shot" };
}

/** The staged creation's own bounds, each naming its remedy. */
export function stagedBlockers(plan: PlanContent): PublishBlocker[] {
  const bounds = STAGED_PUBLISH_BOUNDS;
  const blockers: PublishBlocker[] = [];
  const noHistory = "publish without --with-history, or with fewer earlier versions";
  if (plan.documents.length > bounds.documents) blockers.push({ path: ".", reason: "too_many_documents", message: `${plan.documents.length} documents; a hosted bundle is created with at most ${bounds.documents}` });
  if (plan.blobs.length > bounds.blobs) blockers.push({ path: ".", reason: "too_many_files", message: `${plan.blobs.length} files that are not documents; at most ${bounds.blobs}` });
  if (plan.history.length > bounds.history) blockers.push({ path: ".", reason: "too_much_history", message: `${plan.history.length} earlier versions; a creation carries at most ${bounds.history}: ${noHistory}` });
  const content = stagedContent(plan);
  const current = distinctBytes([...content.documents, ...content.reserved, ...content.blobs]);
  if (current > bounds.currentBytes) blockers.push({ path: ".", reason: "too_large", message: `the bundle's current files are ${Math.ceil(current / MiB)} MiB; a creation carries at most ${bounds.currentBytes / MiB} MiB` });
  const history = distinctBytes(content.history);
  if (history > bounds.historyBytes) blockers.push({ path: ".", reason: "too_much_history", message: `the earlier versions are ${Math.ceil(history / MiB)} MiB; a creation carries at most ${bounds.historyBytes / MiB} MiB: ${noHistory}` });
  // Within the other bounds the packing needs about 140 parts at most (128 MiB in parts of about
  // 1 MiB); checked anyway, since the host refuses a creation's 401st part.
  const parts = packParts(content, content.objects.keys()).length;
  if (parts > bounds.parts) blockers.push({ path: ".", reason: "too_many_parts", message: `the bundle needs ${parts} parts; a creation holds at most ${bounds.parts}: ${plan.history.length > 0 ? noHistory : "publish fewer files"}` });
  const manifest = Buffer.byteLength(JSON.stringify(manifestBody(content, WIDEST_TARGET)));
  if (manifest > bounds.manifestBytes) {
    blockers.push({
      path: ".",
      reason: "manifest_too_large",
      message: `the list of everything sent is ${Math.ceil(manifest / 1024)} KiB; the host takes at most ${bounds.manifestBytes / MiB} MiB: ${plan.history.length > 0 ? noHistory : "publish fewer files"}`,
    });
  }
  return blockers;
}

/** The stored size of distinct versions, each counted once (as the host charges and bounds them). */
function distinctBytes(entries: readonly { version: string; bytes: number }[]): number {
  return [...new Map(entries.map((entry) => [entry.version, entry.bytes])).values()].reduce((sum, bytes) => sum + bytes, 0);
}

/** The `bundles.create.v1` request body. */
export function createBody(plan: PlanContent, target: { workspace: string; bundleId: string; name: string }): Record<string, unknown> {
  return {
    workspace: target.workspace,
    bundleId: target.bundleId,
    name: target.name,
    documents: plan.documents,
    reserved: plan.reserved,
    blobs: plan.blobs.map((blob) => ({ key: blob.key, contentType: blob.contentType, base64: blob.bytes.toString("base64") })),
    ...(plan.history.length > 0 ? { history: plan.history } : {}),
  };
}

/** A digest of what the request carries, so a retry reuses its request id only for the same contents. */
export function planDigest(body: Record<string, unknown>): string {
  return digest(Buffer.from(JSON.stringify(body), "utf8"));
}

/** A manifest entry: an object's stored version and stored size in bytes. */
export interface StagedEntry {
  readonly version: string;
  readonly bytes: number;
}

/** One object a part stages, in the one-shot's own shape (`ordinal` added on history). */
export type StagedObject =
  | { readonly kind: "documents"; readonly value: CreateDocument }
  | { readonly kind: "reserved"; readonly value: CreateReserved }
  | { readonly kind: "history"; readonly value: CreateHistory & { readonly ordinal: number } };

/**
 * The plan as a staged creation sends it: every object's stored version and size, as the host
 * computes them from the one-shot shapes (a document and an imported version are their
 * `stringifyDoc` bytes, a reserved file its text, a blob its raw bytes), imported history numbered
 * 1, 2, … per document in the one-shot's order (the plan hash follows it), the root index and the
 * Kind conventions in full, and one object for each distinct non-blob version (a part stages a
 * version once, whichever entries share it).
 */
export interface StagedContent {
  readonly root: string;
  readonly conventions: readonly CreateDocument[];
  readonly documents: readonly (StagedEntry & { readonly id: string })[];
  readonly reserved: readonly (StagedEntry & { readonly dir: string; readonly name: string })[];
  readonly blobs: readonly (StagedEntry & { readonly key: string; readonly contentType: string })[];
  readonly history: readonly (StagedEntry & { readonly documentId: string; readonly ordinal: number; readonly label: string; readonly author: string; readonly authoredAt: string })[];
  /** By version, in manifest order. */
  readonly objects: ReadonlyMap<string, StagedObject>;
  /** Each blob version's bytes and the first key that holds it. */
  readonly blobBytes: ReadonlyMap<string, { readonly key: string; readonly bytes: Buffer }>;
}

export function stagedContent(plan: PlanContent): StagedContent {
  // Versions are computed from what the host receives: frontmatter after JSON (a value JSON drops
  // or changes, such as undefined or a Date, would otherwise hash differently on each side).
  const wire = <T extends { frontmatter: Record<string, unknown> }>(object: T): T => ({ ...object, frontmatter: JSON.parse(JSON.stringify(object.frontmatter)) as Record<string, unknown> });
  const objects = new Map<string, StagedObject>();
  const keep = (version: string, object: StagedObject) => {
    if (!objects.has(version)) objects.set(version, object);
  };
  const stored = (text: string) => ({ version: versionOfBytes(text), bytes: Buffer.byteLength(text, "utf8") });
  const conventions: CreateDocument[] = [];
  const documents = plan.documents.map((sent) => {
    const doc = wire(sent);
    const text = stringifyDoc(doc.frontmatter as OkfDocument["frontmatter"], doc.body);
    const entry = stored(text);
    keep(entry.version, { kind: "documents", value: doc });
    // A Kind convention as the host's registry reads it: the stored round trip.
    if (matchesFilter({ id: doc.id, frontmatter: parseMarkdown(text, doc.id).frontmatter }, { prefix: CONVENTIONS_PREFIX, type: CONVENTION_TYPE })) conventions.push(doc);
    return { id: doc.id, ...entry };
  });
  const reserved = plan.reserved.map((file) => {
    const entry = stored(file.content);
    keep(entry.version, { kind: "reserved", value: file });
    return { dir: file.dir, name: file.name, ...entry };
  });
  const ordinals = new Map<string, number>();
  const history = plan.history.map((sent) => {
    const row = wire(sent);
    const ordinal = (ordinals.get(row.documentId) ?? 0) + 1;
    ordinals.set(row.documentId, ordinal);
    const entry = stored(stringifyDoc(row.frontmatter as OkfDocument["frontmatter"], row.body));
    keep(entry.version, { kind: "history", value: { ...row, ordinal } });
    return { documentId: row.documentId, ordinal, label: row.label, author: row.author, authoredAt: row.authoredAt, ...entry };
  });
  const blobBytes = new Map<string, { key: string; bytes: Buffer }>();
  const blobs = plan.blobs.map((blob) => {
    const version = blobVersion(blob.bytes);
    if (!blobBytes.has(version)) blobBytes.set(version, { key: blob.key, bytes: blob.bytes });
    return { key: blob.key, contentType: blob.contentType, version, bytes: blob.bytes.byteLength };
  });
  const root = plan.reserved.find((file) => file.dir === "" && file.name === "index.md")?.content ?? "";
  return { root, conventions, documents, reserved, blobs, history, objects, blobBytes };
}

/** The `bundle-create-begin` request body: the manifest. */
export function manifestBody(content: StagedContent, target: { workspace: string; bundleId: string; name: string }): Record<string, unknown> {
  return {
    workspace: target.workspace,
    bundleId: target.bundleId,
    name: target.name,
    root: content.root,
    conventions: content.conventions,
    documents: content.documents,
    reserved: content.reserved,
    blobs: content.blobs,
    history: content.history,
  };
}

/** One part's objects, by kind. */
export interface StagedPart {
  readonly documents: CreateDocument[];
  readonly reserved: CreateReserved[];
  readonly history: (CreateHistory & { readonly ordinal: number })[];
  readonly versions: string[];
}

/**
 * Packs the objects of `versions` (each staged once) into parts of about
 * `STAGED_PUBLISH_BOUNDS.partTargetBytes` of JSON and at most `partObjects` objects, so every part
 * stays far under the host's 3 MiB body cap. A version the content does not hold is skipped.
 */
export function packParts(content: StagedContent, versions: Iterable<string>): StagedPart[] {
  const bounds = STAGED_PUBLISH_BOUNDS;
  const parts: StagedPart[] = [];
  let part: StagedPart | null = null;
  let size = 0;
  // The envelope: workspace, bundle id, plan hash and the three lists.
  const envelope = 512;
  for (const version of new Set(versions)) {
    const object = content.objects.get(version);
    if (!object) continue;
    const bytes = Buffer.byteLength(JSON.stringify(object.value)) + 1;
    if (part === null || part.versions.length >= bounds.partObjects || size + bytes > bounds.partTargetBytes) {
      part = { documents: [], reserved: [], history: [], versions: [] };
      parts.push(part);
      size = envelope;
    }
    if (object.kind === "documents") part.documents.push(object.value);
    else if (object.kind === "reserved") part.reserved.push(object.value);
    else part.history.push(object.value);
    part.versions.push(version);
    size += bytes;
  }
  return parts;
}
