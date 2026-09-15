import { snapshotHostPolicy } from "./host-policy-snapshot.js";
import { InvalidInputError } from "./errors.js";

/** Host observations used by the Node filesystem protocols; never a source of write authority. */
export interface FilesystemHostPolicy {
  readonly runtimeLockParent: () => string;
  readonly runtimeOwnerKey: () => string;
  readonly enforcePrivateMode: boolean;
  readonly isTransientOpenError: (error: unknown) => boolean;
  readonly isReplacementConflict: (error: unknown) => boolean;
  readonly isDirectoryContentionError: (error: unknown) => boolean;
}

export interface FilesystemBackendOptions {
  readonly hostPolicy?: FilesystemHostPolicy;
}

function defaultFilesystemHostPolicy(): FilesystemHostPolicy {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new InvalidInputError(
      "This host requires an explicit filesystem host policy; the default filesystem supports macOS and Linux.",
    );
  }
  return {
    runtimeLockParent: () => "/tmp",
    runtimeOwnerKey: () => `uid-${process.getuid!()}`,
    enforcePrivateMode: true,
    isTransientOpenError: () => false,
    isReplacementConflict: () => false,
    isDirectoryContentionError: () => false,
  };
}

/** Capture the structural policy; see snapshotHostPolicy for its public receiver contract. */
export function captureFilesystemHostPolicy(policy?: FilesystemHostPolicy): FilesystemHostPolicy {
  return snapshotHostPolicy(policy ?? defaultFilesystemHostPolicy());
}
