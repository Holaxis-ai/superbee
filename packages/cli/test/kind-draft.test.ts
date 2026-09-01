// `kind draft` / `kind dismiss` — agent-proposed Kinds, PR 1 (design: designs/agent-proposed-kinds).
//
// The deterministic adversarial probes the design's §7 requires ship here, in the same commit as
// the mechanic: the zero-debt apply-then-validate property probe (appendix O5, pinning that the
// inference predicates equal the validation predicates), the token-staleness refusal, the
// catalog-dismiss recipes-surface trace (O2/O3), the redraft-replaces-dismissal-prose assertion
// (O4), the `new` before/after-dismissal byte-identity (O6), and the apply-line bytes pin (O1).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CONVENTION_TYPE,
  initBundle,
  loadKinds,
  readDoc,
  validateAgainstKind,
  writeDoc,
  type Frontmatter,
} from "@superbee/core";
import { kind } from "../src/commands/kind.js";
import { newCommand } from "../src/commands/new.js";
import { recipes } from "../src/commands/recipes.js";
import { applyRecipe } from "../src/recipes.js";
import { resolveBuiltinSync } from "../src/recipe-source-builtin.js";
import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import { commandQuoted } from "../src/command-text.js";

async function tempBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-kind-draft-test-"));
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runKind(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await kind([...argv, "--json"], { stdout: (s: string) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

async function kindError(argv: string[]): Promise<CliError> {
  try {
    await kind([...argv, "--json"], { stdout: () => {} });
  } catch (error) {
    assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the command to throw");
}

async function seed(dir: string, id: string, frontmatter: Frontmatter, body = "content\n"): Promise<void> {
  await writeDoc({ root: dir }, { id, frontmatter, body });
}

// ── draft: inference + zero-debt property ─────────────────────────────────────

test("kind draft: infers required/optional/path/H1-sections; read-only; apply creates; zero warnings MEASURED (the O5 property probe)", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    for (let i = 0; i < 5; i += 1) {
      await seed(
        dir,
        `plans/p${i}`,
        { type: "Plan", title: `Plan ${i}`, ...(i < 3 ? { description: "d" } : {}) },
        "# Summary\n\nbody\n",
      );
    }
    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    assert.equal(plan.draft, "Plan");
    assert.equal(plan.instances, 5);
    assert.equal(plan.warnings_after_apply, 0);
    const candidate = plan.candidate as Record<string, unknown>;
    assert.deepEqual(candidate.required, ["title"]); // never type/superbee_updated_by
    assert.deepEqual(candidate.optional, ["description"]);
    assert.equal(candidate.path, "plans/");
    assert.deepEqual(candidate.sections, ["Summary"]); // H1-only, 100%-presence only
    const promotions = plan.promotions as Array<Record<string, unknown>>;
    const description = promotions.find((p) => (p.declaration as string).includes("description"));
    assert.deepEqual(description, {
      declaration: "field description (optional -> required)",
      present: "3/5",
      warnings_if_added: 2,
    });

    // Read-only: nothing governs Plan until --apply.
    assert.equal((await loadKinds({ root: dir })).kinds.get("Plan"), undefined);

    const token = plan.plan_token as string;
    assert.match(token, /^sha256:[0-9a-f]{64}$/);
    const applied = await runKind(["draft", "Plan", "--apply", token, "--dir", dir]);
    assert.equal(applied.applied, true);
    assert.equal(applied.convention, "conventions/plan");
    assert.equal(applied.warnings_after_apply, 0);

    // The load-bearing property: apply the draft, then validate EVERY instance — zero violations.
    const governing = (await loadKinds({ root: dir })).kinds.get("Plan");
    assert.ok(governing);
    for (let i = 0; i < 5; i += 1) {
      const doc = await readDoc({ root: dir }, `plans/p${i}`);
      assert.deepEqual(validateAgainstKind(doc, governing), [], doc.id);
    }
  } finally {
    await cleanup();
  }
});

test("kind draft: O1 apply-line bytes — --dir echo and the acceptance-gate comment are emitted verbatim", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "plans/only", { type: "Plan", title: "t" });
    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    assert.equal(
      plan.apply,
      `${cliInvocation()} kind draft ${commandQuoted("Plan")} --apply ${plan.plan_token as string} --dir ${dir}   # after the human accepts`,
    );
    assert.equal(
      plan.note,
      `apply creates the Kind as drafted; promotions are separate follow-ups via '${cliInvocation()} kind field ${commandQuoted("Plan")} add <name> --required'`,
    );
  } finally {
    await cleanup();
  }
});

