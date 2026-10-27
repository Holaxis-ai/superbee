/**
 * `doc import`: the plan, `--apply <token>` and `--resume <record>` flow over core's document
 * transfer, its AXI output shape and its exit codes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, readDoc, TransferInterrupted, VersionConflict, writeDoc, type Bundle } from "@superbee/core";

import { doc } from "../src/commands/doc.js";
import { CliError, cliErrorFromTransfer, EXIT } from "../src/errors.js";
import { folderIdentity, indexCheckoutPath, writeBinding } from "../src/hosted/binding.js";
import { BUILT_COMMAND, commandEnv } from "./support/command-batch.js";

interface Fixture {
  root: string;
  home: string;
  source: Bundle;
  target: Bundle;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superbee-doc-import-")));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const source = await initBundle(path.join(root, "wave"), { okfVersion: "0.2" });
  const target = await initBundle(path.join(root, "board"), { okfVersion: "0.2" });
  await writeDoc(source, { id: "docs/bundle", frontmatter: { type: "Bundle Name", title: "Wave", bundle_id: "wave-bundle" }, body: "" });
  await writeDoc(source, { id: "themes/a", frontmatter: { type: "Theme", title: "A" }, body: "See [b](b.md), [f](../findings/f1.md) and [site](https://example.com).\n" });
  await writeDoc(source, { id: "themes/b", frontmatter: { type: "Theme", title: "B" }, body: "Back to [a](a.md).\n" });
  await writeDoc(source, { id: "findings/f1", frontmatter: { type: "Finding", title: "F1" }, body: "Evidence.\n" });
  await writeDoc(target, { id: "docs/bundle", frontmatter: { type: "Bundle Name", title: "Board", bundle_id: "board-bundle" }, body: "" });
  await writeDoc(target, {
    id: "docs/dependencies",
    frontmatter: { type: "Bundle Dependencies", title: "Dependencies", dependencies: { wave: { bundle_id: "wave-bundle" } } },
    body: "",
  });
  return { root, home, source, target, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function baseArgs(fx: Fixture, extra: string[] = []): string[] {
  return ["import", "--from", "wave", "--with", `wave=${fx.source.root}`, "--select", "type=Theme", "--prefix", "imp",
    "--actor", "process:import-test", "--dir", fx.target.root, ...extra];
}

async function run(fx: Fixture, argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await doc([...argv, "--json"], { stdout: (s) => (out += s), home: fx.home } as Parameters<typeof doc>[1]);
  return JSON.parse(out) as Record<string, unknown>;
}

async function refusal(fx: Fixture, argv: string[]): Promise<CliError> {
  try {
    await run(fx, argv);
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail(`expected ${argv.join(" ")} to fail`);
}

test("plan output: keys in order, counts, untouched links and an exact apply command", async () => {
  const fx = await makeFixture();
  try {
    const plan = await run(fx, baseArgs(fx));
    assert.deepEqual(Object.keys(plan), ["import", "from", "documents", "links", "left_behind", "entries", "untouched_links", "record", "ready", "plan_token", "help"]);
    assert.equal(plan.import, "plan");
    assert.deepEqual(plan.from, { alias: "wave", bundle_id: "wave-bundle", label: fx.source.root });
    assert.equal(plan.documents, 2);
    assert.deepEqual(plan.links, { local: 2, qualified: 1, dequalified: 0, unchanged: 1, dangling_in_source: 0 });
    assert.deepEqual(plan.left_behind, { Finding: 1 });
    assert.deepEqual(plan.untouched_links, { shown: 1, total: 1, rows: [{ source: "themes/a", href: "https://example.com", reason: "external" }] });
    assert.equal(plan.ready, true);
    const help = plan.help as string[];
    assert.match(help[0]!, new RegExp(`--apply ${String(plan.plan_token).replace(/[/.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(help[0]!, /--select type=Theme --prefix imp/);
    assert.equal(existsSync(path.join(fx.target.root, "imp")), false, "planning writes nothing");

    const capped = await run(fx, baseArgs(fx, ["--limit", "1"]));
    assert.deepEqual({ shown: (capped.entries as { shown: number }).shown, total: (capped.entries as { total: number }).total }, { shown: 1, total: 2 });
    assert.match((capped.help as string[]).at(-1)!, /--limit 0 .*# every row/);
  } finally { await fx.cleanup(); }
});

test("apply writes create-only, re-applying the same token is a no-op, and a stale token exits 5", async () => {
  const fx = await makeFixture();
  try {
    const plan = await run(fx, baseArgs(fx));
    const token = String(plan.plan_token);
    const applied = await run(fx, baseArgs(fx, ["--apply", token]));
    assert.equal(applied.import, "applied");
    assert.equal(applied.changed, true);
    assert.equal(applied.documents, 2);
    assert.deepEqual(applied.record, { ...(applied.record as object), id: (plan.record as { id: string }).id, state: "applied" });
    const a = await readDoc(fx.target, "imp/themes/a");
    assert.equal(a.body, "See [b](b.md), [f](okf://wave/findings/f1.md) and [site](https://example.com).\n");
    assert.equal(a.frontmatter.superbee_updated_by, "process:import-test");

    const again = await run(fx, baseArgs(fx, ["--apply", token]));
    assert.equal(again.changed, false);

    const conflicted = await run(fx, baseArgs(fx));
    assert.equal(conflicted.ready, false, "a plan with conflicts still exits 0");
    assert.ok(((conflicted.conflicts as { rows: Array<{ code: string }> }).rows).some((row) => row.code === "target_exists"));

    const other = await refusal(fx, baseArgs(fx, ["--prefix", "other", "--apply", token]));
    assert.equal(other.code, "TRANSFER_PLAN_CHANGED");
    assert.equal(other.exitCode, EXIT.CONFLICT);
    assert.match(other.help ?? "", /doc import --from wave/);
  } finally { await fx.cleanup(); }
});

test("apply against a plan with conflicts is TRANSFER_CONFLICT and writes nothing", async () => {
  const fx = await makeFixture();
  try {
    const plan = await run(fx, baseArgs(fx));
    await writeDoc(fx.target, { id: "imp/themes/b", frontmatter: { type: "Theme", title: "occupied" }, body: "" });
    const error = await refusal(fx, baseArgs(fx, ["--apply", String(plan.plan_token)]));
    assert.equal(error.code, "TRANSFER_CONFLICT");
    assert.equal(error.exitCode, EXIT.CONFLICT);
    assert.equal(existsSync(path.join(fx.target.root, "imp", "themes", "a.md")), false);
  } finally { await fx.cleanup(); }
});

test("usage refusals: --remote, missing --from, undeclared or unbound alias, bad --select, --resume extras", async () => {
  const fx = await makeFixture();
  try {
    for (const [argv, pattern] of [
      [baseArgs(fx, ["--remote", "http://127.0.0.1:9"]), /--remote is not supported/],
      [["import", "--dir", fx.target.root], /requires --from/],
      [["import", "--from", "nope", "--with", `nope=${fx.source.root}`, "--dir", fx.target.root], /not declared/],
      [["import", "--from", "wave", "--select", "type=Theme", "--dir", fx.target.root], /no copy of 'wave' is bound/],
      [baseArgs(fx, ["--select", "kind=Theme"]), /--select expects/],
      [["import", "--from", "wave", "--with", `wave=${fx.source.root}`, "--resume", "promotions/x", "--select", "type=Theme", "--dir", fx.target.root], /--resume takes only/],
    ] as const) {
      const error = await refusal(fx, [...argv]);
      assert.equal(error.exitCode, EXIT.USAGE, `${argv.join(" ")}: ${error.message}`);
      assert.match(error.message, pattern);
    }
  } finally { await fx.cleanup(); }
});

test("a hosted checkout target is refused with USAGE before any dependency read", async () => {
  const fx = await makeFixture();
  try {
    const canonical = await realpath(fx.target.root);
    const binding = {
      schema: 1 as const,
      checkout_id: "22222222-2222-2222-2222-222222222222",
      path: canonical,
      origin: "https://example.invalid",
      audience: "https://example.invalid/mcp",
      routes: "/sync/v1",
      workspace: null,
      workspaces: [],
      bundle_id: "board-bundle",
      principal_id: "fixture",
      created_at: "2026-10-20T00:00:00Z",
      state: "ready" as const,
      folder_identity: (await folderIdentity(fx.target.root))!,
    };
    await writeBinding(fx.home, binding);
    await indexCheckoutPath(fx.home, binding);
    const error = await refusal(fx, baseArgs(fx));
    assert.equal(error.code, "USAGE");
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /this folder is a hosted checkout/);
    assert.equal(existsSync(path.join(fx.target.root, "imp")), false);
  } finally { await fx.cleanup(); }
});

test("a bound copy with the wrong identity plans as not ready and refuses to apply", async () => {
  const fx = await makeFixture();
  try {
    await writeDoc(fx.source, { id: "docs/bundle", frontmatter: { type: "Bundle Name", title: "Wave", bundle_id: "imposter" }, body: "" });
    const plan = await run(fx, baseArgs(fx));
    assert.equal(plan.ready, false);
    assert.equal(((plan.conflicts as { rows: Array<{ code: string }> }).rows)[0]!.code, "alias_identity");
    assert.match((plan.help as string[])[0]!, /^fix the first conflict \(alias_identity/);
    const error = await refusal(fx, baseArgs(fx, ["--apply", "document-transfer/v1:sha256:00"]));
    assert.equal(error.code, "TRANSFER_CONFLICT");
  } finally { await fx.cleanup(); }
});

test("resume finishes an applying record, is idempotent, and a missing record exits 6", async () => {
  const fx = await makeFixture();
  try {
    const plan = await run(fx, baseArgs(fx));
    await run(fx, baseArgs(fx, ["--apply", String(plan.plan_token)]));
    const recordId = (plan.record as { id: string }).id;
    // Simulate a crash after the first document: the record is back at applying and one target is absent.
    const recordPath = path.join(fx.target.root, `${recordId}.md`);
    await writeFile(recordPath, (await readFile(recordPath, "utf8")).replace("promotion_state: applied", "promotion_state: applying"));
    await rm(path.join(fx.target.root, "imp", "themes", "b.md"));
    const resumeArgs = ["import", "--from", "wave", "--with", `wave=${fx.source.root}`, "--actor", "process:import-test", "--dir", fx.target.root, "--resume", recordId];
    const resumed = await run(fx, resumeArgs);
    assert.equal(resumed.import, "resumed");
    assert.equal(resumed.changed, true);
    assert.equal((resumed.record as { state: string }).state, "applied");
    assert.equal((await readDoc(fx.target, "imp/themes/b")).body, "Back to [a](a.md).\n");
    const again = await run(fx, resumeArgs);
    assert.equal(again.changed, false);

    const missing = await refusal(fx, [...resumeArgs.slice(0, -1), "promotions/none"]);
    assert.equal(missing.code, "NOT_FOUND");
    assert.equal(missing.exitCode, EXIT.NOT_FOUND);
  } finally { await fx.cleanup(); }
});

test("an interrupted import maps by cause: a concurrent create is exit 5, an I/O failure exit 1", () => {
  const written = [{ source: "s/a", target: "imp/s/a", version: "sha256:1" }];
  const pending = [{ source: "s/b", target: "imp/s/b" }];
  const raced = cliErrorFromTransfer(new TransferInterrupted("promotions/x", written, pending, new VersionConflict("imp/s/b", null, "sha256:2")))!;
  assert.equal(raced.code, "TRANSFER_INTERRUPTED");
  assert.equal(raced.exitCode, EXIT.CONFLICT);
  assert.equal(raced.details?.record, "promotions/x");
  assert.equal(raced.details?.record_state, "applying");
  assert.deepEqual(raced.details?.pending, pending);
  const crashed = cliErrorFromTransfer(new TransferInterrupted("promotions/x", written, pending, new Error("EIO")))!;
  assert.equal(crashed.code, "RUNTIME");
  assert.equal(crashed.exitCode, EXIT.RUNTIME);
  assert.equal(crashed.details?.record, "promotions/x");
  assert.equal(cliErrorFromTransfer(new Error("other")), null);
});

test("built CLI: plan, apply, then status --with resolves every cross-bundle link", async () => {
  const fx = await makeFixture();
  try {
    const cli = (args: string[]) => spawnSync(process.execPath, [BUILT_COMMAND, ...args], { cwd: fx.root, env: commandEnv(fx.home), encoding: "utf8" });
    const args = ["doc", ...baseArgs(fx), "--json"];
    const planned = cli(args);
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    const token = JSON.parse(planned.stdout).plan_token as string;
    const applied = cli([...args, "--apply", token]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const stale = cli([...args.filter((a) => a !== "--json"), "--prefix", "elsewhere", "--apply", token]);
    assert.equal(stale.status, 5, stale.stdout);
    const status = cli(["status", "--with", `wave=${fx.source.root}`, "--dir", fx.target.root, "--json"]);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const report = JSON.parse(status.stdout) as Record<string, number>;
    assert.equal(report.cross_bundle_unresolved, 0);
    assert.equal(report.cross_bundle_unchecked, 0);
    assert.ok(report.cross_bundle_links! > 0);
    assert.equal(report.unresolved_links, 0);
  } finally { await fx.cleanup(); }
});

function refreshArgs(fx: Fixture, recordId: string, extra: string[] = []): string[] {
  return ["import", "--from", "wave", "--with", `wave=${fx.source.root}`, "--refresh", recordId,
    "--actor", "process:import-test", "--dir", fx.target.root, ...extra];
}

test("--refresh plans, applies with its token, reports a local edit as a conflict and resolves it explicitly", async () => {
  const fx = await makeFixture();
  try {
    const plan = await run(fx, baseArgs(fx));
    await run(fx, baseArgs(fx, ["--apply", String(plan.plan_token)]));
    const recordId = (plan.record as { id: string }).id;

    const fresh = await run(fx, refreshArgs(fx, recordId));
    assert.deepEqual(Object.keys(fresh), ["import", "from", "record", "counts", "entries", "ready", "up_to_date", "help"]);
    assert.equal(fresh.up_to_date, true);

    const reimport = await run(fx, baseArgs(fx));
    assert.ok((reimport.help as string[]).some((line) => line.includes(`--refresh ${recordId}`)), "a colliding re-import points at the refresh");

    await writeDoc(fx.source, { id: "themes/a", frontmatter: { type: "Theme", title: "A v2" }, body: "Updated [b](b.md).\n" });
    await writeDoc(fx.source, { id: "themes/b", frontmatter: { type: "Theme", title: "B v2" }, body: "Updated [a](a.md).\n" });
    const local = await readDoc(fx.target, "imp/themes/b");
    await writeDoc(fx.target, { ...local, body: "Investor wording.\n" });

    const blocked = await run(fx, refreshArgs(fx, recordId));
    assert.equal(blocked.ready, false);
    assert.deepEqual((blocked.conflicts as { rows: Array<{ code: string; target: string }> }).rows.map((r) => [r.code, r.target]), [["target_edited", "imp/themes/b"]]);
    assert.match((blocked.help as string[])[0]!, /--overwrite imp\/themes\/b .*--skip imp\/themes\/b/);
    const refused = await refusal(fx, refreshArgs(fx, recordId, ["--apply", "document-transfer/v1:refresh:sha256:00"]));
    assert.equal(refused.code, "TRANSFER_CONFLICT");
    assert.equal(refused.exitCode, EXIT.CONFLICT);
    assert.equal((await readDoc(fx.target, "imp/themes/b")).body, "Investor wording.\n");

    const skipped = await run(fx, refreshArgs(fx, recordId, ["--skip", "imp/themes/b"]));
    assert.equal(skipped.ready, true);
    assert.match((skipped.help as string[])[0]!, /--refresh .* --skip imp\/themes\/b .*--apply /);
    const applied = await run(fx, refreshArgs(fx, recordId, ["--skip", "imp/themes/b", "--apply", String(skipped.plan_token)]));
    assert.equal(applied.import, "refreshed");
    assert.equal(applied.documents, 1);
    assert.equal((await readDoc(fx.target, "imp/themes/a")).body, "Updated [b](b.md).\n");
    assert.equal((await readDoc(fx.target, "imp/themes/b")).body, "Investor wording.\n");
    assert.equal((await readDoc(fx.target, recordId)).frontmatter.promotion_state, "applied");
  } finally { await fx.cleanup(); }
});

test("--refresh usage refusals", async () => {
  const fx = await makeFixture();
  try {
    const bind = ["import", "--from", "wave", "--with", `wave=${fx.source.root}`, "--dir", fx.target.root];
    for (const [argv, pattern] of [
      [[...bind, "--refresh", "promotions/x", "--select", "type=Theme"], /--refresh takes the record's own selection/],
      [[...bind, "--refresh", "promotions/x", "--resume", "promotions/x"], /mutually exclusive/],
      [[...bind, "--select", "type=Theme", "--skip", "imp/themes/a"], /only with --refresh/],
      [[...bind, "--refresh", " "], /empty record id/],
    ] as Array<[string[], RegExp]>) {
      const error = await refusal(fx, argv);
      assert.equal(error.code, "USAGE", argv.join(" "));
      assert.match(error.message, pattern);
    }
    const missing = await refusal(fx, [...bind, "--refresh", "promotions/none"]);
    assert.equal(missing.code, "NOT_FOUND");
    await writeDoc(fx.target, { id: "notes/not-a-record", frontmatter: { type: "Note", title: "N" }, body: "" });
    const foreign = await refusal(fx, [...bind, "--refresh", "notes/not-a-record"]);
    assert.equal(foreign.code, "TRANSFER_RESUME_CONFLICT");
    assert.match(foreign.message, /cannot refresh/);
    assert.doesNotMatch(foreign.help ?? "", /--resume/, "a record a refresh refuses is not offered a resume");
  } finally { await fx.cleanup(); }
});
