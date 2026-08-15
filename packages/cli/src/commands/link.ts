// `superbee link add|show` — cross-links and derived backlinks.
//
// OKF cross-links are STANDARD markdown links in a concept's body (never wikilinks); backlinks are
// DERIVED by reversing the resolved link graph, never stored. `link add <from> <to>` appends a
// markdown link to `<from>`'s body in the bundle-RELATIVE form (`../<to>.md` — the form VISION, the
// OKF samples, and the reference graph builder use — via core `relativeHref`), then rewrites the doc.
// Appending a cross-link is a meaningful change: v0.1 refreshes `frontmatter.timestamp` by default
// (`--keep-timestamp` preserves it), while v0.2 advances `generated.at` through the shared mutation
// service without inventing legacy metadata. The idempotent no-op path (source already carries the
// same target + exact text) advances neither clock. `link show <id>` reports
// the concept's
// outbound links (core `parseLinks`) and its "cited by" set (core `backlinks`), each row carrying
// the citing/cited link's `text` — the only relationship-type signal OKF's untyped edges carry.
// `link show --text <t>` filters BOTH directions to links whose text EXACTLY matches `<t>` (not a
// substring match) — a reader-side lens over the same edges, never a second derivation.
// `link add`'s SUCCESS envelope (`changed:true` only — the idempotent no-op path never checks) also
// carries a graph-lint `warnings[]` when the link's text matches a bundle-declared typed-edge
// vocabulary entry (a kind's `links` map) but the actual source/target kinds don't conform, or when
// the text is a same-spelling-different-case near miss of a declared type — warn-only, never
// blocking, since the link is already written by the time this check runs. The SAME `warnings[]`
// carries a `LINK_TARGET_ABSENT` entry when the target has no document YET (dangling links stay
// LEGAL — forward-declaration by design — this is receipt HONESTY, not a refusal); a present
// target's receipt is unaffected. That check is LOCAL-bundle only (an extra `--remote` round trip
// would tax every remote link add), so a `--remote` link-add receipt never carries it.
//
// The mutation itself (versioned-read → idempotency check → CAS write → lint) is factored into
// the exported `addLink`, so `new --link` (`commands/new.ts`, one-step create+link) rides the
// EXACT SAME path this file's own `link add` subcommand uses — never a second link-writer.
import { parseArgs } from "node:util";
import {
  readDoc,
  parseLinks,
  backlinks,
  queryEdges,
  relativeHref,
  resolveConceptId,
  isReservedFile,
  pathFromConceptId,
  loadKinds,
  type Bundle,
  type EdgeFilter,
  type KindRegistry,
  type Link,
  type OkfDocument,
  type Version,
  type ValidationWarning,
} from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { maybeAutoPull } from "../autopull.js";
import { CliError, classifyBundleError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { collectLinkDeclarations } from "../link-types.js";
import { resolveActor } from "../actor.js";
import { conceptIdFromCliArgument, resolveConceptIdCliArgument } from "../concept-id.js";
import { mutateDoc } from "../mutate.js";

/** The common flags every `link` subcommand accepts — appended to each verb's focused help. */
const LINK_COMMON_OPTIONS = `Common options:
  --dir <path>         Bundle directory (default: discovered from the cwd)
  --remote <url>       Talk to a wire-protocol server instead of a local bundle
                       (mutually exclusive with --dir; remote access is always explicit)
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help`;

/** Family index for bare `link`; each subcommand owns its focused help below. */
export const LINK_USAGE = `superbee link — add a cross-link, show a concept's links + backlinks, or query the bundle's whole edge graph

Usage:
  superbee link add  <from> <to> [options]   Add a cross-link (idempotent)
  superbee link show <id> [options]          Show a concept's outbound links + derived backlinks
  superbee link list [options]               Query the whole bundle's derived edge list, filtered

Run 'superbee link <verb> --help' for a verb's full options.

${LINK_COMMON_OPTIONS}
`;

export const LINK_ADD_USAGE = `superbee link add — append a cross-link from one concept to another (idempotent)

Usage:
  superbee link add <from> <to> [--text <t>] [--actor <name>] [options]

Idempotent: re-adding the same target with the same exact display text is a no-op — exit 0,
changed:false, no duplicate link, no timestamp refresh. Different text to the same target is a
distinct semantic edge and is added.

Graph lint: if this bundle declares a kind's 'links' vocabulary (see 'kinds --help') and --text
matches a declared type, the just-written link is checked against the actual source/target kinds;
a mismatch or a same-spelling-different-case near miss attaches a 'warnings' array to the success
envelope (exit 0 — the link is already written). An untyped --text (no declared match, any casing)
or a conventions-free bundle never warns.

Target-existence honesty (link add only, LOCAL bundles only): dangling links stay LEGAL — a link to
a target with no document yet is a forward-declaration, by design. When the target is absent at link
time, the success envelope attaches a 'warnings' array entry (code LINK_TARGET_ABSENT) so the receipt
tells the truth; a link to an existing target's receipt is unchanged. Checked only against a local
--dir bundle (confirming existence costs a read that would be an extra network round trip over
--remote), so a --remote link-add receipt never carries this signal.

Options:
  --text <t>           Link display text (default: the target id)
  --keep-timestamp     Preserve the source's existing timestamp (default: refresh to now,
                       since adding a cross-link is a meaningful change)
  --actor <name>       Attribute a newly-added link in the source doc and backend history.
                       Falls back to SUPERBEE_ACTOR (or legacy AGENTSTATE_LITE_ACTOR); an existing
                       link remains a true no-op.
${LINK_COMMON_OPTIONS}

Examples:
  superbee link add tasks/review tasks/spec --text "depends on"
  superbee link show tasks/review
`;

export const LINK_SHOW_USAGE = `superbee link show — show a concept's outbound links and derived backlinks

Usage:
  superbee link show <id> [--limit <n>] [--text <t>] [options]

Reports the concept's outbound links (core 'parseLinks') and its "cited by" backlinks (derived by
reversing the resolved link graph, never stored — core 'backlinks'), each row carrying the citing/
cited link's 'text' — the only relationship-type signal OKF's untyped edges carry.

Options:
  --text <t>           Filter outbound links AND backlinks to those whose text is EXACTLY <t>
                       (case-sensitive, not a substring match); empty/missing value is a usage
                       error. outbound_count/backlink_count report the FILTERED totals when set.
                       A filter that matches nothing is a valid empty result, not an error — its
                       help line names the distinct link texts that ARE present, so a near-miss
                       (typo/case) is visible.
  --limit <n>          Cap each of the outbound/backlink lists (default: 50; 0 = unlimited);
                       outbound_count/backlink_count always report the true (post-filter) totals
${LINK_COMMON_OPTIONS}

Examples:
  superbee link show tasks/review
  superbee link show tasks/review --text "depends on"
`;

export const LINK_LIST_USAGE = `superbee link list — query the whole bundle's derived edge list, filtered

Usage:
  superbee link list [--from <id|prefix/>] [--to <id|prefix/>] [--text <t>] [--limit <n>] [options]

Queries the WHOLE bundle's derived edge list (the same edges 'link show' computes per-concept),
filtered — the atom a blast-radius/containment/ontology question reduces to. --from/--to each
accept a single concept id, a trailing-slash prefix ('tasks/' matches every id starting with that
literal string — one rule, no glob), or are repeatable for a union (OR) within that one flag;
giving BOTH --from and --to ANDs them. Dangling edges (a link to a doc that doesn't exist yet) are
included.

Options:
  --from <id|prefix/>  Restrict to edges whose source matches this id or prefix (repeatable —
                       union/OR across repeats)
  --to <id|prefix/>    Restrict to edges whose target matches this id or prefix (repeatable —
                       union/OR across repeats)
  --text <t>           Exact-match filter over the whole filtered edge set (same semantics as
                       'link show --text', scoped to --from/--to instead of one concept)
  --limit <n>          Cap the returned edge rows (default: 100; 0 = unlimited); count always
                       reports the true (post-filter) total
${LINK_COMMON_OPTIONS}

Examples:
  superbee link list --from tasks/
  superbee link list --to tasks/review --text "depends on"
`;

/** Bounded compare-and-swap retry budget for `link add` (a concurrent writer moved the source doc). */
const LINK_ADD_MAX_ATTEMPTS = 5;

export interface LinkCliDeps {
  stdout: (s: string) => void;
  /**
   * The opportunistic board-freshness trigger `link show` (the READ verb only — never `link add`)
   * runs before serving a LOCAL read (default: autopull.ts's `maybeAutoPull`).
   */
  autoPull?: (dir?: string) => Promise<unknown>;
}

/** A doc's `type` field, or "" when absent/non-string (mirrors `status.ts`'s own `docType`). */
function docType(doc: OkfDocument): string {
  return typeof doc.frontmatter.type === "string" ? doc.frontmatter.type : "";
}

/**
 * Write-time type-conformance lint for a just-written link (graph lints unit): if `text` exactly
 * matches a declared typed-edge vocabulary entry, verify the ACTUAL source/target kinds against the
 * declaration (a mismatch is a `LINK_TYPE_VIOLATION`); if `text` matches a declared type only
 * case-insensitively, warn naming the declared spelling (`LINK_TYPE_CASE_VARIANT`) — no edit-distance
 * matching. Untyped links (no match, in any casing) return no warnings. Never throws for a missing
 * target doc (a dangling target just skips the target-kind half of the check — unresolved links are
 * `status`'s existing concern); a conventions-free bundle (no kind declares any `links`) returns
 * immediately with zero extra I/O beyond the registry load every write command already pays for.
 */
async function lintLinkType(
  bundle: Bundle,
  args: { sourceType: string; text: string; to: string; remoteUrl?: string },
  registry: KindRegistry,
): Promise<ValidationWarning[]> {
  const declarations = collectLinkDeclarations(registry);
  if (declarations.size === 0) return [];

  const exact = declarations.get(args.text);
  if (exact && exact.length > 0) {
    // An exact-match text is the only case that needs the target doc's actual type — a near-miss
    // (or no match at all) never pays for this extra read.
    let targetType: string | undefined;
    let targetResolved = true;
    try {
      targetType = docType(await readDoc(bundle, args.to));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        targetResolved = false;
      } else {
        throw classifyBundleError(err, args.remoteUrl);
      }
    }
    const matched = exact.find((d) => d.governs === args.sourceType) ?? exact[0]!;
    const sourceOk = exact.some((d) => d.governs === args.sourceType);
    const targetOk = !targetResolved || targetType === matched.target;
    if (!sourceOk || !targetOk) {
      return [
        {
          code: "LINK_TYPE_VIOLATION",
          message:
            `'${args.text}' is declared by '${matched.governs}' -> ${matched.target}; this link is ` +
            `${args.sourceType || "(untyped)"} -> ${targetResolved ? targetType || "(untyped)" : "(unresolved)"}.`,
          field: "text",
          severity: "warning",
        },
      ];
    }
    return [];
  }

  // No exact match: a same-spelling-different-case near miss ('Contains' vs 'contains') warns
  // naming the declared spelling.
  for (const declaredText of declarations.keys()) {
    if (declaredText.toLowerCase() === args.text.toLowerCase()) {
      return [
        {
          code: "LINK_TYPE_CASE_VARIANT",
          message: `'${args.text}' is a case-variant of the declared link type '${declaredText}' — did you mean --text '${declaredText}'?`,
          field: "text",
          severity: "warning",
        },
      ];
    }
  }
  return [];
}