test("kind draft: split path prefixes propose NO path — the split is the finding, not a tiebreak", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "plans/a", { type: "Plan", title: "a" });
    await seed(dir, "designs/b", { type: "Plan", title: "b" });
    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    assert.equal((plan.candidate as Record<string, unknown>).path, undefined);
  } finally {
    await cleanup();
  }
});

test("kind draft: O5 predicate pins — empty-string presence never becomes required; array values never yield an enum; enum gates hold", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    for (let i = 0; i < 10; i += 1) {
      await seed(dir, `runs/r${i}`, {
        type: "Run",
        title: `r${i}`,
        note: i === 0 ? "" : "x", // isPresent fails on one instance -> optional, never required
        blank: "", // isPresent fails everywhere -> appears nowhere
        tags: ["a"], // array-valued, 100% present -> required, but NEVER an enum (KIND_FIELD_ARITY trap)
        stage: i % 2 === 0 ? "one" : "two", // scalar, 100%, 2 distinct at 10 instances -> enum
        constant: "only", // 1 distinct value -> not an enum (template artifact)
      });
    }
    const plan = await runKind(["draft", "Run", "--dir", dir]);
    const candidate = plan.candidate as Record<string, unknown>;
    assert.deepEqual(candidate.required, ["constant", "stage", "tags", "title"]);
    assert.deepEqual(candidate.optional, ["note"]);
    assert.deepEqual(candidate.values, { stage: ["one", "two"] });
    assert.equal(plan.warnings_after_apply, 0);

    const applied = await runKind(["draft", "Run", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(applied.warnings_after_apply, 0);
    const governing = (await loadKinds({ root: dir })).kinds.get("Run")!;
    for (let i = 0; i < 10; i += 1) {
      assert.deepEqual(validateAgainstKind(await readDoc({ root: dir }, `runs/r${i}`), governing), []);
    }
  } finally {
    await cleanup();
  }
});

test("kind draft: no enum below 10 instances", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    for (let i = 0; i < 9; i += 1) {
      await seed(dir, `runs/r${i}`, { type: "Run", title: "t", stage: i % 2 === 0 ? "one" : "two" });
    }
    const plan = await runKind(["draft", "Run", "--dir", dir]);
    assert.equal((plan.candidate as Record<string, unknown>).values, undefined);
  } finally {
    await cleanup();
  }
});

// ── draft: token staleness + refusals ─────────────────────────────────────────

test("kind draft --apply: an instance write between draft and apply refuses STALE_HEAD with the literal re-draft command", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "plans/a", { type: "Plan", title: "a" });
    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    await seed(dir, "plans/b", { type: "Plan", title: "b" }); // the 2nd instance changes the stats
    const err = await kindError(["draft", "Plan", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(err.code, "STALE_HEAD");
    const details = err.details as Record<string, unknown>;
    assert.equal(details.expected_plan, plan.plan_token);
    assert.match(details.current_plan as string, /^sha256:/);
    assert.notEqual(details.current_plan, details.expected_plan);
    assert.equal(err.help, `${cliInvocation()} kind draft ${commandQuoted("Plan")} --dir ${dir}`);
  } finally {
    await cleanup();
  }
});

test("kind draft: refuses a declaration-bearing governed type and an instance-less type", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "plans/a", { type: "Plan", title: "a" });
    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    await runKind(["draft", "Plan", "--apply", plan.plan_token as string, "--dir", dir]);

    const governed = await kindError(["draft", "Plan", "--dir", dir]);
    assert.equal(governed.code, "USAGE");
    assert.match(governed.message, /already governed by 'conventions\/plan'/);

    const empty = await kindError(["draft", "Nothing Here", "--dir", dir]);
    assert.equal(empty.code, "USAGE");
    assert.match(empty.message, /no documents of type 'Nothing Here'/);
  } finally {
    await cleanup();
  }
});

