import {
  createFilesystemRuntime,
  FilesystemBackend,
  type FilesystemRuntime,
  type InitBundleOptions,
  type FilesystemMutationLockOptions,
  type Bundle,
} from "@superbee/core";
import { currentFilesystemHost } from "./runtime-context.js";
const runtimes = new WeakMap<object, FilesystemRuntime>();
let defaultRuntime: FilesystemRuntime | undefined;
export function cliFilesystemRuntime(): FilesystemRuntime {
  const host = currentFilesystemHost();
  if (!host) return (defaultRuntime ??= createFilesystemRuntime());
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = createFilesystemRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}
export function configuredBundle(root: string): Bundle {
  return { root, backend: cliFilesystemRuntime().backend(root) };
}
export function configuredInitBundle(
  root: string,
  options?: InitBundleOptions,
): Promise<Bundle> {
  return cliFilesystemRuntime().initBundle(root, options);
}
export function withCliFilesystemMutationLock<T>(
  target: string,
  body: () => Promise<T>,
  options?: FilesystemMutationLockOptions,
): Promise<T> {
  return cliFilesystemRuntime().withMutationLock(target, body, options);
}

/** Local byte access and egress checks apply to implicit and explicitly configured filesystems. */
export function isFilesystemBundle(bundle: Bundle): boolean {
  return !bundle.backend || bundle.backend instanceof FilesystemBackend;
}
