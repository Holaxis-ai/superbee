#!/usr/bin/env node
// Rename legacy View names INSIDE bundle documents — `type: Page` -> `type: View` and the
// legacy `bridge` field -> `access` — plus the shipped-convention refresh. NO file moves and NO
// link rewriting: document ids and blob keys stay exactly where they are (legacy folder
// LOCATIONS remain recognized; relocation is a separate open decision), and fail-closed
// capability semantics are identical under either field name, so values are copied VERBATIM
// (an invalid value is copied and warned about, never "fixed").
//
// Repo script, not a CLI verb (that pattern decision is deliberately open on the board). All
// bundle access goes through the declared core engine API (build from the repo root first); every
// write is CAS-guarded through core's `versionedMutation`, so the script is safe
// to re-run: a second run reports zero changes. Every scan tolerates malformed docs (reported,
// deduped, and BLOCKING for the Page-convention deletion), so a run always ends in a receipt —
// never a mid-migration crash that leaves a bundle partially renamed with no report.
//
// Usage: node scripts/migrate-legacy-view-names.mjs --dir <bundle-root> [--dir <bundle-root> ...]
//        [--dry-run] [--actor <name>] [--overwrite-custom-conventions]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

import {
  deleteDoc,
  isUsableTimestamp,
  MalformedDocumentError,
  parseMarkdown,
  query,
  readDocVersioned,
  stringifyDoc,
  versionedMutation,
  writeDocVersioned,
} from "@superbee/core";

export const DEFAULT_ACTOR = "migrate-legacy-view-names";

/** The one receipt note about write normalization — engine writes are whole-document. */
export const NORMALIZATION_NOTE =
  "engine writes re-serialize whole documents to canonical form (key order, quoting, trailing " +
  "newline), so externally-authored docs may normalize formatting beyond the renamed keys.";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VIEW_CONVENTION_ID = "conventions/view";
const CANONICAL_VIEW_CONVENTION = path.resolve(SCRIPT_DIR, "../examples/views/conventions/view.md");
/** Frozen snapshots of every form this repo ever SHIPPED for `conventions/view` (historical artifacts — see the folder). */
const PRIOR_SHIPPED_DIR = path.resolve(SCRIPT_DIR, "prior-shipped-view-conventions");

// A complete historical install also carried teaching artifacts that present the legacy names as
// the live contract. Leaving them behind would migrate the data while the bundle keeps teaching
// dead names.
//   - The superseded `references/page-authoring-v0` is RETIRED (deleted) — same
//     governance-continuity discipline as the Page-convention deletion: only when its
//     replacement (`references/view-authoring-v0`) is present at end state (created from the
//     canonical repo file when absent) and no unreadable docs could be hiding stock.
//   - The shipped `conventions/review-request` is REFRESHED when its content matches a KNOWN
//     shipped form (same current/prior/customized classification as `conventions/view`); a
//     customized one is never touched.
const LEGACY_REFERENCE_ID = "references/page-authoring-v0";
const VIEW_REFERENCE_ID = "references/view-authoring-v0";
const CANONICAL_VIEW_REFERENCE = path.resolve(SCRIPT_DIR, "../examples/views/references/view-authoring-v0.md");
/** Frozen snapshots of every form this repo shipped for `references/view-authoring-v0`.
 * A known-shipped transitional form at the current id refreshes to the canonical reference,
 * exactly like the shipped-convention swaps. */
const PRIOR_SHIPPED_VIEW_REFERENCE_DIR = path.resolve(SCRIPT_DIR, "prior-shipped-view-authoring-references");
const REVIEW_REQUEST_CONVENTION_ID = "conventions/review-request";
const CANONICAL_REVIEW_REQUEST = path.resolve(
  SCRIPT_DIR,
  "../examples/recipes/review-workflow/conventions/review-request.md",
);
const PRIOR_SHIPPED_REVIEW_REQUEST_DIR = path.resolve(SCRIPT_DIR, "prior-shipped-review-request-conventions");

const ACCESS_VALUES = new Set(["none", "bundle-read", "bundle-propose"]);

const isViewTyped = (frontmatter) => frontmatter.type === "Page" || frontmatter.type === "View";

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The receipt's one plain-language verdict, derived ONLY from the counters the run already
 * computed — no second bookkeeping that could drift. Mode-aware grammar: a dry run states
 * hypotheticals as conditionals ("would migrate …"), a real run reports completed actions in
 * the past tense ("migrated …"). An all-quiet receipt says the scan really looked: how many
 * docs were read, and whether any could not be.
 */
