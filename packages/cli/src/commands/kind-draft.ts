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
import type { MutateDocumentOptions } from "@superbee/core";
import {
  KindAuthoringError, prepareKindDraft, prepareKindDraftMutation, prepareKindDismissal,
  appliedKindDraftWarnings, draftPromotions,
} from "@superbee/core/kind-authoring";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { commandFragment, commandQuoted, commandToken, type CommandText } from "../command-text.js";
import { mutateDoc } from "../mutate.js";
import { render, resolveMode, type OutputFlags } from "../output.js";

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

function inferredBody(type: string, count: number): string {
  return (
    `Drafted from ${count} existing '${type}' instance${count === 1 ? "" : "s"} by ` +
    "`superbee kind draft`. It ratifies the shape those instances already share; evolve it with " +
    `\`superbee kind field ${commandQuoted(type)} add <name>\`.\n`
  );
}

/** Presentation-only mapping of core facts to the established CLI contract. */
function authoringCliError(error: unknown, type: string, values: KindDraftFlags): never {
  if (!(error instanceof KindAuthoringError)) throw error;
  const inv = cliInvocation(), suffix = targetSuffix(values), id = error.details.id;
  switch (error.reason) {
    case "already-governed": throw new CliError("USAGE", `'${type}' is already governed by '${id}' — the Kind exists; evolve it instead of drafting a second one`, { help: `${inv} kind field ${commandQuoted(type)} add <name>` });
    case "no-instances": throw new CliError("USAGE", `no documents of type '${type}' exist in this bundle — there is nothing to infer a Kind from`, { help: `${inv} list` });
    case "plan-changed": throw new CliError("STALE_HEAD", `kind draft plan changed (expected ${error.details.expected}, current ${error.details.current}); inspect a fresh plan before applying`, { details: { expected_plan: error.details.expected, current_plan: error.details.current }, help: `${inv} kind draft ${commandQuoted(type)}${suffix}` });
    case "edition-changed": throw new CliError("STALE_HEAD", `the bundle format changed while applying the '${type}' draft — rerun '${inv} kind draft ${commandQuoted(type)}'`, { help: `${inv} kind draft ${commandQuoted(type)}${suffix}` });
    case "redraft-changed": throw new CliError("STALE_HEAD", `'${id}' is no longer a declaration-free convention governing '${type}' — re-run '${inv} kind draft ${commandQuoted(type)}' against the current bundle`, { help: `${inv} kinds` });
    case "dismiss-governed": throw new CliError("USAGE", `'${type}' is governed by '${id}' — dismiss records a decline for an UNGOVERNED type; a declared Kind is a decision already made`, { help: `${inv} kinds` });
  }
}
async function authoringRead<T>(read: () => Promise<T> | T, type: string, values: KindDraftFlags): Promise<T> {
  try { return await read(); } catch (error) { return authoringCliError(error, type, values); }
}
/** Preserve mutateDoc error adaptation without forking the core candidate/CAS checks. */
function authoringMutation(options: MutateDocumentOptions, type: string, values: KindDraftFlags): MutateDocumentOptions {
  return { ...options, buildCandidate: async (existing, context) => {
    try { return await options.buildCandidate!(existing, context); }
    catch (error) { return authoringCliError(error, type, values); }
  } };
}

export async function kindDraftCommand(
  type: string,
  values: KindDraftFlags,
  stdout: (s: string) => void,
): Promise<void> {
  const inv = cliInvocation();
  const suffix = targetSuffix(values);
  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const plan = await authoringRead(() => prepareKindDraft(bundle, type, { inferredBody, inferredDescription: (_type, count) => `Drafted by 'kind draft' from ${count} existing instance${count === 1 ? "" : "s"}.` }), type, values);

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

  const prepared = await authoringRead(() => prepareKindDraftMutation(bundle, plan, values.apply!, { actor: values.actor?.trim() }), type, values);
  const result = await mutateDoc({
    ...authoringMutation(prepared.options, type, values),
    helpOnKindReject: `${inv} kinds`,
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

  const measured = await appliedKindDraftWarnings(bundle, plan);
  const droppedOnRedraft = prepared.droppedLinks;
  const receipt: Record<string, unknown> = {
    draft: plan.type,
    applied: true,
    convention: plan.candidateDoc.id,
    changed: result.changed,
    version: result.version,
    warnings_after_apply: measured,
  };
  // The O4 wholesale replacement is permitted, not silent: name every outbound link the dismissal
  // record carried that the accepted schema's body does not, so the caller can re-add it.
  if (result.changed && droppedOnRedraft.length > 0) {
    receipt.dropped_links = droppedOnRedraft.map((l) => ({ to: l.to, text: l.text }));
  }
  receipt.help = [`${inv} kinds`];
  stdout(render(receipt, resolveMode(values)));
}

export async function kindDismissCommand(
  type: string,
  values: KindDraftFlags,
  stdout: (s: string) => void,
): Promise<void> {
  const inv = cliInvocation();
  const suffix = targetSuffix(values);
  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const prepared = await authoringRead(() => prepareKindDismissal(bundle, type, {
    actor: values.actor?.trim(),
    description: `Declined: '${type}' is deliberately unconstrained (recorded by 'kind dismiss').`,
    body: (_type, catalog) => {
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
      return `${bodyLines.join("\n")}\n`;
    },
  }), type, values);
  const { id, catalog } = prepared;
  if (!prepared.options) {
    stdout(render({ dismissed: type, convention: id, changed: false, help: [`${inv} kinds`] }, resolveMode(values)));
    return;
  }
  const result = await mutateDoc({
    ...authoringMutation(prepared.options, type, values),
    helpOnKindReject: `${inv} kinds`,
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
