import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CLI_COMMAND_GROUPS,
  CLI_LEAVES,
  HOME_LEAF,
  PUBLIC_COMMAND_NAMES,
  PUBLIC_LEAVES,
  type CommandSpecGroup,
} from "../src/command-spec.js";
import { KNOWN_COMMANDS, PUBLIC_HANDLERS, RUNTIME_COMMANDS } from "../src/cli.js";
import { COMMAND_GROUPS } from "../src/reference.js";
import { projectCommandSpec } from "./support/command-spec-projector.js";

test("canonical graph owns unique indexed public leaves and one hidden home leaf", () => {
  assert.equal(PUBLIC_LEAVES.length, Object.keys(CLI_LEAVES).length);
  assert.equal(new Set(PUBLIC_LEAVES.map((leaf) => leaf.id)).size, PUBLIC_LEAVES.length);
  assert.equal(new Set(PUBLIC_LEAVES.map((leaf) => leaf.path)).size, PUBLIC_LEAVES.length);
  assert.deepEqual(PUBLIC_LEAVES.map((leaf) => leaf.id).sort(), Object.keys(CLI_LEAVES).sort());
  assert.equal(PUBLIC_LEAVES.every((leaf) => leaf.exposure === "public"), true);
  assert.equal(HOME_LEAF.exposure, "hidden");
  assert.equal(PUBLIC_LEAVES.some((leaf) => leaf.path === "home" || leaf.path === "update"), false);
  assert.strictEqual(CLI_LEAVES.query.canonical, CLI_LEAVES.list);
  assert.strictEqual(CLI_LEAVES.query.arity, CLI_LEAVES.list.arity);
});

test("reference, known names, exact handlers, and runtime registration are graph projections", () => {
  const projectedPaths = CLI_COMMAND_GROUPS.flatMap((group) => group.commands.flatMap((row) => row.leaves.map((leaf) => leaf.path)));
  const referencePaths = COMMAND_GROUPS.flatMap((group) => group.commands.flatMap((row) => row.paths));
  assert.deepEqual(referencePaths, projectedPaths);
  assert.strictEqual(KNOWN_COMMANDS, PUBLIC_COMMAND_NAMES);
  assert.deepEqual(Object.keys(PUBLIC_HANDLERS), PUBLIC_COMMAND_NAMES);
  assert.deepEqual(Object.keys(RUNTIME_COMMANDS), [...PUBLIC_COMMAND_NAMES, "home", "update"]);
});

test("public command order preserves the user-facing unknown-command diagnostic", () => {
  assert.deepEqual(PUBLIC_COMMAND_NAMES, [
    "init", "bundle", "catalog", "index", "doc", "promote", "pull", "blobs", "delete",
    "link", "list", "query", "new", "artifact", "kinds", "kind", "recipes", "recipe",
    "status", "serve", "ui", "mcp", "sync", "hook", "skill", "session-start", "version", "view",
  ]);
});

test("pure projection seam gives a one-row change budget for one synthetic addition", () => {
  const before = projectCommandSpec(CLI_COMMAND_GROUPS);
  const synthetic = {
    group: "Synthetic",
    commands: [{
      id: "probe",
      usage: "probe",
      summary: "Synthetic projection probe",
      leaves: [{ id: "probe", path: "probe", arity: { count: 0 } } as never],
    }],
  } as const satisfies CommandSpecGroup;
  const after = projectCommandSpec([...CLI_COMMAND_GROUPS, synthetic]);
  assert.deepEqual(after.paths.slice(0, -1), before.paths);
  assert.equal(after.paths.at(-1), "probe");
  assert.equal(after.rows.length, before.rows.length + 1);
  assert.equal(after.commandNames.filter((name) => name === "probe").length, 1);
});

test("nested-leaf and exact-count changes project from one graph value", () => {
  const before = projectCommandSpec(CLI_COMMAND_GROUPS);
  const targetRowId = "bundleLocate";
  const targetLeafId = "bundleLocate";
  const nestedGroups = CLI_COMMAND_GROUPS.map((group) => ({
    ...group,
    commands: group.commands.map((row) => row.id === targetRowId
      ? { ...row, leaves: [...row.leaves, { id: "bundleInspect", path: "bundle inspect", arity: { count: 0 } } as never] }
      : row),
  })) as readonly CommandSpecGroup[];
  const nested = projectCommandSpec(nestedGroups);
  assert.equal(nested.rows.length, before.rows.length);
  assert.equal(nested.paths.length, before.paths.length + 1);
  assert.equal(nested.commandNames.length, before.commandNames.length);
  assert.equal(nested.rows.find((row) => row.id === targetRowId)?.paths.at(-1), "bundle inspect");
  assert.equal(nested.leaves.find((leaf) => leaf.id === "bundleInspect")?.path, "bundle inspect");

  const countGroups = CLI_COMMAND_GROUPS.map((group) => ({
    ...group,
    commands: group.commands.map((row) => row.id === targetRowId
      ? {
          ...row,
          leaves: row.leaves.map((leaf) => leaf.id === targetLeafId
            ? { ...leaf, arity: { kind: "exact" as const, count: leaf.arity.count + 1 } }
            : leaf),
        }
      : row),
  })) as readonly CommandSpecGroup[];
  const changed = projectCommandSpec(countGroups);
  const beforeCounts = new Map(before.leaves.map((leaf) => [leaf.id, leaf.count]));
  assert.deepEqual(
    changed.leaves.filter((leaf) => leaf.count !== beforeCounts.get(leaf.id)),
    [{ id: targetLeafId, path: CLI_LEAVES.bundleLocate.path, count: CLI_LEAVES.bundleLocate.arity.count + 1 }],
  );
});

test("command-spec stays at the dependency bottom", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/command-spec.ts"), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
});