export function describeReceipt(receipt) {
  const clauses = [];
  const docsChanged = receipt.changed_docs.length;
  if (docsChanged > 0) {
    const parts = [];
    if (receipt.types_flipped > 0) parts.push(count(receipt.types_flipped, "type rename"));
    if (receipt.bridge_renamed > 0) parts.push(count(receipt.bridge_renamed, "field rename"));
    if (receipt.bridge_removed > 0) parts.push(count(receipt.bridge_removed, "shadowed field drop"));
    clauses.push(`${receipt.dry_run ? "migrate" : "migrated"} ${count(docsChanged, "doc")} (${parts.join(", ")})`);
  }
  const conventionClause = {
    would_swap: "swap the View convention",
    would_swap_customized: "swap the View convention",
    swapped: "swapped the View convention",
    swapped_customized: "swapped the View convention",
    would_create: "create the View convention",
    created: "created the View convention",
  }[receipt.convention_swapped];
  if (conventionClause) clauses.push(conventionClause);
  const deleted = receipt.page_conventions_deleted.length;
  if (deleted > 0) clauses.push(`${receipt.dry_run ? "delete" : "deleted"} ${count(deleted, "Page convention")}`);
  // Teaching refresh, retirement, and creation are actions like any other — a run that only
  // refreshed must never read as a clean scan.
  const reviewRequestClause = {
    would_swap: "refresh the Review Request convention",
    swapped: "refreshed the Review Request convention",
  }[receipt.review_request_swapped];
  if (reviewRequestClause) clauses.push(reviewRequestClause);
  const referenceClause = {
    would_swap: "refresh the View authoring reference",
    swapped: "refreshed the View authoring reference",
  }[receipt.reference_refreshed];
  if (referenceClause) clauses.push(referenceClause);
  if (receipt.reference_created === true) clauses.push("created the View authoring reference");
  else if (receipt.reference_created === "would_create") clauses.push("create the View authoring reference");
  const retiredRefs = receipt.legacy_references_deleted.length;
  if (retiredRefs > 0) {
    clauses.push(`${receipt.dry_run ? "retire" : "retired"} ${count(retiredRefs, "legacy Page-authoring reference")}`);
  }

  if (clauses.length === 0) {
    // "No legacy names found" is a clean-scan claim — it may ONLY appear when the scan really
    // was clean. Any warning means legacy or unreadable state remains: skipped
    // docs, a skipped/refused View-convention swap, or a deliberately retained Page convention.
    if (receipt.warnings.length === 0) {
      return `nothing to migrate — no legacy names found in ${count(receipt.docs_scanned, "doc")} (all readable)`;
    }
    const skips = receipt.skipped_docs.length;
    const skipNote = `${count(skips, "doc")} unreadable — see skipped_docs`;
    // Retained Page conventions are counted from the receipt's own warning records (the one
    // place the run states them), never from a second tally.
    const kept = receipt.warnings.filter((w) => w.warning.startsWith("Page convention kept")).length;
    const reasons = [];
    if (kept > 0) reasons.push(`${count(kept, "Page convention")} retained (${skips > 0 ? skipNote : "see warnings"})`);
    else if (skips > 0) reasons.push(skipNote);
    if (receipt.convention_swapped === "skipped_customized") {
      reasons.push("customized View convention skipped (re-run with --overwrite-custom-conventions)");
    } else if (receipt.convention_swapped === "skipped_occupied" || receipt.convention_swapped === "refused_occupied") {
      reasons.push("conventions/view occupied by a non-View-governing doc — left untouched");
    }
    // Teaching states use the same warning-record derivation as the retained-Page count.
    if (receipt.review_request_swapped === "skipped_customized") {
      reasons.push("customized Review Request convention skipped");
    }
    if (receipt.reference_refreshed === "skipped_customized") {
      reasons.push("customized View authoring reference skipped");
    }
    const keptRefs = receipt.warnings.filter((w) => w.warning.startsWith("legacy reference kept")).length;
    if (keptRefs > 0) reasons.push(`${count(keptRefs, "legacy Page-authoring reference")} retained (see warnings)`);
    if (reasons.length === 0) reasons.push("see warnings");
    return `no changes made, but attention needed — ${count(receipt.warnings.length, "warning")}: ${reasons.join("; ")}`;
  }
  let sentence = (receipt.dry_run ? "would " : "") + clauses.join(", ");
  if (receipt.warnings.length > 0) sentence += `; ${count(receipt.warnings.length, "warning")}`;
  return sentence;
}

/**
 * Plan the in-place rename for ONE doc's frontmatter, or `null` when nothing applies. Pure —
 * re-run against every CAS attempt's fresh read. Key order is preserved (`access` takes the
 * `bridge` slot when renamed); values are copied verbatim. Docs of any OTHER type are out of
 * scope even when they carry an own `bridge` field — `bridge` is only the View kind's legacy
 * spelling, not a reserved word.
 */
