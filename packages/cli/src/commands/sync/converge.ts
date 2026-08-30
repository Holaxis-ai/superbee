// The converging-rebase mechanic's CLI half + receipt assembly: conflict labeling, the pinned
// converge strings and help chains, row projection, the push/post-commit failure framing, and
// the sync receipt + awareness-cache builders.
import { readFileSync } from "node:fs";
import { parseMarkdown } from "@superbee/core";
import {
  annotateLanded,
  classifyGitError,
  countUncommitted,
  isBoardGitError,
  provisionAnnouncement,
  runGit,
  singleActor,
  toDeltaRows,
  unpushedCount,
  type CommitResult,
  type DocChange,
  type LandedConflict,
  type ProvisionOutcome,
  type ResolvedConflict,
} from "@superbee/board-git";
import { defaultSyncStore } from "../../cursor.js";
import { upstreamHelp } from "../../sync-outcomes.js";
import { CliError, cliErrorFromBoardGit } from "../../errors.js";
import {
  CLAIM_LOST_KEY,
  ENGINE_STAMPED_FIELDS,
  claimLostStatement,
  loadClaimPolicy,
  recordedOwner,
  type ClaimPolicy,
} from "./claim-conflict.js";

/** A capped row list — the repo's standard `{shown, total, rows}` convention (see `status.ts`). */
export interface Capped {
  shown: number;
  total: number;
  rows: Record<string, unknown>[];
}

export function cap(rows: Record<string, unknown>[], limit: number): Capped {
  const bounded = limit > 0 ? rows.slice(0, limit) : rows;
  return { shown: bounded.length, total: rows.length, rows: bounded };
}

/** The push-fail safety message (test-pinned VERBATIM): reassurance first, then failure class + retry path. */
export const PUSH_FAIL_SAFETY_MESSAGE =
  "committed to the board locally — your work is saved. The push failed (offline or auth); " +
  "re-run sync when you're back online or your access is restored.";

/**
 * The push-failure warning: auth and connectivity failures get the exact generic safety string;
 * a non-fast-forward retry and other classifications keep the same safety-first framing with
 * their actionable message appended.
 */
export function pushFailureMessage(err: CliError): string {
  const genericConnectivityFailure =
    err.code === "AUTH_REQUIRED" || (err.code === "TRANSIENT" && err.details?.reason !== "non-fast-forward");
  if (genericConnectivityFailure) return PUSH_FAIL_SAFETY_MESSAGE;
  return `committed to the board locally — your work is saved. ${err.message}`;
}

/**
 * Attach {@link upstreamHelp} to a NO_UPSTREAM CliError (idempotent — never doubles up); anything
 * else passes through UNCHANGED. Non-throwing so it composes before the final throw.
 */
export function withUpstreamHelp(err: CliError, inv: string): CliError {
  if (err.code === "NO_UPSTREAM" && err.help === undefined) {
    return new CliError("NO_UPSTREAM", err.message, { details: err.details, help: upstreamHelp(inv) });
  }
  return err;
}

/**
 * Classify a raw catch-block value into a CliError — a bare git throw is always ALREADY a typed
 * `BoardGitError` (THE one `cliErrorFromBoardGit` boundary); a defensive fallback keeps it total.
 */
export function toCliError(err: unknown, op: string): CliError {
  if (err instanceof CliError) return err;
  if (isBoardGitError(err)) return cliErrorFromBoardGit(err);
  return cliErrorFromBoardGit(
    classifyGitError({ args: [op], status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) }),
  );
}

/** Write the awareness cache with honest, freshly-probed backstop counts. */
export async function writeAwarenessCache(key: string, boardPath: string, changes: DocChange[], note?: string): Promise<void> {
  await defaultSyncStore.writeCache(key, {
    updatedAt: new Date().toISOString(),
    delta: toDeltaRows(changes),
    unpushedCount: unpushedCount(boardPath) ?? 0,
    uncommittedCount: countUncommitted(boardPath),
    ...(note ? { note } : {}),
  });
}

/**
 * A full sync that COMMITS locally and THEN fails (fetch/rebase, or the converging conflict
 * terminal) must not rethrow bare: that would lose the "your work is saved" reassurance push-fail
 * gets and skip the cache write (the unpushed backstop would miss a stranded commit). Composes
 * {@link pushFailureMessage}'s SAME message selection onto ANY post-commit failure.
 * `committedThisRun` gates it: when nothing NEW was committed this run (skip-empty, or a conflict
 * against a divergence committed before this run started), the error passes through UNCHANGED and
 * NO cache write happens — the converge terminal's pinned string must not gain a prefix then.
 */
