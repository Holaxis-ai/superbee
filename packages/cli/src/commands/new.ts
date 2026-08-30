// `superbee new "<Kind>" <id> --<field> <value> …` — create a new instance of a
// bundle-declared kind.
//
// Phase-0 experiment result (binding — Part B of the kind-conventions plan): 9 fresh agents, 3
// grammar variants. A generic `new "<Kind>" <id>` verb (no per-kind subcommands) scored 3/3 with
// zero failures; per-kind subcommand sugar scored 3/3 too but with shallow discovery (subjects
// groped for a `kinds` verb they couldn't find). `new` is statically registered in
// `KNOWN_COMMANDS`/`cli.ts` like every other command — no dynamic per-kind dispatch machinery.
//
// `new` validates STRICTLY (unlike `doc write`'s warn-by-default): a missing required field or a
// value outside a declared enum is a USAGE error (exit 2), never a written-but-warned doc. Declared
// `sections` are scaffolded as empty body headings; the kind's `path` prefix (if declared) is
// prepended onto the id unless the id already carries it. The engine (`writeDoc`) itself performs NO
// kind validation — this command is the one place that reads the registry and decides.
//
// `new` is create-only, not create-or-overwrite. Calling `writeDoc` unconditionally on an existing
// id would replace its title/body/every field with the freshly scaffolded ones — the same
// silent-data-loss class already closed for `doc write`. It writes with the engine's expect-absent
// compare-and-swap (`expectedVersion: null`, the same create-race-closing pattern the CLI's recipe
// machinery
// (`applyRecipe`) uses): the write succeeds only if the target id does not yet exist, and a
// pre-existing doc maps the resulting `VersionConflict` to a structured ALREADY_EXISTS error
// (exit 5) that hints `doc update` (to patch it) or `doc write` (to overwrite it outright and
// deliberately).
//
// Field flags are dynamic (kind-defined), so this command parses argv in TWO PHASES through the
// SAME `node:util` `parseArgs` every other command uses (retiring the former hand-rolled
// tokenizer, whose glued/malformed-flag error used to misdirect — see below).
//
// Phase 1 (lenient discovery): a `strict:false` parse over ONLY the control flags (dir/remote/
// actor/json/help) extracts the leading `Kind` positional (and opens the bundle + loads the
// registry). Phase 2 (authoritative): a STRICT `parseArgs` re-parse, built from the loaded kind's
// declared fields (`{ type: "string", multiple: true }` each), any version-aware logical aliases,
// PLUS the same control flags, is the source of truth for every value, the
// `id`/`>2`-positionals check, and unknown-flag detection.
// This keeps `new` on the exact same parser shape as every other command (consistency was the
// point) while still handling a kind's fields, which aren't known until the Kind is loaded.
//
// A glued/malformed flag token (e.g. a shell-quoting mistake that lands `"--status todo"` as ONE
// argv element) now surfaces as an "unknown field(s) … status todo" USAGE error that NAMES the
// token — replacing the old hand-rolled parser's misdirecting "got 3 positionals" (a real agent
// hit this mid-session; the whole point of this migration).
//
// `--actor` is a CONTROL flag here (mirrors `doc update`'s `DOC_UPDATE_VALUE_FLAGS`), so a kind
// field literally named `actor` is unreachable AS A KIND-FIELD FLAG via `new` — core's
// `RESERVED_FIELD_NAMES` does not reserve `actor`, but the CLI already treats it as reserved on
// every other mutation surface, so this is consistent, not a regression (still listed in a
// "declared:" hint). The control flag persists edition-appropriate mutation attribution and also
// satisfies an explicitly required `actor` Kind field, with control semantics (blank-value guard,
// trim).
import { parseArgs } from "node:util";
import {
  loadKinds,
  kindInputFieldNames,
  progressStatusCoordinate,
  projectKindForAuthoring,
  readBundleOkfVersion,
  resolveKindFieldCoordinate,
  type Frontmatter,
  type KindConvention,
  type KindRegistry,
  type ValidationWarning,
} from "@superbee/core";
import { resolveConceptIdCliArgument } from "../concept-id.js";
import { assertResolvedLocalRouteIdentity, boardAttributionForRoute, openBundle, resolveLocalBundleRoute, resolveRemoteFlag, type ResolvedLocalRoute } from "../bundle.js";
import { CliError, asHandled, classifyBundleError } from "../errors.js";
import { parseLeafOrUsage, parseNewSchemaPhaseOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation, shellArg } from "../invocation.js";
import { mutateDoc } from "../mutate.js";
import { kindDeclaresAnything } from "../kind-draft.js";
import { isKnownShippedLegacyPageConvention, isLegacyPageDoc, LEGACY_PAGE_TYPE_HINT } from "../legacy-page.js";
import { boardPostPersistHook } from "../board-attribution.js";
import { resolveActor } from "../actor.js";
import { readExternalTextFile } from "../external-file.js";
import { addLink } from "./link.js";

