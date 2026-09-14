// Output rendering for the `axi` CLI (agent-facing default: TOON).
//
// TOON by default; `--json` is a compact-JSON escape hatch for callers already parsing JSON. The
// JSON→TOON conversion happens ONLY here, at the output boundary — every command keeps its internal
// logic on plain JS objects and calls render() once. TOON preserves the object's own insertion
// order, so the rendered field order mirrors the object's key order: commands MUST construct their
// result objects in a stable field order for the rendered string to be stable.
//
// Two modes only: "default" (TOON) and "json" (compact JSON). Error envelopes render as TOON
// everywhere via renderErrorEnvelope() — a single locus shared by cli.ts (formatError,
// renderUnknownCommand, the leading-flag pre-route) and the byte-channel commands (doc read --out -).
// Errors are ALWAYS TOON regardless of --json, because formatError receives only the error and never
// sees per-invocation flags: an agent branches on the exit code first and the TOON error fields read
// identically to the JSON ones.
//
// Ported verbatim from holaxis-agentstate `packages/cli/src/output.ts`.
import { encode } from "@toon-format/toon";
import type { ErrorEnvelope } from "./errors.js";

export type OutputMode = "default" | "json";

/** The raw output flags a command parses (via node:util parseArgs). */
export interface OutputFlags {
  /** Compact-JSON escape hatch for callers already parsing JSON. Absent (the default) ⇒ TOON. */
  json?: boolean;
}

/**
 * Resolve the output mode from parsed flags: `--json` selects compact JSON, otherwise TOON (default).
 */
export function resolveMode(flags: OutputFlags): OutputMode {
  if (flags.json) return "json";
  return "default";
}

/** Render a value for stdout in the given mode (always newline-terminated). */
export function render(value: unknown, mode: OutputMode): string {
  switch (mode) {
    case "json":
      return `${JSON.stringify(value)}\n`;
    case "default":
      return `${encode(value)}\n`;
  }
}

/**
 * Render a structured error envelope as TOON (newline-terminated). Shared by cli.ts and the
 * byte-channel commands so every error surface emits the identical TOON shape at one locus,
 * independent of any --json flag.
 */
export function renderErrorEnvelope(envelope: ErrorEnvelope): string {
  return `${encode(envelope)}\n`;
}
