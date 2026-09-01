// `kind draft "<Type>"` / `kind dismiss "<Type>"` — the creation and decline halves of
// agent-proposed Kinds (design: designs/agent-proposed-kinds, PR 1).
//
// `draft` is READ-ONLY without `--apply`: it infers a candidate convention from the type's
// existing instances (or adopts the builtin definition verbatim for a catalog-covered type),
// MEASURES the post-apply warning count by validating every instance, prices each candidate
// promotion, and hands back one exact apply command bound to a state-bound plan token — the
// `recipe evolve` discipline. `--apply` recomputes the whole plan and refuses on any drift.
//
// `dismiss` records a deliberate human decline as a DECLARATION-FREE convention (`governs` only:
// zero validation obligations — core accepts an absent `fields:` without warning). The governs
// registration is what durably silences every proactive channel, on every synced machine; the
// record's body names `kind draft` as the priced reopen route.
import {
  CONVENTION_TYPE,
  loadKinds,
  parseConventionDoc,
  query,
  readBundleOkfVersion,
  validateAgainstKind,
  type Bundle,
  type Frontmatter,
  type KindConvention,
  type KindRegistry,
  type OkfDocument,
} from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { commandFragment, commandQuoted, commandToken, type CommandText } from "../command-text.js";
import {
  collectInstanceStats,
  draftPlanToken,
  draftPromotions,
  inferKindCandidate,
  kindDeclaresAnything,
  conventionSlugForType,
  warningsAfterApply,
  type DraftInstanceStats,
} from "../kind-draft.js";
import { mutateDoc } from "../mutate.js";
import { render, resolveMode, type OutputFlags } from "../output.js";
import { builtinNames, resolveBuiltinSync } from "../recipe-source-builtin.js";
import { materializeRecipeForEdition } from "../recipes.js";

export interface KindDraftFlags extends OutputFlags {
  dir?: string;
  remote?: string;
  actor?: string;
  apply?: string;
  reason?: string;
}

/** The `--dir`/`--remote` echo every emitted command carries (offers/recipes rows' pattern). */
function targetSuffix(values: Pick<KindDraftFlags, "dir" | "remote">): CommandText {
  let suffix = commandFragment``;
  if (values.dir !== undefined) suffix = commandFragment`${suffix} --dir ${commandToken(values.dir)}`;
  if (values.remote !== undefined) suffix = commandFragment`${suffix} --remote ${commandToken(values.remote)}`;
  return suffix;
}

interface CatalogConvention {
  recipeId: string;
  doc: OkfDocument;
  kind: KindConvention;
  siblings: string[];
}

/** The builtin convention governing `type`, materialized for this bundle's edition, if any. */
function catalogConventionForType(type: string, okfVersion: string): CatalogConvention | undefined {
  for (const name of builtinNames()) {
    const recipe = resolveBuiltinSync(name);
    if (!recipe.governs.includes(type)) continue;
    const materialized = materializeRecipeForEdition(recipe, okfVersion);
    const doc = materialized.docs.find((d) => {
      const governs = d.frontmatter.governs;
      return typeof governs === "string" && governs.trim() === type;
    });
    if (!doc) continue;
    const parsed = parseConventionDoc(doc);
    if (!parsed.ok) continue;
    return {
      recipeId: recipe.id,
      doc,
      kind: parsed.kind,
      siblings: recipe.governs.filter((governs) => governs !== type),
    };
  }
  return undefined;
}

interface DraftPlan {
  type: string;
  okfVersion: string;
  registry: KindRegistry;
  /** The declaration-free convention this draft would upgrade in place (redraft), if any. */
  redraftOver: KindConvention | undefined;
  candidateDoc: { id: string; frontmatter: Frontmatter; body: string };
  candidateKind: KindConvention;
  catalog: CatalogConvention | undefined;
  stats: DraftInstanceStats;
  instances: OkfDocument[];
  warnings: number;
  token: string;
}

/** Candidate frontmatter WITHOUT a timestamp — the engine stamps one at write time. */
function candidateDocFor(kind: KindConvention, body: string): DraftPlan["candidateDoc"] {
  const fields: Record<string, unknown> = {};
  if (kind.fields.required.length > 0) fields.required = kind.fields.required;
  if (kind.fields.optional.length > 0) fields.optional = kind.fields.optional;
  if (Object.keys(kind.fields.values).length > 0) fields.values = kind.fields.values;
  const frontmatter: Frontmatter = {
    type: CONVENTION_TYPE,
    title: kind.title,
    governs: kind.governs,
  };
  if (kind.description !== undefined) frontmatter.description = kind.description;
  if (kind.path !== undefined) frontmatter.path = kind.path;
  if (Object.keys(fields).length > 0) frontmatter.fields = fields;
  if (kind.sections !== undefined && kind.sections.length > 0) frontmatter.sections = kind.sections;
  return { id: kind.id, frontmatter, body };
}

