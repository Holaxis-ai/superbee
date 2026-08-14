import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { observedCheckout, staticPacketClosure } from "./release-packet.mjs";
import { immutableReleaseOperations, promoteOperation, rollbackOperation } from "./release-operations.mjs";
import { operationsFor } from "./release-run-operations.mjs";
import { resolveTargetFacts } from "./release-resolve-target.mjs";
import { resolveTags } from "./release-state.mjs";
import { reconcile } from "./release-state.mjs";
import { loadReleaseTargets } from "./release-targets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => path.join(repoRoot, "scripts", name);

test("five reviewed target tuples bind stable and preview policy explicitly", async () => {
  const manifest = await loadReleaseTargets();
  assert.deepEqual(Object.keys(manifest.targets).sort(), ["bridge", "rehearsal-approve", "rehearsal-reject", "successor-preview", "successor-stable"]);
  assert.deepEqual(Object.keys(manifest.allowed_tuples).sort(), ["bridge", "rehearsal-approve", "rehearsal-reject", "successor-preview", "successor-stable"]);
  assert.equal(manifest.functional_successor_floor, "0.1.0");
  assert.equal(new Set(Object.values(manifest.allowed_tuples).map((tuple) => tuple.version)).size, 5);
  assert.equal(new Set(Object.values(manifest.allowed_tuples).map((tuple) => tuple.tag)).size, 5);
  assert.deepEqual(manifest.allowed_tuples.bridge.publication, { npm_tag: "next", npm_promote_tag: "latest", github_latest: false });
  assert.deepEqual(manifest.allowed_tuples["successor-stable"].publication, { npm_tag: "next", npm_promote_tag: "latest", github_latest: true });
  assert.deepEqual(manifest.allowed_tuples["successor-preview"].publication, { npm_tag: "next", npm_promote_tag: null, github_latest: false });
  assert.deepEqual(await resolveTargetFacts({ target: "successor-preview", tag: "v0.1.1-pre.1" }), {
    target: "successor-preview", package: "superbee", version: "0.1.1-pre.1", tag: "v0.1.1-pre.1",
    policy_tag: "next", npm_promote_tag: null, github_latest: false, workflow_contract: "full",
  });
});

test("observed checkout permits only named normal ignored build outputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-pr7-checkout-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "test"], { cwd: root });
    await writeFile(path.join(root, ".gitignore"), "node_modules/\nunexpected/\n");
    await writeFile(path.join(root, "tracked"), "ok\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
    await writeFile(path.join(root, "node_modules", ".keep"), "ok\n", { recursive: true }).catch(async () => {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "node_modules"), { recursive: true }));
      await writeFile(path.join(root, "node_modules", ".keep"), "ok\n");
    });
    assert.equal((await observedCheckout(root)).dirty, false);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "unexpected"), { recursive: true }));
    await writeFile(path.join(root, "unexpected", "input.js"), "bad\n");
    assert.equal((await observedCheckout(root)).dirty, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target-sensitive operations require a target and preview cannot become GitHub latest", () => {
  assert.throws(() => promoteOperation({ version: "0.1.0", tag: "latest" }), /target/);
  assert.equal(promoteOperation({ target: "successor-stable", version: "0.1.0", tag: "latest" }).command, "npm dist-tag add superbee@0.1.0 latest");
  assert.ok(immutableReleaseOperations({ releaseId: "rel-1", tag: "v0.1.1-pre.1", githubLatest: false }).commands[1].includes("make_latest=false"));
});

test("live operation adapter rejects caller-selected release policy", () => {
  assert.throws(
    () => operationsFor("promote", ["--target", "successor-stable", "--version", "9.9.9"]),
    /differs from reviewed successor-stable version/,
  );
  assert.throws(
    () => operationsFor("promote", ["--target", "successor-stable", "--version", "0.1.0", "--tag", "next"]),
    /unexpected operation argument "--tag"/,
  );
  assert.throws(
    () => operationsFor("immutable-release", ["--target", "successor-preview", "--version", "0.1.1-pre.1", "--release-id", "42", "--github-latest", "true"]),
    /unexpected operation argument "--github-latest"/,
  );
  assert.match(
    operationsFor("immutable-release", ["--target", "successor-preview", "--version", "0.1.1-pre.1", "--release-id", "42"])[1].command,
    /make_latest=false/,
  );
});

test("a post-stable preview settles next without moving latest", () => {
  assert.deepEqual(resolveTags({ kind: "prerelease", phase: "promoted", version: "0.1.1-pre.1", priorLatest: "0.1.0", priorNext: "0.1.0" }), {
    latest: "0.1.0", next: "0.1.1-pre.1",
  });
});

test("initial stable failure removes next and directs recovery to the working bridge", async () => {
  const policy = JSON.parse(await readFile(path.join(repoRoot, "release", "superbee-cutover.json"), "utf8"));
  const failed = policy.legal_states.find((state) => state.id === "stable_failed");
  assert.deepEqual(failed.tags, { latest: "0.0.1", next: null });
  const rollback = rollbackOperation({
    target: "successor-stable",
    failedVersion: policy.stable.version,
    removeTags: ["next"],
    recoveryTarget: "bridge",
    recoveryVersion: "0.1.0-pre.11",
  });
  assert.equal(rollback.commands[0], "npm dist-tag rm superbee next");
  assert.ok(!rollback.commands.some((command) => command.includes("superbee@0.0.1 next")));
  assert.equal(rollback.recovery_command, "npm install --global @holaxis/aslite@0.1.0-pre.11");
});

test("ordering state requires an explicit immutable target", () => {
  assert.throws(() => reconcile({ state: null, identifiers: {} }, { to: "prepared", receipt: {
    version: "0.1.0", tag: "v0.1.0", source_commit: "a".repeat(40), run_id: "1", artifact_id: "2", artifact_digest: "sha256:" + "a".repeat(64), tarball_sha256: "sha256:" + "b".repeat(64), integrity: "sha512-x",
  } }), /requires receipt.target/);
});

test("release entrypoint guards execute through symlinks rather than exiting successfully", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-pr7-symlink-"));
  try {
    for (const name of ["release-env.mjs", "release-packet.mjs"]) {
      const linked = path.join(root, name);
      await symlink(script(name), linked);
      const run = spawnSync(process.execPath, [linked, ...(name === "release-env.mjs" ? ["require-live"] : ["verify"])], { encoding: "utf8" });
      assert.notEqual(run.status, 0, `${name} must execute and reject through a symlink`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static closure rejects direct CommonJS require in a .js entrypoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-pr7-require-"));
  try {
    await writeFile(path.join(root, "entry.js"), 'const hidden = require("./hidden.js");\nexport default hidden;\n');
    await writeFile(path.join(root, "hidden.js"), "module.exports = true;\n");
    await assert.rejects(staticPacketClosure({ root, entries: ["entry.js"] }), /CommonJS|require/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documented packet route is an npm script, so npm_execpath is supplied", () => {
  return readFile(path.join(repoRoot, "package.json"), "utf8").then((text) => {
    assert.equal(JSON.parse(text).scripts["release:packet"], "node scripts/release-packet.mjs");
  });
});

test("packet lexer is a production root dependency for an omit-dev operator checkout", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  assert.equal(pkg.dependencies["es-module-lexer"], "1.7.0");
  assert.equal(lock.packages[""].dependencies["es-module-lexer"], "1.7.0");
  assert.equal(Object.hasOwn(lock.packages["node_modules/es-module-lexer"], "dev"), false);
});
