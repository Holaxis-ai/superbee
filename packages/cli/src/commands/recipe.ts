import { readExternalTextFile } from "../external-file.js";
import { renderUsage } from "../output.js";
import { recipeValidate } from "./recipe-validate.js";
// `superbee recipe add <name-or-path>` installs definitions create-only; `recipe evolve` is the
// separate explicit, state-bound authority for updating already-installed conventions in place.
// Both operate on an EXISTING
// bundle. `<name-or-path>` is a built-in name (e.g. `context-notes`) OR a path to a recipe folder
// (npm-style disambiguation: a separator or a leading `~` means a path — see `recipe-source.ts`).
//
// Mirrors `new.ts`'s create-only / expect-absent-CAS receipt shape, but at the RECIPE level: each
// of the recipe's convention docs is written via the engine's expect-absent CAS create
// (`installRecipe` from `@superbee/core/recipe-lifecycle`), so a doc that already exists is left
// untouched (idempotent changed:false) rather than erroring or overwriting. A built-in and an
// external recipe both flow through `resolveRecipe` -> `installRecipe` — the SAME functions, no
// special-casing — which is what makes recipe application generic rather than a one-off
// `init`-only special case.
import { parseArgs } from "node:util";
import { loadKinds } from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { assertActorAcceptedByBundle, resolveActor } from "../actor.js";
import { CliError, classifyBundleError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation, exactCliInvocation } from "../invocation.js";
import { applyRecipeEvolution, installRecipe, planRecipeEvolution, planRecipeDeclarationRetirement } from "@superbee/core/recipe-lifecycle";
import { resolveRecipe } from "../recipe-source.js";
import { assertRecipeAllowedInHostedCheckout } from "../hosted/refusals.js";
import { commandFragment, commandLiteral, commandQuoted, commandToken, type CommandText } from "../command-text.js";

