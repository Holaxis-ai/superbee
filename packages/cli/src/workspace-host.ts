import { assertSupportedCliHost } from "./posix-host.js";
import { windowsFilesystemUnavailable } from "./windows/runtime-options.js";

export function assertWorkspaceProviderHost(): void {
  if (process.platform !== "win32") return assertSupportedCliHost();
  const unavailable = windowsFilesystemUnavailable();
  if (unavailable) throw new Error(unavailable);
}
