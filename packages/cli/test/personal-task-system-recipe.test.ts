import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  freshnessHorizonMs,
  initBundle,
  loadKinds,
  query,
  queryEdges,
  readBlob,
  readDoc,
  type KindConvention,
} from "@superbee/core";

import { kinds } from "../src/commands/kinds.js";
import { newCommand } from "../src/commands/new.js";
import { recipe } from "../src/commands/recipe.js";
import { CliError } from "../src/errors.js";
import { filesRecipeSource } from "../src/recipe-source.js";

const PERSONAL_TASK_SYSTEM_RECIPE = path.resolve(
  import.meta.dirname,
  "../../../examples/recipes/personal-task-system",
);
const CANONICAL_VIEW_CONVENTION = path.resolve(
  import.meta.dirname,
  "../../../examples/recipes/review-workflow/conventions/view.md",
);
const CANONICAL_VIEW_REFERENCE = path.resolve(
  import.meta.dirname,
  "../../../examples/recipes/review-workflow/references/view-authoring-v0.md",
);
const REVIEW_WORKFLOW_RECIPE = path.resolve(
  import.meta.dirname,
  "../../../examples/recipes/review-workflow",
);

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-personal-task-system-test-"));
}

async function runJson(
  command: (
    argv: string[],
    deps: { stdout: (value: string) => void; readStdin?: () => Promise<string | undefined> },
  ) => Promise<void>,
  argv: string[],
): Promise<Record<string, unknown>> {
  let output = "";
  await command([...argv, "--json"], {
    stdout: (value) => (output += value),
    readStdin: async () => undefined,
  });
  return JSON.parse(output) as Record<string, unknown>;
}

const TASK_STATUS_DESCRIPTIONS = {
  todo: "Ready to be worked but not yet started.",
  in_progress: "Someone is actively advancing the Task.",
  blocked: "The Task cannot proceed until a named dependency or condition changes.",
  done: "The intended work is complete.",
  canceled: "The Task was intentionally closed without completion.",
};

const TASK_PRIORITY_DESCRIPTIONS = {
  high: "Important or time-sensitive work that should be considered before ordinary Tasks.",
  medium: "Normal planned work without exceptional urgency.",
  low: "Optional or opportunistic work that may wait behind higher priorities.",
};

const PROJECT_STATUS_DESCRIPTIONS = {
  active: "The Project is currently being pursued.",
  paused: "Work is intentionally suspended but may resume.",
  archived: "The Project is no longer active and is retained for context.",
};

function expectedTaskKind(): KindConvention {
  return {
    id: "conventions/task",
    title: "Task",
    governs: "Task",
    description: "A discrete next action that a person or agent can prioritize, own, advance, block, and complete.",
    path: "tasks/",
    fields: {
      required: ["title", "status"],
      optional: ["priority", "assignee", "due"],
      values: {
        status: ["todo", "in_progress", "blocked", "done", "canceled"],
        priority: ["high", "medium", "low"],
      },
      valueDescriptions: {
        status: TASK_STATUS_DESCRIPTIONS,
        priority: TASK_PRIORITY_DESCRIPTIONS,
      },
      terminal: { status: ["done", "canceled"] },
      descriptions: {
        status: "Current lifecycle state of the work.",
        priority: "Relative importance; absence means unprioritized.",
        assignee: "Advisory identity responsible for the next action; not authentication or authorization.",
        due: "Target calendar date, authored as YYYY-MM-DD.",
      },
    },
    links: { "depends on": "Task", "part of": "Project" },
    linkDescriptions: {
      "depends on": "A prerequisite Task that should complete before this Task can proceed.",
      "part of": "The optional Project whose outcome this Task advances.",
    },
    freshnessHorizon: "30d",
  };
}

function expectedProjectKind(): KindConvention {
  return {
    id: "conventions/project",
    title: "Project",
    governs: "Project",
    description: "A durable outcome or body of work that groups related Tasks and preserves context across them.",
    path: "projects/",
    fields: {
      required: ["title", "status"],
      optional: ["description"],
      values: { status: ["active", "paused", "archived"] },
      valueDescriptions: { status: PROJECT_STATUS_DESCRIPTIONS },
      terminal: { status: ["archived"] },
      descriptions: {
        status: "Whether the Project is active work, intentionally paused, or archived.",
        description: "A concise statement of the Project's intended outcome or scope.",
      },
    },
    expectsInbound: { "part of": "Task" },
    freshnessHorizon: "180d",
  };
}

