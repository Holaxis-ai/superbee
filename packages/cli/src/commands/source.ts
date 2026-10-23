import { registerSourcePlugin,listSourcePlugins,removeSourcePlugin,SOURCE_PLUGIN_TRUST } from "../source-plugins.js";
import { sourceRefusal } from "../source-local/state.js";
import { bindLocalSnapshot, runLocalSnapshot, checkLocalSnapshot } from "../source-local/snapshot.js";
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
  superbee source plugin register <built-folder> [--accept <digest>] [--json]
  superbee source plugin list [--json]
  superbee source plugin remove <plugin-id> [--json]
  superbee source bind <feed-id> (--anonymous | --credential-env <NAME>) [--accept <digest>] [--dir <bundle>]
  superbee source run <feed-id> [--complete] [--actor <actor>] [--dir <bundle>]
  superbee source snapshot bind <source-doc> [--accept <digest>] [--dir <bundle>]
  superbee source snapshot run <source-doc> --snapshot <ordinary.json> [--accept <digest>] [--actor <actor>] [--dir <bundle>]
  superbee source snapshot check <file> --inputs-file <explicit-map.json> [--settings-file <original-settings.json>]
  superbee source test <recipe-path> --fixture <directory> [--profile <local.mjs>] [--json]

Snapshot run requires previously accepted snapshot bind consent and the existing valid Signal Kind
used by record-overlay, alongside the target Kind. Missing binding refuses without creating state.
Signal links require vocabulary for the actual source/target Kinds; unsupported typed links are omitted.
Snapshot run defaults to input_preview (effects_planned:false, applied:false); --accept authorizes
these exact bytes/policy/private version. Target effects are evaluated only during execution.
Snapshot consent contains no credential and cannot be used by HTTP source run. Changed snapshot
binding with observation history requires a deliberately new source document/state key.
Snapshot check reads a closed {inputs:{logicalId:path},required_identities?:{logicalId:path}} map.
Only explicit ordinary files outside bundles/private state are read. Missing observations are unknown.
The map permits 64 selections per namespace. Original input/identity observations total at most
128 MiB; map/settings JSON at most 64 KiB each. Unselected required dimensions stay unknown.
Settings use original invocation JSON, not exported/normalized settings. Current means equal to the
caller_asserted basis; hashes observed now do not establish historical consumption.
Target updates use existing document CAS. A second identity claimant added during execution may
only be detected on a later fresh index/run; there is no bundle-wide membership transaction.

Replays fixture.json through core's source harness and MemoryBackend. The report compares explicit
receipt, request, cursor, change and finding expectations and lists missing required scenarios.
Any missing scenario, invalid fixture, failed invariant or changed expectation exits nonzero.
bind previews consent without network or credential reads; --accept persists private consent.
run permits built-in and explicitly registered profiles, refuses changed consent and uses DNS-pinned HTTPS.
Plugin updates require re-registration and explicit feed rebind, which resets observation and accepted
state for reacquisition. Removal deactivates future selections; already selected runs may finish.
Register/list/remove and recipe install/validate never execute plugin code.
Recipe add accepts <plugin-id>:<recipe-key> from accepted snapshot bytes, including github:source-feeds and github:work-items.
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
  if(argv[0]==="snapshot") {
    const action=argv[1];
    if(!["bind","run","check"].includes(action??""))throw sourceRefusal("snapshot_action_invalid");
    const shared={json:{type:"boolean" as const},help:{type:"boolean" as const,short:"h"}};
    const p=action==="bind"
      ?parseLeafOrUsage(()=>parseArgs({args:argv.slice(2),allowPositionals:true,strict:true,options:{...shared,dir:{type:"string"},accept:{type:"string"}}}),CLI_LEAVES.sourceSnapshotBind)
      :action==="run"
        ?parseLeafOrUsage(()=>parseArgs({args:argv.slice(2),allowPositionals:true,strict:true,options:{...shared,dir:{type:"string"},snapshot:{type:"string"},accept:{type:"string"},actor:{type:"string"}}}),CLI_LEAVES.sourceSnapshotRun)
        :parseLeafOrUsage(()=>parseArgs({args:argv.slice(2),allowPositionals:true,strict:true,options:{...shared,"inputs-file":{type:"string"},"settings-file":{type:"string"}}}),CLI_LEAVES.sourceSnapshotCheck);
    if(p.values.help){stdout(renderUsage(SOURCE_USAGE));return;}
    const values=p.values as Record<string,string|boolean|undefined>;
    if(action==="run"&&!values.snapshot)throw sourceRefusal("snapshot_file_required");
    if(action==="check"&&!values["inputs-file"])throw sourceRefusal("snapshot_inputs_file_required");
    const options={dir:values.dir as string|undefined,accept:values.accept as string|undefined,snapshot:values.snapshot as string|undefined,actor:values.actor as string|undefined};
    const result=action==="bind"?await bindLocalSnapshot(p.positionals[0]!,options):action==="run"?await runLocalSnapshot(p.positionals[0]!,options)
      :await checkLocalSnapshot(p.positionals[0]!,{inputsFile:values["inputs-file"] as string,settingsFile:values["settings-file"] as string|undefined});
    stdout(render(result,resolveMode(p.values)));
    if(action==="run"&&result.status==="executed"&&result.outcome!=="observed"&&result.outcome!=="deferred")throw new CliError("RUNTIME","Local snapshot run did not complete successfully; inspect its receipt.",{handled:true});
    return;
  }
  if(argv[0]==="plugin") {
    const action=argv[1];
    if(!["register","list","remove"].includes(action??""))throw new CliError("USAGE","Expected source plugin register, list or remove.");
    const parserOptions={args:argv.slice(2),allowPositionals:true,strict:true,options:{json:{type:"boolean"},help:{type:"boolean",short:"h"},...(action==="register"?{accept:{type:"string" as const}}:{})}} as const;
    const p=action==="register"
      ? parseLeafOrUsage(()=>parseArgs(parserOptions),CLI_LEAVES.sourcePluginRegister)
      : action==="list"
        ? parseLeafOrUsage(()=>parseArgs(parserOptions),CLI_LEAVES.sourcePluginList)
        : parseLeafOrUsage(()=>parseArgs(parserOptions),CLI_LEAVES.sourcePluginRemove);
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
  if (argv[0] !== "test") throw new CliError("USAGE", "Expected source snapshot, plugin, test, bind or run.");
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
