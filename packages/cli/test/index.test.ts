import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initBundle, writeDoc } from "@superbee/core";

import { KNOWN_COMMANDS } from "../src/cli.js";
import { indexCommand } from "../src/commands/index.js";
import { SKILL_COMMAND_RESOURCES } from "../src/distribution-resources.js";
import { CliError } from "../src/errors.js";
import { COMMAND_GROUPS } from "../src/reference.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliBin = path.resolve(here, "../dist/superbee.mjs");
const T = "2026-07-20T00:00:00.000Z";

async function tempBundle(name = "bundle"): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const top = await mkdtemp(path.join(tmpdir(), "aslite-index-cli-"));
  const root = path.join(top, name);
  await initBundle(root);
  return { root, cleanup: () => rm(top, { recursive: true, force: true }) };
}

async function runJson(args: string[]): Promise<Record<string, unknown>> {
  let output = "";
  await indexCommand([...args, "--json"], { stdout: (chunk) => (output += chunk) });
  return JSON.parse(output) as Record<string, unknown>;
}

function category(receipt: Record<string, unknown>, key: string): { shown: number; total: number; rows: Array<{ path: string }> } {
  return receipt[key] as { shown: number; total: number; rows: Array<{ path: string }> };
}

async function expectConflict(args: string[]): Promise<CliError> {
  try {
    await runJson(args);
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "CONFLICT");
    return error;
  }
  assert.fail("expected a CONFLICT");
}

test("index generate is registered in dispatch, self-description, and the distribution inventory", () => {
  assert.ok(KNOWN_COMMANDS.includes("index"));
  assert.ok(
    COMMAND_GROUPS.flatMap((group) => group.commands).some((command) => command.usage.startsWith("index generate")),
  );
  assert.deepEqual(SKILL_COMMAND_RESOURCES["index generate"], []);
});

