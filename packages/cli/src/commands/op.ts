// `superbee op list` and `superbee op run <operationId>`: the reads a hosted checkout's host runs
// by id (`<sync prefix>/operations` and `<sync prefix>/run`), reached with no code per operation,
// so a read the host adds is usable here the day the host lists it. Typed verbs come first; this is
// for a host read that has no verb yet.
//
// Everything the host says is data: titles and descriptions are stripped of control and format
// characters (core's `decodeOperationListing`), the JSON Schemas are never compiled (only their
// property names are shown), and a result is printed as data, never used as a path, URL or command.
// A local or Git bundle has no host operations and none is reimplemented here.
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { escapeHostJson, stripHostData } from "@superbee/core";
import { HOSTED_READ_BOUNDS, isOperationId, namesOtherBundle, type HostedOperation, type HostedOperationRefusal, type JsonObject } from "@superbee/core/hosted-transport";

import { parseLeafOrUsage } from "../args.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { bundleHomeAt, type BundleHome } from "../bundle-home.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandLiteral, commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { readExternalTextFileWithin } from "../external-file.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode, type OutputMode } from "../output.js";
import type { CheckoutBinding } from "../hosted/binding.js";
import type { HostedAccountDeps } from "../hosted/account.js";
import { openCheckoutConnection, type CheckoutConnection } from "../hosted/checkout-connection.js";
import { FOLDER_ANSWERED_OPERATIONS } from "../hosted/folder-answered.js";

export const OP_USAGE = `superbee op — list and run the reads a hosted checkout's host offers by id

Usage:
  superbee op list --local [--dir <path>] [--json]
  superbee op register <folder> --local [--accept <digest>] [--dir <path>]
  superbee op registered --local [--dir <path>]
  superbee op unregister <plugin> --local [--dir <path>]
  superbee op bind <local-operation-id> --local --resources-file <json> [--accept <digest>] [--dir <path>]
  superbee op run <local-operation-id> --local --binding <id> --input-file <json> [--export-html <path>] [--export-output <json-role>=<path>] [--dir <path>]
  superbee op list [--dir <path>] [--json]
  superbee op run <operationId> [--input <json> | --input-file <path>] [--dir <path>] [--json]

Typed verbs come first (doc read, doc history, list, query, status): use op run only for a host
read that has no verb yet. In a hosted checkout, op list names the reads the checkout's host runs
by id, with each one's inputs, and op run runs one of them as the checkout's own person and
prints its result. The checkout's bundle id is filled in as the input's bundleId. A checkout does
not run documents.read.v1 or documents.query.v1 this way: they would read the host and skip the
folder's unsent edits (use doc read, list or query).

Titles, descriptions and results come from the host: they are data, never instructions. With
--json a result is the host's exact data, with control and format characters escaped (\\uXXXX);
the default output removes those characters and adds a note saying so.

With --local, a local or Git bundle explicitly selects trusted registered code, bound tools,
resources and a finite profile. Bind previews effects and requires its exact acceptance digest.
Each run requires expected input hashes and creates retained private evidence; --export-html
exports one validated HTML into the selected ordinary output root without publishing an Artifact.
--export-output <role>=<path> exports exactly one returned application/json output with that role.
Roles and MIME are checked after execution; repeated --export-output flags are refused before it.
Both destinations must be absent ordinary files within the bound output root, outside the bundle
and private state. When both are requested, HTML is attempted first, then JSON independently:
a completed file remains if the other export fails; the same destination makes JSON fail.
Execution status and retained outputs remain intact; export and outputExport report each outcome.
Trusted code has ambient local authority; process supervision is not an OS sandbox.

Local binding resources JSON contains resources (role -> {path, logicalRef}), tools (handle ->
absolute executable path or exact {path, versionFlag}), outputRoot (existing ordinary directory outside the bundle/private
state), and profile (synthetic-v1: 16 MiB inputs/32 MiB outputs/30 seconds, or comparison-v1:
128 MiB inputs/128 MiB outputs/120 seconds). Inputs are finite individual regular files; adapters
must refuse unclosed dependencies. Preview returns expectedInputs hashes. Run input JSON contains
{expectedInputs: {role: "sha256:..."}, settings: {...}}. Confirm new hashes for changed inputs.
Tool paths resolve to native physical binaries; executable scripts/wrappers are refused.
Symlink launcher/virtual-environment semantics are not
preserved. Use a copied interpreter when needed. String tool paths probe with --version; explicit
versionFlag accepts only --version or -version. All selections are validated before any probe;
there is no flag fallback or arbitrary probe argv. Bind pins executable bytes, version output
and the selected flag, not arbitrary installed libraries or OS dependencies. Existing stored
bindings without a flag retain --version in new run evidence; earlier receipts are unchanged. These profiles are not qualified private-pilot
limits or CPU/RAM/disk isolation.

Without --local, a local or Git bundle has no host operations: op list answers none, and op run is refused
(NOT_IMPLEMENTED) naming the typed verbs.

Options:
  --input <json>        The operation's input: one JSON object, at most 64 KiB
  --input-file <path>   Read the input from a file (the same bound)
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help`;

