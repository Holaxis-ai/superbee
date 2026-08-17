import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readBurnedDeclaration, saneSuccessors } from "./release-audit-tags.mjs";
import {
  classifySuccessors,
  existingTags,
  nextVersionCandidates,
  screenForBurns,
  screenForConsumption,
} from "./release-next-versions.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptFile = path.join(repoRoot, "scripts", "release-next-versions.mjs");
const execFileAsync = promisify(execFile);

function byVersion(rows) {
  return Object.fromEntries(rows.map((r) => [r.version, r]));
}

// ============================================================ layer 1: SHAPE
// The numbering scheme alone. No registry, no repository, no ledger — if any assertion in this group
// needs one of those to pass, the layers have leaked into each other.

test("SHAPE: candidates are exactly the sane successors, and the rule is imported not restated", () => {
  for (const from of ["0.1.1-pre.2", "0.1.0-pre.3", "0.1.1", "0.2.0"]) {
    assert.deepEqual(nextVersionCandidates(from), saneSuccessors(from), from);
  }
});

test("SHAPE: a preview is followed by its own line's stable and its own next preview", () => {
  const from = nextVersionCandidates("0.1.1-pre.2");
  assert.ok(from.includes("0.1.1"), `0.1.1 must follow its own preview; got ${from.join(", ")}`);
  assert.ok(from.includes("0.1.1-pre.3"));
  assert.ok(!from.includes("0.1.0"), "0.1.0 belongs to a different line");
});

test("SHAPE: a stable offers its next patch PREVIEW, not only its next patch stable", () => {
  // The gap an independent review caught: patch-line prereleases were allowed to EXIST, but no
  // stable could reach one, so the policy could never be used going forward. Asserted here as well
  // as in the audit suite, because this command is what a human actually consults.
  const from = nextVersionCandidates("0.1.1");
  assert.ok(from.includes("0.1.2-pre.1"), `expected a patch preview; got ${from.join(", ")}`);
  assert.ok(from.includes("0.1.2"), "and the patch stable directly");
});

test("SHAPE: no reachability dead end — every shape the scheme permits can be reached", () => {
  // Walk the two directions that matter: stable -> its patch preview -> that preview's stable.
  const fromStable = nextVersionCandidates("0.1.1");
  assert.ok(fromStable.includes("0.1.2-pre.1"), "stable can start a patch preview");
  const fromPreview = nextVersionCandidates("0.1.2-pre.1");
  assert.ok(fromPreview.includes("0.1.2"), "that preview can reach the stable it previews");
  assert.ok(fromPreview.includes("0.1.2-pre.2"), "and can continue on its own line");
});

test("SHAPE: the minor-line case is unchanged by carrying the patch digit", () => {
  const from = nextVersionCandidates("0.1.0-pre.3");
  assert.ok(from.includes("0.1.0"), "a 0.1.0 preview is still followed by 0.1.0");
  assert.ok(from.includes("0.2.0-pre.1"), "and may still jump to the next minor line");
  assert.ok(!from.includes("0.1.1-pre.1"), "a preview must not skip the release it previews");
});

// ========================================================= layer 2: CONSUMED
// Publication and spent tags. Deliberately NO burns in this group.

test("CONSUMED: a published version is blocked, siblings unaffected", () => {
  const rows = byVersion(screenForConsumption(nextVersionCandidates("0.1.1-pre.2"), { published: ["0.1.1"], tags: new Set() }));
  assert.equal(rows["0.1.1"].usable, false);
  assert.match(rows["0.1.1"].blockers.join(" "), /already published/);
  assert.equal(rows["0.1.1-pre.3"].usable, true);
});

test("CONSUMED: a spent v* tag is blocked, and tag_state distinguishes spent from free", () => {
  const rows = byVersion(screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), { tags: new Set(["v0.1.0"]) }));
  assert.equal(rows["0.1.0"].usable, false);
  assert.equal(rows["0.1.0"].tag_state, "spent");
  assert.match(rows["0.1.0"].blockers.join(" "), /immutable/);
  assert.equal(rows["0.2.0-pre.1"].tag_state, "free");
});

test("CONSUMED: absent tag evidence is UNVERIFIED and non-green, never a silent 'free'", () => {
  // Review finding: local `git tag --list` is not authoritative. A stale clone that has never fetched
  // reports a remotely-existing immutable tag as absent, and the candidate then read as USABLE with
  // tag_state "free". Absent evidence must therefore block rather than pass.
  const rows = screenForConsumption(nextVersionCandidates("0.1.1-pre.2"), { tags: null });
  assert.ok(rows.every((r) => r.tag_state === "unverified"), rows.map((r) => r.tag_state).join(","));
  assert.ok(rows.every((r) => !r.usable), "unverified tag existence must not read as usable");
  assert.ok(rows.every((r) => r.blockers.some((b) => /UNVERIFIED/.test(b))));
});

