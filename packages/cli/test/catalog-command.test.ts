import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle } from "@superbee/core";

import { catalog } from "../src/commands/catalog.js";
import { catalogPath } from "../src/catalog.js";
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

test("catalog remove is idempotent, reports a missing folder in list, and never deletes files", async () => {
  const f = await fixture();
  try {
    const gone = path.join(f.root, "gone");
    await initBundle(gone);
    await runJson(["add", "project", "--dir", f.bundle], f.home, f.root);
    const added = await runJson(["add", "gone", "--dir", gone], f.home, f.root);
    await rm(gone, { recursive: true });

    const rawBefore = await readFile(catalogPath(f.home), "utf8");
    const listed = await runJson(["list", "--local"], f.home, f.root);
    assert.equal(listed.unavailable, 1);
    assert.equal(listed.entries.find((entry: { label: string }) => entry.label === "gone").available, false);
    assert.ok(listed.help.some((line: string) => /catalog remove gone$/.test(line)), JSON.stringify(listed.help));
    assert.equal(await readFile(catalogPath(f.home), "utf8"), rawBefore, "list never removes an entry");
    assert.equal((await runJson(["list", "--local"], f.home, f.root)).count, 2);

    const bundleBefore = await snapshot(f.bundle);
    const removed = await runJson(["remove", "gone"], f.home, f.root);
    assert.equal(removed.catalog, "removed");
    assert.equal(removed.removed, true);
    assert.equal(removed.id, added.id);
    assert.equal(removed.locator.path, gone);
    assert.ok(removed.help.some((line: string) => /catalog add gone --dir /.test(line)));

    const again = await runJson(["remove", "gone"], f.home, f.root);
    assert.equal(again.catalog, "unchanged");
    assert.equal(again.removed, false);
    assert.equal(again.reason, "not_registered");

    // A local folder's label is removed by id too, and the folder's files are untouched.
    const byId = await runJson(["remove", (await runJson(["resolve", "project"], f.home, f.root)).id], f.home, f.root);
    assert.equal(byId.removed, true);
    assert.equal(byId.checkout, undefined);
    assert.deepEqual(await snapshot(f.bundle), bundleBefore);
    const empty = await runJson(["list", "--local"], f.home, f.root);
    assert.equal(empty.count, 0);
    assert.equal(empty.unavailable, undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("catalog remove validates its selector and rejects --dir and --field", async () => {
  const f = await fixture();
  try {
    for (const argv of [["remove", "Bad Label"], ["remove", "bnd_xyz"], ["remove", "x", "--dir", f.bundle], ["remove", "x", "--field", "path"]]) {
      await assert.rejects(runJson(argv, f.home, f.root), (error: unknown) => error instanceof CliError && error.code === "USAGE", argv.join(" "));
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())) {
    const file = path.join(rel.parentPath, rel.name);
    out[path.relative(root, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return out;
}
