// A file whose BASENAME collides with the quoting authority, at a nested path. It is not the
// authority and must be scanned like any other consumer. Keying the whole-file skip on a basename
// made this file invisible to the scan while everything still reported green.
import { cliInvocation } from "../../../../src/invocation.js";

export function notTheAuthority(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${bundleValue}`;
}
