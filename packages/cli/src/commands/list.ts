// `superbee list` / `superbee query` — query concepts over their frontmatter.
//
// Thin wrapper over core `queryHeads(bundle, { type?, tags?, prefix?, fields? })` (the filter facets
// are ANDed; reserved index.md/log.md are always excluded) — HEAD projections (id + frontmatter +
// version), never bodies: every row here reads only frontmatter, and over `--remote` the backend
// push-down keeps bodies off the wire entirely. Results default to a UNIFORM, flat row shape
// ({ id, type, title, timestamp }) so TOON renders them as a compact scannable table; the full
// frontmatter + body of any row is available via `superbee doc read <id>`.
//
// Two generic kind capabilities (no per-kind code):
//
//   - Kind-aware columns (Fork A): a `--type <X>`-scoped query, with NO `--fields` override, where a
//     loaded kind convention governs `X`, projects `{id, title, ...kind's declared fields}` instead of
//     the minimal schema — so an agent sees e.g. a Task's status/priority without knowing to pass
//     --fields. Activation requires ALL of: --type given, --fields absent, the type is governed, and
//     the kind declares at least one non-excluded field. An unscoped list, or a type-scoped list of an
//     UNGOVERNED type, keeps the minimal schema byte-for-byte. The registry is otherwise loaded only
//     for `--open` or the version-aware logical `progress_status` field, so ordinary unscoped/explicit
//     projections retain the lean path. `--fields` ALWAYS overrides (an explicit projection wins).
//   - `--field key=value` filter (Fork B, repeatable, ANDed): a generic core QueryFilter facet (any
//     kind, any field), not CLI-side — so it rides the engine's one filter locus over --remote for
//     free, same as the existing type/tags facets (applied to pushed-down heads, never bodies).
//
// Field-query semantics:
//
//   - Set membership on `--field`: a COMMA in the value is OR-within-that-field (`progress_status=todo,
//     in_progress`), AND unchanged across different `--field` flags/keys. A single-member value (no
//     comma) still rides core's `QueryFilter.fields` push-down byte-identically; a multi-member value
//     is READER-SIDE post-filtering over the (possibly still push-down-narrowed) result, reusing
//     core's own `matchesFilter` predicate per candidate member rather than a second coercion
//     implementation — no engine/wire change for the OR semantics.
//   - `--open`: exclude docs whose OWN declared kind marks their current field value(s) terminal
//     (`isTerminal`, `@superbee/core`'s kinds.ts). Purely declaration-driven and reader-side;
//     an ungoverned type, a kind with no terminal declaration, or a doc missing the field are all
//     INCLUDED (not-terminal is the semantic, never a hardcoded status string).
import { parseArgs } from "node:util";
import {
  PROGRESS_STATUS_FIELD,
  queryHeads,
  loadKinds,
  isTerminal,
  matchesFilter,
  readBundleOkfVersion,
  readKindField,
  progressStatusCoordinate,
  projectKindForAuthoring,
  type KindRegistry,
  type QueryFilter,
} from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { maybeAutoPull } from "../autopull.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { compareByMeaningfulChange, meaningfulChangeOrderKey } from "../meaningful-change-order.js";
import { commandToken } from "../command-text.js";