export async function throwPostCommitFailure(err: CliError, committedThisRun: boolean, key: string, boardPath: string): Promise<never> {
  if (!committedThisRun) throw err;
  const wrapped = new CliError(err.code, pushFailureMessage(err), { details: err.details, help: err.help });
  await writeAwarenessCache(key, boardPath, []);
  throw wrapped;
}

/**
 * Label a conflicted entry by its EXPLICIT doc-vs-raw discriminator ({@link ResolvedConflict}
 * .isDoc, set at resolution time) — never re-derived from the entry STRING: a dotted doc id
 * (`notes/v1.2`, legal in core) is indistinguishable from a raw path by string shape alone.
 */
export function entryLabel(c: Pick<ResolvedConflict, "entry" | "isDoc">): string {
  return c.isDoc ? `doc ${c.entry}` : c.entry;
}

/**
 * The converging mechanic's per-doc string (test-pinned), prefixed by {@link entryLabel}. Shape
 * choices: a reserved/raw path drops the fixing-verb suffix (no `doc update`/`doc write` verb
 * exists for log.md); a local-side DELETION (no stage-3 blob → nothing to export) says so
 * honestly instead of naming a file that doesn't exist; a doc DELETED UPSTREAM says "teammate's
 * deletion kept" and points at `doc write` — `doc update` on a doc whose file is gone fails
 * NOT_FOUND.
 *
 * A lost CLAIM ({@link ConflictAnalysis.claim}) is an ownership outcome, not a content
 * divergence. When it is the ONLY divergence the line reports ownership and stops: the
 * kept/exported/reconcile narration exists to merge two versions of a BODY, and there are not two
 * bodies here. When real content diverged too, the ordinary line stands and the ownership
 * statement is appended to it.
 */
export function convergeDocLine(
  c: Pick<LandedConflict, "entry" | "isDoc" | "exportPath" | "bodyExportPath" | "landed">,
  claim?: ClaimDivergence,
): string {
  if (claim?.only) return `${CLAIM_LOST_KEY}: ${c.entry} — ${claim.statement}`;
  const label = entryLabel(c);
  const line = ((): string => {
    if (c.exportPath === null) {
      return `${label} — teammate's version kept (your side deleted it; nothing to save)`;
    }
    // The fixing-verb suffix is keyed on the BODY export's existence, not on isDoc alone — a doc
    // with no .body.md (unparseable/non-utf8 local blob) must not tell the user to `doc update`
    // with the FULL export (nesting YAML into the body). Like the deletion case: no artifact, no verb.
    if (!c.landed) {
      const recreate = c.isDoc && c.bodyExportPath !== null ? " — re-create with doc write" : "";
      return `${label} — teammate's deletion kept; yours saved at ${c.exportPath}${recreate}`;
    }
    const reconcile = c.isDoc && c.bodyExportPath !== null ? " — reconcile with doc update" : "";
    return `${label} — teammate's version kept; yours saved at ${c.exportPath}${reconcile}`;
  })();
  return claim ? `${line}; ${CLAIM_LOST_KEY}: ${claim.statement}` : line;
}

/** The CONFLICT(5) envelope message: one converge line per conflicted entry, "; "-joined. */
export function buildConvergeMessage(
  conflicts: Array<Pick<LandedConflict, "entry" | "isDoc" | "exportPath" | "bodyExportPath" | "landed">>,
  analyses: readonly ConflictAnalysis[] = [],
): string {
  return conflicts.map((c, i) => convergeDocLine(c, analyses[i]?.claim)).join("; ");
}

/**
 * The reconcile HELP CHAIN: view the kept incoming version, write your merged version on top,
 * sync again. Only ever built for a conflict whose kept version LANDED (see {@link pickHelp}),
 * and ALWAYS over the BODY-ONLY export: `doc update --body-file` treats its input as a body, so
 * the full-fidelity export would nest YAML into it — the chain must be literally executable.
 */
export function convergeHelp(inv: string, id: string, bodyExportPath: string): string {
  return (
    `${inv} sync --show-incoming ${id} → ${inv} doc update ${id} --body-file ${bodyExportPath} → ${inv} sync`
  );
}

