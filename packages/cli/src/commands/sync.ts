// `agentstate-lite sync` — the historical import surface; the implementation lives in ./sync/
// (orchestration, conflict convergence + receipts, the --show-incoming viewer).
export * from "./sync/orchestrate.js";
export * from "./sync/converge.js";
export * from "./sync/show-incoming.js";
// The refusal/guidance templates live in THE sync-outcome table (../sync-outcomes.ts); these
// re-exports keep the module's historical import surface stable.
export { ffSwallowToError, inTreeNoBasisNote, syncInTreeRefusalMessage, upstreamHelp } from "../sync-outcomes.js";

import { homedir } from "node:os";

import { isBoardGitError } from "@superbee/board-git";
import { CliError, cliErrorFromBoardGit } from "../errors.js";
import { renderUsage } from "../output.js";
import type { SyncCliDeps } from "../sync-cli.js";
import { dirArgument, hostedCheckoutFor, hostedSync, HOSTED_SYNC_USAGE, type HostedSyncDeps } from "../hosted/sync.js";
import { gitConflictVerb, hostedOnlyVerbError, requestsConflictVerb, requestsHostedOnlyVerb } from "./sync/git-conflict.js";
import { sync as gitSync, SYNC_USAGE } from "./sync/orchestrate.js";
import { bundleHomeAt, unboundLocalCopyAt, type UnboundCopy } from "../bundle-home.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { writeCheckoutMarker } from "../hosted/marker.js";
import { unboundCopyRefusal } from "../hosted/refusals.js";

export type UnifiedSyncDeps = Partial<SyncCliDeps> & Partial<HostedSyncDeps>;

function requestsHelp(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
  }
  return false;
}

/**
 * `superbee sync`: one command for both kinds of checkout. A folder made by `superbee checkout`
 * syncs with its hosted bundle (`../hosted/sync.ts`); every other target is a Git board and takes
 * the Git sync unchanged. The target decides, never a flag.
 */
export async function sync(argv: string[], deps: UnifiedSyncDeps = {}): Promise<void> {
  if (requestsHelp(argv)) {
    (deps.stdout ?? ((text: string) => void process.stdout.write(text)))(renderUsage(`${SYNC_USAGE}\nHosted checkouts (the target decides; there is no flag):\n\n${HOSTED_SYNC_USAGE}`));
    return;
  }
  const home = deps.auth?.home ?? homedir();
  const binding = await hostedCheckoutFor(argv, home, deps.cwd ?? process.cwd());
  if (binding) {
    // A checkout made before the folder marker existed gets one (best effort; it never routes).
    await writeCheckoutMarker(binding.path, binding).catch(() => null);
    await hostedSync(argv, binding, deps);
    return;
  }
  // `--establish` shares the folder as a Git board: the marker does not stand in its way.
  const copy = argv.includes("--establish") ? null : await unboundCheckoutCopy(argv, deps.cwd ?? process.cwd(), home);
  if (copy) {
    throw unboundCopyRefusal(copy, "USAGE", `${copy.folder} is a copy of a hosted checkout of '${copy.marker.bundle_id}' that is not bound here, so sync has nowhere to send it`);
  }
  // The conflict verbs are one grammar for both homes: on a Git board they read the copy a
  // converged sync saved and finish its reconcile chain. The deletion verbs stay hosted-only.
  if (requestsHostedOnlyVerb(argv)) throw hostedOnlyVerbError(await targetHome(argv, deps.cwd ?? process.cwd(), home), argv);
  if (requestsConflictVerb(argv)) {
    try {
      await gitConflictVerb(argv, deps);
    } catch (err) {
      throw isBoardGitError(err) ? cliErrorFromBoardGit(err) : err;
    }
    return;
  }
  await gitSync(argv, deps);
}

/**
 * The home a deletion verb is refused in: a Git board, or else a local bundle. A target that does
 * not resolve is left to the refusal's own words (local).
 */
async function targetHome(argv: readonly string[], cwd: string, home: string): Promise<"local" | "git"> {
  let root: string;
  try {
    root = (await resolveLocalBundleTarget(dirArgument(argv), cwd)).canonicalRoot;
  } catch (error) {
    if (error instanceof CliError) return "local";
    throw error;
  }
  return (await bundleHomeAt(root, { home })).home === "git" ? "git" : "local";
}


/**
 * The unbound checkout copy this sync targets: a local bundle (not a Git board) whose folder
 * carries a hosted checkout marker with no binding. Local reads only; null for anything else.
 */
async function unboundCheckoutCopy(argv: readonly string[], cwd: string, home: string): Promise<UnboundCopy | null> {
  try {
    const target = await resolveLocalBundleTarget(dirArgument(argv), cwd);
    return await unboundLocalCopyAt(target.canonicalRoot, { home });
  } catch {
    return null;
  }
}
