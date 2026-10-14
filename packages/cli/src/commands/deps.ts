// `superbee deps add|remove|list` — the bundles this bundle links into, declared in ONE document,
// `docs/dependencies` (type `Bundle Dependencies`). Every write is checked by core's
// `parseDependencies`, the same parser `status` and the resolver read the document with, so a
// declaration this command accepts is one they accept.
import { parseArgs } from "node:util";
import {
  BUNDLE_NAME_DOC_ID,
  DEPENDENCIES_DOC_ID,
  DEPENDENCIES_DOC_TYPE,
  declaredBundleId,
  loadKinds,
  okfValuesEqual,
  parseDependencies,
  readDoc,
  type Bundle,
  type DependencyProblem,
  type Frontmatter,
  type OkfDocument,
  type ValidationWarning,
} from "@superbee/core";

import { resolveActor } from "../actor.js";
import { parseLeafOrUsage } from "../args.js";
import { maybeAutoPull } from "../autopull.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandToken } from "../command-text.js";
import {
  DECLARATION_COMMON_OPTIONS,
  declarationErrorHooks,
  declarationPersistHook,
  expectedVersionFlag,
  openDeclarationTarget,
} from "../declaration-writes.js";
import { CliError, classifyBundleError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { mutateDoc } from "../mutate.js";
import { render, renderUsage, resolveMode } from "../output.js";

const READ_OPTIONS = `  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Talk to a wire-protocol server instead of a local bundle
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help`;

export const DEPS_USAGE = `superbee deps — declare the bundles this bundle links into (docs/dependencies)

Usage:
  superbee deps add <alias> --bundle-id <id> [--source <s>] [--pin <commit|sha256:digest>] [--path <rel>] [--replace]
  superbee deps remove <alias>
  superbee deps list [--limit <n>]

A declared alias is the <alias> in okf://<alias>/<path>.md links; 'link add --bundle <alias>'
writes them and 'status --with <alias>=<path>' or '--with-deps' checks them.

Run 'superbee deps <verb> --help' for a verb's full options.
`;

export const DEPS_ADD_USAGE = `superbee deps add — declare one bundle this bundle links into

Usage:
  superbee deps add <alias> --bundle-id <id> [--source <s>] [--pin <commit|sha256:digest>] [--path <rel>] [--replace] [options]

Writes the entry <alias>: {bundle_id, source, pin, path} into docs/dependencies, creating the
document (type '${DEPENDENCIES_DOC_TYPE}') when it is missing. Every other entry, every other
field and the body are kept as they are, including keys this version does not know.

The entry is checked by the same rules 'status' reads it with, and refused (USAGE) when:
  <alias>        does not match ^[a-z][a-z0-9-]{0,62}$                         (DEP_ALIAS)
  --bundle-id    is not a portable bundle id                                   (DEP_BUNDLE_ID)
  --pin          is not 7-40 lower-case hex (a commit) or sha256:<64 hex>       (DEP_PIN)
  --path         is absolute (POSIX or Windows) or uses '\\' separators         (DEP_PATH_ABSOLUTE)
  --source/--path  is empty                                                    (DEP_SHAPE)
and refused (CONFLICT) when the bundle's own state forbids it:
  the id is this bundle's own bundle_id (docs/bundle)                          (DEP_SELF)
  another alias already declares the id                                         (DEP_DUPLICATE_BUNDLE)
  the replaced entry keeps a key reserved for recipe dependencies (use, version, channel)
                                                                                (DEP_RESERVED_KEY)
  <alias> is already declared differently and --replace was not given            (DEP_ALIAS_EXISTS)
  docs/dependencies has another type, or its dependencies field is not a mapping  (DEP_TYPE, DEP_SHAPE)

Adding an identical entry again is a no-op (changed:false). --replace sets the entry's bundle_id,
source, pin and path to exactly the flags given and keeps any other key it carries.

The document is re-serialized on write: YAML comments and formatting in its frontmatter are not
preserved (the entries, keys and values are).

Options:
  --bundle-id <id>     The target bundle's portable id (its docs/bundle bundle_id) [required]
  --source <s>         Where to get the bundle (a git URL or hosted:<host>/<bundle_id>); informational
  --pin <pin>          A commit (7-40 lower-case hex) the bound copy's subtree must match, or a
                       sha256:<64 lower-case hex> digest (only a hosted resolver can check one)
  --path <rel>         The target bundle's root relative to this bundle's root, for --with-deps
  --replace            Replace an alias that is already declared differently
${DECLARATION_COMMON_OPTIONS}
`;

export const DEPS_REMOVE_USAGE = `superbee deps remove — remove one declared alias from docs/dependencies

Usage:
  superbee deps remove <alias> [options]

Removes the entry and keeps everything else in the document. Removing an alias that is not
declared, or from a bundle with no docs/dependencies, is a no-op (removed:false, exit 0).
Links under the alias then read as unknown_alias in 'status'. The document is re-serialized on
write: YAML comments and formatting in its frontmatter are not preserved.

Options:
${DECLARATION_COMMON_OPTIONS}
`;

export const DEPS_LIST_USAGE = `superbee deps list — list the declared dependencies

Usage:
  superbee deps list [--limit <n>] [options]

Reads docs/dependencies only: nothing outside this bundle. 'status --with-deps' also checks each
declared bundle can be reached. Each row is alias, bundle_id, source, pin, path; an entry the
parser rejects is absent from the rows and named in problems.

Options:
  --limit <n>          Rows to show (default 50; 0 = all); counts stay the true totals
${READ_OPTIONS}
`;

const DEFAULT_LIMIT = 50;

/** Problems the command refuses rather than writes: each one drops the entry or one of its fields. */
const DROPPING = new Set<DependencyProblem["code"]>([
  "DEP_ALIAS",
  "DEP_SHAPE",
  "DEP_BUNDLE_ID",
  "DEP_PIN",
  "DEP_PATH_ABSOLUTE",
  "DEP_SELF",
  "DEP_DUPLICATE_BUNDLE",
  "DEP_RESERVED_KEY",
]);

/** The keys the command writes; every other key in an entry is carried as it is. */
const ENTRY_FIELDS = ["bundle_id", "source", "pin", "path"] as const;

export interface DepsCliDeps {
  stdout: (s: string) => void;
  autoPull: (dir?: string) => Promise<unknown>;
}

export async function deps(argv: string[], partial: Partial<DepsCliDeps> = {}): Promise<void> {
  const stdout = partial.stdout ?? ((s: string) => void process.stdout.write(s));
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "add") return depsAdd(rest, stdout);
  if (sub === "remove") return depsRemove(rest, stdout);
  if (sub === "list") return depsList(rest, stdout, partial.autoPull ?? maybeAutoPull);
  if (sub === undefined || sub === "-h" || sub === "--help") {
    stdout(renderUsage(DEPS_USAGE));
    return;
  }
  throw new CliError("USAGE", `unknown deps subcommand: ${sub} (expected add|remove|list)`, {
    help: `${cliInvocation()} deps --help`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function dependenciesDoc(frontmatter: Frontmatter): OkfDocument {
  return { id: DEPENDENCIES_DOC_ID, frontmatter, body: "" };
}

/** The existing declaration map, refusing a document this command must not appropriate or flatten. */
function declaredMap(existing: OkfDocument | undefined): Record<string, unknown> {
  if (!existing) return {};
  const type = existing.frontmatter.type;
  if (typeof type !== "string" || type.trim() !== DEPENDENCIES_DOC_TYPE) {
    throw new CliError(
      "CONFLICT",
      `${DEPENDENCIES_DOC_ID} exists with type ${JSON.stringify(type ?? null)}; give it type '${DEPENDENCIES_DOC_TYPE}' or move it, then retry`,
      { help: `${cliInvocation()} doc read ${DEPENDENCIES_DOC_ID}`, details: { reason: "DEP_TYPE", type: type ?? null } },
    );
  }
  const declared = existing.frontmatter.dependencies;
  if (declared === undefined || declared === null) return {};
  if (!isRecord(declared)) {
    throw new CliError(
      "CONFLICT",
      `${DEPENDENCIES_DOC_ID}'s dependencies field is not a mapping of alias to entry; fix it by hand, then retry`,
      { help: `${cliInvocation()} doc read ${DEPENDENCIES_DOC_ID}`, details: { reason: "DEP_SHAPE" } },
    );
  }
  return declared;
}

function problemRows(problems: readonly DependencyProblem[]): Record<string, unknown>[] {
  return problems.map((p) => ({ code: p.code, alias: p.alias ?? null, detail: p.detail }));
}

function problemKey(p: DependencyProblem): string {
  return `${p.code}\u0000${p.alias ?? ""}\u0000${p.detail}`;
}

async function selfBundleId(bundle: Bundle, remoteUrl: string | undefined): Promise<string | undefined> {
  try {
    return declaredBundleId(await readDoc(bundle, BUNDLE_NAME_DOC_ID));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw classifyBundleError(err, remoteUrl);
  }
}

async function depsAdd(argv: string[], stdout: (s: string) => void): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "bundle-id": { type: "string" },
          source: { type: "string" },
          pin: { type: "string" },
          path: { type: "string" },
          replace: { type: "boolean" },
          "expected-version": { type: "string" },
          actor: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.depsAdd,
  );
  if (values.help) {
    stdout(renderUsage(DEPS_ADD_USAGE));
    return;
  }
  const alias = positionals[0]!.trim();
  const help = `${cliInvocation()} deps add --help`;
  if (values["bundle-id"] === undefined) {
    throw new CliError("USAGE", "deps add requires --bundle-id <id>", { help: `${cliInvocation()} deps add ${commandToken(alias)} --bundle-id <id>` });
  }

  // The entry exactly as the flags give it. Validated alone first, by the one parser, so an input
  // defect is a USAGE error before any bundle is opened.
  const given: Record<string, unknown> = { bundle_id: values["bundle-id"] };
  if (values.source !== undefined) given.source = values.source;
  if (values.pin !== undefined) given.pin = values.pin;
  if (values.path !== undefined) given.path = values.path;
  const alone = parseDependencies(dependenciesDoc({ type: DEPENDENCIES_DOC_TYPE, dependencies: { [alias]: given } }));
  const inputDefect = alone.problems.find((p) => DROPPING.has(p.code));
  if (inputDefect) {
    throw new CliError("USAGE", `cannot declare '${alias}': ${inputDefect.detail}`, {
      help,
      details: { reason: inputDefect.code, alias },
    });
  }

  const retry = `${cliInvocation()} deps add ${commandToken(alias)} --bundle-id ${commandToken(String(given.bundle_id))}`;
  const expectedVersion = expectedVersionFlag(values["expected-version"], `${retry} --expected-version <v>`);
  const actor = resolveActor(values.actor, { help: `${retry} --actor <name>` });
  const target = await openDeclarationTarget(values.dir, values.remote);
  const self = await selfBundleId(target.bundle, target.remoteUrl);

  let created = false;
  let replaced = false;
  let warnings: ValidationWarning[] = [];
  const result = await mutateDoc({
    bundle: target.bundle,
    id: DEPENDENCIES_DOC_ID,
    // A whole-document candidate: an entry's unknown keys may hold lists, which an ordinary
    // patch refuses to assign. The candidate below is the stored document with one entry changed.
    mode: "replace-document",
    onAbsent: "create",
    registry: await loadKinds(target.bundle),
    strict: false,
    helpOnKindReject: `${cliInvocation()} kinds`,
    remoteUrl: target.remoteUrl,
    actor,
    persistActor: true,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    onPersisted: declarationPersistHook(target, actor),
    buildCandidate: (existing) => {
      created = existing === undefined;
      replaced = false;
      warnings = [];
      const map = declaredMap(existing);
      const previous = Object.hasOwn(map, alias) ? map[alias] : undefined;
      const kept: Record<string, unknown> = {};
      if (isRecord(previous)) {
        for (const [key, value] of Object.entries(previous)) {
          if (!(ENTRY_FIELDS as readonly string[]).includes(key)) kept[key] = value;
        }
      }
      const entry = { ...given, ...kept };
      if (previous !== undefined && okfValuesEqual(previous, entry)) {
        return { frontmatter: existing!.frontmatter, body: existing!.body };
      }
      if (previous !== undefined && !values.replace) {
        throw new CliError(
          "CONFLICT",
          `'${alias}' is already declared with a different entry; pass --replace to replace it`,
          { help: `${retry} --replace`, details: { reason: "DEP_ALIAS_EXISTS", alias, current: previous } },
        );
      }
      replaced = previous !== undefined;
      const frontmatter: Frontmatter = existing
        ? { ...existing.frontmatter, dependencies: { ...map, [alias]: entry } }
        : { type: DEPENDENCIES_DOC_TYPE, title: "Dependencies", dependencies: { [alias]: entry } };

      // Judge the result by the same parser, against what the stored document already reported:
      // only a problem this write introduces is refused, so a pre-existing defect elsewhere in the
      // document never blocks an unrelated declaration.
      const options = self === undefined ? {} : { selfBundleId: self };
      const before = new Set(parseDependencies(existing ?? null, options).problems.map(problemKey));
      const introduced = parseDependencies(dependenciesDoc(frontmatter), options).problems.filter(
        (p) => !before.has(problemKey(p)) || p.alias === alias,
      );
      const refusal = introduced.find((p) => DROPPING.has(p.code));
      if (refusal) {
        throw new CliError("CONFLICT", `cannot declare '${alias}': ${refusal.detail}`, {
          help: `${cliInvocation()} deps list`,
          details: { reason: refusal.code, alias: refusal.alias ?? alias },
        });
      }
      warnings = introduced
        .filter((p) => p.alias === alias && !before.has(problemKey(p)))
        .map((p) => ({ code: p.code, message: p.detail, field: "dependencies", severity: "warning" as const }));
      return { frontmatter, body: existing?.body ?? "" };
    },
    errors: declarationErrorHooks(DEPENDENCIES_DOC_ID, { expectedVersion, retry: values.replace ? `${retry} --replace` : retry }),
  });

  const stored = parseDependencies(result.doc).dependencies.get(alias);
  const receipt: Record<string, unknown> = {
    dependency: !result.changed ? "unchanged" : replaced ? "replaced" : "added",
    alias,
    bundle_id: stored?.bundle_id ?? given.bundle_id,
    source: stored?.source ?? null,
    pin: stored?.pin?.value ?? null,
    path: stored?.path ?? null,
    doc: DEPENDENCIES_DOC_ID,
    created: result.changed && created,
    changed: result.changed,
    version: result.version,
  };
  const allWarnings = [...(result.changed ? warnings : []), ...result.warnings];
  if (allWarnings.length > 0) receipt.warnings = allWarnings;
  receipt.help = [`${cliInvocation()} status --with ${commandToken(alias)}=<path>`, `${cliInvocation()} link add <from> <id> --bundle ${commandToken(alias)}`];
  stdout(render(receipt, resolveMode(values)));
}

async function depsRemove(argv: string[], stdout: (s: string) => void): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "expected-version": { type: "string" },
          actor: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.depsRemove,
  );
  if (values.help) {
    stdout(renderUsage(DEPS_REMOVE_USAGE));
    return;
  }
  const alias = positionals[0]!.trim();
  if (alias === "") {
    throw new CliError("USAGE", "deps remove requires a non-empty <alias>", { help: `${cliInvocation()} deps list` });
  }
  const retry = `${cliInvocation()} deps remove ${commandToken(alias)}`;
  const expectedVersion = expectedVersionFlag(values["expected-version"], `${retry} --expected-version <v>`);
  const actor = resolveActor(values.actor, { help: `${retry} --actor <name>` });
  const target = await openDeclarationTarget(values.dir, values.remote);
  const mode = resolveMode(values);

  const absent = (): void => {
    stdout(render({ dependency: "absent", alias, doc: DEPENDENCIES_DOC_ID, removed: false, changed: false, help: [`${cliInvocation()} deps list`] }, mode));
  };
  let present = true;
  try {
    await readDoc(target.bundle, DEPENDENCIES_DOC_ID);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw classifyBundleError(err, target.remoteUrl);
    present = false;
  }
  if (!present && expectedVersion === undefined) {
    absent();
    return;
  }

  let removed = false;
  const result = await mutateDoc({
    bundle: target.bundle,
    id: DEPENDENCIES_DOC_ID,
    mode: "replace-document",
    onAbsent: "fail",
    registry: await loadKinds(target.bundle),
    strict: false,
    helpOnKindReject: `${cliInvocation()} kinds`,
    remoteUrl: target.remoteUrl,
    actor,
    persistActor: true,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    onPersisted: declarationPersistHook(target, actor),
    buildCandidate: (existing) => {
      const doc = existing!;
      const map = declaredMap(doc);
      removed = Object.hasOwn(map, alias);
      if (!removed) return { frontmatter: doc.frontmatter, body: doc.body };
      const { [alias]: _gone, ...remaining } = map;
      return { frontmatter: { ...doc.frontmatter, dependencies: remaining }, body: doc.body };
    },
    errors: {
      ...declarationErrorHooks(DEPENDENCIES_DOC_ID, { expectedVersion, retry }),
      // Absent under --expected-version: there is no version to match. Otherwise it was deleted
      // between the probe and the write, and a re-run reports the no-op.
      notFound: () =>
        new CliError(
          "STALE_HEAD",
          expectedVersion === undefined
            ? `${DEPENDENCIES_DOC_ID} was deleted while this command ran; re-run it`
            : `${DEPENDENCIES_DOC_ID} does not exist, so it is not at --expected-version ${commandToken(expectedVersion)}`,
          { help: retry, details: { expected: expectedVersion ?? null, actual: null } },
        ),
    },
  });

  if (!result.changed) {
    absent();
    return;
  }
  const receipt: Record<string, unknown> = {
    dependency: "removed",
    alias,
    doc: DEPENDENCIES_DOC_ID,
    removed,
    changed: true,
    version: result.version,
  };
  if (result.warnings.length > 0) receipt.warnings = result.warnings;
  receipt.help = [`${cliInvocation()} deps list`];
  stdout(render(receipt, mode));
}

