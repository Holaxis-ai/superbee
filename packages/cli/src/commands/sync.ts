// `agentstate-lite sync` — the historical import surface; the implementation lives in ./sync/
// (orchestration, conflict convergence + receipts, the --show-incoming viewer).
export * from "./sync/orchestrate.js";
export * from "./sync/converge.js";
export * from "./sync/show-incoming.js";
// The refusal/guidance templates live in THE sync-outcome table (../sync-outcomes.ts); these
// re-exports keep the module's historical import surface stable.
export { ffSwallowToError, inTreeNoBasisNote, syncInTreeRefusalMessage, upstreamHelp } from "../sync-outcomes.js";

import { homedir } from "node:os";
import path from "node:path";

import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { renderUsage } from "../output.js";
import type { SyncCliDeps } from "../sync-cli.js";
import { dirArgument, hostedCheckoutFor, hostedSync, HOSTED_SYNC_USAGE, type HostedSyncDeps } from "../hosted/sync.js";
import { gitConflictVerb, hostedOnlyVerbError, requestsConflictVerb, requestsHostedOnlyVerb } from "./sync/git-conflict.js";
import { sync as gitSync, SYNC_USAGE } from "./sync/orchestrate.js";
import { bundleHomeAt, type UnboundCopy } from "../bundle-home.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { commandToken } from "../command-text.js";
import { writeCheckoutMarker } from "../hosted/marker.js";
import { withSyncEnvelope, type SyncHome } from "../sync-outcomes.js";

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
    await hostedSync(argv, binding, withEnvelope(argv, deps, "hosted"));
    return;
  }
  // `--establish` shares the folder as a Git board: the marker does not stand in its way.
  const copy = argv.includes("--establish") ? null : await unboundCheckoutCopy(argv, deps.cwd ?? process.cwd(), home);
  if (copy) {
    throw new CliError("USAGE", `${copy.folder} is a copy of a hosted checkout of '${copy.marker.bundle_id}' that is not bound here, so sync has nowhere to send it`, {
      details: {
        reason: "unbound_copy",
        folder: copy.folder,
        marker_host: copy.marker.host,
        marker_bundle_id: copy.marker.bundle_id,
        or: `to use it as a plain local bundle instead, delete ${path.join(copy.folder, ".superbee", "checkout.json")}`,
      },
      help: `${cliInvocation()} checkout --adopt ${commandToken(copy.folder)} --host ${commandToken(copy.marker.host)}`,
    });
  }
  // The conflict verbs are one grammar for both homes: on a Git board they read the copy a
  // converged sync saved and finish its reconcile chain. The deletion verbs stay hosted-only.
  if (requestsHostedOnlyVerb(argv)) throw hostedOnlyVerbError(await targetHome(argv, deps.cwd ?? process.cwd(), home));
  if (requestsConflictVerb(argv)) {
    await gitConflictVerb(argv, deps);
    return;
  }
  await gitSync(argv, envelopedRun(argv) ? withEnvelope(argv, deps, await targetHome(argv, deps.cwd ?? process.cwd(), home)) : deps);
}

/** The home of a sync target that is not a hosted checkout: a Git board, or a local bundle. */
async function targetHome(argv: readonly string[], cwd: string, home: string): Promise<"local" | "git"> {
  try {
    const root = (await resolveLocalBundleTarget(dirArgument(argv), cwd)).canonicalRoot;
    return (await bundleHomeAt(root, { home })).home === "git" ? "git" : "local";
  } catch {
    return "local";
  }
}

/** True for a sync run (not a conflict verb or the incoming viewer) asked for as JSON. */
function envelopedRun(argv: readonly string[]): boolean {
  let json = false;
  for (const token of argv) {
    if (token === "--") break;
    if (token === "--json") json = true;
    // The conflict verbs and the incoming viewer print their own records, not a run receipt.
    if (["--show-incoming", "--inspect", "--resolve"].some((flag) => token === flag || token.startsWith(`${flag}=`))) return false;
  }
  return json;
}

/**
 * The sync's stdout with the one receipt envelope added to its `--json` run receipt
 * (`withSyncEnvelope`): the same keys in every home, beside each home's own. TOON output, error
 * envelopes and the incoming viewer's bytes are unchanged.
 */
function withEnvelope<T extends UnifiedSyncDeps>(argv: readonly string[], deps: T, home: SyncHome): T {
  if (!envelopedRun(argv)) return deps;
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  return { ...deps, stdout: (text: string) => out(withSyncEnvelope(text, home)) };
}

/**
 * The unbound checkout copy this sync targets: a local bundle (not a Git board) whose folder
 * carries a hosted checkout marker with no binding. Local reads only; null for anything else.
 */
async function unboundCheckoutCopy(argv: readonly string[], cwd: string, home: string): Promise<UnboundCopy | null> {
  try {
    const target = await resolveLocalBundleTarget(dirArgument(argv), cwd);
    const facts = await bundleHomeAt(target.canonicalRoot, { home });
    return facts.home === "local" && facts.copy ? facts.copy : null;
  } catch {
    return null;
  }
}
