// `superbee version [--check [--tag latest|next]] [--json]` — local identity plus an optional,
// bounded read-only comparison against the exact public npm release track.
import { parseArgs } from "node:util";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { buildIdentityEnvelope } from "../build-identity.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, resolveMode } from "../output.js";
import { STABLE_MCP_LAUNCH_GUIDANCE } from "../integration-guidance.js";
import {
  checkSupportedRelease,
  parseStrictSemver,
  type ReleaseTrack,
  type UpdateCheckResult,
} from "../update-check.js";

export const VERSION_USAGE = `superbee version — show identity or compare the supported npm release

Usage:
  superbee version [--check] [--tag latest|next] [--json]

Reports the package version, source commit/dirty state baked at build time, artifact channel and
SHA-256, executable path and launch evidence, compatibility-contract generations, and any adjacent
package.json version drift. Without --check, this command is entirely local and never contacts npm.

--check performs one read-only, two-second comparison against the fixed public npm registry endpoint.
The selected dist-tag is authoritative even when it names a rollback. It never installs a package,
changes a dist-tag, writes preferences, or modifies integrations or bundle content.

${STABLE_MCP_LAUNCH_GUIDANCE}

Options:
  --check             Compare the exact release selected by npm (default track: latest)
  --tag latest|next   Select latest, or explicitly preview next; requires --check
  --json              Emit compact JSON instead of TOON
  -h, --help           Show this help
`;

export interface VersionCommandDeps {
  stdout: (text: string) => void;
  identity: () => ReturnType<typeof buildIdentityEnvelope>;
  check: (input: { runningVersion: string; track: ReleaseTrack }) => Promise<UpdateCheckResult>;
  setExitCode: (code: number) => void;
}

export async function versionCommand(
  argv: string[],
  deps: Partial<VersionCommandDeps> = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          json: { type: "boolean" },
          check: { type: "boolean" },
          tag: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.version,
  );
  if (values.help) {
    stdout(VERSION_USAGE);
    return;
  }
  if (values.tag !== undefined && !values.check) {
    throw new CliError("USAGE", "option '--tag' requires '--check'", {
      help: `${cliInvocation()} version --help`,
    });
  }
  if (values.tag !== undefined && values.tag !== "latest" && values.tag !== "next") {
    throw new CliError("USAGE", "unsupported release tag (expected latest or next)", {
      help: `${cliInvocation()} version --help`,
    });
  }
  const identity = (deps.identity ?? buildIdentityEnvelope)();
  if (!values.check) {
    stdout(render(identity, resolveMode(values)));
    return;
  }
  const track: ReleaseTrack = values.tag === "next" ? "next" : "latest";
  const runningVersion = identity.identity.package.version;
  if (!parseStrictSemver(runningVersion)) {
    throw new CliError("RUNTIME", "running package identity is not valid strict SemVer");
  }
  let check: UpdateCheckResult;
  try {
    check = await (deps.check ?? checkSupportedRelease)({
      runningVersion,
      track,
    });
  } catch {
    throw new CliError("RUNTIME", "supported-release check failed");
  }
  stdout(render({ identity: identity.identity, check }, resolveMode(values)));
  if (check.status === "unavailable") {
    (deps.setExitCode ?? ((code) => void (process.exitCode = code)))(1);
  }
}
