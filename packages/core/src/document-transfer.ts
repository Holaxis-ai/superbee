/**
 * Document transfer: copy chosen documents from one bundle into another with ids remapped, links
 * rewritten, provenance extended and one Promotion record of the act.
 *
 * Plan and apply share one computation. A plan reads every source document, every governing
 * convention, the target's `docs/dependencies` and the existence of every target id once, and
 * binds all of it into a plan token; apply recomputes the plan from fresh reads and refuses
 * unless the token is equal, so what applies is exactly what was shown.
 *
 * There is no multi-document transaction on any local backend, so apply never claims
 * all-or-nothing. It writes the Promotion record first (`promotion_state: applying`, with the
 * whole mapping) as the journal, then creates every document with an expect-absent write, then
 * marks the record `applied`. A failed write stops the apply and leaves the record at `applying`;
 * {@link resumeDocumentTransfer} is the one recovery path. Nothing here deletes a document, and only a
 * refresh replaces one.
 *
 * A refresh ({@link planDocumentRefresh}, {@link applyDocumentRefresh}) brings the copies an
 * applied record names up to date with their sources. The record's `source_version` and
 * `target_version` per entry are the baseline: a changed source is an update, and a copy whose
 * version differs from `target_version` was edited in the target and is a conflict unless the
 * caller names it to overwrite or skip. The record is the journal again (`promotion_state:
 * refreshing` with the pending rows), every copy is replaced under a hard compare-and-swap on the
 * version the plan saw, and {@link resumeDocumentTransfer} finishes an interrupted refresh. A
 * refresh never creates, deletes or picks up documents the record does not already name.
 *
 * v1 caveats: resume writes the remaining documents even if the target has since dropped a Kind
 * that governed them. Reference-style link definitions (`[x]: ../f.md`) are copied unchanged and
 * reported as `reference_definition`, so the caller sees links that may not resolve in the target.
 *
 * Storage-neutral: the source is a {@link BundleBinding} (any backend), the target is written
 * through the shared document mutation policy, and no Node module is imported.
 */

import { computeDroppedLinks, outboundLinks } from "./body-replace-guards.js";
import { backendFor, readBundleOkfVersion, readDocVersioned } from "./bundle-ops.js";
import type { BundleBinding, CommitPin } from "./cross-bundle.js";
import {
  BUNDLE_NAME_DOC_ID,
  declaredBundleId,
  DEPENDENCIES_DOC_ID,
  parseDependencies,
  type ParsedDependencies,
} from "./dependencies.js";
import { DocumentNotFoundError, mutateDocument, prepareDocumentMutationCandidate, type DocumentMutationCandidate } from "./document-mutation.js";
import { readManyExisting } from "./engine.js";
import { FilesystemIdentityAliasError, InvalidInputError, OkfActorError } from "./errors.js";
import { foldIdentityPath } from "./identity-fold.js";
import { loadKinds } from "./kinds-load.js";
import { CONVENTIONS_PREFIX, type KindRegistry } from "./kinds.js";
import { emitLinkHref } from "./link-emit.js";
import { extractMarkdownLinkSpans, maskMarkdownCode, normalizeSegments, resolveConceptId, rewriteMarkdownLinks, type MarkdownLinkSpan } from "./links.js";
import { isOkfActor } from "./okf-actor.js";
import { SUPERBEE_UPDATED_BY_FIELD } from "./mutation-attribution.js";
import { assertSafeConceptId, compareStorageKeys, isReservedFile, pathFromConceptId, trimTrailingSlashes } from "./paths.js";
import { isQualifiedHref, parseQualifiedHref, qualifiedHref } from "./qualified-links.js";
import { sha256HexOfUtf8 } from "./sha256.js";
import type { ValidationWarning } from "./validation.js";
import { VersionConflict } from "./versioning.js";
import type { Bundle, ConceptId, Frontmatter, OkfDocument, ReadResult, Version } from "./types.js";

export const DOCUMENT_TRANSFER_CONTRACT = "document-transfer/v1";
/** The `type` of the record each transfer writes. Not the `promote` command, which copies one file. */
export const PROMOTION_TYPE = "Promotion";
export const PROMOTIONS_PREFIX = "promotions/";

/** The source documents to copy: the union of explicit ids, every doc of a type, every doc under a prefix. */
export interface TransferSelection {
  ids?: readonly ConceptId[];
  types?: readonly string[];
  prefixes?: readonly string[];
}

export interface TransferSource {
  /** The alias the target's `docs/dependencies` declares for the source bundle. */
  alias: string;
  binding: BundleBinding;
  /** How the source is named in the Promotion record (default: the binding's label). */
  label?: string;
}

export interface TransferRequest {
  /** A local bundle or git board. */
  target: Bundle;
  from: TransferSource;
  select: TransferSelection;
  /** Target id is `${prefix}/${sourceId}`; without it the source id is kept. */
  prefix?: string;
  /** Accept a selected type that the source governs and the target does not. */
  allowUngoverned?: boolean;
  /** The Promotion record id (default: `promotions/<alias>-<12 hex of the selection>`). */
  recordId?: ConceptId;
  actor?: string;
  now?: () => string;
}

export type TransferConflictCode =
  | "alias_undeclared"
  | "alias_identity"
  | "selection_empty"
  | "source_missing"
  | "source_malformed"
  | "target_exists"
  | "duplicate_target"
  | "unsafe_target_id"
  | "case_collision"
  | "kind_missing"
  | "qualified_alias_mismatch"
  | "record_exists"
  /** Refresh: the copy was changed in the target since the record last wrote it. */
  | "target_edited"
  /** Refresh: the source changed but the copy is gone; a refresh never recreates it. */
  | "target_missing"
  /** Refresh: the record is not applied, or names a row a refresh cannot use. */
  | "record_state"
  /** Refresh: an overwrite or skip names no entry of the record. */
  | "not_in_record";

export interface TransferConflict {
  code: TransferConflictCode;
  source?: ConceptId;
  target?: ConceptId;
  detail: string;
  /** target_exists: the Promotion record whose copy already sits at the target; a refresh of it updates the copy. */
  record?: ConceptId;
}

export type LinkRewriteKind = "local" | "qualified" | "dequalified" | "unchanged";
export type LinkUntouchedReason =
  | "external"
  | "anchor"
  | "in_code"
  | "non_document"
  | "image"
  | "escapes_source_root"
  | "has_query"
  | "not_qualifiable"
  | "invalid_qualified"
  | "already_qualified"
  /** A reference-style definition (`[x]: ../f.md`): copied as written, so it may not resolve in the target. */
  | "reference_definition"
  /** Names a source id only under case or Unicode normalization folding, so no exact document. */
  | "case_variant";

export interface LinkRewrite {
  /** The href's start offset in the source body. */
  offset: number;
  from_href: string;
  /** Equal to `from_href` when unchanged. */
  to_href: string;
  kind: LinkRewriteKind;
  /** Present when `kind` is "unchanged". */
  reason?: LinkUntouchedReason;
  /** The resolved source id, when the href names one. */
  source_target?: ConceptId;
  /** False: the link already dangled in the source. */
  target_present_in_source?: boolean;
}

export type TransferKindState = "governed_both" | "governed_target" | "ungoverned_both" | "allowed_ungoverned" | "missing";

export interface TransferEntry {
  source: ConceptId;
  source_version: Version;
  target: ConceptId;
  type: string;
  rewrites: LinkRewrite[];
  rewrite_counts: Record<LinkRewriteKind, number>;
  /** Frontmatter string values equal to a selected source id; reported, never changed. */
  frontmatter_id_mentions: string[];
  kind_state: TransferKindState;
  /** Against the target registry, as `doc write` reports them. */
  validation_warnings: ValidationWarning[];
}

export interface TransferCounts {
  documents: number;
  local: number;
  qualified: number;
  dequalified: number;
  unchanged: number;
  dangling_in_source: number;
}

export interface TransferPlan {
  contract: typeof DOCUMENT_TRANSFER_CONTRACT;
  from: { alias: string; bundle_id: string; label: string; pin?: CommitPin };
  target: { okf_version: "0.1" | "0.2"; bundle_id?: string; dependencies_version: Version | null };
  /** Ordered by target id. */
  entries: TransferEntry[];
  record: { id: ConceptId; frontmatter: Frontmatter; body: string };
  /** Source document counts by type that were not selected. */
  left_behind: Record<string, number>;
  counts: TransferCounts;
  conflicts: TransferConflict[];
  ready: boolean;
  /** Present only when ready. */
  plan_token?: string;
}

export interface TransferWritten {
  source: ConceptId;
  target: ConceptId;
  version: Version;
}

export interface TransferResult {
  record: { id: ConceptId; version: Version; state: "applied" };
  /** Every document the record names, with its version. */
  written: TransferWritten[];
  /** False when the record was already applied and this call wrote nothing. */
  changed: boolean;
  /**
   * Resume of a refresh only: pending copies it left as they are because the copy or its source
   * moved since the refresh was planned. The record keeps their old baseline, so the next refresh
   * plan reports them again.
   */
  left?: Array<{ source: ConceptId; target: ConceptId; detail: string }>;
}

// ── Typed failures ─────────────────────────────────────────────────────────

/** Apply was asked for a plan that has conflicts. Nothing was written. */
export class TransferConflictError extends Error {
  readonly conflicts: TransferConflict[];
  constructor(conflicts: TransferConflict[]) {
    const first = conflicts[0];
    super(`the import plan has ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}${first ? `; first: ${first.code}: ${first.detail}` : ""}. Nothing was written.`);
    this.name = "TransferConflictError";
    this.conflicts = conflicts;
  }
}