export function planDocChange(frontmatter) {
  const flipType = frontmatter.type === "Page";
  const hasOwnBridge = Object.hasOwn(frontmatter, "bridge") && isViewTyped(frontmatter);
  if (!flipType && !hasOwnBridge) return null;

  const hasOwnAccess = Object.hasOwn(frontmatter, "access");
  const changes = [];
  const warnings = [];
  const entries = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === "type" && flipType) {
      entries.push(["type", "View"]);
      continue;
    }
    if (key === "bridge" && hasOwnBridge) {
      if (hasOwnAccess) continue; // `access` already decides; drop the shadowed legacy field.
      entries.push(["access", value]); // verbatim — fail-closed semantics are name-independent.
      if (!ACCESS_VALUES.has(value)) {
        warnings.push(
          `bridge value ${JSON.stringify(value)} is not a recognized capability; copied verbatim ` +
            "to `access` (it fails closed to `none` at runtime under either name)",
        );
      }
      continue;
    }
    entries.push([key, value]);
  }
  if (flipType) changes.push("type_flipped");
  if (hasOwnBridge) changes.push(hasOwnAccess ? "bridge_removed" : "bridge_renamed");
  // The engine write path guarantees a USABLE timestamp, so migrating a doc without one — the
  // field absent, empty, null, or any non-string — STAMPS it with the current time (a
  // freshness-semantics change). The receipt must say so, not hide it, and the disclosure
  // predicate is THE engine's own `isUsableTimestamp`, never a second local definition.
  if (!isUsableTimestamp(frontmatter.timestamp)) changes.push("timestamp_added");
  // Object.fromEntries defines properties (never invokes a setter), so a hostile key such as
  // `__proto__` cannot poison the accumulator.
  return { next: Object.fromEntries(entries), changes, warnings };
}

const isAbsence = (err) => err?.code === "ENOENT" || err?.code === "EISDIR";

async function readOrAbsent(bundle, id) {
  try {
    const { doc, version } = await readDocVersioned(bundle, id);
    return { state: doc, version };
  } catch (err) {
    if (isAbsence(err)) return { state: undefined, version: null };
    throw err;
  }
}

function parseConventionFile(filePath) {
  const { frontmatter, body } = parseMarkdown(readFileSync(filePath, "utf8"), path.basename(filePath));
  return { frontmatter, body };
}

/** Load THE canonical shipped View convention (single-sourced from this repo's file). */
export function loadCanonicalViewConvention() {
  return parseConventionFile(CANONICAL_VIEW_CONVENTION);
}

/** Load every prior shipped form of the View convention (frozen snapshots, one file each). */
export function loadPriorShippedViewConventions() {
  return readdirSync(PRIOR_SHIPPED_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseConventionFile(path.join(PRIOR_SHIPPED_DIR, name)));
}

/** Load THE canonical shipped View-authoring reference (single-sourced from this repo's file). */
export function loadCanonicalViewReference() {
  return parseConventionFile(CANONICAL_VIEW_REFERENCE);
}

/** Load THE canonical shipped Review Request convention (single-sourced from this repo's file). */
export function loadCanonicalReviewRequestConvention() {
  return parseConventionFile(CANONICAL_REVIEW_REQUEST);
}

/** Load every prior shipped form of the Review Request convention (frozen snapshots). */
export function loadPriorShippedReviewRequestConventions() {
  return readdirSync(PRIOR_SHIPPED_REVIEW_REQUEST_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseConventionFile(path.join(PRIOR_SHIPPED_REVIEW_REQUEST_DIR, name)));
}

/** Load every prior shipped form of the View-authoring reference (frozen snapshots). */
export function loadPriorShippedViewAuthoringReferences() {
  return readdirSync(PRIOR_SHIPPED_VIEW_REFERENCE_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseConventionFile(path.join(PRIOR_SHIPPED_VIEW_REFERENCE_DIR, name)));
}

const isViewConvention = (fm) => fm.type === "Convention" && fm.governs === "View";
const isPageConvention = (fm) => fm.type === "Convention" && fm.governs === "Page";

/**
 * Convention-content equality, ignoring `timestamp`: both sides arrive through THE one
 * frontmatter parser, the engine reorders keys on write (deep equality ignores order), and a
 * timestamp-only difference (a `doc update` touch) is not a customization.
 */
function sameConventionContent(a, b) {
  const { timestamp: _ta, ...fa } = a.frontmatter;
  const { timestamp: _tb, ...fb } = b.frontmatter;
  return isDeepStrictEqual(fa, fb) && a.body === b.body;
}

