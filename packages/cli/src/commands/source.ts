import { registerSourcePlugin,listSourcePlugins,removeSourcePlugin,SOURCE_PLUGIN_TRUST } from "../source-plugins.js";
import { sourceRefusal } from "../source-local/state.js";
import { bindLocalSource, runLocalSource } from "../source-local/run.js";
import { parseArgs } from "node:util";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { testSourceForAuthor } from "../integration-author/source-test.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { assertPathOutsidePrivateState } from "../private-state-bundle-boundary.js";

export const SOURCE_USAGE = `superbee source — test, bind and explicitly run a source

Usage:
  superbee source plugin register <installed-package-directory> [--accept <digest>] [--json]
  superbee source plugin list [--json]
  superbee source plugin remove github [--json]
  superbee source bind <feed-id> (--anonymous | --credential-env <NAME>) [--accept <digest>] [--dir <bundle>]
  superbee source run <feed-id> [--complete] [--actor <actor>] [--dir <bundle>]
  superbee source test <recipe-path> --fixture <directory> [--profile <local.mjs>] [--json]

Replays fixture.json through core's source harness and MemoryBackend. The report compares explicit
receipt, request, cursor, change and finding expectations and lists missing required scenarios.
Any missing scenario, invalid fixture, failed invariant or changed expectation exits nonzero.
bind previews consent without network or credential reads; --accept persists private consent.
run permits built-in and explicitly registered profiles, refuses changed consent and uses DNS-pinned HTTPS.
Plugin updates require re-registration and explicit feed rebind, which resets observation and accepted
state for reacquisition. Removal deactivates future selections; already selected runs may finish.
Register/list/remove and recipe install/validate never execute plugin code.
Recipe add accepts github:source-feeds and github:work-items from accepted snapshot bytes.
Use the external installed package recipe folders for recipe validate and source test.
${SOURCE_PLUGIN_TRUST}
--anonymous never discovers credentials; --credential-env stores only the variable name.
Local/Git bundles only. Run updates existing linked documents/Signals, never mirrors new records.
Run emits its safe receipt before a terminal failure exits nonzero. Deferred continuation exits 0
with retry metadata; it does not claim a complete observation.

--profile explicitly imports TRUSTED local JavaScript exporting a matching SourceProfile. It is
ordinary code execution in this process, not a sandbox; recorded transport cannot constrain
arbitrary module code. Without this flag only a built-in or explicitly registered profile can run. A recipe/fixture cannot
implicitly select a module. recipe validate never executes profile code.

Options:
  --fixture <directory> Directory containing the recorded version-1 fixture.json
  --profile <local.mjs> Explicitly execute a trusted local SourceProfile (default export or profile)
  --json                Compact JSON instead of TOON
  -h, --help            Show this help
`;

export async function source(argv: string[], deps: { stdout?: (text: string) => void; run?: typeof runLocalSource } = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  if (argv[0] === undefined || argv[0] === "--help" || argv[0] === "-h") { stdout(renderUsage(SOURCE_USAGE)); return; }
  if(argv[0]==="plugin") {
    const action=argv[1];
    if(!["register","list","remove"].includes(action??""))throw new CliError("USAGE","Expected source plugin register, list or remove.");
    const spec=action==="register"?CLI_LEAVES.sourcePluginRegister:action==="list"?CLI_LEAVES.sourcePluginList:CLI_LEAVES.sourcePluginRemove;
    const p=parseLeafOrUsage(()=>parseArgs({args:argv.slice(2),allowPositionals:true,strict:true,options:{json:{type:"boolean"},help:{type:"boolean",short:"h"},...(action==="register"?{accept:{type:"string" as const}}:{})}}),spec);
    if(p.values.help){stdout(renderUsage(SOURCE_USAGE));return;}
    const result=action==="register"?await registerSourcePlugin(p.positionals[0]!,p.values.accept as string|undefined):action==="list"?await listSourcePlugins():await removeSourcePlugin(p.positionals[0]!);
    stdout(render(result,resolveMode(p.values)));return;
  }
  if (argv[0] === "bind" || argv[0] === "run") {
    const bind = argv[0] === "bind";
    const p = bind
      ? parseLeafOrUsage(() => parseArgs({args:argv.slice(1),allowPositionals:true,strict:true,options:{dir:{type:"string"},json:{type:"boolean"},help:{type:"boolean",short:"h"},anonymous:{type:"boolean"},"credential-env":{type:"string"},accept:{type:"string"}}}),CLI_LEAVES.sourceBind)
      : parseLeafOrUsage(() => parseArgs({args:argv.slice(1),allowPositionals:true,strict:true,options:{dir:{type:"string"},json:{type:"boolean"},help:{type:"boolean",short:"h"},complete:{type:"boolean"},actor:{type:"string"}}}),CLI_LEAVES.sourceRun);
    if(p.values.help){stdout(renderUsage(SOURCE_USAGE));return;}
    const values = p.values as Record<string,string|boolean|undefined>;
    const options={dir:values.dir as string|undefined,anonymous:values.anonymous as boolean|undefined,credentialEnv:values["credential-env"] as string|undefined,accept:values.accept as string|undefined,complete:values.complete as boolean|undefined,actor:values.actor as string|undefined};
    try {
      const report=bind?await bindLocalSource(p.positionals[0]!,options):await (deps.run ?? runLocalSource)(p.positionals[0]!,options);
      stdout(render(report,resolveMode(p.values)));
      if(!bind && report.outcome!=="observed" && report.outcome!=="deferred") {
        const code = report.outcome==="credential_refused" ? "AUTH_REQUIRED"
          : report.outcome==="not_found" ? "NOT_FOUND"
          : ["refused","unsupported_content","too_large"].includes(String(report.outcome)) ? "USAGE" : "RUNTIME";
        throw new CliError(code,"Local source run did not complete successfully; inspect its receipt.",{handled:true});
      }
      return;
    } catch(error) { if(error instanceof CliError) throw error; throw sourceRefusal("operation_failed","RUNTIME"); }
  }
  if (argv[0] !== "test") throw new CliError("USAGE", "Expected source plugin, test, bind or run.");
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
