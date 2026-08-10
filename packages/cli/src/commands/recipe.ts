// `agentstate-lite recipe add <name-or-path>` — apply a recipe's definitions to an EXISTING
// bundle. `<name-or-path>` is a built-in name (e.g. `context-notes`) OR a path to a recipe folder
// (npm-style disambiguation: a separator or a leading `~` means a path — see `recipe-source.ts`).
//
// Mirrors `new.ts`'s create-only / expect-absent-CAS receipt shape, but at the RECIPE level: each
// of the recipe's convention docs is written via the engine's expect-absent CAS create
// (`recipes.ts`'s `applyRecipe`), so a doc that already exists is left untouched (idempotent
// changed:false) rather than erroring or overwriting. A built-in and an external recipe both flow
// through `resolveRecipe` -> `applyRecipe` — the SAME functions, no special-casing — which is what
// makes recipe application generic rather than a one-off `init`-only special case (CLAUDE.md gate 3).
import { parseArgs } from "node:util";
import { loadKinds } from "@agentstate-lite/core";
import { openBundle, resolveRemoteFlag } from "../bundle.js";
import { CliError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { applyRecipe } from "../recipes.js";
import { resolveRecipe } from "../recipe-source.js";

export const RECIPE_USAGE = `agentstate-lite recipe — apply a recipe to this bundle

Usage:
  agentstate-lite recipe add <name-or-path> [--dir <path>] [--remote <url>]

Applies a recipe's definitions to the bundle. <name-or-path> is a built-in name (e.g.
'context-notes') or a path to a recipe folder (a path is anything containing '/' or starting
with '~' — a local folder literally named 'foo' is reachable only as './foo'). A recipe folder
is 'recipe.md' (type: Recipe manifest) plus one or more 'conventions/*.md' docs. A portable recipe
may opt into 'content_policy: definitions-only' and explicitly declare static 'type: Reference'
docs plus self-contained View registry/HTML pairs; instance data and undeclared files are then
rejected before any write.

Idempotent: a doc the recipe would install that already exists is left untouched (changed:false
for that doc) rather than erroring or overwriting — re-running 'recipe add' on an already-applied
recipe is a changed:false no-op overall, and never clobbers a bundle author's own hand-edit. See
'agentstate-lite recipes' to list built-ins and which are already applied, and 'agentstate-lite
kinds' for the resulting live per-bundle registry.

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd)
  --remote <url>        Talk to a wire-protocol server instead of a local bundle
                         (mutually exclusive with --dir; remote access is always explicit)
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
  if (sub === "-h" || sub === "--help" || sub === undefined) {
    stdout(RECIPE_USAGE);
    return;
  }
  throw new CliError("USAGE", `unknown recipe subcommand: ${sub} (expected add)`, {
    help: `${cliInvocation()} recipe --help`,
  });
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

  const bundle = await openBundle(values.dir, await resolveRemoteFlag(values.remote, values.dir));
  const result = await applyRecipe(bundle, loaded.recipe);

  // Duplicate-`governs` against the TARGET bundle (approved §B decision 8(ii)) is surfaced via the
  // EXISTING `loadKinds` machinery, post-apply — no new conflict machinery. A doc that lost its
  // expect-absent CAS race because ANOTHER doc already governs the same type shows up here.
  const registry = await loadKinds(bundle);
  const dupWarnings = registry.warnings.filter((w) => w.code === "KIND_DUPLICATE_GOVERNS");
  const warnings = [...result.warnings, ...dupWarnings];

  const receipt: Record<string, unknown> = {
    // Reflect the aggregate no-op: an already-applied recipe re-add reports "already applied" rather
    // than a misleading "added" over its own `changed:false` (idempotency signalling, AXI P6).
    recipe: result.changed ? "added" : "already applied",
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
  receipt.help = [`${cliInvocation()} recipes`, `${cliInvocation()} kinds`];

  stdout(render(receipt, resolveMode(values)));
}