function inferredBody(type: string, count: number): string {
  return (
    `Drafted from ${count} existing '${type}' instance${count === 1 ? "" : "s"} by ` +
    "`superbee kind draft`. It ratifies the shape those instances already share; evolve it with " +
    `\`superbee kind field ${commandQuoted(type)} add <name>\`.\n`
  );
}

/** Build the whole read-only plan: registry + instances -> candidate + forecast + token. */
async function prepareDraftPlan(bundle: Bundle, type: string): Promise<DraftPlan> {
  const inv = cliInvocation();
  const [registry, okfVersionRead] = await Promise.all([loadKinds(bundle), readBundleOkfVersion(bundle)]);
  const okfVersion = okfVersionRead ?? "0.1";
  const existing = registry.kinds.get(type);
  if (existing && kindDeclaresAnything(existing)) {
    throw new CliError(
      "USAGE",
      `'${type}' is already governed by '${existing.id}' — the Kind exists; evolve it instead of drafting a second one`,
      { help: `${inv} kind field ${commandQuoted(type)} add <name>` },
    );
  }
  const instances = (await query(bundle, { type })).sort((a, b) => a.id.localeCompare(b.id));
  if (instances.length === 0) {
    throw new CliError(
      "USAGE",
      `no documents of type '${type}' exist in this bundle — there is nothing to infer a Kind from`,
      { help: `${inv} list` },
    );
  }
  const stats = collectInstanceStats(instances);
  const catalog = catalogConventionForType(type, okfVersion);
  let candidateKind: KindConvention;
  let candidateDoc: DraftPlan["candidateDoc"];
  if (catalog) {
    // Adopt the builtin definition VERBATIM — the recipe's schema is better than an inference,
    // and landing it at its canonical id keeps the recipes surface consistent. The forecast
    // below then reports the REAL (possibly large) warning count against existing instances —
    // the priced route `recipe add` cannot offer when instances already exist.
    candidateKind = catalog.kind;
    const { timestamp: _timestamp, ...frontmatter } = catalog.doc.frontmatter;
    candidateDoc = { id: catalog.doc.id, frontmatter, body: catalog.doc.body };
  } else {
    candidateKind = inferKindCandidate(type, instances, stats);
    candidateDoc = candidateDocFor(candidateKind, inferredBody(type, stats.count));
  }
  // A redraft upgrades the EXISTING governing record in place, wherever it lives — a
  // hand-authored governs-only convention at a non-canonical id keeps its id (never two
  // conventions for one kind; the slug id is only for true creates).
  if (existing) candidateDoc = { ...candidateDoc, id: existing.id };
  const warnings = warningsAfterApply(candidateKind, instances);
  const token = draftPlanToken({ target: candidateDoc.id, candidate: candidateDoc, okfVersion, stats });
  return {
    type,
    okfVersion,
    registry,
    redraftOver: existing,
    candidateDoc,
    candidateKind,
    catalog,
    stats,
    instances,
    warnings,
    token,
  };
}