test("CONSUMED: a verified-empty tag set is different from absent evidence", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.1-pre.2"), { tags: new Set() });
  assert.ok(rows.every((r) => r.tag_state === "free"));
  assert.ok(rows.every((r) => r.usable), "verified-and-nothing-spent IS green");
});

test("CONSUMED: a tuple's claim is reported, names its package, and is not a blocker", () => {
  const rows = byVersion(
    screenForConsumption(nextVersionCandidates("0.1.1-pre.2"), {
      tuples: { "successor-stable": { version: "0.1.1", package: "superbee" } },
      tags: new Set(),
    }),
  );
  assert.equal(rows["0.1.1"].claimed_by, "successor-stable");
  assert.equal(rows["0.1.1"].claimed_for_package, "superbee");
  assert.equal(rows["0.1.1"].usable, true, "the tuple that plans to ship it must not block it");
  assert.equal(rows["0.1.1-pre.3"].claimed_by, null);
});

test("CONSUMED: a claim by the OTHER package is reported as such — two histories, one repo", () => {
  const rows = byVersion(
    screenForConsumption(nextVersionCandidates("0.1.0-pre.10"), {
      tuples: { bridge: { version: "0.1.0-pre.11", package: "@holaxis/aslite" } },
      tags: new Set(),
    }),
  );
  assert.equal(rows["0.1.0-pre.11"].claimed_for_package, "@holaxis/aslite");
});

// ============================================================ layer 3: BURNS
// A last-mile screen over already-classified rows. Separate because a burn is bookkeeping about a
// number consumed WITHOUT publication, not part of the numbering scheme.

test("BURNS: the screen is a pure post-pass over classified rows", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), { tags: new Set() });
  assert.ok(rows.every((r) => r.usable), "premise: nothing consumed before the burn screen runs");
  const screened = byVersion(screenForBurns(rows, ["0.1.0-pre.4"]));
  assert.equal(screened["0.1.0-pre.4"].usable, false);
  assert.equal(screened["0.1.0-pre.4"].burned, true);
  assert.match(screened["0.1.0-pre.4"].blockers.join(" "), /burned/);
  assert.equal(screened["0.2.0-pre.1"].burned, false, "unburned rows pass through untouched");
});

test("BURNS: an empty ledger changes nothing", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), { tags: new Set() });
  assert.deepEqual(
    screenForBurns(rows, []).map((r) => ({ v: r.version, u: r.usable })),
    rows.map((r) => ({ v: r.version, u: r.usable })),
  );
});

test("BURNS: the screen preserves earlier blockers rather than replacing them", () => {
  const rows = screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), {
    published: ["0.1.0-pre.4"],
    tags: new Set(["v0.1.0-pre.4"]),
  });
  const screened = byVersion(screenForBurns(rows, ["0.1.0-pre.4"]));
  assert.equal(screened["0.1.0-pre.4"].blockers.length, 3, screened["0.1.0-pre.4"].blockers.join("; "));
});

test("BURNS: a burn flags that the ledger cannot say WHICH package burned it", () => {
  // release/burned-versions.json entries carry a version and a reason, no package, so the screen
  // must not imply a precision the data does not have.
  const rows = screenForBurns(screenForConsumption(nextVersionCandidates("0.1.0-pre.3"), { tags: new Set() }), ["0.1.0-pre.4"]);
  assert.equal(byVersion(rows)["0.1.0-pre.4"].burnedPackageUnknown, true);
});

// The regression that motivated reading the ledger from its own file: this command originally looked
// for `manifest.burned_versions`, which does not exist on the loaded manifest, so EVERY burned number
// reported USABLE. A false green here is worse than no tool, because it gets trusted.
test("BURNS: the COMMITTED ledger blocks a burned candidate — guards the false-green defect", async () => {
  // Derived from whatever the ledger actually declares, rather than pinning a literal version: pick a
  // real burned prerelease and step to it from its own predecessor, so this keeps guarding the defect
  // as the ledger grows. The committed ledger is read on purpose here -- the defect was the ledger
  // being silently absent, so a synthetic list could not catch it.
  const burned = readBurnedDeclaration(JSON.parse(await readFile(path.join(repoRoot, "release", "burned-versions.json"), "utf8")));
  assert.ok(burned.length > 0, "premise: the committed ledger declares at least one burn");
  const target = burned.find((v) => /-pre\.[2-9]\d*$/.test(v)) ?? burned[0];
  const m = /^(\d+\.\d+\.\d+)-pre\.(\d+)$/.exec(target);
  assert.ok(m, `expected a -pre.N burn to step onto; got ${target}`);
  const predecessor = `${m[1]}-pre.${Number(m[2]) - 1}`;
  const rows = byVersion(classifySuccessors({ from: predecessor, burned, tags: new Set() }));
  assert.equal(rows[target].usable, false, `committed burn ${target} must never read as usable`);
  assert.equal(rows[target].burned, true);
});

