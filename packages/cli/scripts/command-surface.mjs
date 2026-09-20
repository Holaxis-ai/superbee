// Generate the command-surface inventory: every public CLI leaf, labelled with what it reaches
// OUTSIDE the bundle it is pointed at.
//
//   node scripts/command-surface.mjs           → (re)write docs/command-surface.md
//   node scripts/command-surface.mjs --check   → exit 1 if the checked-in file is stale
//   node scripts/command-surface.mjs --json    → print the inventory as JSON
//
// WHY THIS IS DERIVED AND NOT DECLARED. A hand-kept list of "which commands touch the network"
// rots the first time somebody adds an import, and rots silently. Every label here is computed
// from two sources that cannot drift from the shipped binary without a test failing:
//
//   1. `src/command-spec.ts` — the canonical leaf registry (the same graph `--help`, the handler
//      map, and the command-name ordering already project from).
//   2. The real relative-import graph under `src/`, walked from each leaf's handler module (and
//      its helpers, stopping at sibling commands) to a small table of MARKER modules whose whole
//      purpose is an outside-the-bundle reach.
//
// Every label therefore carries its evidence: the marker module that produced it. A reader who
// disagrees with a label can open that module. A reader who wants to REMOVE a label has to remove
// the import.
//
// WHAT THIS IS NOT. This file makes no stability claim and confers no compatibility promise. It
// answers one question — how large is the surface, and how much of it reaches outside the bundle
// — so that question stops being answered with adjectives.
import { build } from "esbuild";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../../scripts/is-main-module.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const srcRoot = resolve(packageRoot, "src");
const commandsRoot = resolve(srcRoot, "commands");
// packages/cli/scripts -> repo root
const repoRoot = resolve(here, "../../..");
const reportPath = resolve(packageRoot, "COMMAND-SURFACE.md");

/**
 * Modules whose entire purpose is a reach past the bundle. A leaf is labelled with a marker's
 * reach when its handler module transitively imports that marker.
 *
 * The bar for entry is deliberately high: a module belongs here only if importing it means the
 * reach HAPPENS, not that it might. `install-scope.ts`, for instance, is only a string normalizer
 * for `--scope` and is intentionally absent — it proves nothing about where a command writes.
 */
const REACH_MARKERS = Object.freeze({
  "autopull.ts": {
    reach: "network",
    why: "opportunistic board pull — a git fetch against the configured remote",
  },
  "update-check.ts": {
    reach: "network",
    why: "bounded release check against the npm registry",
  },
  "sync-cli.ts": {
    reach: "network",
    why: "board branch fetch/push against the configured git remote",
  },
  "host-config.ts": {
    reach: "vendor-config",
    why: "Claude/Codex config-root conventions",
  },
  "mcp-install-targets.ts": {
    reach: "vendor-config",
    why: "reads host MCP registrations from their own config locations",
  },
  "mcp-registration.ts": {
    reach: "vendor-config",
    why: "writes this CLI's registration into a host's config",
  },
  "user-state.ts": {
    reach: "user-state",
    why: "the private, user-scoped state directory outside any bundle",
  },
  "private-config-write.ts": {
    reach: "user-state",
    why: "writes private user-scoped configuration",
  },
  "credentials.ts": {
    reach: "user-state",
    why: "reads/writes user-scoped credentials",
  },
  "catalog.ts": {
    reach: "user-state",
    why: "the user-level workspace catalog",
  },
  "external-file.ts": {
    reach: "caller-files",
    why: "ingests bytes from a caller-named path outside the bundle",
  },
});

/** Reach classes in report order, with the one-line gloss each gets in the generated file. */
const REACH_ORDER = Object.freeze([
  ["network", "reaches the network on its own, without being asked"],
  ["network-opt-in", "reaches the network only when the caller passes --remote"],
  ["local-server", "binds a local port or hands off to a browser"],
  ["vendor-config", "reads or writes another tool's configuration"],
  ["user-state", "reads or writes this CLI's own user-level state"],
  ["caller-files", "reads or writes a file the caller named outside the bundle"],
]);

