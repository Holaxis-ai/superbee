import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { win32 as paths } from 'node:path';
import type { FilesystemHostPolicy } from '@superbee/core/filesystem';

function code(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

/** Windows host observations; core owns locks, retry bounds, witnesses and CAS. */
export function createWindowsFilesystemHostPolicy(
  input: { home?: () => string; username?: () => string } = {},
): FilesystemHostPolicy {
  const home = input.home ?? homedir;
  const username = input.username ?? (() => userInfo().username);
  return Object.freeze({
    // Environment TEMP/LOCALAPPDATA overrides must not split the historical same-user namespace.
    runtimeLockParent: () => paths.join(home(), 'AppData', 'Local'),
    runtimeOwnerKey: () => {
      let name = 'unknown';
      try { name = username(); } catch { /* Stable fallback matches the original lock namespace. */ }
      return `user-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
    },
    enforcePrivateMode: false,
    isTransientOpenError: (error: unknown) => code(error) === 'EPERM',
    isReplacementConflict: (error: unknown) => ['EACCES', 'EBUSY', 'EPERM'].includes(code(error) as string),
    // ENOTEMPTY: Node 20's libuv unlink only marks a file delete-on-close, so a lock directory
    // whose owner record another claimer is polling stays non-empty until that handle closes.
    isDirectoryContentionError: (error: unknown) => ['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code(error) as string),
  });
}

export const windowsFilesystemHostPolicy = createWindowsFilesystemHostPolicy();
