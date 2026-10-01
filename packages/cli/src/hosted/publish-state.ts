// The private records `publish` keeps per folder, under `<private state>/hosted-publish/`:
//
//   <sha256 of path>-<sha256 of bundle id>.json
//                                 a creation of that bundle id that may be pending: its request id,
//                                 so a retry re-sends the same one and the host finishes or confirms
//                                 it (one record per id, so publishing under another id never
//                                 forgets an unfinished one)
//   <sha256 of path>.extras.json  the files publish sent that a checkout does not hold as documents
//                                 (blobs, reserved files), kept until the folder is bound, so a
//                                 `checkout --adopt` that finishes an interrupted conversion
//                                 records them too
import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { readUserStateFile, userStateDir, writeUserStateFileAtomic0600 } from "../user-state.js";

function recordDir(home: string): string {
  return path.join(userStateDir(home), "hosted-publish");
}

function recordName(canonical: string, suffix: string): string {
  return `${createHash("sha256").update(`superbee:publish\0${canonical}`, "utf8").digest("hex")}${suffix}`;
}

async function readRecord<T>(home: string, canonical: string, suffix: string, valid: (value: Partial<T>) => boolean): Promise<T | null> {
  try {
    const value = JSON.parse(await readUserStateFile(home, path.join(recordDir(home), recordName(canonical, suffix)), 1024 * 1024)) as Partial<T>;
    return valid(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

async function clearRecord(home: string, canonical: string, suffix: string): Promise<void> {
  await unlink(path.join(recordDir(home), recordName(canonical, suffix))).catch(() => {});
}

export interface PendingCreate {
  readonly request_id: string;
  readonly host: string;
  readonly workspace: string;
  readonly bundle_id: string;
  readonly digest: string;
  /** A staged creation (absent: one request). */
  readonly staged?: boolean;
  /** The folder it publishes, for naming it to the person. */
  readonly folder?: string;
  /**
   * The host has reserved the bundle id for this request (a staged creation answered `importing`
   * or `created`): only this request id can finish it, so the record is kept until it succeeds.
   */
  readonly reserved?: boolean;
}

function pendingSuffix(bundleId: string): string {
  return `-${createHash("sha256").update(bundleId, "utf8").digest("hex")}.json`;
}

export function readPendingCreate(home: string, canonical: string, bundleId: string): Promise<PendingCreate | null> {
  return readRecord<PendingCreate>(home, canonical, pendingSuffix(bundleId), (value) => typeof value.request_id === "string" && typeof value.bundle_id === "string" && typeof value.host === "string");
}

export async function writePendingCreate(home: string, canonical: string, pending: PendingCreate): Promise<void> {
  await writeUserStateFileAtomic0600(home, recordDir(home), recordName(canonical, pendingSuffix(pending.bundle_id)), `${JSON.stringify(pending)}\n`);
}

/** Every pending record, whatever folder it publishes (a record that does not read is skipped). */
export async function listPendingCreates(home: string): Promise<PendingCreate[]> {
  let names: string[];
  try {
    names = await readdir(recordDir(home));
  } catch {
    return [];
  }
  const records: PendingCreate[] = [];
  for (const name of names.filter((entry) => /^[0-9a-f]{64}-[0-9a-f]{64}\.json$/.test(entry))) {
    try {
      const value = JSON.parse(await readUserStateFile(home, path.join(recordDir(home), name), 1024 * 1024)) as Partial<PendingCreate>;
      if (typeof value.request_id === "string" && typeof value.bundle_id === "string" && typeof value.host === "string") records.push(value as PendingCreate);
    } catch {
      // Unreadable: not one to name.
    }
  }
  return records;
}

export function clearPendingCreate(home: string, canonical: string, bundleId: string): Promise<void> {
  return clearRecord(home, canonical, pendingSuffix(bundleId));
}

export interface PublishedExtras {
  readonly host: string;
  readonly bundle_id: string;
  /** Folder-relative path to digest, as `ProjectionRecord.extras`. */
  readonly extras: Record<string, string>;
}

export function readPublishedExtras(home: string, canonical: string): Promise<PublishedExtras | null> {
  return readRecord<PublishedExtras>(home, canonical, ".extras.json", (value) => typeof value.bundle_id === "string" && typeof value.host === "string" && typeof value.extras === "object" && value.extras !== null);
}

export async function writePublishedExtras(home: string, canonical: string, record: PublishedExtras): Promise<void> {
  await writeUserStateFileAtomic0600(home, recordDir(home), recordName(canonical, ".extras.json"), `${JSON.stringify(record)}\n`);
}

export function clearPublishedExtras(home: string, canonical: string): Promise<void> {
  return clearRecord(home, canonical, ".extras.json");
}
