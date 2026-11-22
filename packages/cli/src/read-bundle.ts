import { maybeAutoPull } from "./autopull.js";
import { openBundle, resolveExistingGitBoardRoute } from "./bundle.js";
import type { CommandText } from "./command-text.js";
import { currentExistingGitBoard } from "./runtime-context.js";

export async function openReadBundle(
  dir: string | undefined,
  usage: CommandText,
  autoPull: (dir?: string) => Promise<unknown> = maybeAutoPull,
) {
  if (currentExistingGitBoard()) return (await resolveExistingGitBoardRoute(dir, usage)).bundle;

  // Read freshness is opportunistic and detection-gated. Open after pulling so this read sees it.
  await autoPull(dir);
  return openBundle(dir);
}