test("kind draft/dismiss: cross-flag and missing-type USAGE rejections", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    assert.equal((await kindError(["draft", "--dir", dir])).code, "USAGE");
    assert.equal((await kindError(["dismiss", "X", "--apply", "sha256:0", "--dir", dir])).code, "USAGE");
    assert.equal((await kindError(["draft", "X", "--reason", "r", "--dir", dir])).code, "USAGE");
    assert.equal((await kindError(["draft", "X", "--required", "--dir", dir])).code, "USAGE");
    assert.equal((await kindError(["field", "X", "add", "f", "--apply", "sha256:0", "--dir", dir])).code, "USAGE");
  } finally {
    await cleanup();
  }
});

// ── dismiss: decline record + new-guard ───────────────────────────────────────

test("kind dismiss: writes a declaration-free convention; `new` fails byte-identically before and after (O6); re-dismiss is a no-op", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "research/a", { type: "Research", title: "a" });
    await seed(dir, "research/b", { type: "Research", title: "b" });

    const newError = async (): Promise<CliError> => {
      try {
        await newCommand(["Research", "research/c", "--title", "c", "--dir", dir, "--json"], { stdout: () => {} });
      } catch (error) {
        assert.ok(error instanceof CliError);
        return error;
      }
      assert.fail("expected new to refuse");
    };
    const before = await newError();

    const receipt = await runKind(["dismiss", "Research", "--reason", "research stays freeform", "--dir", dir]);
    assert.equal(receipt.dismissed, "Research");
    assert.equal(receipt.convention, "conventions/research");
    assert.equal(receipt.changed, true);
    assert.equal(receipt.reopen, `${cliInvocation()} kind draft ${commandQuoted("Research")} --dir ${dir}`);

    const doc = await readDoc({ root: dir }, "conventions/research");
    assert.equal(doc.frontmatter.type, CONVENTION_TYPE);
    assert.equal(doc.frontmatter.governs, "Research");
    assert.equal(doc.frontmatter.fields, undefined); // declaration-free by construction
    assert.match(doc.body, /research stays freeform/);
    assert.match(doc.body, /kind draft 'Research'/); // the priced reopen route (O3)

    // The registry sees it (the modeling gate's G1 suppression source)…
    const governing = (await loadKinds({ root: dir })).kinds.get("Research");
    assert.ok(governing);
    // …and it is validation-inert.
    assert.deepEqual(validateAgainstKind(await readDoc({ root: dir }, "research/a"), governing), []);

    // O6: `new Research` fails EXACTLY as it did before the dismissal.
    const after = await newError();
    assert.equal(after.code, before.code);
    assert.equal(after.message, before.message);
    assert.equal(after.help, before.help);

    const again = await runKind(["dismiss", "Research", "--dir", dir]);
    assert.equal(again.changed, false); // idempotent
  } finally {
    await cleanup();
  }
});

test("kind dismiss: the decline record carries NO engine clock, so its provenance does not depend on which command wrote it first", async () => {
  // Both writers target `conventions/<slug>` and the draft path PATCHES OVER a dismissal, so a
  // per-writer clock difference would make a convention's provenance depend on whether it was
  // dismissed first or drafted first. Reverting the opt-out at the dismiss site alone leaves every
  // other test green, which is why this one exists.
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "research/a", { type: "Research", title: "a" });
    await runKind(["dismiss", "Research", "--dir", dir]);
    const raw = await readFile(path.join(dir, "conventions", "research.md"), "utf8");
    assert.doesNotMatch(raw, /^generated:/m, `a dismissal record must carry no engine clock:\n${raw}`);
  } finally {
    await cleanup();
  }
});

test("kind dismiss: refuses a declaration-bearing governed type", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await applyRecipe({ root: dir }, resolveBuiltinSync("context-notes"));
    const err = await kindError(["dismiss", "Context Note", "--dir", dir]);
    assert.equal(err.code, "USAGE");
    assert.match(err.message, /governed by 'conventions\/context-note'/);
  } finally {
    await cleanup();
  }
});

// ── redraft over a dismissal (O4) ─────────────────────────────────────────────

