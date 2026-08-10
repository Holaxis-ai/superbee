// `agentstate-lite status` — a read-only, whole-bundle health report (bundle lint).
//
// COMPOSITION only: this command adds NO new core validation/link/freshness logic. It composes
// existing core machinery — `loadKinds`/`validateAgainstKind` (kind conformance), `parseLinksFromDoc`
// (cross-links, reversed in-memory for orphan derivation), and `freshness()` fed a kind's declared
// horizon (staleness) — into one report. ONE registry load (`loadKinds`) + ONE `query(bundle)` + TWO
// prefix-scoped `listBlobs` (the legacy_naming audit + the dangling-view-entry lint) per invocation;
// everything else derives in memory. Orphans come from reversing the SAME edge set built
// while scanning for unresolved links — never a per-doc `backlinks()` call (that would be N
// whole-bundle traversals over data this command already has in hand).
//
// "Unresolved links", not "broken": OKF §5 explicitly permits links to not-yet-written knowledge, so
// a link whose target isn't in the queried doc set is informational, not an error. External hrefs
// (`isExternalHref`, already filtered out by `parseLinksFromDoc`) never count.
//
// Findings are REPORTS, not errors: exit is ALWAYS 0 once the analysis runs (a bad invocation or a
// missing bundle still exits USAGE/NOT_FOUND as usual, via the owned parser/openBundle). A future
// `--fail-on-findings` CI flag is intentionally NOT built here.
//
// Duplicate-id detection (the old v1.1 wishlist item) is DELIBERATELY DROPPED: a concept id IS its
// storage path, so ids are structurally unique per backend — there is nothing to detect.
import { parseArgs } from "node:util";
import {
  freshness,
  freshnessHorizonMs,
  isTerminal,
  listBlobs,
  loadKinds,
  type OkfDocument,
  parseLinksFromDoc,
  query,
  validateAgainstKind,
} from "@agentstate-lite/core";
import {
  isAnyEntryKey,
  isAnyRegistryId,
  isPageTypeName,
  isViewEntryVersion,
  parseRegistration,
  VIEW_ENTRY_PREFIX,
} from "@agentstate-lite/core/page";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { maybeAutoPull } from "../autopull.js";
import { CliError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { collectLinkDeclarations } from "../link-types.js";
import {
  hasLegacyBridgeField,
  isLegacyPageConvention,
  isLegacyPageDoc,
  isLegacyRegistryDocId,
  LEGACY_PAGE_BLOB_PREFIX,
} from "../legacy-page.js";
import { cliInvocation } from "../invocation.js";

export const STATUS_USAGE = `agentstate-lite status — read-only whole-bundle health report (bundle lint)

Usage:
  agentstate-lite status [--limit <n>] [--dir <path> | --remote <url>]

Runs, in ONE pass over the bundle: a kind-conformance lint (against any declared conventions/,
reusing the SAME validator 'doc write'/'new' use), an unresolved-link scan (a link whose target
isn't in the bundle — informational, since OKF permits links to not-yet-written knowledge; external
links are excluded entirely), an orphan scan (concept docs with zero inbound links from OTHER
concept docs), a freshness sweep over kinds that declare a horizon (a governed doc older than it is
'stale'; a governed doc with no usable timestamp — missing OR malformed — is counted
'no_timestamp'), and two graph lints over any declared 'links'/'expects_inbound' vocabulary (see
'kinds --help'): edges violating a declared typed-edge type ('link_type_violations') and kind
instances missing a declared inbound expectation ('missing_expected_links'), plus two lints over
the bundle's View surface (legacy locations included; the legacy 'Page' kind name no longer
registers — see 'legacy_naming'): registered View docs whose entry blob is missing
('dangling_view_entries') and View-typed docs failing the registration grammar
('invalid_view_registrations'). Duplicate-id detection is not offered: an id IS its storage path,
so ids are structurally unique.

Category semantics (one line each):
  malformed          A document whose YAML frontmatter cannot be parsed at all — it is skipped by
                      every scan (so it never blinds this report) and named here with the parser
                      error; fix its YAML or remove the file. This is the headline finding.
  kind_warnings      Frontmatter/section violations against a doc's OWN declared kind (a per-doc
                      lint; see 'kinds').
  conformance_debt   Count of GOVERNED DOCS carrying at least one FRONTMATTER-level kind violation
                      (a missing required field, an out-of-enum value, or wrong arity) — a per-DOC,
                      frontmatter-only signal, deliberately narrower than 'kind_warnings' (a
                      per-VIOLATION total that also counts body-section violations). Present (even
                      at 0) whenever the bundle declares any kind at all; absent on a
                      conventions-free bundle. See 'doc update' to fix a listed doc.
  unresolved_links   A link whose target isn't in the queried doc set — informational (OKF permits
                      links to not-yet-written knowledge), not broken.
  orphans            A concept doc with ZERO INBOUND links from OTHER concept docs. Outbound links
                      do NOT rescue a doc; a self-link does NOT rescue a doc; links from a reserved
                      file (index.md/log.md) can never count as a source (reserved files are
                      excluded from the queried doc set by design). Convention docs (type:
                      Convention) are EXPECTED, PERMANENT orphans — they are schema declarations,
                      not content, and nothing is expected to cite them — so they are NOT
                      special-cased out of the count or the rows; the 'type' column on each row is
                      how you tell schema from content at a glance.
  stale              A governed doc (its type has a declared kind with a freshness horizon) whose
                      timestamp is older than that horizon.
  no_timestamp       A governed doc with no usable timestamp (missing OR malformed) — it cannot be
                      judged stale or fresh at all, so it is counted separately from 'stale'.
  registry_warnings  Malformed convention docs THEMSELVES (loadKinds' own warnings) — a problem in
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

This is a whole-bundle read (one registry load + one query + two prefix-scoped blob listings,
batched) — acceptable for an explicitly batch-analysis command; over --remote it is one
whole-bundle fetch, not a per-doc round trip.

Exit is ALWAYS 0 once the analysis runs: findings are reports, not errors. (A --fail-on-findings CI
flag is a recorded future item, not built here.)

Options:
  --limit <n>             Cap each finding category's row list to <n> rows (default: 20; 0 = unlimited)
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
}

/** AXI list-cap default: 20 rows per finding category unless `--limit` overrides it (0 = unlimited). */
const DEFAULT_LIMIT = 20;

/** A finding category's row list, capped with `shown`/`total` so truncation is always explicit. */
interface Capped {
  shown: number;
  total: number;
  rows: Record<string, unknown>[];
}

function cap(rows: Record<string, unknown>[], limit: number): Capped {
  const bounded = limit > 0 ? rows.slice(0, limit) : rows;
  return { shown: bounded.length, total: rows.length, rows: bounded };
}

/**
 * `validateAgainstKind`'s codes that represent a FRONTMATTER-shaped violation (a missing required
 * field, an out-of-enum value, or wrong arity) — every code EXCEPT `KIND_SECTION_MISSING` (a missing
 * BODY heading, out of scope for `conformance_debt` below).
 */
const FRONTMATTER_VIOLATION_CODES = new Set(["KIND_FIELD_MISSING", "KIND_FIELD_VALUE", "KIND_FIELD_ARITY"]);

/** A doc's `type` field, or "" when absent/non-string — the ONE place this coercion happens. */
function docType(doc: OkfDocument): string {
  return typeof doc.frontmatter.type === "string" ? doc.frontmatter.type : "";
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
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.status,
  );
  if (values.help) {
    stdout(STATUS_USAGE);
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
  // Opportunistic board freshness (autopull.ts): silent, fail-soft, detection-gated — see list.ts.
  if (!remote) await (deps.autoPull ?? maybeAutoPull)(values.dir);
  const bundle = await openBundle(values.dir, remote);

  // ONE registry load, ONE query — every finding below derives from these two results in memory.
  // A corrupt document (unparseable YAML frontmatter) is collected as its OWN finding rather than
  // crashing the health report — a health report that can't run because one doc is broken is the
  // opposite of useful; the broken doc IS the headline finding.
  const malformedRows: Record<string, unknown>[] = [];
  const [registry, docs, legacyBlobKeys, viewBlobKeys] = await Promise.all([
    loadKinds(bundle),
    query(bundle, {}, { onSkip: (s) => malformedRows.push({ id: s.id, reason: s.reason }) }),
    // legacy_naming audit (below): blob keys still under the legacy pages/ prefix — one extra
    // prefix-scoped listing on a command that is already an explicit whole-bundle read.
    listBlobs(bundle, LEGACY_PAGE_BLOB_PREFIX),
    // dangling_view_entries (below): the views/ half of the entry-key existence set (the pages/
    // half is the legacy listing above — the only two prefixes a valid entry key can name).
    listBlobs(bundle, VIEW_ENTRY_PREFIX),
  ]);
  const byId = new Set(docs.map((d) => d.id));
  // `id -> doc`, for the link-type-violation check's target-doc-type lookup below (never a second
  // per-edge query — the doc is already in hand from the ONE `query(bundle)` above).
  const docsById = new Map(docs.map((d) => [d.id, d]));

  // Kind lint: for every doc whose `type` is governed by a declared kind, validate it (the ONE
  // validator `doc write`/`new` already use — no second implementation).
  //
  // Conformance debt (tasks/status-conformance-debt): re-grouped from this SAME lint pass, by DOC
  // rather than by VIOLATION, and narrowed to FRONTMATTER-shaped codes only — no new query, no new
  // pass over `docs`, and no read of `doc.body` of its OWN (validateAgainstKind's body-section check
  // already ran, as part of computing `kind_warnings`, on docs this loop already has in hand; this
  // block only inspects each warning's `code`, never `doc.body`). `KIND_SECTION_MISSING` (a missing
  // body heading) is deliberately excluded — it names no frontmatter field a `doc update --<field>`
  // could set.
  const lintRows: Record<string, unknown>[] = [];
  const conformanceDebtDocs = new Map<string, string>(); // id -> type, first-seen (docs is id-sorted)
  for (const doc of docs) {
    const kind = registry.kinds.get(docType(doc));
    if (!kind) continue;
    for (const w of validateAgainstKind(doc, kind)) {
      lintRows.push({ id: doc.id, field: w.field ?? "", code: w.code });
      if (FRONTMATTER_VIOLATION_CODES.has(w.code) && !conformanceDebtDocs.has(doc.id)) {
        conformanceDebtDocs.set(doc.id, docType(doc));
      }
    }
  }

  // The declared typed-edge vocabulary (`links` maps across every kind), flattened ONCE for the
  // link-type-violation check below — shared with `link add`'s own write-time lint (link-types.ts),
  // never a second implementation.
  const linkTypeDeclarations = collectLinkDeclarations(registry);

  // Unresolved links + the inbound edge set (reused below for orphans AND the two graph lints —
  // never a per-doc backlinks() call, which would be N whole-bundle traversals over data already
  // in hand).
  const unresolvedRows: Record<string, unknown>[] = [];
  const inbound = new Set<string>();
  // `id -> {text, sourceType}[]` for every RESOLVED inbound edge from an OTHER concept doc (the
  // same "from OTHER concept docs" rule orphans uses — a self-link doesn't rescue a doc from a
  // missing-expected-link finding either). Feeds `missing_expected_links` below.
  const inboundEdges = new Map<string, { text: string; sourceType: string }[]>();
  const linkTypeViolationRows: Record<string, unknown>[] = [];
  for (const doc of docs) {
    for (const l of parseLinksFromDoc(doc)) {
      if (!byId.has(l.to)) {
        unresolvedRows.push({ from: doc.id, href: l.href });
        continue;
      }
      // "From OTHER concept docs" — a self-link does not rescue a doc from orphan (or
      // missing-expected-link) status.
      if (l.to !== doc.id) {
        inbound.add(l.to);
        const list = inboundEdges.get(l.to) ?? [];
        list.push({ text: l.text, sourceType: docType(doc) });
        inboundEdges.set(l.to, list);
      }

      // link_type_violations: this edge's text matches a declared typed-edge vocabulary entry (some
      // kind's 'links' map) but the actual source and/or target kind doesn't conform — the SAME rule
      // `link add` warns on at write time, applied bundle-wide over every resolved edge.
      const declared = linkTypeDeclarations.get(l.text);
      if (declared && declared.length > 0) {
        const sourceType = docType(doc);
        const targetType = docType(docsById.get(l.to)!);
        const matched = declared.find((d) => d.governs === sourceType) ?? declared[0]!;
        const sourceOk = declared.some((d) => d.governs === sourceType);
        const targetOk = targetType === matched.target;
        if (!sourceOk || !targetOk) {
          linkTypeViolationRows.push({
            from: doc.id,
            to: l.to,
            text: l.text,
            expected: `${matched.governs} -> ${matched.target}`,
          });
        }
      }
    }
  }

  // Orphans: concept docs with zero inbound edges from other concept docs. Reserved files never
  // appear in `docs` (query() already excludes index.md/log.md), so they can never be a "source"
  // here structurally, not by special-casing. A convention doc that nothing links to is reported
  // honestly like anything else — not special-cased away. Rows carry `type` alongside `id` so a
  // reader can tell an EXPECTED, PERMANENT orphan (`type: Convention` — schema, not content) apart
  // from an orphaned concept doc at a glance, without splitting the list or the count (the finding
  // that a Convention doc is an orphan is true by definition; honesty over false comfort).
  const orphanRows: Record<string, unknown>[] = [];
  for (const doc of docs) {
    if (!inbound.has(doc.id)) orphanRows.push({ id: doc.id, type: docType(doc) });
  }

  // Freshness sweep: only over kinds that declare a horizon (feeding the EXISTING
  // `FreshnessOptions.maxAgeMs` via `freshness()` itself — no forked verdict logic).
  const now = new Date();
  const staleRows: Record<string, unknown>[] = [];
  const noTimestampRows: Record<string, unknown>[] = [];
  for (const doc of docs) {
    const kind = registry.kinds.get(docType(doc));
    if (!kind) continue;
    const horizonMs = freshnessHorizonMs(kind);
    if (horizonMs === undefined) continue;
    const result = freshness(doc, { maxAgeMs: horizonMs, now });
    if (result.verdict === "empty") {
      noTimestampRows.push({ id: doc.id, type: docType(doc) });
    } else if (result.verdict === "stale") {
      staleRows.push({ id: doc.id, age_ms: result.ageMs, horizon_ms: horizonMs });
    }
  }

  // missing_expected_links: for every kind instance whose OWN kind declares `expects_inbound`,
  // check each declared `{link type: expected source kind}` entry against the doc's resolved
  // inbound edges (built above, one whole-bundle pass — never a second traversal). A doc missing
  // one or more expectations gets ONE row naming all of them. `status` is included on the row only
  // when the kind itself declares a `status` field (the triage signal).
  //
  // tasks/status-terminal-declaration.md: an instance whose OWN kind declares a terminal set
  // (`kind.fields.terminal`) that its frontmatter currently matches is EXCLUDED entirely — a
  // done/canceled instance is noise for this lint (the original gate, 2026-07-07). The exclusion
  // is counted (`terminalSkipped`) rather than silently shrinking the total; a kind with NO
  // terminal declaration keeps every instance, exactly as before this declaration existed.
  const missingExpectedRanked: { row: Record<string, unknown>; sortsFirst: boolean }[] = [];
  let terminalSkipped = 0;
  for (const doc of docs) {
    const kind = registry.kinds.get(docType(doc));
    if (!kind?.expectsInbound) continue;
    const terminalDeclared = Object.keys(kind.fields.terminal).length > 0;
    if (terminalDeclared && isTerminal(kind, doc.frontmatter)) {
      terminalSkipped++;
      continue;
    }
    const edges = inboundEdges.get(doc.id) ?? [];
    const missing = Object.entries(kind.expectsInbound)
      .filter(([text, sourceKind]) => !edges.some((e) => e.text === text && e.sourceType === sourceKind))
      .map(([text]) => text);
    if (missing.length === 0) continue;
    const row: Record<string, unknown> = { id: doc.id };
    const declaresStatus = kind.fields.required.includes("status") || kind.fields.optional.includes("status");
    if (declaresStatus) row.status = doc.frontmatter.status;
    row.missing = missing;
    // Sort key: when the kind DECLARES a terminal set, order by the ACTUAL declaration
    // (`isTerminal`) rather than a hardcoded "done" string — a bundle whose enum uses different
    // terminal words (e.g. resolved/archived) still gets non-terminal-first triage ordering.
    // A kind with no terminal declaration keeps the EXACT pre-existing hardcoded fallback (no
    // regression). Every row here is already non-terminal by construction (terminal instances
    // were excluded above), so for a terminal-declaring kind this is always `false` — the
    // fallback branch is the only one that can ever sort a row second.
    const sortsFirst = terminalDeclared ? isTerminal(kind, doc.frontmatter) : row.status === "done";
    missingExpectedRanked.push({ row, sortsFirst });
  }
  missingExpectedRanked.sort((a, b) => {
    if (a.sortsFirst !== b.sortsFirst) return a.sortsFirst ? 1 : -1;
    return String(a.row.id).localeCompare(String(b.row.id));
  });
  const missingExpectedRows = missingExpectedRanked.map((e) => e.row);

  // legacy_naming (legacy-page.ts; removal phase tasks/remove-legacy-page-bridge-support): the
  // legacy names are NO LONGER accepted, so this is a real FINDING now, not a report — a
  // Page-typed doc silently fails to register and a legacy own-`bridge` field silently grants
  // nothing, and NOTHING else diagnoses either (post-removal they fall out of the
  // isPageTypeName-based View-surface lints above by design; legacy-page.ts's frozen literals
  // exist precisely to detect what the runtime no longer accepts). The legacy-prefix rows stay
  // informational: LOCATIONS remain recognized.
  const pageTypedRows: Record<string, unknown>[] = docs
    .filter((doc) => isLegacyPageDoc(doc.frontmatter))
    .map((doc) => ({ id: doc.id }));
  const bridgeFieldRows: Record<string, unknown>[] = docs
    .filter((doc) => hasLegacyBridgeField(doc.frontmatter))
    .map((doc) => ({ id: doc.id }));
  // A stale convention governing the legacy 'Page' name is silent scaffolding:
  // `kinds` advertises the dead name and kind-aware authoring would produce runtime-ignored
  // docs, yet no doc-level scan above sees it (it scans instances, not governs declarations).
  const pageConventionRows: Record<string, unknown>[] = docs
    .filter((doc) => isLegacyPageConvention(doc.frontmatter))
    .map((doc) => ({ id: doc.id }));
  // STORE-AWARE: docs count only under the legacy registry prefix; blob keys only under the
  // legacy entry prefix (already prefix-scoped at the `listBlobs` call above) — a concept doc
  // that merely lives at e.g. `pages/manual` is not a legacy item.
  const legacyPrefixRows: Record<string, unknown>[] = [
    ...docs.filter((doc) => isLegacyRegistryDocId(doc.id)).map((doc) => ({ id: doc.id, store: "doc" })),
    ...legacyBlobKeys
      .slice()
      .sort()
      .map((key) => ({ id: key, store: "blob" })),
  ];

  // The View-surface lints (tasks/view-entry-dangling-lint), over every View-typed doc
  // (legacy LOCATIONS included; a legacy Page-TYPED doc is no longer recognized here — it lands
  // in legacy_naming below instead) — recognized via core's `isPageTypeName`/`parseRegistration`,
  // the SAME predicates the ui launcher/loopback server consume, so recognition is
  // convention-independent by construction. dangling_view_entries: a VALID registration whose declared `entry` names a
  // blob that does not exist (a never-promoted, typo'd, or since-deleted key mints a view that
  // serves nothing); existence derives from the two prefix-scoped listings batched above, never a
  // per-registration existence probe. Nothing on the write path checks either lint (deliberately
  // — read-side also catches hand-written docs, external bundles, and post-hoc blob deletions).
  const entryBlobKeys = new Set<string>([...viewBlobKeys, ...legacyBlobKeys]);
  let viewTypedCount = 0;
  const danglingViewEntryRows: Record<string, unknown>[] = [];
  const invalidRegistrationRows: Record<string, unknown>[] = [];
  for (const doc of docs) {
    if (!isPageTypeName(doc.frontmatter.type)) continue;
    viewTypedCount++;
    const registration = parseRegistration(doc.id, doc.frontmatter);
    if (registration) {
      if (!entryBlobKeys.has(registration.entry)) {
        danglingViewEntryRows.push({ id: registration.id, entry: registration.entry });
      }
      continue;
    }
    // invalid_view_registrations: the doc DECLARES an accepted registration kind name but fails
    // the registration predicate itself — the launcher cannot mint or serve it, and nothing else
    // diagnoses it (kind validation checks field presence/enums, not this grammar; strict `new`
    // accepts an off-prefix id or a wrong-prefix entry key silently). The failing leg(s) are
    // named by the same core grammar helpers `parseRegistration` composes — no second grammar.
    const legs: string[] = [];
    if (!isAnyRegistryId(doc.id)) legs.push("id");
    if (!isAnyEntryKey(doc.frontmatter.entry)) legs.push("entry");
    if (
      Object.hasOwn(doc.frontmatter, "entry_version") &&
      !isViewEntryVersion(doc.frontmatter.entry_version)
    ) {
      legs.push("entry_version");
    }
    invalidRegistrationRows.push({ id: doc.id, problem: legs.join("+") });
  }

  const malformed = cap(malformedRows, limit);
  const lint = cap(lintRows, limit);
  const unresolved = cap(unresolvedRows, limit);
  const orphans = cap(orphanRows, limit);
  const stale = cap(staleRows, limit);
  const noTimestamp = cap(noTimestampRows, limit);
  const registryLint = cap(
    registry.warnings.map((w): Record<string, unknown> => ({ ...w })),
    limit,
  );
  const linkTypeViolations = cap(linkTypeViolationRows, limit);
  const missingExpectedLinks = cap(missingExpectedRows, limit);
  const conformanceDebt = cap(
    [...conformanceDebtDocs].map(([id, type]) => ({ id, type })),
    limit,
  );
  const danglingViewEntries = cap(danglingViewEntryRows, limit);
  const invalidViewRegistrations = cap(invalidRegistrationRows, limit);

  const out: Record<string, unknown> = {
    docs: docs.length,
    kinds: registry.kinds.size,
    malformed: malformed.total,
    kind_warnings: lint.total,
    unresolved_links: unresolved.total,
    orphans: orphans.total,
    stale: stale.total,
    no_timestamp: noTimestamp.total,
    registry_warnings: registryLint.total,
    link_type_violations: linkTypeViolations.total,
    missing_expected_links: missingExpectedLinks.total,
  };
  // Beside the count, unconditionally at the top level (never nested inside the row block below,
  // which is itself omitted when `missing_expected_links` is 0 — a bundle where EVERY matching
  // instance happened to be terminal-skipped would otherwise hide this field entirely, exactly
  // the silent shrink the exclusion above must not cause). Semantics: INSTANCES skipped BEFORE
  // the missing_expected_links lint evaluated them — not findings suppressed (a skipped instance
  // might have carried its expected edge and linted clean anyway).
  if (terminalSkipped > 0) out.terminal_skipped = terminalSkipped;
  // Conformance debt (tasks/status-conformance-debt): present — even at 0 — whenever the bundle
  // declares ANY kind at all, mirroring `kind_warnings`'s own always-shown-when-relevant shape;
  // absent entirely on a conventions-free bundle (`registry.kinds.size === 0`), which is what keeps
  // that bundle shape's status output BYTE-IDENTICAL to before this field existed (gate 2/3 — see
  // status.test.ts's byte-identity pin). The row block + its fixing-command help hatch follow the
  // SAME omitted-when-empty convention as every other finding category below.
  if (registry.kinds.size > 0) out.conformance_debt = conformanceDebt.total;
  // Present — even at 0 — whenever the bundle carries at least one View-typed doc (the
  // conformance_debt gating idiom): "all entries resolvable" / "all registrations valid" are
  // reports worth seeing, while a bundle with no View surface at all keeps output byte-identical
  // to before these lints existed (the byte-identity pins in status.test.ts).
  if (viewTypedCount > 0) {
    out.dangling_view_entries = danglingViewEntries.total;
    out.invalid_view_registrations = invalidViewRegistrations.total;
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
  if (orphans.total > 0) out.orphan_docs = orphans;
  if (stale.total > 0) out.stale_docs = stale;
  if (noTimestamp.total > 0) out.no_timestamp_docs = noTimestamp;
  if (linkTypeViolations.total > 0) out.link_type_violations_rows = linkTypeViolations;
  if (missingExpectedLinks.total > 0) out.missing_expected_links_rows = missingExpectedLinks;
  if (danglingViewEntries.total > 0) out.dangling_view_entries_rows = danglingViewEntries;
  if (invalidViewRegistrations.total > 0) out.invalid_view_registrations_rows = invalidViewRegistrations;
  if (registryLint.total > 0) out.registry_lint = registryLint;
  // Omitted entirely on a legacy-free bundle (the `terminal_skipped` present-only-when-relevant
  // idiom) — a clean report stays byte-identical to before this finding existed.
  const pageTyped = cap(pageTypedRows, limit);
  const bridgeField = cap(bridgeFieldRows, limit);
  const pageConvention = cap(pageConventionRows, limit);
  const legacyPrefix = cap(legacyPrefixRows, limit);
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
        "agentstate-lite repo) to rename the listed docs in place — types flip to View, " +
        "bridge renames to access, and the shipped View convention is refreshed";
    }
    if (pageTyped.total > 0) legacy.page_typed_rows = pageTyped;
    if (bridgeField.total > 0) legacy.bridge_field_rows = bridgeField;
    if (pageConvention.total > 0) legacy.page_convention_rows = pageConvention;
    if (legacyPrefix.total > 0) legacy.legacy_prefix_rows = legacyPrefix;
    out.legacy_naming = legacy;
  }

  stdout(render(out, resolveMode(values)));
}