/** Classify an existing `conventions/view` doc: `current` | `prior_shipped` | `customized`. */
function classifyShippedConvention(doc, canonical, priorForms) {
  if (sameConventionContent(doc, canonical)) return "current";
  if (priorForms.some((form) => sameConventionContent(doc, form))) return "prior_shipped";
  return "customized";
}

/**
 * Plan-time state of the `conventions/view` id, read DIRECTLY — a type-filtered query cannot
 * see a non-Convention occupant (a `type: Note` doc parked on the id), which is exactly how a
 * refused create could go invisible. `view` = a View-governing Convention; `occupied` = ANY
 * other occupant (wrong type, wrong governs, or unreadable); `absent` = free.
 */
async function readViewConventionState(bundle) {
  try {
    const { doc } = await readDocVersioned(bundle, VIEW_CONVENTION_ID);
    return isViewConvention(doc.frontmatter) ? { kind: "view", doc } : { kind: "occupied", doc };
  } catch (err) {
    if (isAbsence(err)) return { kind: "absent" };
    if (err instanceof MalformedDocumentError) return { kind: "occupied" };
    throw err;
  }
}

/** Refuse anything that is not a bundle root — the same `index.md` requirement the CLI resolver enforces. */
export function assertBundleRoot(root) {
  const indexPath = path.join(root, "index.md");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error(`not a bundle root (no index.md): ${root} — refusing to migrate a non-bundle directory`);
  }
}

