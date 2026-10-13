// The bundle's front page in a hosted checkout: the root `index.md`, synced as one file of its own.
//
// It is not a document. The host serves it in the capabilities answer (`root: {content, version}`)
// and replaces it with one compare-and-swap write (`bundles.root.replace.v1`) that carries no
// request identity. The projection record keeps two facts about it apart:
//
// - `root`: the digest of the bytes last placed in the folder (an edit is a file that differs);
// - `rootBase`: the host's version the folder's root was last brought to, which a write is sent
//   against.
//
// A root version is the SHA-256 of its bytes, the same digest the record keeps, so a file that
// holds exactly the host's bytes is in sync whatever the record says. One step per run, after the
// pull:
//
// - a write whose answer was lost (`rootSent`) is settled first, by the host's version now;
// - the host moved: an unedited file takes the host's bytes, and an edited one is a conflict,
//   resolved with `--resolve take` (the host's bytes) or `keep` (the base moves, and the next sync
//   sends the file against it);
// - the host did not move and the file is edited: it is sent, when the host takes root writes from
//   this person (`rootWrites: "allowed"`); otherwise the scan holds it, as it always has.
import { promises as fs } from "node:fs";
import path from "node:path";

import type { JournaledBackend } from "@superbee/core";
import { RootWriteInputError, rootLanding, rootVersionOf, rootWriteRequest, ROOT_BUSY_CODES, type HostedRootWrites, type RootWriteOutcome } from "@superbee/core/hosted-transport";

import { digestOf, placeNew, replaceGuarded, ROOT_INDEX } from "./projection.js";
import { ACCESS_WITHDRAWN_MESSAGE, READ_ONLY_MESSAGE, type SyncRow } from "./sync-rows.js";
import { utf8, type ProjectionRecord } from "./sync-scan.js";

/** The host's root as the capabilities answer serves it, or null when the bundle has none. */
export type HostRoot = { readonly content: string; readonly version: string } | null;

export const ROOT_CONFLICT_MESSAGE =
  "The bundle's front page also changed on the host. Nothing was merged or sent. Inspect it, then keep yours (the next sync sends it over the host's version) or take the host's.";
export const ROOT_NOT_LANDED_MESSAGE = "The answer was lost, and the host still has the front page this edit replaces, so it was not applied. Run sync again to send it.";
export const ROOT_UNKNOWN_MESSAGE = "The answer was lost; the front page may have changed on the host. The next sync reads the host's front page to tell, never sending it twice.";

/**
 * The base an edit to the folder's root is sent against: the record's. A record written before
 * root writes has none; the store's root (copied from the host at checkout) is the base only while
 * the file holds exactly it (or is gone). A file that differs was edited against a version nobody
 * recorded (held by an older sync, or adopted as it was), so its base is unknown: null, which the
 * host's root never equals, makes it a conflict rather than a write over the host's.
 */
export async function rootBaseOf(projection: ProjectionRecord, store: JournaledBackend, file: RootFile): Promise<string | null> {
  if (projection.rootBase !== undefined) return projection.rootBase;
  const stored = (await store.readReserved("", "index.md"))?.version ?? null;
  return file.kind !== "file" || digestOf(file.bytes) === stored ? stored : null;
}

/** The folder's root `index.md` as it is: a regular file's bytes, absent, or something sync never reads through (a symbolic link, a folder). */
export type RootFile = { readonly kind: "file"; readonly bytes: Buffer } | { readonly kind: "absent" } | { readonly kind: "unsafe"; readonly what: "symlink" | "not_a_file" };

/**
 * Read the root without following a symbolic link: opened with `O_NOFOLLOW` and checked to be a
 * regular file on the open handle, so a link swapped in between is never read through.
 */