/**
 * Warn when a newly linked local target is absent. Remote deliberately skips this advisory to
 * avoid adding a HEAD request; non-absence read failures propagate to the post-write fallback.
 */
async function targetAbsentWarning(
  bundle: Bundle,
  to: string,
  remoteUrl: string | undefined,
): Promise<ValidationWarning | undefined> {
  if (remoteUrl !== undefined) return undefined;
  try {
    await readDoc(bundle, to);
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return {
      code: "LINK_TARGET_ABSENT",
      message:
        `target '${to}' has no document yet — this link is a forward-declaration (dangling links ` +
        `stay allowed); create it with \`${cliInvocation()} doc write ${to} --type <t>\`.`,
      field: "to",
      severity: "warning",
    };
  }
}

export async function link(argv: string[], deps: Partial<LinkCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "add") return linkAdd(rest, stdout);
  if (sub === "show") return linkShow(rest, stdout, deps.autoPull);
  if (sub === "list") return linkList(rest, stdout);
  if (sub === "-h" || sub === "--help" || sub === undefined) {
    stdout(LINK_USAGE);
    return;
  }
  throw new CliError("USAGE", `unknown link subcommand: ${sub} (expected add|show|list)`, {
    help: `${cliInvocation()} link --help`,
  });
}

/**
 * The near-miss hint for a `--text` filter that matched nothing: names the distinct link texts
 * that ARE present (sorted), so a typo/case near-miss reads as "here's what's actually here"
 * instead of "empty graph". Shared VERBATIM by `link show` and `link list` — one hint, never a
 * second independently-worded near-miss message (gate 3's "one X" spirit applied to CLI prose,
 * not just engine code). `scope` supplies the caller-specific qualifier `link show` needs
 * ("in either direction", since it filters two link lists at once) that `link list`'s single
 * filtered edge list has no equivalent for (pass "").
 */