/** The re-create chain for a doc DELETED upstream: `doc write` (a fresh doc), then sync. */
export function recreateHelp(inv: string, id: string, bodyExportPath: string): string {
  return `${inv} doc write ${id} --type <Type> --body-file ${bodyExportPath} → ${inv} sync`;
}

/**
 * Pick the help chain from the ANNOTATED conflicts — prefer a doc whose kept version LANDED (the
 * reconcile chain is directly runnable for it); when every conflicted doc was deleted upstream,
 * fall back to the re-create chain. Both need the BODY-ONLY export; a doc with none (unparseable
 * local blob) is skipped. No usable doc → no help (the message lines carry the disposition).
 *
 * A doc whose ONLY divergence is a lost claim is skipped too: there is no body to merge, and
 * offering a merge chain for it would be the product asking the loser to publish over the winner.
 */
export function pickHelp(
  inv: string,
  conflicts: LandedConflict[],
  analyses: readonly ConflictAnalysis[] = [],
): string | undefined {
  const usable = (c: LandedConflict, i: number): boolean =>
    c.isDoc && c.bodyExportPath !== null && analyses[i]?.claim?.only !== true;
  const reconcilable = conflicts.find((c, i) => usable(c, i) && c.landed);
  if (reconcilable) return convergeHelp(inv, reconcilable.entry, reconcilable.bodyExportPath!);
  const recreatable = conflicts.find(usable);
  if (recreatable) return recreateHelp(inv, recreatable.entry, recreatable.bodyExportPath!);
  return undefined;
}

/** A DECLARED claim coordinate that lost its arbitration on one conflicted doc. */
export interface ClaimDivergence {
  /** The pinned ownership statement (owner + the ref it was arbitrated at). */
  statement: string;
  /** The claim is the ONLY substantive divergence — no body-merge chain applies to this doc. */
  only: boolean;
}

/**
 * What one conflicted entry's two sides say, derived from ONE read of each: the kept doc's
 * display meta, the local frontmatter keys the body-merge chain would NOT carry over, and — when
 * the doc's kind DECLARES claim coordinates that disagree — the ownership statement that replaces
 * the re-apply guidance for exactly those fields.
 */
export interface ConflictAnalysis {
  /** `{kind, title}` from the kept (HEAD) content; empty when absent or malformed. */
  meta: { kind?: string; title?: string };
  /** Non-claim local frontmatter keys that differ from the kept version's, sorted. */
  frontmatterDiffers: string[];
  claim?: ClaimDivergence;
}

const EMPTY_ANALYSIS: ConflictAnalysis = { meta: {}, frontmatterDiffers: [] };

/** `{kind, title}` from a kept frontmatter, omitting whatever it does not usefully carry. */
function keptDocMeta(frontmatter: Record<string, unknown>): { kind?: string; title?: string } {
  const kind = fmValue(frontmatter.type);
  const title = fmValue(frontmatter.title);
  return {
    ...(kind !== UNKNOWN_FIELD ? { kind } : {}),
    ...(title !== UNKNOWN_FIELD ? { title } : {}),
  };
}

/**
 * Analyze one conflicted entry against the content that LANDED on the board (HEAD after the
 * completed rebase). Two jobs, one pair of reads:
 *
 * 1. No silent local-data loss: the reconcile chain writes a merged BODY, so a LOCAL frontmatter
 *    change (a status flip, a retitle) would otherwise vanish without a trace. Surface the
 *    top-level keys whose values differ, `timestamp` excluded (the engine refreshes it on every
 *    write — it ALWAYS differs, pure noise).
 * 2. No product-guided arbitration reversal: when a key that DIFFERS is one the kind declares as
 *    a claim coordinate, the loss of that claim is reported as ownership and the key is dropped
 *    from the re-apply list — `doc update --<owner field>` is exactly the command that takes the
 *    task back from the winner, and the product must not print it.
 *
 * Ownership is only ever attributed to content this run can name a true provenance for; every
 * other case (no declared claim, no upstream ref, kept bytes that are not `origin/board`'s)
 * degrades to the pre-claim report. Absent/malformed content degrades to no fields, the
 * codebase's omit-when-empty convention.
 */