test("Personal Task System parses strictly and installs its kinds plus interactive board without instances", async () => {
  const loaded = await filesRecipeSource().resolve(PERSONAL_TASK_SYSTEM_RECIPE);
  assert.ok(loaded);
  assert.equal(loaded!.ok, true, loaded && !loaded.ok ? loaded.error.message : "");
  if (!loaded || !loaded.ok) return;
  assert.equal(loaded.recipe.contentPolicy, "definitions-only");
  assert.deepEqual(loaded.recipe.governs, ["Project", "Task", "View"]);
  assert.deepEqual(loaded.recipe.warnings, [], "definitions-only parsing rejects any convention warning");
  assert.equal(loaded.recipe.pages.length, 1);
  assert.equal(loaded.recipe.pages[0]!.registry.id, "views-registry/personal-task-system-board");
  assert.equal(loaded.recipe.pages[0]!.entry, "views/personal-task-system/board.html");
  assert.equal(loaded.recipe.references.length, 1);
  assert.equal(loaded.recipe.references[0]!.doc.id, "references/view-authoring-v0");
  assert.equal(
    await readFile(path.join(PERSONAL_TASK_SYSTEM_RECIPE, "conventions/view.md"), "utf8"),
    await readFile(CANONICAL_VIEW_CONVENTION, "utf8"),
    "View-bearing recipes must compose through one byte-identical View convention",
  );
  assert.equal(
    await readFile(path.join(PERSONAL_TASK_SYSTEM_RECIPE, "references/view-authoring-v0.md"), "utf8"),
    await readFile(CANONICAL_VIEW_REFERENCE, "utf8"),
    "View-bearing recipes must carry the same authoring contract their convention links",
  );

  const dir = await tempDir();
  try {
    await initBundle(dir);
    const receipt = await runJson(recipe, ["add", PERSONAL_TASK_SYSTEM_RECIPE, "--dir", dir]);
    assert.equal(receipt.id, "personal-task-system");
    assert.equal(receipt.changed, true);
    assert.deepEqual(
      (receipt.docs as Array<{ id: string }>).map(({ id }) => id),
      ["conventions/project", "conventions/task", "conventions/view"],
    );
    assert.deepEqual(receipt.pages, [
      {
        registry_id: "views-registry/personal-task-system-board",
        entry: "views/personal-task-system/board.html",
        registry_changed: true,
        entry_changed: true,
        changed: true,
      },
    ]);
    assert.deepEqual(receipt.references, [{ id: "references/view-authoring-v0", changed: true }]);

    const registry = await loadKinds({ root: dir });
    assert.deepEqual(registry.warnings, []);
    assert.equal(registry.kinds.size, 3);
    assert.deepEqual(registry.kinds.get("Task"), expectedTaskKind());
    assert.deepEqual(registry.kinds.get("Project"), expectedProjectKind());
    assert.equal(freshnessHorizonMs(registry.kinds.get("Task")!), 30 * 86_400_000);
    assert.equal(freshnessHorizonMs(registry.kinds.get("Project")!), 180 * 86_400_000);

    const projected = await runJson(kinds, ["--dir", dir]);
    const rows = projected.kinds as Array<Record<string, unknown>>;
    const task = rows.find((row) => row.governs === "Task")!;
    const project = rows.find((row) => row.governs === "Project")!;
    assert.deepEqual(task.value_descriptions, {
      status: TASK_STATUS_DESCRIPTIONS,
      priority: TASK_PRIORITY_DESCRIPTIONS,
    });
    assert.deepEqual(task.descriptions, expectedTaskKind().fields.descriptions);
    assert.deepEqual(task.links, expectedTaskKind().links);
    assert.deepEqual(task.link_descriptions, expectedTaskKind().linkDescriptions);
    assert.equal(task.horizon, "30d");
    assert.ok(!("sections" in task), "Task has no required body headings");
    assert.deepEqual(project.value_descriptions, { status: PROJECT_STATUS_DESCRIPTIONS });
    assert.deepEqual(project.descriptions, expectedProjectKind().fields.descriptions);
    assert.deepEqual(project.expects_inbound, { "part of": "Task" });
    assert.equal(project.horizon, "180d");
    assert.ok(!("sections" in project), "Project has no required body headings");

    assert.equal((await query({ root: dir }, { type: "Task" })).length, 0);
    assert.equal((await query({ root: dir }, { type: "Project" })).length, 0);
    const views = await query({ root: dir }, { type: "View" });
    assert.equal(views.length, 1);
    assert.equal(views[0]!.frontmatter.title, "Personal task board");
    assert.equal(views[0]!.frontmatter.entry, "views/personal-task-system/board.html");
    assert.equal(views[0]!.frontmatter.description, "Plan, filter, and safely update Tasks across Projects.");
    assert.equal(views[0]!.frontmatter.access, "bundle-propose");
    const html = await readBlob({ root: dir }, "views/personal-task-system/board.html");
    assert.ok(html);
    assert.match(Buffer.from(html.bytes).toString("utf8"), /Personal task board/);
    assert.match(Buffer.from(html.bytes).toString("utf8"), /document\.set-field/);

    const composed = await runJson(recipe, ["add", REVIEW_WORKFLOW_RECIPE, "--dir", dir]);
    assert.equal(composed.changed, true, "a second View-bearing recipe composes without convention/reference conflicts");
    const reapplied = await runJson(recipe, ["add", PERSONAL_TASK_SYSTEM_RECIPE, "--dir", dir]);
    assert.equal(reapplied.changed, false, "composition leaves the Personal Task System idempotent");
    assert.equal((await query({ root: dir }, { type: "View" })).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Personal Task System kinds strictly accept every v1 lifecycle shape and preserve optional grouping", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await runJson(recipe, ["add", PERSONAL_TASK_SYSTEM_RECIPE, "--dir", dir]);

    for (const status of ["active", "paused", "archived"]) {
      await runJson(newCommand, [
        "Project",
        status,
        "--title",
        `${status} project`,
        "--status",
        status,
        "--dir",
        dir,
      ]);
    }

    await runJson(newCommand, [
      "Task",
      "todo",
      "--title",
      "Todo task",
      "--status",
      "todo",
      "--priority",
      "high",
      "--dir",
      dir,
    ]);
    await runJson(newCommand, [
      "Task",
      "in-progress",
      "--title",
      "In-progress task",
      "--status",
      "in_progress",
      "--priority",
      "medium",
      "--link",
      "part of=projects/active",
      "--link",
      "depends on=tasks/todo",
      "--dir",
      dir,
    ]);
    await runJson(newCommand, [
      "Task",
      "blocked",
      "--title",
      "Blocked task",
      "--status",
      "blocked",
      "--priority",
      "low",
      "--dir",
      dir,
    ]);
    await runJson(newCommand, [
      "Task",
      "done",
      "--title",
      "Done task",
      "--status",
      "done",
      "--dir",
      dir,
    ]);
    await runJson(newCommand, [
      "Task",
      "canceled",
      "--title",
      "Canceled task",
      "--status",
      "canceled",
      "--assignee",
      "example-agent",
      "--due",
      "2026-08-01",
      "--dir",
      dir,
    ]);

    const tasks = await query({ root: dir }, { type: "Task" });
    assert.equal(tasks.length, 5);
    assert.deepEqual(
      tasks.map((doc) => doc.frontmatter.status).sort(),
      ["blocked", "canceled", "done", "in_progress", "todo"],
    );
    assert.equal((await readDoc({ root: dir }, "tasks/done")).frontmatter.priority, undefined);
    assert.equal((await readDoc({ root: dir }, "tasks/todo")).body.trim(), "", "Task capture requires no body headings");
    assert.equal((await readDoc({ root: dir }, "projects/active")).body.trim(), "", "Project capture requires no body headings");
    assert.equal((await queryEdges({ root: dir }, { from: "tasks/todo" })).length, 0, "a Task may have no Project");
    assert.deepEqual(
      (await queryEdges({ root: dir }, { from: "tasks/in-progress" })).map(({ text, to }) => ({ text, to })),
      [
        { text: "part of", to: "projects/active" },
        { text: "depends on", to: "tasks/todo" },
      ],
    );

    await assert.rejects(
      () =>
        newCommand(["Task", "bad-status", "--title", "Bad status", "--status", "queued", "--dir", dir], {
          stdout: () => {},
        }),
      (error: unknown) => error instanceof CliError && error.code === "USAGE" && /status/.test(error.message),
    );
    await assert.rejects(
      () =>
        newCommand(["Project", "bad-status", "--title", "Bad status", "--status", "done", "--dir", dir], {
          stdout: () => {},
        }),
      (error: unknown) => error instanceof CliError && error.code === "USAGE" && /status/.test(error.message),
    );
    await assert.rejects(
      () =>
        newCommand(
          ["Task", "private-field", "--title", "Unknown field", "--status", "todo", "--sensitivity", "private", "--dir", dir],
          { stdout: () => {} },
        ),
      (error: unknown) => error instanceof CliError && error.code === "USAGE" && /sensitivity/.test(error.message),
    );
    await assert.rejects(() => readFile(path.join(dir, "tasks", "bad-status.md")));
    await assert.rejects(() => readFile(path.join(dir, "projects", "bad-status.md")));
    await assert.rejects(() => readFile(path.join(dir, "tasks", "private-field.md")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