function nearMissTextHint(textFilter: string, textsPresent: string[], scope: string): string {
  if (textsPresent.length === 0) {
    return `no links matched --text '${textFilter}'${scope} — this is a definitive empty result, not an error`;
  }
  const TEXTS_SHOWN = 8;
  const shown = textsPresent
    .slice(0, TEXTS_SHOWN)
    .map((t) => `'${t}'`)
    .join(", ");
  const more = textsPresent.length > TEXTS_SHOWN ? ` (+${textsPresent.length - TEXTS_SHOWN} more)` : "";
  return `no links matched --text '${textFilter}'${scope} (exact match) — link texts present here: ${shown}${more}`;
}

/** Options for {@link addLink} — a subset of `link add`'s own flags, since callers other than
 * the CLI subcommand (e.g. `new --link`) never expose `--dir`/`--json`/etc. themselves. */
export interface AddLinkOptions {
  /** Link display text (default: the target id, mirroring `link add`'s own default). */
  text?: string;
  /** Preserve the source's existing timestamp instead of refreshing it to now(). */
  keepTimestamp?: boolean;
  /** Threaded into `classifyBundleError` so a `--remote` mutation's AUTH_REQUIRED carries a
   * copy-pastable hint (mirrors every other bundle-mutating command). */
  remoteUrl?: string;
  /** Advisory attribution, already resolved at the CLI boundary. */
  actor?: string;
}

