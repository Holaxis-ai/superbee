// Same collision, for the cast exemption rather than the whole-file skip: a basename-keyed check
// granted this file the authority's right to mint branded command text out of a raw string.
import type { CommandText } from "../../../../src/command-text.js";
import { cliInvocation } from "../../../../src/invocation.js";

export function alsoNotTheAuthority(bundleValue: string): string {
  return `${cliInvocation()} doc write x --type ${bundleValue as unknown as CommandText}`;
}
