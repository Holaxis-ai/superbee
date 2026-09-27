/**
 * Text that came from a host (a bundle's name, a person's name, a label) made safe to show a person
 * or an agent: control and format characters removed (escape sequences, bidi overrides such as
 * U+202E, zero-width characters), surrounding space trimmed, and at most `max` UTF-16 units kept,
 * cut only between whole characters (never half a surrogate pair). The one rule every surface that
 * shows host text uses.
 */
export function stripHostText(value: string, max: number): string {
  let out = "";
  for (const char of value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out.trim();
}
