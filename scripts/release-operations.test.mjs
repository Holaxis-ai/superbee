import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertToken,
  inspectionInstructions,
  rejectOperation,
  approveOperation,
  secondaryTagOperation,
  removeSecondaryTagOperation,
  rollbackOperation,
  registryVerifyOperations,
  promoteOperation,
  immutableReleaseOperations,
} from "./release-operations.mjs";
import * as allOperations from "./release-operations.mjs";
import { operationsFor } from "./release-run-operations.mjs";
import { defaultReleaseTargets } from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runOps = path.join(repoRoot, "scripts", "release-run-operations.mjs");
const SHA = "sha256:" + "a".repeat(64);
const BARE = "a".repeat(64);

test("inspection instructions emit the exact stage download + SHA-256 compare", () => {
  const i = inspectionInstructions({ target: "bridge", stageId: "stage-1", tarballSha256: SHA, version: "0.1.0-pre.4" });
  const downloaded = "./holaxis-aslite-0.1.0-pre.4-stage-1.tgz";
  assert.equal(i.steps[0], "npm stage download stage-1");
  assert.equal(i.steps[1], `shasum -a 256 ${downloaded}`);
  assert.equal(
    i.steps[2],
    `test "$(shasum -a 256 ${downloaded} | awk '{print $1}')" = "${BARE}" && echo MATCH || echo MISMATCH`,
  );
  assert.equal(i.expected_sha256, SHA);
});

test("reject/approve return a shell-free argv plus display and require 2fa", () => {
  assert.deepEqual(rejectOperation({ stageId: "s9" }), {
    argv: ["npm", "stage", "reject", "s9"],
    command: "npm stage reject s9",
    requires_2fa: true,
  });
  assert.deepEqual(approveOperation({ stageId: "s9" }), {
    argv: ["npm", "stage", "approve", "s9"],
    command: "npm stage approve s9",
    requires_2fa: true,
  });
});

test("secondary tag operations target the bridge and successor packages (argv + display)", () => {
  const add = secondaryTagOperation({ target: "bridge", version: "0.1.0-pre.4", tag: "next" });
  assert.deepEqual(add.argv, ["npm", "dist-tag", "add", "@holaxis/aslite@0.1.0-pre.4", "next"]);
  assert.equal(add.command, "npm dist-tag add @holaxis/aslite@0.1.0-pre.4 next");
  assert.equal(removeSecondaryTagOperation({ target: "bridge", tag: "next" }).command, "npm dist-tag rm @holaxis/aslite next");
  assert.equal(
    secondaryTagOperation({ target: "successor-preview", version: "0.1.1-pre.1", tag: "next" }).command,
    "npm dist-tag add superbee@0.1.1-pre.1 next",
  );
});

test("identity-only rehearsal targets cannot render full release operations", () => {
  assert.throws(
    () => inspectionInstructions({ target: "rehearsal-reject", stageId: "stage-1", tarballSha256: SHA, version: "0.0.0-rename-reject.20260812" }),
    /requires workflow contract full/,
  );
});

test("rollback restores the prior track and deprecates with the recovery command as the message", () => {
  const r = rollbackOperation({ target: "bridge", failedVersion: "0.1.0-pre.4", priorVersion: "0.1.0-pre.3", track: "next" });
  assert.deepEqual(r.argvs[0], ["npm", "dist-tag", "add", "@holaxis/aslite@0.1.0-pre.3", "next"]);
  // The deprecate message is ONE argv element (no shell word-splitting), carrying the recovery.
  assert.equal(r.argvs[1][0], "npm");
  assert.equal(r.argvs[1][1], "deprecate");
  assert.equal(r.argvs[1][2], "@holaxis/aslite@0.1.0-pre.4");
  assert.match(r.argvs[1][3], /npm install --global @holaxis\/aslite@0\.1\.0-pre\.3/);
  assert.equal(r.recovery_command, "npm install --global @holaxis/aslite@0.1.0-pre.3");
  const successor = rollbackOperation({
    target: "successor-preview",
    recoveryTarget: "bridge",
    failedVersion: "0.1.1-pre.1",
    priorVersion: "0.1.0-pre.11",
  });
  assert.equal(successor.argvs[1][2], "superbee@0.1.1-pre.1");
  assert.equal(successor.recovery_command, "npm install --global @holaxis/aslite@0.1.0-pre.11");
});

