// Pure render projections over the canonical grouped CLI command specification.
//
// Executable leaf identity, exact positional count, aliases, display attachment, and public command
// ordering live in command-spec.ts. This module owns only reference rendering.
import { CLI_COMMAND_GROUPS, type PublicLeafPath } from "./command-spec.js";
import type { CommandPrefix } from "./command-text.js";

export type { PublicLeafPath } from "./command-spec.js";

/** The one-sentence tagline. */
export const DESCRIPTION =
  "read and write a local OKF knowledge bundle (context notes, docs, cross-links, live bundle Views)";

/** A single command's usage line + a one-line summary of what it does. */
export interface CommandRef {
  usage: string;
  summary: string;
  /** Executable leaf paths projected from the canonical grouped specification. */
  paths: readonly PublicLeafPath[];
}

/** A named group of related commands (e.g. "Bundle", "Notes & Docs", "Session"). */
export interface CommandGroup {
  group: string;
  commands: readonly CommandRef[];
}

/** Compatibility projection consumed by help, home, and skill rendering. */
export const COMMAND_GROUPS: readonly CommandGroup[] = Object.freeze(
  CLI_COMMAND_GROUPS.map((group) => Object.freeze({
    group: group.group,
    commands: Object.freeze(group.commands.map((row) => Object.freeze({
      usage: row.usage,
      summary: row.summary,
      paths: Object.freeze(row.leaves.map((leaf) => leaf.path)),
    }))),
  })),
);

/**
 * Static pointer TEMPLATE (no bundle I/O) from the offline `--help`/`home` views toward the live
 * kind-convention registry. Kind conventions are declared PER-BUNDLE (a `Convention` doc under
 * `conventions/`), so enumerating them requires a live registry load — which `--help`/`home` may
 * never do (they are pure/offline by contract, see `home.ts`'s OFFLINE GUARANTEE). The Phase-0 CLI
 * grammar experiment (kind-conventions plan, Part B) found this pointer is the causal ingredient:
 * subjects with NO discoverable path from help toward the registry spiraled into ~49-command probes;
 * this one static line, paired with the live `kinds` command, closed that gap.
 *
 * Takes the RESOLVED invocation prefix as a plain string argument rather than resolving it itself
 * (that would mean importing `invocation.ts`'s filesystem/PATH resolution into this module, breaking
 * its "NO I/O, NO imports beyond TypeScript types" contract) — every call site already resolves one
 * (`cliInvocation()` in `cli.ts`, `deps.invocation()` in `home.ts`) for its OTHER emitted hints, so
 * this is purely a projection of a value the caller already has.
 */
export function kindsPointer(invocation: CommandPrefix): string {
  return `kinds are declared per-bundle — run \`${invocation} kinds\` to list them`;
}

/**
 * Static pointer describing explicit remote activation and local bundle resolution, shown in BOTH
 * `--help` and home without bundle I/O.
 */
export function remoteEnvPointer(): string {
  return (
    "bundle resolution: HTTP is activated only by explicit --remote <url>; otherwise an explicit " +
    "--dir wins, then a committed .superbee.json or supported .agentstate.json local-path binding at " +
    "or above the cwd, then local discovery walks up for an enclosing or conventional project bundle. " +
    "Both binding names at one level conflict. URL-valued bindings and the " +
    "retired AGENTSTATE_LITE_REMOTE ambient default fail with guidance to pass --remote explicitly"
  );
}

/** A renderable command reference: group name -> array of "usage — summary" lines. */
export interface CommandReference {
  commands: Record<string, string[]>;
  /** See {@link kindsPointer}. */
  kinds: string;
  /** See {@link remoteEnvPointer}. */
  remoteEnv: string;
}

/**
 * Project COMMAND_GROUPS into a renderable plain object — the shared shape both the home view and the
 * `--help` reference render, so they cannot diverge. Pure: derives entirely from COMMAND_GROUPS plus
 * the caller-supplied `invocation` prefix (see {@link kindsPointer}).
 */
export function commandReference(invocation: CommandPrefix): CommandReference {
  const commands: Record<string, string[]> = {};
  for (const { group, commands: refs } of COMMAND_GROUPS) {
    commands[group] = refs.map((c) => `${c.usage} — ${c.summary}`);
  }
  return { commands, kinds: kindsPointer(invocation), remoteEnv: remoteEnvPointer() };
}

