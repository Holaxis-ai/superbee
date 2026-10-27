// `doc import`: copy chosen documents from a declared, explicitly bound bundle into this one.
//
// A thin adapter over core's document transfer (`planDocumentTransfer`, `applyDocumentTransfer`,
// `resumeDocumentTransfer`, and `planDocumentRefresh` / `applyDocumentRefresh` for --refresh): this module parses flags, binds the source copy the way
// `status --with` does, renders, and maps typed failures. Without `--apply` it is read-only and
// prints the plan with its token, the `kind draft` / `recipe evolve` convention: what applies is
// exactly what was shown. Local bundles and git boards only; `--remote` and hosted checkouts are
// refused before any read.
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  DEPENDENCIES_DOC_ID,
  DocumentNotFoundError,
  TransferConflictError,
  applyDocumentRefresh,
  applyDocumentTransfer,
  parseDependencies,
  planDocumentRefresh,
  planDocumentTransfer,
  readDoc,
  resumeDocumentTransfer,
  type Bundle,
  type RefreshPlan,
  type RefreshRequest,
  type TransferPlan,
  type TransferRequest,
  type TransferSelection,
} from "@superbee/core";
import { hostedCheckoutAt } from "../../autopull.js";
import { resolveBundleBindings } from "../../bundle-bindings.js";
import { assertResolvedLocalRouteIdentity, boardAttributionForRoute, resolveLocalBundleRoute } from "../../bundle.js";
import { boardPostPersistHook } from "../../board-attribution.js";
import { resolveActor } from "../../actor.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { commandFragment, commandToken, joinCommandTokens, type CommandText } from "../../command-text.js";
import { CliError, classifyBundleError } from "../../errors.js";
import { cliInvocation } from "../../invocation.js";
import { render, renderUsage, resolveMode } from "../../output.js";
import type { DocCliDeps } from "./common.js";

export const DOC_IMPORT_USAGE = `superbee doc import: copy documents from another bundle into this one, links rewritten

Usage:
  superbee doc import --from <alias> --with <alias>=<path|label> --select <kind>=<value>... [options]
  superbee doc import ... --apply <plan-token>
  superbee doc import --from <alias> --with <alias>=<path|label> --resume <record-id>
  superbee doc import --from <alias> --with <alias>=<path|label> --refresh <record-id> [--overwrite <id>]... [--skip <id>]...

Not 'superbee promote', which moves one local file's bytes into the store: import copies many
documents from a declared bundle with new ids, rewritten links, a sources entry on each, and one
Promotion record of the act.

Without --apply the command is read-only: it prints the plan (documents, link rewrites by kind,
untouched links with their reason, conflicts) and, when there are no conflicts, a plan token.
--apply <token> recomputes the plan from fresh reads and writes only if the token still matches.
Writes are create-only: an import never overwrites or deletes a document. A link to a selected
document becomes a relative link to its new id; a link to an unselected source document becomes
okf://<alias>/<id>.md. The Promotion record is written first with promotion_state applying and
becomes applied when every document is written; if a write fails, the record stays applying and
--resume <record-id> finishes it.

--refresh <record-id> updates the copies an applied Promotion record names from their sources, with
the same plan, --apply <token> and --resume flow. The record's source_version and target_version
per entry are the baseline: a copy whose source changed is updated; a copy edited in this bundle
since the record wrote it is a target_edited conflict and is never overwritten unless named with
--overwrite (discard the local edits) or --skip (leave it stale; it is reported again next time).
A source that is gone, or a copy that is gone while its source changed, is a conflict too: a
refresh never deletes, recreates or adds documents; import new source documents separately.
Each replaced copy is written only if it is still the version the plan saw. The record becomes
promotion_state refreshing while it writes, and --resume <record-id> finishes an interrupted refresh.

Caveats: resume writes the remaining documents even if this bundle has since dropped their Kind.
Reference-style definitions ([x]: ../f.md) are copied unchanged and listed as reference_definition.

The source alias must be declared in this bundle's docs/dependencies ('superbee deps add') and
the copy must declare the same bundle_id ('superbee bundle id set').

Options:
  --from <alias>          The declared alias of the source bundle                     [required]
  --with <alias>=<value>  Bind the source copy: a path, or a catalog label (repeatable)
  --with-deps             Bind each declared dependency path inside this git repository
  --select type=<T>       Every source document of type T (repeatable)
  --select prefix=<p>     Every source document under p/ (repeatable)
  --select id=<id>        One source document (repeatable)
  --prefix <p>            Write each document at <p>/<source id> (default: the same id)
  --allow-ungoverned      Accept a type the source governs and this bundle does not
  --record <id>           The Promotion record id (default: promotions/<alias>-<hash>)
  --apply <plan-token>    Write the plan this token was issued for
  --resume <record-id>    Finish an import or refresh whose record is still applying or
                          refreshing (takes only --from, --with, --with-deps and --actor)
  --refresh <record-id>   Update the copies this applied Promotion record names from their
                          sources (takes --from, --with, --with-deps, --overwrite, --skip,
                          --apply, --actor, --limit)
  --overwrite <id>        With --refresh: replace this copy even though it was edited here
                          (target or source id, repeatable)
  --skip <id>             With --refresh: leave this copy as it is (repeatable)
  --actor <a>             Attribution for every write (default: SUPERBEE_ACTOR)
  --limit <n>             Rows per table (default 50; 0 = all)
  --dir <path>            Bundle directory (default: discovered from the cwd)
  --json                  Emit compact JSON instead of TOON
  -h, --help              Show this help

Examples:
  superbee doc import --from wave --with wave=../wave --select type=Theme --prefix wave
  superbee doc import --from wave --with wave=../wave --select type=Theme --prefix wave --apply <plan-token>
  superbee doc import --from wave --with wave=../wave --refresh promotions/wave-0123456789ab
`;

