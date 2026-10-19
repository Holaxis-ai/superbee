import { renderUsage } from "../output.js";
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
import { cliInvocation } from "../invocation.js";
import type { OkfDocument, ConceptId } from "@superbee/core";
import { readBundleOkfVersion } from "@superbee/core";
import {
  installedConnectorDocs,
  installedConventionDocs,
  installedRecipes,
  isRecipeApplied,
  recipeDrifts,
  type InstalledRecipeRow,
} from "@superbee/core/recipe-lifecycle";
import { builtinNames, resolveRecipe, type LoadedRecipe } from "../recipe-source.js";
import { commandFragment, commandLiteral, commandQuoted, commandToken, type CommandPrefix, type CommandText } from "../command-text.js";

export const RECIPES_USAGE = `superbee recipes — browse built-in recipes before or after init

Usage:
  superbee recipes [--dir <path>] [--remote <url>]

A recipe is a folder ('recipe.md' manifest + 'conventions/*.md' docs) that 'recipe add
<name-or-path>' installs onto a bundle in one shot — idempotently (re-adding an already-applied
recipe is a changed:false no-op). A definitions-only portable recipe may also declare static
Reference docs and View registry/HTML pairs without carrying instances. This command lists the
BUILT-IN recipes shipped with the CLI; an external recipe (a path) is not enumerated here, only
path-addressed via 'recipe add <path>'.
'init' applies the default recipe ('context-notes') automatically unless '--recipe none' is
passed. Without a discoverable bundle, this command still lists the offline inventory and exact
commands for safely creating a new bundle ('init --create-only') or adding each recipe to an
existing bundle. See 'superbee kinds' for the LIVE per-bundle registry a recipe's docs feed
into.
With a bundle, 'installed' reports each recipe whose stamp ('x_recipe') a convention or a
Connector under 'connectors/' carries: installed, partial, diverged or unknown, with the version it
is at, and for a recipe with connectors how many Connectors carry its stamp ('connectors') of how
many it declares ('connectors_of'). 'unstamped' lists the conventions and Connectors no recipe
wrote, or conventions written before stamps.

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help
`;

/** Repeated `unstamped` rows shown before the list is capped (AXI rule 9). */
const UNSTAMPED_CAP = 20;

/**
 * Descriptive, command-free: a declined Kind reads `partial` on purpose, and a diverged convention
 * needs a person, so no single fixing command fits every row.
 */
const STAMP_HELP =
  "partial: the recipe's conventions record different versions or fewer than it declares; a fresh 'recipe evolve <source>' plan (or 'recipe add' for an interrupted install) converges them, except a Kind declined with 'kind dismiss', which is deliberate, and a declared convention another recipe's stamp owns, which stays with that recipe; diverged: a convention changed since its recipe wrote it; an added declaration blocks the next evolve until the recipe adopts it or it is removed by hand, a removed optional one is put back, and a removed required field, section, terminal value or inbound expectation blocks until restored by hand; unknown: no stamp, or stamp rules this version does not read";

/** Appended to {@link STAMP_HELP} only when an unsettled row is a recipe with connectors. */
const CONNECTOR_STAMP_HELP =
  "a Connector a person changed reads diverged and blocks that recipe's evolve until the change is undone or the Connector is removed and added again; connectors counts the Connectors carrying the stamp, connectors_of how many the recipe declares";

/** One installed-recipe row as `recipes` renders it: the core row without its id lists. */
function installedRow(row: InstalledRecipeRow): Record<string, unknown> {
  const { convention_ids: _ids, connector_ids: _connectorIds, ...rendered } = row;
  return rendered;
}

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

function commandTargetSuffix(target: RecipeCommandTarget): CommandText {
  if (target.dir !== undefined) return commandFragment` --dir ${commandQuoted(target.dir)}`;
  if (target.remote !== undefined) return commandFragment` --remote ${commandQuoted(target.remote)}`;
  return commandLiteral("");
}