test("kind draft: redrafts over a dismissal and REPLACES the decline prose — no 'Declined' text survives an accepted redraft", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "plans/a", { type: "Plan", title: "a" });
    await seed(dir, "plans/b", { type: "Plan", title: "b" });
    await runKind(["dismiss", "Plan", "--reason", "plans stay freeform", "--dir", dir]);

    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    assert.equal(plan.redrafts, "conventions/plan");
    const applied = await runKind(["draft", "Plan", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(applied.changed, true);

    const doc = await readDoc({ root: dir }, "conventions/plan");
    assert.doesNotMatch(doc.body, /[Dd]eclined/);
    assert.doesNotMatch(String(doc.frontmatter.description ?? ""), /[Dd]eclined/);
    assert.doesNotMatch(doc.body, /freeform/);
    assert.match(doc.body, /Drafted from 2 existing 'Plan' instances/);
    const governing = (await loadKinds({ root: dir })).kinds.get("Plan")!;
    assert.deepEqual(governing.fields.required, ["title"]);
  } finally {
    await cleanup();
  }
});

// ── catalog-covered types: dismiss + recipes surface + adoption forecast ──────

test("catalog dismiss of Task: recipes reports applied+drift with the command-free deliberate-drift help; recipe add leaves the record untouched", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "work/t1", { type: "Task", title: "t1" });
    await seed(dir, "work/t2", { type: "Task", title: "t2" });

    const receipt = await runKind(["dismiss", "Task", "--dir", dir]);
    assert.equal(receipt.convention, "conventions/task"); // deliberately the canonical id
    assert.equal(receipt.catalog, "work-tracking");
    const record = await readDoc({ root: dir }, "conventions/task");
    assert.match(record.body, /kind draft 'Task'/); // O3: the priced reopen names kind draft
    assert.match(record.body, /work-tracking/);

    // The recipes surface: applied (ids occupied) + drift (content is not the recipe's) + the
    // descriptive help clause, with NO fixing command anywhere near the flag (O2).
    let out = "";
    await recipes(["--dir", dir, "--json"], {
      stdout: (s: string) => (out += s),
    } as never);
    const listing = JSON.parse(out) as Record<string, unknown>;
    const rows = listing.recipes as Array<Record<string, unknown>>;
    const workTracking = rows.find((r) => r.name === "work-tracking")!;
    assert.equal(workTracking.applied, true);
    assert.equal(workTracking.drift, true);
    assert.equal(
      listing.drift_help,
      "drift can be deliberate — read the installed convention before treating it as a defect",
    );
    assert.doesNotMatch(listing.drift_help as string, /recipe (add|evolve)|kind (draft|field)/);

    // `recipe add work-tracking` after the dismissal: conflict path, record left untouched.
    const result = await applyRecipe({ root: dir }, resolveBuiltinSync("work-tracking"));
    const taskDoc = result.docs.find((d) => d.id === "conventions/task")!;
    assert.equal(taskDoc.changed, false);
    assert.equal(taskDoc.source_differs, true);
    assert.ok(result.warnings.some((w) => w.code === "RECIPE_SOURCE_DIFFERS"));
    assert.equal((await readDoc({ root: dir }, "conventions/task")).body, record.body);
  } finally {
    await cleanup();
  }
});

test("catalog draft of Task: adopts the builtin schema verbatim and MEASURES the real warning count before any write", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "work/t1", { type: "Task", title: "t1" });
    await seed(dir, "work/t2", { type: "Task", title: "t2" });
    await seed(dir, "work/t3", { type: "Task", title: "t3" });

    const plan = await runKind(["draft", "Task", "--dir", dir]);
    assert.equal(plan.catalog, "work-tracking");
    assert.equal((plan.candidate as Record<string, unknown>).convention, "conventions/task");
    // Hand-authored Tasks carry no workflow status: the adopted required field warns on all 3 —
    // the real, nonzero forecast `recipe add` could never show (AC5).
    assert.equal(plan.warnings_after_apply, 3);

    const applied = await runKind(["draft", "Task", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(applied.warnings_after_apply, 3);

    // The adopted convention IS the recipe source: applied flips true with NO drift.
    let out = "";
    await recipes(["--dir", dir, "--json"], { stdout: (s: string) => (out += s) } as never);
    const listing = JSON.parse(out) as Record<string, unknown>;
    const workTracking = (listing.recipes as Array<Record<string, unknown>>).find((r) => r.name === "work-tracking")!;
    assert.equal(workTracking.applied, true);
    assert.equal(workTracking.drift, undefined);
    assert.equal(listing.drift_help, undefined);
  } finally {
    await cleanup();
  }
});

