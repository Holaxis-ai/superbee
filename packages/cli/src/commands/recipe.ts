// `superbee recipe add <name-or-path>` installs definitions create-only; `recipe evolve` is the
// separate explicit, state-bound authority for updating already-installed conventions in place.
// Both operate on an EXISTING
// bundle. `<name-or-path>` is a built-in name (e.g. `context-notes`) OR a path to a recipe folder
// (npm-style disambiguation: a separator or a leading `~` means a path — see `recipe-source.ts`).
//
// Mirrors `new.ts`'s create-only / expect-absent-CAS receipt shape, but at the RECIPE level: each
// of the recipe's convention docs is written via the engine's expect-absent CAS create
// (`recipes.ts`'s `applyRecipe`), so a doc that already exists is left untouched (idempotent
// changed:false) rather than erroring or overwriting. A built-in and an external recipe both flow
// through `resolveRecipe` -> `applyRecipe` — the SAME functions, no special-casing — which is what
// makes recipe application generic rather than a one-off `init`-only special case.
import { parseArgs } from "node:util";
import { loadKinds } from "@superbee/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation, shellArg } from "../invocation.js";
import { applyRecipe } from "../recipes.js";
import { applyRecipeEvolution, planRecipeEvolution } from "../recipe-evolution.js";
import { resolveRecipe } from "../recipe-source.js";

export const RECIPE_USAGE = `superbee recipe — apply a recipe to this bundle

Usage:
  superbee recipe add <name-or-path> [--dir <path>] [--remote <url>]
  superbee recipe evolve <name-or-path> [--apply <plan-token>] [--actor <name>] [options]

Applies a recipe's definitions to the bundle. <name-or-path> is a built-in name (e.g.
'context-notes') or a path to a recipe folder (a path is anything containing '/' or starting
with '~' — a local folder literally named 'foo' is reachable only as './foo'). A recipe folder
is 'recipe.md' (type: Recipe manifest) plus one or more 'conventions/*.md' docs. A portable recipe
may opt into 'content_policy: definitions-only' and explicitly declare static 'type: Reference'
docs plus self-contained View registry/HTML pairs; instance data and undeclared files are then
rejected before any write.

Idempotent: a doc the recipe would install that already exists is left untouched (changed:false
for that doc) rather than overwritten. If its definition differs from the recipe source, the
receipt names that drift and the explicit 'recipe evolve' plan; the command never claims the
recipe is fully applied or clobbers a bundle author's own hand-edit. See 'superbee recipes' to
list built-ins and which are already applied, and 'superbee kinds' for the resulting live
per-bundle registry.

'recipe evolve' is the explicit installed-convention upgrade path. Without --apply it is READ-ONLY:
it compares definitions, permits additive declarations only, revalidates existing instances, and
returns one exact apply command. Applying requires that plan's token, recomputes the preflight, and
writes each changed convention with exact-version CAS. Concurrent non-target changes are detected
by a postcondition check and reported with completed work. It never replaces existing values,
active View assets, or artifacts omitted from the source.

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
  --apply <plan-token>  Apply the exact ready token returned by 'recipe evolve' (evolve only)
  --actor <name>        Attribute evolved convention writes (evolve only)
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

  if (sub === "add") return recipeAdd(rest, stdout);
  if (sub === "evolve") return recipeEvolve(rest, stdout);
  if (sub === "-h" || sub === "--help" || sub === undefined) {
    stdout(RECIPE_USAGE);
    return;
  }
  throw new CliError("USAGE", `unknown recipe subcommand: ${sub} (expected add or evolve)`, {
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
          actor: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.recipeEvolve,
  );
  if (values.help) {
    stdout(RECIPE_USAGE);
    return;
  }

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
    throw new CliError("USAGE", loaded.error.message, { help: `${cliInvocation()} recipes` });
  }
  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const bundle = await openBundle(values.dir, remote);
  const target = values.dir !== undefined
    ? ` --dir ${shellArg(values.dir)}`
    : remote !== undefined
      ? ` --remote ${shellArg(remote)}`
      : "";
  const planCommand = `${cliInvocation()} recipe evolve ${shellArg(ref)}${target}`;

  if (values.apply !== undefined) {
    const result = await applyRecipeEvolution(bundle, loaded.recipe, values.apply.trim(), values.actor?.trim());
    stdout(render({ ...result, help: [planCommand, `${cliInvocation()} kinds`] }, resolveMode(values)));
    return;
  }

  const plan = await planRecipeEvolution(bundle, loaded.recipe);
  const receipt: Record<string, unknown> = {
    ...plan,
    blockers: plan.blockers.slice(0, 20),
    blockers_shown: Math.min(plan.blockers.length, 20),
  };
  if (plan.ready && plan.changed) {
    receipt.commands = {
      apply: `${planCommand} --apply ${plan.plan_token}${values.actor ? ` --actor ${shellArg(values.actor.trim())}` : ""}`,
    };
  } else if (plan.blockers.some((blocker) => blocker.code === "RECIPE_EVOLUTION_DEFINITION_MISSING" || blocker.code === "RECIPE_EVOLUTION_ASSET_MISSING")) {
    receipt.commands = { install_missing: `${cliInvocation()} recipe add ${shellArg(ref)}${target}` };
  }
  receipt.help = [planCommand, `${cliInvocation()} kinds`];
  stdout(render(receipt, resolveMode(values)));
}

async function recipeAdd(argv: string[], stdout: (s: string) => void): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.recipeAdd,
  );
  if (values.help) {
    stdout(RECIPE_USAGE);
    return;
  }

  const ref = positionals[0]?.trim();
  if (!ref) {
    throw new CliError("USAGE", "recipe add requires a <name-or-path> positional", {
      help: `${cliInvocation()} recipes`,
    });
  }

  const loaded = await resolveRecipe(ref);
  if (!loaded.ok) {
    throw new CliError("USAGE", loaded.error.message, { help: `${cliInvocation()} recipes` });
  }

  const remote = await resolveRemoteFlag(values.remote, values.dir);
  const bundle = await openBundle(values.dir, remote);
  const result = await applyRecipe(bundle, loaded.recipe);

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
    docs: result.docs,
  };
  if (result.pages.length > 0) receipt.pages = result.pages;
  if (result.references.length > 0) receipt.references = result.references;
  // Honest artifact tally — `legacy_present` > 0 means an existing legacy-named install already
  // satisfies that many artifacts (Option C+: legacy installs are honored in place — renameable
  // by the migration script, never duplicated).
  receipt.counts = result.counts;
  if (warnings.length > 0) receipt.warnings = warnings;
  if (sourceDiffers > 0) {
    const target = values.dir !== undefined
      ? ` --dir ${shellArg(values.dir)}`
      : remote !== undefined
        ? ` --remote ${shellArg(remote)}`
        : "";
    receipt.commands = { plan_evolution: `${cliInvocation()} recipe evolve ${shellArg(ref)}${target}` };
  }
  receipt.help = [`${cliInvocation()} recipes`, `${cliInvocation()} kinds`];

  stdout(render(receipt, resolveMode(values)));
}
