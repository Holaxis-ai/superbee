import { parseArgs } from "node:util";
import yaml from "js-yaml";
import { isStandardDocumentSetField, loadKinds, readBundleOkfVersion, type FieldActionErrorDetails, type FieldAction, type SourceSelector } from "@superbee/core";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { commandFragment, commandToken, commandWords } from "../../command-text.js";
import { cliInvocation } from "../../invocation.js";
import { CliError } from "../../errors.js";
import { readExternalTextFile } from "../../external-file.js";
import { assertResolvedLocalRouteIdentity, boardAttributionForRoute, openBundle, resolveLocalBundleRoute, resolveRemoteFlag } from "../../bundle.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../../concept-id.js";
import { resolveActor } from "../../actor.js";
import { boardPostPersistHook } from "../../board-attribution.js";
import { mutateDoc } from "../../mutate.js";
import { render, resolveMode } from "../../output.js";
import type { DocCliDeps } from "./common.js";

const leaves = {
  set: CLI_LEAVES.docFieldSet,
  add: CLI_LEAVES.docFieldAdd,
  remove: CLI_LEAVES.docFieldRemove,
  edit: CLI_LEAVES.docFieldEdit,
  "replace-all": CLI_LEAVES.docFieldReplaceAll,
} as const;
type Action = keyof typeof leaves;
const descriptions: Record<Action, string> = {
  set: "Assign one supported non-collection field. Literal values are strings; use --from-file for typed scalars or a complete list-free mapping. Other fields and the body remain unchanged.",
  add: "Make one exact tag string or source entry present. New members append; an identical addition is a no-op. Supply a tag literally or one source mapping with --from-file.",
  remove: "Make one exact tag membership or selected source absent. A missing member is a no-op. For sources, supply exactly one --id or --resource; no value is accepted.",
  edit: "Update supplied properties of one source, preserving its position, sibling sources and other properties. Requires --from-file, --expected-version and exactly one --id or --resource. An ID-less source may receive its first nonempty ID; an existing ID cannot be renamed.",
  "replace-all": "Supply the complete final tags or sources list with --from-file and --expected-version. [] empties the list; omitted members are deliberately removed.",
};
export const DOC_FIELD_USAGE = `superbee doc field - explicit frontmatter actions

Usage:
  superbee doc field <action> <id> <field> [value/options]

Actions: set, add, remove, edit, replace-all
Collections: tags and sources only. sources requires OKF v0.2.
Set supports type, title, description, resource, edition-supported status,
stale_after and usage_window, and declared non-collection Kind fields.
Managed provenance and verification fields are not generic set targets.
Use 'superbee doc field <action> --help' for focused input and version rules.
`;
function help(action: Action): string {
  return `superbee doc field ${action} - ${descriptions[action]}\n\nUsage:\n  superbee doc field ${action} <id> <field> ${action === "edit" || action === "replace-all" ? "" : "[value] "}[options]\n\nOptions:\n  --from-file <path>   One complete JSON/YAML value; never combined with a literal\n  --id <source-id>     Exact source ID (including an empty existing ID)\n  --resource <value>   Exact resource fallback for one ID-less source\n  --expected-version <v>  Observed document version; required for edit/replace-all\n  --actor <actor>      Revision attribution\n  --strict             Reject Kind warnings (declared Kind fields are always strict)\n  --dir <path>         Bundle directory\n  --remote <url>       Explicit wire server (exclusive with --dir)\n  --json               Emit compact JSON instead of TOON\n  -h, --help           Show this help without reading a bundle\n\nLiteral strings are never split on commas or parsed as key/value pairs. Put flags\nbefore -- when passing a dash-leading literal. Field actions never read stdin.\nResource selection refuses an ID-bearing entry and directs you to its ID.\nAmbiguous sources require a unique ID or deliberate versioned whole-list repair.\nA mapping assignment replaces that complete mapping; it cannot hide a nested list.\nUse sources replace-all for source properties containing lists, or complete-document\nreplacement for other nested collections: pull --doc-key <id>.md --out <file>,\nedit that file, then promote <file> --doc-key <id>.md\n--expected-version <version-from-pull>. Field actions preserve the document body.\n`;
}