function analyzeConflict(boardPath: string, c: LandedConflict, policy: ClaimPolicy): ConflictAnalysis {
  if (!c.isDoc) return EMPTY_ANALYSIS;
  const shown = runGit(boardPath, ["show", `HEAD:${c.relPath}`]);
  if (shown.status !== 0) return EMPTY_ANALYSIS;
  let kept: ReturnType<typeof parseMarkdown>;
  try {
    kept = parseMarkdown(shown.stdout, c.relPath);
  } catch {
    return EMPTY_ANALYSIS;
  }
  const keptFm = kept.frontmatter as Record<string, unknown>;
  const meta = keptDocMeta(keptFm);
  // The kept side's display meta survives a local-side read failure: a doc whose EXPORT is
  // unreadable still has a kind and a title worth reporting.
  const keptOnly: ConflictAnalysis = { meta, frontmatterDiffers: [] };
  if (c.exportPath === null || !c.landed) return keptOnly;
  try {
    const local = parseMarkdown(readFileSync(c.exportPath, "utf8"), c.relPath);
    const localFm = local.frontmatter as Record<string, unknown>;
    const keys = new Set([...Object.keys(localFm), ...Object.keys(keptFm)]);
    keys.delete("timestamp");
    const differs = [...keys].filter((k) => JSON.stringify(localFm[k]) !== JSON.stringify(keptFm[k])).sort();

    const coordinates = policy.forType(keptFm.type);
    if (!coordinates || policy.provenance === undefined) return { meta, frontmatterDiffers: differs };
    const claimFields = differs.filter((k) => coordinates.fields.includes(k));
    if (claimFields.length === 0 || !policy.keptFromUpstream(c.relPath)) {
      return { meta, frontmatterDiffers: differs };
    }

    const substantive = differs.filter((k) => !claimFields.includes(k) && !ENGINE_STAMPED_FIELDS.has(k));
    const only = substantive.length === 0 && local.body === kept.body;
    return {
      meta,
      // The re-apply list loses the CLAIM fields only; ordinary fields keep today's guidance. When
      // the claim is the only substantive divergence, nothing is left to re-apply — every
      // remaining key is engine-stamped — so the list is omitted rather than rendered as noise.
      frontmatterDiffers: only ? [] : differs.filter((k) => !claimFields.includes(k)),
      claim: {
        statement: claimLostStatement(recordedOwner(keptFm, coordinates.ownerField), policy.provenance),
        only,
      },
    };
  } catch {
    return keptOnly;
  }
}

/**
 * Project the resolved conflicts into the envelope's row shape: `claim_lost` = who owns the
 * arbitrated version and the ref it was arbitrated at (present only for a lost declared claim),
 * `yours` = the full-fidelity export's path (recoverable byte-for-byte), `yours_body` = the
 * BODY-ONLY export the reconcile chain consumes literally, `theirs` = the teammate's version's
 * disposition ("kept", or "kept (deleted upstream)" when keeping it meant removing the file),
 * `frontmatter_differs` = the local frontmatter fields the body-merge chain would NOT carry over —
 * re-apply via `doc update` flags. A DECLARED claim field never appears in that list: a lost claim
 * is not re-applied, it is reported.
 */
export function toConflictRows(
  conflicts: LandedConflict[],
  analyses: readonly ConflictAnalysis[],
): Record<string, unknown>[] {
  return conflicts.map((c, i) => {
    const analysis = analyses[i] ?? EMPTY_ANALYSIS;
    const row: Record<string, unknown> = c.isDoc ? { id: c.entry } : { path: c.entry };
    if (c.isDoc) Object.assign(row, analysis.meta);
    if (analysis.claim) row[CLAIM_LOST_KEY] = analysis.claim.statement;
    row.yours = c.exportPath !== null ? c.exportPath : "deleted locally — nothing to save";
    // The body export exists to feed the reconcile chain. A claim-only conflict is not offered
    // that chain, so naming its input would be an invitation with no destination.
    if (c.bodyExportPath !== null && analysis.claim?.only !== true) row.yours_body = c.bodyExportPath;
    if (analysis.frontmatterDiffers.length > 0) row.frontmatter_differs = analysis.frontmatterDiffers;
    row.theirs = c.landed ? "kept" : "kept (deleted upstream)";
    return row;
  });
}

/**
 * The CONFLICT(5) terminal's envelope for a CONVERGED rebase. ONE landed probe and ONE analysis
 * per conflict feed the message lines, the rows, AND the help-chain pick. The bundle's own kind
 * conventions are read ONCE per run for the claim vocabulary — a bundle that declares none pays a
 * cheap list-of-nothing and gets byte-for-byte the pre-claim report.
 */
