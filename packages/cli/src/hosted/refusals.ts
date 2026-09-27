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

import { isConventionId } from "@superbee/core";
import type { LoadedRecipe } from "@superbee/core/recipes";

import { resolveLocalBundleTarget } from "../bundle.js";
import { CliError } from "../errors.js";
import { commandToken } from "../command-text.js";
import { cliInvocation } from "../invocation.js";
import { bindingForPath, type CheckoutBinding } from "./binding.js";
import type { UnboundCopy } from "../bundle-home.js";
import { readBundleListing, type HostedSyncClient } from "./client.js";
import { bindingHostArgument, checkoutMarkerPath, unboundCopyInfo } from "./marker.js";
import { DEFINITIONS_REFUSED, heldPathReason, type HeldFile, type HeldReason } from "./sync-scan.js";

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
  /**
   * A command that changes the bundle's model (its Kind conventions). It runs when the host last
   * said this person may (`definition_writes: "allowed"`), is refused with {@link DEFINITIONS_REFUSED}
   * when the host said they may not, and is refused as the row says when the host did not say.
   */
  readonly definitions?: true;
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
  { words: ["kind", "*"], reason: "not_syncable", why: "a hosted bundle's Kinds cannot be changed from a checkout", instead: KINDS_INSTEAD, definitions: true },
  { words: ["recipe", "add"], reason: "not_syncable", why: "recipes change a hosted bundle's Kinds, which cannot be changed from a checkout", instead: KINDS_INSTEAD, definitions: true },
  { words: ["recipe", "evolve"], reason: "not_syncable", why: "recipes change a hosted bundle's Kinds, which cannot be changed from a checkout", instead: KINDS_INSTEAD, definitions: true },
  { words: ["artifact", "*"], reason: "not_syncable", why: "artifacts carry blobs, which do not sync" },
  {
    words: ["promote"],
    reason: "not_syncable",
    why: "a key that is not a .md document is stored as a blob; blobs, reserved files and View files do not sync, and conventions change only through the kind and recipe commands",
    when: (args) => heldKey(docKey(args) ?? ""),
  },
  {
    words: ["delete"],
    reason: "not_syncable",
    why: "a key that is not a .md document is a blob; blobs, reserved files and View files do not sync, and conventions change only through the kind and recipe commands (delete a document with doc delete)",
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
  { words: ["ui"], reason: "not_syncable", why: "the local app writes Views, which do not sync, and conventions outside the kind and recipe commands" },
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
  if (row.definitions && binding.definition_writes === "refused") {
    const { why, instead } = DEFINITIONS_REFUSED;
    return new CliError("FORBIDDEN", `'${words}' refused: ${why} (bundle ${binding.bundle_id} on ${binding.origin}); ${instead}`, {
      details: { ...details, reason: "definitions_refused" },
      help: instead,
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
  // A model change by a person the host allows: the command runs, and sync sends the conventions
  // (a recipe carrying more than Kind conventions is refused by the command, `assertKindOnlyRecipe`).
  if (row.definitions && binding.definition_writes === "allowed") return;
  const sub = row.words.length > 1 ? args.find((token) => !token.startsWith("-")) : undefined;
  throw hostedCheckoutRefusal(row, sub ? `${command} ${sub}` : command, binding);
}

/**
 * In a hosted checkout, `recipe add` and `recipe evolve` may write only Kind conventions
 * (designs/hosted-model-evolution.md section 8): every artifact a recipe installs must be an
 * {@link isConventionId} id. A recipe that also carries Views, their pages, References or any other
 * document is refused before anything is written, naming them; those are published with the
 * bundle. The up-front refusal has already let the command run only for a person the host allows.
 * Resolves for any other target.
 */
export async function assertKindOnlyRecipe(
  words: string,
  dir: string | undefined,
  recipe: Pick<LoadedRecipe, "id" | "docs" | "pages" | "references">,
  context: RefusalContext = {},
): Promise<void> {
  const artifacts = [...recipe.docs.map((doc) => doc.id), ...recipe.pages.flatMap((page) => [page.registry.id, page.entry]), ...recipe.references.map((reference) => reference.doc.id)];
  const outside = artifacts.filter((id) => !isConventionId(id));
  if (outside.length === 0) return;
  const binding = await checkoutFor("recipe", dir, context.home ?? homedir(), context.cwd ?? process.cwd());
  if (!binding) return;
  throw hostedCheckoutRefusal(
    { words: words.split(" "), reason: "not_syncable", why: `recipe '${recipe.id}' installs ${outside.length} artifact(s) outside conventions/, such as Views and References, and a checkout sends Kind conventions only`, instead: KINDS_INSTEAD },
    words,
    binding,
    { recipe: recipe.id, artifacts: outside.slice(0, 20).join(", "), artifacts_total: String(outside.length) },
  );
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
 * A bare bundle id two or more of the person's workspaces hold: no command can tell which one is
 * meant. It lists the references the host named for it and never picks one: the help names the
 * form to choose with, so no agent runs a command that silently selects one workspace's bundle.
 */
export function ambiguousBundle(bundleId: string, target: { readonly origin: string; readonly audience: string }, references: readonly string[], details: Record<string, unknown> = {}, help?: string): CliError {
  const host = bindingHostArgument(target);
  return new CliError("CONFLICT", `hosted bundle id '${bundleId}' is in more than one of your workspaces on ${target.origin}: name the one you mean as <workspace>/${bundleId}`, {
    details: { reason: "ambiguous_bundle", bundle_id: bundleId, host: target.origin, ...(references.length > 0 ? { references } : {}), ...details },
    help: help ?? `${cliInvocation()} checkout <workspace>/<bundle-id> --host ${commandToken(host)} (${cliInvocation()} catalog list --hosted --host ${commandToken(host)} lists them)`,
  });
}

/**
 * The refusal for an MCP write that changes `verified` in a hosted checkout. Sync never sends a
 * managed field, so the edit would be lost; it is refused as `doc verify` is, before the file
 * changes.
 */
export function hostedManagedFieldRefusal(binding: CheckoutBinding, id: string): CliError {
  const verify = HOSTED_CHECKOUT_REFUSALS.find((row) => row.words[0] === "doc" && row.words[1] === "verify")!;
  return hostedCheckoutRefusal({ ...verify, words: ["mcp"] }, "mcp write", binding, { id, field: "verified" });
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
  const detail = unboundCopyInfo(folder, marker);
  return new CliError(code, message, {
    details: {
      reason: "unbound_copy",
      ...extra,
      folder,
      marker_host: marker.host,
      marker_bundle_id: marker.bundle_id,
      note: detail.note,
      // Deleting the marker of a stopped in-place export would abandon the resume the help names.
      ...(detail.export_stopped ? {} : { or: `to use it as a plain local bundle instead, delete ${checkoutMarkerPath(folder)}` }),
    },
    help: detail.help,
  });
}

/**
 * The host answered a checkout's bundle as absent. A checkout that names no workspace, whose id the
 * host now lists in two or more of the person's workspaces, was not deleted: the id became
 * ambiguous. Its folder can be bound again naming the workspace, in place (`checkout --adopt
 * <folder> --host <host> --workspace <slug>`). Anything else is {@link bundleGone}. The listing is
 * read once; if that read fails, the answer is {@link bundleGone}.
 */
export async function bundleAbsent(binding: CheckoutBinding, client: Pick<HostedSyncClient, "bundles">, unsent?: number): Promise<CliError> {
  if (!binding.workspace_slug) {
    let found: { holders: number; references: readonly string[] } | null = null;
    try {
      found = readBundleListing(await client.bundles()).lookup({ slug: null, bundleId: binding.bundle_id });
    } catch {
      // The listing could not be read: the refusal the host gave stands.
    }
    if (found && found.holders > 1) {
      return ambiguousBundle(
        binding.bundle_id,
        binding,
        found.references,
        { folder: binding.path, ...(unsent === undefined ? {} : { unsent_changes: unsent }) },
        `your files stay in ${binding.path}; bind this folder to the one you mean, in place: ${cliInvocation()} checkout --adopt ${commandToken(binding.path)} --host ${commandToken(bindingHostArgument(binding))} --workspace <workspace>`,
      );
    }
  }
  return bundleGone(binding, unsent);
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