/** The plan recomputed at apply differs from the token the caller presented. Nothing was written. */
export class TransferPlanChanged extends Error {
  readonly expected: string;
  readonly current: string;
  constructor(expected: string, current: string) {
    super(`the import plan changed since it was shown (expected ${expected}, current ${current}). Nothing was written; inspect a fresh plan.`);
    this.name = "TransferPlanChanged";
    this.expected = expected;
    this.current = current;
  }
}

/**
 * A write failed after the Promotion record was created. The record stays at `applying`; the
 * listed documents were written and the pending ones were not. Resume the record to finish.
 */
export class TransferInterrupted extends Error {
  readonly recordId: ConceptId;
  readonly written: TransferWritten[];
  readonly pending: Array<{ source: ConceptId; target: ConceptId }>;
  /** The state the record was left in: `applying` for an import, `refreshing` for a refresh. */
  readonly state: "applying" | "refreshing";
  override readonly cause: unknown;
  constructor(
    recordId: ConceptId,
    written: TransferWritten[],
    pending: Array<{ source: ConceptId; target: ConceptId }>,
    cause: unknown,
    state: "applying" | "refreshing" = "applying",
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      `the ${state === "applying" ? "import" : "refresh"} stopped after writing ${written.length} document${written.length === 1 ? "" : "s"}` +
        `${pending.length > 0 ? ` (${pending.length} not written, first '${pending[0]!.target}')` : ""}: ${why}. ` +
        `'${recordId}' stays at promotion_state ${state}; resume it to finish.`,
    );
    this.name = "TransferInterrupted";
    this.recordId = recordId;
    this.written = written;
    this.pending = pending;
    this.state = state;
    this.cause = cause;
  }
}

/** Resume met a record, source or target it cannot finish safely. Nothing further was written. */
export class TransferResumeConflict extends Error {
  readonly recordId: ConceptId;
  readonly id?: ConceptId;
  readonly written: TransferWritten[];
  constructor(recordId: ConceptId, detail: string, options: { id?: ConceptId; written?: TransferWritten[]; verb?: "resume" | "refresh" } = {}) {
    super(`cannot ${options.verb ?? "resume"} '${recordId}': ${detail}`);
    this.name = "TransferResumeConflict";
    this.recordId = recordId;
    if (options.id !== undefined) this.id = options.id;
    this.written = options.written ?? [];
  }
}

// ── Snapshots ──────────────────────────────────────────────────────────────

/** Documents that describe the source bundle itself; they never transfer. */
const SOURCE_SELF_DOCS = new Set<ConceptId>([BUNDLE_NAME_DOC_ID, DEPENDENCIES_DOC_ID]);

interface SourceSnapshot {
  ids: Set<ConceptId>;
  /** Identity fold of every source id, to spot links that only a case- or normalization-insensitive host resolves. */
  folds: Set<string>;
  docs: Map<ConceptId, ReadResult>;
  malformed: Map<ConceptId, string>;
  dependencies: ParsedDependencies;
  registry: KindRegistry;
  bundle: Bundle;
}

interface TargetSnapshot {
  okfVersion: "0.1" | "0.2";
  bundleId?: string;
  dependencies: ParsedDependencies;
  dependenciesVersion: Version | null;
  ids: Set<ConceptId>;
  registry: KindRegistry;
}

function isAbsent(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "ENOENT";
}

async function readOptional(bundle: Bundle, id: ConceptId): Promise<ReadResult | null> {
  try {
    return await readDocVersioned(bundle, id);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

async function readSource(binding: BundleBinding): Promise<SourceSnapshot> {
  const bundle: Bundle = { root: binding.label, backend: binding.backend };
  const listed = await binding.backend.list();
  const malformed = new Map<ConceptId, string>();
  const results = await readManyExisting(binding.backend, listed, (skip) => malformed.set(skip.id, skip.reason));
  const docs = new Map(results.map((result) => [result.doc.id, result]));
  const ids = new Set<ConceptId>([...docs.keys(), ...malformed.keys()]);
  const dependencies = parseDependencies(docs.get(DEPENDENCIES_DOC_ID)?.doc ?? null, { selfBundleId: binding.identity });
  const folds = new Set([...ids].map(foldIdentityPath));
  return { ids, folds, docs, malformed, dependencies, registry: await loadKinds(bundle), bundle };
}

async function readTarget(target: Bundle): Promise<TargetSnapshot> {
  const edition = (await readBundleOkfVersion(target)) ?? "0.1";
  if (edition !== "0.1" && edition !== "0.2") {
    throw new InvalidInputError(`Unsupported OKF version '${edition}' in the target bundle. This build can write 0.1 and 0.2 bundles.`);
  }
  const named = await readOptional(target, BUNDLE_NAME_DOC_ID);
  const bundleId = declaredBundleId(named?.doc);
  const deps = await readOptional(target, DEPENDENCIES_DOC_ID);
  const ids = new Set(await backendFor(target).list());
  const snapshot: TargetSnapshot = {
    okfVersion: edition,
    dependencies: parseDependencies(deps?.doc ?? null, { selfBundleId: bundleId }),
    dependenciesVersion: deps?.version ?? null,
    ids,
    registry: await loadKinds(target),
  };
  if (bundleId !== undefined) snapshot.bundleId = bundleId;
  return snapshot;
}

// ── Link rewrite ───────────────────────────────────────────────────────────

const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

interface RewriteContext {
  alias: string;
  source: SourceSnapshot;
  target: TargetSnapshot;
  /** Selected source id -> target id. */
  mapping: ReadonlyMap<ConceptId, ConceptId>;
}

function folderOf(id: ConceptId): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(0, slash) : "";
}

function targetAliasFor(dependencies: ParsedDependencies, bundleId: string): string | undefined {
  for (const entry of dependencies.dependencies.values()) if (entry.bundle_id === bundleId) return entry.alias;
  return undefined;
}

/** Decide one link of `sourceId` (written at `targetId`). Pushes a conflict when the link cannot be carried. */
function planLink(
  ctx: RewriteContext,
  sourceId: ConceptId,
  targetId: ConceptId,
  span: MarkdownLinkSpan,
  conflicts: TransferConflict[],
): LinkRewrite {
  const href = span.href;
  const base = { offset: span.hrefStart, from_href: href };
  const keep = (reason: LinkUntouchedReason, extra: Partial<LinkRewrite> = {}): LinkRewrite =>
    ({ ...base, to_href: href, kind: "unchanged", reason, ...extra });

  if (isQualifiedHref(href)) {
    if (span.image) return keep("image");
    const parsed = parseQualifiedHref(href);
    if (!parsed.ok) return keep("invalid_qualified");
    const declared = ctx.source.dependencies.dependencies.get(parsed.ref.alias);
    if (!declared) {
      conflicts.push({ code: "qualified_alias_mismatch", source: sourceId, target: targetId, detail: `'${href}' uses alias '${parsed.ref.alias}', which the source bundle does not declare` });
      return keep("already_qualified");
    }
    if (ctx.target.bundleId !== undefined && declared.bundle_id === ctx.target.bundleId) {
      try {
        const to = emitLinkHref({ kind: "local", from: targetId, to: parsed.ref.id, ...(parsed.fragment === undefined ? {} : { fragment: parsed.fragment }) });
        return { ...base, to_href: to, kind: "dequalified" };
      } catch (error) {
        if (!(error instanceof InvalidInputError)) throw error;
        return keep("not_qualifiable");
      }
    }
    const alias = targetAliasFor(ctx.target.dependencies, declared.bundle_id);
    if (alias === undefined) {
      conflicts.push({ code: "qualified_alias_mismatch", source: sourceId, target: targetId, detail: `'${href}' points into '${declared.bundle_id}', which the target bundle does not declare` });
      return keep("already_qualified");
    }
    if (alias === parsed.ref.alias) return keep("already_qualified");
    const to = emitLinkHref({ kind: "qualified", alias, id: parsed.ref.id, ...(parsed.fragment === undefined ? {} : { fragment: parsed.fragment }) });
    return { ...base, to_href: to, kind: "qualified" };
  }
  if (ANY_SCHEME.test(href) || href.startsWith("//")) return keep("external");
  if (href.startsWith("#")) return keep("anchor");
  if (span.image) return keep("image");

  const hash = href.indexOf("#");
  const pathPart = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? undefined : href.slice(hash + 1);
  if (pathPart.includes("?")) return keep("has_query");
  if (!pathPart.endsWith(".md")) return keep("non_document");
  // Normalize against the source document's folder before any stripping: a link that climbs
  // above the root has no target in the source bundle, so no id is guessed for it.
  const segments = pathPart.startsWith("/")
    ? normalizeSegments(pathPart.slice(1).split("/"))
    : normalizeSegments([...folderOf(sourceId).split("/"), ...pathPart.split("/")]);
  if (segments[0] === "..") return keep("escapes_source_root");
  if (isReservedFile(segments.join("/"))) return keep("non_document");
  const resolved = resolveConceptId(sourceId, pathPart);
  if (resolved === null) return keep("non_document");

  const present = ctx.source.ids.has(resolved);
  // A spelling variant of a source id names no document under the exact-identity rule; qualifying
  // it would send a reader to an id the source bundle refuses to serve.
  if (!present && ctx.source.folds.has(foldIdentityPath(resolved))) return keep("case_variant", { source_target: resolved });
  const withFragment = fragment === undefined ? {} : { fragment };
  const mapped = ctx.mapping.get(resolved);
  if (mapped !== undefined) {
    try {
      const to = emitLinkHref({ kind: "local", from: targetId, to: mapped, ...withFragment });
      return { ...base, to_href: to, kind: "local", source_target: resolved, target_present_in_source: true };
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      return keep("not_qualifiable", { source_target: resolved, target_present_in_source: true });
    }
  }
  try {
    const to = emitLinkHref({ kind: "qualified", alias: ctx.alias, id: resolved, ...withFragment });
    return { ...base, to_href: to, kind: "qualified", source_target: resolved, target_present_in_source: present };
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error;
    return keep("not_qualifiable", { source_target: resolved, target_present_in_source: present });
  }
}

const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)/gm;

