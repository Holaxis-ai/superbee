// `superbee recipes` — list built-in recipes before or after a bundle exists, including
// whether each is already applied when a bundle is available.
//
// Mirrors `kinds.ts` (read-only, --dir/--remote, TOON, a `count`). A recipe bundles one or more
// kind-convention docs (with bodies) an agent can install onto a bundle in one shot; `recipe add
// <name-or-path>` is the apply verb (packages/cli/src/commands/recipe.ts). `init` applies the
// default recipe (`context-notes`) via the same generic machinery unless `--recipe none` is
// passed.
//
// Lists BUILT-INS ONLY (approved §B decision 9) — an external (path-addressed) recipe is not
// enumerable, since there is no registry of "every recipe folder that might exist on disk
// somewhere." A `recipes --path <dir>` inspect is reserved, not built.
//
// This distribution's SHIPPED portable recipe folders (`recipe-source-shipped.ts`) ARE enumerable
// — `shippedRecipeNames()` already reads them — but adding them to this inventory changes the
// `count`, the applied/create-bundle command rows, and the receipts several suites pin, so it is a
// separate unit. Until then, an unknown name's error is the discovery surface: it names every
// resolvable recipe, built-in and shipped alike.
import { parseArgs } from "node:util";
import type { Bundle } from "@superbee/core";
import {
  CONVENTIONAL_BUNDLE_DIR_NAME,
  findBundleRoot,
  openBundle,
  resolveProjectBinding,
  resolveRemoteFlag,
} from "../bundle.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation, shellArg } from "../invocation.js";
import { appliedDocIds, isRecipeApplied } from "../recipes.js";
import { builtinNames, resolveRecipe, type LoadedRecipe } from "../recipe-source.js";

