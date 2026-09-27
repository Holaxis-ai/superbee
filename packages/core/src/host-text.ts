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

/**
 * Host data (a result's keys and strings) with control and format characters and the line and
 * paragraph separators (U+2028, U+2029) removed, except tab, newline and carriage return, with no
 * length cap: the rule of {@link stripHostText} for text that is shown whole.
 */
export function stripHostControls(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) => (char === "\t" || char === "\n" || char === "\r" ? char : ""));
}

/**
 * A copy of parsed JSON data with every key and string through {@link stripHostControls}, and
 * whether anything was removed (a key that collides with an earlier one once stripped is dropped,
 * and counts as removed). Iterative, so a deeply nested answer cannot exhaust the stack.
 */
export function stripHostData(input: unknown): { value: unknown; removed: boolean } {
  let removed = false;
  const clean = (text: string): string => {
    const stripped = stripHostControls(text);
    if (stripped !== text) removed = true;
    return stripped;
  };
  const stack: [object, Record<string, unknown> | unknown[]][] = [];
  const place = (item: unknown): unknown => {
    if (typeof item === "string") return clean(item);
    if (typeof item !== "object" || item === null) return item;
    const copy: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : {};
    stack.push([item, copy]);
    return copy;
  };
  const value = place(input);
  while (stack.length > 0) {
    const [source, copy] = stack.pop()!;
    if (Array.isArray(source)) {
      for (const item of source) (copy as unknown[]).push(place(item));
      continue;
    }
    for (const [rawKey, item] of Object.entries(source)) {
      const key = clean(rawKey);
      if (Object.prototype.hasOwnProperty.call(copy, key)) {
        removed = true;
        continue;
      }
      // defineProperty: a `__proto__` key stays an own key, as JSON.parse made it.
      Object.defineProperty(copy, key, { value: place(item), enumerable: true, writable: true, configurable: true });
    }
  }
  return { value, removed };
}

/**
 * JSON text with every C1 control, U+2028, U+2029 and format character (bidi controls, zero-width
 * characters, tag characters) escaped as `\uXXXX`, one escape per UTF-16 unit. `JSON.stringify`
 * already escapes the C0 controls; these can occur only inside strings, so the text stays valid
 * JSON and parses back to the same data.
 */
export function escapeHostJson(json: string): string {
  return json.replace(/[\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, (char) =>
    Array.from({ length: char.length }, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, "0")}`).join(""),
  );
}