test("recursive CLI journey: check is read-only, generation resolves links, rerun is a no-op, and drift is narrow", async () => {
  const top = await mkdtemp(path.join(tmpdir(), "aslite-index-project-"));
  const project = path.join(top, "project-atlas");
  const root = path.join(project, ".agentstate-lite");
  try {
    const bundle = await initBundle(root);
    await writeDoc(bundle, {
      id: "root",
      frontmatter: { type: "Reference", title: "Root", timestamp: T },
      body: "",
    });
    await writeDoc(bundle, {
      id: "child/item",
      frontmatter: { type: "Note", title: "Child", description: "first", timestamp: T },
      body: "",
    });
    await writeDoc(bundle, {
      id: "child/grand/deep",
      frontmatter: { type: "Design", title: "Deep", timestamp: T },
      body: "",
    });

    const rootBefore = await readFile(path.join(root, "index.md"), "utf8");
    const drift = await expectConflict(["generate", "--check", "--dir", root]);
    const driftDetails = drift.details!;
    assert.equal(driftDetails.index, "checked");
    assert.equal(driftDetails.writes, 0);
    assert.equal(driftDetails.display_name, "project-atlas");
    assert.equal(category(driftDetails, "created").total, 2);
    assert.equal(category(driftDetails, "updated").total, 1);
    assert.equal(await readFile(path.join(root, "index.md"), "utf8"), rootBefore, "--check never writes root");
    await assert.rejects(() => access(path.join(root, "child", "index.md")));

    const generated = await runJson(["generate", "--dir", root, "--actor", "mike/codex"]);
    assert.equal(generated.index, "generated");
    assert.equal(generated.changed, true);
    assert.equal(generated.writes, 3);
    assert.equal(category(generated, "completed").total, 3);
    const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
    const childIndex = await readFile(path.join(root, "child", "index.md"), "utf8");
    assert.match(rootIndex, /\[child\]\(child\/index\.md\)/);
    assert.match(childIndex, /\[grand\]\(grand\/index\.md\)/);
    assert.match(await readFile(path.join(root, "child", "grand", "index.md"), "utf8"), /\[Deep\]\(deep\.md\)/);

    const noOp = await runJson(["generate", "--dir", root, "--actor", "must-not-write"]);
    assert.equal(noOp.index, "unchanged");
    assert.equal(noOp.changed, false);
    assert.equal(noOp.writes, 0);
    assert.equal(category(noOp, "completed").total, 0);
    const clean = await runJson(["generate", "--check", "--dir", root]);
    assert.equal(clean.clean, true);
    assert.equal(clean.would_change, 0);

    await writeDoc(bundle, {
      id: "child/grand/deep",
      frontmatter: { type: "Design", title: "Deep", description: "now described", timestamp: T },
      body: "",
    });
    const afterConceptEdit = await expectConflict(["generate", "--check", "--dir", root]);
    assert.equal(category(afterConceptEdit.details!, "updated").total, 1);
    assert.deepEqual(category(afterConceptEdit.details!, "updated").rows, [{ path: "child/grand/index.md" }]);
    assert.equal(await readFile(path.join(root, "index.md"), "utf8"), rootIndex);
    assert.equal(await readFile(path.join(root, "child", "index.md"), "utf8"), childIndex);
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});

test("curated root refuses the whole write, force adopts deliberately, marker removal refuses again", async () => {
  const scratch = await tempBundle("curated");
  try {
    const bundle = { root: scratch.root };
    await writeDoc(bundle, {
      id: "child/item",
      frontmatter: { type: "Note", title: "Item", timestamp: T },
      body: "",
    });
    const curated = "---\nokf_version: '0.1'\n---\n# My curated introduction\n";
    await writeFile(path.join(scratch.root, "index.md"), curated);

    const refused = await expectConflict(["generate", "--dir", scratch.root]);
    assert.equal(category(refused.details!, "refused").total, 1);
    assert.equal(category(refused.details!, "created").total, 1);
    assert.equal(await readFile(path.join(scratch.root, "index.md"), "utf8"), curated);
    await assert.rejects(() => access(path.join(scratch.root, "child", "index.md")));

    const adopted = await runJson(["generate", "--force", "--dir", scratch.root]);
    assert.equal(category(adopted, "adopted").total, 1);
    assert.equal(category(adopted, "created").total, 1);
    assert.equal(adopted.writes, 2);

    const childPath = path.join(scratch.root, "child", "index.md");
    const childGenerated = await readFile(childPath, "utf8");
    await writeFile(childPath, childGenerated.replace("<!-- agentstate-lite:generated-index:v1 -->\n", ""));
    const markerRefusal = await expectConflict(["generate", "--dir", scratch.root]);
    assert.deepEqual(category(markerRefusal.details!, "refused").rows, [{ path: "child/index.md" }]);
  } finally {
    await scratch.cleanup();
  }
});

test("built CLI exposes conflict exit 5 for check drift and exit 0 after generation", async () => {
  const scratch = await tempBundle("built");
  try {
    const checkDrift = spawnSync("node", [cliBin, "index", "generate", "--check", "--dir", scratch.root], {
      encoding: "utf8",
    });
    assert.equal(checkDrift.status, 5);
    assert.match(checkDrift.stdout, /code: CONFLICT/);
    assert.match(checkDrift.stdout, /would_change: 1/);

    const generate = spawnSync("node", [cliBin, "index", "generate", "--dir", scratch.root, "--json"], {
      encoding: "utf8",
    });
    assert.equal(generate.status, 0, generate.stdout + generate.stderr);
    assert.equal(JSON.parse(generate.stdout).changed, true);

    const clean = spawnSync("node", [cliBin, "index", "generate", "--check", "--dir", scratch.root, "--json"], {
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(JSON.parse(clean.stdout).clean, true);
  } finally {
    await scratch.cleanup();
  }
});

test("path categories are defensively capped while preserving their total", async () => {
  const scratch = await tempBundle("many-targets");
  try {
    const bundle = { root: scratch.root };
    for (let index = 0; index < 18; index++) {
      await writeDoc(bundle, {
        id: `dir-${String(index).padStart(2, "0")}/item`,
        frontmatter: { type: "Note", timestamp: T },
        body: "",
      });
    }
    const generated = await runJson(["generate", "--dir", scratch.root]);
    assert.deepEqual(
      { shown: category(generated, "created").shown, total: category(generated, "created").total },
      { shown: 15, total: 18 },
    );
    assert.equal(category(generated, "created").rows.length, 15);
  } finally {
    await scratch.cleanup();
  }
});

test("index generate is local-only and rejects --remote at parse time", async () => {
  await assert.rejects(
    () => indexCommand(["generate", "--remote", "https://example.invalid"]),
    (error: unknown) => error instanceof CliError && error.code === "USAGE",
  );
});

test("recovery commands shell-quote explicit dirs and preserve force after an adoption preview", async () => {
  const scratch = await tempBundle("bundle with 'quote");
  try {
    const curated = "---\nokf_version: '0.1'\n---\n# Curated\n";
    await writeFile(path.join(scratch.root, "index.md"), curated);
    const preview = await expectConflict(["generate", "--check", "--force", "--dir", scratch.root]);
    const quoted = `'${scratch.root.replaceAll("'", "'\\''")}'`;
    assert.match(preview.help ?? "", /index generate --force --dir /);
    assert.ok(preview.help?.endsWith(quoted), `expected a shell-safe quoted path, got: ${preview.help}`);
    assert.equal(await readFile(path.join(scratch.root, "index.md"), "utf8"), curated, "preview remains read-only");
  } finally {
    await scratch.cleanup();
  }
});