/** Reference-style link definitions outside code, which v1 copies unchanged and only reports. */
function referenceDefinitions(body: string): Array<{ offset: number; href: string }> {
  const masked = maskMarkdownCode(body);
  const out: Array<{ offset: number; href: string }> = [];
  for (const match of masked.matchAll(REFERENCE_DEFINITION)) {
    const href = match[1]!;
    const offset = match.index! + match[0].length - href.length;
    out.push({ offset, href: body.slice(offset, offset + href.length) });
  }
  return out;
}

/** Rewrite every link of one body. Links inside code are reported as `in_code` and left alone. */
function rewriteTransferBody(
  ctx: RewriteContext,
  sourceId: ConceptId,
  targetId: ConceptId,
  body: string,
  conflicts: TransferConflict[],
): { body: string; rewrites: LinkRewrite[] } {
  const spans = extractMarkdownLinkSpans(body, { skipCode: true });
  const live = new Set(spans.map((span) => span.hrefStart));
  const rewrites: LinkRewrite[] = [];
  for (const span of extractMarkdownLinkSpans(body)) {
    if (!live.has(span.hrefStart)) {
      rewrites.push({ offset: span.hrefStart, from_href: span.href, to_href: span.href, kind: "unchanged", reason: "in_code" });
    }
  }
  const byOffset = new Map<number, LinkRewrite>();
  for (const span of spans) {
    const rewrite = planLink(ctx, sourceId, targetId, span, conflicts);
    byOffset.set(span.hrefStart, rewrite);
    rewrites.push(rewrite);
  }
  for (const definition of referenceDefinitions(body)) {
    rewrites.push({ offset: definition.offset, from_href: definition.href, to_href: definition.href, kind: "unchanged", reason: "reference_definition" });
  }
  rewrites.sort((a, b) => a.offset - b.offset);
  const next = rewriteMarkdownLinks(body, spans, (span) => {
    const rewrite = byOffset.get(span.hrefStart)!;
    return rewrite.kind === "unchanged" ? undefined : rewrite.to_href;
  });
  return { body: next, rewrites };
}

// ── Plan computation ───────────────────────────────────────────────────────

interface Computed {
  plan: TransferPlan;
  candidates: Map<ConceptId, DocumentMutationCandidate>;
}

function emptyRewriteCounts(): Record<LinkRewriteKind, number> {
  return { local: 0, qualified: 0, dequalified: 0, unchanged: 0 };
}

function idMentions(value: unknown, selected: ReadonlySet<ConceptId>, out: Set<string>): void {
  if (typeof value === "string") {
    if (selected.has(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) idMentions(item, selected, out);
  } else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const item of Object.values(value as Record<string, unknown>)) idMentions(item, selected, out);
  }
}

function sourcesEntryTitle(bundleId: string, version: Version): string {
  return `Imported from ${bundleId} at ${version}`;
}

function hashOf(value: unknown): string {
  return sha256HexOfUtf8(JSON.stringify(value));
}

function defaultRecordId(alias: string, bundleId: string, prefix: string | undefined, ids: readonly ConceptId[]): ConceptId {
  const digest = hashOf({ bundle_id: bundleId, prefix: prefix ?? null, ids: [...ids].sort(compareStorageKeys) }).slice(0, 12);
  return `${PROMOTIONS_PREFIX}${alias}-${digest}`;
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  const trimmed = trimTrailingSlashes(prefix.trim());
  return trimmed === "" ? undefined : trimmed;
}

/** Every planned id must be safe, absent, unique and distinct under the filesystem identity fold. */
const PROTECTED_TARGET_FOLDS = new Set([BUNDLE_NAME_DOC_ID, DEPENDENCIES_DOC_ID].map(foldIdentityPath));
const CONVENTIONS_FOLD = `${foldIdentityPath(CONVENTIONS_PREFIX.replace(/\/$/, ""))}/`;

/**
 * Throw {@link InvalidInputError} unless an import may create `id`: a safe, unreserved concept id
 * that is not the target's own identity or dependency declaration and not a Kind convention
 * (installing Kinds is not part of v1). Compared under the identity fold, so a case or
 * normalization variant of a protected id is refused too.
 */
function assertImportableTargetId(id: ConceptId): void {
  assertSafeConceptId(id);
  if (isReservedFile(pathFromConceptId(id))) throw new InvalidInputError("index.md and log.md are reserved files, not documents");
  const fold = foldIdentityPath(id);
  if (PROTECTED_TARGET_FOLDS.has(fold)) throw new InvalidInputError("it is the bundle's own identity or dependency declaration");
  if (fold.startsWith(CONVENTIONS_FOLD)) throw new InvalidInputError("an import never installs a Kind convention");
}

function checkTargetIds(
  planned: ReadonlyArray<{ source?: ConceptId; target: ConceptId; record?: true }>,
  existing: ReadonlySet<ConceptId>,
  conflicts: TransferConflict[],
): void {
  const folds = new Map<string, string>();
  const remember = (id: ConceptId): Array<[string, string]> => {
    const keys: Array<[string, string]> = [[`${foldIdentityPath(id)}.md`, `${id}.md`]];
    const segments = id.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      keys.push([`${foldIdentityPath(dir)}/`, `${dir}/`]);
    }
    return keys;
  };
  for (const id of existing) for (const [fold, exact] of remember(id)) if (!folds.has(fold)) folds.set(fold, exact);
  const seen = new Set<ConceptId>();
  for (const row of planned) {
    const where = { ...(row.source === undefined ? {} : { source: row.source }), target: row.target };
    try {
      assertImportableTargetId(row.target);
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      conflicts.push({ code: "unsafe_target_id", ...where, detail: `'${row.target}' is not a usable document id: ${error.message}` });
      continue;
    }
    if (existing.has(row.target)) {
      conflicts.push(row.record
        ? { code: "record_exists", target: row.target, detail: `the Promotion record '${row.target}' already exists` }
        : { code: "target_exists", ...where, detail: `'${row.target}' already exists in the target bundle; import never overwrites` });
      continue;
    }
    if (seen.has(row.target)) {
      conflicts.push({ code: "duplicate_target", ...where, detail: `two documents map to '${row.target}'` });
      continue;
    }
    seen.add(row.target);
    let collided = false;
    for (const [fold, exact] of remember(row.target)) {
      const prior = folds.get(fold);
      if (prior !== undefined && prior !== exact && !collided) {
        conflicts.push({ code: "case_collision", ...where, detail: `'${exact}' and '${prior}' name one file on a case- or normalization-insensitive filesystem` });
        collided = true;
      }
      if (prior === undefined) folds.set(fold, exact);
    }
  }
}

function recordFrontmatter(
  plan: Pick<TransferPlan, "from" | "counts" | "left_behind" | "entries">,
  prefix: string | undefined,
  state: "applying" | "applied",
  token: string | undefined,
  targetVersions: ReadonlyMap<ConceptId, Version>,
): Frontmatter {
  const n = plan.entries.length;
  const frontmatter: Frontmatter = {
    type: PROMOTION_TYPE,
    title: `Import of ${n} document${n === 1 ? "" : "s"} from ${plan.from.alias}`,
    description: `${n} document${n === 1 ? "" : "s"} from ${plan.from.bundle_id} into ${prefix ?? "the same ids"}, ${plan.counts.qualified} link${plan.counts.qualified === 1 ? "" : "s"} qualified.`,
    promotion_state: state,
    from_alias: plan.from.alias,
    from_bundle_id: plan.from.bundle_id,
    from_label: plan.from.label,
  };
  if (plan.from.pin) frontmatter.from_pin = plan.from.pin.value;
  if (prefix !== undefined) frontmatter.target_prefix = prefix;
  if (token !== undefined) frontmatter.plan_token = token;
  frontmatter.counts = { ...plan.counts };
  frontmatter.left_behind = { ...plan.left_behind };
  frontmatter.entries = plan.entries.map((entry) => {
    const row: Record<string, string> = { source: entry.source, source_version: entry.source_version, target: entry.target };
    const version = targetVersions.get(entry.target);
    if (version !== undefined) row.target_version = version;
    return row;
  });
  return frontmatter;
}