export const LIST_USAGE = `superbee list — query concepts over their frontmatter (alias: query)

Usage:
  superbee list [--type <t>] [--tag <t>] [--field <k=v>] [--prefix <p>] [--fields <a,b>] [--open] [--limit <n>] [--dir <path>]

Options:
  --type <t>           Restrict to concepts whose frontmatter type equals this
  --tag <t>            Restrict to concepts carrying this tag (repeatable; ALL must match)
  --field <k=v>        Restrict to concepts whose frontmatter field k equals v (repeatable; ALL
                       flags/fields are ANDed). A COMMA in v is SET MEMBERSHIP (OR): --field
                       progress_status=todo,in_progress matches EITHER value on that one field. Array fields
                       still match on membership; values are string-coerced (so an unquoted YAML
                       number like priority: 1 matches --field priority=1). Comma is therefore the
                       set separator — a literal comma inside one value can no longer be expressed
                       via --field (ids/enum values don't carry commas in practice); an empty member
                       (--field progress_status=todo,,done) is a USAGE error.
  --prefix <p>         Restrict to concept ids starting with this bundle-relative prefix
  --fields <a,b,...>   Add extra frontmatter fields to each row (comma-separated; default schema is
                       id,type,title,timestamp). ALWAYS overrides kind-aware columns below. Each cell
                       is truncated to 80 chars — long content lives in \`doc read <id>\`.
  --open               Exclude concepts whose OWN kind declares a terminal set of field values
                       (see 'kinds --help') and whose frontmatter currently matches it (e.g. a Task
                       whose progress_status is 'done'/'canceled', if the Task kind declares that terminal
                       set). Purely declaration-driven: an ungoverned type, a governed type with no
                       terminal declaration, or a doc missing the field are all INCLUDED. On a
                       bundle where NO kind declares a terminal set, --open filters nothing (a help
                       line says so, so the flag is never silently meaningless). Composes with
                       --type/--field/--prefix.
  --limit <n>          Cap the newest-first rows returned (default: 100; 0 = unlimited). A truncated
                       result reports \`shown\` alongside the total \`count\`.
  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Talk to a wire-protocol server instead of a local bundle
  --bundle <bundle_id> Select the exact hosted bundle (requires --remote)
                       (mutually exclusive with --dir; remote access is always explicit)
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help

A --type-scoped query of a kind-governed type projects that kind's declared fields as columns
({id, title, ...fields}) instead of the minimal schema; --fields overrides. An unscoped query, or a
query of an ungoverned type, always keeps the minimal {id,type,title,timestamp} schema.
Results are ordered by each document's meaningful change time, newest first (v0.2 \`generated.at\`
when present, otherwise \`timestamp\`); invalid or missing times sort last, with canonical ID ties.
Use the logical field name progress_status when querying workflow state. Superbee resolves the
bundle's compatible storage coordinate through each document's declared Kind.
`;

export interface ListCliDeps {
  stdout: (s: string) => void;
  /** The opportunistic board-freshness trigger (default {@link maybeAutoPull} — autopull.ts). */
  autoPull: (dir?: string) => Promise<unknown>;
}

