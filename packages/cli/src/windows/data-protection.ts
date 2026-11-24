import { createHash } from "node:crypto";
import { win32 } from "node:path";
import type { RunResult, ToolRunner } from "../hosted-auth/secret-store.js";

/** Keep secrets and the account binding out of argv, including when Windows logs process creation. */
export function runWindowsDataProtection(
  method: "Protect" | "Unprotect",
  account: string,
  data: string,
  env: NodeJS.ProcessEnv,
  run: ToolRunner,
  timeoutMs: number,
): Promise<RunResult> | null {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "";
  if (!/^[A-Za-z]:\\/u.test(systemRoot)) return null;
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -AssemblyName System.Security
    $entropy = [Convert]::FromBase64String([Console]::In.ReadLine())
    $data = [Convert]::FromBase64String([Console]::In.ReadLine())
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    $output = [System.Security.Cryptography.ProtectedData]::${method}($data, $entropy, $scope)
    [Console]::Out.Write([Convert]::ToBase64String($output))
  `;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const entropy = createHash("sha256").update(account).digest("base64");
  return run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], `${entropy}\n${data}\n`, timeoutMs);
}
