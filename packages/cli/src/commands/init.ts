// `superbee init [--dir <path>] [--okf-version <v>]` — create (or open) an OKF knowledge bundle.
//
// Thin wrapper over core `initBundle(root, { okfVersion })`: creates the directory and a root
// `index.md` carrying the `okf_version` frontmatter (the sole place OKF permits index.md frontmatter).
// Idempotent — re-running against an existing bundle leaves its `index.md` untouched. The target dir
// is `--dir` or the cwd (unlike the other commands, `init` does NOT require the dir to already be a
// bundle — it is what makes one).
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { initBundle, loadKinds, resolveOkfAuthoringVersion } from "@superbee/core";
import { assertPlainInitTarget, assertResolvedLocalRouteIdentity, resolveLocalBundleRoute, resolveProjectBinding, withCreateOnlyTarget } from "../bundle.js";
import { CliError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation, shellArg } from "../invocation.js";
import { applyRecipe } from "../recipes.js";
import { resolveRecipe, DEFAULT_RECIPE_REF } from "../recipe-source.js";

export const INIT_USAGE = `superbee init — create (or open) an OKF knowledge bundle

Usage:
  superbee init [--dir <path>] [--okf-version <v>] [--recipe <name-or-path>] [--create-only]

Options:
  --dir <path>            Directory to init the bundle in (default: the current directory)
  --okf-version <v>       Compatibility override for legacy integrations (normally omit; use 0.1
                           only when a legacy consumer requires it). Other versions remain readable
                           but are not authorable
  --recipe <name-or-path> Apply a recipe on create (default: context-notes; 'none' for a bare
                           bundle) — a built-in name or a path to a recipe folder; see
                           'superbee recipes' to list built-ins
  --create-only           Require a genuinely NEW workspace: refuse before publication when
                           the target is already a bundle, is non-empty or a symlink, sits inside
                           an enclosing bundle or bound project workspace, or is created
                           concurrently. Without the flag, init keeps its open-or-create behavior.
                           Recoveries: 'recipe add' modifies an existing bundle; a different
                           explicit --dir creates a new one. A runtime failure can retain empty
                           directories named in residual_created_directories; they are never
                           deleted automatically. The receipt's root is the PHYSICAL path.
  --json                  Emit compact JSON instead of TOON
  -h, --help              Show this help
`;

/** Injectable seams so the parse→init wiring — including the CAS-conflict mapping — is unit-testable. */
export interface InitCliDeps {
  stdout: (s: string) => void;
  /** Core bundle creator override (tests pin the VersionConflict → ALREADY_EXISTS mapping). */
  initBundleImpl: typeof initBundle;
}

/**
 * FS-only: true when `dir` or any ancestor contains a `.git` entry (directory OR file — a `.git`
 * FILE is how git marks a secondary checkout, so both shapes count). Deliberately never invokes
 * the git binary: `init` stays engine-only/offline, and this probe exists solely to print a hint,
 * so a cheap, dependency-free walk is the whole contract (detected by `.git` up-tree,
 * NO git binary invoked").
 */
