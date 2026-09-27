// The hosted bundles a person can reach and has no folder for yet, listed beside their folders
// (designs/seamless-multi-backend-cli, Q2 and S3): `catalog list` and the local MCP app's
// `list_workspaces` show them so an agent finds hosted work without knowing a flag.
//
// Only with a live sign-in: a host is asked only when its stored session record is usable (an
// unexpired access token, or a refresh token; `storedSessionMayNeedSignIn`) or an access token for
// it is in the environment. Nothing here ever starts a sign-in, and a refresh counts against the
// same budget as the listing. Signed out, nothing is asked and nothing is said, so the listing is
// exactly the folders. On a timeout or any other failure the folders are listed with one note. The
// answer is never stored on disk. Which hosts: the host of the last sign-in, and the host of every
// checkout on this machine.
import { homedir } from "node:os";

import { stripHostText } from "@superbee/core";

import { commandFragment, commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import { defaultHostedAuthDeps, hostArgument, hostedBundleHost, SignedOutError, storedSessionMayNeedSignIn, type HostedAuthDeps } from "../hosted-auth/session.js";
import { checkoutTarget, connectHostedAccount } from "./account.js";
import { listReadyBindings, liveCheckoutFolders } from "./binding.js";
import { readBundleListing, type HostedSyncClient } from "./client.js";
import { fetchWithDeadline } from "./freshness.js";

/** One hosted bundle as a listing row: `folder` is the first live checkout of it here, sorted, or null. */
export interface HostedBundleRow {
  readonly bundle_id: string;
  readonly name: string;
  readonly lifecycle: string | null;
  readonly folder: string | null;
  /** Two of the person's workspaces hold the same id; `checkout` refuses it. */
  readonly ambiguous: boolean;
}

/**
 * Every bundle the host lists for this person, with the folder of a live checkout of each here.
 * The host's text is shown to people and agents, so names are stripped of control and format
 * characters (`stripHostText`); a bundle id that is not plain text is left out, since no command
 * could name it safely.
 */
export async function hostedBundleRows(client: HostedSyncClient, target: HostedTarget, home: string): Promise<{ rows: HostedBundleRow[]; complete: boolean }> {
  const listing = readBundleListing(await client.bundles());
  const folders = await liveCheckoutFolders(home, target);
  const rows = [...listing.bundles.values()]
    .filter(({ row }) => row.bundleId !== "" && stripHostText(row.bundleId, 256) === row.bundleId)
    .sort((a, b) => (a.row.bundleId < b.row.bundleId ? -1 : a.row.bundleId > b.row.bundleId ? 1 : 0))
    .map(({ row, workspaces }) => ({
      bundle_id: row.bundleId,
      name: stripHostText(row.name, 200),
      lifecycle: row.lifecycle === null ? null : stripHostText(row.lifecycle, 64),
      folder: folders.get(row.bundleId)?.[0] ?? null,
      ambiguous: workspaces > 1,
    }));
  return { rows, complete: listing.complete };
}

/**
 * The hosted bundles one host lists that have no folder here, each with the command that brings it
 * into one. An id two of the person's workspaces hold has none (`checkout` refuses it): `ask`
 * lists them all.
 */
export interface ReachableHost {
  readonly host: string;
  readonly complete: boolean;
  /** The command that lists every bundle on this host (`catalog list --hosted`). */
  readonly ask: string;
  readonly bundles: readonly (HostedBundleRow & { readonly checkout?: string })[];
}

export interface ReachableListing {
  readonly hosts: readonly ReachableHost[];
  /** One line per host that could not be asked in time or at all, naming the command that asks it. */
  readonly notes: readonly string[];
}

export interface ReachableOptions {
  readonly home?: string;
  /** The whole listing's budget, sign-in refresh included. */
  readonly budgetMs: number;
  readonly auth?: HostedAuthDeps;
  readonly fetch?: typeof fetch;
}

/** The hosts to ask: the last sign-in's and every checkout's, each once. */
async function candidateHosts(home: string): Promise<HostedTarget[]> {
  const out = new Map<string, HostedTarget>();
  const remembered = await hostedBundleHost(undefined, home).catch(() => null);
  if (remembered) {
    try {
      const target = resolveHostedTarget(remembered);
      out.set(`${target.origin} ${target.audience}`, target);
    } catch {
      // An unusable remembered host is ignored; login replaces it.
    }
  }
  for (const binding of await listReadyBindings(home).catch(() => [])) {
    try {
      const target = checkoutTarget(binding);
      out.set(`${target.origin} ${target.audience}`, target);
    } catch {
      // An inconsistent binding is reported by the commands that use it.
    }
  }
  return [...out.values()];
}

/**
 * The hosted bundles with no folder here, from every host with a live sign-in; null when no host has
 * one (signed out: the caller lists folders only, as before).
 */
export async function reachableHostedBundles(options: ReachableOptions): Promise<ReachableListing | null> {
  // A hard wall clock: whatever the budget does not bound (a credential store that hangs) never
  // holds the listing past it.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ReachableListing>((resolve) => {
    timer = setTimeout(() => resolve({ hosts: [], notes: [`hosted bundles were not listed (no answer in time); list them with: ${cliInvocation()} catalog list --hosted`] }), options.budgetMs + 250);
  });
  try {
    return await Promise.race([askHosts(options), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function askHosts(options: ReachableOptions): Promise<ReachableListing | null> {
  const home = options.auth?.home ?? options.home ?? homedir();
  const base = options.auth ?? defaultHostedAuthDeps(home);
  const live: HostedTarget[] = [];
  for (const target of await candidateHosts(home)) {
    if (!(await storedSessionMayNeedSignIn(home, target, base.env, base.now()).catch(() => true))) live.push(target);
  }
  if (live.length === 0) return null;
  const deadline = Date.now() + options.budgetMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const auth: HostedAuthDeps = { ...base, fetch: fetchWithDeadline(base.fetch as typeof fetch, deadline), lockWaitMs: Math.min(remaining(), base.lockWaitMs ?? remaining()) };
  const answers = await Promise.all(
    live.map(async (target): Promise<ReachableHost | string | null> => {
      const host = hostArgument(target);
      const ask = commandFragment`${cliInvocation()} catalog list --hosted --host ${commandToken(host)}`;
      try {
        const { client } = await connectHostedAccount(target, { resume: ask, signIn: false, deadlineMs: remaining() }, { auth, fetch: fetchWithDeadline(options.fetch ?? fetch, deadline) });
        const { rows, complete } = await hostedBundleRows(client, target, home);
        return {
          host: target.origin,
          complete,
          ask: String(ask),
          bundles: rows
            .filter((row) => row.folder === null)
            .map((row) => (row.ambiguous ? row : { ...row, checkout: `${cliInvocation()} checkout ${commandToken(row.bundle_id)} --host ${commandToken(host)}` })),
        };
      } catch (error) {
        // Signed out after all (a refresh the issuer refused), or an environment token that is for
        // another host: nothing to say, as when signed out.
        if (error instanceof SignedOutError || (error instanceof CliError && error.code === "USAGE")) return null;
        return `hosted bundles on ${target.origin} were not listed (${Date.now() >= deadline ? "no answer in time" : "the host could not be asked"}); list them with: ${ask}`;
      }
    }),
  );
  const hosts = answers.filter((answer): answer is ReachableHost => answer !== null && typeof answer !== "string");
  const notes = answers.filter((answer): answer is string => typeof answer === "string");
  if (hosts.length === 0 && notes.length === 0) return null;
  return { hosts, notes };
}
