/**
 * The bundle health report: every finding `superbee status` prints, computed from one bundle read.
 *
 * Composition only: Kind conformance is `validateAgainstKind`, links are `parseLinksFromDoc` and
 * `parseQualifiedLinks`, staleness is `freshness()`, View registrations are `parseRegistration`.
 * One `loadKinds`, one lenient `query`, two prefix-scoped `listBlobs` and one root-index read per
 * call; every finding derives in memory from those results. Orphans and both graph lints come from
 * the edge sets built while scanning for unresolved links, never a per-document backlink query.
 *
 * Findings are data, never errors: a document whose frontmatter does not parse is a `malformed`
 * row, and an unresolved link is information (OKF permits links to knowledge not yet written).
 *
 * Top-level report keys are camelCase; row keys are snake_case, the rows `superbee status` prints.
 */
import { listBlobs, query, readBundleOkfVersion } from "../bundle-ops.js";
import { createLocalResolver, resolveQualifiedLinks, type BundleBinding, type UnresolvedReason } from "../cross-bundle.js";
import {
  BUNDLE_NAME_DOC_ID,
  BUNDLE_NAME_DOC_TYPE,
  DEPENDENCIES_DOC_ID,
  DEPENDENCIES_DOC_TYPE,
  declaredBundleId,
  parseDependencies,
  type ParsedDependencies,
} from "../dependencies.js";
import { freshness, invalidLegacyTimestamp, staleAfterInstant } from "../freshness.js";
import { MalformedDocumentError } from "../frontmatter-contract.js";
import {
  freshnessHorizonMs,
  isKindFieldValidationWarning,
  isTerminal,
  projectKindValidationWarnings,
  validateAgainstKind,
  type KindRegistry,
} from "../kinds.js";
import { inspectKindDeprecatedUsage, type DeprecatedUsage } from "../kind-deprecation.js";
import { loadKinds } from "../kinds-load.js";
import { collectLinkDeclarations, localEdgeQualifiedDeclaration, qualifiedEdgeViolation } from "../link-types.js";
import { parseLinksFromDoc } from "../links.js";
import { isOkfLifecycleStatus } from "../okf-lifecycle.js";
import { invalidOkfTimestamps } from "../okf-timestamps.js";
import {
  isAnyEntryKey,
  isAnyRegistryId,
  isPageTypeName,
  isViewEntryVersion,
  parseRegistration,
  VIEW_ENTRY_PREFIX,
} from "../page.js";
import { isQualifiedHref, parseQualifiedLinks, type QualifiedLink, type QualifiedRef } from "../qualified-links.js";
import type { Bundle, OkfDocument } from "../types.js";
import type { ValidationWarning } from "../validation.js";
import { trustTierCounts, type TrustTierCounts } from "../verification.js";
import {
  hasLegacyBridgeField,
  isLegacyPageConvention,
  isLegacyPageDoc,
  isLegacyRegistryDocId,
  LEGACY_PAGE_BLOB_PREFIX,
} from "./legacy-page.js";

/**
 * Binds declared dependencies: called once, after every read has completed and `docs/dependencies`
 * has been parsed, with that parse. Returns the bound copies by alias.
 */
export type BindDependencies = (declared: ParsedDependencies) => Promise<ReadonlyMap<string, BundleBinding>>;

export interface BundleHealthOptions {
  /** The instant freshness is judged at. Default: the current time, taken after the reads. */
  now?: Date;
  /**
   * Bound copies of declared dependencies, by alias: a map, or a hook called exactly once, after
   * every read has completed and `docs/dependencies` has been parsed, with that parse. Default: none,
   * so nothing outside the bundle is read. Whatever the hook throws propagates unchanged.
   */
  bindings?: ReadonlyMap<string, BundleBinding> | BindDependencies;
  /** This bundle's id when `docs/bundle` declares none. */
  selfBundleId?: string;
}

/** A document whose frontmatter does not parse; the root index comes first when it is one. */
export interface MalformedRow {
  id: string;
  reason: string;
}

/** One Kind violation of one document. */
export interface KindLintRow {
  id: string;
  field: string;
  code: string;
}

/** A document and its `type` ("" when absent or not a string). */
export interface DocTypeRow {
  id: string;
  type: string;
}

export interface UnresolvedLinkRow {
  from: string;
  href: string;
}