export const RECIPES_USAGE = `superbee recipes — browse built-in recipes before or after init

Usage:
  superbee recipes [--dir <path>] [--remote <url>]

A recipe is a folder ('recipe.md' manifest + 'conventions/*.md' docs) that 'recipe add
<name-or-path>' installs onto a bundle in one shot — idempotently (re-adding an already-applied
recipe is a changed:false no-op). A definitions-only portable recipe may also declare static
Reference docs and View registry/HTML pairs without carrying instances. This command lists the
BUILT-IN recipes only. This distribution ALSO ships portable recipe folders that 'recipe add
<name>' resolves by name (see 'recipe add --help'); like an external recipe folder, they are not
enumerated here — an unknown name's error names every resolvable recipe.
'init' applies the default recipe ('context-notes') automatically unless '--recipe none' is
passed. Without a discoverable bundle, this command still lists the offline inventory and exact
commands for safely creating a new bundle ('init --create-only') or adding each recipe to an
existing bundle. See 'superbee kinds' for the LIVE per-bundle registry a recipe's docs feed
into.

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

export interface RecipesCliDeps {
  stdout: (s: string) => void;
  cwd: string;
  openBundle: typeof openBundle;
  resolveRemoteFlag: typeof resolveRemoteFlag;
  resolveProjectBinding: typeof resolveProjectBinding;
  findBundleRoot: typeof findBundleRoot;
}

interface RecipeCommandTarget {
  dir?: string;
  remote?: string;
}

function commandTargetSuffix(target: RecipeCommandTarget): string {
  if (target.dir !== undefined) return ` --dir ${shellArg(target.dir)}`;
  if (target.remote !== undefined) return ` --remote ${shellArg(target.remote)}`;
  return "";
}

/** Project one LoadedRecipe (+ whether it's applied) into the flat row shape `recipes` renders. */
export function recipeInventoryRow(
  recipe: LoadedRecipe,
  applied: boolean | null,
  inv: string,
  target: RecipeCommandTarget = {},
): Record<string, unknown> {
  const targetSuffix = commandTargetSuffix(target);
  const commands: Record<string, string> = {};
  // The wire protocol has no create-bundle endpoint, so a remote-scoped inventory must not emit a
  // local init command disguised as an action on the selected remote. An existing local bundle is
  // likewise add-only: create-only against that same target is guaranteed to refuse.
  if (target.remote === undefined && applied === null) {
    commands.create_bundle = `${inv} init --create-only --recipe ${recipe.id}${commandTargetSuffix({ dir: CONVENTIONAL_BUNDLE_DIR_NAME })}`;
  }
  commands.add_to_bundle = `${inv} recipe add ${recipe.id}${targetSuffix}`;

  return {
    name: recipe.id,
    version: recipe.version,
    applied,
    summary: recipe.summary,
    docs: recipe.docs.map((d) => d.id),
    assets: {
      kinds: recipe.governs,
      references: recipe.references.map((reference) => reference.doc.id),
      views: recipe.pages.map((page) => page.registry.id),
    },
    commands,
  };
}

/**
 * Resolve a bundle only when the caller selected one or discovery finds one. Explicit targets,
 * malformed bindings, and disappeared bundles retain openBundle's existing failures; only the
 * honest "nothing has been created here yet" state becomes an inventory-only success.
 */
async function optionalBundle(
  values: { dir?: string; remote?: string },
  deps: Pick<
    RecipesCliDeps,
    "cwd" | "openBundle" | "resolveRemoteFlag" | "resolveProjectBinding" | "findBundleRoot"
  >,
): Promise<Bundle | undefined> {
  const remote = await deps.resolveRemoteFlag(values.remote, values.dir);
  if (values.dir !== undefined || remote !== undefined) {
    return deps.openBundle(values.dir, remote);
  }

  // A binding is an explicit committed selection. If it is malformed or its target vanished,
  // openBundle must still fail loudly; it is not the bundle-free discovery state.
  const binding = await deps.resolveProjectBinding(deps.cwd);
  if (binding !== null) return deps.openBundle(undefined, undefined);

  if ((await deps.findBundleRoot(deps.cwd)) === null) return undefined;
  return deps.openBundle(undefined, undefined);
}

export async function recipes(argv: string[], deps: Partial<RecipesCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const resolvedDeps: RecipesCliDeps = {
    stdout,
    cwd: deps.cwd ?? process.cwd(),
    openBundle: deps.openBundle ?? openBundle,
    resolveRemoteFlag: deps.resolveRemoteFlag ?? resolveRemoteFlag,
    resolveProjectBinding: deps.resolveProjectBinding ?? resolveProjectBinding,
    findBundleRoot: deps.findBundleRoot ?? findBundleRoot,
  };

  const { values } = parseLeafOrUsage(
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
    CLI_LEAVES.recipes,
  );
  if (values.help) {
    stdout(RECIPES_USAGE);
    return;
  }

  const bundle = await optionalBundle(values, resolvedDeps);
  const appliedIds = bundle ? await appliedDocIds(bundle) : undefined;
  const inv = cliInvocation();

  const rows: Record<string, unknown>[] = [];
  for (const name of builtinNames()) {
    const loaded = await resolveRecipe(name);
    // Every built-in name resolves by construction (parseRecipeFiles ran once already at module
    // load to build CONTEXT_NOTES_RECIPE) — but stay defensive rather than assume.
    if (!loaded.ok) continue;
    rows.push(
      recipeInventoryRow(
        loaded.recipe,
        appliedIds === undefined ? null : isRecipeApplied(loaded.recipe, appliedIds),
        inv,
        { dir: values.dir, remote: values.remote },
      ),
    );
  }

  const addHelp = `${inv} recipe add <name-or-path>${commandTargetSuffix({
    dir: values.dir,
    remote: values.remote,
  })}`;
  const help =
    values.remote !== undefined || appliedIds !== undefined
      ? [addHelp]
      : [
          `${inv} init --create-only --recipe <name>${commandTargetSuffix({ dir: CONVENTIONAL_BUNDLE_DIR_NAME })}`,
          addHelp,
        ];

  stdout(
    render(
      {
        count: rows.length,
        recipes: rows,
        help,
      },
      resolveMode(values),
    ),
  );
}