test("catalog draft of a multi-convention recipe names the sibling it does not install", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "roadmaps/r1", { type: "Roadmap", title: "r1" });
    const plan = await runKind(["draft", "Roadmap", "--dir", dir]);
    assert.equal(plan.catalog, "roadmap");
    assert.match(plan.catalog_note as string, /Roadmap Item/);
    assert.match(plan.catalog_note as string, /recipe evolve roadmap/);
  } finally {
    await cleanup();
  }
});

test("recipes drift bit also flags a legitimately evolved kind (the documented false-positive shape) — descriptive, never a defect claim", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await applyRecipe({ root: dir }, resolveBuiltinSync("context-notes"));
    await runKind(["field", "Context Note", "add", "due", "--dir", dir]); // sanctioned evolution

    let out = "";
    await recipes(["--dir", dir, "--json"], { stdout: (s: string) => (out += s) } as never);
    const listing = JSON.parse(out) as Record<string, unknown>;
    const contextNotes = (listing.recipes as Array<Record<string, unknown>>).find((r) => r.name === "context-notes")!;
    assert.equal(contextNotes.applied, true);
    assert.equal(contextNotes.drift, true);
    assert.equal(
      listing.drift_help,
      "drift can be deliberate — read the installed convention before treating it as a defect",
    );
  } finally {
    await cleanup();
  }
});

test("recipes: a pristine applied recipe reports no drift and no drift_help (omitted-when-empty)", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await applyRecipe({ root: dir }, resolveBuiltinSync("context-notes"));
    let out = "";
    await recipes(["--dir", dir, "--json"], { stdout: (s: string) => (out += s) } as never);
    const listing = JSON.parse(out) as Record<string, unknown>;
    const contextNotes = (listing.recipes as Array<Record<string, unknown>>).find((r) => r.name === "context-notes")!;
    assert.equal(contextNotes.applied, true);
    assert.equal(contextNotes.drift, undefined);
    assert.equal(listing.drift_help, undefined);
  } finally {
    await cleanup();
  }
});

test("kind draft: redraft over a hand-authored governs-only convention at a NON-canonical id patches THAT id in place (review F3)", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "memos/m1", { type: "Memo", title: "m1" });
    await seed(dir, "memos/m2", { type: "Memo", title: "m2" });
    // A human's own governs-only record, deliberately NOT at conventions/memo.
    await seed(
      dir,
      "conventions/weird-memo-record",
      { type: CONVENTION_TYPE, title: "Memo", governs: "Memo" },
      "governs-only, grown later\n",
    );

    const plan = await runKind(["draft", "Memo", "--dir", dir]);
    assert.equal(plan.redrafts, "conventions/weird-memo-record");
    assert.equal((plan.candidate as Record<string, unknown>).convention, "conventions/weird-memo-record");
    const applied = await runKind(["draft", "Memo", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(applied.convention, "conventions/weird-memo-record");
    assert.equal(applied.changed, true);

    // The upgrade landed IN PLACE: no second convention was minted at the slug id.
    await assert.rejects(readDoc({ root: dir }, "conventions/memo"));
    const governing = (await loadKinds({ root: dir })).kinds.get("Memo")!;
    assert.equal(governing.id, "conventions/weird-memo-record");
    assert.deepEqual(governing.fields.required, ["title"]);
  } finally {
    await cleanup();
  }
});

