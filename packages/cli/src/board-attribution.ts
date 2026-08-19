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
//   • keyed to the exact resolved bundle/clone — `resolveBundleKey` over the resolved bundle
//     root, THE one state-key derivation sync/session-start/home already share;
//   • best-effort — the returned hook swallows everything (and mutate.ts's `firePostPersist`
//     swallows again): it can NEVER turn a successful doc write into a failure;
//   • no network — `resolveBundleKey`'s `remote get-url` reads local config only;
//   • no git discovery on GENERIC mutations — the pre-gate below is a pure string check, so a
//     non-conventional bundle (arbitrary `--dir`, and every remote mutation) never spawns git;
//     callers without the git channel simply get `undefined` and pass no hook at all.
import path from "node:path";

import { BUNDLE_DIRS, resolveBundleKey } from "@superbee/board-git";
import type { Bundle } from "@superbee/core";

import { defaultSyncStore } from "./cursor.js";
import { boundBoardOwnerForBundle } from "./bound-board-owner.js";

/**
 * Build the post-persist hook for one mutation, or `undefined` when there is nothing to record:
 * no resolved actor (or core's `"unknown"` placeholder — recording it would make the render hide
 * a teammate's unattributed rows too), a remote bundle (a different backend entirely — not this
 * clone's git channel), or a bundle not at a recognized conventional name (the
 * zero-spawn pre-gate: the git channel only ever lives at the conventional folder, both as the
 * board worktree and as an in-tree committed bundle). A conventional bundle outside any git repo
 * degrades to a harmless path-keyed record — one local spawn, post-persist only.
 */
export function boardPostPersistHook(
  bundle: Bundle,
  actor: string | undefined,
): (() => Promise<void>) | undefined {
  if (!actor || actor === "unknown") return undefined;
  if (bundle.backend !== undefined) return undefined;
  const owner = boundBoardOwnerForBundle(bundle);
  if (!owner && !BUNDLE_DIRS.includes(path.basename(bundle.root) as (typeof BUNDLE_DIRS)[number])) return undefined;
  return async () => {
    try {
      // Bound runs were proven before the first persistence operation. Reusing the captured key
      // prevents a post-write cwd/public-repository probe from retaking authority.
      await defaultSyncStore.recordSelfActors(owner?.stateKey ?? resolveBundleKey(bundle.root), [actor]);
    } catch {
      /* best-effort by contract — attribution must never fail a successful write */
    }
  };
}