async function depsList(argv: string[], stdout: (s: string) => void, autoPull: (dir?: string) => Promise<unknown>): Promise<void> {
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          limit: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.depsList,
  );
  if (values.help) {
    stdout(renderUsage(DEPS_LIST_USAGE));
    return;
  }
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    if (!/^\d+$/.test(values.limit.trim())) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = all)", { help: `${cliInvocation()} deps list --limit 0` });
    }
    limit = Number(values.limit.trim());
  }
  const target = await openDeclarationTarget(values.dir, values.remote);
  if (target.remoteUrl === undefined) await autoPull(values.dir);

  let doc: OkfDocument | null = null;
  try {
    doc = await readDoc(target.bundle, DEPENDENCIES_DOC_ID);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw classifyBundleError(err, target.remoteUrl);
  }
  const self = await selfBundleId(target.bundle, target.remoteUrl);
  const parsed = parseDependencies(doc, self === undefined ? {} : { selfBundleId: self });
  const rows = [...parsed.dependencies.values()].map((entry) => ({
    alias: entry.alias,
    bundle_id: entry.bundle_id,
    source: entry.source ?? null,
    pin: entry.pin?.value ?? null,
    path: entry.path ?? null,
  }));
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  const out: Record<string, unknown> = {
    doc: DEPENDENCIES_DOC_ID,
    exists: doc !== null,
    bundle_id: self ?? null,
    count: rows.length,
    shown: shown.length,
    dependencies: shown,
  };
  if (parsed.problems.length > 0) out.problems = problemRows(parsed.problems);
  const help: string[] = [];
  if (shown.length < rows.length) help.push(`${cliInvocation()} deps list --limit 0`);
  help.push(rows.length === 0 ? `${cliInvocation()} deps add <alias> --bundle-id <id>` : `${cliInvocation()} status --with-deps`);
  out.help = help;
  stdout(render(out, resolveMode(values)));
}