export async function kindDraftCommand(
  type: string,
  values: KindDraftFlags,
  stdout: (s: string) => void,
): Promise<void> {
  const inv = cliInvocation();
  const suffix = targetSuffix(values);
  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const plan = await prepareDraftPlan(bundle, type);

  if (values.apply === undefined) {
    const candidate: Record<string, unknown> = {
      convention: plan.candidateDoc.id,
      governs: plan.type,
      required: plan.candidateKind.fields.required,
      optional: plan.candidateKind.fields.optional,
    };
    if (plan.candidateKind.path !== undefined) candidate.path = plan.candidateKind.path;
    if (Object.keys(plan.candidateKind.fields.values).length > 0) candidate.values = plan.candidateKind.fields.values;
    if (plan.candidateKind.sections !== undefined && plan.candidateKind.sections.length > 0) {
      candidate.sections = plan.candidateKind.sections;
    }
    const receipt: Record<string, unknown> = {
      draft: plan.type,
      instances: plan.stats.count,
      warnings_after_apply: plan.warnings,
      candidate,
    };
    if (plan.catalog) {
      receipt.catalog = plan.catalog.recipeId;
      if (plan.catalog.siblings.length > 0) {
        receipt.catalog_note =
          `recipe '${plan.catalog.recipeId}' also defines ${plan.catalog.siblings.join(", ")}; ` +
          `'${inv} recipe evolve ${commandToken(plan.catalog.recipeId)}' completes it`;
      }
    }
    if (plan.redraftOver) receipt.redrafts = plan.redraftOver.id;
    const promotions = draftPromotions(plan.candidateKind, plan.stats);
    if (promotions.length > 0) receipt.promotions = promotions;
    receipt.note = `apply creates the Kind as drafted; promotions are separate follow-ups via '${inv} kind field ${commandQuoted(plan.type)} add <name> --required'`;
    receipt.plan_token = plan.token;
    // O1 (design appendix): these exact bytes — the --dir/--remote echo and the acceptance-gate
    // comment — are load-bearing for skill-less agents and pinned by test. The gate must sit
    // beside the command an agent would copy, not only in skill prose.
    receipt.apply = `${inv} kind draft ${commandQuoted(plan.type)} --apply ${commandToken(plan.token)}${suffix}   # after the human accepts`;
    stdout(render(receipt, resolveMode(values)));
    return;
  }

  const expected = values.apply.trim();
  if (plan.token !== expected) {
    throw new CliError(
      "STALE_HEAD",
      `kind draft plan changed (expected ${expected}, current ${plan.token}); inspect a fresh plan before applying`,
      {
        details: { expected_plan: expected, current_plan: plan.token },
        help: `${inv} kind draft ${commandQuoted(plan.type)}${suffix}`,
      },
    );
  }

  const redraftTarget = plan.redraftOver;
  const result = await mutateDoc({
    // A convention adopted from a recipe source must stay byte-comparable to it, and
    // `sameInstalledDoc` strips `generated.at` but not an engine-seeded `generated.by` - so a
    // seeded clock makes an untouched install report as drifted. Recipe installation opts out for
    // the same reason. Both writers here target `conventions/<slug>` and the draft path patches
    // OVER a dismissal, so this must be uniform: otherwise a convention's provenance would depend
    // on whether it was dismissed first or drafted first. NOT bundle-wide - a generic
    // `doc write --type Convention` still seeds a clock, which is a recorded decision (provenance
    // is arguably wanted on a hand-authored convention) rather than an oversight.
    seedGenerationClock: false,
    bundle,
    id: plan.candidateDoc.id,
    // A redraft UPGRADES the dismissal record in place (patch); a fresh draft must not clobber a
    // concurrently created convention (create-only).
    mode: redraftTarget ? "patch" : "create-only",
    registry: plan.registry,
    strict: false, // this command WRITES a schema — it never validates one against another
    helpOnKindReject: `${inv} kinds`,
    actor: values.actor?.trim(),
    buildCandidate: (existingDoc, context) => {
      if (context.okfVersion !== plan.okfVersion) {
        throw new CliError(
          "STALE_HEAD",
          `the bundle format changed while applying the '${plan.type}' draft — rerun '${inv} kind draft ${commandQuoted(plan.type)}'`,
          { help: `${inv} kind draft ${commandQuoted(plan.type)}${suffix}` },
        );
      }
      if (redraftTarget) {
        // Re-verify against EVERY attempt's fresh read (the `kind field` discipline): the doc
        // must still be the declaration-free dismissal record for THIS type. A real Kind that
        // appeared concurrently must never be silently overwritten.
        const parsed = parseConventionDoc(existingDoc!);
        if (!parsed.ok || parsed.kind.governs !== plan.type || kindDeclaresAnything(parsed.kind)) {
          throw new CliError(
            "STALE_HEAD",
            `'${redraftTarget.id}' is no longer a declaration-free convention governing '${plan.type}' — ` +
              `re-run '${inv} kind draft ${commandQuoted(plan.type)}' against the current bundle`,
            { help: `${inv} kinds` },
          );
        }
      }
      // Frontmatter AND body wholesale: an accepted redraft replaces the dismissal prose — a
      // "declined" record must not survive under a now-real schema (design appendix O4).
      return { frontmatter: { ...plan.candidateDoc.frontmatter }, body: plan.candidateDoc.body };
    },
    errors: {
      // No governance claim without evidence (review F2): create-only sees only the conflict,
      // and the occupying doc may be a convention governing a DIFFERENT type (slug collision)
      // rather than a concurrently created Kind for this one.
      alreadyExists: () =>
        new CliError(
          "ALREADY_EXISTS",
          `'${plan.candidateDoc.id}' already exists — created concurrently, or the id is occupied by a ` +
            `convention governing a different type; nothing was written. Inspect '${inv} kinds', then ` +
            `re-run '${inv} kind draft ${commandQuoted(plan.type)}'`,
          { help: `${inv} kinds` },
        ),
    },
  });

  const applied = (await loadKinds(bundle)).kinds.get(plan.type);
  const measured = applied ? plan.instances.reduce((total, doc) => total + validateAgainstKind(doc, applied).length, 0) : plan.warnings;
  stdout(
    render(
      {
        draft: plan.type,
        applied: true,
        convention: plan.candidateDoc.id,
        changed: result.changed,
        version: result.version,
        warnings_after_apply: measured,
        help: [`${inv} kinds`],
      },
      resolveMode(values),
    ),
  );
}

