// `autopull.ts` — the opportunistic-freshness trigger's CLI WIRING (board-git A1).
//
// The mechanic (staleness window, fs-only pre-gate, attempt throttle, the shared
// pull-and-record step) lives in `@superbee/board-git`; this module binds its two
// injected seams to the CLI's own facts — `defaultSyncStore` (the `~/.superbee-state/sync`
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

import { defaultSyncStore } from "./cursor.js";
import { findBundleRoot, resolveLocalBundleRoute, type ResolvedLocalRoute } from "./bundle.js";

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

/** See the package's `maybeAutoPull` — this binds the CLI's store + bundle discovery. */
export async function maybeAutoPull(
  dir?: string,
  opts: AutoPullOptions & { route?: ResolvedLocalRoute } = {},
) {
  const route = opts.route;
  if (route?.kind === "bound-board") {
    if (route.readiness !== "ready") return "no-board";
    return maybeAutoPullWith(
      { store: defaultSyncStore, resolveBundleRoot: async () => route.owner.bundleRoot },
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
          { store: defaultSyncStore, resolveBundleRoot: async () => resolved.owner.bundleRoot },
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
  return maybeAutoPullWith({ store: defaultSyncStore, resolveBundleRoot: findBundleRoot }, dir, opts);
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
