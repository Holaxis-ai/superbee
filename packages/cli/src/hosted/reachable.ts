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

import { commandFragment, commandToken } from "../command-text.js";
import { cliInvocation } from "../invocation.js";
import { resolveHostedTarget, type HostedTarget } from "../hosted-auth/discovery.js";
import { defaultHostedAuthDeps, hostArgument, readDefaultHost, SignedOutError, storedSessionMayNeedSignIn, type HostedAuthDeps } from "../hosted-auth/session.js";
import { connectHostedAccount } from "./account.js";
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

/** Every bundle the host lists for this person, with the folder of a live checkout of each here. */
export async function hostedBundleRows(client: HostedSyncClient, target: HostedTarget, home: string): Promise<{ rows: HostedBundleRow[]; complete: boolean }> {
  const listing = readBundleListing(await client.bundles());
  const folders = await liveCheckoutFolders(home, target);
  const rows = [...listing.bundles.values()]
    .sort((a, b) => (a.row.bundleId < b.row.bundleId ? -1 : a.row.bundleId > b.row.bundleId ? 1 : 0))
    .map(({ row, workspaces }) => ({
      bundle_id: row.bundleId,
      name: row.name,
      lifecycle: row.lifecycle,
      folder: folders.get(row.bundleId)?.[0] ?? null,
      ambiguous: workspaces > 1,
    }));
  return { rows, complete: listing.complete };
}

/** The hosted bundles one host lists that have no folder here, and the command that brings one into a folder. */
export interface ReachableHost {
  readonly host: string;
  readonly complete: boolean;
  readonly bundles: readonly (HostedBundleRow & { readonly checkout: string })[];
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
  const remembered = await readDefaultHost(home).catch(() => null);
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
      const target = resolveHostedTarget(binding.audience);
      if (target.origin === binding.origin) out.set(`${target.origin} ${target.audience}`, target);
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
  const home = options.auth?.home ?? options.home ?? homedir();
  const base = options.auth ?? defaultHostedAuthDeps(home);
  const live: HostedTarget[] = [];
  for (const target of await candidateHosts(home)) {
    if (!(await storedSessionMayNeedSignIn(home, target, base.env, base.now()).catch(() => true))) live.push(target);
  }
  if (live.length === 0) return null;
  const deadline = Date.now() + options.budgetMs;
  const auth: HostedAuthDeps = { ...base, fetch: fetchWithDeadline(base.fetch as typeof fetch, deadline), lockWaitMs: Math.min(options.budgetMs, base.lockWaitMs ?? options.budgetMs) };
  const answers = await Promise.all(
    live.map(async (target): Promise<ReachableHost | string | null> => {
      const host = hostArgument(target);
      const ask = commandFragment`${cliInvocation()} catalog list --hosted --host ${commandToken(host)}`;
      try {
        const { client } = await connectHostedAccount(target, { resume: ask, signIn: false, deadlineMs: Math.max(1, deadline - Date.now()) }, { auth, fetch: fetchWithDeadline(options.fetch ?? fetch, deadline) });
        const { rows, complete } = await hostedBundleRows(client, target, home);
        return {
          host: target.origin,
          complete,
          bundles: rows.filter((row) => row.folder === null).map((row) => ({ ...row, checkout: `${cliInvocation()} checkout ${commandToken(row.bundle_id)} --host ${commandToken(host)}` })),
        };
      } catch (error) {
        // Signed out after all (a refresh the issuer refused): nothing to say, as when signed out.
        if (error instanceof SignedOutError) return null;
        return `hosted bundles on ${target.origin} were not listed (${Date.now() >= deadline ? "no answer in time" : "the host could not be asked"}); list them with: ${ask}`;
      }
    }),
  );
  const hosts = answers.filter((answer): answer is ReachableHost => answer !== null && typeof answer !== "string");
  const notes = answers.filter((answer): answer is string => typeof answer === "string");
  if (hosts.length === 0 && notes.length === 0) return null;
  return { hosts, notes };
}
