// Up-front refusals in a hosted checkout (Mike's decision, September 22, 2026: refuse at the
// command, with "do this in the app"; Kind and recipe commands, which the app cannot do either, say
// what to do instead). A hosted checkout syncs whole documents only, through
// `documents.create.v1`, `documents.replace.v1` and `documents.delete.v1` (a deleted file, from
// `doc delete` or by hand, syncs as a delete). A command whose effect sync cannot send is
// refused before it touches the folder, instead of succeeding locally and being held forever.
// The held backstop at scan time (C2) still covers direct file edits.
//
// Only the commands in the table below pay for the check, and the check is one private-state
// lookup by the folder's canonical path; every other command runs unchanged.
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { resolveLocalBundleTarget } from "../bundle.js";
import { CliError } from "../errors.js";
import { commandToken } from "../command-text.js";
import { cliInvocation } from "../invocation.js";
import { bindingForPath, type CheckoutBinding } from "./binding.js";
import type { UnboundCopy } from "../bundle-home.js";
import { checkoutMarkerPath, unboundCopyDetail } from "./marker.js";
import { heldPathReason, type HeldFile, type HeldReason } from "./sync-scan.js";

type RefusalReason = "not_syncable" | "checkout_target";

interface RefusalRow {
  /** The command words, e.g. `["doc", "delete"]`; `"*"` matches any subcommand. */
  readonly words: readonly string[];
  readonly reason: RefusalReason;
  /** Why sync cannot send it, in a few words. */
  readonly why: string;
  /** When present, the row applies only to invocations this accepts. */
  readonly when?: (args: readonly string[]) => boolean;
  /** What to do instead, for a command the app cannot do either. */
  readonly instead?: string;
}

const KINDS_INSTEAD = "to design Kinds, work in a local or Git bundle and publish it";

/** The `--doc-key` value in argv, in either spelling; the last one wins, as the parser takes it. */
function docKey(args: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") break;
    if (token === "--doc-key") value = args[index + 1];
    else if (token.startsWith("--doc-key=")) value = token.slice("--doc-key=".length);
  }
  return value;
}

/** True when sync holds a file at `key` whatever its content (`heldPathReason`); `.md` compared in any case, as before. */
function heldKey(key: string): boolean {
  const rel = key.toLowerCase().endsWith(".md") ? `${key.slice(0, -3)}.md` : key;
  return heldPathReason(rel) !== null;
}

/** Every command a hosted checkout refuses up front. The order is the lookup order. */
export const HOSTED_CHECKOUT_REFUSALS: readonly RefusalRow[] = Object.freeze(([
  { words: ["doc", "verify"], reason: "not_syncable", why: "verification is a managed field the host records" },
  { words: ["kind", "*"], reason: "not_syncable", why: "a hosted bundle's Kinds cannot be changed from a checkout", instead: KINDS_INSTEAD },
  { words: ["recipe", "add"], reason: "not_syncable", why: "recipes change a hosted bundle's Kinds, which cannot be changed from a checkout", instead: KINDS_INSTEAD },
  { words: ["recipe", "evolve"], reason: "not_syncable", why: "recipes change a hosted bundle's Kinds, which cannot be changed from a checkout", instead: KINDS_INSTEAD },
  { words: ["artifact", "*"], reason: "not_syncable", why: "artifacts carry blobs, which do not sync" },
  {
    words: ["promote"],
    reason: "not_syncable",
    why: "a key that is not a .md document is stored as a blob, and blobs, reserved files and conventions do not sync",
    when: (args) => heldKey(docKey(args) ?? ""),
  },
  {
    words: ["delete"],
    reason: "not_syncable",
    why: "a key that is not a .md document is a blob, and blobs, reserved files and conventions do not sync (delete a document with doc delete)",
    when: (args) => {
      const key = docKey(args);
      return key !== undefined && heldKey(key);
    },
  },
  {
    words: ["index", "generate"],
    reason: "not_syncable",
    why: "index.md files are reserved navigation the host keeps; generated ones would be held by sync",
    // --check only reports whether the indexes are current; it writes nothing.
    when: (args) => !args.some((token) => token === "--check" || token.startsWith("--check=")),
  },
  { words: ["serve"], reason: "not_syncable", why: "the served bundle accepts writes and deletes that do not sync" },
  { words: ["ui"], reason: "not_syncable", why: "the local app writes Views and conventions, which do not sync" },
  { words: ["init"], reason: "checkout_target", why: "the folder is a hosted checkout, not a local bundle" },
] satisfies RefusalRow[]).map((row): RefusalRow => Object.freeze({ ...row, words: Object.freeze([...row.words]) })));

function matchRow(command: string, args: readonly string[]): RefusalRow | undefined {
  const sub = args.find((token) => !token.startsWith("-"));
  return HOSTED_CHECKOUT_REFUSALS.find((row) => {
    if (row.words[0] !== command) return false;
    if (row.when && !row.when(args)) return false;
    if (row.words.length === 1) return true;
    return row.words[1] === "*" ? sub !== undefined : row.words[1] === sub;
  });
}

/** The `--dir` value, and whether `--remote` or help was asked for; a malformed argv is left to the command. */
function scan(args: readonly string[]): { dir: string | undefined; skip: boolean } {
  let dir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") break;
    if (token === "--help" || token === "-h" || token === "--remote" || token.startsWith("--remote=")) return { dir, skip: true };
    if (token === "--dir") dir = args[index + 1];
    else if (token.startsWith("--dir=")) dir = token.slice("--dir=".length);
  }
  return { dir, skip: false };
}