// ================================================================ composition

test("classifySuccessors runs the three layers in order", () => {
  const rows = byVersion(
    classifySuccessors({
      from: "0.1.0-pre.3",
      published: ["0.1.0-pre.4"],
      burned: ["0.1.0-pre.4"],
      tags: new Set(["v0.1.0"]),
    }),
  );
  assert.equal(rows["0.1.0-pre.4"].blockers.length, 2, "published + burned");
  assert.equal(rows["0.1.0"].tag_state, "spent");
  assert.equal(rows["0.2.0-pre.1"].usable, true);
});

test("a published preview reaches its own stable; a spent tag on ANOTHER line does not block it", () => {
  // Behaviour, not this repository's data. Registry and tag evidence are both injected, and the
  // numbers are chosen to be unrelated to anything real, so the assertion is about line-scoping
  // rather than about which numbers happen to be spent today. Injecting tags also keeps the test
  // offline: `existingTags` consults the remote, and these gates run with the network off.
  const preview = "1.4.2-pre.7";
  const rows = byVersion(
    classifySuccessors({
      from: preview,
      published: ["1.0.0", preview],
      tags: new Set(["v1.4.1", `v${preview}`]), // spent, but both on other numbers
    }),
  );
  assert.ok(rows["1.4.2"], `1.4.2 must be enumerated as a successor of ${preview}`);
  assert.equal(rows["1.4.2"].usable, true, rows["1.4.2"].blockers.join("; "));
  assert.equal(rows["1.4.2"].tag_state, "free");
  assert.equal(rows["1.4.1"], undefined, "a lower line's stable is not a successor and must not be offered");
});

test("a spent tag ON a candidate's own number blocks exactly that candidate", () => {
  const rows = byVersion(classifySuccessors({ from: "3.2.0", published: ["3.2.0"], tags: new Set(["v3.2.1-pre.1"]) }));
  assert.equal(rows["3.2.1-pre.1"].usable, false);
  assert.equal(rows["3.2.1-pre.1"].tag_state, "spent");
  assert.equal(rows["3.2.1"].usable, true, "its sibling stable is untouched");
});

test("existingTags is INDETERMINATE when no authoritative tag source can be reached", async () => {
  // Outside a git repository at all.
  assert.equal(await existingTags({ cwd: "/" }), null);

  // And in a real repository whose remote cannot be consulted: local tags alone are NOT authoritative
  // (this is the stale-clone case from review), so the result must be null rather than the local set.
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-next-versions-tags-"));
  const run = (...args) => execFileSync("git", args, { cwd: scratch, stdio: "pipe" });
  run("init", "--quiet");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "t");
  run("commit", "--allow-empty", "-m", "seed", "--quiet");
  run("tag", "v9.9.9");
  try {
    assert.equal(
      await existingTags({ cwd: scratch, remote: "no-such-remote", timeoutMs: 5_000 }),
      null,
      "an unreachable remote must not degrade to the local-only set",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ======================================================== CLI argument handling

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptFile, ...args], { timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("CLI: a malformed --from is a usage error, not an empty table that reads as 'nothing available'", async () => {
  const r = await runCli(["--from", "definitely-not-semver", "--offline"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /is not a strict SemVer version/);
});

test("CLI: an unsupported flag is rejected rather than silently ignored", async () => {
  // --package was removed; silently ignoring it would answer for superbee while the caller believed
  // they had asked about the bridge.
  const r = await runCli(["--package", "@holaxis/aslite", "--offline"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /unsupported flag --package/);

  const bogus = await runCli(["--bogus", "--offline"]);
  assert.equal(bogus.code, 2, bogus.stderr);
  assert.match(bogus.stderr, /unsupported flag --bogus/);
});

test("CLI: a stray positional argument is rejected", async () => {
  const r = await runCli(["0.1.1", "--offline"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /unexpected positional argument/);
});

test("CLI: --from with no value is a usage error", async () => {
  const r = await runCli(["--offline", "--from"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /missing value for --from/);
});

test("CLI: a well-formed offline query answers successfully", async () => {
  const r = await runCli(["--from", "0.1.1", "--offline", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.from, "0.1.1");
  assert.ok(parsed.candidates.some((c) => c.version === "0.1.2-pre.1"), "the patch preview must be offered");
});
