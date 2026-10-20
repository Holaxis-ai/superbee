import { renderUsage } from "../output.js";
// `superbee status`: a read-only, whole-bundle health report (bundle lint).
//
// The findings are computed by core (`bundleHealth`, `@superbee/core/bundle-health`) from one read
// of the bundle; this command is one client of it. It owns what only a client can: the flags and
// help, the `--limit` row caps, the record's key order and omit-when-empty rules, the `help` and
// `note` prose, the home and `sync` blocks, and `--with`/`--with-deps` binding (Git, filesystem and
// catalog aware), which core calls as a hook at its own point in the sequence.
//
// Findings are REPORTS, not errors: exit is ALWAYS 0 once the analysis runs (a bad invocation or a
// missing bundle still exits USAGE/NOT_FOUND as usual, via the owned parser/openBundle). A future
// `--fail-on-findings` CI flag is intentionally NOT built here.
//
// Duplicate-id detection (the old v1.1 wishlist item) is DELIBERATELY DROPPED: a concept id IS its
// storage path, so ids are structurally unique per backend — there is nothing to detect.
import { parseArgs } from "node:util";
import { bundleHealth, type BundleHealthReport } from "@superbee/core/bundle-health";
import { resolveBundleBindings, type BindingProblem } from "../bundle-bindings.js";
import { trustCountsRowFromCounts } from "../trust.js";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { hostedCheckoutAt, maybeAutoPull } from "../autopull.js";
import { CliError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { bundleHomeAt, gitBoardSyncBlock, unboundCopyOf } from "../bundle-home.js";
import { commandFragment, commandToken } from "../command-text.js";

export const STATUS_USAGE = `superbee status — read-only whole-bundle health report (bundle lint)

Usage:
  superbee status [--limit <n>] [--with <alias>=<path|label>]... [--with-deps] [--dir <path> | --remote <url>]

Runs, in ONE pass over the bundle: a kind-conformance lint (against any declared conventions/,
reusing the SAME validator 'doc write'/'new' use), an unresolved-link scan (a link whose target
isn't in the bundle — informational, since OKF permits links to not-yet-written knowledge; external
links are excluded entirely), an orphan scan (isolated content docs once a concept graph exists),
a freshness sweep over standard 'stale_after' instants and kinds that declare a horizon
(an elapsed absolute instant or exceeded horizon is 'stale'; a horizon-governed doc with no usable
meaningful-change time is counted 'no_timestamp'), and two graph lints over any declared
'links'/'expects_inbound' vocabulary (see
'kinds --help'): edges violating a declared typed-edge type ('link_type_violations') and kind
instances missing a declared inbound expectation ('missing_expected_links'), plus two lints over
the bundle's View surface (legacy locations included; the legacy 'Page' kind name no longer
registers — see 'legacy_naming'): registered View docs whose entry blob is missing
('dangling_view_entries') and View-typed docs failing the registration grammar
('invalid_view_registrations'). Duplicate-id detection is not offered: an id IS its storage path,
so ids are structurally unique.

Cross-bundle links ('[text](okf://<alias>/<path>.md)', the path relative to the TARGET bundle's
root) are checked against the aliases this bundle declares in 'docs/dependencies'. Nothing outside
this bundle is read unless you name it: '--with alias=<value>' binds one copy (a path when the value
contains '/' or '\\', starts with '.' or '~', or is drive-qualified; otherwise a catalog label; a
bare value that is both a label and a directory here is refused), and '--with-deps' binds each
declared 'path', only inside this bundle's git repository. A relative '../' link to another bundle
is not followed; write it as okf:// instead.

Category semantics (one line each):
  malformed          A document whose YAML frontmatter cannot be parsed at all — it is skipped by
                      every scan (so it never blinds this report) and named here with the parser
                      error; fix its YAML or remove the file. This is the headline finding.
  kind_warnings      Frontmatter/section violations against a doc's OWN declared kind (a per-doc
                      lint; see 'kinds').
  conformance_debt   Count of GOVERNED DOCS carrying at least one FRONTMATTER-level kind violation
                      (a missing required field, an out-of-enum value, wrong arity, or a value not
                      matching its declared fields.types type) — a per-DOC,
                      frontmatter-only signal, deliberately narrower than 'kind_warnings' (a
                      per-VIOLATION total that also counts body-section violations). Present (even
                      at 0) whenever the bundle declares any kind at all; absent on a
                      conventions-free bundle. See 'doc update' to fix a listed doc.
  unresolved_links   A link whose target isn't in the queried doc set — informational (OKF permits
                      links to not-yet-written knowledge), not broken.
  orphans            Content docs isolated from an established concept graph: no inbound or
                      outbound link to another bundle doc. This finding stays quiet until the
                      bundle has at least one resolved cross-document link. Graph roots (outbound
                      but no inbound), definition/metadata docs (Convention, registered View,
                      references/* Reference, docs/bundle Bundle Name), and docs already named by
                      another graph finding are excluded. Each remaining row is actionable: link
                      it into the graph or delete it if it is unintended. Self-links do not count.
  stale              A doc on/after its standard 'stale_after' instant, or a governed doc whose
                      meaningful-change time is older than its kind's freshness horizon.
  invalid_stale_after  A v0.2 doc carrying an unreadable 'stale_after' (including date-only values).
                      Its deadline cannot be evaluated; the stored value is preserved. Applies
                      without a Kind or horizon, including terminal and untyped docs. Omitted
                      when none are found, and always absent on v0.1. Fix with
                      'doc update <id> --stale-after <ISO-8601 instant with Z or UTC offset>'.
  invalid_timestamps  Count of invalid standard v0.2 timestamp FIELD OCCURRENCES, not documents:
                      generated.at, verified.at (mapping or list), stale_after, source
                      last_modified, and shared/per-source usage_window.from/to. Bounded rows
                      in 'invalid_timestamp_fields' name id, type, field, and the stored value.
                      Date-only, zone-less, malformed, and non-string values remain unchanged;
                      applies without a Kind or horizon, including terminal and untyped docs.
                      Omitted when none are found, and always absent on v0.1. Deadlines also
                      remain in the compatible 'invalid_stale_after' category.
  invalid_legacy_timestamps
                      Invalid effective legacy timestamp clocks in v0.2, including ungoverned docs.
                      Separate from invalid_timestamps; suppressed when generated.at is selected.
                      Bounded rows in invalid_legacy_timestamp_fields retain the stored value.
                      Repair from evidence of the intended instant, or remove the optional field.
  no_timestamp       A governed doc with no usable timestamp (missing OR malformed) — it cannot be
                      judged stale or fresh at all, so it is counted separately from 'stale'.
  trust              OKF v0.2 trust tiers (SPEC 5.3) counted once per doc from its 'verified'
                      events: 'human_reviewed' (a human:<id> verifier), 'machine_confirmed' (only
                      process:/producer verifiers), 'unverified' (no events). A bare single-event
                      mapping counts as one event. Present on a v0.2 bundle with at least one doc;
                      a v0.1 bundle defines no trust family. See 'doc verify' to add an event.
  registry_warnings  Malformed conventions or v0.2 workflow status collisions — a problem in
                      the schema declaration, not in a doc that kind governs.
  link_type_violations  An edge whose text EXACTLY matches a declared typed-edge vocabulary entry
                      (some kind's 'links' map) but the actual source and/or target doc's type
                      doesn't conform to that declaration — the same rule 'link add' warns on at
                      write time, applied bundle-wide.
  missing_expected_links  A kind instance whose OWN kind declares 'expects_inbound' but lacks at
                      least one conforming inbound edge (exact text match AND the citing doc's
                      type matches the expected source kind). Rows carry the instance's 'status'
                      field value when its kind declares one (the triage signal). An instance
                      whose OWN kind declares a terminal set of field values (see 'kinds --help')
                      AND whose frontmatter currently matches it is EXCLUDED from this count and
                      its rows (it's noise — a done/canceled instance doesn't need the expected
                      edge anymore); the top-level 'terminal_skipped' field counts the INSTANCES
                      skipped before this lint evaluated them — not findings suppressed (a skipped
                      instance might have linted clean anyway) — present only when > 0. A kind with no terminal
                      declaration is unaffected (every instance still counts, exactly as before
                      terminal declarations existed). Non-terminal instances sort first: by the
                      declared terminal set when the kind has one, else by the legacy hardcoded
                      status === "done" fallback.
  dangling_view_entries  A registered View doc — legacy LOCATIONS included, via the same
                      recognition the 'ui' launcher uses, no convention needed — whose 'entry'
                      names a blob that does not exist: a never-promoted, typo'd, or
                      since-deleted key mints a view that serves nothing. Rows name registry
                      id -> missing entry key. Present (even at 0) whenever the bundle carries
                      any View-typed doc; absent otherwise.
  invalid_view_registrations  A doc declaring the View kind name that FAILS the registration
                      grammar, so the 'ui' launcher cannot mint or serve it at all: its id is
                      outside a registry prefix ('views-registry/', or the legacy location)
                      and/or its 'entry' is not a valid entry key ('views/…', or the legacy
                      prefix). Rows name the doc id and the failing leg(s) — 'id',
                      'entry', or 'id+entry'. Fix by moving the doc under a registry prefix /
                      pointing 'entry' at a real 'views/…' key. Same presence rule as
                      'dangling_view_entries'.
  cross_bundle_links  Qualified (okf:) links in this bundle, malformed ones included. This and the
                      two counts below are present only when the bundle has 'docs/dependencies' or
                      any okf: link.
  cross_bundle_unresolved  Qualified links that did not resolve; 'cross_bundle_unresolved_rows' names
                      from, href, reason (bundle_unavailable | pin_mismatch | target_missing |
                      unknown_alias | invalid_ref) and detail.
  cross_bundle_unchecked  Qualified links whose declared alias has no copy bound (no --with for it).
  dependencies       One row per declared alias: bundle_id, state (unbound | ok | bundle_unavailable |
                      pin_mismatch), bound (the copy's root, or null) and pin. A commit pin holds
                      when the bound copy's subtree at HEAD equals it and has no uncommitted change.
  dependency_problems  Defects in 'docs/dependencies' (DEP_* codes) and in binding (BIND_* codes,
                      e.g. a --with-deps path outside the repository).
  cross_bundle_link_type_violations_rows  A qualified link whose text is a declared type that does
                      not conform (wrong source kind, or the declaration names another or no alias),
                      or a local link under a qualified declaration ('links: {pours: "beers:Beer"}').
                      An explicitly bound resolved target must have the declared kind. Inspect the
                      target's type and the source convention's links declaration when this row appears.
                      Unbound, unavailable or unresolved targets remain unchecked/unresolved, not certified.
                      No foreign schema is loaded; link add without bindings retains metadata-only lint.
  okf_upgrade        Present only when a legacy bundle declares workflow 'status' values that
                      collide with the current standard lifecycle vocabulary. The bundle remains supported;
                      this is migration-readiness guidance, never an automatic rewrite.
  legacy_naming      FINDING: the legacy View names are no longer accepted by the runtime — a
                      doc typed 'Page' (the legacy name for the 'View' kind) does not register
                      at all, and a legacy 'bridge:' capability field grants nothing (the doc
                      resolves to access: none). Counts + rows name every legacy Page-typed doc,
                      every View-kind doc carrying an own legacy 'bridge' field, and every
                      Convention still governing the legacy 'Page' name (silent scaffolding);
                      run the repo's scripts/migrate-legacy-view-names.mjs to rename them in place. Also
                      reports (informational) items under the legacy pages-registry//pages/ id
                      prefixes — those LOCATIONS remain recognized; relocation is a separate
                      open decision. Omitted when the bundle carries none of the above.

The report leads with the bundle's 'home' (local, git or hosted) and a 'sync' block for it, read
from local state only: no request, no fetch, and no automatic pull for a hosted checkout. A local
bundle reports 'sync: none (local only)'.

For a Git board, the 'sync' block reads local Git (what the last fetch saw, never a new fetch):
  channel            branch (the provisioned 'board' worktree) | in-tree (committed with the code)
  branch, upstream   The checked-out branch and its tracking ref (null when there is none)
  state              clean | unsent_changes | behind | diverged | not_shared (no upstream yet)
  ahead              Board commits not yet pushed (null without an upstream)
  behind             Upstream board commits not yet pulled, as of the last fetch
  uncommitted        Changed files not yet committed to the board
  last_fetch         When this clone last fetched (null when it never has)

In a hosted checkout (a folder made by 'checkout'), the 'sync' block reads:
  state              clean | unsent_changes | needs_decision (a conflict or a held item) | busy
                      (another command, such as a running sync, holds the checkout)
  unsent             Documents with a change the next sync would send (edited, new or deleted
                      files, and changes recorded but not yet sent); 'unsent_ids' lists the first 5.
  conflicts          Documents changed both here and on the host; 'conflict_ids' lists the first 5.
                      Inspect one with 'sync --inspect --doc <id>'.
  held_files         Files sync cannot send as they stand ('held_rows' names id and reason).
  held_deletions     Deleted files held as a mass delete; the next sync names the release token.
  last_pull          When the last pull completed (null when none has); 'since_pull' is its age.
  stale              True once the last pull is over 30 minutes old, or when there is none.
A 'help' list names 'sync' when there is something to send, resolve or pull.

This is a whole-bundle read (one registry load + one query + one root-index read + two
prefix-scoped blob listings, batched) — acceptable for an explicitly batch-analysis command;
over --remote it remains a bounded set of requests, not a per-doc round trip.

Exit is ALWAYS 0 once the analysis runs: findings are reports, not errors. (A --fail-on-findings CI
flag is a recorded future item, not built here.)

Options:
  --limit <n>             Cap each finding category's row list to <n> rows (default: 20; 0 = unlimited)
  --with <alias>=<value>  Bind a copy of a declared dependency: a path or a catalog label (repeatable)
  --with-deps             Bind each declared dependency 'path' inside this bundle's git repository
  --dir <path>            Bundle directory (default: discovered from the cwd)
  --remote <url>          Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
  --json                  Emit compact JSON instead of TOON
  -h, --help              Show this help
`;

export interface StatusCliDeps {
  stdout: (s: string) => void;
  /** The opportunistic board-freshness trigger (default {@link maybeAutoPull} — autopull.ts). */
  autoPull: (dir?: string) => Promise<unknown>;
  /** The home whose private state holds hosted checkout bindings (default: the OS home). */
  home: string;
  /** The clock the hosted checkout's staleness and the report's freshness are judged by (default: now). */
  now: () => Date;
}

/** AXI list-cap default: 20 rows per finding category unless `--limit` overrides it (0 = unlimited). */
const DEFAULT_LIMIT = 20;

/** A finding category's row list, capped with `shown`/`total` so truncation is always explicit. */
interface Capped<T> {
  shown: number;
  total: number;
  rows: T[];
}

function cap<T>(rows: T[], limit: number): Capped<T> {
  const bounded = limit > 0 ? rows.slice(0, limit) : rows;
  return { shown: bounded.length, total: rows.length, rows: bounded };
}

/**
 * The status record for one report: summary counts first, then the row blocks, each omitted when
 * empty so a clean bundle's report stays a short summary. `bindingProblems` are the binder's rows,
 * listed after core's `DEP_*` rows in `dependency_problems`.
 */
function statusRecord(
  report: BundleHealthReport,
  options: { limit: number; bindingProblems: readonly BindingProblem[] },
): Record<string, unknown> {
  const { limit } = options;
  const malformed = cap(report.malformed, limit);
  const lint = cap(report.kindLint, limit);
  const unresolved = cap(report.unresolvedLinks, limit);
  const orphans = cap(report.orphans, limit);
  const stale = cap(report.stale, limit);
  const noTimestamp = cap(report.noTimestamp, limit);
  const invalidStaleAfter = cap(report.invalidStaleAfter, limit);
  const invalidTimestamps = cap(report.invalidTimestamps, limit);
  const invalidLegacyTimestamps = cap(report.invalidLegacyTimestamps, limit);
  const registryLint = cap(
    report.registryWarnings.map((w): Record<string, unknown> => ({ ...w })),
    limit,
  );
  const linkTypeViolations = cap(report.linkTypeViolations, limit);
  const missingExpectedLinks = cap(report.missingExpectedLinks, limit);
  const conformanceDebt = cap(report.conformanceDebt ?? [], limit);
  const danglingViewEntries = cap(report.views.danglingEntries, limit);
  const invalidViewRegistrations = cap(report.views.invalidRegistrations, limit);

  const out: Record<string, unknown> = {
    docs: report.docs,
    kinds: report.kinds,
    malformed: malformed.total,
    kind_warnings: lint.total,
    unresolved_links: unresolved.total,
    orphans: orphans.total,
    stale: stale.total,
    ...(invalidStaleAfter.total > 0 ? { invalid_stale_after: invalidStaleAfter.total } : {}),
    ...(invalidTimestamps.total > 0 ? { invalid_timestamps: invalidTimestamps.total } : {}),
    ...(invalidLegacyTimestamps.total > 0 ? { invalid_legacy_timestamps: invalidLegacyTimestamps.total } : {}),
    no_timestamp: noTimestamp.total,
    registry_warnings: registryLint.total,
    link_type_violations: linkTypeViolations.total,
    missing_expected_links: missingExpectedLinks.total,
  };
  // Present only for a bundle that declares dependencies or holds any okf: href, so every other
  // bundle's report stays byte-identical.
  if (report.crossBundle) {
    out.cross_bundle_links = report.crossBundle.links;
    out.cross_bundle_unresolved = report.crossBundle.unresolved.length;
    out.cross_bundle_unchecked = report.crossBundle.unchecked;
  }
  if (report.trust) out.trust = trustCountsRowFromCounts(report.trust);
  // Beside the count, unconditionally at the top level (never nested inside the row block below,
  // which is itself omitted when `missing_expected_links` is 0 — a bundle where EVERY matching
  // instance happened to be terminal-skipped would otherwise hide this field entirely). Semantics:
  // INSTANCES skipped BEFORE the missing_expected_links lint evaluated them — not findings
  // suppressed (a skipped instance might have carried its expected edge and linted clean anyway).
  if (report.terminalSkipped > 0) out.terminal_skipped = report.terminalSkipped;
  // Conformance debt: present — even at 0 — whenever the bundle declares ANY kind at all; absent
  // entirely on a conventions-free bundle, which keeps that bundle shape's output BYTE-IDENTICAL to
  // before this field existed (see status.test.ts's byte-identity pin).
  if (report.conformanceDebt !== null) out.conformance_debt = conformanceDebt.total;
  // Present — even at 0 — whenever the bundle carries at least one View-typed doc: "all entries
  // resolvable" / "all registrations valid" are reports worth seeing, while a bundle with no View
  // surface keeps output byte-identical to before these lints existed.
  if (report.views.typed > 0) {
    out.dangling_view_entries = danglingViewEntries.total;
    out.invalid_view_registrations = invalidViewRegistrations.total;
  }
  if (report.okfUpgrade) {
    const statusFieldKinds = cap(report.okfUpgrade.statusFieldRows, limit);
    out.okf_upgrade = {
      current_version: "0.1",
      target_version: "0.2",
      readiness: "blocked",
      blocker: "workflow_status_collision",
      recommended_logical_field: "progress_status",
      status_field_kinds: statusFieldKinds.total,
      affected_documents: report.okfUpgrade.affectedDocuments,
      status_field_rows: statusFieldKinds,
      note:
        "This bundle remains a supported OKF v0.1 bundle. Superbee can author and mutate v0.2, " +
        "but changing index.md alone is not a migration: " +
        "OKF v0.2 reserves top-level status for draft|stable|deprecated, while the listed kinds " +
        "use it for workflow state.",
      help: [
        "Model workflow progress as logical progress_status across conventions, documents, Views, and saved queries before changing okf_version.",
        "Superbee does not currently perform this multi-file migration automatically.",
      ],
    };
  }
  // Row-list blocks are omitted when empty (matching `kinds`/`doc write`'s existing omit-if-empty
  // convention) so a clean bundle's report stays a short summary, not nine empty categories.
  if (malformed.total > 0) out.malformed_docs = malformed;
  if (lint.total > 0) out.kind_lint = lint;
  if (conformanceDebt.total > 0) {
    out.conformance_debt_docs = {
      ...conformanceDebt,
      help:
        `${cliInvocation()} doc update <id> --<field> <value>  — fix a listed doc's missing/invalid ` +
        `field(s); see '${cliInvocation()} kinds' for each governing kind's declared fields`,
    };
  }
  if (unresolved.total > 0) out.unresolved = unresolved;
  if (orphans.total > 0) {
    out.orphan_docs = {
      ...orphans,
      help:
        `${cliInvocation()} link add <from> <id>  — link each listed doc into the graph, ` +
        `or '${cliInvocation()} doc delete <id>' if it is unintended`,
    };
  }
  if (stale.total > 0) out.stale_docs = stale;
  if (invalidStaleAfter.total > 0) {
    out.invalid_stale_after_docs = {
      ...invalidStaleAfter,
      reason: "The stale_after deadline cannot be evaluated: expected an ISO-8601 instant with Z or a UTC offset; date-only and malformed values remain stored unchanged.",
      help: `${cliInvocation()} doc update <id> --stale-after <ISO-8601 instant with Z or UTC offset>`,
    };
  }
  if (invalidTimestamps.total > 0) {
    out.invalid_timestamp_fields = {
      ...invalidTimestamps,
      reason: "Standard OKF timestamps require an ISO-8601 date and time with Z or a UTC offset. Ambiguous or invalid stored values remain unchanged.",
      help: "Choose the intended instant and repair each named field with an explicit UTC offset.",
    };
  }
  if (invalidLegacyTimestamps.total > 0) {
    out.invalid_legacy_timestamp_fields = {
      ...invalidLegacyTimestamps,
      reason: "The effective legacy timestamp is not a valid ISO-8601 date and time with an explicit UTC offset. Stored values remain unchanged.",
      help: "Use evidence of the intended instant to repair timestamp with Z or a numeric UTC offset in the document frontmatter, or remove the optional timestamp. No offset is inferred.",
    };
  }
  if (noTimestamp.total > 0) out.no_timestamp_docs = noTimestamp;
  if (linkTypeViolations.total > 0) out.link_type_violations_rows = linkTypeViolations;
  if (missingExpectedLinks.total > 0) out.missing_expected_links_rows = missingExpectedLinks;
  const dependencyRows = report.crossBundle?.dependencies ?? [];
  const dependencyProblemRows: { code: string; alias: string | null; detail: string }[] = [
    ...(report.crossBundle?.problems ?? []),
    ...options.bindingProblems.map((p) => ({ code: p.code, alias: p.alias, detail: p.detail })),
  ];
  const crossUnresolvedRows = report.crossBundle?.unresolved ?? [];
  if (dependencyRows.length > 0) out.dependencies = cap(dependencyRows, limit);
  if (dependencyProblemRows.length > 0) out.dependency_problems = cap(dependencyProblemRows, limit);
  if (crossUnresolvedRows.length > 0) out.cross_bundle_unresolved_rows = cap(crossUnresolvedRows, limit);
  if (report.crossLinkTypeViolations.length > 0) out.cross_bundle_link_type_violations_rows = cap(report.crossLinkTypeViolations, limit);
  if (danglingViewEntries.total > 0) out.dangling_view_entries_rows = danglingViewEntries;
  if (invalidViewRegistrations.total > 0) out.invalid_view_registrations_rows = invalidViewRegistrations;
  if (registryLint.total > 0) out.registry_lint = registryLint;
  // Omitted entirely on a legacy-free bundle (the `terminal_skipped` present-only-when-relevant
  // idiom) — a clean report stays byte-identical to before this finding existed.
  const pageTyped = cap(report.legacyNaming.pageTyped, limit);
  const bridgeField = cap(report.legacyNaming.bridgeField, limit);
  const pageConvention = cap(report.legacyNaming.pageConvention, limit);
  const legacyPrefix = cap(report.legacyNaming.legacyPrefix, limit);
  if (pageTyped.total > 0 || bridgeField.total > 0 || pageConvention.total > 0 || legacyPrefix.total > 0) {
    // The loud FINDING note (+ the migration-script help) fires only for retired NAMES —
    // instances, legacy fields, OR a convention still declaring the dead kind name; a migrated
    // bundle that simply kept its legacy LOCATIONS (fully supported) gets the milder
    // informational note instead of a call to action it cannot act on.
    const namesPresent = pageTyped.total > 0 || bridgeField.total > 0 || pageConvention.total > 0;
    const legacy: Record<string, unknown> = {
      note: namesPresent
        ? "FINDING — the legacy View names are no longer accepted: a 'type: Page' doc does not " +
          "register (the ui launcher ignores it), a legacy 'bridge:' field grants nothing " +
          "(access resolves to none), and a Convention still governing the legacy 'Page' name " +
          "scaffolds docs the runtime ignores. Legacy pages-registry//pages/ LOCATIONS remain recognized."
        : "informational — items under the legacy pages-registry//pages/ id prefixes; these " +
          "LOCATIONS remain fully recognized (relocation is a separate open decision).",
      page_typed_docs: pageTyped.total,
      bridge_field_docs: bridgeField.total,
      page_convention_docs: pageConvention.total,
      legacy_prefix_items: legacyPrefix.total,
    };
    if (namesPresent) {
      legacy.help =
        "run `node scripts/migrate-legacy-view-names.mjs --dir <bundle-root>` (in the " +
        "Superbee repo) to rename the listed docs in place — types flip to View, " +
        "bridge renames to access, and the shipped View convention is refreshed";
    }
    if (pageTyped.total > 0) legacy.page_typed_rows = pageTyped;
    if (bridgeField.total > 0) legacy.bridge_field_rows = bridgeField;
    if (pageConvention.total > 0) legacy.page_convention_rows = pageConvention;
    if (legacyPrefix.total > 0) legacy.legacy_prefix_rows = legacyPrefix;
    out.legacy_naming = legacy;
  }
  return out;
}

export async function status(argv: string[], deps: Partial<StatusCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          limit: { type: "string" },
          dir: { type: "string" },
          remote: { type: "string" },
          with: { type: "string", multiple: true },
          "with-deps": { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.status,
  );
  if (values.help) {
    stdout(renderUsage(STATUS_USAGE));
    return;
  }

  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)");
    }
    limit = Number(raw);
  }

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  // A hosted checkout reports its sync state from local state only: no automatic pull, so the
  // report never waits on the network and its staleness is the checkout's own.
  const home = deps.home ?? homedir();
  const hosted = remote ? null : await hostedCheckoutAt(values.dir, home).catch(() => null);
  // Opportunistic board freshness (autopull.ts): silent, fail-soft, detection-gated — see list.ts.
  if (!remote && !hosted) await (deps.autoPull ?? maybeAutoPull)(values.dir);
  // One clock judges both the hosted checkout's staleness and the report's freshness.
  const now = (deps.now ?? (() => new Date()))();
  // Loaded only in a hosted checkout, so an ordinary status never loads the sync engine.
  const hostedReport = hosted
    ? await (await import("../hosted/status.js")).hostedStatus(hosted, home, now)
    : null;
  const bundle = await openBundle(values.dir, remote);

  // Core calls the binder once, after its own read and its one parse of docs/dependencies, so a
  // malformed declaration stays a finding and every CliError the binder throws keeps its exit code.
  let bindingProblems: BindingProblem[] = [];
  const report = await bundleHealth(bundle, {
    now,
    ...(hosted ? { selfBundleId: hosted.bundle_id } : {}),
    bindings: async (declared) => {
      const resolved = await resolveBundleBindings({
        referringRoot: remote ? null : bundle.root,
        dependencies: declared.dependencies,
        withValues: values.with ?? [],
        withDeps: values["with-deps"] === true,
        home,
      });
      bindingProblems = resolved.problems;
      return resolved.bindings;
    },
  });
  const out = statusRecord(report, { limit, bindingProblems });

  if (hostedReport) {
    const record: Record<string, unknown> = { home: "hosted", sync: hostedReport.sync, ...out };
    if (hostedReport.help.length > 0) record.help = hostedReport.help;
    stdout(render(record, resolveMode(values)));
    return;
  }
  if (remote) {
    stdout(render(out, resolveMode(values)));
    return;
  }
  // Where this bundle lives, and for a Git board what the next sync would move: local Git only, no fetch.
  const facts = await bundleHomeAt(await realpath(bundle.root), { home });
  if (facts.home === "git") {
    const block = await gitBoardSyncBlock(facts.board);
    const record: Record<string, unknown> = { home: "git", sync: block, ...unboundCopyOf(facts), ...out };
    if (block.state !== "clean") {
      record.help = [
        values.dir === undefined
          ? `${cliInvocation()} sync`
          : commandFragment`${cliInvocation()} sync --dir ${commandToken(values.dir)}`,
      ];
    }
    stdout(render(record, resolveMode(values)));
    return;
  }
  stdout(render({ home: "local", sync: "none (local only)", ...unboundCopyOf(facts), ...out }, resolveMode(values)));
}