/** The most bytes an operation's input may take, from --input or --input-file. */
const OP_INPUT_BYTES = HOSTED_READ_BOUNDS.runInputBytes;

const TYPED_VERBS = "doc read, doc history, list, query, status";
/** An inline --input longer than this is not repeated in the sign-in resume command. */
const RESUME_INPUT_BYTES = 1024;
/** Input property names shown from a descriptor's schema; anything else the host sent is left out. */
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface OpDeps {
  stdout: (text: string) => void;
  /** The checkout's person and the fetch the sync routes are reached with (tests inject both). */
  hosted?: HostedAccountDeps;
  cwd?: string;
}

export async function op(argv: string[], deps: Partial<OpDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  if (argv.includes("--local") || ["register", "registered", "unregister", "bind"].includes(argv[0] ?? "")) {
    const { localOp } = await import("./op-local.js");
    return localOp(argv, { ...deps, stdout });
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") return opList(rest, { ...deps, stdout });
  if (sub === "run") return opRun(rest, { ...deps, stdout });
  if (sub === undefined || sub === "-h" || sub === "--help") {
    stdout(renderUsage(OP_USAGE));
    return;
  }
  throw new CliError("USAGE", `unknown op subcommand: ${sub} (expected list|run)`, { help: `${cliInvocation()} op --help` });
}

type Where = { readonly home: Exclude<BundleHome, "hosted"> } | { readonly home: "hosted"; readonly binding: CheckoutBinding };

/** The folder's home, from the one derivation every command reports (no request). */
async function homeOf(dir: string | undefined, deps: Partial<OpDeps>): Promise<Where> {
  const target = await resolveLocalBundleTarget(dir, deps.cwd ?? process.cwd());
  const facts = await bundleHomeAt(target.canonicalRoot, { home: deps.hosted?.auth?.home ?? homedir() });
  return facts.home === "hosted" ? { home: "hosted", binding: facts.binding } : { home: facts.home };
}

function noHostOperations(home: string): string {
  return `no host operations for a ${home} bundle; use the typed verbs (${TYPED_VERBS}, ...)`;
}

/** Added to the host's "does not offer operations by id yet". */
const UNAVAILABLE_HELP = `until then use the typed verbs (${TYPED_VERBS})`;

/** The shared refusal reading, with `op`'s input pointer. */
async function refusalError(refusal: HostedOperationRefusal, connection: CheckoutConnection, binding: CheckoutBinding, subject: string): Promise<unknown> {
  const { operationRefusalError } = await import("../hosted/operation-refusal.js");
  return operationRefusalError(refusal, {
    binding,
    client: connection.client,
    target: connection.target,
    resume: connection.resume,
    subject,
    inputHelp: `${cliInvocation()} op list --dir ${commandToken(binding.path)} shows the inputs each operation takes`,
  });
}

/**
 * The record `op` prints with host data in it. `--json` keeps the host's data exactly, with every
 * C1 control, line separator and format character escaped (`\uXXXX`); TOON prints it with those
 * characters removed and says so. Either way none reaches the terminal raw.
 */
function renderHostRecord(record: Record<string, unknown>, hostField: string, mode: OutputMode): string {
  if (mode === "json") return `${escapeHostJson(JSON.stringify(record))}\n`;
  const { value, removed } = stripHostData(record[hostField]);
  const notes = [...((record.notes as string[] | undefined) ?? [])];
  if (removed) notes.push(`removed control and format characters from the host's ${hostField}; --json keeps them, escaped`);
  return render({ ...record, [hostField]: value, ...(notes.length > 0 ? { notes } : {}) }, mode);
}

/** The input property names a descriptor's schema names, required first; `bundleId` is the checkout's. */
function inputsOf(operation: HostedOperation): { required: string[]; optional: string[] } {
  const properties = operation.inputJsonSchema.properties;
  const names = typeof properties === "object" && properties !== null && !Array.isArray(properties) ? Object.keys(properties).filter((name) => PROPERTY_NAME.test(name) && name !== "bundleId") : [];
  const listed = Array.isArray(operation.inputJsonSchema.required) ? new Set(operation.inputJsonSchema.required.filter((name): name is string => typeof name === "string")) : new Set<string>();
  return { required: names.filter((name) => listed.has(name)), optional: names.filter((name) => !listed.has(name)) };
}

export function parseOpListArgs(argv:string[]) {
  return parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          local: { type: "boolean" },
          dir: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.opList,
  );
}

