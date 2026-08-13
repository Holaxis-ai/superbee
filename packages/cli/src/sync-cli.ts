// `sync-cli.ts` — the sync family's shared CLI-side deps (board-git A1).
//
// Both sync command modules (`commands/sync.ts`, `commands/sync-establish.ts`) consume these;
// hosting them here keeps command modules from importing each other for shared CLI facts (the
// A0 discipline). Deliberately CLI-side: `SyncCliDeps` is an output-channel seam and
// `hookInstallHintOnce` composes the hook probe with invocation-aware hint copy — neither is
// git/channel orchestration, so neither belongs in `@superbee/board-git`.
import { defaultSyncStore } from "./cursor.js";
import { hookInstalled } from "./commands/hook.js";

export interface SyncCliDeps {
  stdout: (s: string) => void;
  /** show-incoming's receipt/envelope channel when stdout is reserved for raw bytes (--out -). */
  stderr: (s: string) => void;
  /** Raw byte writes for `--show-incoming --out -` (stdout stays a pure byte stream). */
  writeStdoutBytes: (data: Uint8Array) => void;
  /** The installed-hook probe behind the one-time onboarding hint (default hook.ts's {@link hookInstalled}). */
  hookInstalled: () => boolean;
}

/**
 * The onboarding last-mile hint (tasks/sync-opportunistic-pull): when NO managed SessionStart hook
 * is installed anywhere (project or global scope), a successful sync's receipt hints `hook install`
 * ONCE per clone. Once-ness mechanism: recorded on the per-clone sync state (cursor.ts's
 * `hookHintedAt` — the same keyed store the cursor/cache ride), so the hint is honest (it names the
 * ONE manual step left in the onboarding chain) and never nagging (a clone sees it exactly once;
 * an already-installed hook suppresses it before it is ever shown, and installing later simply
 * makes the probe true). Chosen surface: sync's SUCCESS receipts — sync is the setup verb (first
 * contact provisions through it), and the receipt is read at exactly the moment onboarding
 * completes; home renders every session and would nag. Best-effort throughout: any probe/state
 * failure suppresses the hint, never the receipt.
 */
export async function hookInstallHintOnce(
  key: string,
  inv: string,
  installed: () => boolean = hookInstalled,
): Promise<string | undefined> {
  try {
    if (installed()) return undefined;
    if ((await defaultSyncStore.readHookHintedAt(key)) !== null) return undefined;
    await defaultSyncStore.recordHookHinted(key);
    return (
      `no SessionStart hook is installed — run \`${inv} hook install\` once and every new agent ` +
      `session will start with the board pulled and rendered`
    );
  } catch {
    return undefined;
  }
}
