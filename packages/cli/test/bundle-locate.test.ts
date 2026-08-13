import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle } from "@superbee/core";

import {
  openBundle,
  PROJECT_BINDING_FILE_NAME,
  SUPERBEE_PROJECT_BINDING_FILE_NAME,
} from "../src/bundle.js";
import { bundleCommand } from "../src/commands/bundle.js";
import { CliError } from "../src/errors.js";

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "agentstate-lite-locate-test-")));
}

async function runJson(argv: string[], cwd: string): Promise<Record<string, unknown>> {
  let out = "";
  await bundleCommand([...argv, "--json"], { cwd: () => cwd, stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

test("bundle locate: explicit --dir wins and identifies the same physical root openBundle operates on", async () => {
  const root = await tempDir();
  try {
    const actual = path.join(root, "actual");
    await initBundle(actual);
    const linked = path.join(root, "linked");
    await symlink(actual, linked, "dir");

    const project = path.join(root, "project");
    await mkdir(project);
    await initBundle(path.join(project, ".agentstate-lite"));
    await writeFile(path.join(project, PROJECT_BINDING_FILE_NAME), JSON.stringify({ bundle: ".agentstate-lite" }));

    const receipt = await runJson(["locate", "--dir", linked], project);
    assert.deepEqual(receipt, {
      schema_version: 1,
      locator: { kind: "local-path", path: actual },
      selected_by: "explicit-dir",
      available: true,
    });

    const opened = await openBundle(linked);
    assert.equal(await realpath(opened.root), (receipt.locator as { path: string }).path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle locate: an explicit project directory identifies its conventional bundle", async () => {
  const project = await tempDir();
  try {
    const conventional = path.join(project, ".agentstate-lite");
    await initBundle(conventional);

    const receipt = await runJson(["locate", "--dir", project], project);
    assert.deepEqual(receipt, {
      schema_version: 1,
      locator: { kind: "local-path", path: conventional },
      selected_by: "explicit-dir",
      available: true,
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("bundle locate: a preferred project binding wins discovery and names the binding that selected it", async () => {
  const root = await tempDir();
  try {
    const bound = path.join(root, "bound");
    await initBundle(bound);
    const project = path.join(root, "project");
    const nested = path.join(project, "src", "deep");
    await mkdir(nested, { recursive: true });
    await initBundle(path.join(project, ".agentstate-lite"));
    const bindingFile = path.join(project, SUPERBEE_PROJECT_BINDING_FILE_NAME);
    await writeFile(bindingFile, JSON.stringify({ bundle: "../bound" }));

    const receipt = await runJson(["locate"], nested);
    assert.deepEqual(receipt, {
      schema_version: 1,
      locator: { kind: "local-path", path: bound },
      selected_by: "project-binding",
      binding_file: bindingFile,
      available: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle locate: bare resolution discovers the nearest conventional project bundle", async () => {
  const project = await tempDir();
  try {
    const conventional = path.join(project, ".agentstate-lite");
    await initBundle(conventional);
    const nested = path.join(project, "src", "deep");
    await mkdir(nested, { recursive: true });

    const receipt = await runJson(["locate"], nested);
    assert.deepEqual(receipt, {
      schema_version: 1,
      locator: { kind: "local-path", path: conventional },
      selected_by: "discovery",
      available: true,
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("bundle locate: unavailable targets and remote intent fail instead of choosing", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => bundleCommand(["locate", "--dir", path.join(dir, "missing"), "--json"], { cwd: () => dir }),
      (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND",
    );
    await assert.rejects(
      () => bundleCommand(["locate", "--remote", "http://example.test", "--json"], { cwd: () => dir }),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
