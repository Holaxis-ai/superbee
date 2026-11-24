import { transformWindowsAuthData } from "./secret-store.js";

const WINDOWS_RECORD_PREFIX = "dpapi-v1:";

/** Bind each OAuth record to its use and session directory as well as the current Windows user. */
export async function protectWindowsAuthRecord(key: string, text: string): Promise<string> {
  const protectedBytes = await transformWindowsAuthData("Protect", `record:${key}`, Buffer.from(text, "utf8"));
  return `${WINDOWS_RECORD_PREFIX}${protectedBytes.toString("base64")}\n`;
}

export async function unprotectWindowsAuthRecord(key: string, text: string): Promise<string | null> {
  // Windows releases before native sign-in did not mint records. An imported plaintext record
  // has no owner or integrity proof here. A fresh sign-in will replace it.
  if (!text.startsWith(WINDOWS_RECORD_PREFIX)) return null;
  const protectedBytes = Buffer.from(text.slice(WINDOWS_RECORD_PREFIX.length), "base64");
  return (await transformWindowsAuthData("Unprotect", `record:${key}`, protectedBytes)).toString("utf8");
}