const DEFAULT_LIMIT = 50;

interface Capped<T> {
  shown: number;
  total: number;
  rows: T[];
}

function cap<T>(rows: T[], limit: number): Capped<T> {
  const bounded = limit > 0 ? rows.slice(0, limit) : rows;
  return { shown: bounded.length, total: rows.length, rows: bounded };
}

function parseSelections(values: readonly string[]): TransferSelection {
  const ids: string[] = [];
  const types: string[] = [];
  const prefixes: string[] = [];
  for (const raw of values) {
    const eq = raw.indexOf("=");
    const key = eq < 0 ? "" : raw.slice(0, eq).trim();
    const value = eq < 0 ? "" : raw.slice(eq + 1).trim();
    if (value === "" || (key !== "type" && key !== "prefix" && key !== "id")) {
      throw new CliError("USAGE", `--select expects type=<T>, prefix=<p> or id=<id>, got '${raw}'`, {
        help: `${cliInvocation()} doc import --from <alias> --with <alias>=<path> --select type=<T>`,
      });
    }
    if (key === "type") types.push(value);
    else if (key === "prefix") prefixes.push(value);
    else ids.push(value);
  }
  return { ids, types, prefixes };
}

async function declaredDependencies(bundle: Bundle) {
  try {
    return parseDependencies(await readDoc(bundle, DEPENDENCIES_DOC_ID));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw classifyBundleError(error);
    return parseDependencies(null);
  }
}

