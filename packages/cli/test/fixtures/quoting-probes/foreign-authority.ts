// A SECOND module in the same package exporting names the authority also exports. Nothing here is
// the real renderer. The scanner must decide by the DECLARING FILE, not by the name — otherwise
// this module inherits the authority's whole-argument exemption and hides an unrendered value.
import type { CommandText } from "../../../src/command-text.js";

/** Same name as the real renderer, laundered so this file itself trips no rule. */
export function commandToken(value: string): CommandText {
  return value as unknown as CommandText;
}

/** An unrelated helper that merely SHARES a name with the authority's literal-only producer. */
export function commandLiteral(value: string): string {
  return value.trim();
}