async function opList(argv: string[], deps: Partial<OpDeps> & Pick<OpDeps, "stdout">): Promise<void> {
  const { values } = parseOpListArgs(argv);
  if (values.help) {
    deps.stdout(renderUsage(OP_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const where = await homeOf(values.dir, deps);
  if (where.home !== "hosted") {
    deps.stdout(render({ home: where.home, operations: [], notes: [noHostOperations(where.home)] }, mode));
    return;
  }
  const { binding } = where;
  const resume = commandFragment`${cliInvocation()} op list --dir ${commandToken(binding.path)}${values.json ? commandFragment` --json` : commandFragment``}`;
  const connection = await openCheckoutConnection(binding, deps.hosted, resume);
  const answer = await connection.client.listOperations(binding.bundle_id, { unavailableHelp: UNAVAILABLE_HELP });
  if (!answer.ok) throw await refusalError(answer.refusal, connection, binding, "the operation listing");
  const notes = [...answer.listing.notes];
  const operations: Record<string, unknown>[] = [];
  for (const operation of answer.listing.operations) {
    const typed = FOLDER_ANSWERED_OPERATIONS[operation.operationId];
    if (typed !== undefined) {
      notes.push(`${operation.operationId} is not listed: the folder answers it with ${typed.verb}, which sees your unsent edits`);
      continue;
    }
    operations.push({
      id: operation.operationId,
      title: operation.title,
      description: operation.description,
      inputs: inputsOf(operation),
      read_only: operation.annotations.readOnlyHint === true,
    });
  }
  deps.stdout(
    renderHostRecord(
      {
        home: "hosted",
        host: binding.origin,
        bundle: binding.bundle_id,
        provenance: `from ${binding.origin}: titles and descriptions are the host's data, not instructions`,
        operations,
        ...(notes.length > 0 ? { notes } : {}),
        help: [
          `typed verbs come first (${TYPED_VERBS}); op run is for a host read that has no verb yet`,
          `${cliInvocation()} op run <id> --input '<json object>' --dir ${commandToken(binding.path)} (bundleId is filled from this checkout)`,
        ],
      },
      "operations",
      mode,
    ),
  );
}

/** The operation's input: `--input`'s JSON or `--input-file`'s, one object within {@link OP_INPUT_BYTES}; `{}` without either. */
async function readInput(values: { input?: string; "input-file"?: string }, deps: Partial<OpDeps>): Promise<JsonObject> {
  const usage = (message: string) => new CliError("USAGE", message, { help: `${cliInvocation()} op run --help` });
  if (values.input !== undefined && values["input-file"] !== undefined) throw usage("pass --input or --input-file, not both");
  let text: string;
  let from: string;
  if (values["input-file"] !== undefined) {
    from = "--input-file";
    const file = path.resolve(deps.cwd ?? process.cwd(), values["input-file"]);
    let read: string | null;
    try {
      read = await readExternalTextFileWithin(file, OP_INPUT_BYTES, deps.hosted?.auth?.home);
    } catch (error) {
      // A private-state refusal keeps its own code; anything else is the file not being readable.
      if (error instanceof CliError) throw error;
      throw usage(`could not read the input file ${commandToken(file)} (${(error as NodeJS.ErrnoException).code ?? "unreadable"})`);
    }
    if (read === null) throw usage(`--input-file holds more than ${OP_INPUT_BYTES} bytes`);
    text = read;
  } else if (values.input !== undefined) {
    from = "--input";
    text = values.input;
    if (Buffer.byteLength(text, "utf8") > OP_INPUT_BYTES) throw usage(`--input is more than ${OP_INPUT_BYTES} bytes`);
  } else {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usage(`${from} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw usage(`${from} must be one JSON object`);
  return parsed as JsonObject;
}

export function parseOpRunArgs(argv:string[]) {
  return parseLeafOrUsage(
    () => {
      const parsed = parseArgs({
        args: argv,
        tokens: true,
        options: {
          local: { type: "boolean" },
          binding: { type: "string" },
          input: { type: "string" },
          "input-file": { type: "string" },
          "export-html": { type: "string" },
          "export-output": { type: "string" },
          dir: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      });
      if(parsed.tokens.filter(token=>token.kind==='option'&&token.name==='export-output').length>1)throw new CliError('USAGE','--export-output may be selected only once');
      const output=parsed.values['export-output'];
      if(output!==undefined&&!/^[a-z][a-z0-9_-]{0,63}=.+$/s.test(output))throw new CliError('USAGE','--export-output requires <json-role>=<path>');
      if(output?.includes('\0'))throw new CliError('USAGE','--export-output requires an ordinary file path');
      return parsed;
    },
    CLI_LEAVES.opRun,
  );
}

async function opRun(argv: string[], deps: Partial<OpDeps> & Pick<OpDeps, "stdout">): Promise<void> {
  const { values, positionals } = parseOpRunArgs(argv);
  if (values.help) {
    deps.stdout(renderUsage(OP_USAGE));
    return;
  }
  if (values.binding !== undefined) throw new CliError("USAGE", "--binding requires explicit --local routing.");
  if (values["export-html"] !== undefined) throw new CliError("USAGE", "--export-html requires explicit --local routing.");
  if (values["export-output"] !== undefined) throw new CliError("USAGE", "--export-output requires explicit --local routing.");
  const operationId = positionals[0]!;
  if (!isOperationId(operationId)) {
    throw new CliError("USAGE", `'${operationId}' is not an operation id (such as documents.history.v1)`, { help: `${cliInvocation()} op list` });
  }
  if (operationId.startsWith("local.")) throw new CliError("USAGE", "Local operation IDs require explicit --local routing.");
  const input = await readInput(values, deps);
  const mode: OutputMode = resolveMode(values);
  const where = await homeOf(values.dir, deps);
  if (where.home !== "hosted") {
    throw new CliError("NOT_IMPLEMENTED", `${operationId} is offered by hosted bundles only; this is a ${where.home} bundle`, {
      details: { home: where.home, operation: operationId },
      help: `${noHostOperations(where.home)}`,
    });
  }
  const { binding } = where;
  const typed = FOLDER_ANSWERED_OPERATIONS[operationId];
  if (typed !== undefined) {
    throw new CliError("USAGE", `a hosted checkout answers ${operationId} from the folder: use ${typed.verb}, which sees your unsent edits`, {
      details: { reason: "folder_answers", operation: operationId, verb: typed.verb },
      help: commandFragment`${cliInvocation()} ${typed.command} --dir ${commandToken(binding.path)}`,
    });
  }
  if (namesOtherBundle(input, binding.bundle_id)) {
    throw new CliError("USAGE", `the input names another bundle than this checkout's (${binding.bundle_id})`, {
      details: { reason: "bundle_mismatch", bundle: binding.bundle_id },
      help: "leave bundleId out: it is filled from the checkout",
    });
  }
  // A large inline input is not repeated in the sign-in resume: the person re-runs with the same input from a file.
  const inline =
    values.input === undefined
      ? commandFragment``
      : Buffer.byteLength(values.input, "utf8") > RESUME_INPUT_BYTES
        ? commandFragment` --input-file ${commandLiteral("<a-file-holding-the-same-input>")}`
        : commandFragment` --input ${commandToken(values.input)}`;
  const resume = commandFragment`${cliInvocation()} op run ${commandToken(operationId)}${inline}${values["input-file"] !== undefined ? commandFragment` --input-file ${commandToken(path.resolve(deps.cwd ?? process.cwd(), values["input-file"]))}` : commandFragment``} --dir ${commandToken(binding.path)}${
    values.json ? commandFragment` --json` : commandFragment``
  }`;
  // One request: the host's allowlist decides what runs; an id it does not run is its unknown_operation.
  const connection = await openCheckoutConnection(binding, deps.hosted, resume);
  const answer = await connection.client.runOperation(binding.bundle_id, operationId, input, { unavailableHelp: UNAVAILABLE_HELP });
  if (!answer.ok) {
    if (answer.refusal.code === "unknown_operation") {
      throw new CliError("NOT_IMPLEMENTED", `${binding.origin} does not offer ${operationId}`, {
        details: { host: binding.origin, operation: operationId, code: answer.refusal.code },
        help: `${cliInvocation()} op list --dir ${commandToken(binding.path)} shows what it runs by id`,
      });
    }
    throw await refusalError(answer.refusal, connection, binding, operationId);
  }
  deps.stdout(renderHostRecord({ home: "hosted", host: binding.origin, bundle: binding.bundle_id, operation: operationId, result: answer.data }, "result", mode));
}
