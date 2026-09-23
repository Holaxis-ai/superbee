import { currentBoardHost } from "./runtime-context.js";
// `autopull.ts` — the opportunistic-freshness trigger's CLI WIRING (board-git A1).
//
// The mechanic (staleness window, fs-only pre-gate, attempt throttle, the shared
// pull-and-record step) lives in `@superbee/board-git`; this module binds its two
// injected seams to the CLI's own facts — `defaultSyncStore` (the platform-native private sync
// credentials discipline) and `findBundleRoot` (the conventional-folder discovery walk) — and
// re-exports the trigger under its historical signatures so every call site (list, doc read,
// status, home, link show, session-start) stays unchanged.
import {
  maybeAutoPull as maybeAutoPullWith,
  pullBoardAndRecord as pullBoardAndRecordWith,
  type AutoPullOptions,
  type BoardPullRecordResult,
  type NetworkBudgetOptions,
} from "@superbee/board-git";

import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { defaultSyncStore } from "./cursor.js";
import { findBundleRoot, resolveLocalBundleRoute, type ResolvedLocalRoute } from "./bundle.js";
import { cliInvocation } from "./invocation.js";
import { commandToken } from "./command-text.js";
import { bindingForPath, type CheckoutBinding } from "./hosted/binding.js";
import {
  ageMs,
  describeAge,
  fetchWithDeadline,
  HOSTED_AUTOPULL_BUDGET_MS,
  HOSTED_AUTOPULL_STALE_MS,
  HOSTED_STALE_WARNING_MS,
  readFreshness,
  recordPullAttempt,
} from "./hosted/freshness.js";
import type { HostedPullResult, HostedSyncDeps } from "./hosted/sync.js";
import { defaultHostedAuthDeps } from "./hosted-auth/session.js";
import { NO_AUTOPULL_ENV as LEGACY_NO_AUTOPULL, SUPERBEE_NO_AUTOPULL_ENV as NO_AUTOPULL } from "@superbee/board-git";

export {
  AUTO_PULL_BUDGET_MS,
  AUTO_PULL_CONNECT_TIMEOUT_SECONDS,
  AUTO_PULL_STALE_MS,
  NO_AUTOPULL_ENV,
  SUPERBEE_NO_AUTOPULL_ENV,
  findBoardCandidate,
  type AutoPullOptions,
  type AutoPullOutcome,
  type BoardPullRecordResult,
} from "@superbee/board-git";

/**
 * The hosted checkout a read targets: the folder (`--dir`, else the cwd) or its nearest ancestor
 * that is a live checkout. Filesystem reads only, no process spawns; null for everything else.
 */
