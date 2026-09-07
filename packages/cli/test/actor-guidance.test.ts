/**
 * Actor guidance through CLI-owned surfaces (tasks/guide-actor-spelling-in-cli): installed hosts
 * have no project instruction file we control, so the refusal, the help text, the orientation
 * line, and the shipped skill must each teach the OKF actor convention on their own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, readDoc, writeDoc } from "@superbee/core";

import { doc, type DocCliDeps } from "../src/commands/doc.js";
import { link } from "../src/commands/link.js";
import { artifact } from "../src/commands/artifact.js";
import { indexCommand } from "../src/commands/index.js";
import { recipe } from "../src/commands/recipe.js";
import { buildHomeView } from "../src/commands/home.js";
import { CliError } from "../src/errors.js";
import { renderNpm } from "../src/skill-render.js";
import { ACTOR_FORMS_HELP, actorRefusal, describeResolvedActor } from "../src/actor-guidance.js";
import { LEGACY_ACTOR_ENV } from "../src/env-policy.js";

async function bundle(okfVersion: "0.1" | "0.2"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), `superbee-actor-guidance-${okfVersion}-`));
  await initBundle(dir, { okfVersion });
  await writeDoc({ root: dir }, { id: "notes/a", frontmatter: { type: "Note", title: "A" }, body: "Body." });
  await writeDoc({ root: dir }, { id: "notes/b", frontmatter: { type: "Note", title: "B" }, body: "Body." });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runDoc(argv: string[], deps: Partial<DocCliDeps> = {}): Promise<Record<string, unknown>> {
  let out = "";
  await doc([...argv, "--json"], { stdout: (s) => (out += s), readStdin: async () => undefined, ...deps });
  return JSON.parse(out) as Record<string, unknown>;
}

async function expectRefusal(promise: Promise<unknown>): Promise<CliError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CliError, `expected a CliError, got ${String(caught)}`);
  assert.equal(caught.code, "USAGE", caught.message);
  return caught;
}

test("a refused actor names the corrected spelling and the once-only env fix, on every writing verb", async () => {
  const { dir, cleanup } = await bundle("0.2");
  try {
    const write = await expectRefusal(runDoc(["write", "notes/c", "--type", "Note", "--body", "x", "--actor", "codex-root", "--dir", dir]));
    assert.match(write.message, /'codex-root' is not an OKF actor/);
    assert.match(write.message, /process:codex-root/);
    assert.match(write.message, /human:codex-root/);
    assert.match(write.message, /human:<id> for a person/);
    assert.equal(write.help, "rerun with --actor process:codex-root, or set it once: export SUPERBEE_ACTOR=process:codex-root");
    assert.deepEqual(write.details, { actor: "codex-root" });

    const update = await expectRefusal(runDoc(["update", "notes/a", "--title", "T", "--actor", "openai/codex/root", "--dir", dir]));
    assert.match(update.message, /Use openai\/codex or process:codex-root/);
    assert.match(String(update.help), /--actor openai\/codex/);

    let linkOut = "";
    const linkErr = await expectRefusal(
      link(["add", "notes/a", "notes/b", "--actor", "claude-root", "--dir", dir, "--json"], { stdout: (s) => (linkOut += s) }),
    );
    assert.match(linkErr.message, /process:claude-root/);

    const verify = await expectRefusal(runDoc(["verify", "notes/a", "--actor", "brian", "--dir", dir]));
    assert.match(verify.message, /^verifier 'brian' is not an OKF actor/);
    assert.match(verify.message, /Use human:brian or process:brian/, "a verifier surface offers the human reading first");
    assert.match(verify.message, /Trust tiers key off the human: prefix/);
    assert.match(String(verify.help), /--actor human:brian/);

    // Nothing usable can be derived from punctuation: the help shows the forms, never a pasteable placeholder.
    const placeholder = await expectRefusal(runDoc(["write", "notes/c", "--type", "Note", "--body", "x", "--actor", "/", "--dir", dir]));
    assert.match(placeholder.message, /Use process:<id>, human:<id> or <producer>\/<version>/);
    assert.match(String(placeholder.help), /^rerun with --actor <actor> in one of those forms/);
    assert.doesNotMatch(String(placeholder.help), /'<id>'|process:<id>/);

    // Nothing was written by any refusal.
    for (const id of ["notes/a", "notes/b"]) {
      const after = await readDoc({ root: dir }, id);
      assert.equal(after.frontmatter.superbee_updated_by, undefined, id);
      assert.equal(after.frontmatter.verified, undefined, id);
    }
    await assert.rejects(readDoc({ root: dir }, "notes/c"));
  } finally {
    await cleanup();
  }
});

test("a v0.1 bundle still accepts a free-form actor (the grammar is a v0.2 provenance rule)", async () => {
  const { dir, cleanup } = await bundle("0.1");
  try {
    const receipt = await runDoc(["update", "notes/a", "--title", "T", "--actor", "codex-root", "--dir", dir]);
    assert.equal(receipt.changed, true);
    assert.equal((await readDoc({ root: dir }, "notes/a")).frontmatter.actor, "codex-root");
    // verify is v0.2-only: on v0.1 the edition is the reason given, not "this v0.2 bundle refuses".
    const verify = await expectRefusal(runDoc(["verify", "notes/a", "--actor", "codex-root", "--dir", dir]));
    assert.match(verify.message, /OKF 0\.1/);
    assert.doesNotMatch(verify.message, /this v0\.2 bundle refuses/);
  } finally {
    await cleanup();
  }
});

test("actorRefusal / describeResolvedActor: deterministic wording for the three states", () => {
  assert.deepEqual(actorRefusal("openai/codex/root", { env: {} }), {
    message:
      "actor 'openai/codex/root' is not an OKF actor, so this v0.2 bundle refuses to record it as provenance. "
      + "Use openai/codex or process:codex-root — human:<id> for a person, process:<id> for an automated job or a "
      + "role-specific agent session, or <producer>/<version> for an agent or tool (e.g. openai/codex, anthropic/claude).",
    help: "rerun with --actor openai/codex, or set it once: export SUPERBEE_ACTOR=openai/codex",
  });
  assert.deepEqual(describeResolvedActor({ kind: "value", actor: "anthropic/claude" }), { actor: "anthropic/claude" });
  const bad = describeResolvedActor({ kind: "value", actor: "codex-root" }, { env: {} });
  assert.equal(bad.actor, "codex-root");
  assert.match(String(bad.actor_help), /will be refused — use process:codex-root or human:codex-root: export SUPERBEE_ACTOR=process:codex-root$/);
  // When the bad value came from the legacy variable, the orientation hint must clear it too, and
  // the hint must WORK when pasted: execute its span from that env and check what follows sees.
  const legacyHint = String(describeResolvedActor({ kind: "value", actor: "codex-root" }, { env: { AGENTSTATE_LITE_ACTOR: "codex-root" } }).actor_help);
  assert.match(legacyHint, /export SUPERBEE_ACTOR=process:codex-root; unset AGENTSTATE_LITE_ACTOR$/);
  const hintSpan = legacyHint.slice(legacyHint.indexOf("export SUPERBEE_ACTOR="));
  const hinted = spawnSync("/bin/sh", ["-c", `${hintSpan}; printf '%s|%s' "$SUPERBEE_ACTOR" "\${AGENTSTATE_LITE_ACTOR-UNSET}"`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", AGENTSTATE_LITE_ACTOR: "codex-root" },
  });
  assert.equal(hinted.stdout, "process:codex-root|UNSET", "the pasted orientation hint leaves a usable environment");
  const unset = describeResolvedActor({ kind: "unset" }, { env: {} });
  assert.match(unset.actor, /^unset/);
  assert.match(String(unset.actor_help), /\(human:<id>.*\): export SUPERBEE_ACTOR=<actor>$/, "the span ends the line");
  const unusable = describeResolvedActor({ kind: "unusable", diagnostic: "SUPERBEE_ACTOR was given an empty value" });
  assert.equal(unusable.actor, "unusable environment value (writes will be refused)");
  assert.match(String(unusable.actor_help), /^SUPERBEE_ACTOR was given an empty value — human:<id>/);
  // The env repair also clears a legacy variable that would otherwise conflict with the fix.
  const combined = actorRefusal("codex-root", { env: { AGENTSTATE_LITE_ACTOR: "codex-root" } }).help;
  assert.equal(combined, "rerun with --actor process:codex-root, or set it once: export SUPERBEE_ACTOR=process:codex-root; unset AGENTSTATE_LITE_ACTOR");
  assert.doesNotMatch(actorRefusal("codex-root", { env: {} }).help, /AGENTSTATE_LITE_ACTOR/);
  // The repair must WORK when pasted, not merely read well: execute it in a POSIX shell that starts
  // with the conflicting legacy value and check what the next command would see.
  const repair = combined.slice(combined.indexOf("set it once: ") + "set it once: ".length);
  const shell = spawnSync("/bin/sh", ["-c", `${repair}; printf '%s|%s' "$SUPERBEE_ACTOR" "\${AGENTSTATE_LITE_ACTOR-UNSET}"`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", AGENTSTATE_LITE_ACTOR: "codex-root" },
  });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, "process:codex-root|UNSET", "after the pasted repair the fix is exported and the legacy variable is gone");
  assert.equal(LEGACY_ACTOR_ENV, "AGENTSTATE_LITE_ACTOR", "the guidance module spells the legacy variable as a literal to avoid an import cycle");
  const punct = describeResolvedActor({ kind: "value", actor: "///" }, { env: {} });
  assert.match(String(punct.actor_help), /set a real one \(human:<id>.*\): export SUPERBEE_ACTOR=<actor>$/);
  // The placeholder branch clears a legacy value too; with a real actor substituted, the span must
  // leave a usable environment (executed, not read).
  const punctLegacy = String(describeResolvedActor({ kind: "value", actor: "///" }, { env: { AGENTSTATE_LITE_ACTOR: "///" } }).actor_help);
  assert.match(punctLegacy, /export SUPERBEE_ACTOR=<actor>; unset AGENTSTATE_LITE_ACTOR$/, "the span ends the line so a whole-line paste works");
  const punctSpan = punctLegacy.slice(punctLegacy.indexOf("export SUPERBEE_ACTOR=")).replace("<actor>", "process:review");
  const punctRun = spawnSync("/bin/sh", ["-c", `${punctSpan}; printf '%s|%s' "$SUPERBEE_ACTOR" "\${AGENTSTATE_LITE_ACTOR-UNSET}"`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", AGENTSTATE_LITE_ACTOR: "///" },
  });
  assert.equal(punctRun.stdout, "process:review|UNSET");
  assert.match(ACTOR_FORMS_HELP, /human:<id>/);
});

test("home: the v0.2 bundle block shows the resolved actor and flags a refusable one; v0.1 shows nothing", () => {
  const summary = (okfVersion: string) => ({
    root: "/r",
    docs: 1,
    byType: { Note: 1 },
    recent: { shown: 1, total: 1, rows: [{ id: "notes/a", type: "Note", title: "A", timestamp: "" }] },
    okfVersion,
  });
  const deps = (env: NodeJS.ProcessEnv) => ({ binPath: () => "/bin/superbee", invocation: () => "superbee" as never, env });
  const good = buildHomeView(deps({ SUPERBEE_ACTOR: "openai/codex" }), summary("0.2") as never);
  assert.equal((good.bundle as Record<string, unknown>).actor, "openai/codex");
  assert.equal("actor_help" in (good.bundle as Record<string, unknown>), false);

  const bad = buildHomeView(deps({ SUPERBEE_ACTOR: "codex-root" }), summary("0.2") as never);
  assert.equal((bad.bundle as Record<string, unknown>).actor, "codex-root");
  assert.match(String((bad.bundle as Record<string, unknown>).actor_help), /export SUPERBEE_ACTOR=process:codex-root/);

  const legacy = buildHomeView(deps({ AGENTSTATE_LITE_ACTOR: "brian" }), summary("0.2") as never);
  assert.equal((legacy.bundle as Record<string, unknown>).actor, "brian");
  assert.match(String((legacy.bundle as Record<string, unknown>).actor_help), /; unset AGENTSTATE_LITE_ACTOR$/);

  const unset = buildHomeView(deps({}), summary("0.2") as never);
  assert.match(String((unset.bundle as Record<string, unknown>).actor), /^unset/);

  const blank = buildHomeView(deps({ SUPERBEE_ACTOR: "   " }), summary("0.2") as never);
  assert.equal((blank.bundle as Record<string, unknown>).actor, "unusable environment value (writes will be refused)", "a blank env value never crashes orientation, and is not reported as unset");
  assert.match(String((blank.bundle as Record<string, unknown>).actor_help), /SUPERBEE_ACTOR was given an empty value/);
  // The resolver's own diagnostic names the variable actually at fault, even beside a valid canonical value.
  const blankLegacy = buildHomeView(deps({ SUPERBEE_ACTOR: "human:a", AGENTSTATE_LITE_ACTOR: "" }), summary("0.2") as never);
  assert.equal((blankLegacy.bundle as Record<string, unknown>).actor, "unusable environment value (writes will be refused)");
  assert.match(String((blankLegacy.bundle as Record<string, unknown>).actor_help), /AGENTSTATE_LITE_ACTOR/);
  assert.doesNotMatch(String((blankLegacy.bundle as Record<string, unknown>).actor_help), /^SUPERBEE_ACTOR was given/);
  const conflict = buildHomeView(deps({ SUPERBEE_ACTOR: "human:a", AGENTSTATE_LITE_ACTOR: "human:b" }), summary("0.2") as never);
  assert.equal((conflict.bundle as Record<string, unknown>).actor, "unusable environment value (writes will be refused)");
  assert.match(String((conflict.bundle as Record<string, unknown>).actor_help), /different/);

  const v01 = buildHomeView(deps({ SUPERBEE_ACTOR: "codex-root" }), summary("0.1") as never);
  assert.equal("actor" in (v01.bundle as Record<string, unknown>), false);
});

test("the shipped skill and the --actor help lines carry the convention", async () => {
  const skill = renderNpm();
  assert.match(skill, /Writes carry an actor \(`--actor`\/`SUPERBEE_ACTOR`\)/);
  assert.match(skill, /`human:<id>`, `process:<id>`, or `<producer>\/<version>` \(e\.g\. `openai\/codex`\)/);
  assert.match(skill, /a bare name is refused with the fix/);
  for (const argv of [["write", "--help"], ["update", "--help"], ["verify", "--help"], ["open", "--help"]]) {
    let out = "";
    await doc(argv, { stdout: (s) => (out += s) });
    assert.match(out, /human:<id>/, argv.join(" "));
    assert.match(out, /<producer>\/<version>/, argv.join(" "));
  }
});

test("verbs whose first write is not the document mutation refuse BEFORE any write: artifact create, index generate, recipe evolve --apply", async () => {
  const { dir, cleanup } = await bundle("0.2");
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-actor-guidance-artifact-"));
  try {
    const html = path.join(scratch, "a.html");
    await writeFile(html, "<html>hi</html>", "utf8");
    const before = new Set(await readdir(dir));
    const indexBefore = await readFile(path.join(dir, "index.md"), "utf8");
    let out = "";
    const sink = { stdout: (s: string) => (out += s) };

    const created = await expectRefusal(artifact(["create", html, "--title", "A", "--actor", "agent:builder", "--dir", dir, "--json"], sink));
    assert.match(created.message, /'agent:builder' is not an OKF actor/);
    assert.match(String(created.help), /^rerun with --actor process:agent-builder/);
    assert.equal((await readdir(dir)).includes("artifacts"), false, "no blob is promoted before the actor is accepted");

    const generated = await expectRefusal(indexCommand(["generate", "--dir", dir, "--actor", "codex-root", "--json"], sink));
    assert.match(String(generated.help), /--actor process:codex-root/);
    assert.equal(await readFile(path.join(dir, "index.md"), "utf8"), indexBefore, "reserved index bytes untouched");

    const evolved = await expectRefusal(recipe(["evolve", "context-notes", "--apply", "not-a-token", "--actor", "codex-root", "--dir", dir, "--json"], sink));
    assert.equal(evolved.code, "USAGE", "a usage error with the fix, never CONFLICT");
    assert.match(String(evolved.help), /--actor process:codex-root/);

    assert.deepEqual(new Set(await readdir(dir)), before, "the bundle tree is unchanged after all three refusals");

    // v0.1 keeps free-form actors on the same verbs.
    const legacy = await mkdtemp(path.join(tmpdir(), "superbee-actor-guidance-v01-"));
    try {
      await initBundle(legacy, { okfVersion: "0.1" });
      await indexCommand(["generate", "--dir", legacy, "--actor", "codex-root", "--json"], sink);
    } finally {
      await rm(legacy, { recursive: true, force: true });
    }
  } finally {
    await cleanup();
    await rm(scratch, { recursive: true, force: true });
  }
});