export async function buildConvergeError(
  boardPath: string,
  resolved: ResolvedConflict[],
  inv: string,
  limit: number,
): Promise<CliError> {
  const conflicts = annotateLanded(boardPath, resolved);
  const policy = await loadClaimPolicy(boardPath);
  const analyses = conflicts.map((c) => analyzeConflict(boardPath, c, policy));
  const rows = toConflictRows(conflicts, analyses);
  const help = pickHelp(inv, conflicts, analyses);
  return new CliError("CONFLICT", buildConvergeMessage(conflicts, analyses), {
    details: { conflicts: cap(rows, limit) },
    ...(help ? { help } : {}),
  });
}

/**
 * Merge {@link provisionAnnouncement} into a CliError's `details`: a provisioning git mutation is
 * announced on EVERY envelope this run can produce, not only the success receipt. `err` passes
 * through UNCHANGED when there is nothing to announce.
 */
export function withProvisionAnnouncement(err: CliError, outcome: ProvisionOutcome): CliError {
  const announcement = provisionAnnouncement(outcome);
  if (!announcement) return err;
  return new CliError(err.code, err.message, { details: { ...err.details, ...announcement }, help: err.help });
}

const UNKNOWN_FIELD = "unknown";
function fmValue(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : UNKNOWN_FIELD;
}

/** Project the enriched delta feed into the envelope's `incoming` row shape. */
export function toIncomingRows(changes: DocChange[]): Record<string, unknown>[] {
  return changes.map((c) => ({ verb: c.verb, kind: c.kind, id: c.docId, title: c.title, actor: c.actor }));
}

/** The `{committed, pushed, pulled, actor?, incoming}` block both receipt shapes share. */
function assignCounts(
  rec: Record<string, unknown>, commitDocs: CommitResult["docs"], pushed: number, originDelta: DocChange[], limit: number,
): void {
  rec.committed = commitDocs.length;
  rec.pushed = pushed;
  rec.pulled = originDelta.length;
  const actor = singleActor(commitDocs);
  if (actor) rec.actor = actor;
  rec.incoming = cap(toIncomingRows(originDelta), limit);
}

/**
 * The push-failure PARTIAL envelope: what committed/pulled is real and already persisted, LEADING
 * with the safety warning.
 */
export function buildPushFailurePartial(
  outcome: ProvisionOutcome, warning: string, commitDocs: CommitResult["docs"],
  originDelta: DocChange[], limit: number, reanchorNote?: string,
): Record<string, unknown> {
  const partial: Record<string, unknown> = { warning };
  const announcement = provisionAnnouncement(outcome);
  if (announcement) Object.assign(partial, announcement);
  assignCounts(partial, commitDocs, 0, originDelta, limit);
  if (reanchorNote) partial.note = reanchorNote;
  return partial;
}

export interface SyncReceiptInput {
  outcome: ProvisionOutcome; commitDocs: CommitResult["docs"]; pushedCount: number;
  originDelta: DocChange[]; limit: number;
  establishAlreadyNote?: string; reanchorNote?: string; hookHint?: string;
}

/**
 * The sync success receipt. Nothing committed/pulled-from-origin/pushed and no re-anchor is the
 * definitive empty state ("already up to date"); a FRESH provision/repair must still not read as
 * a silent no-op — the announcement rides alongside that line, never replacing it. `conflicts` is
 * OMITTED rather than rendered empty: a conflicted run always THROWS (the CONFLICT(5) envelope
 * carries the rows), so it would always be empty — against omit-when-empty and AXI §7.
 */
export function buildSyncReceipt(input: SyncReceiptInput): Record<string, unknown> {
  const { outcome, commitDocs, pushedCount, originDelta, limit, establishAlreadyNote, reanchorNote, hookHint } = input;
  const rec: Record<string, unknown> = {};
  if (establishAlreadyNote) rec.establish = establishAlreadyNote;
  const announcement = provisionAnnouncement(outcome);
  if (announcement) Object.assign(rec, announcement);
  if (commitDocs.length === 0 && originDelta.length === 0 && pushedCount === 0 && !reanchorNote) {
    rec.sync = "already up to date";
    if (hookHint) rec.hint = hookHint;
    return rec;
  }
  assignCounts(rec, commitDocs, pushedCount, originDelta, limit);
  if (reanchorNote) rec.note = reanchorNote;
  if (hookHint) rec.hint = hookHint;
  return rec;
}
