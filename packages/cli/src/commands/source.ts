import { parseArgs } from "node:util";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { testSourceForAuthor } from "../integration-author/source-test.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertPathOutsidePrivateState } from "../private-state-bundle-boundary.js";

export const SOURCE_USAGE = `superbee source — test a source offline with recorded provider answers

Usage:
  superbee source test <recipe-path> --fixture <directory> [--profile <local.mjs>] [--json]

Replays fixture.json through core's source harness and MemoryBackend. The report compares explicit
receipt, request, cursor, change and finding expectations and lists missing required scenarios.
Any missing scenario, invalid fixture, failed invariant or changed expectation exits nonzero.
No source bind/run, credential access or live provider transport is included.

--profile explicitly imports TRUSTED local JavaScript exporting a matching SourceProfile. It is
ordinary code execution in this process, not a sandbox; recorded transport cannot constrain
arbitrary module code. Without this flag only a shipped profile can run. A recipe/fixture cannot
implicitly select a module. recipe validate never executes profile code.

Options:
  --fixture <directory> Directory containing the recorded version-1 fixture.json
  --profile <local.mjs> Explicitly execute a trusted local SourceProfile (default export or profile)
  --json                Compact JSON instead of TOON
  -h, --help            Show this help
`;

export async function source(argv: string[], deps: { stdout?: (text: string) => void } = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  if (argv[0] === undefined || argv[0] === "--help" || argv[0] === "-h") { stdout(renderUsage(SOURCE_USAGE)); return; }
  if (argv[0] !== "test") throw new CliError("USAGE", "Expected source test; live source binding and running are not available.");
  const parsed = parseLeafOrUsage(() => parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true,
    options: { fixture: { type: "string" }, profile: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } }), CLI_LEAVES.sourceTest);
  if (parsed.values.help) { stdout(renderUsage(SOURCE_USAGE)); return; }
  if (!parsed.values.fixture) throw new CliError("USAGE", "source test requires --fixture <directory>.");
  assertPathOutsidePrivateState(parsed.values.fixture);
  if (parsed.values.profile) assertPathOutsidePrivateState(parsed.values.profile);
  const report = await testSourceForAuthor(parsed.positionals[0]!, parsed.values.fixture, { profile: parsed.values.profile });
  stdout(render(report, resolveMode(parsed.values)));
  if (!report.ok) throw new CliError("USAGE", "Source fixture qualification failed; inspect missing scenarios and diagnostic locations.", { handled: true });
}