export const NEW_USAGE = `superbee new — create a new instance of a bundle-declared kind

Usage:
  superbee new "<Kind>" <id> --<field> <value> [--<field> <value> ...] [--body <markdown> | --body-file <path>] [options]

The kind must be declared by a kind convention doc under conventions/ — run 'superbee kinds'
to list what a bundle declares. Supply each of the kind's required fields via --<field> <value>
(or --<field>=<value>); declared optional fields may be supplied the same way. Repeat a flag to
set an array value (e.g. --tags a --tags b). Any field not declared by the kind is a USAGE error.
The kind's declared body 'sections' (if any) are scaffolded as empty '# Heading' blocks; its
'path' prefix (if any) is prepended onto <id> unless <id> already carries it. Validation is
STRICT: a missing required field or a disallowed enum value rejects the write (exit 2) rather
than writing-with-a-warning.

'new' is CREATE-ONLY: if the (prefixed) <id> already carries a document, the write is rejected
(exit 5) instead of silently replacing it — run 'doc update' to patch an existing doc, or 'doc
write' to overwrite it outright and deliberately.

'superbee doc write <id> --type <Type> ...' creates a generic document whose type has no governing
Kind, and is also the deliberate full-replacement path for an existing document.

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
  --actor <name>         Attribute this write using the bundle's compatible advisory field, used
                         by per-doc sync receipts and version history for a persisting backend.
                         Precedence: --actor > SUPERBEE_ACTOR >
                         legacy AGENTSTATE_LITE_ACTOR > absent. A present-but-blank flag or
                         environment value is a USAGE error (exit 2).
  --body <markdown>     Use inline Markdown as the complete initial body. Mutually exclusive with
                       --body-file. The supplied body is validated strictly against the kind's
                       declared sections before anything is written.
  --body-file <path>   Read the initial Markdown body from a local file. When omitted, scaffold
                       the kind's declared sections as empty '# Heading' blocks. The supplied body
                       is validated strictly against those declared sections before anything is
                       written. This is a byte-ingress convenience; the bundle still stores an
                       ordinary OKF Markdown document.
  --link "<type>=<target-id>"
                         Repeatable. After the doc is created, add an outbound cross-link of this
                         TYPE to the given target id — through the exact same idempotent path
                         'link add --text "<type>"' uses (relative bundle-relative href; a
                         dangling target, i.e. one with no document yet, is allowed, same as
                         'link add'). A type not in this kind's declared 'links' vocabulary warns
                         but still adds the link (teach, never block). A malformed value (missing
                         '=', empty type, or empty target) is a USAGE error (exit 2) — checked
                         BEFORE the doc is written, so a malformed --link creates nothing. If a
                         link fails AFTER the doc was created (e.g. a reserved-file target), the
                         doc is NOT rolled back: the receipt's 'links' array names which entries
                         failed and the command exits non-zero.
  --no-prefix           Use <id> verbatim — do NOT auto-prepend the kind's declared path prefix
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

export interface NewCliDeps {
  stdout: (s: string) => void;
}

/** Define a kind-authored field name without invoking the legacy `__proto__` setter. */
function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Prototype-safe own-key check for kind-authored maps. */
function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Bundle-selection + output-control flags for `new`, shared by BOTH parse phases. NOT `strict` —
 * `new` is ALWAYS strict, so a literal `--strict` token must remain an "unknown field" (falls into
 * the kind-field bucket and is rejected as undeclared), matching pre-migration behavior. `actor`
 * is control here (mirrors `doc update`'s `DOC_UPDATE_VALUE_FLAGS`), so a same-named kind field is
 * shadowed — see file header. `link` (the one-step create+link ergonomics flag) is control for the
 * same reason: it is generic to EVERY kind, not a kind-declared field, so a kind literally
 * declaring a field named `link` is shadowed too (same judgment call as `actor`).
 */
const NEW_CONTROL_OPTIONS = {
  dir: { type: "string" },
  remote: { type: "string" },
  actor: { type: "string" },
  link: { type: "string", multiple: true },
  body: { type: "string" },
  "body-file": { type: "string" },
  "no-prefix": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** One parsed `--link "<type>=<target-id>"` value. */
interface ParsedLinkFlag {
  type: string;
  target: string;
}

/**
 * Parse one `--link` value into its `{type, target}` pair. Splits on the FIRST '=' (a target id
 * can never itself contain '=', but this keeps the rule simple and doesn't matter either way).
 * Malformed input (no '=', empty type, empty target) is a USAGE error (exit 2) NAMING the
 * expected form — checked for every value before any doc is written, so a malformed --link
 * creates nothing (fail fast, never a partially-applied create).
 */
function parseLinkFlagValue(raw: string): ParsedLinkFlag {
  const eq = raw.indexOf("=");
  if (eq < 0) {
    throw new CliError("USAGE", `--link value '${raw}' is missing '=' — expected the form "<type>=<target-id>"`, {
      help: `${cliInvocation()} new "<Kind>" <id> --link "<type>=<target-id>"`,
    });
  }
  const type = raw.slice(0, eq).trim();
  const target = raw.slice(eq + 1).trim();
  if (!type) {
    throw new CliError(
      "USAGE",
      `--link value '${raw}' has an empty link type — expected the form "<type>=<target-id>"`,
      { help: `${cliInvocation()} new "<Kind>" <id> --link "<type>=<target-id>"` },
    );
  }
  if (!target) {
    throw new CliError(
      "USAGE",
      `--link value '${raw}' has an empty target id — expected the form "<type>=<target-id>"`,
      { help: `${cliInvocation()} new "<Kind>" <id> --link "<type>=<target-id>"` },
    );
  }
  return { type, target };
}

/**
 * Phase 1 runs `strict:false`, which yields boolean `true` (not `undefined`, and no throw) for a
 * CONFIGURED value flag given no value as the final argv token — e.g. `new Task x --dir`. `--dir`/
 * `--remote` are consumed BEFORE the authoritative Phase-2 strict parse (they open the bundle the
 * kind is loaded from), so a boolean here would reach `openBundle` and crash it ('paths[0] must be a
 * string') as a RUNTIME (off the capped taxonomy) instead of the clean USAGE Phase 2 would give.
 * Reject it here, returning the narrowed `string | undefined` so no unsound cast is needed.
 */
function controlFlagValue(val: string | boolean | undefined, flag: string): string | undefined {
  if (typeof val === "boolean") {
    throw new CliError("USAGE", `--${flag} requires a value`, {
      help: `${cliInvocation()} new "<Kind>" <id> --${flag} <value>`,
    });
  }
  return val;
}

/**
 * Inbound typed-link declarations targeting `kind`: every OTHER kind whose `links` map names
 * `kind.governs` as a target. Pure reverse lookup over the ONE registry — no kind or link-type
 * name appears in code, so the alignment teaching below is fully generic: whatever relationships
 * a bundle's conventions declare are what get taught. Self-declarations (a kind linking to
 * itself, e.g. Task "depends on" Task) are excluded — the kind's OWN `links` map already covers
 * those on the outbound side.
 */
function inboundLinkDecls(
  registry: KindRegistry,
  kind: KindConvention,
): Array<{ source: KindConvention; linkType: string }> {
  const inbound: Array<{ source: KindConvention; linkType: string }> = [];
  for (const source of registry.kinds.values()) {
    if (source.governs === kind.governs) continue;
    for (const [linkType, target] of Object.entries(source.links ?? {})) {
      if (target === kind.governs) inbound.push({ source, linkType });
    }
  }
  return inbound.sort(
    (a, b) => a.source.governs.localeCompare(b.source.governs) || a.linkType.localeCompare(b.linkType),
  );
}

/** `roadmap-items/<roadmap-item>`-style placeholder for a kind: declared path prefix + slugged name. */
function kindIdPlaceholder(kind: KindConvention | undefined, governs: string): string {
  const slug = governs.toLowerCase().replace(/\s+/g, "-");
  const prefix = kind?.path ? kind.path.replace(/\/+$/, "") + "/" : "";
  return `${prefix}<${slug}>`;
}

/**
 * Per-kind help for `new "<Kind>" --help`: the exact required/optional fields, enum values, scaffolded
 * body sections, and id path prefix an agent needs to author a VALID instance — without a separate
 * `kinds` round-trip (cold-start study: 2 testers had to cross-reference `kinds` before every `new`).
 */
function renderKindHelp(
  kind: KindConvention,
  registry: KindRegistry,
  inv: string,
): string {
  const oneLine = (value: string) => value.trim().replace(/\s+/g, " ");
  const ownDescription = (record: Record<string, string> | undefined, key: string): string | undefined => {
    if (!record || !hasOwn(record, key) || typeof record[key] !== "string") return undefined;
    const description = oneLine(record[key]);
    return description === "" ? undefined : description;
  };
  const ordinary = (field: string) => field !== "actor" && field !== "link";
  const req = [...new Set(kind.fields.required.filter(ordinary))];
  const required = new Set(req);
  const opt = [...new Set(kind.fields.optional.filter((field) => ordinary(field) && !required.has(field)))];
  const fieldRows = [
    ...req.map((field) => ({ field, requirement: "required" })),
    ...opt.map((field) => ({ field, requirement: "optional" })),
  ].map(({ field, requirement }) => {
    const allowed = hasOwn(kind.fields.values, field) && Array.isArray(kind.fields.values[field])
      ? kind.fields.values[field]
      : undefined;
    const description = ownDescription(kind.fields.descriptions, field);
    const descriptionsByValue = kind.fields.valueDescriptions;
    const valueDescriptions = descriptionsByValue && hasOwn(descriptionsByValue, field)
      ? descriptionsByValue[field]
      : undefined;
    const describedValues = allowed?.map((value) => ({ value, description: ownDescription(valueDescriptions, value) }));
    const hasValueDescriptions = describedValues?.some((entry) => entry.description !== undefined) ?? false;
    const fieldLine = `  --${field} <v>  ${requirement}`;
    if (!allowed || allowed.length === 0) return fieldLine + (description ? ` — ${description}` : "");
    if (!hasValueDescriptions) {
      return `${fieldLine}; allowed: ${allowed.join(" | ")}` + (description ? ` — ${description}` : "");
    }
    const valueRows = describedValues!.flatMap((entry) => [
      `      - value: ${JSON.stringify(entry.value)}`,
      ...(entry.description ? [`        description: ${JSON.stringify(entry.description)}`] : []),
    ]);
    return (
      fieldLine +
      (description ? ` — ${description}` : "") +
      "\n    allowed values:\n" +
      valueRows.join("\n")
    );
  });
  const sectionLines =
    kind.sections && kind.sections.length > 0
      ? kind.sections.map((section) => `  # ${section}`).join("\n")
      : "  (none)";
  const pathLine = kind.path
    ? `Id:  auto-prefixed with '${kind.path.replace(/\/+$/, "")}/' unless <id> already carries it`
    : "Id:  used as-is (this kind declares no path prefix)";
  // Typed-link vocabulary, BOTH directions (declared-only; a bundle declaring none gets no block):
  // the kind's own outbound types, plus the reverse lookup — other kinds declaring edges INTO this
  // one. The inbound side is the alignment cue (e.g. a new Task learns Roadmap Items contain Tasks).
  const outboundLines = Object.entries(kind.links ?? {}).map(([t, target]) => {
    const description = ownDescription(kind.linkDescriptions, t);
    return `  this kind may link:     "${t}" → ${target}${description ? ` — ${description}` : ""}`;
  });
  const inboundLines = inboundLinkDecls(registry, kind).map(({ source, linkType }) => {
    const description = ownDescription(source.linkDescriptions, linkType);
    return (
      `  other kinds link here:  ${source.governs} "${linkType}" → ${kind.governs}` +
      (description ? ` — ${description}` : "")
    );
  });
  const linksBlock =
    outboundLines.length + inboundLines.length > 0
      ? `Links (typed edges declared by this bundle's conventions; write with --link "<type>=<target-id>" ` +
        `at create time, or link add --text "<type>" after the fact):\n` +
        [...outboundLines, ...inboundLines].join("\n") +
        "\n"
      : "";
  return (
    `${inv} new "${kind.governs}" <id> — create a ${kind.governs} instance\n\n` +
    (kind.description ? `Description:  ${kind.description}\n` : "") +
    `Fields (declared by the '${kind.governs}' kind convention):\n` +
    (fieldRows.length > 0 ? fieldRows.join("\n") + "\n" : "  (none)\n") +
    `Required body headings (level 1; exact Markdown):\n${sectionLines}\n` +
    linksBlock +
    `${pathLine}\n\n` +
    `Repeat a flag to set an array value (e.g. --tag a --tag b). Validation is STRICT.\n` +
    `To ADD a field to this kind, edit its convention doc (${inv} kinds names it; then pull → edit fields.optional → promote).\n\n` +
    `Options:\n` +
    `  --actor <name>   Attribute the write (overrides SUPERBEE_ACTOR; legacy AGENTSTATE_LITE_ACTOR remains supported)\n` +
    `  --body <markdown>\n` +
    `                   Use inline Markdown as the complete initial body; mutually exclusive with\n` +
    `                   --body-file\n` +
    `  --body-file <path>\n` +
    `                   Read the complete initial Markdown body from a local file; when omitted,\n` +
    `                   scaffold the declared body sections\n` +
    `  --link "<type>=<target-id>"\n` +
    `                   Repeatable: after creating this instance, add an outbound link of type\n` +
    `                   <type> to <target-id> (same idempotent path as 'link add'; a dangling\n` +
    `                   target is allowed)\n` +
    `  --no-prefix      Use <id> verbatim (skip the auto path prefix above)\n` +
    `  --dir <path>     Bundle directory (default: discovered from the cwd)\n` +
    `  --remote <url>   Talk to a wire-protocol server instead of a local bundle\n` +
    `  --json           Emit compact JSON instead of TOON\n` +
    `  -h, --help       Show this help\n`
  );
}

