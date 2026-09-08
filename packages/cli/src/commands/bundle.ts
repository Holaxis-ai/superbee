// Bundle targeting and persisted time-zone policy use their respective shared authorities.
import { parseArgs } from "node:util";
import { parseSelectorOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { readBundleTimeZone, setBundleTimeZone } from "@superbee/core";
import { resolveActor } from "../actor.js";
import { openBundle, resolveRemoteFlag, resolveLocalBundleTarget } from "../bundle.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode } from "../output.js";

export const BUNDLE_USAGE = `superbee bundle — inspect targeting and configure bundle time zone

Usage:
  superbee bundle locate [--dir <path>]
  superbee bundle timezone [--dir <path> | --remote <url>]
  superbee bundle timezone set <IANA-zone> [options]
  superbee bundle timezone reset [options]

Commands:
  locate                  Resolve the exact local bundle this invocation would use
  timezone                Show effective time zone, source, and root version
  timezone set <IANA-zone> Persist a named zone, e.g. America/New_York
  timezone reset          Remove the override and return to GMT (Etc/GMT)

Options:
  --dir <path>            Resolve this bundle root or its direct .superbee (or legacy .agentstate-lite) child
  --remote <url>          Explicit HTTP bundle (timezone only; mutually exclusive with --dir)
  --expected-version <v>  Set/reset only: root version from inspection; stale tokens fail without retry
  --actor <name>          Set/reset attribution (OKF actor in v0.2 bundles)
  --json                  Emit compact JSON instead of TOON
  -h, --help              Show this help

Resolution preserves normal CLI precedence: explicit --dir, then the nearest project binding,
then local discovery. A successful receipt contains a canonical absolute local path suitable for
passing back to ordinary commands with --dir. The locate command never reads or selects an HTTP remote.

The default is fixed GMT, independent of the host zone. Named zones follow their daylight-saving
rules. Settings travel with index.md as the Superbee extension superbee_base_time_zone; set/reset
preserve other metadata and document timestamps. Date-only and zone-less deadlines still require
an explicit date, time, and zone. No historical deadlines are reinterpreted or migrated.
Set/reset uses one guarded write against the observed root version, including when no explicit
--expected-version is supplied. A conflict requires inspection and a new deliberate invocation.
`;

export interface BundleCliDeps {
  stdout: (s: string) => void;
  cwd: () => string;
}

export async function bundleCommand(argv: string[], deps: Partial<BundleCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const cwd = deps.cwd ?? (() => process.cwd());
  const parsed = parseSelectorOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          remote: { type: "string" },
          actor: { type: "string" },
          "expected-version": { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    "bundle",
    (positionals) => {
      if (positionals.length === 0) return { kind: "navigation" } as const;
      if (positionals[0] === "locate") {
        return { kind: "selected", leaf: CLI_LEAVES.bundleLocate, data: positionals.slice(1), payload: "locate" } as const;
      }
      if (positionals[0] !== "timezone") return { kind: "unknown", token: positionals[0] } as const;
      if (positionals[1] === undefined) {
        return { kind: "selected", leaf: CLI_LEAVES.bundleTimezone, data: [], payload: "timezone" } as const;
      }
      if (positionals[1] === "set") {
        return { kind: "selected", leaf: CLI_LEAVES.bundleTimezoneSet, data: positionals.slice(2), payload: "set" } as const;
      }
      if (positionals[1] === "reset") {
        return { kind: "selected", leaf: CLI_LEAVES.bundleTimezoneReset, data: positionals.slice(2), payload: "reset" } as const;
      }
      return { kind: "unknown", token: positionals[1] } as const;
    },
  );

  if (parsed.selection.kind === "help" || parsed.selection.kind === "navigation") {
    stdout(BUNDLE_USAGE);
    return;
  }
  if (parsed.selection.kind === "unknown") {
    throw new CliError("USAGE", `unknown bundle subcommand: ${parsed.selection.token ?? ""}`, {
      help: `${cliInvocation()} bundle --help`,
    });
  }

  const { values, selection } = parsed;
  const mutation = selection.payload === "set" || selection.payload === "reset";
  if (!mutation && (values.actor !== undefined || values["expected-version"] !== undefined)) {
    throw new CliError("USAGE", "--actor and --expected-version apply only to bundle timezone set/reset");
  }
  if (selection.payload !== "locate") {
    const rawExpected = values["expected-version"];
    if (rawExpected !== undefined && !rawExpected.trim()) {
      throw new CliError("USAGE", "--expected-version must contain a root version from bundle timezone inspection");
    }
    const actor = mutation ? resolveActor(values.actor) : undefined;
    const remote = await resolveRemoteFlag(values.remote, values.dir);
    const bundle = await openBundle(values.dir, remote);
    const receipt = mutation
      ? await setBundleTimeZone(bundle, selection.payload === "reset" ? null : selection.data[0]!, {
        ...(actor === undefined ? {} : { actor }),
        ...(rawExpected === undefined ? {} : { expectedVersion: rawExpected.trim() }),
      })
      : await readBundleTimeZone(bundle);
    stdout(render({ schema_version: 1, ...receipt }, resolveMode(values)));
    return;
  }
  if (values.remote !== undefined) {
    throw new CliError("USAGE", "bundle locate is local-only; use bundle timezone --remote <url> for remote configuration");
  }
  const target = await resolveLocalBundleTarget(values.dir, cwd());
  stdout(
    render(
      {
        schema_version: 1,
        locator: { kind: "local-path", path: target.canonicalRoot },
        selected_by: target.selectedBy,
        ...(target.bindingFile ? { binding_file: target.bindingFile } : {}),
        available: true,
      },
      resolveMode(parsed.values),
    ),
  );
}