const LIST_OPTIONS = {
  type: { type: "string" },
  tag: { type: "string", multiple: true },
  field: { type: "string", multiple: true },
  prefix: { type: "string" },
  fields: { type: "string" },
  open: { type: "boolean" },
  limit: { type: "string" },
  dir: { type: "string" },
          remote: { type: "string" },
          bundle: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export async function list(argv: string[], deps: Partial<ListCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: LIST_OPTIONS,
        allowPositionals: true,
      }),
    CLI_LEAVES.list,
    { optionNames: Object.keys(LIST_OPTIONS) },
  );
  if (values.help) {
    stdout(LIST_USAGE);
    return;
  }

  const filter: QueryFilter = {};
  if (values.type?.trim()) filter.type = values.type.trim();
  if (values.tag && values.tag.length > 0) filter.tags = values.tag;
  if (values.prefix?.trim()) filter.prefix = values.prefix.trim();

  // Fork B: --field key=value (repeatable, ANDed across different keys). Split on the FIRST "="
  // (a deliberate value containing "=" survives); an empty key, or a token with no "=" at all, is
  // USAGE (exit 2). A comma in the value is the set-membership
  // separator (OR within that one field) — the value is split on "," into members (each taken
  // verbatim, not trimmed, same as before a comma existed, so a deliberately spaced member
  // survives untouched); an EMPTY member (--field progress_status=todo,,done, or a leading/trailing comma)
  // is USAGE, since it can never match anything and is almost certainly a typo. A single-member
  // value (no comma) is unchanged from before and rides core's `QueryFilter.fields` push-down
  // byte-identically; a multi-member value is collected into `orFieldSets` and post-filtered
  // below (reader-side — no engine/wire change). A repeated `--field` for the SAME key keeps
  // last-one-wins (matching the pre-existing single-value behavior), whichever variant it lands as.
  const singleFields: Record<string, string> = {};
  const orFieldSets: Record<string, string[]> = {};
  let progressFieldSet: string[] | undefined;
  if (values.field && values.field.length > 0) {
    for (const entry of values.field) {
      const eq = entry.indexOf("=");
      const key = eq >= 0 ? entry.slice(0, eq).trim() : "";
      if (eq < 0 || key === "") {
        throw new CliError("USAGE", `--field expects key=value (got '${entry}')`, {
          help: `${cliInvocation()} list --field progress_status=done`,
        });
      }
      const rawValue = entry.slice(eq + 1);
      const members = rawValue.split(",");
      if (members.some((m) => m === "")) {
        // Two distinct typos share the "empty member" shape but deserve different wording: a
        // BARE value (no comma at all, e.g. `--field status=`) is an empty value, not a
        // set-membership mistake — tailor the message so it doesn't talk about commas the user
        // never typed. Both stay a loud USAGE (exit 2): a silent count:0 on either typo would be
        // a false negative for an agent scanning for a real match.
        if (!rawValue.includes(",")) {
          throw new CliError(
            "USAGE",
            `--field ${commandToken(key)} has an empty value — expected --field ${commandToken(key)}=<value>, or comma-separated set membership --field ${commandToken(key)}=a,b`,
            { help: `${cliInvocation()} list --field progress_status=done` },
          );
        }
        throw new CliError(
          "USAGE",
          `--field ${commandToken(key)} has an empty member in '${rawValue}' (comma is the set-membership separator — use 'a,b', not 'a,,b' or a leading/trailing comma)`,
          { help: `${cliInvocation()} list --field progress_status=todo,in_progress` },
        );
      }
      if (key === PROGRESS_STATUS_FIELD) {
        progressFieldSet = members;
        delete singleFields[key];
        delete orFieldSets[key];
      } else if (members.length > 1) {
        orFieldSets[key] = members;
        delete singleFields[key];
      } else {
        singleFields[key] = rawValue;
        delete orFieldSets[key];
      }
    }
    if (Object.keys(singleFields).length > 0) filter.fields = singleFields;
  }

  // Row cap (AXI §9 "reveal truncated lists"): `list` is THE query verb and the one most likely to
  // hit large N, so it bounds its rows by default like `status` does its finding categories. Default
  // 100 (high enough that a typical bundle is never truncated — §2 "cover common cases in one call");
  // 0 = unlimited. `count` always reports the TOTAL matched; a truncated result additionally carries
  // `shown` + a `--limit 0` hint so the bound is never silent.
  const DEFAULT_LIMIT = 100;
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)", {
        help: `${cliInvocation()} list --limit 100`,
      });
    }
    limit = Number(raw);
  }

  // Extra frontmatter fields to append after the default schema (AXI §2 `--fields` hatch). The four
  // default keys are always present, so a requested duplicate is skipped and every row stays uniform.
  const DEFAULT_KEYS = new Set(["id", "type", "title", "timestamp"]);
  const extraFields = (values.fields?.trim() ? values.fields.split(",") : [])
    .map((f) => f.trim())
    .filter((f) => f && !DEFAULT_KEYS.has(f));

  const remote = await resolveRemoteFlag(values.remote, values.dir, values.bundle);
  // Opportunistic board freshness (autopull.ts): a LOCAL read of a provisioned board checkout
  // whose awareness cache has gone stale runs the time-boxed ff-only pull FIRST, so this very
  // read serves fresh state. Silent, fail-soft, detection-gated (never provisions), and skipped
  // entirely for a --remote read (the board is a git-tier local concept).
  if (!remote) await (deps.autoPull ?? maybeAutoPull)(values.dir);
  const bundle = await openBundle(values.dir, remote);
  // A corrupt document (unparseable YAML frontmatter) is skipped and reported, never allowed to
  // fail the whole scan — one bad file must not blind the agent to every other doc (AXI §5/§6).
  // Head projections, not full docs: every row below reads only id + frontmatter, and over
  // `--remote` the push-down means bodies never cross the wire (frontmatter-projection pass).
  const skipped: { id: string; reason: string }[] = [];
  let docs = await queryHeads(bundle, filter, { onSkip: (s) => skipped.push(s) });

  // Registry cache: loaded AT MOST once per invocation, on demand — the OR-field post-filter below
  // never needs it (matchesFilter is registry-free), only --open and the two kind-column forks do.
  let registryCache: KindRegistry | undefined;
  const getRegistry = async (): Promise<KindRegistry> => {
    registryCache ??= await loadKinds(bundle);
    return registryCache;
  };
  let okfVersionLoaded = false;
  let okfVersionCache: string | undefined;
  const getOkfVersion = async (): Promise<string | undefined> => {
    if (!okfVersionLoaded) {
      okfVersionCache = await readBundleOkfVersion(bundle);
      okfVersionLoaded = true;
    }
    return okfVersionCache;
  };

  // OR-within-field post-filter for every multi-member --field (comma
  // sets). AND across fields (a doc must satisfy EVERY field's set), each field itself OR'd across
  // its declared members. Reuses core's OWN exact-match predicate (`matchesFilter`) per candidate
  // member instead of a second value-coercion implementation — reader-side only, no engine/wire
  // change (the single-member case above already rode the real push-down).
  for (const [field, members] of Object.entries(orFieldSets)) {
    docs = docs.filter((d) => members.some((m) => matchesFilter(d, { fields: { [field]: m } })));
  }
  if (progressFieldSet) {
    const registry = await getRegistry();
    const okfVersion = await getOkfVersion();
    docs = docs.filter((doc) => {
      const kind = registry.kinds.get(String(doc.frontmatter.type ?? ""));
      if (!kind) return false;
      const raw = readKindField(okfVersion, kind, doc.frontmatter, PROGRESS_STATUS_FIELD);
      const actual = raw === undefined || raw === null
        ? []
        : (Array.isArray(raw) ? raw : [raw]).map((value) => String(value));
      return progressFieldSet!.some((value) => actual.includes(value));
    });
  }

  // --open excludes a doc whose own kind declares a terminal
  // set (`kind.fields.terminal`) that its current frontmatter matches (`isTerminal`) — purely
  // declaration-driven: an ungoverned type, a governed type with no terminal declaration, or a doc
  // missing the field are all kept (not-terminal is the safe default). A bundle where NO kind
  // declares ANY terminal set makes --open a structural no-op; that's reported via a help line
  // below rather than silently doing nothing.
  let openNoopReason: string | undefined;
  if (values.open) {
    const registry = await getRegistry();
    const anyTerminalDeclared = [...registry.kinds.values()].some(
      (k) => Object.keys(k.fields.terminal).length > 0,
    );
    if (!anyTerminalDeclared) {
      openNoopReason = "no kind declares terminal values — --open filtered nothing";
    } else {
      docs = docs.filter((d) => {
        const kind = registry.kinds.get(typeof d.frontmatter.type === "string" ? d.frontmatter.type : "");
        if (!kind) return true;
        return !isTerminal(kind, d.frontmatter);
      });
    }
  }

  // Core owns the storage-facing canonical-ID ordering. The CLI presents a different, orientation
  // facing order only after every CLI filter has settled: newest meaningful change first, then
  // canonical ID. Invalid or missing clocks remain visible at the end rather than being dropped.
  const recency = docs.map((doc) => ({ doc, key: meaningfulChangeOrderKey(doc.id, doc.frontmatter) }));
  recency.sort((a, b) => compareByMeaningfulChange(a.key, b.key));
  docs = recency.map(({ doc }) => doc);
  const meaningfulTimestampById = new Map(recency.map(({ key }) => [key.id, key.timestamp]));

  // Cap a projected cell so one long field can't dominate a row (AXI §2/§3 — long-form content
  // belongs in `doc read`, not a list cell). SHARED by the `--fields` projection and the kind-aware
  // columns below, so both truncate identically.
  const COLUMN_CELL_CAP = 80;
  const cell = (v: unknown): unknown => {
    if (v === undefined || v === null) return "";
    const s = Array.isArray(v) ? v.join(",") : v;
    return typeof s === "string" && s.length > COLUMN_CELL_CAP ? s.slice(0, COLUMN_CELL_CAP) + "…" : s;
  };

  const logicalProjectionRequested = extraFields.includes(PROGRESS_STATUS_FIELD);
  const projectionRegistry = logicalProjectionRequested ? await getRegistry() : undefined;
  const projectionVersion = logicalProjectionRequested ? await getOkfVersion() : undefined;

  const projectMinimal = (d: (typeof docs)[number]): Record<string, unknown> => {
    const row: Record<string, unknown> = {
      id: d.id,
      type: typeof d.frontmatter.type === "string" ? d.frontmatter.type : "",
      title:
        typeof d.frontmatter.title === "string"
          ? d.frontmatter.title
          : (d.id.split("/").pop() ?? d.id),
      timestamp: meaningfulTimestampById.get(d.id) ?? "",
    };
    // The `--fields` hatch caps each cell the SAME way kind columns do — a long field (e.g.
    // `--fields description`) is truncated per row rather than dumped in full.
    for (const f of extraFields) {
      if (f === PROGRESS_STATUS_FIELD && projectionRegistry) {
        const kind = projectionRegistry.kinds.get(String(d.frontmatter.type ?? ""));
        row[f] = cell(kind ? readKindField(projectionVersion, kind, d.frontmatter, f) : undefined);
      } else {
        row[f] = cell((d.frontmatter as Record<string, unknown>)[f]);
      }
    }
    return row;
  };

  // Fork A: kind-aware columns. Activation requires ALL of: --type given (a single-kind result — the
  // hard TOON constraint, since docs[N]{cols} is a UNIFORM table so per-row kind-specific columns are
  // only sound when every row shares one kind), --fields ABSENT (an explicit projection always wins),
  // the loaded registry governs --type, and that kind declares at least one non-excluded field. Loading
  // the registry is gated behind the first two conditions so an unscoped/--fields query — and every
  // conventions-free bundle — does zero extra registry work.
  //
  // "--fields ABSENT" means the FLAG was not given at all — NOT "extraFields ended up empty". A
  // caller passing --fields id,title (both already default keys) still explicitly asked for a
  // projection and must get the minimal schema back, not have it silently overridden by kind
  // columns just because every requested name happened to collide with a default key.
  const fieldsFlagGiven = values.fields !== undefined;

  let kindCols: string[] | undefined;
  let kindProgressCoordinate: ReturnType<typeof progressStatusCoordinate>;
  if (!fieldsFlagGiven && filter.type && docs.length > 0) {
    const registry = await getRegistry(); // command-layer, loaded AT MOST once per invocation
    const kind = registry.kinds.get(filter.type);
    if (kind) {
      kindProgressCoordinate = progressStatusCoordinate(await getOkfVersion(), kind);
      const cols = [...new Set([...kind.fields.required, ...kind.fields.optional].map((field) =>
        field === kindProgressCoordinate?.storageField ? kindProgressCoordinate.logicalField : field,
      ))].filter(
        (f) => f !== "id" && f !== "title" && f !== "description",
      );
      if (cols.length > 0) kindCols = cols;
    }
  }

  const rows: Record<string, unknown>[] = kindCols
    ? docs.map((d) => {
        const fm = d.frontmatter as Record<string, unknown>;
        const row: Record<string, unknown> = {
          id: d.id,
          title: typeof fm.title === "string" ? fm.title : (d.id.split("/").pop() ?? d.id),
        };
        for (const c of kindCols!) {
          row[c] = cell(
            c === kindProgressCoordinate?.logicalField
              ? fm[kindProgressCoordinate.storageField]
              : fm[c],
          );
        }
        return row;
      })
    : docs.map(projectMinimal);

  const total = rows.length;
  const shownRows = limit > 0 ? rows.slice(0, limit) : rows;
  const truncated = shownRows.length < total;

  // `count` is the TOTAL matched (§4 definitive aggregate); `docs` is the (possibly capped) page.
  const out: Record<string, unknown> = { count: total, docs: shownRows };
  if (truncated) out.shown = shownRows.length;

  // Contextual disclosure (§9): a list is not self-contained, so point at the natural drill-downs —
  // but only when there's something to drill into. A truncation hint (if capped) and the corrupt-doc
  // hint (if any) precede the browse hints so the most actionable line is first.
  const help: string[] = [];
  if (truncated) {
    help.push(
      `showing ${shownRows.length} of ${total} — run \`${cliInvocation()} list --limit 0\` (or a higher --limit) for all`,
    );
  }
  if (skipped.length > 0) {
    out.skipped = skipped;
    help.push(
      `${skipped.length} document(s) skipped (unparseable frontmatter) — run \`${cliInvocation()} doc read <id>\` for the full error, then fix the YAML`,
    );
  }
  // --open on a bundle with zero terminal declarations is a structural no-op (nothing to exclude) —
  // said explicitly so the flag is never silently meaningless.
  if (openNoopReason) help.push(openNoopReason);
  // Discovery hint for the kind-column projection: the felt friction this closes is an
  // agent typing `--fields status,priority` on every board scan because nothing advertises that
  // `--type Task` projects those columns automatically. When a MINIMAL-schema result turns out to
  // be uniformly ONE governed kind with projectable fields, say so — ONE help line, never a
  // schema change: output columns key on the invocation, not on current bundle contents. The
  // registry load is gated behind uniformity and the
  // absence of --type/--fields, so mixed/unscoped scans (and every conventions-free bundle) pay
  // nothing; when it fires over --remote it costs one thin conventions/ round-trip.
  if (!kindCols && !fieldsFlagGiven && !filter.type && docs.length > 0) {
    const first = docs[0]!.frontmatter.type;
    const uniformType = typeof first === "string" && first !== "" && docs.every((d) => d.frontmatter.type === first);
    if (uniformType) {
      const registry = await getRegistry();
      const kind = registry.kinds.get(first);
      if (kind) {
        const authoringKind = projectKindForAuthoring(await getOkfVersion(), kind);
        const cols = [...new Set([...authoringKind.fields.required, ...authoringKind.fields.optional])].filter(
          (f) => f !== "id" && f !== "title" && f !== "description",
        );
        if (cols.length > 0) {
          help.push(
            `all ${total} rows are '${first}' — \`${cliInvocation()} list --type ${commandToken(first)}\` projects its ${cols.join("/")} columns`,
          );
        }
      }
    }
  }
  if (total > 0) {
    help.push(`${cliInvocation()} doc read <id>`, `${cliInvocation()} link show <id>`);
  }
  if (help.length > 0) out.help = help;
  stdout(render(out, resolveMode(values)));
}