/**
 * Reaches that a marker module cannot prove, because the reach is a property of the INVOCATION
 * rather than of the code path. Each is derived from the leaf's own registry entry, so it stays
 * tied to the canonical graph rather than to a second list.
 */
const FLAG_REACHES = Object.freeze([
  {
    reach: "network-opt-in",
    why: "accepts --remote, which targets an arbitrary wire-protocol server",
    applies: (leaf, usage) => usage.includes("--remote"),
  },
  {
    reach: "local-server",
    why: "binds a local port or opens a browser window",
    applies: (leaf) => ["serve", "ui", "doc open", "mcp"].includes(leaf.path),
  },
]);

async function loadCommandSpec() {
  // `command-spec.ts` is asserted to sit at the dependency bottom with no imports at all, so this
  // bundle is a type strip rather than a real graph walk.
  const out = await build({
    entryPoints: [resolve(srcRoot, "command-spec.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  return import(`data:text/javascript,${encodeURIComponent(out.outputFiles[0].text)}`);
}

async function typeScriptSourcesUnder(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    found.push(resolve(entry.parentPath, entry.name));
  }
  return found;
}

const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
// `import type` / `export type` are erased before anything runs, so a type-only edge proves no
// reach at all. Counting them labelled almost every leaf with almost every reach.
const TYPE_ONLY_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+type\s[\s\S]*?from\s*["']([^"']+)["']/g;

/**
 * Resolve one relative specifier the way the package's own ESM build does: authored `.ts`, emitted
 * and imported as `.js`. A specifier that resolves to nothing is dropped rather than guessed at —
 * a missing edge under-reports a reach, which fails safe against a label nobody can trace.
 */
function resolveSpecifier(fromFile, specifier, known) {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

async function readImportGraph() {
  const files = await typeScriptSourcesUnder(srcRoot);
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const typeOnly = new Set([...source.matchAll(TYPE_ONLY_SPECIFIER)].map((match) => match[1]));
    const edges = new Set();
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      if (typeOnly.has(match[1])) continue;
      const target = resolveSpecifier(file, match[1], known);
      if (target !== undefined) edges.add(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

/**
 * The modules that implement one leaf: its own module, plus everything it pulls in, stopping at
 * the boundary of ANOTHER command's implementation.
 *
 * This boundary is the most important decision in this file. A plain transitive walk cannot tell
 * delegation apart from incidental linkage, and gets it wrong in a way that destroys trust:
 * `commands/pull.ts` imports `commands/doc.ts`, which imports `commands/doc/read.ts`, which pulls
 * the board — so a closure calls `pull` a network command, which it is not. `new` picked up the
 * same false label through `commands/link.ts`.
 *
 * Stopping at one hop instead is worse in the other direction: it called `sync` bundle-only,
 * because `sync` reaches the remote through `sync-cli.ts` rather than inline.
 *
 * Every observed false positive crossed into a DIFFERENT command's module, and every observed
 * false negative stayed inside the leaf's own family. So the walk follows helper modules freely
 * and refuses to cross into a sibling command: importing another command's module is not evidence
 * of calling it. A leaf's family is its own module plus the directory named after it
 * (`commands/sync.ts` owns `commands/sync/`), which is the layout the commands tree already uses.
 */
function implementationClosure(graph, entry) {
  const family = `${entry.replace(/\.ts$/, "")}${sep}`;
  const traversable = (module) =>
    !module.startsWith(`${commandsRoot}${sep}`) || module === entry || module.startsWith(family);

  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    for (const next of graph.get(queue.pop()) ?? []) {
      if (seen.has(next) || !traversable(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * The module that actually implements one leaf.
 *
 * Leaf paths map onto the commands tree by convention (`doc read` -> `commands/doc/read.ts`), and
 * the walk shortens the path until a module exists, so a leaf whose family shares one module
 * (`hook install` -> `commands/hook.ts`) resolves to the module that really runs it. The
 * granularity of the answer is therefore the granularity the code provides, never finer: sibling
 * leaves behind one module necessarily share its reach, and the report says so.
 */
function resolveLeafModule(leaf, known) {
  const words = leaf.canonicalPath.split(" ");
  for (let length = words.length; length > 0; length -= 1) {
    const candidate = resolve(commandsRoot, `${words.slice(0, length).join(sep)}.ts`);
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

function markerAt(modulePath) {
  return REACH_MARKERS[relative(srcRoot, modulePath).split(sep).join("/")];
}

/**
 * Build the inventory: one row per leaf, each reach carrying the module that proves it.
 *
 * A near-universal reach is kept rather than suppressed. Bundle resolution reads user-level state,
 * so almost every leaf carries `user-state` — which looks like noise until you notice it is the
 * finding: the CLI cannot resolve a bundle without reaching outside it. The report handles this by
 * printing whichever side of a reach is SHORTER, so a reach covering all but two leaves is
 * reported as those two exceptions rather than as a 56-line list.
 */
export function buildInventory({ groups, graph }) {
  const known = new Set(graph.keys());
  const entries = [];
  for (const group of groups) {
    for (const row of group.commands) {
      for (const leaf of row.leaves) {
        // An alias is the same executable surface under a second spelling, so it is reported with
        // the reach of what it aliases rather than resolved a second time.
        const canonicalPath = leaf.canonical.path;
        const module = resolveLeafModule({ canonicalPath }, known);
        entries.push({
          group: group.group,
          usage: row.usage,
          leaf,
          canonicalPath,
          module,
          closure: module === undefined ? new Set() : implementationClosure(graph, module),
        });
      }
    }
  }

  const rows = entries.map((entry) => {
    const reaches = new Map();
    const note = (reach, why, evidence) => {
      if (!reaches.has(reach)) reaches.set(reach, []);
      reaches.get(reach).push({ why, evidence });
    };
    for (const reached of entry.closure) {
      const marker = markerAt(reached);
      if (marker !== undefined) note(marker.reach, marker.why, relative(srcRoot, reached));
    }
    for (const flag of FLAG_REACHES) {
      if (flag.applies(entry.leaf, entry.usage)) note(flag.reach, flag.why, "command grammar");
    }
    return {
      group: entry.group,
      command: entry.leaf.command,
      path: entry.leaf.path,
      alias: entry.leaf.path !== entry.canonicalPath ? entry.canonicalPath : undefined,
      module: entry.module === undefined ? undefined : relative(packageRoot, entry.module),
      reaches: Object.fromEntries([...reaches].map(([reach, causes]) => [reach, causes])),
    };
  });

  return { rows };
}

function countBy(rows, reach) {
  return rows.filter((row) => Object.hasOwn(row.reaches, reach)).length;
}

export function renderReport({ rows }) {
  const commands = new Set(rows.map((row) => row.command));
  const bundleOnly = rows.filter((row) => Object.keys(row.reaches).length === 0);
  const sharedModules = new Map();
  for (const row of rows) {
    if (row.module === undefined) continue;
    sharedModules.set(row.module, (sharedModules.get(row.module) ?? 0) + 1);
  }

  const lines = [];
  lines.push("# Command surface");
  lines.push("");
  lines.push(
    "GENERATED FILE — do not edit. Run `npm run surface -w @superbee/cli` to regenerate;",
    "`npm run surface:check -w @superbee/cli` fails when this file is stale.",
  );
  lines.push("");
  lines.push(
    "Every public CLI leaf, labelled with what it reaches outside the bundle it is pointed at.",
    "Labels are derived from the canonical registry in `src/command-spec.ts` and from the real",
    "import graph under `src/` — not declared by hand — so each one names the module that proves",
    "it. **This file makes no stability claim.** It answers how large the surface is and how much",
    "of it reaches past the bundle.",
  );
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- **${rows.length} public leaves** across **${commands.size} top-level commands**`);
  lines.push(`- **${bundleOnly.length}** reach nothing outside the bundle`);
  for (const [reach, gloss] of REACH_ORDER) {
    lines.push(`- **${countBy(rows, reach)}** ${reach} — ${gloss}`);
  }
  lines.push("");
  lines.push(
    "A leaf can carry more than one reach, so these do not sum to the total.",
  );
  lines.push("");

  lines.push("## What each reach means");
  lines.push("");
  lines.push("| Reach | Meaning | Proven by |");
  lines.push("| --- | --- | --- |");
  for (const [reach, gloss] of REACH_ORDER) {
    const markers = Object.entries(REACH_MARKERS)
      .filter(([, marker]) => marker.reach === reach)
      .map(([module]) => `\`${module}\``);
    const grammar = FLAG_REACHES.some((flag) => flag.reach === reach) ? ["the command grammar"] : [];
    lines.push(`| \`${reach}\` | ${gloss} | ${[...markers, ...grammar].join(", ") || "—"} |`);
  }
  lines.push("");

  lines.push("## Leaves");
  lines.push("");
  lines.push("| Command | Reaches | Implemented by |");
  lines.push("| --- | --- | --- |");
  let currentGroup;
  for (const row of rows) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      lines.push(`| **${currentGroup}** | | |`);
    }
    const reaches = Object.keys(row.reaches);
    const label = reaches.length === 0 ? "bundle only" : reaches.map((r) => `\`${r}\``).join(", ");
    const alias = row.alias === undefined ? "" : ` _(alias of \`${row.alias}\`)_`;
    lines.push(`| \`${row.path}\`${alias} | ${label} | \`${row.module ?? "—"}\` |`);
  }
  lines.push("");

  lines.push("## Evidence");
  lines.push("");
  lines.push(
    "Why each labelled leaf carries the label it does. Where a reach covers more than half the",
    "surface the exceptions are listed instead, because the short list is the informative one.",
  );
  lines.push("");
  for (const [reach] of REACH_ORDER) {
    const labelled = rows.filter((row) => Object.hasOwn(row.reaches, reach));
    if (labelled.length === 0) continue;
    lines.push(`### ${reach} — ${labelled.length} of ${rows.length}`);
    lines.push("");
    if (labelled.length * 2 > rows.length) {
      const exceptions = rows.filter((row) => !Object.hasOwn(row.reaches, reach));
      const causes = [...new Set(labelled.flatMap((row) => row.reaches[reach].map((cause) => `${cause.evidence} — ${cause.why}`)))];
      for (const cause of causes) lines.push(`- via ${cause}`);
      lines.push("");
      lines.push(
        exceptions.length === 0
          ? "No exceptions: every leaf."
          : `Every leaf except: ${exceptions.map((row) => `\`${row.path}\``).join(", ")}.`,
      );
    } else {
      for (const row of labelled) {
        const causes = row.reaches[reach]
          .map((cause) => `${cause.evidence} — ${cause.why}`)
          .join("; ");
        lines.push(`- \`${row.path}\`: ${causes}`);
      }
    }
    lines.push("");
  }

  const multiLeafModules = [...sharedModules].filter(([, count]) => count > 1).sort();
  if (multiLeafModules.length > 0) {
    lines.push("## Resolution granularity");
    lines.push("");
    lines.push(
      "These modules implement more than one leaf, so those leaves necessarily share a reach.",
      "A finer answer would need the code split, not the report changed.",
    );
    lines.push("");
    for (const [module, count] of multiLeafModules) lines.push(`- \`${module}\` — ${count} leaves`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function generate() {
  const [{ CLI_COMMAND_GROUPS }, graph] = await Promise.all([loadCommandSpec(), readImportGraph()]);
  const inventory = buildInventory({ groups: CLI_COMMAND_GROUPS, graph });
  return { ...inventory, report: renderReport(inventory) };
}

async function main(argv) {
  const { rows, report } = await generate();

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  if (argv.includes("--check")) {
    const existing = await readFile(reportPath, "utf8").catch(() => undefined);
    if (existing === report) {
      process.stdout.write(`command surface up to date (${rows.length} leaves)\n`);
      return 0;
    }
    process.stderr.write(
      `${relative(repoRoot, reportPath)} is stale — run \`npm run surface -w @superbee/cli\`\n`,
    );
    return 1;
  }

  await writeFile(reportPath, report);
  process.stdout.write(`wrote ${relative(repoRoot, reportPath)} (${rows.length} leaves)\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(await main(process.argv.slice(2)));
