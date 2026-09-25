// The plan `superbee publish --to hosted` shows and sends: the whole bundle as one
// `bundles.create.v1` request (hosted `docs/person-bundle-create.md`), every bound the host
// enforces checked here first, and what will not travel. Reads the folder and local Git only.
//
// What travels:
//   documents       every `.md` file that is not a reserved file, as `{id, frontmatter, body}`
//   reserved        `index.md` and `log.md` at any level, as their exact text
//   blobs           every other plain file, base64, with a content type from its extension
//   history         with `--with-history` on a Git board: each earlier Git version of each document,
//                   labeled `imported:git/<commit>` and unverified (Mike's decision D2)
// What does not: dot-files and dot-folders (`.git`, the checkout marker), symbolic links, and
// anything that is not a regular file. A document the host would refuse blocks the plan.
import { promises as fs } from "node:fs";
import path from "node:path";

import { readDocBytesAtRef, runGit } from "@superbee/board-git";
import { assertSafeBlobKey, assertSafeConceptId, conceptIdFromPath, isReservedFile, parseMarkdown } from "@superbee/core";
import { wholeDocumentRequest, WholeDocumentInputError } from "@superbee/core/hosted-transport";

import type { GitBoardFacts } from "../bundle-home.js";
import { digestOf, findPathCollision, fold } from "./projection.js";
import { unsendable, utf8 } from "./sync-scan.js";

/** The host's bounds for one creation (hosted `src/person-bundle-create.ts`). */
export const PUBLISH_BOUNDS = Object.freeze({
  objects: 1500,
  documents: 1000,
  reserved: 1000,
  blobs: 100,
  history: 1000,
  reservedBytes: 64 * 1024,
  blobBytes: 1_000_000,
  requestBytes: 3 * 1024 * 1024,
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
export interface CreateBlob {
  readonly key: string;
  readonly contentType: string;
  readonly base64: string;
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

export interface PublishPlan {
  readonly documents: CreateDocument[];
  readonly reserved: CreateReserved[];
  readonly blobs: CreateBlob[];
  readonly history: CreateHistory[];
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

/** The host refuses control and format characters (bidi overrides, zero-width) in an author. */
function cleanAuthor(author: string): string {
  return [...author.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, 200).join("").trim() || "unknown";
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

function okfVersionOf(rootIndex: string | null): "0.1" | "0.2" | undefined {
  if (rootIndex === null) return undefined;
  try {
    const version = parseMarkdown(rootIndex, "index").frontmatter.okf_version;
    return version === "0.1" || version === "0.2" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the bundle folder into a creation plan. `history` asks for Git history; it is planned only
 * for a Git board, and a local bundle's plan says `current-only`.
 */
export async function planPublish(folder: string, options: { history: false } | ({ history: true } & Partial<HistoryOptions>)): Promise<PublishPlan> {
  const documents: CreateDocument[] = [];
  const reserved: CreateReserved[] = [];
  const blobs: CreateBlob[] = [];
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
  const okfVersion = okfVersionOf(rootIndex);
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
      if (bytes.byteLength > PUBLISH_BOUNDS.blobBytes) {
        blockers.push({ path: entry.rel, reason: "too_large", message: `${entry.rel} is over the 1 MB a file may hold` });
        continue;
      }
      blobs.push({ key: entry.rel, contentType: contentTypeOf(entry.rel), base64: bytes.toString("base64") });
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
    // The host's canonical spelling (#642): no segment starting or ending with whitespace, NFC.
    if (id.split("/").some((segment) => segment !== segment.trim()) || id !== id.normalize("NFC")) {
      blockers.push({ path: entry.rel, reason: "document_id_not_canonical", message: `${entry.rel} is not in its canonical spelling (a segment starts or ends with a space, or it is not NFC); rename it` });
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
  if (documents.length > PUBLISH_BOUNDS.documents) blockers.push({ path: ".", reason: "too_many_documents", message: `${documents.length} documents; a hosted bundle is created with at most ${PUBLISH_BOUNDS.documents}` });
  if (reserved.length > PUBLISH_BOUNDS.reserved) blockers.push({ path: ".", reason: "too_many_reserved", message: `${reserved.length} reserved files; at most ${PUBLISH_BOUNDS.reserved}` });
  if (blobs.length > PUBLISH_BOUNDS.blobs) blockers.push({ path: ".", reason: "too_many_files", message: `${blobs.length} files that are not documents; at most ${PUBLISH_BOUNDS.blobs}` });

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
      if (history.length > PUBLISH_BOUNDS.history || documents.length + reserved.length + blobs.length + history.length > PUBLISH_BOUNDS.objects) {
        blockers.push({
          path: ".",
          reason: "too_much_history",
          message: `${history.length} earlier versions: one creation carries at most ${PUBLISH_BOUNDS.history} versions and ${PUBLISH_BOUNDS.objects} objects in all; publish without --with-history`,
        });
      }
    }
  }
  if (documents.length + reserved.length + blobs.length + history.length > PUBLISH_BOUNDS.objects && !blockers.some((b) => b.reason === "too_much_history")) {
    blockers.push({ path: ".", reason: "too_many_objects", message: `one creation carries at most ${PUBLISH_BOUNDS.objects} documents, reserved files and files in all` });
  }
  const plan: PublishPlan = { documents, reserved, blobs, history, skipped, blockers, historyPlan, extras };
  const bytes = Buffer.byteLength(JSON.stringify(createBody(plan, { workspace: "w".repeat(64), bundleId: "b".repeat(128), name: "n".repeat(128) })));
  if (bytes > PUBLISH_BOUNDS.requestBytes) {
    blockers.push({ path: ".", reason: "request_too_large", message: `the bundle is ${Math.ceil(bytes / 1024)} KiB as one request; the host takes at most ${PUBLISH_BOUNDS.requestBytes / 1024 / 1024} MiB` });
  }
  return plan;
}

/** The `bundles.create.v1` request body. */
export function createBody(plan: PublishPlan, target: { workspace: string; bundleId: string; name: string }): Record<string, unknown> {
  return {
    workspace: target.workspace,
    bundleId: target.bundleId,
    name: target.name,
    documents: plan.documents,
    reserved: plan.reserved,
    blobs: plan.blobs,
    ...(plan.history.length > 0 ? { history: plan.history } : {}),
  };
}

/** A digest of what the request carries, so a retry reuses its request id only for the same contents. */
export function planDigest(body: Record<string, unknown>): string {
  return digest(Buffer.from(JSON.stringify(body), "utf8"));
}
