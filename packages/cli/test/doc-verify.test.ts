/**
 * `doc verify <id>` — the OKF v0.2 verification verb and the trust tier it surfaces.
 *
 * Runs command functions in-process against a real temp filesystem bundle (mirrors `doc.test.ts`).
 * Every write here routes through `mutateDoc`, so the body-replace guards, CAS, and attribution
 * contracts are the ones `doc update` already proves; these tests pin what is SPECIFIC to
 * verification: the event shape, the untouched `generated` provenance, the refusals, and the tier
 * as each read surface (`status`, `list --fields trust`, `home`) derives it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, readDoc, writeDoc } from "@superbee/core";

import { doc, type DocCliDeps } from "../src/commands/doc.js";
import { list } from "../src/commands/list.js";
import { status } from "../src/commands/status.js";
import { summarizeDocs } from "../src/commands/home.js";
import { CliError } from "../src/errors.js";

const GENERATED = { by: "finance_agent/1.0", at: "2026-07-28T12:34:56.000Z" };

async function makeV02Bundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-doc-verify-"));
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function seed(dir: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeDoc(
    { root: dir },
    { id, frontmatter: { type: "Metric", title: "MRR", generated: GENERATED, ...extra }, body: "# MRR\n\nBody.\n" },
  );
}

async function runDoc(argv: string[], deps: Partial<DocCliDeps> = {}): Promise<Record<string, unknown>> {
  let out = "";
  await doc([...argv, "--json"], { stdout: (s) => (out += s), readStdin: async () => undefined, ...deps });
  return JSON.parse(out) as Record<string, unknown>;
}

async function runJson(fn: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>, argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await fn([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Run with NO ambient actor so the verb's own refusal is what is under test. */
async function withoutAmbientActor<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { SUPERBEE_ACTOR: process.env.SUPERBEE_ACTOR, AGENTSTATE_LITE_ACTOR: process.env.AGENTSTATE_LITE_ACTOR };
  delete process.env.SUPERBEE_ACTOR;
  delete process.env.AGENTSTATE_LITE_ACTOR;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function expectCliError(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<CliError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CliError, `expected a CliError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

test("doc verify: appends one {by, at} event for the actor, reports human-reviewed, and leaves body + generated untouched", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/revenue");
    const before = Date.now();
    const receipt = await runDoc(["verify", "concepts/revenue", "--actor", "human:ahormati", "--dir", dir]);
    assert.equal(receipt.doc, "verified");
    assert.equal(receipt.id, "concepts/revenue");
    assert.equal(receipt.trust, "human-reviewed");
    assert.equal(receipt.changed, true);
    assert.equal(typeof receipt.version, "string");
    const verifiedReceipt = receipt.verified as { count: number; latest_at: string };
    assert.equal(verifiedReceipt.count, 1);

    const after = await readDoc({ root: dir }, "concepts/revenue");
    const events = after.frontmatter.verified as Array<{ by: string; at: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.by, "human:ahormati");
    assert.ok(Date.parse(events[0]!.at) >= before - 1000, "at defaults to now");
    assert.equal(events[0]!.at, verifiedReceipt.latest_at);
    assert.deepEqual(after.frontmatter.generated, GENERATED, "verification never advances generated.at or replaces generated.by");
    assert.equal(after.frontmatter.superbee_updated_by, "human:ahormati", "the revision is still attributed");
    assert.equal(after.body, "# MRR\n\nBody.\n");
    assert.equal(after.frontmatter.timestamp, undefined, "v0.2 invents no legacy clock");
  } finally {
    await cleanup();
  }
});

test("doc verify: a second (machine) confirmation grows the list, keeps the human tier, and --at is normalized to ISO UTC", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/revenue");
    await runDoc(["verify", "concepts/revenue", "--actor", "human:ahormati", "--at", "2026-06-25T09:00:00Z", "--dir", dir]);
    const receipt = await runDoc([
      "verify", "concepts/revenue", "--actor", "process:finance-nightly", "--at", "2026-06-26T02:00:00+00:00", "--dir", dir,
    ]);
    assert.equal(receipt.trust, "human-reviewed");
    assert.deepEqual(receipt.verified, { count: 2, latest_at: "2026-06-26T02:00:00.000Z" });
    const after = await readDoc({ root: dir }, "concepts/revenue");
    assert.deepEqual(after.frontmatter.verified, [
      { by: "human:ahormati", at: "2026-06-25T09:00:00.000Z" },
      { by: "process:finance-nightly", at: "2026-06-26T02:00:00.000Z" },
    ]);
    assert.deepEqual(after.frontmatter.generated, GENERATED);
  } finally {
    await cleanup();
  }
});

test("doc verify: a producer's bare verified mapping is read as one event (SPEC 5.2 MUST) and becomes a two-element list", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/bare", { verified: { by: "process:nightly", at: "2026-06-20T00:00:00Z", method: "checksum" } });
    const receipt = await runDoc(["verify", "concepts/bare", "--actor", "human:ahormati", "--at", "2026-06-25T09:00:00Z", "--dir", dir]);
    assert.equal(receipt.trust, "human-reviewed");
    assert.deepEqual(receipt.verified, { count: 2, latest_at: "2026-06-25T09:00:00.000Z" });
    const after = await readDoc({ root: dir }, "concepts/bare");
    assert.deepEqual(after.frontmatter.verified, [
      { by: "process:nightly", at: "2026-06-20T00:00:00Z", method: "checksum" },
      { by: "human:ahormati", at: "2026-06-25T09:00:00.000Z" },
    ]);
  } finally {
    await cleanup();
  }
});

test("doc verify: identical event (same actor, same --at) converges to changed:false without a write", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/revenue");
    const first = await runDoc(["verify", "concepts/revenue", "--actor", "human:ahormati", "--at", "2026-06-25T09:00:00Z", "--dir", dir]);
    const again = await runDoc(["verify", "concepts/revenue", "--actor", "human:ahormati", "--at", "2026-06-25T09:00:00Z", "--dir", dir]);
    assert.equal(again.changed, false);
    assert.equal(again.version, first.version);
    assert.deepEqual(again.verified, { count: 1, latest_at: "2026-06-25T09:00:00.000Z" });
  } finally {
    await cleanup();
  }
});

test("doc verify: an imported event with an hour-only offset is recognized as already recorded and ranks as latest", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/imported", {
      verified: [{ by: "process:a", at: "2026-09-06T23:00:00Z" }, { by: "human:reviewer", at: "2026-09-07T14:00:00+02" }],
    });
    const same = await runDoc(["verify", "concepts/imported", "--actor", "human:reviewer", "--at", "2026-09-07T12:00:00Z", "--dir", dir]);
    assert.equal(same.changed, false, "same verifier, same instant, different spelling: nothing to record");
    assert.deepEqual(same.verified, { count: 2, latest_at: "2026-09-07T14:00:00+02" });
    const after = await readDoc({ root: dir }, "concepts/imported");
    assert.equal((after.frontmatter.verified as unknown[]).length, 2);
  } finally {
    await cleanup();
  }
});

test("doc verify: refusals — non-OKF actor, no actor at all, bad --at, blank --expected-version, missing id (USAGE, no write)", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/revenue");
    await expectCliError(runDoc(["verify", "concepts/revenue", "--actor", "codex-root", "--dir", dir]), "USAGE", /human:<id>/);
    await withoutAmbientActor(() =>
      expectCliError(runDoc(["verify", "concepts/revenue", "--dir", dir]), "USAGE", /--actor|SUPERBEE_ACTOR/),
    );
    await expectCliError(runDoc(["verify", "concepts/revenue", "--actor", "human:a", "--at", "yesterday", "--dir", dir]), "USAGE", /--at/);
    // A zone-less or date-only instant would record a host-dependent time; refused, not guessed.
    await expectCliError(runDoc(["verify", "concepts/revenue", "--actor", "human:a", "--at", "2026-06-25T09:00:00", "--dir", dir]), "USAGE", /timezone/);
    await expectCliError(runDoc(["verify", "concepts/revenue", "--actor", "human:a", "--at", "2026-06-25", "--dir", dir]), "USAGE", /timezone/);
    // An impossible calendar date must be refused, not rolled forward by Date.parse (Feb 30 -> Mar 2).
    for (const impossible of ["2026-02-30T12:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00+02:00", "2026-06-25T24:00:00Z"]) {
      await expectCliError(runDoc(["verify", "concepts/revenue", "--actor", "human:a", "--at", impossible, "--dir", dir]), "USAGE", /impossible|timezone/);
    }
    await expectCliError(
      runDoc(["verify", "concepts/revenue", "--actor", "human:a", "--expected-version", "", "--dir", dir]),
      "USAGE",
      /--expected-version/,
    );
    await expectCliError(runDoc(["verify", "--actor", "human:a", "--dir", dir]), "USAGE");
    const after = await readDoc({ root: dir }, "concepts/revenue");
    assert.equal(after.frontmatter.verified, undefined, "no refusal wrote anything");
    assert.equal(after.frontmatter.superbee_updated_by, undefined);
  } finally {
    await cleanup();
  }
});

test("doc verify: NOT_FOUND for an absent doc; STALE_HEAD on a moved --expected-version; success on the current token", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/revenue");
    await expectCliError(runDoc(["verify", "concepts/ghost", "--actor", "human:a", "--dir", dir]), "NOT_FOUND");
    const first = await runDoc(["verify", "concepts/revenue", "--actor", "human:a", "--at", "2026-06-25T09:00:00Z", "--dir", dir]);
    const stale = await runDoc(["update", "concepts/revenue", "--title", "Moved", "--actor", "human:b", "--dir", dir]);
    assert.notEqual(stale.version, first.version);
    await expectCliError(
      runDoc(["verify", "concepts/revenue", "--actor", "human:a", "--expected-version", String(first.version), "--dir", dir]),
      "STALE_HEAD",
    );
    const ok = await runDoc([
      "verify", "concepts/revenue", "--actor", "human:a", "--expected-version", String(stale.version), "--dir", dir,
    ]);
    assert.equal(ok.changed, true);
    assert.equal((ok.verified as { count: number }).count, 2);
  } finally {
    await cleanup();
  }
});

test("doc verify: refuses an unrecognized verified shape rather than overwriting trust history", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/odd", { verified: "human:someone" });
    await expectCliError(runDoc(["verify", "concepts/odd", "--actor", "human:a", "--dir", dir]), "USAGE", /verified must be a list/);
    const after = await readDoc({ root: dir }, "concepts/odd");
    assert.equal(after.frontmatter.verified, "human:someone");
  } finally {
    await cleanup();
  }
});

test("doc verify: a v0.1 bundle is refused — its free-form actors define no trust tier", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-doc-verify-v01-"));
  try {
    await initBundle(dir, { okfVersion: "0.1" });
    await writeDoc({ root: dir }, { id: "notes/a", frontmatter: { type: "Note", title: "A" }, body: "Body." });
    await expectCliError(runDoc(["verify", "notes/a", "--actor", "human:a", "--dir", dir]), "USAGE", /OKF 0\.1/);
    const after = await readDoc({ root: dir }, "notes/a");
    assert.equal(after.frontmatter.verified, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doc verify --help: focused usage names the tier vocabulary and the actor convention", async () => {
  let out = "";
  await doc(["verify", "--help"], { stdout: (s) => (out += s) });
  assert.match(out, /doc verify <id> --actor <actor>/);
  assert.match(out, /human-reviewed/);
  assert.match(out, /machine-confirmed/);
  assert.match(out, /human:<id>/);
  let family = "";
  await doc(["--help"], { stdout: (s) => (family += s) });
  assert.match(family, /doc verify/);
});

test("trust surfaces: status counts per tier (v0.2 with docs), list --fields trust derives the column, home summary folds the same counts", async () => {
  const { dir, cleanup } = await makeV02Bundle();
  try {
    await seed(dir, "concepts/human");
    await seed(dir, "concepts/machine", { verified: { by: "process:nightly", at: "2026-06-20T00:00:00Z" } });
    await seed(dir, "concepts/plain");
    await runDoc(["verify", "concepts/human", "--actor", "human:ahormati", "--dir", dir]);

    const report = await runJson(status, ["--dir", dir]);
    assert.deepEqual(report.trust, { human_reviewed: 1, machine_confirmed: 1, unverified: 1 });

    const rows = (await runJson(list, ["--fields", "trust", "--dir", dir])).docs as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.id, r.trust]));
    assert.equal(byId.get("concepts/human"), "human-reviewed");
    assert.equal(byId.get("concepts/machine"), "machine-confirmed");
    assert.equal(byId.get("concepts/plain"), "unverified");

    const heads = [
      { id: "a", frontmatter: { type: "T", verified: [{ by: "human:x" }] } },
      { id: "b", frontmatter: { type: "T", verified: { by: "process:y" } } },
      { id: "c", frontmatter: { type: "T" } },
    ];
    assert.deepEqual(summarizeDocs(heads, "/r", { okfVersion: "0.2" }).trust, { human_reviewed: 1, machine_confirmed: 1, unverified: 1 });
    assert.equal(summarizeDocs(heads, "/r", { okfVersion: "0.1" }).trust, undefined, "v0.1 defines no trust family");
    assert.equal(summarizeDocs([], "/r", { okfVersion: "0.2" }).trust, undefined, "an empty bundle keeps its baseline");
  } finally {
    await cleanup();
  }
});

test("status: a v0.1 bundle with docs carries no trust block; a v0.2 bundle with docs always does (even all-unverified)", async () => {
  const v01 = await mkdtemp(path.join(tmpdir(), "superbee-status-trust-v01-"));
  const { dir: v02, cleanup } = await makeV02Bundle();
  try {
    await initBundle(v01, { okfVersion: "0.1" });
    await writeDoc({ root: v01 }, { id: "notes/a", frontmatter: { type: "Note", title: "A" }, body: "Body." });
    assert.equal("trust" in (await runJson(status, ["--dir", v01])), false);
    await seed(v02, "concepts/plain");
    assert.deepEqual((await runJson(status, ["--dir", v02])).trust, { human_reviewed: 0, machine_confirmed: 0, unverified: 1 });
  } finally {
    await cleanup();
    await rm(v01, { recursive: true, force: true });
  }
});
