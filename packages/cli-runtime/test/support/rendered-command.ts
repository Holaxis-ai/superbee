/**
 * Expectations about EMITTED COMMANDS, written for the platform the test is running on.
 *
 * The renderer deliberately produces different bytes per platform — POSIX single-quotes, Windows
 * double-quotes, and Windows withholds values it cannot make inert. A test that hard-codes
 * `'Context Note'` therefore passes on POSIX and fails on Windows while the CODE is correct, which
 * is how this suite took a green Windows lane to eighteen failures.
 *
 * These helpers delegate to the shipped renderer rather than re-implementing it. That is deliberate:
 * a second copy of the quoting rules inside the tests is exactly what drifted here — one test grew
 * its own `commandArg`, kept the pre-fix Windows semantics, and silently stopped describing the
 * shipped behaviour. What the rendering IS stays pinned by `command-text.test.ts` (which forces the
 * platform) and by the injection probes (which execute the result); what these helpers assert is
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
 * produced. Tests that "execute the emitted command" previously split on plain spaces, which works
 * only while every token happens to be unquoted — true on POSIX for inert values, false on Windows
 * the moment a path carries a backslash. The result was a harness that failed while the emitted
 * command was correct, which is the most expensive kind of red.
 *
 * Handles both conventions because the renderer emits both: POSIX `'…'` (literal, with `'\''` for an
 * embedded quote) and Windows `"…"` (with `""` for an embedded quote).
 */
export function parseCommandLine(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        // `""` inside a double-quoted run is one literal quote (cmd/CRT and PowerShell agree).
        if (line[i + 1] === '"') { current += '"'; i += 1; } else quote = undefined;
      } else current += character;
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
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
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
 * A Windows-rendered token contains `"`, which the serializer escapes — so a baseline that pins
 * serialized bytes has to escape it too, or it compares the wrong thing.
 */
export function escapeForSerializedString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Decode a serialized scalar's PRESENTATION ENVELOPE.
 *
 * TOON and JSON both quote-and-escape a scalar that contains a `"`. A Windows-rendered token
 * contains `"`; a POSIX-rendered one contains only `'`, which needs no escaping. So a test that
 * pulls a command out of serialized output with a regex and string-compares it reads the bare value
 * on POSIX and the ENVELOPE on Windows — and the failure looks like a quoting difference when it is
 * a serialization difference. That is one root cause behind two separate Windows failures.
 *
 * Decode first, then compare the command.
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
