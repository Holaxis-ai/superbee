/** Explicit Node filesystem construction, independent of executable or CLI startup. */
import { FilesystemBackend } from "./backend.js";
import { initBundle } from "./bundle.js";
import { captureFilesystemHostPolicy, type FilesystemHostPolicy } from "./filesystem-host.js";
import {
  filesystemMutationLockPath,
  withFilesystemMutationLock,
  type FilesystemMutationLockOptions,
} from "./filesystem-lock.js";
import type { Bundle, InitBundleOptions } from "./types.js";

export { FilesystemBackend } from "./backend.js";
export type { FilesystemBackendOptions, FilesystemHostPolicy } from "./filesystem-host.js";

export interface FilesystemRuntime {
  backend(root: string): FilesystemBackend;
  initBundle(root: string, options?: InitBundleOptions): Promise<Bundle>;
  withMutationLock<T>(target: string, body: () => Promise<T>, options?: Omit<FilesystemMutationLockOptions, "hostPolicy">): Promise<T>;
  mutationLockPath(target: string, portableRoot?: string): string;
}

/** Each runtime retains its selected host; it never changes another consumer's defaults. */
export function createFilesystemRuntime(policy?: FilesystemHostPolicy): FilesystemRuntime {
  const hostPolicy = captureFilesystemHostPolicy(policy);
  return Object.freeze({
    backend: (root: string) => new FilesystemBackend(root, { hostPolicy }),
    initBundle: (root: string, options?: InitBundleOptions) => initBundle(root, options, { hostPolicy }),
    withMutationLock: <T>(target: string, body: () => Promise<T>, options?: Omit<FilesystemMutationLockOptions, "hostPolicy">) =>
      withFilesystemMutationLock(target, body, { ...options, hostPolicy }),
    mutationLockPath: (target: string, portableRoot?: string) => filesystemMutationLockPath(target, portableRoot, hostPolicy),
  });
}