export interface AddLinkResult {
  /** The source doc's id (post-write, or as read on the idempotent no-op path). */
  from: string;
  /** The link's exact canonical target after CLI path-alias resolution. */
  normalizedTo: string;
  href: string;
  text: string;
  /** false when the source already carries this normalized target + exact display text. */
  changed: boolean;
  /** The source document's current version after this call (written head or idempotent no-op head). */
  version: Version;
  /** Advisory type-conformance or local target-existence findings from the successful write. */
  warnings?: ValidationWarning[];
}

/**
 * Core link-add mutation: idempotent versioned-read → idempotency check → CAS write (bounded
 * retry) → write-time link guidance. Extracted out of `linkAdd` below (the CLI
 * subcommand, which composes this into its own receipt shape unchanged) so `new --link`
 * (`commands/new.ts` — one-step create+link) rides the EXACT SAME machinery instead of a second
 * hand-rolled link-writer (gate 3: one link resolver, no parallel implementation).
 */
export async function addLink(
  bundle: Bundle,
  from: string,
  to: string,
  opts: AddLinkOptions = {},
): Promise<AddLinkResult> {
  const requestedText = to;
  from = await resolveConceptIdCliArgument(bundle, from);
  to = await resolveConceptIdCliArgument(bundle, to);
  const text = opts.text?.trim() || requestedText;
  const href = relativeHref(from, to);
  // Resolve the exact canonical href we emit through core's one link resolver so idempotency and
  // graph parsing compare the same edge. CLI aliases were normalized at the boundary above.
  const normalizedTo = resolveConceptId(from, href) ?? to;

  // Reserved files (index.md/log.md, any directory level) are never concept documents, so they
  // can never be a link target — core's `resolveConceptId` now drops such a link from the parsed
  // edge set entirely (it never becomes a concept edge), which would otherwise silently break the
  // idempotency check below (the parsed edge could never match the target + text identity and
  // observe a link it can no longer see, so a re-run would append a duplicate link on every
  // invocation instead of converging to `changed:false`). Reject up front with a structured error
  // instead — a pure, no-I/O check via the SAME reserved-name predicate core uses.
  if (isReservedFile(pathFromConceptId(normalizedTo))) {
    throw new CliError(
      "USAGE",
      `'${to}' names a reserved OKF file (index.md/log.md), which is never a concept document and cannot be a link target`,
      { help: `${cliInvocation()} list` },
    );
  }

  // Link addition is an ordinary body patch through the shared document mutation service. That
  // service owns CAS/retry, edition-aware clocks, actor persistence, no-op receipts, and Kind
  // validation; this command owns only the markdown-link candidate and graph guidance.
  const registry = await loadKinds(bundle);
  let sourceTypeAtWrite = "";
  const mutation = await mutateDoc({
    bundle,
    id: from,
    mode: "patch",
    onAbsent: "fail",
    registry,
    strict: false,
    helpOnKindReject: `${cliInvocation()} kinds`,
    remoteUrl: opts.remoteUrl,
    actor: opts.actor,
    persistActor: true,
    maxAttempts: LINK_ADD_MAX_ATTEMPTS,
    buildCandidate: (source, context) => {
      const existing = source!;
      sourceTypeAtWrite = docType(existing);
      // Link text is the relationship-type signal, so identity is target + exact text. Re-adding
      // that edge is a no-op; different text to the same target is a distinct semantic edge.
      const already = parseLinks(bundle, existing).some((l) => l.to === normalizedTo && l.text === text);
      if (already) return { frontmatter: { ...existing.frontmatter }, body: existing.body };

      const trimmed = existing.body.replace(/\s*$/, "");
      const nextBody = `${trimmed}${trimmed ? "\n\n" : ""}[${text}](${href})\n`;
      const nextFrontmatter = { ...existing.frontmatter };
      // v0.1 retains link add's historical explicit clock refresh. v0.2's `generated.at` is
      // advanced centrally by mutateDocument, and top-level timestamp/actor stay untouched.
      if (context.okfVersion !== "0.2" && !opts.keepTimestamp) {
        nextFrontmatter.timestamp = new Date().toISOString();
      }
      return { frontmatter: nextFrontmatter, body: nextBody };
    },
    errors: {
      notFound: () => new CliError("NOT_FOUND", `no source concept at id '${from}'`, {
        help: `${cliInvocation()} list`,
      }),
      staleHead: (error) => new CliError("STALE_HEAD", error.message, {
        help: `${cliInvocation()} link add ${from} ${to}`,
      }),
    },
  });

  if (!mutation.changed) {
    return { from: mutation.doc.id, normalizedTo, href, text, changed: false, version: mutation.version };
  }
    // Write-time type-conformance lint (graph lints unit) + target-existence honesty (link-add-
    // target-honesty unit) — both warn-only, never blocking: the link is already written by the
    // time either runs. Both post-write checks are skipped entirely on the idempotent no-op path.
    let warnings: ValidationWarning[];
    try {
      warnings = await lintLinkType(bundle, {
        sourceType: sourceTypeAtWrite,
        text,
        to: normalizedTo,
        remoteUrl: opts.remoteUrl,
      }, registry);
      const absent = await targetAbsentWarning(bundle, normalizedTo, opts.remoteUrl);
      if (absent) warnings.push(absent);
    } catch (err) {
      // The mutation is already durable and its version is known. Both checks above are
      // explicitly advisory, so a registry/target read failure must not erase the successful
      // write outcome or make a caller retry an operation that already landed. Surface the
      // degraded check as a warning while preserving the truthful post-write version.
      warnings = [
        {
          code: "LINK_LINT_UNAVAILABLE",
          message: `link was written, but link-metadata guidance was unavailable: ${err instanceof Error ? err.message : String(err)}`,
          field: "text",
          severity: "warning",
        },
      ];
    }
    return {
      from: mutation.doc.id,
      normalizedTo,
      href,
      text,
      changed: true,
      version: mutation.version,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
}

async function linkAdd(argv: string[], stdout: (s: string) => void): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          text: { type: "string" },
          "keep-timestamp": { type: "boolean" },
          actor: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.linkAdd,
  );
  if (values.help) {
    stdout(LINK_ADD_USAGE);
    return;
  }

  const from = positionals[0]?.trim();
  const to = positionals[1]?.trim();
  if (!from || !to) {
    throw new CliError("USAGE", "link add requires <from> and <to> concept ids", {
      help: `${cliInvocation()} link add <from> <to>`,
    });
  }
  const actor = resolveActor(values.actor, { help: `${cliInvocation()} link add ${from} ${to} --actor <name>` });

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const mode = resolveMode(values);

  const result = await addLink(bundle, from, to, {
    text: values.text,
    keepTimestamp: values["keep-timestamp"],
    remoteUrl: values.remote,
    actor,
  });

  if (!result.changed) {
    stdout(
      render(
        {
          link: "exists",
          from: result.from,
          to: result.normalizedTo,
          changed: false,
          help: [`${cliInvocation()} link show ${result.normalizedTo}`],
        },
        mode,
      ),
    );
    return;
  }

  const receipt: Record<string, unknown> = {
    link: "added",
    from: result.from,
    to,
    href: result.href,
    text: result.text,
    changed: true,
    help: [`${cliInvocation()} link show ${to}`],
  };
  if (result.warnings && result.warnings.length > 0) receipt.warnings = result.warnings;
  stdout(render(receipt, mode));
}