export async function docField(argv: string[], deps: Partial<DocCliDeps>): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const token = argv[0];
  if (token === undefined || token === "--help" || token === "-h") { stdout(DOC_FIELD_USAGE); return; }
  if (!Object.prototype.hasOwnProperty.call(leaves, token)) throw new CliError("USAGE", `unknown doc field action: ${token}`, { help: `${cliInvocation()} doc field --help` });
  const action = token as Action;
  const leaf = leaves[action];
  const helpCommand = `${cliInvocation()} ${commandWords(leaf.path)} --help`;
  const fail = (message: string): never => { throw new CliError("USAGE", message, { help: helpCommand }); };
  const config = {
    args: argv.slice(1), tokens: true, allowPositionals: true,
    options: { "from-file": { type: "string" }, id: { type: "string" }, resource: { type: "string" }, "expected-version": { type: "string" }, actor: { type: "string" }, dir: { type: "string" }, remote: { type: "string" }, strict: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  } as const;
  const { values, positionals, tokens } = action === "set" ? parseLeafOrUsage(() => parseArgs(config), CLI_LEAVES.docFieldSet)
    : action === "add" ? parseLeafOrUsage(() => parseArgs(config), CLI_LEAVES.docFieldAdd)
    : action === "remove" ? parseLeafOrUsage(() => parseArgs(config), CLI_LEAVES.docFieldRemove)
    : action === "edit" ? parseLeafOrUsage(() => parseArgs(config), CLI_LEAVES.docFieldEdit)
    : parseLeafOrUsage(() => parseArgs(config), CLI_LEAVES.docFieldReplaceAll);
  if (values.help) { stdout(help(action)); return; }
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === "option") {
    if (seen.has(token.name)) fail(`--${token.name} was supplied more than once; pass it once.`);
    seen.add(token.name);
  }
  const rawId = positionals[0]!;
  let id = conceptIdFromCliArgument(rawId);
  const field = positionals[1]!;
  if (!field || !rawId.trim()) fail("A document ID and field name are required.");
  const literal = positionals[2];
  const fromFile = values["from-file"];
  const expectedVersion = values["expected-version"];
  if (expectedVersion !== undefined && expectedVersion.trim() === "") fail("--expected-version requires a nonempty observed version.");
  if ((action === "edit" || action === "replace-all") && expectedVersion === undefined) fail("This action requires --expected-version from a prior document read.");
  if (fromFile !== undefined && !fromFile.trim()) fail("--from-file requires a nonempty path.");
  if (fromFile !== undefined && literal !== undefined) fail("Supply either a literal value or --from-file, never both.");
  const needsSelector = action === "edit" || (action === "remove" && field === "sources");
  const selectorCount = Number(values.id !== undefined) + Number(values.resource !== undefined);
  if (needsSelector ? selectorCount !== 1 : selectorCount !== 0) fail(needsSelector ? "Select one source with exactly one --id or --resource." : "Selectors are only accepted for source edit/remove.");
  if (action === "edit" && field !== "sources") fail("edit supports sources only.");
  if (action !== "set" && field !== "tags" && field !== "sources") fail("Collection actions support only tags and sources.");
  if (action === "remove" && field === "sources") {
    if (literal !== undefined || fromFile !== undefined) fail("Source remove accepts a selector, not a value.");
  } else if (literal === undefined && fromFile === undefined) fail("Supply one literal value or --from-file.");
  if ((action === "edit" || action === "replace-all" || (action === "add" && field === "sources")) && fromFile === undefined) fail("This action requires one complete JSON/YAML value through --from-file.");
  const routeFlag = values.dir !== undefined ? commandFragment` --dir=${commandToken(values.dir)}` : values.remote !== undefined ? commandFragment` --remote=${commandToken(values.remote)}` : commandFragment``;
  const actor = resolveActor(values.actor, { help: helpCommand });
  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const route = remote === undefined ? await resolveLocalBundleRoute(values.dir) : undefined;
  const bundle = route?.bundle ?? await openBundle(values.dir, remote);
  if (route) await assertResolvedLocalRouteIdentity(route);
  id = await resolveConceptIdCliArgument(bundle, rawId);
  let value: unknown = literal;
  if (fromFile !== undefined) {
    const source = await readExternalTextFile(fromFile);
    if (!source.trim()) fail("--from-file must contain one complete JSON/YAML value; the file is empty.");
    try { value = /\.json$/i.test(fromFile) ? JSON.parse(source) : yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA }); }
    catch { fail("--from-file must contain one complete valid JSON/YAML value."); }
    if (value === undefined) fail("--from-file must contain one complete JSON/YAML value.");
  }
  const selector: SourceSelector | undefined = values.id !== undefined ? { id: values.id } : values.resource !== undefined ? { resource: values.resource } : undefined;
  const operation = (action === "edit" ? { action, field, selector, patch: value } : action === "remove" && field === "sources" ? { action, field, selector } : { action, field, value }) as FieldAction;
  const registry = await loadKinds(bundle);
  const edition = (await readBundleOkfVersion(bundle)) === "0.2" ? "0.2" : "0.1";
  // Standard edits retain warn-by-default; dynamic Kind fields retain strict authoring.

  if (route) await assertResolvedLocalRouteIdentity(route);
  try {
    const result = await mutateDoc({
      bundle, id, mode: "patch", onAbsent: "fail", registry,
      strict: Boolean(values.strict) || (action === "set" && !isStandardDocumentSetField(field, edition)),
      helpOnKindReject: `${cliInvocation()} kinds`, actor, persistActor: true,
      expectedVersion: expectedVersion?.trim(), remoteUrl: values.remote,
      input: (_existing, context) => {
        if (context.okfVersion !== edition) fail("The bundle edition changed; retry against its current declaration.");
        return { kind: "field-action", action: operation };
      },
      onPersisted: boardPostPersistHook(route ? boardAttributionForRoute(route) : { kind: "none" }, actor),
      errors: {
        notFound: () => new CliError("NOT_FOUND", `no concept document at id '${id}'`, { help: `${cliInvocation()} list` }),
        staleHead: error => new CliError("STALE_HEAD", "The document has moved; re-read its current version before retrying.", { help: `${cliInvocation()} doc read ${commandToken(id)}${routeFlag}`, details: { expected: error.expected, actual: error.actual } }),
      },
    });
    const scope = result.scope!;
    const { affectedSourceIds, ...boundedScope } = scope;
    stdout(render({ doc: "field", id: result.doc.id, field, operation: action, changed: result.changed, version: result.version,
      scope: { ...boundedScope, ...(affectedSourceIds === undefined ? {} : { affectedSourceIds: affectedSourceIds.slice(0, 20), affectedSourceIdCount: affectedSourceIds.length }) },
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
      help: [`${cliInvocation()} doc read ${commandToken(result.doc.id)}${routeFlag}`],
    }, resolveMode(values)));
  } catch (error) {
    if (error instanceof CliError && error.code === "USAGE" && !error.help) {
      const details = error.details as FieldActionErrorDetails | undefined;
      let correction = helpCommand;
      const selected = details?.recommendedSelector;
      if (selected && selected.id !== undefined) {
        const nextAction = details?.reason === "source-id-conflict" ? "edit" : action;
        const fileFlag = nextAction === "edit" ? commandFragment` --from-file=${commandToken(fromFile ?? "<patch-file>")}` : commandFragment``;
        const versionFlag = expectedVersion !== undefined ? commandFragment` --expected-version=${commandToken(expectedVersion)}` : nextAction === "edit" ? commandFragment` --expected-version=${commandToken("<observed-version>")}` : commandFragment``;
        correction = `${cliInvocation()} doc field ${commandWords(nextAction)} ${commandToken(id)} sources --id=${commandToken(selected.id)}${fileFlag}${versionFlag}${routeFlag}`;
      } else if (details?.reason === "ambiguous-source") {
        correction = `${cliInvocation()} doc read ${commandToken(id)} --field sources${routeFlag}`;
      }
      throw new CliError("USAGE", error.message, { help: correction, details: error.details });
    }
    throw error;
  }
}
