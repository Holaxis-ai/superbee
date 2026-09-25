// The folder marker of a hosted checkout: `.superbee/checkout.json`, a read-only note that says
// "this folder is a hosted checkout of <bundle> on <host>" to anyone looking at the folder (an
// agent, an editor, `ls`).
//
// It is never an authority. Nothing reads it to route a command: the private binding, keyed by the
// folder's path and identity (`binding.ts`), is the only thing that makes a folder a checkout, so
// nothing written inside the folder can retarget it. The marker's one job is to be noticed when the
// binding does not match: a folder that was copied, restored, or moved carries the marker but has
// no binding at its new path. That reads as "a copy of a hosted checkout, not bound", and the
// person can bind it again with `superbee checkout --adopt`, naming the host themselves.
//
// It sits in a dot-folder, which the bundle walk and the sync scan skip, so it is never a document,
// never synced and never held.
import { chmod, lstat, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { commandToken } from "../command-text.js";
import { cliInvocation } from "../invocation.js";
import { readRegularFileTextNoFollowSync } from "../nofollow-read.js";
import type { CheckoutBinding } from "./binding.js";
import { placeNew } from "./projection.js";

export const CHECKOUT_MARKER_DIR = ".superbee";
export const CHECKOUT_MARKER_FILE = "checkout.json";
export const CHECKOUT_MARKER_SCHEMA = 1;
const MAX_MARKER_BYTES = 4 * 1024;
const MARKER_NOTE =
  "Written by superbee checkout. Informational only: it never selects a host. If this folder was copied, moved or restored, bind it with: superbee checkout --adopt <folder> --host <host>";

/** What the marker says. Every field is data from the folder, never trusted to route. */
export interface CheckoutMarker {
  readonly home: "hosted";
  /** The host as `checkout --host` takes it: an origin, or an agent connection URL. */
  readonly host: string;
  readonly bundle_id: string;
  readonly workspace: string | null;
}

export function checkoutMarkerPath(folder: string): string {
  return path.join(folder, CHECKOUT_MARKER_DIR, CHECKOUT_MARKER_FILE);
}

/**
 * The host as `--host` takes it: the origin when the audience is the origin's own `/mcp`, else the
 * agent connection URL. The one derivation; `hostArgument` in the sign-in module delegates here.
 */
export function bindingHostArgument(binding: { readonly origin: string; readonly audience: string }): string {
  return binding.audience === `${binding.origin}/mcp` ? binding.origin : binding.audience;
}

export function markerFor(binding: CheckoutBinding): CheckoutMarker {
  return { home: "hosted", host: bindingHostArgument(binding), bundle_id: binding.bundle_id, workspace: binding.workspace };
}

function markerBytes(marker: CheckoutMarker): Buffer {
  return Buffer.from(`${JSON.stringify({ superbee_checkout: CHECKOUT_MARKER_SCHEMA, ...marker, note: MARKER_NOTE }, null, 2)}\n`, "utf8");
}

function isMarker(value: unknown): value is CheckoutMarker & { superbee_checkout: number } {
  const record = value as Record<string, unknown> | null;
  return (
    record !== null &&
    typeof record === "object" &&
    record.superbee_checkout === CHECKOUT_MARKER_SCHEMA &&
    record.home === "hosted" &&
    typeof record.host === "string" &&
    record.host.length > 0 &&
    record.host.length <= 2048 &&
    typeof record.bundle_id === "string" &&
    record.bundle_id.length > 0 &&
    record.bundle_id.length <= 128 &&
    (record.workspace === null || record.workspace === undefined || (typeof record.workspace === "string" && record.workspace.length <= 256))
  );
}

/**
 * The marker in this folder, or null when there is none or it cannot be read as one (a symbolic
 * link, an oversized file, malformed JSON). Never throws.
 */
export function readCheckoutMarker(folder: string): CheckoutMarker | null {
  let read;
  try {
    read = readRegularFileTextNoFollowSync(checkoutMarkerPath(folder));
  } catch {
    return null;
  }
  if (read.state !== "present" || Buffer.byteLength(read.text) > MAX_MARKER_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return null;
  }
  if (!isMarker(value)) return null;
  return { home: "hosted", host: value.host, bundle_id: value.bundle_id, workspace: value.workspace ?? null };
}

function sameMarker(a: CheckoutMarker, b: CheckoutMarker): boolean {
  return a.host === b.host && a.bundle_id === b.bundle_id && a.workspace === b.workspace;
}

/**
 * Write the binding's marker into its folder, read-only, unless an identical one is already there.
 * A differing marker (left by an earlier checkout of this folder) is replaced. The marker directory
 * is created only when absent; a symbolic link or file in its place is left alone and nothing is
 * written. Returns the path written, or null when nothing changed.
 */
export async function writeCheckoutMarker(folder: string, binding: CheckoutBinding): Promise<string | null> {
  const marker = markerFor(binding);
  const current = readCheckoutMarker(folder);
  if (current && sameMarker(current, marker)) return null;
  const dir = path.join(folder, CHECKOUT_MARKER_DIR);
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const file = checkoutMarkerPath(folder);
  try {
    const info = await lstat(file);
    if (!info.isFile()) return null;
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const outcome = await placeNew(file, markerBytes(marker));
  if (!outcome.placed) return null;
  await chmod(file, 0o444).catch(() => {});
  return file;
}

/** The bytes a marker for this binding holds, for callers that track what they placed. */
export function checkoutMarkerBytes(binding: CheckoutBinding): Buffer {
  return markerBytes(markerFor(binding));
}

/**
 * Remove the marker when it names this bundle on this host, and then its directory when that
 * leaves it empty. A marker for anything else, or a file that is not a marker, is kept. Returns
 * true when a marker was removed.
 */
export async function removeCheckoutMarker(folder: string, binding: Pick<CheckoutBinding, "origin" | "audience" | "bundle_id">): Promise<boolean> {
  const current = readCheckoutMarker(folder);
  if (!current || current.bundle_id !== binding.bundle_id || current.host !== bindingHostArgument(binding)) return false;
  try {
    await unlink(checkoutMarkerPath(folder));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await rmdir(path.join(folder, CHECKOUT_MARKER_DIR)).catch(() => {});
  return true;
}

/** The `copy_of_checkout` detail a receipt carries for a folder with a marker and no binding. */
export function unboundCopyDetail(folder: string, marker: CheckoutMarker): Record<string, unknown> {
  return {
    copy_of_checkout: {
      bound: false,
      host: marker.host,
      bundle_id: marker.bundle_id,
      ...(marker.workspace ? { workspace: marker.workspace } : {}),
      note: "this folder carries a hosted checkout marker but is not bound here (copied, moved or restored); it behaves as a local bundle until adopted",
      help: `${cliInvocation()} checkout --adopt ${commandToken(folder)} --host ${commandToken(marker.host)}`,
    },
  };
}
