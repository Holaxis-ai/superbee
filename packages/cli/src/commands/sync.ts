// `agentstate-lite sync` — the historical import surface; the implementation lives in ./sync/
// (orchestration, conflict convergence + receipts, the --show-incoming viewer).
export * from "./sync/orchestrate.js";
export * from "./sync/converge.js";
export * from "./sync/show-incoming.js";
// The refusal/guidance templates live in THE sync-outcome table (../sync-outcomes.ts); these
// re-exports keep the module's historical import surface stable.
export { ffSwallowToError, inTreeNoBasisNote, syncInTreeRefusalMessage, upstreamHelp } from "../sync-outcomes.js";

import { homedir } from "node:os";

import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { renderUsage } from "../output.js";
import type { SyncCliDeps } from "../sync-cli.js";
import { dirArgument, hostedCheckoutFor, hostedSync, HOSTED_SYNC_USAGE, requestsHostedVerb, type HostedSyncDeps } from "../hosted/sync.js";
import { sync as gitSync, SYNC_USAGE } from "./sync/orchestrate.js";
import { bundleHomeAt, type UnboundCopy } from "../bundle-home.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { commandToken } from "../command-text.js";
import { writeCheckoutMarker } from "../hosted/marker.js";

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
  const copy = await unboundCheckoutCopy(argv, deps.cwd ?? process.cwd(), home);
  if (copy) {
    throw new CliError("USAGE", `${copy.folder} is a copy of a hosted checkout of '${copy.marker.bundle_id}' that is not bound here, so sync has nowhere to send it`, {
      details: { reason: "unbound_copy", folder: copy.folder, marker_host: copy.marker.host, marker_bundle_id: copy.marker.bundle_id },
      help: `${cliInvocation()} checkout --adopt ${commandToken(copy.folder)} --host ${commandToken(copy.marker.host)}`,
    });
  }
  if (requestsHostedVerb(argv)) {
    throw new CliError("USAGE", "--inspect, --resolve and --doc apply to a hosted checkout; this folder is not one", {
      help: `for a Git board, see incoming changes with: ${cliInvocation()} sync --show-incoming <id>`,
    });
  }
  await gitSync(argv, deps);
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