export async function readRootFile(folder: string): Promise<RootFile> {
  const file = path.join(folder, ROOT_INDEX);
  let handle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    if (code === "ELOOP" || code === "EMLINK") return { kind: "unsafe", what: "symlink" };
    if (code === "EISDIR") return { kind: "unsafe", what: "not_a_file" };
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) return { kind: "unsafe", what: "not_a_file" };
    return { kind: "file", bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

/** The held row for a root that is not a plain file: nothing is sent or placed through it. */
function unsafeRootRow(what: "symlink" | "not_a_file"): SyncRow {
  return what === "symlink"
    ? row("held", "symlink", "index.md is a symbolic link; sync sends and places only plain files. The file stays as it is and nothing is sent.")
    : row("held", "unsafe_path", "index.md is not a plain file (a folder, say); sync sends and places only plain files. Nothing is sent or placed.");
}

/** Record that the folder's root now holds the host's root: the placed digest, the base, and the store's copy. */
export async function adoptHostRoot(projection: ProjectionRecord, store: JournaledBackend, host: NonNullable<HostRoot>): Promise<void> {
  if ((await store.readReserved("", "index.md"))?.version !== host.version) await store.writeReserved("", "index.md", host.content);
  projection.root = host.version;
  projection.rootBase = host.version;
}

/**
 * Move the base to the host's root (a kept conflict). The placed digest is cleared, so whatever the
 * file holds at the next sync is sent against that base, even bytes it held before; a file that
 * holds exactly the host's bytes is in sync instead.
 */
export async function moveRootBase(projection: ProjectionRecord, store: JournaledBackend, host: HostRoot): Promise<void> {
  if (host && (await store.readReserved("", "index.md"))?.version !== host.version) await store.writeReserved("", "index.md", host.content);
  projection.rootBase = host?.version ?? null;
  projection.root = null;
  delete projection.rootConflicted;
}

/** The root conflict now, or null: the host moved past the base while the file holds an edit. */
export interface RootConflict {
  readonly base: string | null;
  readonly host: HostRoot;
  readonly bytes: Buffer;
}

export async function rootConflict(folder: string, projection: ProjectionRecord, store: JournaledBackend, host: HostRoot): Promise<RootConflict | null> {
  const file = await readRootFile(folder);
  if (file.kind !== "file" || digestOf(file.bytes) === projection.root) return null;
  const bytes = file.bytes;
  const base = await rootBaseOf(projection, store, file);
  const current = host?.version ?? null;
  if (current === base || digestOf(bytes) === current) return null;
  return { base, host, bytes };
}

export interface RootStepContext {
  readonly folder: string;
  readonly bundleId: string;
  readonly projection: ProjectionRecord;
  readonly store: JournaledBackend;
  readonly rootWrites: HostedRootWrites;
  /** The host's root now (the capabilities answer, as current as the run's last heads). */
  current(): Promise<HostRoot>;
  /** The host's root read again with a new request, to settle a write whose answer was lost. */
  reread(): Promise<HostRoot>;
  /** Send one root write; absent, the step only reads (a pull). */
  send?(content: string, base: string | null): Promise<RootWriteOutcome>;
  /** Write the projection record now. */
  persist(): Promise<void>;
}

export interface RootStepReport {
  /** The row the root's state this run stands for, if any. */
  readonly row?: SyncRow;
  /** True when the folder's root now holds new bytes from the host. */
  readonly refreshed: boolean;
}

const row = (state: SyncRow["state"], reason: string, message: string, version: string | null = null): SyncRow => ({ id: ROOT_INDEX, state, reason, version, message });

/**
 * Settle a root write whose answer was lost, from the host's root version now. While the host still
 * holds the base the write is kept on record (it may yet land late, which a later read then sees);
 * it is cleared once the host's root moved, to the bytes sent or elsewhere.
 */
export async function settleRootSent(projection: ProjectionRecord, store: JournaledBackend, host: HostRoot, persist: () => Promise<void>): Promise<"landed" | "not_landed" | "conflict" | null> {
  const sent = projection.rootSent;
  if (!sent) return null;
  const landing = rootLanding(host?.version ?? null, sent.version, sent.base);
  if (landing === "not_landed") return landing;
  delete projection.rootSent;
  if (landing === "landed" && host) {
    // The host holds the bytes sent: they are the base now, and what the folder last placed.
    if ((await store.readReserved("", "index.md"))?.version !== host.version) await store.writeReserved("", "index.md", host.content);
    projection.rootBase = host.version;
    projection.root = host.version;
  }
  await persist();
  return landing;
}

const settleSent = (context: RootStepContext, host: HostRoot) => settleRootSent(context.projection, context.store, host, context.persist);

/** The row one root write's outcome stands for, with the record updated for it. */
async function settleOutcome(context: RootStepContext, outcome: RootWriteOutcome, content: string): Promise<SyncRow> {
  const { projection, store } = context;
  switch (outcome.kind) {
    case "committed":
      delete projection.rootSent;
      await adoptHostRoot(projection, store, { content, version: outcome.version });
      await context.persist();
      return row("committed", "committed", "Sent and accepted: the bundle's front page.", outcome.version);
    case "conflict":
      delete projection.rootSent;
      await context.persist();
      return row("conflict", "changed_remotely", ROOT_CONFLICT_MESSAGE);
    case "refused": {
      delete projection.rootSent;
      await context.persist();
      if (outcome.code === "access_withdrawn") return row("refused", "access_withdrawn", ACCESS_WITHDRAWN_MESSAGE);
      if (outcome.malformed) return row("refused", outcome.code, `The host refused the front-page request as malformed (${outcome.code}); nothing was written. This is not about your file: run sync again, and report it if it repeats.`);
      if (outcome.authorization === "AUTH_REQUIRED") return row("paused", "sign_in", "The hosted session ended before the front page was sent; sign in and run sync again.");
      if (outcome.authorization === "PERMISSION_DENIED") return row("refused", "read_only", READ_ONLY_MESSAGE);
      if (ROOT_BUSY_CODES.has(outcome.code)) return row("paused", "busy", "The host was busy and did not apply the front page; run sync again.");
      return row("refused", outcome.code, `The host refused the front page (${outcome.code}): ${outcome.message} Edit index.md and run sync again.`);
    }
    case "unknown": {
      let host: HostRoot;
      try {
        host = await context.reread();
      } catch {
        return row("unknown", "possibly_delivered", ROOT_UNKNOWN_MESSAGE);
      }
      const landing = await settleSent(context, host);
      if (landing === "landed") return row("committed", "committed", "Sent and accepted: the bundle's front page.", host!.version);
      if (landing === "not_landed") return row("paused", "not_landed", ROOT_NOT_LANDED_MESSAGE);
      return row("conflict", "changed_remotely", ROOT_CONFLICT_MESSAGE);
    }
  }
}

/**
 * The run's root step: settle a lost answer, take the host's root into an unedited file, report an
 * edited one the host also changed as a conflict, and send an edit the host may take.
 */
export async function syncRoot(context: RootStepContext): Promise<RootStepReport> {
  const report = await rootStep(context);
  // Kept for a status preview, which makes no request: a conflict this run reported stands until resolved.
  const conflicted = report.row?.state === "conflict";
  if (conflicted !== (context.projection.rootConflicted === true)) {
    if (conflicted) context.projection.rootConflicted = true;
    else delete context.projection.rootConflicted;
    await context.persist();
  }
  return report;
}

async function rootStep(context: RootStepContext): Promise<RootStepReport> {
  const { folder, projection, store } = context;
  let host = await context.current();
  const settled = await settleSent(context, host);
  if (settled === "landed") host = await context.current();
  const file = path.join(folder, ROOT_INDEX);
  const found = await readRootFile(folder);
  // Never read, sent or replaced through: a link could point outside the checkout.
  if (found.kind === "unsafe") return { row: unsafeRootRow(found.what), refreshed: false };
  const bytes = found.kind === "file" ? found.bytes : null;
  const base = await rootBaseOf(projection, store, found);
  const current = host?.version ?? null;
  // A file that holds exactly the host's bytes is in sync, whatever the record says (a run that
  // stopped after placing it, or the same edit made on both sides).
  if (bytes !== null && host && digestOf(bytes) === host.version) {
    if (projection.root !== host.version || projection.rootBase !== host.version) {
      await adoptHostRoot(projection, store, host);
      await context.persist();
    }
    return { refreshed: false };
  }
  const edited = bytes !== null && digestOf(bytes) !== projection.root;
  if (current !== base) {
    if (edited) {
      // Without root writes the scan holds the file, as it always has: nothing to resolve here.
      return context.rootWrites === "allowed" ? { row: row("conflict", "changed_remotely", ROOT_CONFLICT_MESSAGE), refreshed: false } : { refreshed: false };
    }
    if (!host) {
      // The host has no root any more; the file is left as it is.
      projection.rootBase = null;
      await context.persist();
      return { refreshed: false };
    }
    const next = Buffer.from(host.content, "utf8");
    const outcome = bytes === null ? await placeNew(file, next) : await replaceGuarded(file, bytes, next);
    if (!outcome.placed) return { refreshed: false };
    await adoptHostRoot(projection, store, host);
    await context.persist();
    return { refreshed: true };
  }
  if (!edited || context.rootWrites !== "allowed" || !context.send) return { refreshed: false };
  const content = utf8(bytes!);
  // Text that does not encode back to the file's exact bytes (not UTF-8, or a byte-order mark the
  // decoder drops) would be stored as other bytes than the file holds.
  if (content === null || !Buffer.from(content, "utf8").equals(bytes!)) {
    return { row: row("held", "not_sendable", "index.md is not plain UTF-8 text (or starts with a byte-order mark); sending it would change its bytes. The file stays as it is and nothing is sent."), refreshed: false };
  }
  try {
    rootWriteRequest(context.bundleId, content, base);
  } catch (error) {
    if (!(error instanceof RootWriteInputError)) throw error;
    const reason = error.code === "too_large" ? "too_large" : "not_sendable";
    return { row: row("held", reason, `${error.message}. The file stays as it is and nothing is sent.`), refreshed: false };
  }
  // Recorded before it leaves: a lost answer is settled by the host's version, now or next run.
  projection.rootSent = { version: rootVersionOf(content), base };
  await context.persist();
  return { row: await settleOutcome(context, await context.send(content, base), content), refreshed: false };
}
