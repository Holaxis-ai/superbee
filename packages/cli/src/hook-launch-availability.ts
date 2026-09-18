import { accessSync, constants, statSync } from "node:fs";
import { currentHost } from "./runtime-context.js";
import { classifyHookCommand, isOwnedHookCompatibility, tokenizeGeneratedHookCommand } from "./hook-compatibility.js";

export interface HookLaunchAvailability {
  /** File availability only: this does not prove host discovery, trust, or successful execution. */
  state: "available" | "unavailable" | "not_checked";
  reason: string;
  path?: string;
}

/** Inspect recognized generated paths without executing or sourcing stored configuration. */
export function inspectHookLaunchAvailability(command: string | undefined): HookLaunchAvailability {
  if (!command || !isOwnedHookCompatibility(classifyHookCommand(command))) {
    return { state: "not_checked", reason: "no recognized generated launch to inspect" };
  }
  const tokens = tokenizeGeneratedHookCommand(command);
  if (!tokens || !currentHost().paths.isAbsolute(tokens[0]!)) {
    return { state: "not_checked", reason: "launch depends on the host's PATH" };
  }
  const targets = tokens.length === 3
    ? [{ path: tokens[0]!, label: "Node launcher", mode: constants.X_OK },
      { path: tokens[1]!, label: "CLI entry", mode: constants.R_OK }]
    : [{ path: tokens[0]!, label: "CLI launcher", mode: constants.X_OK }];
  for (const target of targets) {
    try {
      if (!statSync(target.path).isFile()) throw new Error("not a regular file");
      accessSync(target.path, target.mode);
    } catch {
      return {
        state: "unavailable",
        reason: `${target.label} is missing or inaccessible`,
        path: target.path,
      };
    }
  }
  return { state: "available", reason: "generated launch files are accessible; host execution is not verified" };
}