/** A resolved local edge whose text is a declared link type its source or target does not conform to. */
export interface LinkTypeViolationRow {
  from: string;
  to: string;
  text: string;
  expected: string;
}

/**
 * A qualified link whose text is a declared type it does not conform to, or a local link under a
 * qualified declaration (`links: {pours: "beers:Beer"}`).
 */
export interface CrossLinkTypeViolationRow {
  from: string;
  href: string;
  text: string;
  expected: string;
}

/**
 * A Kind instance lacking a declared inbound expectation. `status` is present when the Kind declares
 * a `status` field, and is the raw stored value (any YAML value, or undefined when unset).
 */
export interface MissingExpectedRow {
  id: string;
  status?: unknown;
  missing: string[];
}

/** A stale document: past its `stale_after` instant (a string by construction), or older than its Kind's horizon. */
export interface StaleRow {
  id: string;
  age_ms?: number;
  horizon_ms?: number;
  stale_after?: string;
}

/** An unreadable `stale_after`; `value` is the stored value made JSON-safe. */
export interface ValueRow {
  id: string;
  type: string;
  value: unknown;
}

/** An invalid timestamp field occurrence; `value` is the stored value made JSON-safe. */
export interface FieldValueRow {
  id: string;
  type: string;
  field: string;
  value: unknown;
}

export interface DanglingEntryRow {
  id: string;
  entry: string;
}

/** A View-typed document failing the registration grammar; `problem` names the failing legs, joined by `+`. */
export interface InvalidRegistrationRow {
  id: string;
  problem: string;
}

export interface ViewSurfaceHealth {
  /** View-typed documents (legacy locations included). */
  typed: number;
  danglingEntries: DanglingEntryRow[];
  invalidRegistrations: InvalidRegistrationRow[];
}

export interface CrossUnresolvedRow {
  from: string;
  href: string;
  reason: UnresolvedReason;
  detail: string;
}

export interface DependencyRow {
  alias: string;
  bundle_id: string;
  /** `unbound` without a binding; otherwise the bound copy's verdict from core's resolver. */
  state: "unbound" | "ok" | UnresolvedReason;
  /** The binding's label, or null when the alias is unbound. */
  bound: string | null;
  pin: string | null;
}

/** A `docs/dependencies` defect (a `DEP_*` code). */
export interface DependencyProblemRow {
  code: string;
  alias: string | null;
  detail: string;
}

export interface CrossBundleHealth {
  /** Every qualified (`okf:`) link, malformed ones included. */
  links: number;
  /** Qualified links whose declared alias has no binding. */
  unchecked: number;
  unresolved: CrossUnresolvedRow[];
  dependencies: DependencyRow[];
  problems: DependencyProblemRow[];
}

/** One Kind declaring a workflow `status` that collides with the OKF v0.2 lifecycle vocabulary. */
export interface StatusFieldRow {
  kind: string;
  convention: string;
  declaration: "unbounded" | "enumerated";
  incompatible_values: string[];
  observed_incompatible_values: string[];
  affected_documents: number;
}

export interface OkfUpgradeFinding {
  statusFieldRows: StatusFieldRow[];
  affectedDocuments: number;
}

export interface LegacyNamingFindings {
  pageTyped: { id: string }[];
  bridgeField: { id: string }[];
  pageConvention: { id: string }[];
  legacyPrefix: { id: string; store: "doc" | "blob" }[];
}

export interface BundleHealthReport {
  /** The root index's declared edition; undefined when absent or unreadable. */
  okfVersion: string | undefined;
  docs: number;
  kinds: number;
  malformed: MalformedRow[];
  kindLint: KindLintRow[];
  /** Informational stored usage, not conformance debt or retirement clearance. */
  deprecatedUsage?: Array<DeprecatedUsage & { id: string }>;
  /** One row per governed document with a frontmatter-level violation; null when the bundle declares no Kind. */
  conformanceDebt: DocTypeRow[] | null;
  registryWarnings: ValidationWarning[];
  unresolvedLinks: UnresolvedLinkRow[];
  orphans: DocTypeRow[];
  linkTypeViolations: LinkTypeViolationRow[];
  /** Independent of `crossBundle`: a local edge under a qualified declaration needs no dependencies. */
  crossLinkTypeViolations: CrossLinkTypeViolationRow[];
  /** In triage order. */
  missingExpectedLinks: MissingExpectedRow[];
  /** Terminal instances skipped before the inbound-expectation lint evaluated them. */
  terminalSkipped: number;
  stale: StaleRow[];
  noTimestamp: DocTypeRow[];
  invalidStaleAfter: ValueRow[];
  invalidTimestamps: FieldValueRow[];
  invalidLegacyTimestamps: FieldValueRow[];
  /** Null on v0.1, an undeclared edition, or an empty bundle. */
  trust: TrustTierCounts | null;
  views: ViewSurfaceHealth;
  /** Null without `docs/dependencies` and without any `okf:` link. */
  crossBundle: CrossBundleHealth | null;
  /** Present only on a v0.1 bundle with a workflow-status collision. */
  okfUpgrade: OkfUpgradeFinding | null;
  legacyNaming: LegacyNamingFindings;
}

