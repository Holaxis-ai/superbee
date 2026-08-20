// `board-attribution.ts` — the POST-PERSIST self-actor hook's CLI wiring (board-git PR C).
//
// THE GAP THIS CLOSES: "self" is defined operationally — the actors THIS CLONE committed to the
// board (cursor.ts `selfActors`) — and until PR C it was recorded ONLY by sync's commit step and
// establish. An IN-TREE board never runs either (docs ride the user's normal git flow), so a
// clone's own doc writes would come back around the awareness loop as teammate activity. Branch
// mode had a thinner version of the same gap (a doc write that a LATER actor's sync commits).
// The fix records the resolved CLI actor at the moment a doc mutation substantively persists.
//
// INVARIANTS (plan v3, binding — enforced across mutate.ts + this module):
//   • fires only after a SUBSTANTIVE persisted mutation — mutate.ts invokes `onPersisted` only on
//     a successful write, never a `changed: false` no-op and never a failed/refused write;
//   • keyed to the exact pre-persist route decision — the caller computes a state key before the
//     mutation, so this post-persist path can never rediscover from a bundle or cwd;
//   • best-effort — the returned hook swallows everything (and mutate.ts's `firePostPersist`
//     swallows again): it can NEVER turn a successful doc write into a failure;
//   • no network or Git discovery — state-key selection completed before persistence;
//   • generic mutations with no eligible precomputed decision get `undefined` and never spawn.
import { defaultSyncStore } from "./cursor.js";
import type { BoardAttribution } from "./bundle.js";

/**
 * Build the post-persist hook for one mutation, or `undefined` when there is nothing to record:
 * no resolved actor (or core's `"unknown"` placeholder — recording it would make the render hide
 * a teammate's unattributed rows too), or a route whose pre-persist decision is `none`.
 */
export function boardPostPersistHook(
  attribution: BoardAttribution,
  actor: string | undefined,
): (() => Promise<void>) | undefined {
  if (!actor || actor === "unknown" || attribution.kind !== "board") return undefined;
  return async () => {
    try {
      await defaultSyncStore.recordSelfActors(attribution.stateKey, [actor]);
    } catch {
      /* best-effort by contract — attribution must never fail a successful write */
    }
  };
}