export const RECIPE_USAGE = `superbee recipe — apply a recipe to this bundle

Usage:
  superbee recipe validate <path> [--readme] [--json]
  superbee recipe add <name-or-path> [--actor <name>] [--dir <path>] [--remote <url>]
  superbee recipe evolve <name-or-path> [--apply <plan-token>] [--actor <name>] [options]
  superbee recipe evolve <name-or-path> --retirement-scan [--retirement-evidence <json>] [options]

'recipe validate' reads a local recipe folder without installation or executable profile loading.
It reports declaration/mapping/profile errors, secret-shaped package text and source metadata.

Applies a recipe's definitions to the bundle. <name-or-path> is a built-in name (e.g.
'context-notes') or a path to a recipe folder (a path is anything containing '/' or starting
with '~' — a local folder literally named 'foo' is reachable only as './foo'). A recipe folder
is 'recipe.md' (type: Recipe manifest) plus one or more 'conventions/*.md' docs. A portable recipe
may opt into 'content_policy: definitions-only' and explicitly declare static 'type: Reference'
docs, self-contained View registry/HTML pairs, and 'type: Connector' declarations under
'connectors/' (the manifest's 'connectors:' list); instance data and undeclared files are then
rejected before any write. A Connector says what an integration is; adding one runs nothing. Each
Connector's sources must map onto a Kind the bundle declares (or the recipe brings), checked
before anything is written.

Idempotent: a doc the recipe would install that already exists is left untouched (changed:false
for that doc) rather than overwritten. If its definition differs from the recipe source, the
receipt names that drift and the explicit 'recipe evolve' plan; the command never claims the
recipe is fully applied or clobbers a bundle author's own hand-edit. See 'superbee recipes' to
list built-ins and which are already applied, and 'superbee kinds' for the resulting live
per-bundle registry.

Valid deprecated fields/values/links metadata can be added only with an unchanged same-recipe
ownership baseline. Existing records stay readable; admitted-registry writes preserve/remove
legacy usage but refuse new deprecated usage. Removal stays unsupported; no atomic instance-scan
closure or ecosystem-wide non-use is claimed. Recipe asset writes keep their import-like posture.

'recipe evolve' is the explicit installed-convention upgrade path. Without --apply it is READ-ONLY:
it compares definitions, permits additive declarations only, revalidates existing instances, and
returns one exact apply command. Applying requires that plan's token, recomputes the preflight, and
writes each changed convention with exact-version CAS. Concurrent non-target changes are detected
by a postcondition check and reported with completed work. It never replaces existing values,
active View assets, or artifacts omitted from the source. Retained stamped definitions omitted from
the selected source are reported as orphaned_definitions; a zero-write plan does not remove them.
It may add a field type (fields.types) or an enum (fields.values) to a declared field only when every existing instance conforms; otherwise
the plan names the violating documents. It never changes or removes a type or an enum. New outbound
link types revalidate existing edges; new expects_inbound labels add status graph lint only and do
not require existing records to have those edges. Inbound additions require an unchanged recipe
baseline so locally removed expectations are not restored silently. Neither declaration may remove
or retarget an installed label. A Connector
has no additive merge: a changed one replaces the installed document whole, and only one this
recipe wrote that nobody changed since. A Connector a person edited, an unstamped one that differs
and another recipe's Connector each block the plan and are never rewritten.

Every convention and Connector 'recipe add' creates or 'recipe evolve' writes carries an 'x_recipe'
stamp naming the recipe version, in the same write. A plan with changed:false and writes above zero still has an
apply command: it records stamps only, which is how a bundle from before stamps gets them.

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
  --retirement-scan   Read-only local declaration retirement evidence. Reports observed concepts,
                      exact versions, known supplied structural consumers and unknown external use.
                      No removal token or apply authority; guarded lifecycle apply is not implemented.
  --retirement-evidence <json>
                      Explicit recipe-set-preflight/v1 JSON. Bind it to this candidate source,
                      hypothetical definitions and the report's exact local observation digest.
                      Missing evidence means unassessed consumers, never ecosystem clearance.
  --apply <plan-token>  Apply the exact ready token returned by 'recipe evolve' (evolve only)
  --actor <name>        Attribute installed or evolved document writes. Add resolves --actor over
                        SUPERBEE_ACTOR, legacy AGENTSTATE_LITE_ACTOR, then absent; conflicting
                        environment values refuse. OKF v0.2 bundles accept
                        only an OKF actor: human:<id>, process:<id>, or <producer>/<version>
                        (e.g. openai/codex)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

export interface RecipeCliDeps {
  stdout: (s: string) => void;
}

export async function recipe(argv: string[], deps: Partial<RecipeCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "validate") return recipeValidate(rest, { stdout });
  if (sub === "add") return recipeAdd(rest, stdout);
  if (sub === "evolve") return recipeEvolve(rest, stdout);
  if (sub === "-h" || sub === "--help" || sub === undefined) {
    stdout(renderUsage(RECIPE_USAGE));
    return;
  }
  throw new CliError("USAGE", `unknown recipe subcommand: ${sub} (expected add, evolve or validate)`, {
    help: `${cliInvocation()} recipe --help`,
  });
}

async function recipeEvolve(argv: string[], stdout: (s: string) => void): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          remote: { type: "string" },
          apply: { type: "string" },
          "retirement-scan": { type: "boolean" },
          "retirement-evidence": { type: "string" },
          actor: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.recipeEvolve,
  );
  if (values.help) {
    stdout(renderUsage(RECIPE_USAGE));
    return;
  }

  if (values["retirement-scan"] && values.apply !== undefined) throw new CliError("USAGE", "--retirement-scan is read-only and cannot be combined with --apply");
  if (values["retirement-evidence"] !== undefined && !values["retirement-scan"]) throw new CliError("USAGE", "--retirement-evidence requires --retirement-scan");
  if (values["retirement-evidence"] !== undefined && !values["retirement-evidence"].trim()) throw new CliError("USAGE", "--retirement-evidence requires a nonempty JSON file path");
  const ref = positionals[0]?.trim();
  if (!ref) {
    throw new CliError("USAGE", "recipe evolve requires a <name-or-path> positional", {
      help: `${cliInvocation()} recipes`,
    });
  }
  if (values.apply !== undefined && values.apply.trim() === "") {
    throw new CliError("USAGE", "--apply requires the non-empty plan token returned by 'recipe evolve'");
  }
  if (values.actor !== undefined && values.actor.trim() === "") {
    throw new CliError("USAGE", "--actor was given an empty value — pass an actor identity or omit the flag.");
  }

  const loaded = await resolveRecipe(ref);
  if (!loaded.ok) {
    throw new CliError("USAGE", loaded.error.message, {
      help: `${cliInvocation()} recipes`,
      ...(loaded.error.connector ? { details: { connector: loaded.error.connector } } : {}),
    });
  }
  // Before anything reads the bundle: in a hosted checkout, the recipe decides which refusal applies.
  if (values.remote === undefined) await assertRecipeAllowedInHostedCheckout("recipe evolve", values.dir, loaded.recipe);
  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const bundle = await openBundle(values.dir, remote);
  const target: CommandText = values.dir !== undefined
    ? commandFragment` --dir ${commandQuoted(values.dir)}`
    : remote !== undefined
      ? commandFragment` --remote ${commandQuoted(remote)}`
      : commandLiteral("");
  const planCommand = `${cliInvocation()} recipe evolve ${commandQuoted(ref)}${target}`;
  const exactPlanCommand = `${exactCliInvocation()} recipe evolve ${commandQuoted(ref)}${target}`;

  if (values["retirement-scan"]) {
    let consumerEvidence: unknown;
    const path = values["retirement-evidence"];
    if (path !== undefined) {
      try { consumerEvidence = JSON.parse(await readExternalTextFile(path)); }
      catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("USAGE", `--retirement-evidence must name readable JSON: ${error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : String(error)}`);
      }
    }
    const inspection = await planRecipeDeclarationRetirement(bundle, loaded.recipe, path === undefined ? {} : { consumerEvidence });
    stdout(render(inspection, resolveMode(values)));
    return;
  }

  if (values.apply !== undefined) {
    // Before apply: the evolution's own error wrapping would present a write-policy refusal as
    // CONFLICT; the actor rule is a usage error with a corrected spelling, decided up front.
    await assertActorAcceptedByBundle(bundle, values.actor?.trim());
    let result: Awaited<ReturnType<typeof applyRecipeEvolution>>;
    try {
      result = await applyRecipeEvolution(bundle, loaded.recipe, values.apply.trim(), { actor: values.actor?.trim() });
    } catch (error) {
      throw classifyBundleError(error);
    }
    stdout(render({ ...result, ...(result.orphaned_definitions ? { orphaned_help: ORPHANED_HELP } : {}), help: [planCommand, `${cliInvocation()} kinds`] }, resolveMode(values)));
    return;
  }

  let plan: Awaited<ReturnType<typeof planRecipeEvolution>>;
  try {
    plan = await planRecipeEvolution(bundle, loaded.recipe);
  } catch (error) {
    throw classifyBundleError(error);
  }
  const receipt: Record<string, unknown> = {
    ...plan,
    blockers: plan.blockers.slice(0, 20),
    blockers_shown: Math.min(plan.blockers.length, 20),
  };
  // `changed` is content only; a ready plan with only stamps to record still has an apply command.
  if (plan.ready && plan.writes > 0) {
    receipt.commands = {
      apply: `${exactPlanCommand} --apply ${commandToken(plan.plan_token)}${values.actor ? ` --actor ${commandQuoted(values.actor.trim())}` : ""}`,
    };
  } else if (plan.blockers.some((blocker) => blocker.code === "RECIPE_EVOLUTION_DEFINITION_MISSING" || blocker.code === "RECIPE_EVOLUTION_ASSET_MISSING")) {
    receipt.commands = { install_missing: `${cliInvocation()} recipe add ${commandQuoted(ref)}${target}` };
  }
  if (plan.orphaned_definitions) receipt.orphaned_help = ORPHANED_HELP;
  receipt.help = [planCommand, `${cliInvocation()} kinds`];
  stdout(render(receipt, resolveMode(values)));
}

const ORPHANED_HELP = "orphaned_definitions are retained documents stamped by this recipe that the selected source no longer declares; evolve never changes or removes them, and a zero-write plan does not resolve them; inspect them before deciding whether to keep or remove them";

async function recipeAdd(argv: string[], stdout: (s: string) => void): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          remote: { type: "string" },
          actor: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.recipeAdd,
  );
  if (values.help) {
    stdout(renderUsage(RECIPE_USAGE));
    return;
  }

  const ref = positionals[0]?.trim();
  if (!ref) {
    throw new CliError("USAGE", "recipe add requires a <name-or-path> positional", {
      help: `${cliInvocation()} recipes`,
    });
  }

  const actor = resolveActor(values.actor);
  const loaded = await resolveRecipe(ref);
  if (!loaded.ok) {
    throw new CliError("USAGE", loaded.error.message, {
      help: `${cliInvocation()} recipes`,
      ...(loaded.error.connector ? { details: { connector: loaded.error.connector } } : {}),
    });
  }

  // Before anything reads the bundle: in a hosted checkout, the recipe decides which refusal applies.
  if (values.remote === undefined) await assertRecipeAllowedInHostedCheckout("recipe add", values.dir, loaded.recipe);
  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const bundle = await openBundle(values.dir, remote);
  await assertActorAcceptedByBundle(bundle, actor);
  // Core's recipe lifecycle throws typed errors; classify them here, through the one CLI mapping,
  // so this command throws a CliError like every other command.
  let result: Awaited<ReturnType<typeof installRecipe>>;
  try {
    result = await installRecipe(bundle, loaded.recipe, { actor });
  } catch (error) {
    throw classifyBundleError(error);
  }

  // Duplicate-`governs` against the TARGET bundle (approved §B decision 8(ii)) is surfaced via the
  // EXISTING `loadKinds` machinery, post-apply — no new conflict machinery. A doc that lost its
  // expect-absent CAS race because ANOTHER doc already governs the same type shows up here.
  const registry = await loadKinds(bundle);
  const dupWarnings = registry.warnings.filter((w) => w.code === "KIND_DUPLICATE_GOVERNS");
  const warnings = [...result.warnings, ...dupWarnings];

  const sourceDiffers = result.counts.source_differs ?? 0;
  const recipeStatus = sourceDiffers > 0
    ? (result.changed ? "partially applied" : "source differs")
    : (result.changed ? "added" : "already applied");
  const receipt: Record<string, unknown> = {
    // Reflect the aggregate no-op: an already-applied recipe re-add reports "already applied" rather
    // than a misleading "added" over its own `changed:false` (idempotency signalling, AXI P6).
    recipe: recipeStatus,
    id: result.id,
    version: result.version,
    source: result.source,
    changed: result.changed,
    stamp: result.stamp,
    docs: result.docs,
  };
  if (result.connectors.length > 0) receipt.connectors = result.connectors;
  if (result.pages.length > 0) receipt.pages = result.pages;
  if (result.references.length > 0) receipt.references = result.references;
  // Honest artifact tally — `legacy_present` > 0 means an existing legacy-named install already
  // satisfies that many artifacts (Option C+: legacy installs are honored in place — renameable
  // by the migration script, never duplicated).
  receipt.counts = result.counts;
  if (warnings.length > 0) receipt.warnings = warnings;
  // Install never rewrites an existing convention, so a stale or missing stamp (or a differing
  // source) is converged by the explicit evolve plan. A foreign stamp stays with its recipe, so no
  // plan changes it; the receipt names those conventions instead.
  if (result.foreign_ids.length > 0) {
    receipt.foreign_ids = result.foreign_ids;
    receipt.foreign_help =
      "another recipe's stamp owns these conventions and keeps them; this recipe reads partial in 'recipes' while it does; an evolve plan takes one over only when it also changes that convention's content, which leaves the other recipe partial" +
      (result.connectors.some((connector) => result.foreign_ids.includes(connector.id))
        ? "; a Connector another recipe's stamp owns is never taken over: this recipe's evolve plan blocks on it until it is removed by hand"
        : "");
  }
  const migrationPending = result.docs.some((doc) => doc.migration_required !== undefined);
  if (sourceDiffers > 0 || result.restamp_ids.length > 0 || migrationPending) {
    const target: CommandText = values.dir !== undefined
      ? commandFragment` --dir ${commandQuoted(values.dir)}`
      : remote !== undefined
        ? commandFragment` --remote ${commandQuoted(remote)}`
        : commandLiteral("");
    receipt.commands = { plan_evolution: `${cliInvocation()} recipe evolve ${commandQuoted(ref)}${target}` };
  }
  receipt.help = [`${cliInvocation()} recipes`, `${cliInvocation()} kinds`];

  stdout(render(receipt, resolveMode(values)));
}
