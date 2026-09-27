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
import { isOperationId, type HostedOperation, type HostedOperationRefusal, type JsonObject } from "@superbee/core/hosted-transport";

import { parseLeafOrUsage } from "../args.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { bundleHomeAt, type BundleHome } from "../bundle-home.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandLiteral, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { readExternalTextFileWithin } from "../external-file.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode, type OutputMode } from "../output.js";
import type { CheckoutBinding } from "../hosted/binding.js";
import type { HostedAccountDeps } from "../hosted/account.js";
import { openCheckoutConnection, type CheckoutConnection } from "../hosted/checkout-connection.js";

export const OP_USAGE = `superbee op — list and run the reads a hosted checkout's host offers by id

Usage:
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

A local or Git bundle has no host operations: op list answers none, and op run is refused
(NOT_IMPLEMENTED) naming the typed verbs.

Options:
  --input <json>        The operation's input: one JSON object, at most 64 KiB
  --input-file <path>   Read the input from a file (the same bound)
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help`;

/**
 * The host operations a folder answers through typed verbs, which a checkout never runs by id:
 * they would read the host and skip the folder's unsent edits.
 */
export const FOLDER_ANSWERED_OPERATIONS: Readonly<Record<string, { readonly verb: string; readonly command: CommandText }>> = Object.freeze({
  "documents.read.v1": Object.freeze({ verb: "doc read", command: commandLiteral("doc read <id>") }),
  "documents.query.v1": Object.freeze({ verb: "list or query", command: commandLiteral("list") }),
});

/** The most bytes an operation's input may take, from --input or --input-file. */
export const OP_INPUT_BYTES = 64 * 1024;

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

async function opList(argv: string[], deps: Partial<OpDeps> & Pick<OpDeps, "stdout">): Promise<void> {
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.opList,
  );
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

async function opRun(argv: string[], deps: Partial<OpDeps> & Pick<OpDeps, "stdout">): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          input: { type: "string" },
          "input-file": { type: "string" },
          dir: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.opRun,
  );
  if (values.help) {
    deps.stdout(renderUsage(OP_USAGE));
    return;
  }
  const operationId = positionals[0]!;
  if (!isOperationId(operationId)) {
    throw new CliError("USAGE", `'${operationId}' is not an operation id (such as documents.history.v1)`, { help: `${cliInvocation()} op list` });
  }
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
  if (input.bundleId !== undefined && input.bundleId !== binding.bundle_id) {
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