/** A document's `type`, or "" when absent or not a string: the one place this coercion happens. */
function docType(doc: OkfDocument): string {
  return typeof doc.frontmatter.type === "string" ? doc.frontmatter.type : "";
}

/** Preserve ordinary YAML value shapes while keeping unsupported JSON values legible. */
function diagnosticValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "number" && !Number.isFinite(item) ? `<${String(item)}>` : item));
  } catch {
    // YAML aliases can form cycles; the report must still name the offending document.
    return `<non-JSON ${Array.isArray(value) ? "array" : typeof value}: circular or too deeply nested>`;
  }
}

/**
 * Documents that define the bundle's operating model or identity rather than participating as
 * concept instances. Their lack of inbound concept links is intentional, so they are never orphans.
 */
function isGraphDefinition(doc: OkfDocument): boolean {
  const type = docType(doc);
  return type === "Convention" ||
    isPageTypeName(type) ||
    isLegacyPageDoc(doc.frontmatter) ||
    (type === "Reference" && doc.id.startsWith("references/")) ||
    (type === BUNDLE_NAME_DOC_TYPE && doc.id === BUNDLE_NAME_DOC_ID) ||
    (type === DEPENDENCIES_DOC_TYPE && doc.id === DEPENDENCIES_DOC_ID);
}

function okfV02WorkflowStatusCollisions(registry: KindRegistry, docs: OkfDocument[]): StatusFieldRow[] {
  const affectedByKind = new Map<string, number>();
  const observedValuesByKind = new Map<string, Set<string>>();
  for (const doc of docs) {
    const value = doc.frontmatter.status;
    if (value === undefined || isOkfLifecycleStatus(value)) continue;
    const type = docType(doc);
    affectedByKind.set(type, (affectedByKind.get(type) ?? 0) + 1);
    const display = typeof value === "string" ? value : `<${Array.isArray(value) ? "array" : typeof value}>`;
    const observed = observedValuesByKind.get(type) ?? new Set<string>();
    observed.add(display);
    observedValuesByKind.set(type, observed);
  }

  const rows: StatusFieldRow[] = [];
  for (const kind of [...registry.kinds.values()].sort((a, b) => a.governs.localeCompare(b.governs))) {
    const declaresStatus =
      kind.fields.required.includes("status") || kind.fields.optional.includes("status");
    if (!declaresStatus) continue;
    const declaredValues = kind.fields.values.status;
    const incompatibleValues = (declaredValues ?? []).filter(
      (value) => !isOkfLifecycleStatus(value),
    );
    const affectedDocuments = affectedByKind.get(kind.governs) ?? 0;
    if (declaredValues !== undefined && incompatibleValues.length === 0 && affectedDocuments === 0) continue;
    rows.push({
      kind: kind.governs,
      convention: kind.id,
      declaration: declaredValues === undefined ? "unbounded" : "enumerated",
      incompatible_values: incompatibleValues,
      observed_incompatible_values: [...(observedValuesByKind.get(kind.governs) ?? [])].sort(),
      affected_documents: affectedDocuments,
    });
  }
  return rows;
}

/**
 * Compute the health report for `bundle`. Read-only: it reads through the bundle's backend and
 * never writes. It throws only what it propagates: `InvalidInputError` for a backend-less bundle in
 * a runtime with no default, backend errors other than `MalformedDocumentError` (a finding), and
 * whatever the `bindings` hook throws.
 */
