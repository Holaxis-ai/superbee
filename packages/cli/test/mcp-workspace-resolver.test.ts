import assert from "node:assert/strict";
import { mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { initBundle, type Bundle } from "@superbee/core";
import { MAX_WORKSPACE_CATALOG_PAGE } from "@superbee/mcp-app";

import { createCatalogMcpWorkspaceResolver } from "../src/mcp-workspace-resolver.js";
import { openBundle } from "../src/bundle.js";
import { addCatalogEntry } from "../src/catalog.js";

const availableEntry = {
  id: "bnd_00000000000000000000000000000000",
  label: "planning",
  locator: { kind: "local-path" as const, path: "/private/catalog/planning" },
  available: true,
};

test("catalog MCP resolver exposes only path-free summaries and derives display names", async () => {
  const bundle = { root: "/private/catalog/planning" } as Bundle;
  const opened: Array<string | undefined> = [];
  const resolver = createCatalogMcpWorkspaceResolver({
    listEntries: async () => [
      availableEntry,
      {
        id: "bnd_11111111111111111111111111111111",
        label: "missing",
        locator: { kind: "local-path", path: "/private/catalog/missing" },
        available: false,
      },
    ],
    open: async (dir) => {
      opened.push(dir);
      return bundle;
    },
    deriveName: async () => ({ name: "Product planning", source: "explicit" }),
  });

  const listed = await resolver.list();
  assert.deepEqual(listed, [
    {
      id: availableEntry.id,
      label: "planning",
      displayName: "Product planning",
      available: true,
    },
    {
      id: "bnd_11111111111111111111111111111111",
      label: "missing",
      available: false,
    },
  ]);
  assert.deepEqual(opened, [availableEntry.locator.path]);
  assert.doesNotMatch(JSON.stringify(listed), /private|locator|path/);
});

test("catalog MCP resolver re-resolves selection and returns one immutable bundle context", async () => {
  const bundle = { root: availableEntry.locator.path } as Bundle;
  let selected: string | undefined;
  const resolver = createCatalogMcpWorkspaceResolver({
    actor: "human:mike",
    resolveEntry: async (selector) => {
      selected = selector;
      return availableEntry;
    },
    open: async (dir) => {
      assert.equal(dir, availableEntry.locator.path);
      return bundle;
    },
    resolveTarget: async () => ({
      root: availableEntry.locator.path,
      canonicalRoot: availableEntry.locator.path,
      selectedBy: "explicit-dir",
    }),
    deriveName: async () => ({ name: "Product planning", source: "explicit" }),
  });

  const context = await resolver.open("planning");
  assert.equal(selected, "planning");
  assert.equal(context.bundle, bundle);
  assert.equal(context.name, "Product planning");
  assert.equal(context.actor, "human:mike");
  assert.ok(context.viewAuthorization);
  assert.ok(Object.isFrozen(context));
});

test("catalog MCP resolver downgrades display-name drift to unavailable without leaking paths", async () => {
  const resolver = createCatalogMcpWorkspaceResolver({
    listEntries: async () => [availableEntry],
    open: async () => {
      throw new Error(`could not read ${availableEntry.locator.path}`);
    },
  });

  const listed = await resolver.list();
  assert.deepEqual(listed, [{
    id: availableEntry.id,
    label: availableEntry.label,
    available: false,
  }]);
  assert.doesNotMatch(JSON.stringify(listed), /private|catalog/);
});

test("catalog MCP resolver bounds display-name bundle reads to the visible page", async () => {
  let opens = 0;
  const resolver = createCatalogMcpWorkspaceResolver({
    listEntries: async () => Array.from(
      { length: MAX_WORKSPACE_CATALOG_PAGE + 3 },
      (_, index) => ({
        id: `bnd_${index.toString(16).padStart(32, "0")}`,
        label: `workspace-${index.toString().padStart(2, "0")}`,
        locator: { kind: "local-path" as const, path: `/private/catalog/${index}` },
        available: true,
      }),
    ),
    open: async (dir) => {
      opens += 1;
      return { root: dir ?? "" } as Bundle;
    },
    deriveName: async (bundle) => ({ name: bundle.root, source: "root-basename" }),
  });

  const listed = await resolver.list();
  assert.equal(listed.length, MAX_WORKSPACE_CATALOG_PAGE + 3);
  assert.equal(opens, MAX_WORKSPACE_CATALOG_PAGE);
  assert.equal(listed[MAX_WORKSPACE_CATALOG_PAGE]?.displayName, undefined);
});

test("catalog MCP resolver refuses canonical-root drift between resolution and open", async () => {
  const resolver = createCatalogMcpWorkspaceResolver({
    resolveEntry: async () => availableEntry,
    open: async () => ({ root: availableEntry.locator.path }) as Bundle,
    resolveTarget: async () => ({
      root: availableEntry.locator.path,
      canonicalRoot: "/private/catalog/replaced",
      selectedBy: "explicit-dir",
    }),
  });

  await assert.rejects(
    resolver.open("planning"),
    /workspace catalog target changed during selection/,
  );
});

test("catalog MCP resolver refuses a real rename-and-symlink retarget during selection", async (t) => {
  const requestedBase = await mkdtemp(path.join(os.tmpdir(), "superbee-mcp-retarget-"));
  const base = await realpath(requestedBase);
  const home = path.join(base, "home");
  const slot = path.join(base, "slot");
  const moved = path.join(base, "moved");
  const foreign = path.join(base, "foreign");
  await initBundle(slot);
  await initBundle(foreign);
  await addCatalogEntry("planning", slot, { home });
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  let swapped = false;
  const resolver = createCatalogMcpWorkspaceResolver({
    home,
    open: async (dir) => {
      if (!swapped) {
        swapped = true;
        await rename(slot, moved);
        await symlink(foreign, slot, "dir");
      }
      return openBundle(dir);
    },
  });

  await assert.rejects(
    resolver.open("planning"),
    /workspace catalog target changed during selection/,
  );
});