/** First free path of `<base>` / `<base>.1` / `<base>.2` … — an export never clobbers an earlier one. */
function unusedExportPath(base) {
  if (!existsSync(base)) return base;
  for (let n = 1; ; n++) {
    const candidate = `${base}.${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Migrate one bundle in one pass. Options: `dryRun` (plan + report, zero writes), `actor`
 * (attribution for every write), `overwriteCustomConventions` (see below), and test-only
 * `hooks.beforeDocWrite(id, attempt)` — invoked inside the CAS window so a test can inject a
 * deterministic competing write.
 *
 * Convention-swap policy: an existing `conventions/view` matching the CURRENT
 * shipped content is a no-op; matching a KNOWN PRIOR shipped form swaps silently; anything else
 * is CUSTOMIZED and is skipped with a warning by default — `overwriteCustomConventions: true`
 * first exports the old doc (canonical serialization) to a sibling file next to the bundle,
 * then swaps, and the receipt names the export path.
 */
export async function migrateBundle(bundle, options = {}) {
  const { dryRun = false, actor = DEFAULT_ACTOR, overwriteCustomConventions = false, hooks = {} } = options;
  assertBundleRoot(bundle.root);
  const receipt = {
    bundle: bundle.root,
    dry_run: dryRun,
    docs_scanned: 0,
    types_flipped: 0,
    bridge_renamed: 0,
    bridge_removed: 0,
    timestamp_added: 0,
    timestamp_added_docs: [],
    convention_swapped: false,
    page_conventions_deleted: [],
    review_request_swapped: false,
    reference_refreshed: false,
    reference_created: false,
    legacy_references_deleted: [],
    changed_docs: [],
    warnings: [],
    skipped_docs: [],
  };
  const warn = (id, warning) => receipt.warnings.push({ id, warning });
  // ONE deduped skip set shared by EVERY scan: the post-write re-queries must
  // tolerate exactly the malformed docs the first scan did — a run always ends in a receipt.
  const skippedIds = new Set();
  const onSkip = ({ id, reason }) => {
    if (skippedIds.has(id)) return;
    skippedIds.add(id);
    receipt.skipped_docs.push({ id, reason });
    warn(id, `unreadable doc skipped (${reason}) — if it is Page/bridge-typed it was NOT migrated`);
  };

  const docs = await query(bundle, {}, { onSkip });
  receipt.docs_scanned = docs.length;

  // ── 1. Per-doc renames (type flip + bridge -> access), CAS-guarded, retried per doc. ─────────
  const candidates = docs.filter((doc) => planDocChange(doc.frontmatter) !== null);
  for (const candidate of candidates) {
    const id = candidate.id;
    if (dryRun) {
      const plan = planDocChange(candidate.frontmatter);
      recordPlan(receipt, id, plan, warn);
      continue;
    }
    let attemptNo = 0;
    const outcome = await versionedMutation({
      read: () => readOrAbsent(bundle, id),
      decide: (state) => {
        if (state === undefined) return { action: "done", result: null };
        const plan = planDocChange(state.frontmatter);
        if (plan === null) return { action: "done", result: null };
        return { action: "write", next: { id, frontmatter: plan.next, body: state.body }, result: plan };
      },
      write: async (next, expectedVersion) => {
        await hooks.beforeDocWrite?.(id, attemptNo++);
        return (await writeDocVersioned(bundle, next, { expectedVersion, actor })).version;
      },
    });
    if (outcome.result !== null) recordPlan(receipt, id, outcome.result, warn);
  }

  // ── 2. Shipped-convention refresh + dead Page-convention removal. ─────────────────────────────
  const canonical = loadCanonicalViewConvention();
  const priorForms = loadPriorShippedViewConventions();
  const conventionDocs = await query(bundle, { prefix: "conventions/", type: "Convention" }, { onSkip });
  const pageConventionIds = conventionDocs.filter((doc) => isPageConvention(doc.frontmatter)).map((doc) => doc.id);
  const viewConventionState = await readViewConventionState(bundle);
  const hadViewConvention = viewConventionState.kind === "view";
  if (viewConventionState.kind === "occupied") {
    warn(VIEW_CONVENTION_ID, "exists but is not a Convention governing View — left untouched");
    receipt.convention_swapped = "skipped_occupied";
  }

  // Page-typed docs remaining AFTER the doc pass (fresh tolerant query — dry-run projects the
  // flips). Skipped (unreadable) docs BLOCK the deletion: they could hide Page stock.
  const remainingPage = dryRun ? [] : (await query(bundle, { type: "Page" }, { onSkip })).map((doc) => doc.id);
  const pageStockGone = remainingPage.length === 0 && receipt.skipped_docs.length === 0;

  // Swap an existing View convention to the current shipped content; create it only as the
  // replacement for a Page convention this run deletes (a conventions-free bundle stays
  // conventions-free — kind usage is opt-in per bundle). `viewConventionEndsGoverning` tracks
  // the ORDERING INVARIANT for the deletion below: a Page convention may be deleted only when
  // this run's END STATE has a View-governing `conventions/view` — pre-existing (shipped, prior,
  // or customized all govern View) or successfully created/swapped here. An occupant or a
  // refused create keeps the Page convention.
  const exportBase = `${bundle.root.replace(/[\\/]+$/, "")}.pre-swap.conventions-view.md`;
  const shouldCreate = viewConventionState.kind === "absent" && pageConventionIds.length > 0 && pageStockGone;
  let viewConventionEndsGoverning = hadViewConvention;
  if (hadViewConvention || shouldCreate) {
    if (dryRun) {
      if (viewConventionState.kind === "absent") {
        receipt.convention_swapped = "would_create";
        viewConventionEndsGoverning = true;
      } else {
        const shape = classifyShippedConvention(viewConventionState.doc, canonical, priorForms);
        if (shape === "prior_shipped") receipt.convention_swapped = "would_swap";
        else if (shape === "customized") {
          if (overwriteCustomConventions) {
            receipt.convention_swapped = "would_swap_customized";
            receipt.convention_export = unusedExportPath(exportBase);
          } else {
            receipt.convention_swapped = "skipped_customized";
            warn(
              VIEW_CONVENTION_ID,
              "customized (matches neither the current shipped convention nor any prior shipped form) — " +
                "left untouched; re-run with --overwrite-custom-conventions to export it and swap",
            );
          }
        }
      }
    } else {
      // Export state is per-run: decide (per attempt, from THAT attempt's fresh read) stages the
      // doc to preserve; write exports it to disk BEFORE the CAS write, so a customized doc's
      // content exists on disk before anything can destroy it (FilesystemBackend keeps no
      // history). A conflict retry re-stages and re-exports to the SAME path.
      let exportPath = null;
      let exportDoc = null;
      const outcome = await versionedMutation({
        read: () => readOrAbsent(bundle, VIEW_CONVENTION_ID),
        decide: (state) => {
          exportDoc = null;
          if (state !== undefined && !isViewConvention(state.frontmatter)) {
            // Raced into an unrelated occupant — leave it, but NEVER silently: the refusal must
            // reach the receipt, and the Page-convention deletion below must see it.
            warn(VIEW_CONVENTION_ID, "occupied by a non-View-governing doc at write time — swap/create refused");
            return { action: "done", result: "refused_occupied" };
          }
          if (state !== undefined) {
            const shape = classifyShippedConvention(state, canonical, priorForms);
            if (shape === "current") return { action: "done", result: false }; // idempotent no-op.
            if (shape === "customized" && !overwriteCustomConventions) {
              warn(
                VIEW_CONVENTION_ID,
                "customized (matches neither the current shipped convention nor any prior shipped form) — " +
                  "left untouched; re-run with --overwrite-custom-conventions to export it and swap",
              );
              return { action: "done", result: "skipped_customized" };
            }
            if (shape === "customized") exportDoc = state;
            return {
              action: "write",
              next: { id: VIEW_CONVENTION_ID, frontmatter: canonical.frontmatter, body: canonical.body },
              result: shape === "customized" ? "swapped_customized" : "swapped",
            };
          }
          return {
            action: "write",
            next: { id: VIEW_CONVENTION_ID, frontmatter: canonical.frontmatter, body: canonical.body },
            result: "created",
          };
        },
        write: async (next, expectedVersion) => {
          if (exportDoc !== null) {
            exportPath ??= unusedExportPath(exportBase);
            writeFileSync(exportPath, stringifyDoc(exportDoc.frontmatter, exportDoc.body));
          }
          return (await writeDocVersioned(bundle, next, { expectedVersion, actor })).version;
        },
      });
      receipt.convention_swapped = outcome.result;
      if (outcome.result === "swapped_customized" && exportPath !== null) {
        receipt.convention_export = exportPath;
        warn(VIEW_CONVENTION_ID, `customized convention overwritten; previous content exported to ${exportPath}`);
      }
      // Every non-refused outcome leaves a View-governing doc on the id: `false` (already
      // current), skipped_customized (customized still governs View), swapped/swapped_customized,
      // and created all qualify; only a refusal does not.
      viewConventionEndsGoverning = outcome.result !== "refused_occupied";
    }
  }

  // A convention teaching a dead kind name is exactly the two-names confusion this migration
  // ends — delete it ONLY when zero Page-typed docs remain AND the end state has a
  // View-governing `conventions/view` (the ordering invariant above): deleting the Page
  // convention while the View id is occupied or the create was refused would leave the
  // just-migrated View docs with no governing convention at all. Dry-run projects the SAME rule.
  for (const id of pageConventionIds) {
    const keepReasons = [];
    if (!pageStockGone) {
      const blockers = [...remainingPage, ...receipt.skipped_docs.map((s) => s.id)];
      keepReasons.push(`Page-typed stock may remain (${blockers.join(", ")})`);
    }
    if (!viewConventionEndsGoverning) {
      keepReasons.push(
        "conventions/view does not end this run as a View-governing Convention — deleting would leave View docs ungoverned",
      );
    }
    if (keepReasons.length > 0) {
      warn(id, `Page convention kept: ${keepReasons.join("; ")}`);
      continue;
    }
    if (dryRun) {
      receipt.page_conventions_deleted.push(id);
      continue;
    }
    const outcome = await versionedMutation({
      read: () => readOrAbsent(bundle, id),
      decide: (state) => {
        if (state === undefined) return { action: "done", result: false };
        if (!isPageConvention(state.frontmatter)) return { action: "done", result: false };
        return { action: "write", next: state, result: true };
      },
      // `versionedMutation` expects a version-returning write; the delete's CAS uses the same
      // expectedVersion and the returned token is unused by this caller.
      write: async (_next, expectedVersion) => {
        await deleteDoc(bundle, id, { expectedVersion });
        return expectedVersion;
      },
    });
    if (outcome.result === true) receipt.page_conventions_deleted.push(id);
  }

  // ── 3. Shipped-teaching refresh + superseded legacy reference retirement ───────────────────
  const readDocState = async (id) => {
    try {
      const { doc } = await readDocVersioned(bundle, id);
      return { kind: "present", doc };
    } catch (err) {
      if (isAbsence(err)) return { kind: "absent" };
      if (err instanceof MalformedDocumentError) return { kind: "unreadable" };
      throw err;
    }
  };

  // The unreadable-stock guard applies ONLY to
  // DESTRUCTIVE operations — the Page-convention deletion and the page-authoring-reference
  // retirement below — because hidden stock is material to whether a REMOVAL is safe. The two
  // classify-and-CAS REFRESHES (review-request convention, view-authoring reference) are NOT
  // guarded: their safety comes from exact known-shipped classification at the target id plus
  // CAS, which an unrelated unreadable doc cannot change. Do not re-unify.

  // 3a. `conventions/review-request`: a KNOWN shipped form still teaching the legacy names is
  // refreshed to the current canonical; customized content is never touched. Absent is fine —
  // installing it is the recipe's job, not this script's.
  const rrState = await readDocState(REVIEW_REQUEST_CONVENTION_ID);
  if (rrState.kind === "unreadable") {
    warn(REVIEW_REQUEST_CONVENTION_ID, "unreadable — shipped-teaching refresh skipped");
  } else if (rrState.kind === "present") {
    const fm = rrState.doc.frontmatter;
    if (fm.type !== "Convention" || fm.governs !== "Review Request") {
      warn(REVIEW_REQUEST_CONVENTION_ID, "exists but is not a Convention governing Review Request — left untouched");
    } else {
      const canonicalRR = loadCanonicalReviewRequestConvention();
      const priorRR = loadPriorShippedReviewRequestConventions();
      const shape = classifyShippedConvention(rrState.doc, canonicalRR, priorRR);
      if (shape === "prior_shipped") {
        if (dryRun) {
          receipt.review_request_swapped = "would_swap";
        } else {
          const outcome = await versionedMutation({
            read: () => readOrAbsent(bundle, REVIEW_REQUEST_CONVENTION_ID),
            decide: (state) => {
              if (state === undefined) return { action: "done", result: false };
              if (classifyShippedConvention(state, canonicalRR, priorRR) !== "prior_shipped") {
                return { action: "done", result: false }; // raced into current/customized content — leave it.
              }
              return {
                action: "write",
                next: { id: REVIEW_REQUEST_CONVENTION_ID, frontmatter: canonicalRR.frontmatter, body: canonicalRR.body },
                result: "swapped",
              };
            },
            write: async (next, expectedVersion) =>
              (await writeDocVersioned(bundle, next, { expectedVersion, actor })).version,
          });
          receipt.review_request_swapped = outcome.result;
        }
      } else if (shape === "customized") {
        receipt.review_request_swapped = "skipped_customized";
        warn(
          REVIEW_REQUEST_CONVENTION_ID,
          "customized (matches neither the current shipped convention nor any prior shipped form) — left untouched",
        );
      }
    }
  }

  // 3b. `references/view-authoring-v0` at its current id may carry a KNOWN shipped transitional
  // form still teaching bridge/Page
  // acceptance. A known-shipped match refreshes to the canonical; customized content is never
  // touched (unguarded refresh — see the guard-split comment above). Runs
  // BEFORE the retirement below, so the retirement's replacement check sees the refreshed doc.
  const viewRefState = await readDocState(VIEW_REFERENCE_ID);
  if (viewRefState.kind === "present" && viewRefState.doc.frontmatter.type === "Reference") {
    const canonicalRef = loadCanonicalViewReference();
    const priorRefs = loadPriorShippedViewAuthoringReferences();
    const shape = classifyShippedConvention(viewRefState.doc, canonicalRef, priorRefs);
    if (shape === "prior_shipped") {
      if (dryRun) {
        receipt.reference_refreshed = "would_swap";
      } else {
        const outcome = await versionedMutation({
          read: () => readOrAbsent(bundle, VIEW_REFERENCE_ID),
          decide: (state) => {
            if (state === undefined) return { action: "done", result: false };
            if (classifyShippedConvention(state, canonicalRef, priorRefs) !== "prior_shipped") {
              return { action: "done", result: false }; // raced into current/customized content — leave it.
            }
            return {
              action: "write",
              next: { id: VIEW_REFERENCE_ID, frontmatter: canonicalRef.frontmatter, body: canonicalRef.body },
              result: "swapped",
            };
          },
          write: async (next, expectedVersion) =>
            (await writeDocVersioned(bundle, next, { expectedVersion, actor })).version,
        });
        receipt.reference_refreshed = outcome.result;
      }
    } else if (shape === "customized") {
      receipt.reference_refreshed = "skipped_customized";
      warn(
        VIEW_REFERENCE_ID,
        "customized (matches neither the current shipped reference nor any prior shipped form) — left untouched",
      );
    }
  } else if (viewRefState.kind === "unreadable") {
    warn(VIEW_REFERENCE_ID, "unreadable — shipped-teaching refresh skipped");
  } else if (viewRefState.kind === "present") {
    warn(VIEW_REFERENCE_ID, "exists but is not a Reference — left untouched");
  }

  // 3c. Retire the superseded `references/page-authoring-v0` — it teaches the retired names as
  // the live contract. Same governance-continuity discipline as the Page-convention deletion:
  // delete only when the REPLACEMENT (`references/view-authoring-v0`, created from the canonical
  // repo file when absent) is present at end state, and only when no unreadable docs could be
  // hiding related stock. The receipt reports every outcome.
  const legacyRefState = await readDocState(LEGACY_REFERENCE_ID);
  if (legacyRefState.kind === "unreadable") {
    warn(LEGACY_REFERENCE_ID, "unreadable — legacy reference retirement skipped");
  } else if (legacyRefState.kind === "present") {
    if (legacyRefState.doc.frontmatter.type !== "Reference") {
      warn(LEGACY_REFERENCE_ID, "exists but is not a Reference — left untouched");
    } else if (receipt.skipped_docs.length > 0) {
      // DESTRUCTIVE-op guard (see the guard-split comment above): retirement is a deletion, so
      // hidden stock behind unreadable docs is material — refuse, like the Page-convention gate.
      warn(
        LEGACY_REFERENCE_ID,
        `legacy reference kept: unreadable docs were skipped (${receipt.skipped_docs.map((s) => s.id).join(", ")})`,
      );
    } else {
      const canonicalRef = loadCanonicalViewReference();
      let replacementPresent = false;
      const replacementState = await readDocState(VIEW_REFERENCE_ID);
      if (replacementState.kind === "present" && replacementState.doc.frontmatter.type === "Reference") {
        replacementPresent = true;
      } else if (replacementState.kind === "absent") {
        if (dryRun) {
          receipt.reference_created = "would_create";
          replacementPresent = true;
        } else {
          const outcome = await versionedMutation({
            read: () => readOrAbsent(bundle, VIEW_REFERENCE_ID),
            decide: (state) => {
              if (state !== undefined) {
                // Raced into an occupant — only a Reference counts as the replacement.
                return { action: "done", result: state.frontmatter.type === "Reference" };
              }
              return {
                action: "write",
                next: { id: VIEW_REFERENCE_ID, frontmatter: canonicalRef.frontmatter, body: canonicalRef.body },
                result: "created",
              };
            },
            write: async (next, expectedVersion) =>
              (await writeDocVersioned(bundle, next, { expectedVersion, actor })).version,
          });
          if (outcome.result === "created") receipt.reference_created = true;
          replacementPresent = outcome.result === "created" || outcome.result === true;
        }
      } else {
        warn(VIEW_REFERENCE_ID, "occupied by a non-Reference doc — legacy reference retirement refused");
      }
      if (replacementPresent) {
        if (dryRun) {
          receipt.legacy_references_deleted.push(LEGACY_REFERENCE_ID);
        } else {
          const outcome = await versionedMutation({
            read: () => readOrAbsent(bundle, LEGACY_REFERENCE_ID),
            decide: (state) => {
              if (state === undefined) return { action: "done", result: false };
              if (state.frontmatter.type !== "Reference") return { action: "done", result: false };
              return { action: "write", next: state, result: true };
            },
            write: async (_next, expectedVersion) => {
              await deleteDoc(bundle, LEGACY_REFERENCE_ID, { expectedVersion });
              return expectedVersion;
            },
          });
          if (outcome.result === true) receipt.legacy_references_deleted.push(LEGACY_REFERENCE_ID);
        }
      } else {
        warn(
          LEGACY_REFERENCE_ID,
          "legacy reference kept: references/view-authoring-v0 does not end this run as a Reference — deleting would leave View authoring untaught",
        );
      }
    }
  }

  // `result` leads the receipt: the human verdict first, the machine counters (unchanged keys)
  // after it. Derived at the end so it can only restate what the counters already say.
  return { result: describeReceipt(receipt), ...receipt };
}

function recordPlan(receipt, id, plan, warn) {
  receipt.changed_docs.push(id);
  if (plan.changes.includes("type_flipped")) receipt.types_flipped++;
  if (plan.changes.includes("bridge_renamed")) receipt.bridge_renamed++;
  if (plan.changes.includes("bridge_removed")) receipt.bridge_removed++;
  if (plan.changes.includes("timestamp_added")) {
    receipt.timestamp_added++;
    receipt.timestamp_added_docs.push(id);
  }
  for (const warning of plan.warnings) warn(id, warning);
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      actor: { type: "string", default: DEFAULT_ACTOR },
      "overwrite-custom-conventions": { type: "boolean", default: false },
    },
  });
  const dirs = (values.dir ?? []).map((dir) => path.resolve(dir));
  if (dirs.length === 0) {
    console.error(
      "usage: node scripts/migrate-legacy-view-names.mjs --dir <bundle-root> [--dir <bundle-root> ...] " +
        "[--dry-run] [--actor <name>] [--overwrite-custom-conventions]",
    );
    process.exit(2);
  }
  // Preflight EVERY dir before migrating ANY: a bad target refuses the whole run
  // up front instead of leaving earlier bundles migrated and later ones untouched.
  for (const dir of dirs) {
    try {
      assertBundleRoot(dir);
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
  }
  const receipts = [];
  for (const dir of dirs) {
    receipts.push(
      await migrateBundle(
        { root: dir },
        {
          dryRun: values["dry-run"],
          actor: values.actor,
          overwriteCustomConventions: values["overwrite-custom-conventions"],
        },
      ),
    );
  }
  console.log(JSON.stringify({ note: NORMALIZATION_NOTE, bundles: receipts }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
