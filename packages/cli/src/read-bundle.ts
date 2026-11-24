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
  const scope = currentExistingGitBoard();
  if (allowLocal || scope?.hostedOnboarding) {
    // An already qualified board read works even when private user state is inaccessible.
    const board = dir && hasEnclosingGitMarker(dir) ? await existingGitBoardRoute(dir) : null;
    if (board) return board.bundle;
    const hosted = await scopedHostedCheckoutRoute(dir);
    if (hosted) return hosted.route.bundle;
    if (allowLocal) return (await resolveOnboardingRoute(dir, usage)).bundle;
  }
  if (scope) return (await resolveExistingGitBoardRoute(dir, usage)).bundle;

  // Read freshness is opportunistic and detection-gated. Open after pulling so this read sees it.
  await autoPull(dir);
  return openBundle(dir);
}
