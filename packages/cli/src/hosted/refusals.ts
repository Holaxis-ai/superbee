// Up-front refusals in a hosted checkout (Mike's decision, September 22, 2026: refuse at the
// command, with "do this in the app"). A hosted checkout syncs whole documents only, through
// `documents.create.v1` and `documents.replace.v1`. A command whose effect sync cannot send is
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
import { bindingForPath, type CheckoutBinding } from "./binding.js";

type RefusalReason = "not_syncable" | "checkout_target";

interface RefusalRow {
  /** The command words, e.g. `["doc", "delete"]`; `"*"` matches any subcommand. */
  readonly words: readonly string[];
  readonly reason: RefusalReason;
  /** Why sync cannot send it, in a few words. */
  readonly why: string;
  /** When present, the row applies only to invocations this accepts. */
  readonly when?: (args: readonly string[]) => boolean;
}

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

/** `mcp` subcommands that manage the host registration and never open a bundle. */
const MCP_REGISTRATION: ReadonlySet<string> = new Set(["install", "status", "uninstall"]);

/** Every command a hosted checkout refuses up front. The order is the lookup order. */
export const HOSTED_CHECKOUT_REFUSALS: readonly RefusalRow[] = Object.freeze(([
  { words: ["doc", "delete"], reason: "not_syncable", why: "deleting a document does not sync yet" },
  { words: ["delete"], reason: "not_syncable", why: "deleting a document does not sync yet" },
  { words: ["doc", "verify"], reason: "not_syncable", why: "verification is a managed field the host records" },
  { words: ["kind", "*"], reason: "not_syncable", why: "Kind conventions are edited in the app" },
  { words: ["recipe", "add"], reason: "not_syncable", why: "recipes change Kind and View conventions, which are edited in the app" },
  { words: ["recipe", "evolve"], reason: "not_syncable", why: "recipes change Kind and View conventions, which are edited in the app" },
  { words: ["artifact", "*"], reason: "not_syncable", why: "artifacts carry blobs, which do not sync" },
  {
    words: ["promote"],
    reason: "not_syncable",
    why: "a key that is not a .md document is stored as a blob, and blobs do not sync",
    when: (args) => !(docKey(args) ?? "").toLowerCase().endsWith(".md"),
  },
  { words: ["serve"], reason: "not_syncable", why: "the served bundle accepts writes and deletes that do not sync" },
  { words: ["ui"], reason: "not_syncable", why: "the local app writes Views and conventions, which do not sync" },
  {
    words: ["mcp"],
    reason: "not_syncable",
    why: "the local MCP app writes Views and conventions, which do not sync",
    when: (args) => !MCP_REGISTRATION.has(args.find((token) => !token.startsWith("-")) ?? ""),
  },
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

export function hostedCheckoutRefusal(row: RefusalRow, words: string, binding: CheckoutBinding): CliError {
  const details = { reason: row.reason, command: words, bundle_id: binding.bundle_id, host: binding.origin, checkout: binding.path };
  if (row.reason === "checkout_target") {
    return new CliError("FORBIDDEN", `'${words}' refused: ${row.why} (bundle ${binding.bundle_id} on ${binding.origin})`, {
      details,
      help: "choose another folder for a local bundle",
    });
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
