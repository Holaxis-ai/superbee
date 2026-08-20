import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { CONVENTION_TYPE, initBundle, readDoc, writeDoc, type Bundle } from "@superbee/core";

const cliBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/superbee.mjs");
const T = "2026-07-01T00:00:00.000Z";

test("built CLI new persists prototype-looking options as exact own properties and rejects omissions", async () => {
  assert.ok(existsSync(cliBin), "root npm run build must create the built CLI before this proof runs");
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-new-built-"));
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir, { okfVersion: "0.1" });
    const cases = [
      { field: "__proto__", args: ["--__proto__", "proto-value"], expected: "proto-value", values: ["proto-value"] },
      { field: "constructor", args: ["--constructor=ctor-value"], expected: "ctor-value", values: ["ctor-value"] },
      { field: "toString", args: ["--toString", "first", "--toString", "second"], expected: ["first", "second"] },
    ];
    for (const entry of cases) {
      const kindName = `Built ${entry.field}`;
      const suffix = entry.field.replaceAll("_", "dash");
      await writeDoc(bundle, {
        id: `conventions/built-${suffix}`,
        frontmatter: {
          type: CONVENTION_TYPE,
          governs: kindName,
          fields: { required: [entry.field], values: entry.values ? Object.fromEntries([[entry.field, entry.values]]) : {} },
          timestamp: T,
        },
        body: "",
      });

      const presentId = `present-${suffix}`;
      const result = spawnSync("node", [cliBin, "new", kindName, presentId, ...entry.args, "--dir", dir, "--json"], { encoding: "utf8" });
      assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
      const saved = await readDoc(bundle, presentId);
      assert.equal(Object.prototype.hasOwnProperty.call(saved.frontmatter, entry.field), true);
      assert.deepEqual((saved.frontmatter as Record<string, unknown>)[entry.field], entry.expected);
      assert.equal(Object.getPrototypeOf(saved.frontmatter), Object.prototype);

      const missingId = `missing-${suffix}`;
      const missing = spawnSync("node", [cliBin, "new", kindName, missingId, "--dir", dir, "--json"], { encoding: "utf8" });
      assert.equal(missing.status, 2, `stdout=${missing.stdout} stderr=${missing.stderr}`);
      assert.match(missing.stdout, new RegExp(entry.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await assert.rejects(() => readDoc(bundle, missingId));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI new accepts logical progress_status while preserving v0.1 status storage", async () => {
  assert.ok(existsSync(cliBin), "root npm run build must create the built CLI before this proof runs");
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-progress-new-"));
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir, { okfVersion: "0.1" });
    await writeDoc(bundle, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Task",
        path: "tasks/",
        fields: {
          required: ["title", "status"],
          optional: [],
          values: { status: ["todo", "done"] },
        },
        timestamp: T,
      },
      body: "",
    });

    const result = spawnSync(
      "node",
      [cliBin, "new", "Task", "logical", "--title", "Logical", "--progress_status", "todo", "--dir", dir, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(receipt.field_coordinates, undefined);
    const saved = await readDoc(bundle, "tasks/logical");
    assert.equal(saved.frontmatter.status, "todo");
    assert.equal(Object.hasOwn(saved.frontmatter, "progress_status"), false);

    const duplicate = spawnSync(
      "node",
      [cliBin, "new", "Task", "duplicate", "--title", "Duplicate", "--status", "todo", "--progress_status", "done", "--dir", dir, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(duplicate.status, 2, `stdout=${duplicate.stdout} stderr=${duplicate.stderr}`);
    assert.match(duplicate.stdout, /'progress_status' was supplied more than once/);
    assert.doesNotMatch(duplicate.stdout, /--status|stored field/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI new maps logical progress_status to the producer-qualified v0.2 coordinate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-progress-v02-new-"));
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    await writeFile(path.join(dir, "index.md"), "---\nokf_version: '0.2'\n---\n# Bundle\n", "utf8");
    await writeDoc(bundle, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Task",
        path: "tasks/",
        fields: {
          required: ["title", "superbee_progress_status"],
          optional: ["status", "priority"],
          values: {
            superbee_progress_status: ["todo", "done"],
            status: ["draft", "stable", "deprecated"],
            priority: ["high"],
          },
        },
      },
      body: "",
    });
    const help = spawnSync("node", [cliBin, "new", "Task", "--help", "--dir", dir], { encoding: "utf8" });
    assert.equal(help.status, 0, `stdout=${help.stdout} stderr=${help.stderr}`);
    assert.match(help.stdout, /--progress_status <v>  required/);
    assert.doesNotMatch(help.stdout, /superbee_progress_status|stored as/);

    const missingProgress = spawnSync(
      "node",
      [cliBin, "new", "Task", "missing-progress", "--title", "Missing", "--dir", dir, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(missingProgress.status, 2, `stdout=${missingProgress.stdout} stderr=${missingProgress.stderr}`);
    assert.match(missingProgress.stdout, /progress_status/);
    assert.doesNotMatch(missingProgress.stdout, /superbee_progress_status/);

    for (const duplicateFields of [
      ["--progress_status", "todo", "--superbee_progress_status", "done"],
      ["--superbee_progress_status", "todo", "--progress_status", "done"],
    ]) {
      const duplicate = spawnSync(
        "node",
        [cliBin, "new", "Task", `duplicate-${duplicateFields[0]!.includes("superbee") ? "raw" : "logical"}`, "--title", "Duplicate", ...duplicateFields, "--dir", dir, "--json"],
        { encoding: "utf8" },
      );
      assert.equal(duplicate.status, 2, `stdout=${duplicate.stdout} stderr=${duplicate.stderr}`);
      assert.match(duplicate.stdout, /'progress_status' was supplied more than once/);
      assert.doesNotMatch(duplicate.stdout, /superbee_progress_status/);
    }

    const literalValue = spawnSync(
      "node",
      [cliBin, "new", "Task", "literal-value", "--title", "Literal", "--progress_status", "todo", "--priority", "superbee_progress_status", "--dir", dir, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(literalValue.status, 2, `stdout=${literalValue.stdout} stderr=${literalValue.stderr}`);
    assert.match(literalValue.stdout, /'priority' value 'superbee_progress_status'/);

    const result = spawnSync(
      "node",
      [cliBin, "new", "Task", "v02", "--title", "V02", "--progress_status", "todo", "--status", "stable", "--dir", dir, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    const saved = await readDoc(bundle, "tasks/v02");
    assert.equal(saved.frontmatter.superbee_progress_status, "todo");
    assert.equal(saved.frontmatter.status, "stable");
    assert.equal(Object.hasOwn(saved.frontmatter, "progress_status"), false);
    assert.equal(Object.hasOwn(saved.frontmatter, "timestamp"), false);
    assert.equal(Object.hasOwn(saved.frontmatter, "actor"), false);
    assert.equal(Object.hasOwn(saved.frontmatter, "generated"), false);
    assert.equal((JSON.parse(result.stdout) as Record<string, unknown>).field_coordinates, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI creates a work-tracking Task fresh without exposing its storage clock in the receipt", async () => {
  assert.ok(existsSync(cliBin), "root npm run build must create the built CLI before this proof runs");
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-fresh-task-"));
  try {
    const initialized = spawnSync(
      "node",
      [cliBin, "init", "--dir", dir, "--recipe", "work-tracking", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(initialized.status, 0, `stdout=${initialized.stdout} stderr=${initialized.stderr}`);

    const created = spawnSync(
      "node",
      [
        cliBin,
        "new",
        "Task",
        "fresh",
        "--title",
        "Fresh",
        "--progress_status",
        "todo",
        "--dir",
        dir,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, `stdout=${created.stdout} stderr=${created.stderr}`);
    const receipt = JSON.parse(created.stdout) as Record<string, unknown>;
    assert.equal(receipt.timestamp, null);
    assert.equal(receipt.generated, undefined);

    const saved = await readDoc({ root: dir }, "tasks/fresh");
    assert.deepEqual(saved.frontmatter.generated, {
      by: "process:superbee",
      at: (saved.frontmatter.generated as Record<string, unknown>).at,
    });
    assert.equal(typeof (saved.frontmatter.generated as Record<string, unknown>).at, "string");
    assert.equal(Object.hasOwn(saved.frontmatter, "timestamp"), false);

    const status = spawnSync("node", [cliBin, "status", "--dir", dir, "--json"], { encoding: "utf8" });
    assert.equal(status.status, 0, `stdout=${status.stdout} stderr=${status.stderr}`);
    const health = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(health.no_timestamp, 0);
    assert.equal(health.stale, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