export async function docImport(argv: string[], deps: Partial<DocCliDeps> & { home?: string }): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          from: { type: "string" },
          with: { type: "string", multiple: true },
          "with-deps": { type: "boolean" },
          select: { type: "string", multiple: true },
          prefix: { type: "string" },
          "allow-ungoverned": { type: "boolean" },
          record: { type: "string" },
          apply: { type: "string" },
          resume: { type: "string" },
          refresh: { type: "string" },
          overwrite: { type: "string", multiple: true },
          skip: { type: "string", multiple: true },
          actor: { type: "string" },
          limit: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.docImport,
  );
  if (values.help) {
    stdout(renderUsage(DOC_IMPORT_USAGE));
    return;
  }
  const inv = cliInvocation();
  if (values.remote !== undefined) {
    throw new CliError("USAGE", "doc import writes local bundles and git boards only; --remote is not supported", {
      help: `${inv} doc import --help`,
    });
  }
  const alias = values.from?.trim();
  if (!alias) {
    throw new CliError("USAGE", "doc import requires --from <alias>, the declared alias of the source bundle", {
      help: `${inv} doc import --from <alias> --with <alias>=<path> --select type=<T>`,
    });
  }
  if (values.apply !== undefined && values.resume !== undefined) {
    throw new CliError("USAGE", "--apply and --resume are mutually exclusive", { help: `${inv} doc import --help` });
  }
  if (values.refresh !== undefined && values.resume !== undefined) {
    throw new CliError("USAGE", "--refresh and --resume are mutually exclusive; --resume finishes an interrupted refresh", { help: `${inv} doc import --help` });
  }
  const refresh = values.refresh?.trim();
  if (values.refresh !== undefined && !refresh) throw new CliError("USAGE", "--refresh was given an empty record id");
  if (refresh !== undefined) {
    const extra = (["select", "prefix", "allow-ungoverned", "record"] as const).filter((flag) => values[flag] !== undefined);
    if (extra.length > 0) {
      throw new CliError("USAGE", `--refresh takes the record's own selection and target; remove: ${extra.join(", ")}`, {
        help: `${inv} doc import --from ${commandToken(alias)} --with ${commandToken(`${alias}=<path>`)} --refresh ${commandToken(refresh)}`,
      });
    }
  } else if (values.overwrite !== undefined || values.skip !== undefined) {
    throw new CliError("USAGE", "--overwrite and --skip apply only with --refresh <record-id>", { help: `${inv} doc import --help` });
  }
  const resume = values.resume?.trim();
  if (values.resume !== undefined && !resume) throw new CliError("USAGE", "--resume was given an empty record id");
  if (resume !== undefined) {
    const extra = (["select", "prefix", "allow-ungoverned", "record", "limit", "overwrite", "skip"] as const).filter((flag) => values[flag] !== undefined);
    if (extra.length > 0) {
      throw new CliError("USAGE", `--resume takes only --from, --with, --with-deps and --actor; remove: ${extra.join(", ")}`, {
        help: `${inv} doc import --from ${commandToken(alias)} --with ${commandToken(`${alias}=<path>`)} --resume ${commandToken(resume)}`,
      });
    }
  }
  if (values.apply !== undefined && values.apply.trim() === "") throw new CliError("USAGE", "--apply was given an empty plan token");
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    if (!/^\d+$/.test(values.limit.trim())) throw new CliError("USAGE", "--limit must be a non-negative integer (0 = all)");
    limit = Number(values.limit.trim());
  }
  const select = parseSelections(values.select ?? []);
  const actor = resolveActor(values.actor, { help: `${inv} doc import --from ${commandToken(alias)} --actor <name>` });

  const route = await resolveLocalBundleRoute(values.dir);
  await assertResolvedLocalRouteIdentity(route);
  const bundle = route.bundle;
  const home = deps.home ?? homedir();
  if (await hostedCheckoutAt(bundle.root, home).catch(() => null)) {
    throw new CliError("USAGE", "doc import writes local bundles and git boards only; this folder is a hosted checkout", {
      help: `${inv} doc import --help`,
    });
  }

  const declared = await declaredDependencies(bundle);
  if (!declared.dependencies.has(alias)) {
    throw new CliError("USAGE", `alias '${alias}' is not declared in docs/dependencies`, {
      help: `${inv} deps add ${commandToken(alias)} --bundle-id <bundle-id>`,
    });
  }
  const resolved = await resolveBundleBindings({
    referringRoot: bundle.root,
    dependencies: declared.dependencies,
    withValues: values.with ?? [],
    withDeps: values["with-deps"] === true,
    home,
  });
  const binding = resolved.bindings.get(alias);
  if (!binding) {
    const problem = resolved.problems.find((p) => p.alias === alias);
    throw new CliError("USAGE", `no copy of '${alias}' is bound${problem ? `: ${problem.detail}` : ""}; name it with --with`, {
      help: `${inv} doc import --from ${commandToken(alias)} --with ${commandToken(`${alias}=<path>`)}`,
    });
  }
  const withValue = (values.with ?? []).find((raw) => raw.slice(0, raw.indexOf("=")).trim() === alias);
  const label = withValue !== undefined ? withValue.slice(withValue.indexOf("=") + 1).trim() : declared.dependencies.get(alias)!.path ?? binding.label;

  // Every emitted command repeats the binding, selection and target so it runs as shown.
  const common: CommandText[] = [commandFragment`--from ${commandToken(alias)}`];
  for (const raw of values.with ?? []) common.push(commandFragment`--with ${commandToken(raw.trim())}`);
  if (values["with-deps"]) common.push(commandFragment`--with-deps`);
  if (values.actor !== undefined) common.push(commandFragment`--actor ${commandToken(values.actor.trim())}`);
  const selection: CommandText[] = [];
  for (const raw of values.select ?? []) selection.push(commandFragment`--select ${commandToken(raw.trim())}`);
  if (values.prefix !== undefined) selection.push(commandFragment`--prefix ${commandToken(values.prefix.trim())}`);
  if (values["allow-ungoverned"]) selection.push(commandFragment`--allow-ungoverned`);
  if (values.record !== undefined) selection.push(commandFragment`--record ${commandToken(values.record.trim())}`);
  if (refresh !== undefined) selection.push(commandFragment`--refresh ${commandToken(refresh)}`);
  for (const raw of values.overwrite ?? []) selection.push(commandFragment`--overwrite ${commandToken(raw.trim())}`);
  for (const raw of values.skip ?? []) selection.push(commandFragment`--skip ${commandToken(raw.trim())}`);
  const dirSuffix: CommandText[] = values.dir === undefined ? [] : [commandFragment`--dir ${commandToken(values.dir)}`];
  const importCommand = (...tail: CommandText[]): string =>
    `${inv} doc import ${joinCommandTokens([...common, ...selection, ...dirSuffix, ...tail])}`;
  const resumeCommand = (recordId: string): string =>
    `${inv} doc import ${joinCommandTokens([...common, ...dirSuffix, commandFragment`--resume ${commandToken(recordId)}`])}`;
  const refreshCommand = (recordId: string): string =>
    `${inv} doc import ${joinCommandTokens([...common, ...dirSuffix, commandFragment`--refresh ${commandToken(recordId)}`])}`;
  const statusCommand = `${inv} status ${joinCommandTokens([...(values.with ?? []).map((raw) => commandFragment`--with ${commandToken(raw.trim())}`), ...(values["with-deps"] ? [commandFragment`--with-deps`] : []), ...dirSuffix])}`.trimEnd();

  const from = { alias, binding, label };
  const persisted = boardPostPersistHook(boardAttributionForRoute(route), actor);
  const fail = (error: unknown, recordId?: string): never => {
    if (error instanceof DocumentNotFoundError) {
      throw new CliError("NOT_FOUND", `no Promotion record at '${error.id}'`, { help: `${inv} list --type Promotion` });
    }
    const classified = classifyBundleError(error);
    const resumable = classified.details?.record_state === "applying" || classified.details?.record_state === "refreshing" || classified.code === "TRANSFER_RESUME_CONFLICT"
      || (error instanceof TransferConflictError && error.conflicts.some((c) => c.code === "record_exists"));
    const help = resumable && recordId !== undefined
      ? resumeCommand(String(classified.details?.record ?? recordId))
      : classified.code === "TRANSFER_PLAN_CHANGED" || classified.code === "TRANSFER_CONFLICT"
        ? importCommand()
        : classified.help;
    throw new CliError(classified.code, classified.message, {
      ...(classified.details ? { details: classified.details } : {}),
      ...(help ? { help } : {}),
    });
  };

  if (resume !== undefined) {
    const result = await resumeDocumentTransfer(bundle, resume, from, actor === undefined ? {} : { actor }).catch((e: unknown) => fail(e, resume));
    if (result.changed) await persisted?.();
    stdout(render({
      import: "resumed",
      changed: result.changed,
      from: { alias, bundle_id: binding.identity ?? "", label },
      documents: result.written.length,
      written: cap(result.written.map((w) => ({ source: w.source, target: w.target, version: w.version })), limit),
      ...(result.left ? { left: cap(result.left, limit) } : {}),
      record: { id: result.record.id, state: result.record.state, version: result.record.version },
      help: [
        ...(result.left ? [`${refreshCommand(result.record.id)}   # plan again: ${result.left.length} cop${result.left.length === 1 ? "y was" : "ies were"} left as they are`] : []),
        statusCommand,
        `${inv} doc read ${commandToken(result.record.id)}`,
      ],
    }, resolveMode(values)));
    return;
  }

  if (refresh !== undefined) {
    const refreshRequest: RefreshRequest = {
      target: bundle,
      recordId: refresh,
      from,
      overwrite: (values.overwrite ?? []).map((v) => v.trim()),
      skip: (values.skip ?? []).map((v) => v.trim()),
      ...(actor !== undefined ? { actor } : {}),
    };
    // A record refused at plan time is not resumable by implication, so no record id for help.
    const plan = await planDocumentRefresh(refreshRequest).catch((e: unknown) => fail(e));
    if (values.apply === undefined) {
      stdout(render(refreshPlanRecord(plan, limit, importCommand, `${inv} doc read ${commandToken(plan.record.id)}`, resumeCommand(plan.record.id), importCommand(commandFragment`--limit 0`)), resolveMode(values)));
      return;
    }
    const result = await applyDocumentRefresh(refreshRequest, values.apply).catch((e: unknown) => fail(e, refresh));
    if (result.changed) await persisted?.();
    stdout(render({
      import: "refreshed",
      changed: result.changed,
      from: fromRecord(plan),
      documents: result.written.length,
      written: cap(result.written.map((w) => ({ source: w.source, target: w.target, version: w.version })), limit),
      record: { id: result.record.id, state: result.record.state, version: result.record.version },
      help: [statusCommand, `${inv} doc read ${commandToken(result.record.id)}`],
    }, resolveMode(values)));
    return;
  }

  const request: TransferRequest = {
    target: bundle,
    from,
    select,
    ...(values.prefix !== undefined ? { prefix: values.prefix } : {}),
    ...(values["allow-ungoverned"] ? { allowUngoverned: true } : {}),
    ...(values.record !== undefined ? { recordId: values.record } : {}),
    ...(actor !== undefined ? { actor } : {}),
  };
  const plan = await planDocumentTransfer(request).catch((e: unknown) => fail(e));
  if (values.apply === undefined) {
    stdout(render(planRecord(plan, limit, importCommand, refreshCommand, importCommand(commandFragment`--limit 0`)), resolveMode(values)));
    return;
  }
  const result = await applyDocumentTransfer(request, values.apply).catch((e: unknown) => fail(e, plan.record.id));
  if (result.changed) await persisted?.();
  stdout(render({
    import: "applied",
    changed: result.changed,
    from: fromRecord(plan),
    documents: result.written.length,
    links: linksRecord(plan),
    written: cap(result.written.map((w) => ({ source: w.source, target: w.target, version: w.version })), limit),
    record: { id: result.record.id, state: result.record.state, version: result.record.version },
    help: [statusCommand, `${inv} doc read ${commandToken(result.record.id)}`],
  }, resolveMode(values)));
}