async function linkShow(
  argv: string[],
  stdout: (s: string) => void,
  autoPull?: (dir?: string) => Promise<unknown>,
): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          limit: { type: "string" },
          text: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.linkShow,
  );
  if (values.help) {
    stdout(LINK_SHOW_USAGE);
    return;
  }

  // Row cap (AXI §9): a heavily-cited hub concept can have a very large "cited by" set — bound both
  // link lists by default like `status`/`list` do, while `outbound_count`/`backlink_count` keep
  // reporting the true (post-filter) totals. Default 50; 0 = unlimited.
  const DEFAULT_LIMIT = 50;
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)", {
        help: `${cliInvocation()} link show <id> --limit 50`,
      });
    }
    limit = Number(raw);
  }

  // `--text` is an exact-match filter over BOTH directions' link text — not a second derivation,
  // just a lens over the same edges `parseLinks`/`backlinks` already resolved. An empty/missing
  // value is a usage error (a filter that matches nothing is a valid result; a filter that names
  // nothing is a mistake).
  let textFilter: string | undefined;
  if (values.text !== undefined) {
    textFilter = values.text.trim();
    if (!textFilter) {
      throw new CliError("USAGE", "--text requires a non-empty value to filter on", {
        help: `${cliInvocation()} link show <id> --text <t>`,
      });
    }
  }

  const rawId = positionals[0]?.trim();
  if (!rawId) {
    throw new CliError("USAGE", "link show requires a concept <id>", {
      help: `${cliInvocation()} link show <id>`,
    });
  }
  // A trailing slash is an intentional exact, impossible-doc selector on `link show` (historical
  // contract: zero outbound/backlinks), not the prefix selector that only `link list` supports.
  const impossibleExactId = rawId.endsWith("/");
  let id = impossibleExactId ? rawId : conceptIdFromCliArgument(rawId);

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  // Opportunistic board freshness (autopull.ts): silent, fail-soft, detection-gated — see list.ts.
  if (!remote) await (autoPull ?? maybeAutoPull)(values.dir);
  const bundle = await openBundle(values.dir, remote);
  if (!impossibleExactId) id = await resolveConceptIdCliArgument(bundle, rawId);

  // Outbound links come from the source doc (missing doc → NOT_FOUND). Backlinks are derived over the
  // whole bundle and are valid even for a not-yet-written target, so they are computed regardless.
  let outbound: { to: string; text: string; href: string }[] = [];
  let exists = !impossibleExactId;
  if (!impossibleExactId) {
    try {
      const source = await readDoc(bundle, id);
      outbound = parseLinks(bundle, source).map((l) => ({ to: l.to, text: l.text, href: l.href }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw classifyBundleError(err, values.remote);
      }
      // ENOENT: no document at this id YET. NOT an error — a concept can be CITED before it is written
      // (backlinks are derived over the whole bundle and stay meaningful). Report `exists:false` so an
      // agent can distinguish "doc exists, zero outbound links" from "no doc here" — which a bare
      // outbound_count:0 could not (the #5 gap: `link add` errors NOT_FOUND on the same id; `link show`
      // must not silently look identical to an existing-but-linkless doc).
      exists = false;
    }
  }

  const inbound = await backlinks(bundle, id);
  // Distinct link texts across BOTH directions, captured BEFORE filtering — fuel for the
  // zero-match near-miss hint below. Exact match means a typo ('contain' for 'contains') would
  // otherwise read as an empty graph; naming what IS there mirrors `doc read --field`'s
  // absent-field behavior.
  const textsPresent =
    textFilter === undefined
      ? []
      : [...new Set([...outbound, ...inbound].map((l) => l.text))].sort((a, b) => a.localeCompare(b));
  if (textFilter !== undefined) {
    outbound = outbound.filter((l) => l.text === textFilter);
  }
  // `inboundMatched` is the FILTERED set whenever `--text` is set — the honest post-filter total
  // every downstream count/help message below reads from, never the unfiltered `inbound` length
  // dressed up as if it were the filtered count.
  const inboundMatched = textFilter !== undefined ? inbound.filter((l) => l.text === textFilter) : inbound;
  const outboundShown = limit > 0 ? outbound.slice(0, limit) : outbound;
  const inboundShown = limit > 0 ? inboundMatched.slice(0, limit) : inboundMatched;
  const payload: Record<string, unknown> = {
    id,
    exists,
    outbound_count: outbound.length,
    outbound: outboundShown,
    backlink_count: inboundMatched.length,
    backlinks: inboundShown.map((l) => ({ from: l.from, text: l.text })),
  };
  if (textFilter !== undefined) payload.text_filter = textFilter;

  const help: string[] = [];
  if (outboundShown.length < outbound.length || inboundShown.length < inboundMatched.length) {
    help.push(
      `showing ${outboundShown.length}/${outbound.length} outbound + ${inboundShown.length}/${inboundMatched.length} backlinks — run \`${cliInvocation()} link show ${id} --limit 0\` for all`,
    );
  }
  if (textFilter !== undefined && outbound.length === 0 && inboundMatched.length === 0) {
    // `exists:false` + zero texts present would otherwise render the plain "definitive empty
    // result" branch of the hint below for a doc that has no document AT ALL — that case gets
    // its own, more specific message from the `!exists` block further down instead.
    if (textsPresent.length > 0 || exists) {
      help.push(nearMissTextHint(textFilter, textsPresent, " in either direction"));
    }
  }
  if (!exists) {
    help.push(
      inboundMatched.length > 0
        ? `'${id}' has no document yet but is cited by ${inboundMatched.length} — run \`${cliInvocation()} doc write ${id} --type <t>\` to create it`
        : `no concept at '${id}': it has no document and nothing links to it${textFilter !== undefined ? ` matching --text '${textFilter}'` : ""}`,
    );
  }
  if (help.length > 0) payload.help = help;
  stdout(render(payload, resolveMode(values)));
}

