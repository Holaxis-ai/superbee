// One-click re-entry for the `ui` command after a restart (tasks/ui-pages-spike B6). On boot the
// command records the CURRENT run's tokenized URL to `~/.superbee-state/ui-url` (0600, dir 0700, the
// same discipline credentials use). Combined with the stable per-bundle PORT, a human whose tab
// died on a restart re-opens the freshly-printed URL in one click instead of copy-pasting a
// rotating token from the terminal.
//
// The file DOES hold a live credential while the run lasts: the recorded URL embeds the run's
// session token (`?token=`), which is exactly why it rides the credentials-file discipline (0600,
// dir 0700) instead of a plain cache path. Each run mints a fresh secret, so the persistence
// window is the run itself: the file is overwritten on the next boot and removed on a clean
// shutdown (only if it still points at OUR url, so a newer instance's pointer is never
// clobbered). A stale file left by a crash points at a dead server whose token the next boot
// rotates away — it 403s or refuses the connection; it is never a REUSABLE credential.
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialsDir } from "../credentials.js";
import { readUserStateFile, writeUserStateFileAtomic0600 } from "../user-state.js";

export const UI_URL_FILE_NAME = "ui-url";

export function uiUrlFilePath(home: string = homedir()): string {
  return join(credentialsDir(home), UI_URL_FILE_NAME);
}

/** Record `url` for one-click re-entry (0600, dir 0700). Best-effort: a failure here never fails the command — the printed URL is always the fallback. */
export async function writeUiUrlFile(url: string, home: string = homedir()): Promise<void> {
  try {
    await writeUserStateFileAtomic0600(home, credentialsDir(home), UI_URL_FILE_NAME, url + "\n");
  } catch {
    // convenience only — never surface
  }
}

/** Remove the URL file on clean shutdown, but ONLY if it still points at `url` (don't clobber a newer instance's pointer). Best-effort. */
export async function clearUiUrlFile(url: string, home: string = homedir()): Promise<void> {
  try {
    const current = (await readUserStateFile(home, uiUrlFilePath(home), 16 * 1024)).trim();
    if (current === url.trim()) await unlink(uiUrlFilePath(home));
  } catch {
    // absent / unreadable / already gone — nothing to clear
  }
}