async function checkoutFor(command: string, dir: string | undefined, home: string, cwd: string): Promise<CheckoutBinding | null> {
  let root: string;
  try {
    if (command === "init") root = await realpath(path.resolve(cwd, dir ?? "."));
    else root = (await resolveLocalBundleTarget(dir, cwd)).canonicalRoot;
  } catch {
    // No resolvable target: not a checkout, and the command reports its own error.
    return null;
  }
  return bindingForPath(home, root);
}

export function hostedCheckoutRefusal(row: RefusalRow, words: string, binding: CheckoutBinding, extra: Readonly<Record<string, string>> = {}): CliError {
  const details = { reason: row.reason, command: words, bundle_id: binding.bundle_id, host: binding.origin, checkout: binding.path, ...extra };
  if (row.reason === "checkout_target") {
    return new CliError("FORBIDDEN", `'${words}' refused: ${row.why} (bundle ${binding.bundle_id} on ${binding.origin})`, {
      details,
      help: "choose another folder for a local bundle",
    });
  }
  if (row.instead) {
    return new CliError("FORBIDDEN", `'${words}' cannot sync from a hosted checkout (${row.why}): ${row.instead}`, { details, help: row.instead });
  }
  return new CliError("FORBIDDEN", `'${words}' cannot sync from a hosted checkout (${row.why}): do this in the Superbee app`, {
    details: { ...details, do_this_in: "app" },
    help: `do this in the Superbee app for bundle ${binding.bundle_id} on ${binding.origin}`,
  });
}

export interface RefusalContext {
  readonly home?: string;
  readonly cwd?: string;
}

/**
 * Throw the up-front refusal when `command args` would run against a hosted checkout and is a
 * command sync cannot send. Resolves for every other command and target.
 */
export async function assertAllowedInHostedCheckout(command: string, args: readonly string[], context: RefusalContext = {}): Promise<void> {
  const row = matchRow(command, args);
  if (!row) return;
  const { dir, skip } = scan(args);
  if (skip) return;
  const binding = await checkoutFor(command, dir, context.home ?? homedir(), context.cwd ?? process.cwd());
  if (!binding) return;
  const sub = row.words.length > 1 ? args.find((token) => !token.startsWith("-")) : undefined;
  throw hostedCheckoutRefusal(row, sub ? `${command} ${sub}` : command, binding);
}

/** What to do instead of a write sync would hold, by the reason the scan records. */
const HELD_INSTEAD: Partial<Record<HeldReason, string>> = {
  type_change: "keep the document's type; a checkout cannot change it (create a new document instead)",
  too_large: "keep the document within the size a sync write carries",
  not_sendable: "change the document so sync can send it",
  unsafe_path: "use a document id sync can send",
};

/**
 * The refusal for a write the local MCP app tries in a hosted checkout that sync would hold
 * (`served-bundle.ts`), made before the file is touched. `details.held_reason` is the reason the
 * sync scan would record. Blobs, reserved files and conventions are the app's to change.
 */
export function hostedHeldWriteRefusal(binding: CheckoutBinding, held: HeldFile): CliError {
  const instead = HELD_INSTEAD[held.reason];
  return hostedCheckoutRefusal(
    { words: ["mcp"], reason: "not_syncable", why: held.message, ...(instead ? { instead } : {}) },
    "mcp write",
    binding,
    { held_reason: held.reason, id: held.id },
  );
}

/**
 * The refusal for an MCP write that changes `verified` in a hosted checkout. Sync never sends a
 * managed field, so the edit would be lost; it is refused as `doc verify` is, before the file
 * changes.
 */
export function hostedManagedFieldRefusal(binding: CheckoutBinding, id: string, field: string): CliError {
  const verify = HOSTED_CHECKOUT_REFUSALS.find((row) => row.words[0] === "doc" && row.words[1] === "verify")!;
  return hostedCheckoutRefusal({ words: ["mcp"], reason: verify.reason, why: verify.why }, "mcp write", binding, { id, field });
}

/**
 * A folder that carries a hosted checkout marker but no binding here (moved, copied or restored, or
 * an in-place export that stopped part way): nothing done in it reaches the host. Every command that
 * refuses such a folder (`sync`, `publish`, `checkout` into it, and the local MCP app's writes) does
 * it in this one shape, naming how to bind it again (or finish the export), or how to keep it as a
 * plain local bundle.
 */
export function unboundCopyRefusal(copy: UnboundCopy, code: "USAGE" | "FORBIDDEN" | "ALREADY_EXISTS", message: string, extra: Readonly<Record<string, string>> = {}): CliError {
  const { folder, marker } = copy;
  const detail = unboundCopyDetail(folder, marker).copy_of_checkout as { note: string; help: string };
  return new CliError(code, message, {
    details: {
      reason: "unbound_copy",
      ...extra,
      folder,
      marker_host: marker.host,
      marker_bundle_id: marker.bundle_id,
      note: detail.note,
      or: `to use it as a plain local bundle instead, delete ${checkoutMarkerPath(folder)}`,
    },
    help: detail.help,
  });
}

/**
 * The host no longer serves a checkout's bundle (`bundle_not_found`): it was deleted there, or the
 * person's access was removed. A conflict with the checkout, whose files stay; `unsent` is the
 * count of changes sync has not sent, when the command knows it.
 */
export function bundleGone(binding: CheckoutBinding, unsent?: number): CliError {
  return new CliError(
    "CONFLICT",
    `hosted bundle '${binding.bundle_id}' is no longer served to you on ${binding.origin}: it was deleted there, or your access was removed`,
    {
      details: { reason: "bundle_deleted_remotely", bundle_id: binding.bundle_id, host: binding.origin, folder: binding.path, ...(unsent === undefined ? {} : { unsent_changes: unsent }) },
      help: `your files stay in ${binding.path}; to keep them as a plain folder: ${cliInvocation()} checkout --release ${commandToken(binding.path)}`,
    },
  );
}
