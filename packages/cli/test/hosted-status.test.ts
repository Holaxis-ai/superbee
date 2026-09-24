// `superbee status` in a hosted checkout: a `sync` block read from local state only (unsent
// changes, conflicts, held items, the last pull and its staleness), with no request to the host
// and no automatic pull. The checkout is made against the stateful fake of the hosted sync routes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { parseMarkdown } from "@superbee/core";

import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import { checkout } from "../src/commands/checkout.js";
import { status } from "../src/commands/status.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { readFreshness } from "../src/hosted/freshness.js";
import { hostedCheckoutAt } from "../src/autopull.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
}

async function harness(): Promise<Harness> {
  const host = new FakeHost();
  const home = await mkdtemp(path.join(tmpdir(), "sb-status-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-status-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return { home, cwd, folder: path.join(cwd, "team"), auth, host };
}

interface SyncBlock {
  bundle_id: string;
  host: string;
  folder: string;
  state: string;
  unsent: number;
  unsent_ids?: string[];
  conflicts: number;
  conflict_ids?: string[];
  held_files: number;
  held_rows?: { id: string; reason: string }[];
  held_deletions: number;
  last_pull: string | null;
  since_pull: string;
  stale: boolean;
}

async function runStatus(h: Harness, now?: Date, extra: string[] = []): Promise<{ record: Record<string, unknown>; sync: SyncBlock; help: string[]; raw: string }> {
  const out: string[] = [];
  const requestsBefore = h.host.requests.length;
  await status(["--dir", h.folder, ...extra], {
    stdout: (text) => void out.push(text),
    autoPull: async () => assert.fail("status in a hosted checkout must not pull"),
    home: h.home,
    ...(now ? { now: () => now } : {}),
  });
  assert.equal(h.host.requests.length, requestsBefore, "status sends no request to the host");
  const raw = out.join("");
  const record = (extra.includes("--json") ? JSON.parse(raw) : decode(raw.trim())) as Record<string, unknown>;
  return { record, sync: record.sync as SyncBlock, help: (record.help as string[] | undefined) ?? [], raw };
}

async function edit(h: Harness, id: string, change: (doc: { frontmatter: Record<string, unknown>; body: string }) => void): Promise<void> {
  const file = path.join(h.folder, `${id}.md`);
  const parsed = parseMarkdown(await readFile(file, "utf8"), id);
  const doc = { frontmatter: { ...(parsed.frontmatter as Record<string, unknown>) }, body: parsed.body };
  change(doc);
  const yaml = Object.entries(doc.frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  await writeFile(file, `---\n${yaml}\n---\n${doc.body}`);
}

test("a fresh checkout is clean, pulled just now, not stale, and asks for nothing", async () => {
  const h = await harness();
  const { record, sync: block, help } = await runStatus(h);
  assert.equal(Object.keys(record)[0], "sync", "the sync block leads the report");
  assert.equal(block.bundle_id, BUNDLE);
  assert.equal(block.host, HOST);
  assert.equal(block.state, "clean");
  assert.equal(block.unsent, 0);
  assert.equal(block.conflicts, 0);
  assert.equal(block.held_files, 0);
  assert.equal(block.held_deletions, 0);
  assert.ok(!("unsent_ids" in block) && !("conflict_ids" in block));
  const binding = (await hostedCheckoutAt(h.folder, h.home))!;
  const pulled = (await readFreshness(h.home, binding.checkout_id)).pulled_at;
  assert.ok(pulled, "checkout records its pull");
  assert.equal(block.last_pull, pulled);
  assert.equal(block.since_pull, "0m");
  assert.equal(block.stale, false);
  assert.deepEqual(help, []);
  // The ordinary bundle report still follows.
  assert.equal(typeof record.docs, "number");
});

test("an edited file, a new file and a deleted file are unsent; help names sync", async () => {
  const h = await harness();
  await edit(h, "notes/alpha", (doc) => void (doc.body = "Alpha, edited locally.\n"));
  await writeFile(path.join(h.folder, "notes/zeta.md"), "---\ntype: Note\ntitle: Zeta\n---\nNew.\n");
  const { sync: block, help } = await runStatus(h);
  assert.equal(block.state, "unsent_changes");
  assert.equal(block.unsent, 2);
  assert.deepEqual(block.unsent_ids, ["notes/alpha", "notes/zeta"]);
  assert.equal(block.conflicts, 0);
  assert.deepEqual(help, [`${cliInvocation()} sync --dir ${h.folder}`]);

  // Removing the new file takes it off the list; deleting a document's file is an unsent delete.
  await unlink(path.join(h.folder, "notes/zeta.md"));
  await unlink(path.join(h.folder, "projects/2026/plan.md"));
  const after = await runStatus(h);
  assert.deepEqual(after.sync.unsent_ids, ["notes/alpha", "projects/2026/plan"]);
  assert.equal(after.sync.held_deletions, 0);
});

test("a non-document file is held, not unsent", async () => {
  const h = await harness();
  await writeFile(path.join(h.folder, "scratch.txt"), "not a document\n");
  const { sync: block, help } = await runStatus(h);
  assert.equal(block.state, "needs_decision");
  assert.equal(block.unsent, 0);
  assert.equal(block.held_files, 1);
  assert.deepEqual(block.held_rows, [{ id: "scratch.txt", reason: "not_a_document" }]);
  assert.deepEqual(help, [`${cliInvocation()} sync --dir ${h.folder}`]);
});

test("a document changed on both sides is a conflict; help names sync --inspect --doc <id>", async () => {
  const h = await harness();
  const before = h.host.docs.get("projects/2026/plan")!;
  h.host.put("projects/2026/plan", { ...before.frontmatter, status: "paused" }, before.body);
  await edit(h, "projects/2026/plan", (doc) => void (doc.frontmatter.title = "Plan, retitled"));
  try {
    await sync(["--dir", h.folder], {
      stdout: () => {},
      auth: h.auth,
      cwd: h.cwd,
      fetch: h.host.fetch,
      write: { sleep: async () => {}, lookupDelayMs: 0 },
      sleep: async () => {},
    });
    assert.fail("the sync reports the conflict");
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.code, "CONFLICT", error.message);
  }
  const { sync: block, help } = await runStatus(h);
  assert.equal(block.state, "needs_decision");
  assert.equal(block.conflicts, 1);
  assert.deepEqual(block.conflict_ids, ["projects/2026/plan"]);
  assert.equal(block.unsent, 0, "a conflict is not also counted as unsent");
  assert.deepEqual(help, [`${cliInvocation()} sync --inspect --doc projects/2026/plan --dir ${h.folder}`, `${cliInvocation()} sync --dir ${h.folder}`]);
});

test("the last pull's age and staleness follow the freshness threshold; --json carries the same block", async () => {
  const h = await harness();
  const binding = (await hostedCheckoutAt(h.folder, h.home))!;
  const pulledAt = Date.parse((await readFreshness(h.home, binding.checkout_id)).pulled_at!);

  const recent = await runStatus(h, new Date(pulledAt + 29 * 60_000));
  assert.equal(recent.sync.since_pull, "29m");
  assert.equal(recent.sync.stale, false);
  assert.deepEqual(recent.help, []);

  const old = await runStatus(h, new Date(pulledAt + 3 * 60 * 60_000));
  assert.equal(old.sync.since_pull, "3h");
  assert.equal(old.sync.stale, true);
  assert.equal(old.sync.state, "clean");
  assert.deepEqual(old.help, [`${cliInvocation()} sync --dir ${h.folder}`]);

  const json = await runStatus(h, new Date(pulledAt + 3 * 60 * 60_000), ["--json"]);
  assert.deepEqual(json.sync, old.sync);
});
