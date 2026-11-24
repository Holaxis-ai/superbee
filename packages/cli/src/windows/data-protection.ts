import { createHash } from "node:crypto";
import type { RunResult, ToolRunner } from "../hosted-auth/secret-store.js";

// This kernel link names the installed Windows directory regardless of drive or user environment.
const POWERSHELL = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;

/** Keep secrets and the account binding out of argv, including when Windows logs process creation. */
export function runWindowsDataProtection(
  method: "Protect" | "Unprotect",
  account: string,
  data: string,
  run: ToolRunner,
  timeoutMs: number,
): Promise<RunResult> {
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [void][System.Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
    $entropy = [Convert]::FromBase64String([Console]::In.ReadLine())
    $data = [Convert]::FromBase64String([Console]::In.ReadLine())
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    $output = [System.Security.Cryptography.ProtectedData]::${method}($data, $entropy, $scope)
    [Console]::Out.Write([Convert]::ToBase64String($output))
  `;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const entropy = createHash("sha256").update(account).digest("base64");
  return run(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], `${entropy}\n${data}\n`, timeoutMs);
}