export async function kindDismissCommand(
  type: string,
  values: KindDraftFlags,
  stdout: (s: string) => void,
): Promise<void> {
  const inv = cliInvocation();
  const suffix = targetSuffix(values);
  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const [registry, okfVersionRead] = await Promise.all([loadKinds(bundle), readBundleOkfVersion(bundle)]);
  const okfVersion = okfVersionRead ?? "0.1";
  const existing = registry.kinds.get(type);
  if (existing && kindDeclaresAnything(existing)) {
    throw new CliError(
      "USAGE",
      `'${type}' is governed by '${existing.id}' — dismiss records a decline for an UNGOVERNED type; ` +
        "a declared Kind is a decision already made",
      { help: `${inv} kinds` },
    );
  }
  if (existing) {
    // Idempotent, matching `kind field`'s no-op posture: re-dismissing an already-dismissed type
    // succeeds without a write.
    stdout(
      render(
        { dismissed: type, convention: existing.id, changed: false, help: [`${inv} kinds`] },
        resolveMode(values),
      ),
    );
    return;
  }

  const id = `conventions/${conventionSlugForType(type)}`;
  const catalog = catalogConventionForType(type, okfVersion);
  const reason = values.reason?.trim();
  const bodyLines = [
    `The human declined a Kind for '${type}'${reason ? `: ${reason}` : ""}. This declaration-free`,
    "convention records that decision so no future session re-proposes it.",
    "",
    // O3: the priced reopen route is `kind draft` — it forecasts instance conformance before any
    // write, which `recipe evolve`'s additive plan does not.
    `Reopen by running \`${inv} kind draft ${commandQuoted(type)}\` — read-only; it prices adding a real schema`,
    "against the existing instances before anything is written.",
  ];
  if (catalog) {
    bodyLines.push(
      "",
      `The builtin recipe '${catalog.recipeId}' defines a full '${type}' schema; \`kind draft\``,
      "adopts it with an instance-conformance forecast.",
    );
  }

  const result = await mutateDoc({
    // A convention adopted from a recipe source must stay byte-comparable to it, and
    // `sameInstalledDoc` strips `generated.at` but not an engine-seeded `generated.by` - so a
    // seeded clock makes an untouched install report as drifted. Recipe installation opts out for
    // the same reason. Both writers here target `conventions/<slug>` and the draft path patches
    // OVER a dismissal, so this must be uniform: otherwise a convention's provenance would depend
    // on whether it was dismissed first or drafted first. NOT bundle-wide - a generic
    // `doc write --type Convention` still seeds a clock, which is a recorded decision (provenance
    // is arguably wanted on a hand-authored convention) rather than an oversight.
    seedGenerationClock: false,
    bundle,
    id,
    mode: "create-only",
    registry,
    strict: false,
    helpOnKindReject: `${inv} kinds`,
    actor: values.actor?.trim(),
    buildCandidate: () => ({
      // Deliberately NO `fields:` key at all — core's parseConventionDoc accepts its absence
      // with zero warnings ("nothing to declare, nothing to warn about"), which is what makes
      // the record validation-inert.
      frontmatter: {
        type: CONVENTION_TYPE,
        title: type,
        governs: type,
        description: `Declined: '${type}' is deliberately unconstrained (recorded by 'kind dismiss').`,
      },
      body: `${bodyLines.join("\n")}\n`,
    }),
    errors: {
      alreadyExists: () =>
        new CliError(
          "ALREADY_EXISTS",
          `'${id}' already exists (it governs a different type) — pick the decline record's own id by hand via 'doc write', or inspect '${inv} kinds'`,
          { help: `${inv} kinds` },
        ),
    },
  });

  stdout(
    render(
      {
        dismissed: type,
        convention: id,
        changed: result.changed,
        version: result.version,
        ...(catalog ? { catalog: catalog.recipeId } : {}),
        reopen: `${inv} kind draft ${commandQuoted(type)}${suffix}`,
        help: [`${inv} kinds`],
      },
      resolveMode(values),
    ),
  );
}