test("registry instructions are read-only and delegate strict proof to the verifier", () => {
  const v = registryVerifyOperations({ target: "bridge", version: "0.1.0-pre.4" });
  assert.ok(v.commands.includes("npm view @holaxis/aslite@0.1.0-pre.4 dist.integrity dist.shasum --json"));
  assert.ok(v.commands.includes("npm pack @holaxis/aslite@0.1.0-pre.4 --json --ignore-scripts"));
  assert.match(v.workflow_proof, /release-verify-registry\.mjs/);
  assert.ok(!v.commands.some((c) => c.includes("audit signatures --package")), "npm has no audit signatures --package option");
  assert.ok(!v.commands.some((c) => /dist-tag|publish|deprecate|stage (approve|reject)/.test(c)));
  assert.match(registryVerifyOperations({ target: "successor-preview", version: "0.1.1-pre.1" }).workflow_proof, /--target successor-preview/);
});

test("promote and immutable release name the exact version/tag/release id", () => {
  assert.equal(
    promoteOperation({ target: "successor-stable", version: "0.1.0", tag: "latest" }).command,
    "npm dist-tag add superbee@0.1.0 latest",
  );
  const rel = immutableReleaseOperations({ releaseId: "rel-42", tag: "v0.1.0", githubLatest: false });
  assert.ok(rel.commands[0].includes("releases/rel-42"));
  assert.ok(rel.commands[1].includes("-f draft=false"));
  assert.ok(rel.commands[1].includes("make_latest=false"));
  const latest = immutableReleaseOperations({ releaseId: "rel-43", tag: "v0.1.0", githubLatest: true });
  assert.ok(latest.commands[1].includes("make_latest=true"));
});

// ── SECURITY: injection-shaped inputs are REJECTED at construction (no argv is ever built) ──
test("injection-shaped version / id / stage-id / tag are refused, not interpolated", () => {
  const injections = [
    () => rejectOperation({ stageId: "nope; touch ./INJECTED_PROOF; true" }),
    () => approveOperation({ stageId: "$(touch x)" }),
    () => secondaryTagOperation({ target: "bridge", version: "0.1.0; rm -rf /", tag: "next" }),
    () => secondaryTagOperation({ target: "bridge", version: "0.1.0", tag: "next && echo bad" }),
    () => promoteOperation({ target: "bridge", version: "0.1.0 | cat", tag: "latest" }),
    () => rollbackOperation({ target: "bridge", failedVersion: "0.1.0`id`", priorVersion: "0.1.0" }),
    () => registryVerifyOperations({ target: "bridge", version: "0.1.0\nid" }),
    () => immutableReleaseOperations({ releaseId: "rel; curl evil", tag: "v0.1.0", githubLatest: true }),
  ];
  for (const attempt of injections) {
    assert.throws(attempt, /invalid (version|stageId|tag|releaseId)/);
  }
});

// ── SECURITY: flag-shaped (leading-dash) tokens are REJECTED so no argv element can pose as an option ──
test("assertToken refuses leading-dash tokens and accepts legitimate release values", () => {
  const hostile = ["-v", "--registry=evil", "--", "-", "-rf", "-stage-1"];
  for (const value of hostile) {
    assert.throws(() => assertToken("tag", value), /invalid tag .*no leading dash/, `must reject ${JSON.stringify(value)}`);
  }
  const legitimate = [
    "next",
    "latest",
    "stage-1",
    "v0.1.0-pre.4",
    "rel-42",
    "a".repeat(64), // bare sha-shaped artifact id
    "holaxis-aslite-0.1.0-pre.4-stage-1.tgz",
  ];
  for (const value of legitimate) {
    assert.equal(assertToken("tag", value), value, `must accept ${JSON.stringify(value)}`);
  }
});

