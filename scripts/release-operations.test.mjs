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
const BRIDGE = { target: "bridge" };

test("inspection instructions emit the exact stage download + SHA-256 compare", () => {
  const i = inspectionInstructions({ ...BRIDGE, stageId: "stage-1", tarballSha256: SHA, version: "0.1.0-pre.4" });
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
  const add = secondaryTagOperation({ ...BRIDGE, version: "0.1.0-pre.4", tag: "next" });
  assert.deepEqual(add.argv, ["npm", "dist-tag", "add", "@holaxis/aslite@0.1.0-pre.4", "next"]);
  assert.equal(add.command, "npm dist-tag add @holaxis/aslite@0.1.0-pre.4 next");
  assert.equal(removeSecondaryTagOperation({ ...BRIDGE, tag: "next" }).command, "npm dist-tag rm @holaxis/aslite next");
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

test("rollback restores or removes exact prior tag state and names a working recovery", () => {
  const r = rollbackOperation({ ...BRIDGE, failedVersion: "0.1.0-pre.4", restoreTags: { next: "0.1.0-pre.3" } });
  assert.deepEqual(r.argvs[0], ["npm", "dist-tag", "add", "@holaxis/aslite@0.1.0-pre.3", "next"]);
  // The deprecate message is ONE argv element (no shell word-splitting), carrying the recovery.
  assert.equal(r.argvs[1][0], "npm");
  assert.equal(r.argvs[1][1], "deprecate");
  assert.equal(r.argvs[1][2], "@holaxis/aslite@0.1.0-pre.4");
  assert.match(r.argvs[1][3], /npm install --global @holaxis\/aslite@0\.1\.0-pre\.3/);
  assert.equal(r.recovery_command, "npm install --global @holaxis/aslite@0.1.0-pre.3");
  const successor = rollbackOperation({
    target: "successor-preview",
    recoveryTarget: "successor-stable",
    failedVersion: "0.1.1-pre.1",
    restoreTags: { next: "0.1.0" },
    recoveryVersion: "0.1.0",
  });
  assert.equal(successor.argvs[1][2], "superbee@0.1.1-pre.1");
  assert.equal(successor.recovery_command, "npm install --global superbee@0.1.0");
  const firstStable = rollbackOperation({
    target: "successor-stable",
    recoveryTarget: "bridge",
    failedVersion: "0.1.0",
    removeTags: ["next"],
    recoveryVersion: "0.1.0-pre.11",
  });
  assert.equal(firstStable.argvs[0].join(" "), "npm dist-tag rm superbee next");
  assert.ok(!firstStable.commands.some((command) => command.includes("superbee@0.0.1")), "placeholder is not presented as a rollback target");
  assert.equal(firstStable.recovery_command, "npm install --global @holaxis/aslite@0.1.0-pre.11");
  const promotedStable = rollbackOperation({
    target: "successor-stable",
    recoveryTarget: "bridge",
    failedVersion: "0.1.0",
    restoreTags: { latest: "0.0.1" },
    removeTags: ["next"],
    recoveryVersion: "0.1.0-pre.11",
  });
  assert.deepEqual(promotedStable.argvs.slice(0, 2), [
    ["npm", "dist-tag", "add", "superbee@0.0.1", "latest"],
    ["npm", "dist-tag", "rm", "superbee", "next"],
  ]);
  assert.match(promotedStable.argvs[2][3], /install @holaxis\/aslite@0\.1\.0-pre\.11/);
  assert.throws(
    () => rollbackOperation({ target: "successor-stable", recoveryTarget: "bridge", failedVersion: "0.1.0", removeTags: ["next"] }),
    /explicit recovery version/,
  );
  assert.throws(
    () => rollbackOperation({ ...BRIDGE, failedVersion: "0.1.0-pre.4", restoreTags: { next: "0.1.0-pre.3" }, removeTags: ["next"] }),
    /cannot be restored and removed/,
  );
});

test("registry instructions are read-only and delegate strict proof to the verifier", () => {
  const v = registryVerifyOperations({ ...BRIDGE, version: "0.1.0-pre.4" });
  assert.ok(v.commands.includes("npm view @holaxis/aslite@0.1.0-pre.4 dist.integrity dist.shasum --json"));
  assert.ok(v.commands.includes("npm pack @holaxis/aslite@0.1.0-pre.4 --json --ignore-scripts"));
  assert.match(v.workflow_proof, /release-verify-registry\.mjs/);
  assert.ok(!v.commands.some((c) => c.includes("audit signatures --package")), "npm has no audit signatures --package option");
  assert.ok(!v.commands.some((c) => /dist-tag|publish|deprecate|stage (approve|reject)/.test(c)));
  assert.match(registryVerifyOperations({ target: "successor-preview", version: "0.1.1-pre.1" }).workflow_proof, /--target successor-preview/);
});

test("promote and immutable release name the exact version/tag/release id", () => {
  assert.equal(promoteOperation({ ...BRIDGE, version: "0.1.0", tag: "latest" }).command, "npm dist-tag add @holaxis/aslite@0.1.0 latest");
  assert.equal(
    promoteOperation({ target: "successor-stable", version: "0.1.0", tag: "latest" }).command,
    "npm dist-tag add superbee@0.1.0 latest",
  );
  const rel = immutableReleaseOperations({ releaseId: "rel-42", tag: "v0.1.0", githubLatest: true });
  assert.ok(rel.commands[0].includes("releases/rel-42"));
  assert.ok(rel.commands[1].includes("-f draft=false"));
});

// ── SECURITY: injection-shaped inputs are REJECTED at construction (no argv is ever built) ──
test("injection-shaped version / id / stage-id / tag are refused, not interpolated", () => {
  const injections = [
    () => rejectOperation({ stageId: "nope; touch ./INJECTED_PROOF; true" }),
    () => approveOperation({ stageId: "$(touch x)" }),
    () => secondaryTagOperation({ ...BRIDGE, version: "0.1.0; rm -rf /", tag: "next" }),
    () => secondaryTagOperation({ ...BRIDGE, version: "0.1.0", tag: "next && echo bad" }),
    () => promoteOperation({ ...BRIDGE, version: "0.1.0 | cat", tag: "latest" }),
    () => rollbackOperation({ ...BRIDGE, failedVersion: "0.1.0`id`", restoreTags: { next: "0.1.0" } }),
    () => registryVerifyOperations({ ...BRIDGE, version: "0.1.0\nid" }),
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
    () => secondaryTagOperation({ ...BRIDGE, version: "0.1.0", tag: "--otp=0" }),
    () => removeSecondaryTagOperation({ ...BRIDGE, tag: "--" }),
    () => rollbackOperation({ ...BRIDGE, failedVersion: "0.1.0", removeTags: ["-next"] }),
    () => promoteOperation({ ...BRIDGE, version: "0.1.0", tag: "-latest" }),
    () => inspectionInstructions({ ...BRIDGE, stageId: "-s", tarballSha256: SHA, version: "0.1.0" }),
    () => immutableReleaseOperations({ releaseId: "--jq", tag: "v0.1.0" }),
    () => immutableReleaseOperations({ releaseId: "rel-1", tag: "-v0.1.0" }),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, /invalid (stageId|tag|rollback tag|releaseId)/);
  }
});

test("missing required arguments fail closed", () => {
  assert.throws(() => rejectOperation({}), /invalid stageId/);
  assert.throws(() => secondaryTagOperation({ ...BRIDGE, version: "1.0.0" }), /invalid tag/);
  assert.throws(() => rollbackOperation({ ...BRIDGE, failedVersion: "1.0.0" }), /at least one tag/);
  assert.throws(() => immutableReleaseOperations({ releaseId: "r" }), /invalid tag/);
});

test("operationsFor resolves each op to the same argv + display strings", () => {
  assert.deepEqual(operationsFor("reject", ["--stage-id", "s1"]), [
    { argv: ["npm", "stage", "reject", "s1"], command: "npm stage reject s1", requires_2fa: true },
  ]);
  assert.deepEqual(
    operationsFor("registry-verify", ["--target", "bridge", "--version", "0.1.0-pre.11"]).map((o) => o.command),
    registryVerifyOperations({ ...BRIDGE, version: "0.1.0-pre.11" }).commands,
  );
  assert.deepEqual(operationsFor("immutable-release", ["--target", "successor-stable", "--version", "0.1.0", "--release-id", "rel-9"]).map((o) => o.argv), [
    ["gh", "api", "repos/{owner}/{repo}/releases/rel-9", "--jq", ".draft, .tag_name, .id"],
    ["gh", "api", "-X", "PATCH", "repos/{owner}/{repo}/releases/rel-9", "-f", "draft=false", "-f", "make_latest=true"],
  ]);
  assert.match(
    operationsFor("immutable-release", ["--target", "successor-preview", "--version", "0.1.1-pre.1", "--release-id", "rel-10"])[1].command,
    /make_latest=false/,
  );
  assert.deepEqual(
    operationsFor("rollback", [
      "--target", "successor-stable", "--from-state", "stable_staged",
    ]).map((o) => o.command),
    [
      "npm dist-tag rm superbee next",
      "npm deprecate superbee@0.1.0 \"superseded - install @holaxis/aslite@0.1.0-pre.11 (npm install --global @holaxis/aslite@0.1.0-pre.11)\"",
    ],
  );
  assert.deepEqual(
    operationsFor("rollback", [
      "--target", "successor-preview", "--from-state", "preview_staged_or_settled",
    ]).map((o) => o.command),
    [
      "npm dist-tag add superbee@0.1.0 next",
      "npm deprecate superbee@0.1.1-pre.1 \"superseded - install superbee@0.1.0 (npm install --global superbee@0.1.0)\"",
    ],
  );
  assert.throws(() => operationsFor("bogus", []), /unknown op/);
});

test("executable operations derive publication and rollback policy from reviewed tuples", () => {
  assert.equal(
    operationsFor("promote", ["--target", "successor-stable", "--version", "0.1.0"])[0].command,
    "npm dist-tag add superbee@0.1.0 latest",
  );
  assert.throws(
    () => operationsFor("promote", ["--target", "successor-stable", "--version", "9.9.9"]),
    /differs from reviewed successor-stable version/,
  );
  assert.throws(
    () => operationsFor("promote", ["--target", "successor-stable", "--version", "0.1.0", "--tag", "next"]),
    /unexpected operation argument "--tag"/,
  );
  assert.throws(
    () => operationsFor("promote", ["--target", "successor-preview", "--version", "0.1.1-pre.1"]),
    /has no npm promotion/,
  );
  assert.throws(
    () => operationsFor("immutable-release", ["--target", "successor-preview", "--version", "0.1.1-pre.1", "--release-id", "rel-10", "--github-latest", "true"]),
    /unexpected operation argument "--github-latest"/,
  );
  assert.throws(
    () => operationsFor("immutable-release", ["--target", "successor-stable", "--version", "0.1.0", "--version", "9.9.9", "--release-id", "rel-9"]),
    /duplicate operation flag --version/,
  );

  assert.deepEqual(
    operationsFor("rollback", ["--target", "successor-stable", "--from-state", "stable_promoted"]).map((operation) => operation.command),
    [
      "npm dist-tag add superbee@0.0.1 latest",
      "npm dist-tag rm superbee next",
      "npm deprecate superbee@0.1.0 \"superseded - install @holaxis/aslite@0.1.0-pre.11 (npm install --global @holaxis/aslite@0.1.0-pre.11)\"",
    ],
  );
  assert.deepEqual(
    operationsFor("rollback", ["--target", "bridge", "--from-state", "bridge_settled"]).map((operation) => operation.command),
    [
      "npm dist-tag add @holaxis/aslite@0.1.0-pre.8 latest",
      "npm dist-tag add @holaxis/aslite@0.1.0-pre.8 next",
      "npm deprecate @holaxis/aslite@0.1.0-pre.11 \"superseded - install @holaxis/aslite@0.1.0-pre.8 (npm install --global @holaxis/aslite@0.1.0-pre.8)\"",
    ],
  );
  assert.throws(
    () => operationsFor("rollback", ["--target", "successor-stable", "--from-state", "stable_failed"]),
    /does not allow --from-state/,
  );
  assert.throws(
    () => operationsFor("rollback", ["--target", "successor-stable", "--from-state", "stable_staged", "--restore-tag", "latest=9.9.9"]),
    /unexpected operation argument "--restore-tag"/,
  );
});

test("human npm stage decisions can be rendered but never auto-executed", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [runOps, "--op", "approve", "--stage-id", "stage-1", "--execute"]),
    (error) => {
      assert.match(String(error.stderr ?? error.message), /requires a human npm 2FA command/);
      return true;
    },
  );
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