/** Project one LoadedRecipe (+ whether it's applied) into the flat row shape `recipes` renders. */
export function recipeInventoryRow(
  recipe: LoadedRecipe,
  applied: boolean | null,
  inv: CommandPrefix,
  target: RecipeCommandTarget = {},
  drift = false,
): Record<string, unknown> {
  const targetSuffix = commandTargetSuffix(target);
  const commands: Record<string, string> = {};
  // The wire protocol has no create-bundle endpoint, so a remote-scoped inventory must not emit a
  // local init command disguised as an action on the selected remote. An existing local bundle is
  // likewise add-only: create-only against that same target is guaranteed to refuse.
  if (target.remote === undefined && applied === null) {
    commands.create_bundle = `${inv} init --create-only --recipe ${commandToken(recipe.id)}${commandTargetSuffix({ dir: CONVENTIONAL_BUNDLE_DIR_NAME })}`;
  }
  commands.add_to_bundle = `${inv} recipe add ${commandToken(recipe.id)}${targetSuffix}`;

  return {
    name: recipe.id,
    version: recipe.version,
    applied,
    // Omitted-when-false: only a bundle whose installed docs differ from the recipe source
    // changes shape (the status omitted-when-empty idiom). Descriptive only — see recipeDrifts.
    ...(drift ? { drift: true } : {}),
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
    stdout(renderUsage(RECIPES_USAGE));
    return;
  }

  const bundle = await optionalBundle(values, resolvedDeps);
  const installed: Map<ConceptId, OkfDocument> | undefined = bundle ? await installedConventionDocs(bundle) : undefined;
  const appliedIds = installed === undefined ? undefined : new Set(installed.keys());
  const okfVersion = bundle ? (await readBundleOkfVersion(bundle)) ?? "0.1" : undefined;
  const now = new Date().toISOString();
  const inv = cliInvocation();

  const rows: Record<string, unknown>[] = [];
  const known: LoadedRecipe[] = [];
  let anyDrift = false;
  for (const name of builtinNames()) {
    const loaded = await resolveRecipe(name);
    // Every built-in name resolves by construction (parseRecipeFiles ran once already at module
    // load to build CONTEXT_NOTES_RECIPE) — but stay defensive rather than assume.
    if (!loaded.ok) continue;
    known.push(loaded.recipe);
    const drift =
      installed !== undefined && okfVersion !== undefined
        ? recipeDrifts(loaded.recipe, installed, okfVersion, now)
        : false;
    anyDrift ||= drift;
    rows.push(
      recipeInventoryRow(
        loaded.recipe,
        appliedIds === undefined ? null : isRecipeApplied(loaded.recipe, appliedIds),
        inv,
        { dir: values.dir, remote: values.remote },
        drift,
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

  // With a bundle: each recipe's state, read from the stamps its conventions carry.
  const stamps: Record<string, unknown> = {};
  if (installed !== undefined) {
    const connectors = await installedConnectorDocs(bundle!);
    const { rows: installedRows, unstamped } = installedRecipes([...installed.values(), ...connectors.values()], known);
    stamps.installed_count = installedRows.length;
    stamps.installed = installedRows.map(installedRow);
    stamps.unstamped_count = unstamped.length;
    if (unstamped.length > 0) {
      const shown = unstamped.slice(0, UNSTAMPED_CAP);
      stamps.unstamped = shown;
      if (shown.length < unstamped.length) {
        stamps.unstamped_shown = shown.length;
        stamps.conventions_all = `${inv} list --type Convention --prefix conventions/ --limit 0${commandTargetSuffix({ dir: values.dir, remote: values.remote })}`;
      }
      stamps.unstamped_help =
        "conventions no recipe wrote, or written before recipe stamps; a 'recipe evolve' apply stamps the ones its recipe declares" +
        (unstamped.some((id) => connectors.has(id))
          ? "; an unstamped Connector is stamped only when it equals its recipe's, and otherwise blocks that recipe's evolve"
          : "") +
        (shown.length < unstamped.length ? "; conventions_all lists every convention, and the unstamped ones carry no x_recipe" : "");
    }
    const unsettled = installedRows.filter((row) => row.state !== "installed");
    if (unsettled.length > 0) {
      stamps.stamp_help = unsettled.some((row) => row.connectors !== undefined) ? `${STAMP_HELP}; ${CONNECTOR_STAMP_HELP}` : STAMP_HELP;
    }
  }

  stdout(
    render(
      {
        count: rows.length,
        recipes: rows,
        // Descriptive, deliberately command-free (design appendix O2): the flag also covers a
        // dismissal record at the canonical id and a legitimately evolved kind, and a "fix"
        // pointer here would re-propose exactly what a decline recorded.
        ...(anyDrift
          ? { drift_help: "drift can be deliberate — read the installed convention before treating it as a defect" }
          : {}),
        ...stamps,
        help,
      },
      resolveMode(values),
    ),
  );
}