test("flag-shaped values are refused at every operation entry point", () => {
  const attempts = [
    () => rejectOperation({ stageId: "--registry=evil" }),
    () => approveOperation({ stageId: "-v" }),
    () => secondaryTagOperation({ target: "bridge", version: "0.1.0", tag: "--otp=0" }),
    () => removeSecondaryTagOperation({ target: "bridge", tag: "--" }),
    () => rollbackOperation({ target: "bridge", failedVersion: "0.1.0", priorVersion: "0.0.9", track: "-next" }),
    () => promoteOperation({ target: "bridge", version: "0.1.0", tag: "-latest" }),
    () => inspectionInstructions({ target: "bridge", stageId: "-s", tarballSha256: SHA, version: "0.1.0" }),
    () => immutableReleaseOperations({ releaseId: "--jq", tag: "v0.1.0", githubLatest: true }),
    () => immutableReleaseOperations({ releaseId: "rel-1", tag: "-v0.1.0", githubLatest: true }),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, /invalid (stageId|tag|track|releaseId)/);
  }
});

test("missing required arguments fail closed", () => {
  assert.throws(() => rejectOperation({}), /invalid stageId/);
  assert.throws(() => secondaryTagOperation({ target: "bridge", version: "1.0.0" }), /invalid tag/);
  assert.throws(() => rollbackOperation({ target: "bridge", failedVersion: "1.0.0" }), /invalid version/);
  assert.throws(() => promoteOperation({ target: "bridge", version: "1.0.0" }), /invalid tag/);
  assert.throws(() => immutableReleaseOperations({ releaseId: "r", githubLatest: true }), /invalid tag/);
  assert.throws(() => immutableReleaseOperations({ releaseId: "r", tag: "v1.0.0" }), /invalid githubLatest/);
});

test("operationsFor resolves each op to the same argv + display strings", () => {
  assert.deepEqual(operationsFor("reject", ["--stage-id", "s1"]), [
    { argv: ["npm", "stage", "reject", "s1"], command: "npm stage reject s1", requires_2fa: true },
  ]);
  assert.deepEqual(
    operationsFor("registry-verify", ["--version", "0.1.0", "--target", "bridge"]).map((o) => o.command),
    registryVerifyOperations({ target: "bridge", version: "0.1.0" }).commands,
  );
  assert.deepEqual(operationsFor("immutable-release", ["--version", "0.1.0", "--release-id", "rel-9", "--github-latest", "false"]).map((o) => o.argv), [
    ["gh", "api", "repos/{owner}/{repo}/releases/rel-9", "--jq", ".draft, .tag_name, .id"],
    ["gh", "api", "-X", "PATCH", "repos/{owner}/{repo}/releases/rel-9", "-f", "draft=false", "-f", "make_latest=false"],
  ]);
  assert.throws(() => operationsFor("promote", ["--version", "0.1.0"]), /missing --tag/);
  assert.throws(() => operationsFor("bogus", []), /unknown op/);
});

// ── F8: an omitted target must never resolve to a package. No silent bridge redirect. ──
test("every operation that names a package refuses to resolve one without an explicit target", () => {
  const attempts = {
    inspectionInstructions: () => inspectionInstructions({ stageId: "stage-1", tarballSha256: SHA, version: "0.1.0" }),
    secondaryTagOperation: () => secondaryTagOperation({ version: "0.1.0", tag: "next" }),
    removeSecondaryTagOperation: () => removeSecondaryTagOperation({ tag: "next" }),
    rollbackOperation: () => rollbackOperation({ failedVersion: "0.1.0", priorVersion: "0.0.9" }),
    registryVerifyOperations: () => registryVerifyOperations({ version: "0.1.0" }),
    promoteOperation: () => promoteOperation({ version: "0.1.0", tag: "latest" }),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    assert.throws(attempt, /requires an explicit target/, `${name} must not default to a package`);
  }
  // An explicit but unusable target still fails closed, and never falls back.
  assert.throws(() => promoteOperation({ target: "shadow", version: "0.1.0", tag: "latest" }), /is not a declared release target/);
  for (const hostile of [null, 12345, { id: "bridge" }, ["bridge"]]) {
    assert.throws(
      () => promoteOperation({ target: hostile, version: "0.1.0", tag: "latest" }),
      /must be a string|invalid release target|requires an explicit target/,
      `must reject ${JSON.stringify(hostile)}`,
    );
  }
});

