// The registry's path surface, proved against the SHIPPED parser.
//
// `CliLeafSpec.pathFlags` / `pathPositionals` are what the boundary coverage tables enumerate
// themselves from. Declared metadata that nothing checks is just another hand-kept list — the
// exact artifact that let four review rounds each miss a different crossing point — so this file
// is the gate that makes the declaration TRUE:
//
//   • every declared path flag is accepted by the built CLI, and
//   • no UNDECLARED path-shaped flag is accepted anywhere, and
//   • every declared non-`rejected` path flag appears in its command's usage line.
//
// The probe is `<leaf> --<flag>` with no value: a configured option answers "requires a value", an
// unconfigured one answers "unknown option". Both fail during argument parsing, before any effect.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CLI_COMMAND_GROUPS,
  HOME_LEAF,
  PUBLIC_LEAVES,
  type CliLeafSpec,
} from "../src/command-spec.js";
import { BUILT_CLI, runCli, scratch } from "./support/private-state-fixtures.js";

const ALL_LEAVES: readonly CliLeafSpec[] = [...PUBLIC_LEAVES, HOME_LEAF];

/**
 * Path-shaped flag names probed on EVERY leaf, whatever the registry currently declares. This list
 * is FIXED on purpose: a candidate set derived only from the declarations would shrink the moment a
 * declaration was deleted, so deleting one would silently stop testing it — precisely the
 * regression this gate exists to catch. The declared union is unioned in on top, so a newly
 * declared name is covered without editing this list.
 */
const PATH_FLAG_CANDIDATES = [
  "dir",
  "body-file",
  "out",
  "body-out",
  "recipe",
  "file",
  "input",
  "output",
  "source",
  "dest",
  "path",
  "from-file",
  "to-file",
] as const;

/** Positionals a leaf needs before its own parser is reached. Default: `arity.count` placeholders. */
const PROBE_POSITIONALS: Readonly<Record<string, readonly string[]>> = {
  // `new` resolves the bundle and the Kind BEFORE its kind-aware strict parse, so a placeholder
  // Kind never reaches the flag table.
  new: ["Context Note", "probe-id"],
};

function probeArgv(leaf: CliLeafSpec, flag: string): string[] {
  const positionals = PROBE_POSITIONALS[leaf.id]
    ?? Array.from({ length: leaf.arity.count }, (_unused, index) => `probe${index}`);
  return [...leaf.path.split(" "), ...positionals, `--${flag}`];
}

function spawnProbe(argv: readonly string[], cwd: string, home: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUILT_CLI, ...argv], {
      cwd,
      env: {
        ...process.env,
        ASLITE_NO_UPDATE_CHECK: "1",
        SUPERBEE_NO_UPDATE_CHECK: "1",
        AGENTSTATE_LITE_NO_AUTOPULL: "1",
        SUPERBEE_NO_AUTOPULL: "1",
        HOME: home,
      },
      encoding: "utf8",
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("close", () => resolve(output));
  });
}

async function mapConcurrently<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

type Acceptance = "accepted" | "rejected";

function classify(output: string): Acceptance | null {
  if (/requires a value/.test(output)) return "accepted";
  // `new` and `doc update` route undeclared flags through kind-field validation instead of
  // parseArgs, so their rejection wording differs — both are still a rejection.
  if (/unknown option/.test(output) || /unknown field\(s\) for kind/.test(output)) return "rejected";
  return null;
}

/** One scratch bundle: `new` only reaches its flag table inside a real bundle with real kinds. */
function probeWorkspace(): { cwd: string; home: string; cleanup: () => void } {
  const root = scratch("superbee-path-surface-");
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const initialized = runCli(["init", "--create-only", "--dir", ".superbee", "--json"], { cwd, home });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  return { cwd, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("registry path flags: every declared flag is accepted by the built CLI, and no undeclared path-shaped flag is", async (t) => {
  const workspace = probeWorkspace();
  t.after(() => workspace.cleanup());
  const declaredNames = [...new Set(ALL_LEAVES.flatMap((leaf) => leaf.pathFlags.map((entry) => entry.flag)))].sort();
  const candidates = [...new Set([...declaredNames, ...PATH_FLAG_CANDIDATES])].sort();

  const jobs = ALL_LEAVES.flatMap((leaf) => candidates.map((flag) => ({ leaf, flag })));
  const observed = await mapConcurrently(jobs, 12, async ({ leaf, flag }) => {
    const output = await spawnProbe(probeArgv(leaf, flag), workspace.cwd, workspace.home);
    return { leaf, flag, acceptance: classify(output), output };
  });

  const unclassified = observed.filter((row) => row.acceptance === null);
  assert.deepEqual(
    unclassified.map((row) => `${row.leaf.path} --${row.flag}: ${row.output.trim()}`),
    [],
    "a probe that reaches neither the flag table nor a rejection needs a PROBE_POSITIONALS entry",
  );

  for (const leaf of ALL_LEAVES) {
    const declared = new Set(leaf.pathFlags.map((entry) => entry.flag));
    const accepted = new Set(
      observed.filter((row) => row.leaf === leaf && row.acceptance === "accepted").map((row) => row.flag),
    );
    for (const flag of declared) {
      assert.ok(accepted.has(flag), `${leaf.path} declares --${flag} but the shipped parser rejects it`);
    }
    if (leaf.dynamicFieldFlags) continue;
    for (const flag of accepted) {
      assert.ok(
        declared.has(flag),
        `${leaf.path} accepts --${flag} without declaring it in command-spec.ts — declare its CliPathRole `
        + "so the boundary coverage table can require a row for it",
      );
    }
  }

  for (const leaf of ALL_LEAVES.filter((candidate) => candidate.dynamicFieldFlags)) {
    await t.test(
      `${leaf.path}: undeclared path-shaped flags are rejected`,
      {
        skip:
          "unprovable by probe: this leaf parses with strict:false so an undeclared --flag is a kind FIELD, "
          + "not a filesystem target. Convert this row to a passing one if the parser ever becomes strict.",
      },
      () => {},
    );
  }
});

test("registry path flags: every declared path flag is documented in its command's usage line", () => {
  const rows = CLI_COMMAND_GROUPS.flatMap((group) => group.commands);
  const missing: string[] = [];
  for (const row of rows) {
    for (const leaf of row.leaves) {
      for (const entry of leaf.pathFlags) {
        // A `rejected` flag reaches a leaf only through a shared selector parse config and is then
        // refused as a USAGE error; documenting it would advertise an option that cannot be used.
        if (entry.role === "rejected") continue;
        if (!row.usage.includes(`--${entry.flag} `) && !row.usage.includes(`--${entry.flag}]`)) {
          missing.push(`${row.id}: ${leaf.path} accepts --${entry.flag} (${entry.role}) but its usage omits it`);
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("registry path positionals: each is inside the leaf's arity and visible in the usage line", () => {
  const rows = CLI_COMMAND_GROUPS.flatMap((group) => group.commands);
  const declared = rows.flatMap((row) => row.leaves.flatMap((leaf) =>
    leaf.pathPositionals.map((entry) => ({ row, leaf, entry }))));
  assert.ok(declared.length > 0, "the fixture would be vacuous with no declared path positionals");
  for (const { row, leaf, entry } of declared) {
    assert.ok(entry.index < leaf.arity.count, `${leaf.path}: positional ${entry.index} exceeds its arity`);
    assert.match(row.usage, /<file>|<name-or-path>|<path>/, `${row.id}: a path positional must be visible in the usage`);
  }
});
