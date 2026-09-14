/**
 * `kind draft --apply` over a dismissal record is a declared whole-body replace (design appendix
 * O4): the verb passes `bodyReplace: { replaceLinks: true }` to the mutation seam, so the link-drop
 * guard does not refuse it. A permitted drop must not be a silent one — the receipt names every
 * outbound link the dismissal record carried that the accepted schema's body does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, parseLinks, readDoc, writeDoc } from "@superbee/core";
import { kind } from "../src/commands/kind.js";
import { link } from "../src/commands/link.js";

async function tempBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-redraft-posture-"));
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runKind(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await kind([...argv, "--json"], { stdout: (s: string) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

async function dismissedPlanWithInstances(dir: string): Promise<void> {
  await writeDoc({ root: dir }, { id: "plans/a", frontmatter: { type: "Plan", title: "a" }, body: "content\n" });
  await writeDoc({ root: dir }, { id: "plans/b", frontmatter: { type: "Plan", title: "b" }, body: "content\n" });
  await runKind(["dismiss", "Plan", "--reason", "plans stay freeform", "--dir", dir]);
}

test("kind draft --apply: a redraft over a dismissal record that carries an outbound link drops it by declared posture AND discloses it on the receipt", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await dismissedPlanWithInstances(dir);
    // An ordinary follow-up the dismissal prose invites: cite why the kind was declined.
    await writeDoc({ root: dir }, { id: "docs/rationale", frontmatter: { type: "Note", title: "Why plans stay freeform" }, body: "Because.\n" });
    let linkOut = "";
    await link(["add", "conventions/plan", "docs/rationale", "--dir", dir, "--json"], { stdout: (s: string) => (linkOut += s) });
    assert.equal((JSON.parse(linkOut) as Record<string, unknown>).changed, true);
    const carried = parseLinks({ root: dir }, await readDoc({ root: dir }, "conventions/plan"));
    assert.equal(carried.length, 1);

    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    assert.equal(plan.redrafts, "conventions/plan");
    const applied = await runKind(["draft", "Plan", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(applied.changed, true);
    // The seam did not refuse (declared posture), and the receipt says exactly what went.
    assert.deepEqual(applied.dropped_links, [{ to: carried[0]!.to, text: carried[0]!.text }]);
    assert.equal(parseLinks({ root: dir }, await readDoc({ root: dir }, "conventions/plan")).length, 0);
  } finally {
    await cleanup();
  }
});

test("kind draft --apply: a redraft over a link-free dismissal record carries no dropped_links key", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await dismissedPlanWithInstances(dir);
    const plan = await runKind(["draft", "Plan", "--dir", dir]);
    const applied = await runKind(["draft", "Plan", "--apply", plan.plan_token as string, "--dir", dir]);
    assert.equal(applied.changed, true);
    assert.equal(applied.dropped_links, undefined);
  } finally {
    await cleanup();
  }
});