function fromRecord(plan: Pick<TransferPlan, "from"> | Pick<RefreshPlan, "from">): Record<string, unknown> {
  const out: Record<string, unknown> = { alias: plan.from.alias, bundle_id: plan.from.bundle_id, label: plan.from.label };
  if (plan.from.pin) out.pin = plan.from.pin.value;
  return out;
}

function linksRecord(plan: TransferPlan): Record<string, number> {
  const { local, qualified, dequalified, unchanged, dangling_in_source } = plan.counts;
  return { local, qualified, dequalified, unchanged, dangling_in_source };
}

function planRecord(
  plan: TransferPlan,
  limit: number,
  importCommand: (...tail: CommandText[]) => string,
  refreshCommand: (recordId: string) => string,
  allRows: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    import: "plan",
    from: fromRecord(plan),
    documents: plan.counts.documents,
    links: linksRecord(plan),
    left_behind: plan.left_behind,
  };
  if (plan.conflicts.length > 0) {
    out.conflicts = cap(plan.conflicts.map((c) => ({ code: c.code, source: c.source ?? "", target: c.target ?? "", detail: c.detail })), limit);
  }
  const entries = cap(plan.entries.map((e) => ({
    source: e.source,
    target: e.target,
    type: e.type,
    local: e.rewrite_counts.local + e.rewrite_counts.dequalified,
    qualified: e.rewrite_counts.qualified,
    unchanged: e.rewrite_counts.unchanged,
    warnings: e.validation_warnings.length,
  })), limit);
  out.entries = entries;
  const untouched = plan.entries.flatMap((e) => e.rewrites
    .filter((r) => r.kind === "unchanged")
    .map((r) => ({ source: e.source, href: r.from_href, reason: r.reason ?? "" })));
  if (untouched.length > 0) out.untouched_links = cap(untouched, limit);
  out.record = { id: plan.record.id, state: "planned" };
  out.ready = plan.ready;
  const help: string[] = [];
  if (plan.ready) {
    out.plan_token = plan.plan_token;
    help.push(`${importCommand(commandFragment`--apply ${commandToken(plan.plan_token!)}`)}   # writes ${plan.counts.documents} documents and the record`);
  } else {
    help.push(`fix the first conflict (${plan.conflicts[0]!.code}: ${plan.conflicts[0]!.detail}), then plan again: ${importCommand()}`);
    const promoted = plan.conflicts.find((c) => c.record !== undefined);
    if (promoted) help.push(`${refreshCommand(promoted.record!)}   # update the copies '${promoted.record}' promoted instead`);
  }
  const truncated = [entries.total > entries.shown, untouched.length > limit && limit > 0, plan.conflicts.length > limit && limit > 0].some(Boolean);
  if (truncated && allRows !== undefined) help.push(`${allRows}   # every row`);
  out.help = help;
  return out;
}

