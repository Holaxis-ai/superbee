import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle } from "@superbee/core";

import { catalog } from "../src/commands/catalog.js";
import { CliError } from "../src/errors.js";

async function fixture(): Promise<{ root: string; home: string; bundle: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agentstate-lite-catalog-command-")));
  const home = path.join(root, "home");
  const bundle = path.join(root, "bundle");
  await initBundle(bundle);
  return { root, home, bundle };
}

async function runJson(argv: string[], home: string, cwd: string): Promise<Record<string, any>> {
  let stdout = "";
  await catalog([...argv, "--json"], { home: () => home, cwd: () => cwd, stdout: (value) => (stdout += value) });
  return JSON.parse(stdout) as Record<string, any>;
}

test("catalog command supports the explicit add/list/resolve loop and canonicalizes symlinks", async () => {
  const f = await fixture();
  try {
    const linked = path.join(f.root, "linked");
    await symlink(f.bundle, linked, "dir");
    const added = await runJson(["add", "project", "--dir", linked], f.home, f.root);
    assert.equal(added.catalog, "added");
    assert.equal(added.locator.path, f.bundle);

    const repeated = await runJson(["add", "project", "--dir", f.bundle], f.home, f.root);
    assert.equal(repeated.catalog, "unchanged");
    assert.equal(repeated.id, added.id);

    const listed = await runJson(["list"], f.home, f.root);
    assert.equal(listed.count, 1);
    assert.equal(listed.entries[0].label, "project");
    assert.equal(listed.entries[0].available, true);

    const resolved = await runJson(["resolve", added.id], f.home, f.root);
    assert.equal(resolved.label, "project");

    let raw = "";
    await catalog(["resolve", "project", "--field", "path"], {
      home: () => f.home,
      cwd: () => f.root,
      stdout: (value) => (raw += value),
    });
    assert.equal(raw, f.bundle + "\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog command validates scoped flags, arity, and labels", async () => {
  const f = await fixture();
  try {
    const cases = [
      ["add", "Uppercase", "--dir", f.bundle],
      ["add", "one", "two", "--dir", f.bundle],
      ["list", "--dir", f.bundle],
      ["resolve", "one", "--field", "other"],
      ["resolve", "one", "--field", "path", "--json"],
      ["unknown"],
    ];
    for (const argv of cases) {
      await assert.rejects(
        () => catalog(argv, { home: () => f.home, cwd: () => f.root, stderr: () => {} }),
        (err: unknown) => err instanceof CliError && err.code === "USAGE",
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog resolve --field path reserves stdout and routes every error envelope to stderr", async () => {
  const f = await fixture();
  try {
    let stdout = "";
    let stderr = "";
    await assert.rejects(
      () =>
        catalog(["resolve", "missing", "--field", "path", "--unknown"], {
          home: () => f.home,
          cwd: () => f.root,
          stdout: (value) => (stdout += value),
          stderr: (value) => (stderr += value),
        }),
      (err: unknown) => err instanceof CliError && err.code === "USAGE" && err.handled,
    );
    assert.equal(stdout, "");
    assert.match(stderr, /error:/);

    stderr = "";
    await assert.rejects(
      () =>
        catalog(["resolve", "missing", "--field", "path"], {
          home: () => f.home,
          cwd: () => f.root,
          stdout: (value) => (stdout += value),
          stderr: (value) => (stderr += value),
        }),
      (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND" && err.handled,
    );
    assert.equal(stdout, "");
    assert.match(stderr, /NOT_FOUND/);

    stderr = "";
    await assert.rejects(
      () =>
        catalog(["resolve", "missing", "--field=path"], {
          home: () => f.home,
          cwd: () => f.root,
          stdout: (value) => (stdout += value),
          stderr: (value) => (stderr += value),
        }),
      (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND" && err.handled,
    );
    assert.equal(stdout, "");
    assert.match(stderr, /NOT_FOUND/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
