import { promises as fs } from "node:fs";
import path from "node:path";
import { linkedWorktree, resolveStandaloneBoardCheckout } from "@superbee/board-git";
import { maybeAutoPull } from "./autopull.js";
import { openBundle } from "./bundle.js";
import type { CommandText } from "./command-text.js";
import { CliError } from "./errors.js";
import { configuredBundle } from "./filesystem-runtime.js";
import { cliInvocation } from "./invocation.js";
import { assertBundleOutsidePrivateState } from "./private-state-bundle-boundary.js";
import { currentBoardHost, currentExistingGitBoard, currentHost } from "./runtime-context.js";

export async function openReadBundle(
  dir: string | undefined,
  usage: CommandText,
  autoPull: (dir?: string) => Promise<unknown> = maybeAutoPull,
) {
  if (!currentExistingGitBoard()) {
    // Read freshness is opportunistic and detection-gated. Open after pulling so this read sees it.
    await autoPull(dir);
    return openBundle(dir);
  }

  if (dir?.trim()) {
    const requested = path.resolve(dir);
    assertBundleOutsidePrivateState(requested);
    const found = resolveStandaloneBoardCheckout(requested);
    if (found !== null) {
      const [root, checkout] = await Promise.all([fs.realpath(requested), fs.realpath(found)]);
      if (currentHost().sameResolvedPath(root, checkout) && !linkedWorktree(checkout, currentBoardHost())) {
        assertBundleOutsidePrivateState(checkout);
        return configuredBundle(checkout);
      }
    }
  }
  throw new CliError("USAGE", "--dir must point to the root of an existing standalone Git board checkout.", {
    help: `${cliInvocation()} ${usage}`,
  });
}