/**
 * The leading command word(s) of a usage string, up to its first argument/flag/option token —
 * e.g. `"doc read <id> [--out …]"` -> `"doc read"`. Exported (beyond its original
 * {@link compactCommandReference} use) so distribution-resources.ts's skill projection registry and
 * its exhaustiveness gate (test/skill-distribution.test.ts) derive command NAMES from the exact
 * same projection `--help`/`home` already use — never a second, driftable name-extraction rule.
 */
export function commandName(usage: string): string {
  const stop = usage.search(/[<[("]|\s--|\s-\w/);
  return (stop === -1 ? usage : usage.slice(0, stop)).trim();
}

/**
 * A COMPACT command list for the home view — which IS the SessionStart hook payload, so it must stay
 * token-lean (AXI §7 "ruthlessly minimize"). Each group maps to its command NAMES only (no
 * usage/summary): discoverability of WHAT commands exist is preserved (every name is visible) while
 * the verbose per-command reference — which the full `--help` still carries — is dropped, cutting the
 * every-session payload substantially. A comprehensive UX audit flagged the full reference (~1.6k
 * tokens) rendering on every session as the single worst §7 violation.
 */
export function compactCommandReference(invocation: CommandPrefix): {
  commands: Record<string, string>;
  commands_help: string;
} {
  const commands: Record<string, string> = {};
  for (const { group, commands: refs } of COMMAND_GROUPS) {
    // Set-dedupe usage variants of one command: a name-only view gains nothing from repeating it.
    commands[group] = [...new Set(refs.map((c) => commandName(c.usage)))].join(", ");
  }
  return {
    commands,
    commands_help: `run \`${invocation} <command> --help\` (or \`${invocation} --help\`) for full usage`,
  };
}

/**
 * Word-wrap `text` to `width` columns, breaking only at existing spaces (never mid-word). Pure, no
 * I/O. Used solely to keep the footer pointers ({@link kindsPointer}, {@link remoteEnvPointer}) —
 * each authored as one long single-line string — readable as wrapped prose in `helpIndexText()`
 * instead of one unbroken line; command usage/summary lines are deliberately left un-wrapped (see
 * {@link helpIndexText}'s comment).
 */
export function wrapText(text: string, width = 96): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const wrapped: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length > width && line.length > 0) {
      wrapped.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) wrapped.push(line);
  return wrapped.join("\n");
}

/**
 * The `--help` / `-h` / `help` INDEX: `commandReference()`'s data rendered as grouped PLAIN TEXT —
 * a heading per group, one command per physical line (its usage synopsis and one-line summary
 * joined by " — ", exactly as `commandReference()` already composes them — only the OUTPUT FORMAT
 * changes here, from a TOON-encoded object to prose). Command lines are intentionally left
 * un-wrapped (some usage+summary pairs are long; splitting them across physical lines would break
 * the "one command per line" property this rewrite exists to deliver) — only the free-prose footer
 * pointers are wrapped, via {@link wrapText}. Pure: derives entirely from {@link commandReference}
 * plus the caller-supplied `invocation` prefix; no I/O.
 */
export function helpIndexText(invocation: CommandPrefix): string {
  const ref = commandReference(invocation);
  const lines: string[] = [
    `${invocation} — ${DESCRIPTION}`,
    "",
    `Usage: ${invocation} <command> [options]`,
    `Run \`${invocation} <command> --help\` for a specific command's full reference.`,
  ];
  for (const [group, commandLines] of Object.entries(ref.commands)) {
    lines.push("", `${group}:`);
    for (const commandLine of commandLines) {
      lines.push(`  ${commandLine}`);
    }
  }
  lines.push(
    "",
    "Agent setup:",
    "  After installation, the calling agent should run:",
    "",
    `    ${invocation} setup --host <host> --scope <scope> --json`,
    "",
    "  The calling agent executes the returned action, reports what it is doing, requests approval",
    "  when required, and repeats setup until ready. Do not ask the user to copy or run setup",
    "  commands unless execution is unavailable. Prefer the resolved project binary or",
    "  `npx --no-install superbee`; do not use a download-permitting npx invocation for setup guidance.",
  );
  lines.push("", wrapText(ref.kinds), "", wrapText(ref.remoteEnv));
  return `${lines.join("\n")}\n`;
}