export async function bundleHealth(bundle: Bundle, options: BundleHealthOptions = {}): Promise<BundleHealthReport> {
  // A document whose frontmatter does not parse is its own finding, never an abort.
  const malformed: MalformedRow[] = [];
  const [registry, docs, legacyBlobKeys, viewBlobKeys, okfVersionRead] = await Promise.all([
    loadKinds(bundle),
    query(bundle, {}, { onSkip: (s) => malformed.push({ id: s.id, reason: s.reason }) }),
    // legacyNaming: blob keys still under the legacy pages/ prefix.
    listBlobs(bundle, LEGACY_PAGE_BLOB_PREFIX),
    // views: the views/ half of the entry-key existence set (the legacy listing is the other half).
    listBlobs(bundle, VIEW_ENTRY_PREFIX),
    readBundleOkfVersion(bundle)
      .then((version) => ({ version }))
      .catch((error: unknown) => {
        if (!(error instanceof MalformedDocumentError)) throw error;
        return { version: undefined, malformed: { id: "index.md", reason: error.message } };
      }),
  ]);
  if ("malformed" in okfVersionRead) malformed.unshift(okfVersionRead.malformed);
  const okfVersion = okfVersionRead.version;
  const byId = new Set(docs.map((d) => d.id));
  const docsById = new Map(docs.map((d) => [d.id, d]));

  // Kind lint, per violation; conformance debt regroups the same pass by document and keeps only
  // frontmatter-level codes (a missing body section names no field an update could set).
  const kindLint: KindLintRow[] = [];
  const deprecatedUsage: Array<DeprecatedUsage & { id: string }> = [];
  const conformanceDebtDocs = new Map<string, string>(); // id -> type, first seen (docs is id-sorted)
  for (const doc of docs) {
    const kind = registry.kinds.get(docType(doc));
    if (!kind) continue;
    deprecatedUsage.push(...inspectKindDeprecatedUsage(doc, kind).map(row => ({ id: doc.id, ...row })));
    for (const w of projectKindValidationWarnings(okfVersion, kind, validateAgainstKind(doc, kind))) {
      kindLint.push({ id: doc.id, field: w.field ?? "", code: w.code });
      if (isKindFieldValidationWarning(w) && !conformanceDebtDocs.has(doc.id)) {
        conformanceDebtDocs.set(doc.id, docType(doc));
      }
    }
  }

  // The declared typed-edge vocabulary, shared with `link add`'s write-time lint.
  const linkTypeDeclarations = collectLinkDeclarations(registry);

  const unresolvedLinks: UnresolvedLinkRow[] = [];
  const inbound = new Set<string>();
  const outbound = new Set<string>();
  // id -> resolved inbound edges from OTHER documents (a self-link rescues nothing).
  const inboundEdges = new Map<string, { text: string; sourceType: string }[]>();
  const linkTypeViolations: LinkTypeViolationRow[] = [];
  const crossLinkTypeViolations: CrossLinkTypeViolationRow[] = [];
  for (const doc of docs) {
    for (const l of parseLinksFromDoc(doc)) {
      // A malformed `okf:` href without `//` also parses as a local link; it counts once, as a
      // cross-bundle invalid_ref, never as a local edge.
      if (isQualifiedHref(l.href)) continue;
      // A local link under a qualified declaration is a cross-bundle type violation whether or not
      // its local target exists.
      const qualifiedDeclaration = localEdgeQualifiedDeclaration(linkTypeDeclarations.get(l.text), docType(doc));
      if (qualifiedDeclaration) {
        crossLinkTypeViolations.push({
          from: doc.id,
          href: l.href,
          text: l.text,
          expected: `${qualifiedDeclaration.governs} -> ${qualifiedDeclaration.target}`,
        });
      }
      // Any non-self link is an intentional outgoing edge; an unresolved one has its own finding,
      // so it must not also make its source an orphan.
      if (l.to !== doc.id) outbound.add(doc.id);
      if (!byId.has(l.to)) {
        unresolvedLinks.push({ from: doc.id, href: l.href });
        continue;
      }
      if (l.to !== doc.id) {
        inbound.add(l.to);
        const list = inboundEdges.get(l.to) ?? [];
        list.push({ text: l.text, sourceType: docType(doc) });
        inboundEdges.set(l.to, list);
      }

      // A resolved edge whose text is a declared link type its source or target does not conform to.
      const declared = linkTypeDeclarations.get(l.text);
      if (declared && declared.length > 0 && !qualifiedDeclaration) {
        const sourceType = docType(doc);
        const targetType = docType(docsById.get(l.to)!);
        const matched = declared.find((d) => d.governs === sourceType) ?? declared[0]!;
        const sourceOk = declared.some((d) => d.governs === sourceType);
        const targetOk = targetType === matched.target;
        if (!sourceOk || !targetOk) {
          linkTypeViolations.push({
            from: doc.id,
            to: l.to,
            text: l.text,
            expected: `${matched.governs} -> ${matched.target}`,
          });
        }
      }
    }
  }

  // Cross-bundle links, parsed from the documents already in hand.
  const qualifiedLinks: QualifiedLink[] = [];
  const metadataViolations = new Set<QualifiedLink>();
  for (const doc of docs) {
    for (const q of parseQualifiedLinks(doc)) {
      qualifiedLinks.push(q);
      if (!q.ref) continue;
      const violation = qualifiedEdgeViolation(linkTypeDeclarations.get(q.text), docType(doc), q.ref.alias);
      if (violation) {
        metadataViolations.add(q);
        crossLinkTypeViolations.push({
          from: doc.id,
          href: q.href,
          text: q.text,
          expected: `${violation.governs} -> ${violation.target}`,
        });
      }
    }
  }
  const dependenciesDoc = docsById.get(DEPENDENCIES_DOC_ID);
  const hasCrossBundle = dependenciesDoc !== undefined || qualifiedLinks.length > 0;
  const selfBundleId = declaredBundleId(docsById.get(BUNDLE_NAME_DOC_ID)) ?? options.selfBundleId;
  const declaredDeps = parseDependencies(dependenciesDoc, selfBundleId === undefined ? {} : { selfBundleId });
  // Binding runs here, after every read and on this one parse, so a malformed or absent declaration
  // stays a finding and a self alias is already dropped when the binder sees the declaration.
  const bindings: ReadonlyMap<string, BundleBinding> =
    typeof options.bindings === "function"
      ? await options.bindings(declaredDeps)
      : options.bindings ?? new Map<string, BundleBinding>();

  let crossBundle: CrossBundleHealth | null = null;
  if (hasCrossBundle) {
    let unchecked = 0;
    const checked = qualifiedLinks.filter((q) => {
      const unbound = q.ref !== null && declaredDeps.dependencies.has(q.ref.alias) && !bindings.has(q.ref.alias);
      if (unbound) unchecked++;
      return !unbound;
    });
    const resolver = createLocalResolver({ dependencies: declaredDeps.dependencies, rejected: declaredDeps.rejected, bindings });
    // One probe per bound alias rides the same resolve call, so each binding's verdict (identity,
    // pin) comes from the resolver and its copy is still read in one batch.
    const probeAliases = [...bindings.keys()];
    const probes: QualifiedLink[] = probeAliases.map((alias) => {
      const ref: QualifiedRef = { alias, id: BUNDLE_NAME_DOC_ID };
      return { from: BUNDLE_NAME_DOC_ID, text: "", href: "", ref };
    });
    const results = await resolveQualifiedLinks(resolver, [...checked, ...probes]);
    const verdictByAlias = new Map<string, DependencyRow["state"]>();
    results.slice(checked.length).forEach((r, i) => {
      const resolution = r.resolution;
      const state = resolution.state === "resolved" || resolution.reason === "target_missing" ? "ok" : resolution.reason;
      verdictByAlias.set(probeAliases[i]!, state);
    });
    const unresolved: CrossUnresolvedRow[] = [];
    for (const { link, resolution } of results.slice(0, checked.length)) {
      if (resolution.state === "resolved") {
        // Reuse the admitted document from the existing resolution batch, never a foreign registry.
        if (!metadataViolations.has(link)) {
          const violation = qualifiedEdgeViolation(
            linkTypeDeclarations.get(link.text), docType(docsById.get(link.from)!),
            resolution.ref.alias, docType(resolution.document),
          );
          if (violation) crossLinkTypeViolations.push({
            from: link.from, href: link.href, text: link.text,
            expected: `${violation.governs} -> ${violation.target}`,
          });
        }
        continue;
      }
      unresolved.push({ from: link.from, href: link.href, reason: resolution.reason, detail: resolution.detail });
    }
    const dependencies: DependencyRow[] = [];
    for (const entry of declaredDeps.dependencies.values()) {
      dependencies.push({
        alias: entry.alias,
        bundle_id: entry.bundle_id,
        state: verdictByAlias.get(entry.alias) ?? "unbound",
        bound: bindings.get(entry.alias)?.label ?? null,
        pin: entry.pin?.value ?? null,
      });
    }
    crossBundle = {
      links: qualifiedLinks.length,
      unchecked,
      unresolved,
      dependencies,
      problems: declaredDeps.problems.map((p) => ({ code: p.code, alias: p.alias ?? null, detail: p.detail })),
    };
  }

  // Orphans are isolated content documents inside an established graph: a bundle with no resolved
  // edge has not adopted graph structure yet, roots with outbound edges are intentional, and
  // definition documents are classified above.
  const orphans: DocTypeRow[] = [];
  if (inbound.size > 0) {
    for (const doc of docs) {
      if (!inbound.has(doc.id) && !outbound.has(doc.id) && !isGraphDefinition(doc)) {
        orphans.push({ id: doc.id, type: docType(doc) });
      }
    }
  }

  // One freshness authority handles both standard v0.2 `stale_after` and optional Kind horizons.
  const now = options.now ?? new Date();
  const stale: StaleRow[] = [];
  const noTimestamp: DocTypeRow[] = [];
  const invalidStaleAfter: ValueRow[] = [];
  const invalidTimestamps: FieldValueRow[] = [];
  const invalidLegacyTimestamps: FieldValueRow[] = [];
  for (const doc of docs) {
    const invalidLegacy = invalidLegacyTimestamp(doc.frontmatter, okfVersion);
    if (invalidLegacy) {
      invalidLegacyTimestamps.push({ id: doc.id, type: docType(doc), field: invalidLegacy.field, value: diagnosticValue(invalidLegacy.value) });
    }
    if (okfVersion === "0.2") {
      for (const { field, value } of invalidOkfTimestamps(doc.frontmatter)) {
        invalidTimestamps.push({ id: doc.id, type: docType(doc), field, value: diagnosticValue(value) });
      }
    }
    const kind = registry.kinds.get(docType(doc));
    const horizonMs = kind ? freshnessHorizonMs(kind) : undefined;
    const hasStaleAfter = okfVersion === "0.2" && Object.hasOwn(doc.frontmatter, "stale_after");
    const staleAfterIsInvalid = hasStaleAfter && staleAfterInstant(doc.frontmatter.stale_after) === null;
    if (staleAfterIsInvalid) {
      invalidStaleAfter.push({ id: doc.id, type: docType(doc), value: diagnosticValue(doc.frontmatter.stale_after) });
    }
    // A readable stale_after is a string: staleAfterInstant accepts strings only.
    const staleAfter = hasStaleAfter && !staleAfterIsInvalid
      ? doc.frontmatter.stale_after as string
      : undefined;
    if (horizonMs === undefined && staleAfter === undefined) continue;
    const result = freshness(doc, { maxAgeMs: horizonMs, now, okfVersion });
    if (result.verdict === "empty" && horizonMs !== undefined) {
      noTimestamp.push({ id: doc.id, type: docType(doc) });
    } else if (result.verdict === "stale") {
      stale.push({
        id: doc.id,
        ...(result.ageMs === undefined ? {} : { age_ms: result.ageMs }),
        ...(horizonMs === undefined ? {} : { horizon_ms: horizonMs }),
        ...(staleAfter === undefined ? {} : { stale_after: staleAfter }),
      });
    }
  }

  // OKF v0.2 trust tiers (SPEC 5.3); v0.1 defines no trust family.
  const trust = okfVersion === "0.2" && docs.length > 0 ? trustTierCounts(docs) : null;

  // Inbound expectations: one row per instance of a Kind declaring `expects_inbound` that lacks a
  // conforming inbound edge. An instance whose Kind declares a terminal set it currently matches is
  // skipped and counted, never silently dropped.
  const missingExpectedRanked: { row: MissingExpectedRow; sortsFirst: boolean }[] = [];
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
    const declaresStatus = kind.fields.required.includes("status") || kind.fields.optional.includes("status");
    const row: MissingExpectedRow = declaresStatus
      ? { id: doc.id, status: doc.frontmatter.status, missing }
      : { id: doc.id, missing };
    // Non-terminal instances sort first: by the declared terminal set when the Kind has one, else
    // by the historical status === "done" fallback.
    const sortsFirst = terminalDeclared ? isTerminal(kind, doc.frontmatter) : row.status === "done";
    missingExpectedRanked.push({ row, sortsFirst });
  }
  missingExpectedRanked.sort((a, b) => {
    if (a.sortsFirst !== b.sortsFirst) return a.sortsFirst ? 1 : -1;
    return String(a.row.id).localeCompare(String(b.row.id));
  });
  const missingExpectedLinks = missingExpectedRanked.map((e) => e.row);

  // legacyNaming: retired names the runtime no longer accepts, plus legacy locations (still
  // recognized, reported as information). Documents count only under the legacy registry prefix,
  // blob keys only under the legacy entry prefix.
  const legacyNaming: LegacyNamingFindings = {
    pageTyped: docs.filter((doc) => isLegacyPageDoc(doc.frontmatter)).map((doc) => ({ id: doc.id })),
    bridgeField: docs.filter((doc) => hasLegacyBridgeField(doc.frontmatter)).map((doc) => ({ id: doc.id })),
    pageConvention: docs.filter((doc) => isLegacyPageConvention(doc.frontmatter)).map((doc) => ({ id: doc.id })),
    legacyPrefix: [
      ...docs.filter((doc) => isLegacyRegistryDocId(doc.id)).map((doc) => ({ id: doc.id, store: "doc" as const })),
      ...legacyBlobKeys
        .slice()
        .sort()
        .map((key) => ({ id: key, store: "blob" as const })),
    ],
  };

  // The View surface, recognized with the same predicates the ui launcher uses (legacy locations
  // included; a Page-typed document is a legacyNaming finding instead). Entry existence derives
  // from the two prefix-scoped listings above, never a per-registration probe.
  const entryBlobKeys = new Set<string>([...viewBlobKeys, ...legacyBlobKeys]);
  const views: ViewSurfaceHealth = { typed: 0, danglingEntries: [], invalidRegistrations: [] };
  for (const doc of docs) {
    if (!isPageTypeName(doc.frontmatter.type)) continue;
    views.typed++;
    const registration = parseRegistration(doc.id, doc.frontmatter);
    if (registration) {
      if (!entryBlobKeys.has(registration.entry)) {
        views.danglingEntries.push({ id: registration.id, entry: registration.entry });
      }
      continue;
    }
    // The document declares the View kind name but fails the registration grammar; name each
    // failing leg with the grammar helpers parseRegistration composes.
    const legs: string[] = [];
    if (!isAnyRegistryId(doc.id)) legs.push("id");
    if (!isAnyEntryKey(doc.frontmatter.entry)) legs.push("entry");
    if (
      Object.hasOwn(doc.frontmatter, "entry_version") &&
      !isViewEntryVersion(doc.frontmatter.entry_version)
    ) {
      legs.push("entry_version");
    }
    views.invalidRegistrations.push({ id: doc.id, problem: legs.join("+") });
  }

  const statusCollisions = okfV02WorkflowStatusCollisions(registry, docs);
  const okfUpgrade: OkfUpgradeFinding | null =
    okfVersion === "0.1" && statusCollisions.length > 0
      ? {
          statusFieldRows: statusCollisions,
          affectedDocuments: statusCollisions.reduce((total, row) => total + row.affected_documents, 0),
        }
      : null;

  return {
    okfVersion,
    docs: docs.length,
    kinds: registry.kinds.size,
    malformed,
    kindLint,
    ...(deprecatedUsage.length ? { deprecatedUsage } : {}),
    conformanceDebt: registry.kinds.size > 0 ? [...conformanceDebtDocs].map(([id, type]) => ({ id, type })) : null,
    registryWarnings: registry.warnings,
    unresolvedLinks,
    orphans,
    linkTypeViolations,
    crossLinkTypeViolations,
    missingExpectedLinks,
    terminalSkipped,
    stale,
    noTimestamp,
    invalidStaleAfter,
    invalidTimestamps,
    invalidLegacyTimestamps,
    trust,
    views,
    crossBundle,
    okfUpgrade,
    legacyNaming,
  };
}
