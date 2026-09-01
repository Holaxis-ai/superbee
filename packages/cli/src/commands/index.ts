// Explicit local consumer of core's governed portable-index projection. Generation never runs
// from reads, mutations, sync, session start, or any ambient hook.
import { parseArgs } from "node:util";
import {
  IndexProjectionWriteError,
  applyIndexProjection,
  planIndexProjection,
  prepareIndexProjection,
  queryHeads,
  type AppliedIndexTarget,
  type IndexProjectionPreparation,
  type PreparedIndexTarget,
} from "@superbee/core";

import { resolveActor } from "../actor.js";
import { parseSelectorOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { deriveBundleDisplayName } from "../bundle-name.js";
import { openBundle } from "../bundle.js";
import { CliError, classifyBundleError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { commandLiteral, commandQuoted, joinCommandTokens, type CommandText } from "../command-text.js";
import { render, resolveMode } from "../output.js";

export const INDEX_USAGE = `superbee index — generate portable Markdown navigation

Usage:
  superbee index generate [--dir <path>] [--check] [--force] [--actor <name>]

Scans concept metadata once and plans the bundle's complete index.md hierarchy. A normal run
creates missing indexes and refreshes only files carrying AgentState's exact generated marker.
If any existing target is unmarked or malformed, the whole run refuses before writing anything;
--force is the explicit one-time adoption path and may replace curated prose.

--check performs the identical scan and ownership preflight but never writes. It exits 0 only when
the projection is clean; drift or refusal returns a structured CONFLICT (exit 5) whose details
carry the same capped per-path classification as a normal receipt.

Options:
  --dir <path>       Local bundle directory (default: discovered from the cwd)
  --check            Report drift/refusal without writing; clean is exit 0, otherwise exit 5
  --force            Adopt and replace unmarked/malformed index files explicitly
  --actor <name>     Attribute changed writes (overrides SUPERBEE_ACTOR; legacy
                     AGENTSTATE_LITE_ACTOR remains supported)
  --json             Emit compact JSON instead of TOON on success
  -h, --help         Show this help

This command is local-only. It never syncs and has no --remote mode.
`;

const PATH_LIMIT = 15;

export interface IndexCliDeps {
  stdout: (s: string) => void;
}

function displayPath(dir: string): string {
  return dir === "" ? "index.md" : `${dir}/index.md`;
}

function generateCommand(options: { dir?: string; check?: boolean; force?: boolean } = {}): string {
  const flags: CommandText[] = [
    ...(options.check ? [commandLiteral("--check")] : []),
    ...(options.force ? [commandLiteral("--force")] : []),
    ...(options.dir !== undefined ? [commandLiteral("--dir"), commandQuoted(options.dir)] : []),
  ];
  const flagRun = flags.length > 0 ? joinCommandTokens([commandLiteral(""), ...flags]) : commandLiteral("");
  return `${cliInvocation()} index generate${flagRun}`;
}

function cappedPaths(dirs: readonly string[]): Record<string, unknown> {
  const paths = dirs.map(displayPath);
  return {
    shown: Math.min(paths.length, PATH_LIMIT),
    total: paths.length,
    rows: paths.slice(0, PATH_LIMIT).map((path) => ({ path })),
  };
}

function dirsWith(targets: readonly PreparedIndexTarget[], disposition: PreparedIndexTarget["disposition"]): string[] {
  return targets.filter((target) => target.disposition === disposition).map((target) => target.dir);
}

function classificationFields(prepared: IndexProjectionPreparation): Record<string, unknown> {
  return {
    targets: prepared.targets.length,
    created: cappedPaths(dirsWith(prepared.targets, "missing")),
    updated: cappedPaths(dirsWith(prepared.targets, "generated")),
    unchanged: cappedPaths(dirsWith(prepared.targets, "unchanged")),
    adopted: cappedPaths(dirsWith(prepared.targets, "adopted")),
    refused: cappedPaths(dirsWith(prepared.targets, "refused")),
  };
}

function completedDirs(completed: readonly AppliedIndexTarget[]): string[] {
  return completed.map((target) => target.dir);
}

function plannedChangeCount(prepared: IndexProjectionPreparation): number {
  return prepared.targets.filter((target) => target.disposition !== "unchanged" && target.disposition !== "refused").length;
}

function refusalError(
  prepared: IndexProjectionPreparation,
  displayName: string,
  scanned: number,
  check: boolean,
  dir: string | undefined,
): CliError {
  const details = {
    index: check ? "checked" : "refused",
    clean: false,
    writes: 0,
    display_name: displayName,
    scanned,
    ...classificationFields(prepared),
  };
  return new CliError("CONFLICT", "portable index generation refused: existing index files are not AgentState-owned", {
    details,
    help: check
      ? generateCommand({ dir, force: true })
      : generateCommand({ dir, check: true }),
  });
}

/** CLI entry: plan once, preflight every target, then either report or apply explicitly. */
export async function indexCommand(argv: string[], deps: Partial<IndexCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const { values, selection } = parseSelectorOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          check: { type: "boolean" },
          force: { type: "boolean" },
          actor: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    "index",
    (positionals) => {
      if (positionals.length === 0) return { kind: "navigation" } as const;
      if (positionals[0] !== "generate") return { kind: "unknown", token: positionals[0] } as const;
      return { kind: "selected", leaf: CLI_LEAVES.indexGenerate, data: positionals.slice(1), payload: undefined } as const;
    },
  );
  if (selection.kind === "help" || selection.kind === "navigation") {
    stdout(INDEX_USAGE);
    return;
  }
  if (selection.kind === "unknown") {
    throw new CliError("USAGE", `unknown index subcommand: ${selection.token ?? ""}`, {
      help: `${cliInvocation()} index --help`,
    });
  }

  const actor = resolveActor(values.actor, {
    help: `${cliInvocation()} index generate --actor <name>`,
  });
  const bundle = await openBundle(values.dir);
  const [{ name: displayName }, heads] = await Promise.all([
    deriveBundleDisplayName(bundle),
    queryHeads(bundle),
  ]);
  const plan = planIndexProjection(displayName, heads);
  const prepared = await prepareIndexProjection(bundle, plan, { force: values.force });

  if (!prepared.ready) {
    throw refusalError(prepared, displayName, heads.length, values.check ?? false, values.dir);
  }

  const wouldChange = plannedChangeCount(prepared);
  const fields = classificationFields(prepared);
  if (values.check) {
    const receipt = {
      index: "checked",
      clean: wouldChange === 0,
      writes: 0,
      would_change: wouldChange,
      display_name: displayName,
      scanned: heads.length,
      ...fields,
      help: [generateCommand({ dir: values.dir, force: values.force })],
    };
    if (wouldChange > 0) {
      throw new CliError("CONFLICT", "portable index projection is not current", {
        details: receipt,
        help: generateCommand({ dir: values.dir, force: values.force }),
      });
    }
    stdout(render(receipt, resolveMode(values)));
    return;
  }

  try {
    const applied = await applyIndexProjection(bundle, prepared, { actor });
    const receipt = {
      index: applied.completed.length > 0 ? "generated" : "unchanged",
      changed: applied.completed.length > 0,
      writes: applied.completed.length,
      display_name: displayName,
      scanned: heads.length,
      ...fields,
      completed: cappedPaths(completedDirs(applied.completed)),
      pending: cappedPaths(applied.pending),
      help: [generateCommand({ dir: values.dir, check: true })],
    };
    stdout(render(receipt, resolveMode(values)));
  } catch (error) {
    if (!(error instanceof IndexProjectionWriteError)) throw error;
    const cause = classifyBundleError(error.cause);
    throw new CliError(cause.code, `${error.message}: ${cause.message}`, {
      details: {
        index: "partial",
        display_name: displayName,
        scanned: heads.length,
        ...fields,
        failed: displayPath(error.failed),
        completed: cappedPaths(completedDirs(error.completed)),
        pending: cappedPaths(error.pending),
        ...(cause.details ?? {}),
      },
      help: generateCommand({ dir: values.dir, force: values.force }),
    });
  }
}
