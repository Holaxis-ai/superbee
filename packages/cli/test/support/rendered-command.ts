/**
 * Expectations about emitted commands from the supported POSIX renderer.
 *
 * These helpers delegate to the shipped renderer rather than re-implementing it. That is deliberate:
 * a second copy of the quoting rules inside the tests is exactly what drifted here — one test grew
 * its own `commandArg` and silently stopped describing the shipped behaviour. What the rendering IS
 * stays pinned by `command-text.test.ts` and by the injection probes; what these helpers assert is
 * WHICH command was emitted, not how a token is spelled.
 */
import { commandQuoted, commandToken } from "../../src/command-text.js";

/** How the renderer spells `value` as one token here — bare when inert, quoted otherwise. */
export function rendered(value: string): string {
  return commandToken(value);
}

/** How the always-quote renderer spells `value` here (the form used in prose that shows a value). */
export function renderedQuoted(value: string): string {
  return commandQuoted(value);
}

/** Escape for embedding inside a `RegExp`, so a rendered token can be matched literally. */
export function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** {@link rendered}, escaped for a `RegExp`. */
export function renderedPattern(value: string): string {
  return escapeForRegExp(rendered(value));
}

/** {@link renderedQuoted}, escaped for a `RegExp`. */
export function renderedQuotedPattern(value: string): string {
  return escapeForRegExp(renderedQuoted(value));
}

/**
 * Split an emitted command line into argv the way a SHELL would, honouring the quoting the renderer
 * produced. Tests that "execute the emitted command" previously split on plain spaces, which fails
 * as soon as a value needs quoting. The result was a harness that failed while the emitted command
 * was correct. This parser handles the POSIX `'…'` convention, including `'\''` for an apostrophe.
 */
export function parseCommandLine(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote = false;

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i]!;
    if (quote) {
      if (character === "'") quote = false;
      else current += character;
      continue;
    }
    // Outside quotes a backslash escapes the next character. This is not decoration: POSIX
    // always-quote emits an embedded apostrophe as `'\''` — closing the quoted run, an ESCAPED
    // quote, then reopening — so a value as ordinary as `Owner's Guide` is mis-split without it.
    if (character === "\\" && i + 1 < line.length) {
      current += line[i + 1]!;
      i += 1;
      started = true;
      continue;
    }
    if (character === "'") { quote = true; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { argv.push(current); current = ""; started = false; }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

/**
 * Escape a rendered token for embedding inside a serialized double-quoted scalar (TOON or JSON).
 * Serialized fields may contain `"`, so a baseline that pins bytes has to escape it too.
 */
export function escapeForSerializedString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Decode a serialized scalar's PRESENTATION ENVELOPE.
 *
 * TOON and JSON may quote and escape a scalar. Decode that presentation envelope before comparing
 * the command value.
 */
export function decodeSerializedScalar(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') ? (JSON.parse(trimmed) as string) : trimmed;
}

/**
 * Read one scalar field out of TOON output and decode its envelope. Use this instead of a bare
 * regex whenever the field can hold a rendered command.
 */
export function extractSerializedField(output: string, field: string): string | undefined {
  // The field name is escaped: it is a NAME, not a pattern. Unescaped, `a.b` would match a line
  // called `axb` and hand the caller a confidently wrong value.
  const matched = new RegExp(`^[ \\t]*${escapeForRegExp(field)}: (.+)$`, "m").exec(output);
  return matched ? decodeSerializedScalar(matched[1]!) : undefined;
}