function recordBody(recordId: ConceptId, plan: Pick<TransferPlan, "from" | "entries">): string {
  const lines = [
    `Imported ${plan.entries.length} document${plan.entries.length === 1 ? "" : "s"} from the bundle ` +
      `\`${plan.from.bundle_id}\` (alias \`${plan.from.alias}\`). This record is the journal of the import: ` +
      "`promotion_state` stays `applying` until every document is written, and resuming this record " +
      "finishes an interrupted import. Each line links the imported document and its origin.",
    "",
  ];
  for (const entry of plan.entries) {
    const parts: string[] = [];
    try {
      parts.push(`[imported](${emitLinkHref({ kind: "local", from: recordId, to: entry.target })})`);
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
    }
    try {
      parts.push(`[from](${emitLinkHref({ kind: "qualified", alias: plan.from.alias, id: entry.source })})`);
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
    }
    lines.push(`- \`${entry.source}\` ${parts.join(" ")}`.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

interface BuiltEntry {
  entry: TransferEntry;
  candidate: DocumentMutationCandidate;
}

/** Rewrite, provenance and validation for one selected document. Shared by plan and resume. */
function buildEntry(
  ctx: RewriteContext,
  fromBundleId: string,
  recordId: ConceptId,
  read: ReadResult,
  targetId: ConceptId,
  selected: ReadonlySet<ConceptId>,
  allowUngoverned: boolean,
  actor: string | undefined,
  now: () => string,
  conflicts: TransferConflict[],
): BuiltEntry {
  const { doc, version } = read;
  const type = String(doc.frontmatter.type ?? "");
  const { body, rewrites } = rewriteTransferBody(ctx, doc.id, targetId, doc.body, conflicts);
  const counts = emptyRewriteCounts();
  for (const rewrite of rewrites) counts[rewrite.kind]++;
  const mentions = new Set<string>();
  idMentions(doc.frontmatter, selected, mentions);

  const frontmatter = structuredClone(doc.frontmatter);
  let resource: string;
  try {
    resource = qualifiedHref({ alias: ctx.alias, id: doc.id });
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error;
    resource = `okf://${ctx.alias}/${doc.id}.md`;
    conflicts.push({ code: "source_malformed", source: doc.id, target: targetId, detail: `'${doc.id}' cannot be named by a cross-bundle href: ${error.message}` });
  }
  const provenance = { resource, id: recordId, title: sourcesEntryTitle(fromBundleId, version) };
  if (frontmatter.sources === undefined) frontmatter.sources = [provenance];
  else if (Array.isArray(frontmatter.sources)) frontmatter.sources = [...frontmatter.sources, provenance];
  else conflicts.push({ code: "source_malformed", source: doc.id, target: targetId, detail: "its sources field is not a list, so no provenance entry can be added" });

  const sourceGoverned = ctx.source.registry.kinds.has(type);
  const targetGoverned = ctx.target.registry.kinds.has(type);
  const kindState: TransferKindState = targetGoverned
    ? sourceGoverned ? "governed_both" : "governed_target"
    : sourceGoverned ? allowUngoverned ? "allowed_ungoverned" : "missing" : "ungoverned_both";

  const candidate: DocumentMutationCandidate = { frontmatter, body };
  let warnings: ValidationWarning[] = [];
  try {
    warnings = prepareDocumentMutationCandidate(undefined, structuredClone(candidate), {
      id: targetId,
      registry: ctx.target.registry,
      strict: false,
      okfVersion: ctx.target.okfVersion,
      actor,
      now,
      seedGenerationClock: false,
    }).warnings;
  } catch (error) {
    if (error instanceof OkfActorError) throw error;
    conflicts.push({ code: "source_malformed", source: doc.id, target: targetId, detail: `the target would refuse this document: ${error instanceof Error ? error.message : String(error)}` });
  }

  return {
    entry: {
      source: doc.id,
      source_version: version,
      target: targetId,
      type,
      rewrites,
      rewrite_counts: counts,
      frontmatter_id_mentions: [...mentions].sort(compareStorageKeys),
      kind_state: kindState,
      validation_warnings: warnings,
    },
    candidate,
  };
}

async function sourceIdentity(
  from: TransferSource,
  target: TargetSnapshot,
  conflicts: TransferConflict[],
): Promise<{ bundleId: string; pin?: CommitPin }> {
  const { alias, binding } = from;
  const declared = target.dependencies.dependencies.get(alias);
  const bundleId = declared?.bundle_id ?? binding.identity ?? "";
  if (!declared) {
    const rejected = target.dependencies.rejected.get(alias);
    conflicts.push({ code: "alias_undeclared", detail: rejected === undefined
      ? `alias '${alias}' is not declared in the target's docs/dependencies`
      : `alias '${alias}' is declared in the target's docs/dependencies but rejected (${rejected})` });
    return { bundleId };
  }
  if (binding.identity === undefined) {
    conflicts.push({ code: "alias_identity", detail: `${binding.label} declares no bundle_id; '${alias}' expects '${declared.bundle_id}'` });
  } else if (binding.identity !== declared.bundle_id) {
    conflicts.push({ code: "alias_identity", detail: `${binding.label} is '${binding.identity}', not '${declared.bundle_id}' as '${alias}' declares` });
  }
  const pin = declared.pin;
  if (pin === undefined) return { bundleId };
  if (pin.kind === "digest") {
    conflicts.push({ code: "alias_identity", detail: "a digest pin is verified only by a hosted resolver" });
    return { bundleId };
  }
  const commit: CommitPin = { kind: "commit", value: pin.value };
  if (!binding.pin) {
    conflicts.push({ code: "alias_identity", detail: `no pin check is available for ${binding.label}` });
  } else {
    const verdict = await binding.pin(commit).catch((error: unknown) => ({ ok: false as const, detail: `pin check failed: ${error instanceof Error ? error.message : String(error)}` }));
    if (!verdict.ok) conflicts.push({ code: "alias_identity", detail: verdict.detail });
  }
  return { bundleId, pin: commit };
}

function assertActor(actor: string | undefined, okfVersion: "0.1" | "0.2"): void {
  if (actor !== undefined && okfVersion === "0.2" && !isOkfActor(actor)) {
    throw new OkfActorError(actor, `OKF v0.2 mutation actor '${actor}' must be human:<id>, process:<id>, or <producer>/<version>`);
  }
}

async function computeTransfer(request: TransferRequest): Promise<Computed> {
  const conflicts: TransferConflict[] = [];
  const now = request.now ?? (() => new Date().toISOString());
  const target = await readTarget(request.target);
  assertActor(request.actor, target.okfVersion);
  const { bundleId, pin } = await sourceIdentity(request.from, target, conflicts);
  const source = await readSource(request.from.binding);
  const prefix = normalizePrefix(request.prefix);

  // Selection: the union of ids, types and prefixes. Reserved files are never listed.
  const selected = new Set<ConceptId>();
  for (const id of request.select.ids ?? []) {
    if (SOURCE_SELF_DOCS.has(id)) {
      conflicts.push({ code: "source_missing", source: id, detail: `'${id}' describes the source bundle itself and never transfers` });
    } else if (source.malformed.has(id)) {
      conflicts.push({ code: "source_malformed", source: id, detail: `'${id}' is malformed in the source: ${source.malformed.get(id)}` });
    } else if (!source.docs.has(id)) {
      conflicts.push({ code: "source_missing", source: id, detail: `'${id}' is not in ${request.from.binding.label}` });
    } else {
      selected.add(id);
    }
  }
  const types = new Set(request.select.types ?? []);
  const prefixes = (request.select.prefixes ?? []).map((p) => trimTrailingSlashes(p.trim())).filter((p) => p !== "");
  const underPrefix = (id: ConceptId): boolean => prefixes.some((p) => id === p || id.startsWith(`${p}/`));
  for (const [id, { doc }] of source.docs) {
    if (SOURCE_SELF_DOCS.has(id)) continue;
    if (types.has(String(doc.frontmatter.type)) || underPrefix(id)) selected.add(id);
  }
  for (const [id, reason] of source.malformed) {
    if (!SOURCE_SELF_DOCS.has(id) && underPrefix(id)) {
      conflicts.push({ code: "source_malformed", source: id, detail: `'${id}' is malformed in the source: ${reason}` });
    }
  }
  if (selected.size === 0 && conflicts.every((c) => c.code !== "source_missing" && c.code !== "source_malformed")) {
    conflicts.push({ code: "selection_empty", detail: "the selection matches no source document" });
  }

  const selectedIds = [...selected].sort(compareStorageKeys);
  const mapping = new Map<ConceptId, ConceptId>(selectedIds.map((id) => [id, prefix === undefined ? id : `${prefix}/${id}`]));
  const recordId = request.recordId?.trim() || defaultRecordId(request.from.alias, bundleId, prefix, selectedIds);
  checkTargetIds(
    [...[...mapping].map(([s, t]) => ({ source: s, target: t })), { target: recordId, record: true as const }],
    target.ids,
    conflicts,
  );
  for (const conflict of conflicts) {
    if (conflict.code !== "target_exists" || conflict.target === undefined) continue;
    const promotedBy = await promotingRecord(request.target, conflict.target, request.from.alias);
    if (promotedBy === undefined) continue;
    conflict.record = promotedBy;
    conflict.detail += `; it is a copy promoted by '${promotedBy}', which a refresh of that record updates`;
  }

  const ctx: RewriteContext = { alias: request.from.alias, source, target, mapping };
  const built: BuiltEntry[] = [];
  for (const id of selectedIds) {
    built.push(buildEntry(ctx, bundleId, recordId, source.docs.get(id)!, mapping.get(id)!, selected, request.allowUngoverned === true, request.actor, now, conflicts));
  }
  built.sort((a, b) => compareStorageKeys(a.entry.target, b.entry.target));

  const missingKinds = new Map<string, number>();
  for (const { entry } of built) if (entry.kind_state === "missing") missingKinds.set(entry.type, (missingKinds.get(entry.type) ?? 0) + 1);
  for (const [type, count] of missingKinds) {
    conflicts.push({ code: "kind_missing", detail: `'${type}' is governed in the source but not in the target (${count} selected document${count === 1 ? "" : "s"}); declare the Kind in the target or allow ungoverned documents` });
  }

  const leftBehind: Record<string, number> = {};
  for (const [id, { doc }] of [...source.docs].sort(([a], [b]) => compareStorageKeys(a, b))) {
    if (selected.has(id) || SOURCE_SELF_DOCS.has(id)) continue;
    const type = String(doc.frontmatter.type);
    leftBehind[type] = (leftBehind[type] ?? 0) + 1;
  }

  const counts: TransferCounts = { documents: built.length, local: 0, qualified: 0, dequalified: 0, unchanged: 0, dangling_in_source: 0 };
  for (const { entry } of built) {
    for (const rewrite of entry.rewrites) {
      counts[rewrite.kind]++;
      if (rewrite.kind === "qualified" && rewrite.target_present_in_source === false) counts.dangling_in_source++;
    }
  }

  const from: TransferPlan["from"] = { alias: request.from.alias, bundle_id: bundleId, label: request.from.label ?? request.from.binding.label };
  if (pin) from.pin = pin;
  const targetFacts: TransferPlan["target"] = { okf_version: target.okfVersion, dependencies_version: target.dependenciesVersion };
  if (target.bundleId !== undefined) targetFacts.bundle_id = target.bundleId;

  // Every governing convention the selection's types touch, on both sides.
  const conventionVersions: Array<{ type: string; source: Version | null; target: Version | null }> = [];
  for (const type of [...new Set(built.map((b) => b.entry.type))].sort(compareStorageKeys)) {
    const sourceKind = source.registry.kinds.get(type);
    const targetKind = target.registry.kinds.get(type);
    conventionVersions.push({
      type,
      source: sourceKind ? (source.docs.get(sourceKind.id)?.version ?? null) : null,
      target: targetKind ? ((await readOptional(request.target, targetKind.id))?.version ?? null) : null,
    });
  }

  const entries = built.map((b) => b.entry);
  const ready = conflicts.length === 0;
  const partial = { from, counts, left_behind: leftBehind, entries };
  let token: string | undefined;
  if (ready) {
    token = `${DOCUMENT_TRANSFER_CONTRACT}:sha256:${hashOf({
      contract: DOCUMENT_TRANSFER_CONTRACT,
      from: { bundle_id: bundleId, pin: pin?.value ?? null },
      target: { okf_version: target.okfVersion, bundle_id: target.bundleId ?? null, dependencies_version: target.dependenciesVersion },
      record: recordId,
      prefix: prefix ?? null,
      allow_ungoverned: request.allowUngoverned === true,
      conventions: conventionVersions,
      entries: built.map((b) => ({ source: b.entry.source, source_version: b.entry.source_version, target: b.entry.target, candidate: hashOf(b.candidate) })),
    })}`;
  }
  const plan: TransferPlan = {
    contract: DOCUMENT_TRANSFER_CONTRACT,
    from,
    target: targetFacts,
    entries,
    record: { id: recordId, frontmatter: recordFrontmatter(partial, prefix, "applying", token, new Map()), body: recordBody(recordId, partial) },
    left_behind: leftBehind,
    counts,
    conflicts,
    ready,
  };
  if (token !== undefined) plan.plan_token = token;
  return { plan, candidates: new Map(built.map((b) => [b.entry.source, b.candidate])) };
}

/** Read-only: compute what an import would write, its conflicts and, when it has none, its plan token. */
export async function planDocumentTransfer(request: TransferRequest): Promise<TransferPlan> {
  return (await computeTransfer(request)).plan;
}

// ── Writes ─────────────────────────────────────────────────────────────────

async function writeRecordState(
  target: Bundle,
  registry: KindRegistry,
  recordId: ConceptId,
  expectedVersion: Version,
  state: "applying" | "applied",
  versions: ReadonlyMap<ConceptId, Version>,
  actor: string | undefined,
  now: (() => string) | undefined,
  edited: ReadonlySet<ConceptId> = new Set(),
): Promise<Version> {
  const result = await mutateDocument({
    bundle: target,
    id: recordId,
    mode: "replace-document",
    onAbsent: "fail",
    expectedVersion,
    registry,
    strict: false,
    actor,
    ...(now ? { now } : {}),
    buildCandidate: (existing) => {
      const frontmatter = structuredClone(existing!.frontmatter);
      frontmatter.promotion_state = state;
      if (Array.isArray(frontmatter.entries)) {
        frontmatter.entries = frontmatter.entries.map((row: unknown) => {
          if (row === null || typeof row !== "object") return row;
          const entry = { ...(row as Record<string, unknown>) };
          const version = versions.get(String(entry.target));
          if (version !== undefined) entry.target_version = version;
          if (edited.has(String(entry.target))) entry.target_edited = true;
          return entry;
        });
      }
      return { frontmatter, body: existing!.body };
    },
  });
  return result.version;
}

/**
 * Recompute the plan from fresh reads, refuse unless it is ready and its token equals
 * `planToken`, then write: the record (`applying`), each document create-only in plan order, and
 * the record again (`applied`). A failed document write throws {@link TransferInterrupted} and
 * leaves the record at `applying`; nothing is deleted or overwritten.
 */
export async function applyDocumentTransfer(request: TransferRequest, planToken: string): Promise<TransferResult> {
  const { plan, candidates } = await computeTransfer(request);
  if (!plan.ready) {
    // Idempotence: the same token applied again after it completed is a no-op success.
    const prior = plan.conflicts.some((c) => c.code === "record_exists") ? await readOptional(request.target, plan.record.id) : null;
    if (prior && prior.doc.frontmatter.type === PROMOTION_TYPE && prior.doc.frontmatter.plan_token === planToken.trim()) {
      const record = parseRecord(plan.record.id, prior.doc);
      if (record.state === "applied") return appliedResult(plan.record.id, prior.version, record.entries, false);
      throw new TransferConflictError([{ code: "record_exists", target: plan.record.id, detail: `'${plan.record.id}' from this plan is still ${record.state}; resume it to finish` }]);
    }
    throw new TransferConflictError(plan.conflicts);
  }
  if (plan.plan_token !== planToken.trim()) throw new TransferPlanChanged(planToken.trim(), plan.plan_token!);

  const registry = await loadKinds(request.target);
  const recordId = plan.record.id;
  let recordVersion: Version;
  try {
    recordVersion = (await mutateDocument({
      bundle: request.target,
      id: recordId,
      mode: "create-only",
      registry,
      strict: false,
      actor: request.actor,
      ...(request.now ? { now: request.now } : {}),
      buildCandidate: () => ({ frontmatter: structuredClone(plan.record.frontmatter), body: plan.record.body }),
    })).version;
  } catch (error) {
    if (error instanceof VersionConflict) {
      throw new TransferConflictError([{ code: "record_exists", target: recordId, detail: `the Promotion record '${recordId}' was created by another writer` }]);
    }
    throw error;
  }

  const written: TransferWritten[] = [];
  const versions = new Map<ConceptId, Version>();
  for (let index = 0; index < plan.entries.length; index++) {
    const entry = plan.entries[index]!;
    try {
      const result = await mutateDocument({
        bundle: request.target,
        id: entry.target,
        mode: "create-only",
        registry,
        strict: false,
        actor: request.actor,
        seedGenerationClock: false,
        ...(request.now ? { now: request.now } : {}),
        buildCandidate: () => structuredClone(candidates.get(entry.source)!),
      });
      written.push({ source: entry.source, target: entry.target, version: result.version });
      versions.set(entry.target, result.version);
    } catch (cause) {
      // Best effort: record the versions written so far; the record stays `applying` either way.
      await writeRecordState(request.target, registry, recordId, recordVersion, "applying", versions, request.actor, request.now).catch(() => undefined);
      throw new TransferInterrupted(recordId, written, plan.entries.slice(index).map((e) => ({ source: e.source, target: e.target })), cause);
    }
  }
  try {
    recordVersion = await writeRecordState(request.target, registry, recordId, recordVersion, "applied", versions, request.actor, request.now);
  } catch (cause) {
    throw new TransferInterrupted(recordId, written, [], cause);
  }
  return { record: { id: recordId, version: recordVersion, state: "applied" }, written, changed: true };
}

interface RecordEntry {
  source: ConceptId;
  source_version: Version;
  target: ConceptId;
  target_version?: Version;
  /** The copy at `target_version` is not known to be what the import wrote (it was edited before a resume adopted it). */
  target_edited?: true;
}

type RecordState = "applying" | "applied" | "refreshing";

/** One pending row of a refresh: the copy at `target`, at `replaces_version`, becomes the source at `source_version`. */
interface RefreshJournalEntry {
  source: ConceptId;
  source_version: Version;
  target: ConceptId;
  replaces_version: Version;
}

interface ParsedRecord {
  state: RecordState;
  alias: string;
  bundleId: string;
  prefix?: string;
  entries: RecordEntry[];
  /** Present only while `refreshing`. */
  refresh?: RefreshJournalEntry[];
}

function parseRecord(recordId: ConceptId, doc: OkfDocument, verb: "resume" | "refresh" = "resume"): ParsedRecord {
  const fm = doc.frontmatter;
  const refuse = (detail: string): never => { throw new TransferResumeConflict(recordId, detail, { verb }); };
  if (String(fm.type).trim() !== PROMOTION_TYPE) refuse(`it is not a ${PROMOTION_TYPE} record (type '${String(fm.type)}')`);
  const state = fm.promotion_state;
  if (state !== "applying" && state !== "applied" && state !== "refreshing") refuse("promotion_state must be applying, applied or refreshing");
  if (typeof fm.from_alias !== "string" || typeof fm.from_bundle_id !== "string") refuse("from_alias and from_bundle_id are required");
  if (!Array.isArray(fm.entries)) refuse("entries must be a list");
  if (fm.target_prefix !== undefined && typeof fm.target_prefix !== "string") refuse("target_prefix must be a string");
  const prefix = normalizePrefix(fm.target_prefix as string | undefined);
  const entries: RecordEntry[] = [];
  for (const row of fm.entries as unknown[]) {
    const r = row as Record<string, unknown> | null;
    if (!r || typeof r.source !== "string" || typeof r.source_version !== "string" || typeof r.target !== "string") {
      refuse("every entry needs source, source_version and target");
    }
    const entry: RecordEntry = { source: r!.source as string, source_version: r!.source_version as string, target: r!.target as string };
    if (typeof r!.target_version === "string") entry.target_version = r!.target_version;
    if (r!.target_edited === true) entry.target_edited = true;
    // The record is a document anyone can edit: every target is recomputed from its source and
    // the record's prefix, and must pass the same rule a plan applies, before resume trusts it.
    if (SOURCE_SELF_DOCS.has(entry.source)) refuse(`'${entry.source}' describes the source bundle itself and never transfers`);
    const expected = prefix === undefined ? entry.source : `${prefix}/${entry.source}`;
    if (entry.target !== expected) refuse(`entry '${entry.source}' targets '${entry.target}', not '${expected}' as the record's prefix requires`);
    try {
      assertSafeConceptId(entry.source);
      assertImportableTargetId(entry.target);
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      refuse(`'${entry.target}' is not a target an import may write: ${error.message}`);
    }
    entries.push(entry);
  }
  const parsed: ParsedRecord = { state: state as RecordState, alias: fm.from_alias as string, bundleId: fm.from_bundle_id as string, ...(prefix === undefined ? {} : { prefix }), entries };
  if (state === "refreshing") {
    const journal = fm.refresh as Record<string, unknown> | null | undefined;
    if (!journal || typeof journal !== "object" || !Array.isArray(journal.entries)) refuse("a refreshing record needs refresh.entries");
    const byTarget = new Map(entries.map((e) => [e.target, e]));
    parsed.refresh = [];
    for (const row of journal!.entries as unknown[]) {
      const r = row as Record<string, unknown> | null;
      if (!r || typeof r.source !== "string" || typeof r.source_version !== "string" || typeof r.target !== "string" || typeof r.replaces_version !== "string") {
        refuse("every refresh entry needs source, source_version, target and replaces_version");
      }
      // A pending row may only name an entry the record already holds, with the same source.
      if (byTarget.get(r!.target as string)?.source !== r!.source) refuse(`refresh entry '${String(r!.target)}' is not an entry of this record`);
      parsed.refresh.push({ source: r!.source as string, source_version: r!.source_version as string, target: r!.target as string, replaces_version: r!.replaces_version as string });
    }
  }
  return parsed;
}

/** The result an already-applied record stands for: nothing is written again. */
function appliedResult(recordId: ConceptId, version: Version, entries: readonly RecordEntry[], changed: boolean): TransferResult {
  const written: TransferWritten[] = [];
  for (const entry of entries) {
    if (entry.target_version === undefined) throw new TransferResumeConflict(recordId, `it is applied but '${entry.target}' has no target_version`);
    written.push({ source: entry.source, target: entry.target, version: entry.target_version });
  }
  return { record: { id: recordId, version, state: "applied" }, written, changed };
}

function provenanceEntries(doc: OkfDocument): Array<Record<string, unknown>> {
  const sources = doc.frontmatter.sources;
  return Array.isArray(sources) ? sources.filter((s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s)) : [];
}

/**
 * True when `doc` is what writing `candidate` over it would leave: the mutation service's own no-op
 * test, attributed to whichever actor the copy names (the writer may not be the resuming actor).
 */
function isWrittenCopy(doc: OkfDocument, candidate: DocumentMutationCandidate, registry: KindRegistry, okfVersion: "0.1" | "0.2"): boolean {
  const attributed = doc.frontmatter[okfVersion === "0.1" ? "actor" : SUPERBEE_UPDATED_BY_FIELD];
  try {
    return !prepareDocumentMutationCandidate(doc, structuredClone(candidate), {
      mode: "replace-document",
      id: doc.id,
      registry,
      strict: false,
      okfVersion,
      ...(typeof attributed === "string" ? { actor: attributed } : {}),
      seedGenerationClock: false,
    }).changed;
  } catch {
    return false;
  }
}

function hasProvenance(doc: OkfDocument, recordId: ConceptId): boolean {
  return provenanceEntries(doc).some((s) => s.id === recordId);
}

/** The Promotion record an existing copy at `id` names as its import from `alias`, if any. */
async function promotingRecord(target: Bundle, id: ConceptId, alias: string): Promise<ConceptId | undefined> {
  const read = await readOptional(target, id).catch(() => null);
  if (!read) return undefined;
  for (const entry of provenanceEntries(read.doc)) {
    if (typeof entry.id !== "string" || !entry.id.startsWith(PROMOTIONS_PREFIX)) continue;
    if (typeof entry.resource !== "string" || !entry.resource.startsWith(`okf://${alias}/`)) continue;
    const record = await readOptional(target, entry.id).catch(() => null);
    if (record && String(record.doc.frontmatter.type).trim() === PROMOTION_TYPE) return entry.id;
  }
  return undefined;
}

/**
 * Finish an `applying` Promotion record. For each entry: an absent target is created from the
 * source at the recorded source version (a changed source refuses); a present target carrying a
 * `sources` entry with this record's id is already done; anything else refuses. When every entry
 * is done the record becomes `applied`. Running it again on an `applied` record is a no-op.
 * A `refreshing` record is finished the same way by {@link finishRefresh}.
 */
export async function resumeDocumentTransfer(
  target: Bundle,
  recordId: ConceptId,
  from: TransferSource,
  options: { actor?: string; now?: () => string } = {},
): Promise<TransferResult> {
  const read = await readOptional(target, recordId);
  if (!read) throw new DocumentNotFoundError(recordId);
  const record = parseRecord(recordId, read.doc);
  if (record.alias !== from.alias) throw new TransferResumeConflict(recordId, `it was written for alias '${record.alias}', not '${from.alias}'`);
  if (from.binding.identity !== record.bundleId) {
    throw new TransferResumeConflict(recordId, `${from.binding.label} is '${from.binding.identity ?? "undeclared"}', not '${record.bundleId}'`);
  }
  if (record.state === "applied") return appliedResult(recordId, read.version, record.entries, false);
  if (record.state === "refreshing") return finishRefresh(target, recordId, read, record, from, options);

  const snapshot = await readTarget(target);
  assertActor(options.actor, snapshot.okfVersion);
  // The same alias and identity check a plan runs: the target's declaration may have moved since.
  const identity: TransferConflict[] = [];
  await sourceIdentity(from, snapshot, identity);
  if (identity.length > 0) throw new TransferResumeConflict(recordId, `${identity[0]!.code}: ${identity[0]!.detail}`);
  const source = await readSource(from.binding);
  const mapping = new Map(record.entries.map((e) => [e.source, e.target]));
  const selected = new Set(mapping.keys());
  const ctx: RewriteContext = { alias: from.alias, source, target: snapshot, mapping };
  const now = options.now ?? (() => new Date().toISOString());
  const registry = snapshot.registry;

  const written: TransferWritten[] = [];
  const versions = new Map<ConceptId, Version>();
  const edited = new Set<ConceptId>();
  for (const entry of record.entries) {
    let existing: ReadResult | null;
    try {
      existing = await readOptional(target, entry.target);
    } catch (error) {
      if (error instanceof FilesystemIdentityAliasError) {
        throw new TransferResumeConflict(recordId, `'${entry.target}' is spelled differently on disk: ${error.message}`, { id: entry.target, written });
      }
      throw error;
    }
    if (existing) {
      if (!hasProvenance(existing.doc, recordId)) {
        throw new TransferResumeConflict(recordId, `'${entry.target}' exists and was not written by this import`, { id: entry.target, written });
      }
      written.push({ source: entry.source, target: entry.target, version: existing.version });
      versions.set(entry.target, existing.version);
      // A copy edited after the interrupted write still carries the provenance; it is adopted, but
      // flagged so a refresh treats it as edited instead of as the import's own baseline.
      const sourceRead = source.docs.get(entry.source);
      const conflicts: TransferConflict[] = [];
      const built = sourceRead?.version === entry.source_version
        ? buildEntry(ctx, record.bundleId, recordId, sourceRead, entry.target, selected, true, options.actor, now, conflicts)
        : undefined;
      if (!built || conflicts.length > 0 || !isWrittenCopy(existing.doc, built.candidate, registry, snapshot.okfVersion)) edited.add(entry.target);
      continue;
    }
    const sourceDoc = source.docs.get(entry.source);
    if (!sourceDoc || sourceDoc.version !== entry.source_version) {
      throw new TransferResumeConflict(recordId, `the source '${entry.source}' is ${sourceDoc ? "changed" : "missing"} since the import was planned`, { id: entry.target, written });
    }
    const conflicts: TransferConflict[] = [];
    const built = buildEntry(ctx, record.bundleId, recordId, sourceDoc, entry.target, selected, true, options.actor, now, conflicts);
    if (conflicts.length > 0) throw new TransferResumeConflict(recordId, `${conflicts[0]!.code}: ${conflicts[0]!.detail}`, { id: entry.target, written });
    try {
      const result = await mutateDocument({
        bundle: target,
        id: entry.target,
        mode: "create-only",
        registry,
        strict: false,
        actor: options.actor,
        seedGenerationClock: false,
        ...(options.now ? { now: options.now } : {}),
        buildCandidate: () => built.candidate,
      });
      written.push({ source: entry.source, target: entry.target, version: result.version });
      versions.set(entry.target, result.version);
    } catch (error) {
      if (error instanceof VersionConflict) {
        throw new TransferResumeConflict(recordId, `'${entry.target}' was created by another writer during the resume`, { id: entry.target, written });
      }
      if (error instanceof FilesystemIdentityAliasError) {
        throw new TransferResumeConflict(recordId, `'${entry.target}' is spelled differently on disk: ${error.message}`, { id: entry.target, written });
      }
      throw error;
    }
  }
  const version = await writeRecordState(target, registry, recordId, read.version, "applied", versions, options.actor, options.now, edited);
  return { record: { id: recordId, version, state: "applied" }, written, changed: true };
}

// ── Refresh ────────────────────────────────────────────────────────────────

export const DOCUMENT_REFRESH_TOKEN_PREFIX = `${DOCUMENT_TRANSFER_CONTRACT}:refresh`;

/**
 * What a refresh does to one entry of the record: `update` replaces a copy whose source changed;
 * `overwrite` replaces a locally edited copy the caller named; `unchanged` and `skip` write
 * nothing; `conflict` blocks the plan (see the plan's conflicts).
 */
export type RefreshAction = "update" | "overwrite" | "unchanged" | "skip" | "conflict";

export interface RefreshRequest {
  /** A local bundle or git board holding the record. */
  target: Bundle;
  /** The applied Promotion record whose copies to refresh. */
  recordId: ConceptId;
  from: TransferSource;
  /** Copies (target or source ids) to replace even though they were edited in the target. */
  overwrite?: readonly ConceptId[];
  /** Copies (target or source ids) to leave as they are in this refresh. */
  skip?: readonly ConceptId[];
  actor?: string;
  now?: () => string;
}

export interface RefreshEntry {
  source: ConceptId;
  target: ConceptId;
  action: RefreshAction;
  /** The source version the record holds. */
  recorded_source_version: Version;
  /** The source version now, when the source document is present. */
  source_version?: Version;
  /** The copy's version the record holds. */
  recorded_target_version?: Version;
  /** The copy's version now; null when the copy is gone. */
  target_version: Version | null;
  /** True when the copy differs from the version the record last wrote. */
  edited: boolean;
  /** Outbound links of the copy that the new body no longer carries (update and overwrite only). */
  dropped_links: number;
  detail?: string;
}

export interface RefreshPlan {
  contract: typeof DOCUMENT_TRANSFER_CONTRACT;
  record: { id: ConceptId; version: Version; state: RecordState };
  from: { alias: string; bundle_id: string; label: string; pin?: CommitPin };
  /** In record order. */
  entries: RefreshEntry[];
  counts: Record<RefreshAction, number>;
  conflicts: TransferConflict[];
  /** No conflicts. A ready plan with no update or overwrite has nothing to write and no token. */
  ready: boolean;
  /** Present only when ready and something would be written. */
  plan_token?: string;
}

interface ComputedRefresh {
  plan: RefreshPlan;
  candidates: Map<ConceptId, DocumentMutationCandidate>;
  read: ReadResult;
}

function matchesEntry(names: ReadonlySet<string>, entry: RecordEntry): boolean {
  return names.has(entry.target) || names.has(entry.source);
}

async function computeRefresh(request: RefreshRequest): Promise<ComputedRefresh> {
  const conflicts: TransferConflict[] = [];
  const now = request.now ?? (() => new Date().toISOString());
  const read = await readOptional(request.target, request.recordId);
  if (!read) throw new DocumentNotFoundError(request.recordId);
  const record = parseRecord(request.recordId, read.doc, "refresh");
  const target = await readTarget(request.target);
  assertActor(request.actor, target.okfVersion);

  if (record.alias !== request.from.alias) {
    conflicts.push({ code: "alias_identity", detail: `'${request.recordId}' was written for alias '${record.alias}', not '${request.from.alias}'` });
  }
  const identity = await sourceIdentity(request.from, target, conflicts);
  if (identity.bundleId !== record.bundleId) {
    conflicts.push({ code: "alias_identity", detail: `'${request.recordId}' imported from '${record.bundleId}', but '${request.from.alias}' is '${identity.bundleId}'` });
  }
  if (record.state !== "applied") {
    conflicts.push({ code: "record_state", detail: `'${request.recordId}' is ${record.state}; resume it before a refresh` });
  }

  const overwrite = new Set(request.overwrite ?? []);
  const skip = new Set(request.skip ?? []);
  for (const name of [...overwrite, ...skip]) {
    if (!record.entries.some((e) => e.target === name || e.source === name)) {
      conflicts.push({ code: "not_in_record", target: name, detail: `'${name}' is not a copy '${request.recordId}' names` });
    }
  }
  for (const name of overwrite) {
    if (skip.has(name)) conflicts.push({ code: "not_in_record", target: name, detail: `'${name}' is named both to overwrite and to skip` });
  }

  const source = await readSource(request.from.binding);
  const mapping = new Map(record.entries.map((e) => [e.source, e.target]));
  const selected = new Set(mapping.keys());
  const ctx: RewriteContext = { alias: request.from.alias, source, target, mapping };
  const candidates = new Map<ConceptId, DocumentMutationCandidate>();
  const entries: RefreshEntry[] = [];

  for (const entry of record.entries) {
    let current: ReadResult | null;
    try {
      current = await readOptional(request.target, entry.target);
    } catch (error) {
      if (!(error instanceof FilesystemIdentityAliasError)) throw error;
      current = null;
      conflicts.push({ code: "case_collision", source: entry.source, target: entry.target, detail: `'${entry.target}' is spelled differently on disk: ${error.message}` });
    }
    const sourceRead = source.docs.get(entry.source);
    const row: RefreshEntry = {
      source: entry.source,
      target: entry.target,
      action: "unchanged",
      recorded_source_version: entry.source_version,
      target_version: current?.version ?? null,
      edited: current !== null && (current.version !== entry.target_version || entry.target_edited === true),
      dropped_links: 0,
    };
    if (entry.target_version !== undefined) row.recorded_target_version = entry.target_version;
    if (sourceRead) row.source_version = sourceRead.version;
    entries.push(row);
    const where = { source: entry.source, target: entry.target };
    const block = (code: TransferConflictCode, detail: string): void => {
      row.action = "conflict";
      row.detail = detail;
      conflicts.push({ code, ...where, detail });
    };

    if (matchesEntry(skip, entry)) {
      row.action = "skip";
      continue;
    }
    if (entry.target_version === undefined) {
      block("record_state", `the record holds no target_version for '${entry.target}', so a local edit cannot be told apart`);
      continue;
    }
    if (source.malformed.has(entry.source)) {
      block("source_malformed", `'${entry.source}' is malformed in the source: ${source.malformed.get(entry.source)}`);
      continue;
    }
    const sourceChanged = sourceRead?.version !== entry.source_version;
    if (!sourceRead) {
      block("source_missing", `'${entry.source}' is no longer in ${request.from.binding.label}; a refresh never deletes the copy`);
      continue;
    }
    if (current === null) {
      if (sourceChanged) block("target_missing", `'${entry.target}' is gone from the target; a refresh never recreates it`);
      else row.detail = "the copy is gone from the target; its source has not changed";
      continue;
    }
    const overwriting = row.edited && matchesEntry(overwrite, entry);
    if (!sourceChanged && !overwriting) {
      if (row.edited) row.detail = "the copy was edited in the target; its source has not changed";
      continue;
    }
    if (row.edited && !overwriting) {
      block("target_edited", `'${entry.target}' was edited in the target since '${request.recordId}' wrote it; overwrite or skip it explicitly`);
      continue;
    }
    const built = buildEntry(ctx, record.bundleId, request.recordId, sourceRead, entry.target, selected, true, request.actor, now, conflicts);
    candidates.set(entry.source, built.candidate);
    row.action = overwriting ? "overwrite" : "update";
    row.dropped_links = computeDroppedLinks(outboundLinks(current.doc), outboundLinks({ ...current.doc, body: built.candidate.body })).length;
  }

  const counts: Record<RefreshAction, number> = { update: 0, overwrite: 0, unchanged: 0, skip: 0, conflict: 0 };
  for (const row of entries) counts[row.action]++;
  const from: RefreshPlan["from"] = { alias: request.from.alias, bundle_id: identity.bundleId, label: request.from.label ?? request.from.binding.label };
  if (identity.pin) from.pin = identity.pin;
  const ready = conflicts.length === 0;
  const plan: RefreshPlan = {
    contract: DOCUMENT_TRANSFER_CONTRACT,
    record: { id: request.recordId, version: read.version, state: record.state },
    from,
    entries,
    counts,
    conflicts,
    ready,
  };
  if (ready && counts.update + counts.overwrite > 0) {
    plan.plan_token = `${DOCUMENT_REFRESH_TOKEN_PREFIX}:sha256:${hashOf({
      contract: DOCUMENT_REFRESH_TOKEN_PREFIX,
      record: { id: request.recordId, version: read.version },
      from: { bundle_id: identity.bundleId, pin: identity.pin?.value ?? null },
      target: { okf_version: target.okfVersion, bundle_id: target.bundleId ?? null, dependencies_version: target.dependenciesVersion },
      entries: entries.map((row) => ({
        source: row.source,
        target: row.target,
        action: row.action,
        source_version: row.source_version ?? null,
        target_version: row.target_version,
        candidate: candidates.has(row.source) ? hashOf(candidates.get(row.source)) : null,
      })),
    })}`;
  }
  return { plan, candidates, read };
}

/** Read-only: compute what a refresh of an applied Promotion record would write, and its conflicts. */
export async function planDocumentRefresh(request: RefreshRequest): Promise<RefreshPlan> {
  return (await computeRefresh(request)).plan;
}

/** The record as applied, with each refreshed row's versions moved forward and the journal removed. */
async function closeRefresh(
  target: Bundle,
  registry: KindRegistry,
  recordId: ConceptId,
  expectedVersion: Version,
  done: ReadonlyMap<ConceptId, { source_version: Version; target_version: Version }>,
  token: string | undefined,
  pin: CommitPin | undefined,
  actor: string | undefined,
  now: (() => string) | undefined,
): Promise<Version> {
  const result = await mutateDocument({
    bundle: target,
    id: recordId,
    mode: "replace-document",
    onAbsent: "fail",
    expectedVersion,
    registry,
    strict: false,
    actor,
    ...(now ? { now } : {}),
    buildCandidate: (existing) => {
      const frontmatter = structuredClone(existing!.frontmatter);
      frontmatter.promotion_state = "applied";
      delete frontmatter.refresh;
      if (token !== undefined) frontmatter.refresh_token = token;
      if (pin) frontmatter.from_pin = pin.value;
      frontmatter.entries = (frontmatter.entries as unknown[]).map((row) => {
        const entry = { ...(row as Record<string, unknown>) };
        const moved = done.get(String(entry.target));
        if (moved) {
          Object.assign(entry, moved);
          delete entry.target_edited;
        }
        return entry;
      });
      return { frontmatter, body: existing!.body };
    },
  });
  return result.version;
}

function refreshedResult(recordId: ConceptId, version: Version, written: TransferWritten[], changed: boolean): TransferResult {
  return { record: { id: recordId, version, state: "applied" }, written, changed };
}

/**
 * Recompute the refresh plan from fresh reads, refuse unless it is ready and its token equals
 * `planToken`, then write: the record (`refreshing`, with the pending rows), each copy replaced
 * under a hard compare-and-swap on the version the plan saw, and the record again (`applied`, its
 * rows moved forward). A failed write throws {@link TransferInterrupted} with state `refreshing`;
 * {@link resumeDocumentTransfer} finishes it. The same token applied again after it completed is
 * a no-op success.
 */
export async function applyDocumentRefresh(request: RefreshRequest, planToken: string): Promise<TransferResult> {
  const token = planToken.trim();
  const { plan, candidates, read } = await computeRefresh(request);
  if (!plan.ready) throw new TransferConflictError(plan.conflicts);
  if (plan.plan_token === undefined && read.doc.frontmatter.refresh_token === token) {
    return refreshedResult(request.recordId, read.version, [], false);
  }
  if (plan.plan_token !== token) throw new TransferPlanChanged(token, plan.plan_token ?? "(nothing to refresh)");

  const registry = await loadKinds(request.target);
  const pending = plan.entries.filter((row) => row.action === "update" || row.action === "overwrite");
  const journal: RefreshJournalEntry[] = pending.map((row) => ({
    source: row.source,
    source_version: row.source_version!,
    target: row.target,
    replaces_version: row.target_version!,
  }));
  let recordVersion: Version;
  try {
    recordVersion = (await mutateDocument({
      bundle: request.target,
      id: request.recordId,
      mode: "replace-document",
      onAbsent: "fail",
      expectedVersion: read.version,
      registry,
      strict: false,
      actor: request.actor,
      ...(request.now ? { now: request.now } : {}),
      buildCandidate: (existing) => {
        const frontmatter = structuredClone(existing!.frontmatter);
        frontmatter.promotion_state = "refreshing";
        frontmatter.refresh = { plan_token: token, entries: journal.map((row) => ({ ...row })) };
        return { frontmatter, body: existing!.body };
      },
    })).version;
  } catch (error) {
    if (error instanceof VersionConflict) throw new TransferPlanChanged(token, `'${request.recordId}' changed during the refresh`);
    throw error;
  }

  const written: TransferWritten[] = [];
  const done = new Map<ConceptId, { source_version: Version; target_version: Version }>();
  for (let index = 0; index < journal.length; index++) {
    const row = journal[index]!;
    try {
      const result = await replaceCopy(request.target, registry, row, candidates.get(row.source)!, request.actor, request.now);
      written.push({ source: row.source, target: row.target, version: result });
      done.set(row.target, { source_version: row.source_version, target_version: result });
    } catch (cause) {
      throw new TransferInterrupted(request.recordId, written, journal.slice(index).map((e) => ({ source: e.source, target: e.target })), cause, "refreshing");
    }
  }
  try {
    recordVersion = await closeRefresh(request.target, registry, request.recordId, recordVersion, done, token, plan.from.pin, request.actor, request.now);
  } catch (cause) {
    throw new TransferInterrupted(request.recordId, written, [], cause, "refreshing");
  }
  return refreshedResult(request.recordId, recordVersion, written, true);
}

/** Replace one copy, only if it is still exactly the version the refresh planned against. */
async function replaceCopy(
  target: Bundle,
  registry: KindRegistry,
  row: RefreshJournalEntry,
  candidate: DocumentMutationCandidate,
  actor: string | undefined,
  now: (() => string) | undefined,
): Promise<Version> {
  const result = await mutateDocument({
    bundle: target,
    id: row.target,
    mode: "replace-document",
    onAbsent: "fail",
    expectedVersion: row.replaces_version,
    registry,
    strict: false,
    actor,
    seedGenerationClock: false,
    // The source is the authority for a promoted copy's body; the plan reported the links it drops.
    bodyReplace: { replaceLinks: true },
    ...(now ? { now } : {}),
    buildCandidate: () => structuredClone(candidate),
  });
  return result.version;
}

/**
 * Finish a `refreshing` record. For each pending row: a copy whose provenance already names this
 * record at the row's source version is done; a copy still at `replaces_version` whose source is
 * still at the row's `source_version` is replaced; any other row (the copy was deleted or edited,
 * or the source moved on) is left as it is, keeps its old baseline in the record, and is reported,
 * so the record always closes without overwriting anything the plan did not show.
 */
async function finishRefresh(
  target: Bundle,
  recordId: ConceptId,
  read: ReadResult,
  record: ParsedRecord,
  from: TransferSource,
  options: { actor?: string; now?: () => string },
): Promise<TransferResult> {
  const snapshot = await readTarget(target);
  assertActor(options.actor, snapshot.okfVersion);
  const identity: TransferConflict[] = [];
  const { pin } = await sourceIdentity(from, snapshot, identity);
  if (identity.length > 0) throw new TransferResumeConflict(recordId, `${identity[0]!.code}: ${identity[0]!.detail}`);
  const source = await readSource(from.binding);
  const mapping = new Map(record.entries.map((e) => [e.source, e.target]));
  const ctx: RewriteContext = { alias: from.alias, source, target: snapshot, mapping };
  const now = options.now ?? (() => new Date().toISOString());
  const registry = snapshot.registry;
  const token = (read.doc.frontmatter.refresh as Record<string, unknown>).plan_token;

  const written: TransferWritten[] = [];
  const left: NonNullable<TransferResult["left"]> = [];
  const done = new Map<ConceptId, { source_version: Version; target_version: Version }>();
  for (const row of record.refresh!) {
    const leave = (detail: string): void => { left.push({ source: row.source, target: row.target, detail }); };
    let current: ReadResult | null;
    try {
      current = await readOptional(target, row.target);
    } catch (error) {
      if (!(error instanceof FilesystemIdentityAliasError)) throw error;
      leave(`'${row.target}' is spelled differently on disk: ${error.message}`);
      continue;
    }
    if (!current) {
      leave(`'${row.target}' was deleted during the refresh`);
      continue;
    }
    const sourceDoc = source.docs.get(row.source);
    if (!sourceDoc || sourceDoc.version !== row.source_version) {
      leave(`the source '${row.source}' is ${sourceDoc ? "changed" : "missing"} since the refresh was planned`);
      continue;
    }
    const conflicts: TransferConflict[] = [];
    const built = buildEntry(ctx, record.bundleId, recordId, sourceDoc, row.target, new Set(mapping.keys()), true, options.actor, now, conflicts);
    if (conflicts.length > 0) {
      leave(`${conflicts[0]!.code}: ${conflicts[0]!.detail}`);
      continue;
    }
    if (current.version !== row.replaces_version) {
      // Done only when the copy is exactly what this refresh writes; provenance alone would also
      // match a copy edited after the write, and adopting it would make that edit the baseline.
      if (isWrittenCopy(current.doc, built.candidate, registry, snapshot.okfVersion)) {
        written.push({ source: row.source, target: row.target, version: current.version });
        done.set(row.target, { source_version: row.source_version, target_version: current.version });
      } else {
        leave(`'${row.target}' was changed by another writer during the refresh`);
      }
      continue;
    }
    try {
      const version = await replaceCopy(target, registry, row, built.candidate, options.actor, options.now);
      written.push({ source: row.source, target: row.target, version });
      done.set(row.target, { source_version: row.source_version, target_version: version });
    } catch (error) {
      if (!(error instanceof VersionConflict)) throw error;
      leave(`'${row.target}' was changed by another writer during the resume`);
    }
  }
  const version = await closeRefresh(target, registry, recordId, read.version, done, typeof token === "string" ? token : undefined, pin, options.actor, options.now);
  return { ...refreshedResult(recordId, version, written, true), ...(left.length > 0 ? { left } : {}) };
}