test("kind draft --apply: a slug collision with a convention governing a DIFFERENT type refuses without claiming governance (review F2)", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    // 'Task!' kebab-slugs to conventions/task, which a convention governing plain 'Task' occupies.
    await seed(dir, "work/t1", { type: "Task!", title: "t1" });
    await seed(
      dir,
      "conventions/task",
      { type: CONVENTION_TYPE, title: "Task", governs: "Task", fields: { required: ["title"] } },
      "the real Task kind\n",
    );
    const plan = await runKind(["draft", "Task!", "--dir", dir]);
    assert.equal((plan.candidate as Record<string, unknown>).convention, "conventions/task");
    const err = await kindError(["draft", "Task!", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(err.code, "ALREADY_EXISTS");
    assert.doesNotMatch(err.message, /now governed/); // no governance claim without evidence
    assert.match(err.message, /occupied by a convention governing a different type/);
    assert.match(err.message, /nothing was written/);
    assert.equal((await readDoc({ root: dir }, "conventions/task")).body, "the real Task kind\n");
  } finally {
    await cleanup();
  }
});

test("hostile type name: every emitted command renders the type through the quoting authority as ONE shell-safe token, slugging stays sane, and draft/dismiss work end-to-end", async () => {
  const { dir, cleanup } = await tempBundle();
  const hostile = 'x"; touch /tmp/pwned; "';
  try {
    await seed(dir, "attack/a1", { type: hostile, title: "a1" });
    await seed(dir, "attack/a2", { type: hostile, title: "a2" });

    // Draft end-to-end: the apply line's type token is exactly commandQuoted(hostile) — never the raw
    // name inside double quotes, which a shared-board writer could turn into command injection.
    const plan = await runKind(["draft", hostile, "--dir", dir]);
    const applyLine = plan.apply as string;
    assert.ok(applyLine.includes(`kind draft ${commandQuoted(hostile)} --apply `), applyLine);
    assert.ok(!applyLine.includes(`draft "${hostile}"`), "raw double-quoted type must never be emitted");
    // The kebab slug collapses quotes/spaces/punctuation to hyphenated alphanumerics — non-explosive.
    assert.equal((plan.candidate as Record<string, unknown>).convention, "conventions/x-touch-tmp-pwned");
    const applied = await runKind(["draft", hostile, "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(applied.applied, true);
    assert.equal(applied.warnings_after_apply, 0);

    // Staleness help on a hostile type is likewise a safe token.
    await seed(dir, "attack2/b1", { type: 'y"; rm -rf ~; "', title: "b1" });
    const plan2 = await runKind(["draft", 'y"; rm -rf ~; "', "--dir", dir]);
    await seed(dir, "attack2/b2", { type: 'y"; rm -rf ~; "', title: "b2" });
    const stale = await kindError(["draft", 'y"; rm -rf ~; "', "--apply", plan2.plan_token as string, "--dir", dir]);
    assert.equal(stale.help, `${cliInvocation()} kind draft ${commandQuoted('y"; rm -rf ~; "')} --dir ${dir}`);

    // Dismiss end-to-end: receipt and record body carry only the safe token.
    const dismissed = await runKind(["dismiss", 'y"; rm -rf ~; "', "--dir", dir]);
    assert.equal(dismissed.convention, "conventions/y-rm-rf");
    assert.equal(dismissed.reopen, `${cliInvocation()} kind draft ${commandQuoted('y"; rm -rf ~; "')} --dir ${dir}`);
    const record = await readDoc({ root: dir }, "conventions/y-rm-rf");
    assert.ok(record.body.includes(`kind draft ${commandQuoted('y"; rm -rf ~; "')}`));
    assert.ok(!record.body.includes('kind draft "y'), "raw double-quoted type must never reach the record body");
  } finally {
    await cleanup();
  }
});

test("kind draft --apply: a concurrently created convention refuses ALREADY_EXISTS and never clobbers it", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await seed(dir, "plans/a", { type: "Plan", title: "a" });
    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    // A concurrent writer lands a convention at the same id WITHOUT changing Plan instances
    // (the token binds instance stats + candidate, so it still matches; create-only is the
    // last line of defense and must refuse without clobbering).
    await seed(
      dir,
      "conventions/plan",
      { type: CONVENTION_TYPE, title: "Plan", governs: "Other" },
      "someone else's convention\n",
    );
    const err = await kindError(["draft", "Plan", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(err.code, "ALREADY_EXISTS");
    assert.match(err.message, /created concurrently/);
    assert.equal((await readDoc({ root: dir }, "conventions/plan")).body, "someone else's convention\n");
  } finally {
    await cleanup();
  }
});
