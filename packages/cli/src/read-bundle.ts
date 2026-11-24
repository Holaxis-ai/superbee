import { maybeAutoPull } from "./autopull.js";
import { hasEnclosingGitMarker } from "@superbee/board-git";
import { existingGitBoardRoute, openBundle, resolveExistingGitBoardRoute } from "./bundle.js";
import type { CommandText } from "./command-text.js";
import { currentExistingGitBoard } from "./runtime-context.js";
import { resolveOnboardingRoute, scopedHostedCheckoutRoute } from "./local-onboarding.js";

export async function openReadBundle(
  dir: string | undefined,
  usage: CommandText,
  autoPull: (dir?: string) => Promise<unknown> = maybeAutoPull,
  allowLocal = false,
) {
  if (allowLocal) {
    // An already qualified board read works even when private user state is inaccessible.
    const board = dir && hasEnclosingGitMarker(dir) ? await existingGitBoardRoute(dir) : null;
    return (board ?? await scopedHostedCheckoutRoute(dir) ?? await resolveOnboardingRoute(dir, usage)).bundle;
  }
  if (currentExistingGitBoard()) return (await resolveExistingGitBoardRoute(dir, usage)).bundle;

  // Read freshness is opportunistic and detection-gated. Open after pulling so this read sees it.
  await autoPull(dir);
  return openBundle(dir);
}