function refreshPlanRecord(
  plan: RefreshPlan,
  limit: number,
  importCommand: (...tail: CommandText[]) => string,
  readRecord: string,
  resume: string,
  allRows: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    import: "refresh_plan",
    from: fromRecord(plan),
    record: { id: plan.record.id, state: plan.record.state },
    counts: plan.counts,
  };
  if (plan.conflicts.length > 0) {
    out.conflicts = cap(plan.conflicts.map((c) => ({ code: c.code, source: c.source ?? "", target: c.target ?? "", detail: c.detail })), limit);
  }
  const entries = cap(plan.entries.map((e) => ({
    source: e.source,
    target: e.target,
    action: e.action,
    edited: e.edited,
    dropped_links: e.dropped_links,
    detail: e.detail ?? "",
  })), limit);
  out.entries = entries;
  out.ready = plan.ready;
  const help: string[] = [];
  const writes = plan.counts.update + plan.counts.overwrite;
  if (plan.plan_token !== undefined) {
    out.plan_token = plan.plan_token;
    help.push(`${importCommand(commandFragment`--apply ${commandToken(plan.plan_token)}`)}   # replaces ${writes} cop${writes === 1 ? "y" : "ies"} and updates the record`);
  } else if (plan.ready) {
    out.up_to_date = true;
    help.push(`${readRecord}   # nothing to refresh: every copy matches its source`);
  } else if (plan.record.state !== "applied") {
    help.push(`${resume}   # '${plan.record.id}' is ${plan.record.state}; finish it, then plan the refresh again`);
  } else {
    const first = plan.conflicts[0]!;
    const how = first.code === "target_edited" && first.target !== undefined
      ? `: add --overwrite ${commandToken(first.target)} to discard the local edits or --skip ${commandToken(first.target)} to keep them`
      : "";
    help.push(`fix the first conflict (${first.code}: ${first.detail})${how}, then plan again: ${importCommand()}`);
  }
  const truncated = [entries.total > entries.shown, plan.conflicts.length > limit && limit > 0].some(Boolean);
  if (truncated && allRows !== undefined) help.push(`${allRows}   # every row`);
  out.help = help;
  return out;
}
