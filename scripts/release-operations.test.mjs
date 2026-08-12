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
import { operationsFor } from "./release-run-operations.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runOps = path.join(repoRoot, "scripts", "release-run-operations.mjs");
const SHA = "sha256:" + "a".repeat(64);
const BARE = "a".repeat(64);

test("inspection instructions emit the exact stage download + SHA-256 compare", () => {
  const i = inspectionInstructions({ stageId: "stage-1", tarballSha256: SHA, version: "0.1.0-pre.4" });
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

test("secondary tag operations target the scoped package (argv + display)", () => {
  const add = secondaryTagOperation({ version: "0.1.0-pre.4", tag: "next" });
  assert.deepEqual(add.argv, ["npm", "dist-tag", "add", "@holaxis/aslite@0.1.0-pre.4", "next"]);
  assert.equal(add.command, "npm dist-tag add @holaxis/aslite@0.1.0-pre.4 next");
  assert.equal(removeSecondaryTagOperation({ tag: "next" }).command, "npm dist-tag rm @holaxis/aslite next");
  assert.equal(
    secondaryTagOperation({ target: "successor", version: "0.1.0-pre.11", tag: "next" }).command,
    "npm dist-tag add @holaxis/superbee@0.1.0-pre.11 next",
  );
});

test("rollback restores the prior track and deprecates with the recovery command as the message", () => {
  const r = rollbackOperation({ failedVersion: "0.1.0-pre.4", priorVersion: "0.1.0-pre.3", track: "next" });
  assert.deepEqual(r.argvs[0], ["npm", "dist-tag", "add", "@holaxis/aslite@0.1.0-pre.3", "next"]);
  // The deprecate message is ONE argv element (no shell word-splitting), carrying the recovery.
  assert.equal(r.argvs[1][0], "npm");
  assert.equal(r.argvs[1][1], "deprecate");
  assert.equal(r.argvs[1][2], "@holaxis/aslite@0.1.0-pre.4");
  assert.match(r.argvs[1][3], /npm install --global @holaxis\/aslite@0\.1\.0-pre\.3/);
  assert.equal(r.recovery_command, "npm install --global @holaxis/aslite@0.1.0-pre.3");
  const successor = rollbackOperation({
    target: "successor",
    recoveryTarget: "bridge",
    failedVersion: "0.1.0-pre.11",
    priorVersion: "0.1.0-pre.10",
  });
  assert.equal(successor.argvs[1][2], "@holaxis/superbee@0.1.0-pre.11");
  assert.equal(successor.recovery_command, "npm install --global @holaxis/aslite@0.1.0-pre.10");
});

test("registry instructions are read-only and delegate strict proof to the verifier", () => {
  const v = registryVerifyOperations({ version: "0.1.0-pre.4" });
  assert.ok(v.commands.includes("npm view @holaxis/aslite@0.1.0-pre.4 dist.integrity dist.shasum --json"));
  assert.ok(v.commands.includes("npm pack @holaxis/aslite@0.1.0-pre.4 --json --ignore-scripts"));
  assert.match(v.workflow_proof, /release-verify-registry\.mjs/);
  assert.ok(!v.commands.some((c) => c.includes("audit signatures --package")), "npm has no audit signatures --package option");
  assert.ok(!v.commands.some((c) => /dist-tag|publish|deprecate|stage (approve|reject)/.test(c)));
  assert.match(registryVerifyOperations({ target: "successor", version: "0.1.0-pre.11" }).workflow_proof, /--target successor/);
});

test("promote and immutable release name the exact version/tag/release id", () => {
  assert.equal(promoteOperation({ version: "0.1.0", tag: "latest" }).command, "npm dist-tag add @holaxis/aslite@0.1.0 latest");
  assert.equal(
    promoteOperation({ target: "successor", version: "0.1.0-pre.11", tag: "latest" }).command,
    "npm dist-tag add @holaxis/superbee@0.1.0-pre.11 latest",
  );
  const rel = immutableReleaseOperations({ releaseId: "rel-42", tag: "v0.1.0" });
  assert.ok(rel.commands[0].includes("releases/rel-42"));
  assert.ok(rel.commands[1].includes("-f draft=false"));
});

// ── SECURITY: injection-shaped inputs are REJECTED at construction (no argv is ever built) ──
test("injection-shaped version / id / stage-id / tag are refused, not interpolated", () => {
  const injections = [
    () => rejectOperation({ stageId: "nope; touch ./INJECTED_PROOF; true" }),
    () => approveOperation({ stageId: "$(touch x)" }),
    () => secondaryTagOperation({ version: "0.1.0; rm -rf /", tag: "next" }),
    () => secondaryTagOperation({ version: "0.1.0", tag: "next && echo bad" }),
    () => promoteOperation({ version: "0.1.0 | cat", tag: "latest" }),
    () => rollbackOperation({ failedVersion: "0.1.0`id`", priorVersion: "0.1.0" }),
    () => registryVerifyOperations({ version: "0.1.0\nid" }),
    () => immutableReleaseOperations({ releaseId: "rel; curl evil", tag: "v0.1.0" }),
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
    () => secondaryTagOperation({ version: "0.1.0", tag: "--otp=0" }),
    () => removeSecondaryTagOperation({ tag: "--" }),
    () => rollbackOperation({ failedVersion: "0.1.0", priorVersion: "0.0.9", track: "-next" }),
    () => promoteOperation({ version: "0.1.0", tag: "-latest" }),
    () => inspectionInstructions({ stageId: "-s", tarballSha256: SHA, version: "0.1.0" }),
    () => immutableReleaseOperations({ releaseId: "--jq", tag: "v0.1.0" }),
    () => immutableReleaseOperations({ releaseId: "rel-1", tag: "-v0.1.0" }),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, /invalid (stageId|tag|track|releaseId)/);
  }
});

test("missing required arguments fail closed", () => {
  assert.throws(() => rejectOperation({}), /invalid stageId/);
  assert.throws(() => secondaryTagOperation({ version: "1.0.0" }), /invalid tag/);
  assert.throws(() => rollbackOperation({ failedVersion: "1.0.0" }), /invalid version/);
  assert.throws(() => immutableReleaseOperations({ releaseId: "r" }), /invalid tag/);
});

test("operationsFor resolves each op to the same argv + display strings", () => {
  assert.deepEqual(operationsFor("reject", ["--stage-id", "s1"]), [
    { argv: ["npm", "stage", "reject", "s1"], command: "npm stage reject s1", requires_2fa: true },
  ]);
  assert.deepEqual(
    operationsFor("registry-verify", ["--version", "0.1.0"]).map((o) => o.command),
    registryVerifyOperations({ version: "0.1.0" }).commands,
  );
  assert.deepEqual(operationsFor("immutable-release", ["--version", "0.1.0", "--release-id", "rel-9"]).map((o) => o.argv), [
    ["gh", "api", "repos/{owner}/{repo}/releases/rel-9", "--jq", ".draft, .tag_name, .id"],
    ["gh", "api", "-X", "PATCH", "repos/{owner}/{repo}/releases/rel-9", "-f", "draft=false", "-f", "make_latest=true"],
  ]);
  assert.throws(() => operationsFor("bogus", []), /unknown op/);
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