/**
 * `link list` (graph-query-v0): the whole-bundle derived edge list, filtered — a thin CLI face
 * over core `queryEdges`. Row schema is AXI-minimal (`{from, to, text}` + `count`), no `--fields`
 * hatch (no consumer has asked for one yet). `--from`/`--to` are repeatable (union within the
 * flag, AND across the two flags) and each accept an exact id or a trailing-slash prefix. CLI
 * path aliases are resolved once before entering core's exact canonical selector contract. Over
 * `--remote`, `queryEdges` rides `query`'s existing whole-bundle `readMany` batch (exactly like
 * `backlinks`/`link show` already do today) — one round trip, no wire change.
 */
async function linkList(argv: string[], stdout: (s: string) => void): Promise<void> {
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          from: { type: "string", multiple: true },
          to: { type: "string", multiple: true },
          text: { type: "string" },
          limit: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.linkList,
  );
  if (values.help) {
    stdout(LINK_LIST_USAGE);
    return;
  }

  // Exact match only (never substring/regex) — the same rule `link show --text` already applies,
  // now over the whole filtered edge set instead of one concept's two link lists.
  let textFilter: string | undefined;
  if (values.text !== undefined) {
    textFilter = values.text.trim();
    if (!textFilter) {
      throw new CliError("USAGE", "--text requires a non-empty value to filter on", {
        help: `${cliInvocation()} link list --text <t>`,
      });
    }
  }

  // --from/--to: trim each repeated value and reject a blank/empty selector with USAGE rather than
  // silently matching nothing — an empty string can never be a valid id/prefix selector, so
  // `--from ''` is almost certainly a mistake, not a deliberate "match nothing" request.
  const fromValues = (values.from ?? []).map((v) => v.trim());
  if (fromValues.some((v) => v === "")) {
    throw new CliError("USAGE", "--from requires a non-empty id or prefix (got an empty/blank value)", {
      help: `${cliInvocation()} link list --from <id|prefix/>`,
    });
  }
  const toValues = (values.to ?? []).map((v) => v.trim());
  if (toValues.some((v) => v === "")) {
    throw new CliError("USAGE", "--to requires a non-empty id or prefix (got an empty/blank value)", {
      help: `${cliInvocation()} link list --to <id|prefix/>`,
    });
  }

  // Row cap (AXI §9), mirroring `list`'s own default/semantics (this is a bundle-wide scan, the
  // same shape of question) rather than `link show`'s smaller per-concept default of 50.
  const DEFAULT_LIMIT = 100;
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)", {
        help: `${cliInvocation()} link list --limit 100`,
      });
    }
    limit = Number(raw);
  }

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));

  const resolveSelector = async (raw: string): Promise<string> => {
    if (raw.endsWith("/")) return `${conceptIdFromCliArgument(raw.replace(/\/+$/, ""))}/`;
    return resolveConceptIdCliArgument(bundle, raw);
  };
  const [fromSelectors, toSelectors] = await Promise.all([
    Promise.all(fromValues.map(resolveSelector)),
    Promise.all(toValues.map(resolveSelector)),
  ]);

  // The scope filter carries ONLY --from/--to, never --text: this fetches the from/to-scoped edge
  // set in exactly ONE queryEdges call (one round trip over --remote) regardless of whether --text
  // is also given. --text is then applied as a local exact-match filter over that same
  // already-fetched list — so a zero-match --text query costs ONE scan, not two (the near-miss
  // hint below reuses these SAME scoped edges for its "texts present" list rather than re-scanning).
  const scopeFilter: EdgeFilter = {};
  if (fromSelectors.length > 0) scopeFilter.from = fromSelectors;
  if (toSelectors.length > 0) scopeFilter.to = toSelectors;

  let scopedEdges: Link[];
  try {
    scopedEdges = await queryEdges(bundle, scopeFilter);
  } catch (err) {
    throw classifyBundleError(err, values.remote);
  }

  const edges = textFilter !== undefined ? scopedEdges.filter((e) => e.text === textFilter) : scopedEdges;
  const rows = edges.map((e) => ({ from: e.from, to: e.to, text: e.text }));
  const total = rows.length;
  const shownRows = limit > 0 ? rows.slice(0, limit) : rows;
  const truncated = shownRows.length < total;

  const out: Record<string, unknown> = { count: total, edges: shownRows };
  if (truncated) out.shown = shownRows.length;

  const help: string[] = [];
  if (truncated) {
    help.push(
      `showing ${shownRows.length} of ${total} — run \`${cliInvocation()} link list --limit 0\` (or a higher --limit) for all`,
    );
  }
  // Zero-match with --text: name the distinct texts present among the SAME --from/--to-scoped
  // edges already fetched above (no second scan) — the same near-miss hint `link show` gives.
  if (textFilter !== undefined && total === 0) {
    const textsPresent = [...new Set(scopedEdges.map((e) => e.text))].sort((a, b) => a.localeCompare(b));
    help.push(nearMissTextHint(textFilter, textsPresent, ""));
  }
  if (help.length > 0) out.help = help;
  stdout(render(out, resolveMode(values)));
}
