import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { qualifiedArtifactDigest } from "@superbee/core/qualified-filesystem";

const cli = fileURLToPath(
  new URL("../../superbee/dist/superbee.mjs", import.meta.url),
);
test("built CLI discovers exact selectors, authors both schemas and refuses unported routes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qualified-cli-"));
  const dir = path.join(root, "bundle");
  const actor = "openai/codex";
  const run = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SUPERBEE_NO_AUTOPULL: "1",
        SUPERBEE_NO_UPDATE_CHECK: "1",
      },
    });
    assert.equal(
      result.status,
      expected,
      `${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
    return result.stdout;
  };
  const json = (name: string, value: unknown) => {
    const file = path.join(root, name + ".json");
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  try {
    assert.match(run(["qualified", "--help"]), /independently/);
    run(["qualified", "init", "--dir", dir, "--actor", actor]);
    for (const [repository_id, field] of [
      ["100", "votes"],
      ["200", "cost"],
    ]) {
      const artifact = {
        format: "superbee-recipe/v2" as const,
        identity: {
          authority: "github.com" as const,
          repository_id: repository_id!,
          recipe_id: "decisions",
        },
        release: "1.0.0",
        commit: "a".repeat(40),
        owner_id: repository_id!,
        kinds: [
          {
            kind_id: "decision",
            doc: {
              id: "conventions/decision",
              frontmatter: {
                type: "Convention",
                governs: "Decision",
                fields: { required: [field!] },
              },
              body: "",
            },
          },
        ],
      };
      const approval = {
        repository_id,
        owner_id: repository_id,
        release: artifact.release,
        commit: artifact.commit,
        source_revision: qualifiedArtifactDigest(artifact),
        actor,
        approved_at: "2026-11-13T12:00:00Z",
      };
      const draftPath = path.join(root, `approval-${repository_id}.json`);
      const inspection = JSON.parse(
        run([
          "qualified",
          "inspect",
          "--input",
          json("artifact", artifact),
          "--actor",
          actor,
          "--out",
          draftPath,
        ]),
      );
      assert.match(inspection.source_verification, /unverified/);
      assert.equal(
        inspection.approval_draft.source_revision,
        approval.source_revision,
      );
      run([
        "qualified",
        "install",
        "--dir",
        dir,
        "--input",
        json("artifact", artifact),
        "--approval",
        draftPath,
      ]);
    }
    const kinds = JSON.parse(run(["qualified", "kinds", "--dir", dir]));
    assert.equal(kinds.length, 2);
    for (const [index, kind] of kinds.entries())
      run([
        "qualified",
        "new",
        "--dir",
        dir,
        "--input",
        json("record", {
          id: `decisions/${index}`,
          selector: kind.selector,
          fields: { [kind.required[0]]: 1 },
        }),
        "--actor",
        actor,
      ]);
    const read = JSON.parse(
      run(["qualified", "read", "--dir", dir, "--id", "decisions/0"]),
    );
    run([
      "qualified",
      "update",
      "--dir",
      dir,
      "--actor",
      actor,
      "--input",
      json("patch", {
        id: "decisions/0",
        expectedVersion: read.version,
        fields: { [kinds[0].required[0]]: 2 },
      }),
    ]);
    assert.equal(
      JSON.parse(
        run([
          "qualified",
          "list",
          "--dir",
          dir,
          "--selector",
          kinds[0].selector,
        ]),
      ).length,
      1,
    );
    const portable = path.join(root, "portable.json");
    run(["qualified", "export", "--dir", dir, "--out", portable]);
    const copy = path.join(root, "copy");
    run(["qualified", "import", "--dir", copy, "--input", portable]);
    assert.equal(
      JSON.parse(run(["qualified", "list", "--dir", copy])).length,
      2,
    );
    for (const operation of [
      "status",
      "list",
      "kinds",
      "sync",
      "publish",
      "delete",
      "recipe",
    ])
      assert.match(
        run([operation, "--dir", dir], 2),
        /Qualified bundle does not support/,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("built CLI discovers and authors exact question/options receipts without hashes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qualified-links-cli-"));
  const dir = path.join(root, "bundle");
  const run = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, [cli, "qualified", ...args], {
      encoding: "utf8", env: { ...process.env, SUPERBEE_NO_AUTOPULL: "1", SUPERBEE_NO_UPDATE_CHECK: "1" },
    });
    assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return expected === 0 ? JSON.parse(result.stdout) : result.stdout;
  };
  const json = (name: string, data: unknown) => {
    const file = path.join(root, name + ".json");
    writeFileSync(file, JSON.stringify(data));
    return file;
  };
  try {
    run(["init", "--dir", dir, "--actor", "openai/codex"]);
    const artifact = JSON.parse(readFileSync(new URL("../../../examples/qualified-decision-recipe.json", import.meta.url), "utf8"));
    for (const publisher of ["100", "200"]) {
      artifact.identity.repository_id = publisher;
      artifact.owner_id = publisher;
      const input = json("recipe", artifact);
      const approval = path.join(root, `approval-${publisher}.json`);
      run(["inspect", "--input", input, "--actor", "openai/codex", "--out", approval]);
      run(["install", "--dir", dir, "--input", input, "--approval", approval]);
    }
    const kinds = run(["kinds", "--dir", dir]);
    const select = (publisher: string, label: string) => kinds.find((k: any) => k.identity.repository_id === publisher && k.label === label);
    const create = (id: string, selector: string, body = "", expected = 0) => run(["new", "--dir", dir, "--actor", "openai/codex", "--input", json("record", {id, selector, fields: {title: id}, body})], expected);
    for (const publisher of ["100", "200"]) {
      create(`questions/${publisher}`, select(publisher, "Question").selector);
      create(`options/${publisher}`, select(publisher, "Option").selector, `[question](../questions/${publisher}.md)`);
      create(`decisions/${publisher}`, select(publisher, "Decision").selector, `[question](../questions/${publisher}.md)\n[options](../options/${publisher}.md)`);
    }
    assert.equal(select("100", "Decision").relationships.question.targets[0].selector, select("100", "Question").selector);
    create("decisions/wrong", select("100", "Decision").selector, "[question](../questions/200.md)", 2);
    assert.equal(run(["list", "--dir", dir, "--selector", select("100", "Decision").selector]).length, 1);
    const out = path.join(root, "portable.json");
    run(["export", "--dir", dir, "--out", out]);
    run(["import", "--dir", path.join(root, "copy"), "--input", out]);
    assert.equal(run(["list", "--dir", path.join(root, "copy")]).length, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
