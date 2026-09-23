// The private binding of a hosted checkout: which hosted bundle a checkout folder projects, under
// whose identity, and where its private store lives. It is kept in private state, never in the
// checkout folder: the folder carries no URL and no `.superbee.json`, so nothing inside it can
// retarget it, and there is no ambient default. A command reaches a checkout's bundle only through
// the record for that folder's own path.
//
// Layout under the private state root:
//   hosted-checkouts/<checkout id>/binding.json   this record
//   hosted-checkouts/<checkout id>/store/         the working copy's log store (`FileJournaledBackend`)
//   hosted-checkouts/paths/<sha256 of path>.json  the path index: folder path -> checkout id
import { createHash, randomUUID } from "node:crypto";
import { lstat, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { readUserStateFile, userStateDir, writeUserStateFileAtomic0600 } from "../user-state.js";

export const BINDING_SCHEMA = 1;
const MAX_RECORD_BYTES = 64 * 1024;

/** The key a checkout is bound by: its folder plus the hosted identity it projects. */
export interface CheckoutBinding {
  readonly schema: typeof BINDING_SCHEMA;
  /** Random per checkout; its digest is the recovery binding (`X-Superbee-Checkout`) sync sends. */
  readonly checkout_id: string;
  /** The checkout folder's canonical absolute path. */
  readonly path: string;
  /** The hosted origin and the token audience (`<origin>/mcp`, or an agent connection's `/mcp` URL). */
  readonly origin: string;
  readonly audience: string;
  /** The sync route family under that audience, e.g. `/sync/v1` or `/agents/<uuid>/sync/v1`. */
  readonly routes: string;
  /** The workspace (tenant) that serves the bundle, when the identity reaches exactly one or one was named. */
  readonly workspace: string | null;
  /** Every workspace the identity reached at checkout, sorted. */
  readonly workspaces: readonly string[];
  readonly bundle_id: string;
  /** The principal the gateway named at checkout; later commands refuse any other. */
  readonly principal_id: string;
  readonly created_at: string;
  /** `hydrating` until the projection is complete; only a `ready` record is indexed by path. */
  readonly state: "hydrating" | "ready";
  /**
   * The folder's filesystem identity at checkout (device and inode), the marker that ties the
   * record to that folder without writing anything into it. A folder deleted and recreated at the
   * same path has another identity, so the record no longer applies to it.
   */
  readonly folder_identity: { readonly dev: number; readonly ino: number };
}

/** The identity a folder has now, or null when nothing is there. */
export async function folderIdentity(folder: string): Promise<{ dev: number; ino: number } | null> {
  try {
    const info = await stat(folder);
    return info.isDirectory() ? { dev: info.dev, ino: info.ino } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

export function hostedCheckoutsRoot(home: string): string {
  return join(userStateDir(home), "hosted-checkouts");
}

export function checkoutDir(home: string, checkoutId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(checkoutId)) throw new TypeError("malformed checkout id");
  return join(hostedCheckoutsRoot(home), checkoutId);
}

/** The private store's directory for one checkout. */
export function checkoutStoreDir(home: string, checkoutId: string): string {
  return join(checkoutDir(home, checkoutId), "store");
}

function pathKey(canonicalPath: string): string {
  return createHash("sha256").update(`superbee:hosted-checkout\0${canonicalPath}`, "utf8").digest("hex");
}

function pathIndexDir(home: string): string {
  return join(hostedCheckoutsRoot(home), "paths");
}

/** The name of a checkout's lock: the push role every writer of the checkout takes. */
export function checkoutLockName(canonicalPath: string): string {
  return `superbee:hosted-checkout:${pathKey(canonicalPath)}`;
}

/** `sha256:<hex>` of the checkout id: the recovery binding's `installation`, never the id itself. */
export function checkoutBindingDigest(checkoutId: string): string {
  return `sha256:${createHash("sha256").update(checkoutId, "utf8").digest("hex")}`;
}

export function newCheckoutId(): string {
  return randomUUID();
}

async function readJson(home: string, file: string): Promise<unknown | null> {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: string;
  try {
    raw = await readUserStateFile(home, file, MAX_RECORD_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isBinding(value: unknown): value is CheckoutBinding {
  const record = value as Partial<CheckoutBinding> | null;
  return (
    record !== null &&
    typeof record === "object" &&
    record.schema === BINDING_SCHEMA &&
    typeof record.checkout_id === "string" &&
    typeof record.path === "string" &&
    typeof record.origin === "string" &&
    typeof record.audience === "string" &&
    typeof record.routes === "string" &&
    (record.workspace === null || typeof record.workspace === "string") &&
    Array.isArray(record.workspaces) &&
    typeof record.bundle_id === "string" &&
    typeof record.principal_id === "string" &&
    (record.state === "hydrating" || record.state === "ready") &&
    typeof record.folder_identity?.dev === "number" &&
    typeof record.folder_identity?.ino === "number"
  );
}

export async function writeBinding(home: string, binding: CheckoutBinding): Promise<void> {
  await writeUserStateFileAtomic0600(home, checkoutDir(home, binding.checkout_id), "binding.json", `${JSON.stringify(binding)}\n`);
}

export async function readBinding(home: string, checkoutId: string): Promise<CheckoutBinding | null> {
  const value = await readJson(home, join(checkoutDir(home, checkoutId), "binding.json"));
  return isBinding(value) && value.checkout_id === checkoutId ? value : null;
}

/** Index a ready checkout by its folder path. The index is written last, so a partial checkout is never found. */
export async function indexCheckoutPath(home: string, binding: CheckoutBinding): Promise<void> {
  await writeUserStateFileAtomic0600(
    home,
    pathIndexDir(home),
    `${pathKey(binding.path)}.json`,
    `${JSON.stringify({ path: binding.path, checkout_id: binding.checkout_id })}\n`,
  );
}

/**
 * The ready binding indexed at this canonical path, whether or not the folder there is still the
 * one it was made for. Only reclaim and release read this; every other caller uses
 * {@link bindingForPath}.
 */
export async function indexedBindingForPath(home: string, canonicalPath: string): Promise<CheckoutBinding | null> {
  const entry = (await readJson(home, join(pathIndexDir(home), `${pathKey(canonicalPath)}.json`))) as {
    path?: unknown;
    checkout_id?: unknown;
  } | null;
  if (!entry || entry.path !== canonicalPath || typeof entry.checkout_id !== "string" || !/^[0-9a-f-]{36}$/.test(entry.checkout_id)) return null;
  const binding = await readBinding(home, entry.checkout_id);
  return binding && binding.state === "ready" && binding.path === canonicalPath ? binding : null;
}

/**
 * The live binding for exactly this canonical folder path, or null: the indexed record must name
 * the same path, and the folder there must still be the one it was made for (its identity
 * marker). Any disagreement reads as no checkout, never as a different one.
 */
export async function bindingForPath(home: string, canonicalPath: string): Promise<CheckoutBinding | null> {
  const binding = await indexedBindingForPath(home, canonicalPath);
  if (!binding) return null;
  const identity = await folderIdentity(canonicalPath);
  return identity && identity.dev === binding.folder_identity.dev && identity.ino === binding.folder_identity.ino ? binding : null;
}

/** Remove a checkout's path index entry and its private state (binding and store). The folder is never touched. */
export async function releaseCheckout(home: string, binding: CheckoutBinding): Promise<void> {
  await unlink(join(pathIndexDir(home), `${pathKey(binding.path)}.json`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await discardCheckoutState(home, binding.checkout_id);
}

/** Remove a checkout's private state (binding and store). Used only for a checkout that never became ready. */
export async function discardCheckoutState(home: string, checkoutId: string): Promise<void> {
  await rm(checkoutDir(home, checkoutId), { recursive: true, force: true });
}