// The class, not the six probed sites: enumerated from the module itself, so an operation added
// later with a defaulted target fails here instead of quietly naming a package.
test("no exported operation yields a package-bound result when no target is supplied", () => {
  const targetless = {
    stageId: "stage-1", tarballSha256: SHA, version: "0.1.0", tag: "next", track: "next",
    failedVersion: "0.1.0", priorVersion: "0.0.9", releaseId: "rel-1", githubLatest: false,
  };
  // Derived from the manifest: adding a target adds a name that must not appear by default.
  const packageNames = [...new Set(Object.values(defaultReleaseTargets()).map((target) => target.package.name))];
  const inspected = [];
  for (const [name, exported] of Object.entries(allOperations)) {
    if (typeof exported !== "function") continue;
    let produced;
    try {
      produced = exported(targetless);
    } catch {
      inspected.push(name);
      continue; // already fails closed
    }
    const rendered = JSON.stringify(produced ?? null);
    for (const packageName of packageNames) {
      assert.ok(!rendered.includes(packageName), `${name} named ${packageName} without an explicit target: ${rendered}`);
    }
    inspected.push(name);
  }
  assert.ok(inspected.length >= 8, `expected the operations module to expose its emitters, saw ${inspected.length}`);
});

test("operationsFor requires --target for every op that mutates or names a package", () => {
  const targetless = {
    "secondary-tag": ["--version", "0.1.0", "--tag", "next"],
    "remove-secondary-tag": ["--tag", "next"],
    rollback: ["--failed-version", "0.1.0", "--prior-version", "0.0.9"],
    "registry-verify": ["--version", "0.1.0"],
    promote: ["--version", "0.1.0", "--tag", "latest"],
  };
  for (const [op, argv] of Object.entries(targetless)) {
    assert.throws(() => operationsFor(op, argv), /missing --target/, `${op} must require --target`);
  }
  // Ops that name no package still work without one: reject/approve act on a stage id.
  assert.equal(operationsFor("approve", ["--stage-id", "s1"])[0].command, "npm stage approve s1");
});

// The rollback path is the one that mutates a LIVE registry: a superbee rollback run without
// --target used to emit dist-tag + deprecate commands against @holaxis/aslite.
test("rollback without --target emits nothing and names no package", () => {
  assert.throws(() => operationsFor("rollback", ["--failed-version", "0.1.0", "--prior-version", "0.0.9"]), /missing --target/);
  // With --target and no --recovery-target, recovery stays on the failed package: both commands
  // name superbee, where the bridge default used to put @holaxis/aslite on both.
  const explicit = operationsFor("rollback", ["--failed-version", "0.1.0", "--prior-version", "0.0.9", "--target", "successor-stable"]);
  assert.deepEqual(explicit.map((o) => o.command), [
    "npm dist-tag add superbee@0.0.9 next",
    'npm deprecate superbee@0.1.0 "superseded - install superbee@0.0.9 (npm install --global superbee@0.0.9)"',
  ]);
  // Recovering onto a different package stays possible, but only when the operator says so.
  const crossed = operationsFor("rollback", ["--failed-version", "0.1.0", "--prior-version", "0.1.0-pre.11", "--target", "successor-stable", "--recovery-target", "bridge"]);
  assert.match(crossed[0].command, /@holaxis\/aslite@0\.1\.0-pre\.11/);
  assert.match(crossed[1].command, /npm deprecate superbee@0\.1\.0/);
});

// ── SECURITY (empirical): --execute with an injection-shaped stage id creates NO marker file ──
test("release-run-operations --execute refuses an injected stage-id and creates no marker", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-inject-"));
  try {
    const marker = path.join(scratch, "INJECTED_PROOF");
    await assert.rejects(
      execFileAsync(process.execPath, [
        runOps,
        "--op",
        "reject",
        "--stage-id",
        `nope; touch ${marker}; true`,
        "--execute",
      ]),
      (err) => {
        assert.match(String(err.stderr ?? err.message), /invalid stageId/);
        return true;
      },
    );
    await assert.rejects(access(marker), /ENOENT/, "no command ran — the marker must not exist");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