export function insideGitRepo(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** CLI entry: parse flags, init the bundle, print its root. */
export async function init(argv: string[], deps: Partial<InitCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          "okf-version": { type: "string" },
          recipe: { type: "string" },
          "create-only": { type: "boolean" },
          // Declared (not just left to error out generically) so a misdirected `init --remote`
          // gets the SPECIFIC message below instead of parseArgs's generic unknown-option text.
          remote: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.init,
  );
  if (values.help) {
    stdout(INIT_USAGE);
    return;
  }
  if (values.remote) {
    throw new CliError(
      "USAGE",
      "the wire protocol has no create-bundle endpoint; run init on the server's directory",
      // Both halves of this two-step hint must resolve for the actual running executable (AXI
      // §7/§10); a hard-coded bare command would fail when the CLI is running through npx.
      { help: `${cliInvocation()} init --dir <path> (then ${cliInvocation()} serve --dir <path>)` },
    );
  }

  // `init` is write-first. A plain binding names its selected bundle, while only a proven private
  // board refuses bare init before a write can reach the invoking public checkout.
  let boundRoute: Awaited<ReturnType<typeof resolveLocalBundleRoute>> | undefined;
  if (values.dir === undefined && await resolveProjectBinding(process.cwd())) {
    boundRoute = await resolveLocalBundleRoute(undefined);
    if (boundRoute.kind === "bound-board") {
      throw new CliError(
        "CONFLICT",
        "a project binding already selects a private board; bare init refuses before writing",
        { help: `${cliInvocation()} sync --dir ${shellArg(boundRoute.owner.ownerRoot)}` },
      );
    }
  }

  // Recipe RESOLUTION is hoisted before any write: a recipe typo must fail at exit 2
  // with NOTHING created — under --create-only the old ordering left a bundle behind and wedged
  // the retry at exit 5. Resolution needs no bundle; APPLICATION still runs after create.
  const recipeRef = values.recipe?.trim() || DEFAULT_RECIPE_REF;
  let loadedRecipe: Awaited<ReturnType<typeof resolveRecipe>> | undefined;
  if (recipeRef !== "none") {
    loadedRecipe = await resolveRecipe(recipeRef);
    if (!loadedRecipe.ok) {
      throw new CliError("USAGE", loadedRecipe.error.message, { help: `${cliInvocation()} recipes` });
    }
  }

  const createOnly = Boolean(values["create-only"]);
  const requestedOkfVersion = values["okf-version"];
  const okfVersion = resolveOkfAuthoringVersion(
    requestedOkfVersion === undefined ? undefined : requestedOkfVersion.trim(),
  );
  // The engine (`initBundle`) no longer seeds anything (CLAUDE.md gate 3: core special-cases
  // nothing about conventions) — it just creates the bundle. `init` applies the default recipe
  // via the SAME generic machinery `recipe add` uses (decision 2: full self-hosting from day
  // one, now expressed as a product-surface commitment in the CLI, not an engine default).
  // Idempotent (expect-absent CAS per doc) — re-running `init` against an already-recipe'd bundle
  // is a no-op for each convention doc. `--recipe none` opts out to a bare bundle.
  // Create-only owns one root-scoped critical section from strict revalidation through the
  // expect-absent index publication. Recipe application remains outside the lock and after a valid
  // bundle exists. Plain init keeps its historical open-or-create path unchanged.
  let root: string;
  let bundle;
  const initDir = boundRoute?.kind === "bound-local" ? boundRoute.bundle.root : values.dir;
  if (createOnly) {
    if (boundRoute) await assertResolvedLocalRouteIdentity(boundRoute);
    const result = await withCreateOnlyTarget(initDir, (physicalTarget) =>
      (deps.initBundleImpl ?? initBundle)(physicalTarget, {
        okfVersion,
        expectNew: true,
      }),
    );
    root = result.root;
    bundle = result.value;
  } else {
    if (boundRoute) await assertResolvedLocalRouteIdentity(boundRoute);
    root = await assertPlainInitTarget(initDir);
    bundle = await (deps.initBundleImpl ?? initBundle)(root, {
      okfVersion,
    });
  }
  let recipeApplied = "none";
  let selectedRecipeKinds: string[] = [];
  let warnings: unknown[] = [];
  if (loadedRecipe?.ok) {
    if (boundRoute) await assertResolvedLocalRouteIdentity(boundRoute);
    const result = await applyRecipe(bundle, loadedRecipe.recipe);
    recipeApplied = result.id;
    selectedRecipeKinds = loadedRecipe.recipe.governs;
    // Duplicate-`governs` against the TARGET bundle (approved §B decision 8(ii)), same as
    // `recipe add` — surfaced via the EXISTING `loadKinds` machinery, no new conflict machinery.
    const registry = await loadKinds(bundle);
    const dupWarnings = registry.warnings.filter((w) => w.code === "KIND_DUPLICATE_GOVERNS");
    warnings = [...result.warnings, ...dupWarnings];
  }

  const receipt: Record<string, unknown> = { init: "ok", root: bundle.root, recipe: recipeApplied };
  if (warnings.length > 0) receipt.warnings = warnings;
  // `init` always creates a local bundle. Inside a Git repo, an advisory fs-only hint distinguishes
  // joining an existing shared board from explicitly sharing this new one.
  if (insideGitRepo(root)) {
    receipt.hint =
      "this bundle is local until shared — if the project already shares a board, " +
      `\`${cliInvocation()} sync\` joins it (never init there, that mints a divergent second ` +
      `bundle); to start sharing this one, \`${cliInvocation()} sync --establish\``;
  }
  // A selected recipe may not install Context Note (or any kind at all). Never advertise a
  // mutation the resulting bundle cannot perform; use the recipe's parsed `governs` inventory to
  // offer the known Context Note shortcut or send the caller through the generic kind catalog.
  // When `--dir` selected a bundle outside the invocation cwd, retain that resolved target in every
  // follow-up. Otherwise a copy-pasted read can inspect a different bundle and `new` can mutate it.
  const target = values.dir === undefined ? "" : ` --dir ${shellArg(root)}`;
  const help: string[] = [];
  if (selectedRecipeKinds.includes("Context Note")) {
    help.push(`${cliInvocation()} new "Context Note" <id> --title <title>${target}`);
  } else if (selectedRecipeKinds.length > 0) {
    help.push(`${cliInvocation()} kinds${target}`);
  }
  help.push(`${cliInvocation()} recipes${target}`);
  receipt.help = help;

  stdout(render(receipt, resolveMode(values)));
}