export async function hostedCheckoutAt(dir: string | undefined, home: string = homedir()): Promise<CheckoutBinding | null> {
  let current: string;
  try {
    current = await realpath(path.resolve(dir ?? process.cwd()));
  } catch {
    return null;
  }
  for (;;) {
    const binding = await bindingForPath(home, current).catch(() => null);
    if (binding) return binding;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** What the automatic pull did in a hosted checkout. Diagnostic only, like {@link AutoPullOutcome}. */
export type HostedAutoPullOutcome = "disabled" | "fresh" | "throttled" | "pulled" | "signed-out" | "skipped";

export interface HostedAutoPullOptions {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  staleMs?: number;
  budgetMs?: number;
  /** Where the staleness warning goes (default: stderr, so a read's stdout stays its own record). */
  stderr?: (text: string) => void;
  /** The pull-only pass (default {@link hostedPull}). */
  pull?: (binding: CheckoutBinding, deps: Partial<HostedSyncDeps>) => Promise<HostedPullResult>;
  /** Sync seams for the default pull (tests pass the fake host's fetch and auth). */
  sync?: Partial<HostedSyncDeps>;
}

/**
 * The hosted checkout's automatic pull: a read pulls first once the last pull is over five
 * minutes old, within a two-second budget, and never more than once per five minutes whether or
 * not the attempt completed. It never starts a sign-in, never sends, and never fails the read.
 * Afterwards, if the last completed pull is over thirty minutes old (or there was none), one line
 * on stderr says so and names the sync command.
 */
export async function maybeHostedAutoPull(binding: CheckoutBinding, opts: HostedAutoPullOptions = {}): Promise<HostedAutoPullOutcome> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const home = opts.sync?.auth?.home ?? homedir();
  let outcome: HostedAutoPullOutcome = "skipped";
  try {
    const freshness = await readFreshness(home, binding.checkout_id);
    const staleMs = opts.staleMs ?? HOSTED_AUTOPULL_STALE_MS;
    const pulledAge = ageMs(freshness.pulled_at, now());
    const attemptAge = ageMs(freshness.attempt_at, now());
    if (env[NO_AUTOPULL] || env[LEGACY_NO_AUTOPULL]) outcome = "disabled";
    else if (pulledAge !== null && pulledAge <= staleMs) outcome = "fresh";
    else if (attemptAge !== null && attemptAge <= staleMs) outcome = "throttled";
    else {
      await recordPullAttempt(home, binding.checkout_id, now());
      const deadline = Date.now() + (opts.budgetMs ?? HOSTED_AUTOPULL_BUDGET_MS);
      const auth = opts.sync?.auth ?? defaultHostedAuthDeps(home);
      const deps: Partial<HostedSyncDeps> = {
        ...opts.sync,
        auth: { ...auth, fetch: fetchWithDeadline(auth.fetch as typeof fetch, deadline) },
        fetch: fetchWithDeadline(opts.sync?.fetch ?? fetch, deadline),
        lockWaitMs: 0,
        stdout: () => {},
      };
      // Loaded only here, so a read outside a hosted checkout never loads the sync engine.
      const pullOnce = opts.pull ?? (await import("./hosted/sync.js")).hostedPull;
      const result = await pullOnce(binding, deps);
      outcome = result.state === "pulled" ? "pulled" : "signed-out";
    }
  } catch {
    // Offline, busy, refused, or anything unexpected: the read goes on with the folder as it is.
    outcome = "skipped";
  }
  try {
    const age = ageMs((await readFreshness(home, binding.checkout_id)).pulled_at, now());
    if (age === null || age > HOSTED_STALE_WARNING_MS) {
      const since = age === null ? "has not been pulled since checkout" : `was last pulled ${describeAge(age)} ago`;
      (opts.stderr ?? ((text: string) => void process.stderr.write(text)))(
        `superbee: warning: hosted checkout ${binding.path} ${since}; it may be out of date. Run: ${cliInvocation()} sync --dir ${commandToken(binding.path)}\n`,
      );
    }
  } catch {
    // The warning is advisory.
  }
  return outcome;
}

/** See the package's `maybeAutoPull` — this binds the CLI's store + bundle discovery. */
export async function maybeAutoPull(
  dir?: string,
  opts: AutoPullOptions & { route?: ResolvedLocalRoute; hosted?: HostedAutoPullOptions } = {},
) {
  // A hosted checkout is never a Git board: its reads pull from the host instead.
  if (opts.route === undefined || opts.route.kind === "unbound") {
    try {
      const binding = await hostedCheckoutAt(dir, opts.hosted?.sync?.auth?.home);
      if (binding) return maybeHostedAutoPull(binding, { ...(opts.env ? { env: opts.env } : {}), ...(opts.now ? { now: opts.now } : {}), ...opts.hosted });
    } catch {
      return "error";
    }
  }
  const route = opts.route;
  if (route?.kind === "bound-board") {
    if (route.readiness !== "ready") return "no-board";
    return maybeAutoPullWith(
      { hostPolicy: currentBoardHost(), store: defaultSyncStore, resolveBundleRoot: async () => route.owner.bundleRoot },
      route.owner.bundleRoot,
      opts,
    );
  }
  if (route?.kind === "bound-local") {
    return "no-board";
  }
  // A bare binding is resolved once before board-git's candidate walk can inspect a cwd-derived
  // checkout.  A plain binding remains an ordinary selected bundle; only a proven owner receives
  // private-board routing. Resolution failure preserves autopull's fail-soft contract.
  if (dir === undefined) {
    try {
      const resolved = await resolveLocalBundleRoute(undefined);
      if (resolved.kind === "bound-board") {
        if (resolved.readiness !== "ready") return "no-board";
        return maybeAutoPullWith(
          { hostPolicy: currentBoardHost(), store: defaultSyncStore, resolveBundleRoot: async () => resolved.owner.bundleRoot },
          resolved.owner.bundleRoot,
          opts,
        );
      }
      if (resolved.kind === "bound-local") {
        return "no-board";
      }
    } catch {
      // Preserve autopull's fail-soft contract; the command boundary renders any binding error.
      return "error";
    }
  }
  return maybeAutoPullWith({ hostPolicy: currentBoardHost(), store: defaultSyncStore, resolveBundleRoot: findBundleRoot }, dir, opts);
}

/** See the package's `pullBoardAndRecord` — this binds the CLI's `defaultSyncStore`. */
export async function pullBoardAndRecord(
  boardPath: string,
  key: string,
  budget: NetworkBudgetOptions = {},
  now: () => Date = () => new Date(),
): Promise<BoardPullRecordResult> {
  return pullBoardAndRecordWith(defaultSyncStore, boardPath, key, budget, now);
}