export async function newCommand(argv: string[], deps: Partial<NewCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  // Phase 1 — lenient discovery: extract the leading `Kind` positional plus the bundle-selection
  // flags, without yet knowing the kind's declared fields (unconfigured kind-field flags become
  // stray booleans/positionals here — harmless, since only `positionals[0]` is read from this
  // pass; Phase 2 is the AUTHORITATIVE parse for everything else, including `id`).
  const pre = parseNewSchemaPhaseOrUsage(
    () => parseArgs({ args: argv, strict: false, allowPositionals: true, options: NEW_CONTROL_OPTIONS }),
  );
  const kindName = (pre.positionals[0] as string | undefined)?.trim();
  // `new --help` with NO kind named → the generic reference. `new "<Kind>" --help` → that kind's
  // own schema (rendered below, once the kind is loaded) so an agent can author a valid instance
  // without a separate `kinds` round-trip.
  if (pre.values.help && !kindName) {
    stdout(NEW_USAGE);
    return;
  }
  if (!kindName) {
    throw new CliError("USAGE", 'new requires "<Kind>" and <id> positionals', {
      help: `${cliInvocation()} new "<Kind>" <id> --<field> <value>`,
    });
  }

  const preDir = controlFlagValue(pre.values.dir, "dir");
  const preRemote = controlFlagValue(pre.values.remote, "remote");
  // `--help` must work anywhere: if the bundle can't be opened, fall back to the generic reference
  // rather than erroring on a bundle lookup the user didn't ask to perform.
  let bundle;
  let route: ResolvedLocalRoute | undefined;
  let attribution: ReturnType<typeof boardAttributionForRoute> = { kind: "none" };
  try {
    const remote = await resolveRemoteFlag(preRemote, preDir);
    route = remote === undefined ? await resolveLocalBundleRoute(preDir) : undefined;
    bundle = route?.bundle ?? await openBundle(preDir, remote);
    attribution = route ? boardAttributionForRoute(route) : { kind: "none" };
  } catch (err) {
    if (pre.values.help) {
      stdout(NEW_USAGE);
      return;
    }
    throw err;
  }
  if (route) await assertResolvedLocalRouteIdentity(route);
  const [registry, okfVersion] = await Promise.all([
    loadKinds(bundle),
    readBundleOkfVersion(bundle),
  ]);
  // DELIBERATE exclusion: a declaration-free kind — a `kind dismiss` decline record, or a
  // hand-authored governs-only convention that has not yet grown its first declaration — is
  // invisible to `new`'s EXECUTION path. Without this guard, `new` would resolve a schema-less
  // kind whose phase-2 strict parse then rejects EVERY domain flag as "unknown field(s)";
  // excluding it keeps a real `new <Type> ...` invocation's failure byte-identical before and
  // after a dismissal (design appendix O6). `--help` still resolves it: kind help is read-only
  // and a declaration-free kind can carry renderable INBOUND-link guidance declared by OTHER
  // kinds (pinned in kinds.test.ts). The `doc write` path is unaffected either way.
  const resolvedKind = registry.kinds.get(kindName);
  const kind = resolvedKind && (pre.values.help || kindDeclaresAnything(resolvedKind)) ? resolvedKind : undefined;
  if (!kind) {
    if (pre.values.help) {
      stdout(NEW_USAGE); // named kind isn't declared here — the generic help is the most we can show
      return;
    }
    const known = [...registry.kinds.entries()]
      .filter(([, candidate]) => kindDeclaresAnything(candidate))
      .map(([name]) => name)
      .sort();
    throw new CliError(
      "USAGE",
      known.length > 0
        ? `unknown kind '${kindName}' (declared: ${known.join(", ")})`
        : `unknown kind '${kindName}' (no kinds declared in this bundle)`,
      { help: `${cliInvocation()} kinds` },
    );
  }
  if (pre.values.help) {
    stdout(renderKindHelp(projectKindForAuthoring(okfVersion, kind), registry, cliInvocation()));
    return;
  }
  // Scaffolding from the KNOWN SHIPPED
  // legacy Page convention would produce a doc the runtime ignores — refuse with the remedy. A
  // genuinely-custom kind that merely reuses the legacy 'Page' name (a different declared
  // shape) is not matched and scaffolds normally (the write-time hint still fires).
  if (isKnownShippedLegacyPageConvention(kind)) {
    throw new CliError(
      "USAGE",
      "this bundle's 'Page' convention is the retired legacy form of the 'View' kind — a scaffolded type: Page doc would not register anywhere",
      {
        help:
          "run `node scripts/migrate-legacy-view-names.mjs --dir <bundle-root>` (in the superbee repo) " +
          `to migrate the bundle in place, then author with: ${cliInvocation()} new "View" <id> --access <none|bundle-read|bundle-propose>`,
      },
    );
  }

  // Phase 2 — strict, kind-aware, AUTHORITATIVE parse. Core strips every centrally-reserved kind
  // field before this point (including `body` and `body-file`); only `actor` and `link` remain
  // command controls with intentional kind-aware behavior, so they are excluded here explicitly.
  const authoringKind = projectKindForAuthoring(okfVersion, kind);
  const declaredFields = [...authoringKind.fields.required, ...authoringKind.fields.optional];
  const fieldNames = kindInputFieldNames(okfVersion, kind).filter((f) => f !== "actor" && f !== "link");
  const fieldOptions = Object.fromEntries(
    fieldNames.map((f) => [f, { type: "string", multiple: true } as const]),
  );

  const { values, positionals, tokens } = parseLeafOrUsage(() => {
    try {
      return parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        tokens: true,
        options: { ...fieldOptions, ...NEW_CONTROL_OPTIONS },
      });
    } catch (err) {
      // Preserve the helpful unknown-field UX (and, notably, turn a glued/malformed flag token —
      // e.g. `"--status todo"` as ONE argv element from a shell-quoting mistake — into an error
      // that NAMES the offending token instead of the old hand-rolled parser's misdirecting "got N
      // positionals"): re-throw the kind-specific message. The owned parser passes a thrown
      // `CliError` through unchanged and translates any OTHER parse error normally.
      if ((err as { code?: unknown } | null)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
        const raw = /'([^']+)'/.exec((err as Error).message)?.[1] ?? "";
        const field = raw.replace(/^--?/, ""); // node quotes the raw '--name'; strip the dashes
        throw new CliError(
          "USAGE",
          `unknown field(s) for kind '${kind.governs}': ${field}` +
            (declaredFields.length > 0
              ? ` (declared: ${declaredFields.join(", ")})`
              : " (this kind declares no fields)") +
            ` — to ADD it to the '${kind.governs}' kind: \`${cliInvocation()} kind field "${kind.governs}" add ${field}\` (then re-run).`,
          { help: `${cliInvocation()} kinds` },
        );
      }
      throw err; // owned parser -> translated USAGE (missing value, takes-no-value, …)
    }
  }, CLI_LEAVES.new);
  // Node accepts and tokenizes `--__proto__`, but deliberately omits that key from `values`.
  // The validated token stream is therefore the authority for every kind-defined field.
  const dynamicValues = new Map<string, string[]>();
  const dynamicFieldNames = new Set(fieldNames);
  for (const token of tokens) {
    if (token.kind !== "option" || !dynamicFieldNames.has(token.name) || token.value === undefined) continue;
    const accumulated = dynamicValues.get(token.name) ?? [];
    accumulated.push(token.value);
    dynamicValues.set(token.name, accumulated);
  }

  const rawId = (positionals[1] as string | undefined)?.trim();
  if (!rawId) {
    throw new CliError("USAGE", 'new requires "<Kind>" and <id> positionals', {
      help: `${cliInvocation()} new "<Kind>" <id> --<field> <value>`,
    });
  }
  const id = await resolveConceptIdCliArgument(bundle, rawId);
  const actor = resolveActor(values.actor as string | undefined, {
    help: `${cliInvocation()} new "<Kind>" <id> --actor <name>`,
  });

  // Parse EVERY --link value up front, before any write — a malformed value is a caller mistake,
  // not a partial-success case, so it must reject cleanly with NOTHING created (see
  // `parseLinkFlagValue`'s header).
  const linkFlags = (values.link as string[] | undefined) ?? [];
  const parsedLinks = linkFlags.map(parseLinkFlagValue);

  // Resolve the body ONCE and before any mutation. Missing/unreadable or ambiguous input is a
  // caller problem and must leave no partially-created document. An explicit empty inline body or
  // empty file is still deliberate input; strict kind validation decides whether it satisfies the
  // declared sections.
  const inlineBody = values.body as string | undefined;
  const bodyFile = values["body-file"] as string | undefined;
  if (inlineBody !== undefined && bodyFile !== undefined) {
    throw new CliError("USAGE", "--body and --body-file are mutually exclusive", {
      help: `${cliInvocation()} new "${kindName}" <id> [--body <markdown> | --body-file <path>]`,
    });
  }
  let suppliedBody = inlineBody;
  if (bodyFile !== undefined) {
    if (bodyFile.trim() === "") {
      throw new CliError("USAGE", "--body-file requires a non-empty path", {
        help: `${cliInvocation()} new "${kindName}" <id> --body-file <path>`,
      });
    }
    try {
      suppliedBody = await readExternalTextFile(bodyFile);
    } catch (err) {
      // A private-state boundary refusal is a CONFLICT verdict, not an I/O failure — never let the
      // "could not read" wrapper below demote it to USAGE.
      if (err instanceof CliError) throw err;
      throw new CliError(
        "USAGE",
        `could not read --body-file ${JSON.stringify(bodyFile)}: ${err instanceof Error ? err.message : String(err)}`,
        { help: `${cliInvocation()} new "${kindName}" <id> --body-file <path>` },
      );
    }
  }

  const frontmatter: Frontmatter = { type: kind.governs };
  const suppliedByStorageField = new Map<string, string>();
  const progressCoordinate = progressStatusCoordinate(okfVersion, kind);
  for (const field of fieldNames) {
    const vals = dynamicValues.get(field);
    if (vals === undefined || vals.length === 0) continue;
    const coordinate = resolveKindFieldCoordinate(okfVersion, kind, field);
    if (!coordinate) continue;
    const previous = suppliedByStorageField.get(coordinate.storageField);
    if (previous) {
      const logicalField = coordinate.storageField === progressCoordinate?.storageField
        ? progressCoordinate.logicalField
        : coordinate.logicalField;
      throw new CliError(
        "USAGE",
        `'${logicalField}' was supplied more than once; pass it once`,
        { help: `${cliInvocation()} new "${kind.governs}" <id> --${logicalField} <value>` },
      );
    }
    suppliedByStorageField.set(coordinate.storageField, field);
    setOwn(frontmatter, coordinate.storageField, vals.length === 1 ? vals[0]! : vals);
  }
  // `mutateDoc` applies the resolved actor to frontmatter before strict validation, so the actor
  // control flag (or environment default) still satisfies a kind that declares actor as required.
  // `mutateDoc`'s validate step (strict:true below) defaults `frontmatter.timestamp` in place if
  // still absent BEFORE validating — so a kind that declares `timestamp` required (e.g. the seeded
  // Context Note kind) validates against a value that is actually present, not "missing because the
  // user didn't pass --timestamp".

  const body = suppliedBody ?? (kind.sections ?? []).map((heading) => `# ${heading}\n`).join("\n");
  // `--no-prefix` uses the id VERBATIM instead of auto-prepending the kind's declared `path` — the
  // escape hatch for when a caller needs a specific id/namespace that differs from the kind's
  // convention (cold-start study r3: an agent needing a literal prefix had to drop off `new` onto
  // `doc write`, losing strict kind validation, because the auto-prefix rewrote its id).
  const targetId = values["no-prefix"]
    ? id
    : await resolveConceptIdCliArgument(bundle, rawId, { prefix: kind.path });
  const remote = values.remote as string | undefined;

  // "create-only" mode: expect-absent CAS, the same closed-create-race pattern the CLI's recipe
  // machinery (`applyRecipe`) uses. A pre-existing doc at `targetId` maps to a structured, actionable
  // ALREADY_EXISTS (exit 5) instead of silently overwriting it. Validation is STRICT (unlike `doc
  // write`'s warn-by-default): a missing required field or a disallowed enum value rejects the
  // write (exit 2) before any write is attempted.
  if (route) await assertResolvedLocalRouteIdentity(route);
  const result = await mutateDoc({
    bundle,
    id: targetId,
    mode: "create-only",
    registry,
    remoteUrl: remote,
    strict: true,
    helpOnKindReject:
      `${cliInvocation()} new ${shellArg(kind.governs)} --help` +
      (preDir !== undefined
        ? ` --dir ${shellArg(preDir)}`
        : preRemote !== undefined
          ? ` --remote ${shellArg(preRemote)}`
          : ""),
    actor,
    persistActor: true,
    // Board self-attribution (PR C): fires only after the expect-absent CAS create persisted.
    onPersisted: boardPostPersistHook(attribution, actor),
    buildCandidate: (_existing, context) => {
      const preparedEdition = okfVersion ?? "0.1";
      if (context.okfVersion !== preparedEdition) {
        throw new CliError(
          "STALE_HEAD",
          `the bundle OKF edition changed from '${preparedEdition}' to '${context.okfVersion}' while creating '${targetId}' — rerun the command against the current edition`,
          { help: `${cliInvocation()} new "${kindName}" ${rawId}` },
        );
      }
      return { frontmatter, body };
    },
    errors: {
      alreadyExists: () =>
        new CliError(
          "ALREADY_EXISTS",
          `'${targetId}' already exists — 'new' only creates fresh instances of a kind and refuses to ` +
            `silently overwrite one. Run '${cliInvocation()} doc update ${targetId}' to patch it, or ` +
            `'${cliInvocation()} doc write ${targetId} --type ${kind.governs}' to overwrite it outright ` +
            `and deliberately.`,
          { help: `${cliInvocation()} doc update ${targetId}` },
        ),
    },
  });

  const saved = result.doc;
  const receipt: Record<string, unknown> = {
    new: "written",
    kind: kind.governs,
    id: saved.id,
    type: saved.frontmatter.type,
    timestamp: saved.frontmatter.timestamp ?? null,
  };
  // Registry warnings for THIS convention belong at the point of use too. In particular, a bundle
  // that previously declared `body` or `body-file` as a domain field must not have the now-reserved
  // controls silently reinterpret its command: the successful receipt carries the central rename
  // guidance.
  const conventionWarningPrefix = `kind convention '${kind.id}'`;
  const conventionWarnings = registry.warnings.filter((warning) =>
    warning.message.startsWith(conventionWarningPrefix),
  );
  if (conventionWarnings.length > 0) receipt.warnings = conventionWarnings;
  // Surface the path-prefixing so it isn't silent: an agent that passed a bare id (or a
  // differently-prefixed one) sees the final id it actually got (cold-start study: C4 nearly
  // committed a wrong id because the prefix was auto-applied without any indication).
  if (targetId !== id) {
    receipt.note = `id prefixed with the '${kind.governs}' kind's path → '${targetId}' (you passed '${id}')`;
  }
  // --link (one-step create+link ergonomics unit): wire each declared cross-link through the
  // EXACT SAME machinery `link add` uses (`addLink`, `link.ts`) — never a second link-writer.
  // Best-effort across entries: the doc already exists by this point, and each --link is an
  // INDEPENDENT edge, so one failing entry does not abort the others (no fake atomicity — every
  // entry is attempted and reported).
  interface LinkFlagReceipt {
    type: string;
    target: string;
    changed?: boolean;
    href?: string;
    warnings?: ValidationWarning[];
    error?: { code: string; message: string };
  }
  const linkResults: LinkFlagReceipt[] = [];
  const satisfiedOutboundTypes = new Set<string>();
  // `new` itself writes once, then each successful `--link` rides the shared link-add CAS path.
  // Keep the version current after every success/no-op so the ONE command's receipt describes the
  // final stored head, not the pre-link intermediate version that dogfooding exposed.
  let finalVersion = result.version;
  let firstLinkFailure: CliError | undefined;
  for (const { type, target } of parsedLinks) {
    const warnings: ValidationWarning[] = [];
    // Teach when this kind declares an outbound link vocabulary and `type` isn't in it — warn,
    // never block: a hard reject here would be incoherent given a DANGLING target (below) is
    // unconditionally allowed, so a merely-undeclared TYPE can't be held to a stricter standard.
    if (kind.links && Object.keys(kind.links).length > 0 && !hasOwn(kind.links, type)) {
      warnings.push({
        code: "LINK_TYPE_UNDECLARED_FOR_KIND",
        message: `'${type}' is not declared in the '${kind.governs}' kind's link vocabulary (declared: ${Object.keys(kind.links).join(", ")}) — added anyway.`,
        field: "text",
        severity: "warning",
      });
    }
    try {
      const added = await addLink(bundle, saved.id, target, { text: type, remoteUrl: remote, actor });
      finalVersion = added.version;
      if (added.warnings) warnings.push(...added.warnings);
      linkResults.push({
        type,
        target,
        changed: added.changed,
        href: added.href,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
      satisfiedOutboundTypes.add(type);
    } catch (err) {
      const classified = classifyBundleError(err, remote);
      linkResults.push({
        type,
        target,
        error: { code: classified.code, message: classified.message },
        ...(warnings.length > 0 ? { warnings } : {}),
      });
      if (!firstLinkFailure) firstLinkFailure = classified;
    }
  }
  if (parsedLinks.length > 0) receipt.links = linkResults;
  // The content-addressed token of the FINAL document state after every successful/no-op link
  // attempt. This is the truthful CAS basis for a follow-up `doc update --expected-version`.
  receipt.version = finalVersion;
  // Legacy-naming nudge (legacy-page.ts): authoring-moment only — never blocks, never on reads.
  if (isLegacyPageDoc(saved.frontmatter)) receipt.hint = LEGACY_PAGE_TYPE_HINT;

  // Point-of-use link teaching (AXI §9): the moment an instance is created is when its declared
  // relationships are actionable — surface them as complete, placeholder-parameterized commands
  // derived from the SAME registry (inbound = alignment cue from other kinds' declarations,
  // outbound = this kind's own). Capped per direction; a bundle declaring no links adds nothing.
  // An outbound type already satisfied via --link above is dropped from its own hint — suggesting
  // a follow-up `link add` for a relationship this very command just established would be noise.
  const help = [`${cliInvocation()} doc read ${saved.id}`];
  const HINTS_PER_DIRECTION = 3;
  for (const { source, linkType } of inboundLinkDecls(registry, kind).slice(0, HINTS_PER_DIRECTION)) {
    help.push(
      `link from a ${source.governs}: ${cliInvocation()} link add ${kindIdPlaceholder(source, source.governs)} ${saved.id} --text "${linkType}"`,
    );
  }
  const outboundLinkDecls = Object.entries(kind.links ?? {}).filter(([linkType]) => !satisfiedOutboundTypes.has(linkType));
  for (const [linkType, target] of outboundLinkDecls.slice(0, HINTS_PER_DIRECTION)) {
    help.push(
      `link to a ${target}: ${cliInvocation()} link add ${saved.id} ${kindIdPlaceholder(registry.kinds.get(target), target)} --text "${linkType}"`,
    );
  }
  receipt.help = help;
  stdout(render(receipt, resolveMode({ json: Boolean(values.json) })));

  // At least one --link entry failed AFTER the doc was created: the full receipt above already
  // named the doc (it exists — no rollback, no fake atomicity) and which links failed. Throw
  // `asHandled` so the bin wrapper sets a non-zero exit WITHOUT re-emitting a second, conflicting
  // envelope (mirrors `sync`'s post-commit push-failure partial-envelope pattern).
  if (firstLinkFailure) {
    const failedCount = linkResults.filter((r) => r.error).length;
    throw asHandled(
      new CliError(
        firstLinkFailure.code,
        `'${saved.id}' was created, but ${failedCount} of ${parsedLinks.length} --link ${parsedLinks.length === 1 ? "entry" : "entries"} failed — see 'links' in the receipt above for details`,
        { help: firstLinkFailure.help },
      ),
    );
  }
}
