/**
 * `skill install|status|uninstall` — destructive-write boundary tests (same discipline as the
 * hook suite): manifest-tracked installs, refusal of anything unmanaged, convergent reinstall,
 * exact-manifest uninstall, and env-var host relocation for --scope user.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  lstatSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SKILL_MANIFEST_FILENAME,
  isSafeManifestEntry,
  resolveSkillAssets,
  skill,
  skillRefreshScopes,
  skillStatusForDir,
  skillTargets,
} from "../src/commands/skill.js";
import { CliError } from "../src/errors.js";
import { cliVersion } from "../src/build-identity.js";
import type { PersistentInstallAuthority } from "../src/install-authority.js";

const RUNNING_VERSION = cliVersion();

const ASSET_FILES: Record<string, string> = {
  "SKILL.md": "---\nname: superbee\n---\n# superbee\n",
  "references/views/view-authoring.md": "# views contract\n",
  "references/recipes/claims/recipe.md": "# claims recipe\n",
};

/** Build a fake npm-layout distribution root; returns its dist executable path. */
function makeDistribution(root: string, version = "9.9.9", files: Record<string, string> = ASSET_FILES): string {
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "superbee.mjs"), "// bundle\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "superbee", version }) + "\n");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return path.join(root, "dist", "superbee.mjs");
}

function scratch(): { base: string; executable: string } {
  const base = mkdtempSync(path.join(tmpdir(), "aslite-skill-cmd-"));
  const executable = makeDistribution(path.join(base, "pkg"));
  return { base, executable };
}

async function runSkill(
  argv: string[],
  deps: {
    cwd?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    executable?: string;
    installAuthority?: () => PersistentInstallAuthority;
  },
): Promise<Record<string, any>> {
  let out = "";
  await skill([...argv, "--json"], { env: {}, ...deps, stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, any>;
}

/** Every file under `dir` mapped to its bytes (posix-relative), for byte-stability snapshots. */
function treeSnapshot(dir: string, prefix = ""): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  if (!existsSync(dir)) return snapshot;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of treeSnapshot(path.join(dir, entry.name), relative)) snapshot.set(key, value);
    } else {
      snapshot.set(relative, readFileSync(path.join(dir, entry.name)));
    }
  }
  return snapshot;
}

function assertSameTree(a: Map<string, Buffer>, b: Map<string, Buffer>): void {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const [key, bytes] of a) assert.ok(b.get(key)!.equals(bytes), `${key} bytes changed`);
}

function hostSkillDir(cwd: string, host: ".claude" | ".codex", name: "superbee" | "aslite"): string {
  return path.join(cwd, host, "skills", name);
}

function moveCanonicalToLegacy(cwd: string, host: ".claude" | ".codex"): void {
  renameSync(hostSkillDir(cwd, host, "superbee"), hostSkillDir(cwd, host, "aslite"));
}

test("skill install (project scope): assets + manifest land in BOTH host folders; reinstall is byte-stable and changed:false", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });

  const receipt = await runSkill(["install"], { cwd, executable });
  assert.equal(receipt.skill.action, "install");
  assert.equal(receipt.skill.changed, true);
  assert.equal(receipt.skill.restart_required, true);
  assert.deepEqual(receipt.skill.affected_hosts, ["claude_code", "codex"]);
  assert.equal(receipt.skill.version, RUNNING_VERSION);

  for (const host of [".claude", ".codex"]) {
    const dir = path.join(cwd, host, "skills", "superbee");
    assert.equal(existsSync(path.join(cwd, host, "skills", "aslite")), false);
    for (const [relative, content] of Object.entries(ASSET_FILES)) {
      assert.equal(readFileSync(path.join(dir, ...relative.split("/")), "utf8"), content);
    }
    const manifest = JSON.parse(readFileSync(path.join(dir, SKILL_MANIFEST_FILENAME), "utf8"));
    assert.equal(manifest.package, "superbee");
    assert.equal(manifest.version, RUNNING_VERSION);
    assert.equal(manifest.installed_by, "superbee skill install");
    assert.deepEqual(manifest.files, Object.keys(ASSET_FILES).sort());
    assert.deepEqual(Object.keys(manifest), [
      "schema",
      "package",
      "version",
      "installed_by",
      "compatibility_contract",
      "source_identity",
      "files",
      "file_sha256",
    ]);
    assert.equal(manifest.schema, "aslite.skill-manifest.v2");
    assert.equal(manifest.compatibility_contract, 1);
    assert.equal(manifest.source_identity.release_version, RUNNING_VERSION);
    assert.equal(manifest.source_identity.artifact_channel, "local-dev");
    assert.deepEqual(Object.keys(manifest.file_sha256), manifest.files);
    for (const relative of manifest.files) {
      const expected = `sha256:${createHash("sha256")
        .update(readFileSync(path.join(dir, ...relative.split("/"))))
        .digest("hex")}`;
      assert.equal(manifest.file_sha256[relative], expected);
    }
  }

  const before = treeSnapshot(path.join(cwd, ".claude"));
  const again = await runSkill(["install"], { cwd, executable });
  assert.equal(again.skill.changed, false);
  assert.equal(again.skill.restart_required, false);
  assert.deepEqual(again.skill.affected_hosts, []);
  assert.equal(again.skill.hosts.claude_code.changed, false);
  assert.equal(again.skill.hosts.codex.changed, false);
  assertSameTree(before, treeSnapshot(path.join(cwd, ".claude")));
});

test("skill refresh scopes reuse managed-byte classification and self-clear after reinstall", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });

  assert.deepEqual(skillRefreshScopes({ cwd, home, env: {}, executable }), []);
  await runSkill(["install"], { cwd, home, executable });
  assert.deepEqual(skillRefreshScopes({ cwd, home, env: {}, executable }), []);

  writeFileSync(path.join(cwd, ".codex", "skills", "superbee", "SKILL.md"), "stale\n");
  assert.deepEqual(skillRefreshScopes({ cwd, home, env: {}, executable }), ["project"]);

  await runSkill(["install"], { cwd, home, executable });
  assert.deepEqual(skillRefreshScopes({ cwd, home, env: {}, executable }), []);

  const unmanaged = path.join(home, ".codex", "skills", "superbee");
  mkdirSync(unmanaged, { recursive: true });
  writeFileSync(path.join(unmanaged, "foreign.md"), "foreign\n");
  assert.deepEqual(skillRefreshScopes({ cwd, home, env: {}, executable }), []);
});

test("old-only owned installs migrate atomically to canonical and status reports both paths", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  for (const host of [".claude", ".codex"] as const) moveCanonicalToLegacy(cwd, host);

  const before = await runSkill(["status"], { cwd, executable });
  assert.equal(before.skill.hosts.claude_code.canonical.state, "absent");
  assert.equal(before.skill.hosts.claude_code.legacy.state, "installed");
  assert.match(before.skill.hosts.claude_code.canonical.path, /skills\/superbee$/);
  assert.match(before.skill.hosts.claude_code.legacy.path, /skills\/aslite$/);

  const receipt = await runSkill(["install"], { cwd, executable });
  assert.equal(receipt.skill.hosts.claude_code.migrated, true);
  assert.equal(receipt.skill.hosts.codex.migrated, true);
  for (const host of [".claude", ".codex"] as const) {
    assert.equal(existsSync(hostSkillDir(cwd, host, "aslite")), false);
    assert.ok(existsSync(path.join(hostSkillDir(cwd, host, "superbee"), "SKILL.md")));
  }
  const manifest = JSON.parse(
    readFileSync(path.join(hostSkillDir(cwd, ".claude", "superbee"), SKILL_MANIFEST_FILENAME), "utf8"),
  );
  assert.equal(manifest.schema, "aslite.skill-manifest.v2");
});

test("an old-only manifest-first partial install migrates and converges", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  moveCanonicalToLegacy(cwd, ".claude");
  const legacyDir = hostSkillDir(cwd, ".claude", "aslite");
  rmSync(path.join(legacyDir, "SKILL.md"));

  const before = await runSkill(["status"], { cwd, executable });
  assert.equal(before.skill.hosts.claude_code.legacy.state, "stale");
  const receipt = await runSkill(["install"], { cwd, executable });
  assert.equal(receipt.skill.hosts.claude_code.migrated, true);
  assert.equal(readFileSync(path.join(hostSkillDir(cwd, ".claude", "superbee"), "SKILL.md"), "utf8"), ASSET_FILES["SKILL.md"]);
  assert.equal(existsSync(legacyDir), false);
});

test("dual owned canonical and legacy installs fail closed without changing either tree", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  const canonical = hostSkillDir(cwd, ".claude", "superbee");
  const legacy = hostSkillDir(cwd, ".claude", "aslite");
  cpSync(canonical, legacy, { recursive: true });
  const canonicalBefore = treeSnapshot(canonical);
  const legacyBefore = treeSnapshot(legacy);

  await assert.rejects(
    () => runSkill(["install"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(JSON.stringify(err.details), /both canonical and legacy folders are owned/);
      return true;
    },
  );
  assertSameTree(canonicalBefore, treeSnapshot(canonical));
  assertSameTree(legacyBefore, treeSnapshot(legacy));
});

test("foreign canonical blocks migration and leaves an owned legacy install untouched", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  moveCanonicalToLegacy(cwd, ".claude");
  const canonical = hostSkillDir(cwd, ".claude", "superbee");
  const legacy = hostSkillDir(cwd, ".claude", "aslite");
  mkdirSync(canonical, { recursive: true });
  writeFileSync(path.join(canonical, "SKILL.md"), "# foreign canonical skill\n");
  const canonicalBefore = treeSnapshot(canonical);
  const legacyBefore = treeSnapshot(legacy);

  await assert.rejects(() => runSkill(["install"], { cwd, executable }), CliError);
  assertSameTree(canonicalBefore, treeSnapshot(canonical));
  assertSameTree(legacyBefore, treeSnapshot(legacy));
});

test("foreign legacy coexists with canonical install and is refused but preserved on uninstall", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const legacy = hostSkillDir(cwd, ".claude", "aslite");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "SKILL.md"), "# foreign legacy skill\n");

  const receipt = await runSkill(["install"], { cwd, executable });
  assert.equal(receipt.skill.hosts.claude_code.legacy_state_before, "unmanaged");
  assert.ok(existsSync(path.join(hostSkillDir(cwd, ".claude", "superbee"), "SKILL.md")));
  assert.equal(readFileSync(path.join(legacy, "SKILL.md"), "utf8"), "# foreign legacy skill\n");
  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "installed");
  assert.equal(status.skill.hosts.claude_code.legacy.state, "unmanaged");

  await assert.rejects(() => runSkill(["uninstall"], { cwd, executable }), CliError);
  assert.equal(existsSync(hostSkillDir(cwd, ".claude", "superbee")), false);
  assert.equal(readFileSync(path.join(legacy, "SKILL.md"), "utf8"), "# foreign legacy skill\n");
  assert.equal(existsSync(hostSkillDir(cwd, ".codex", "superbee")), false);
});

test("uninstall removes both canonical and legacy when both independently prove ownership", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  for (const host of [".claude", ".codex"] as const) {
    cpSync(hostSkillDir(cwd, host, "superbee"), hostSkillDir(cwd, host, "aslite"), { recursive: true });
  }

  const receipt = await runSkill(["uninstall"], { cwd, executable });
  assert.equal(receipt.skill.changed, true);
  for (const host of [".claude", ".codex"] as const) {
    assert.equal(existsSync(hostSkillDir(cwd, host, "superbee")), false);
    assert.equal(existsSync(hostSkillDir(cwd, host, "aslite")), false);
  }
});

test("skill install refuses a pre-existing unmanaged folder (nothing written there); the other host is still processed", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const claudeDir = path.join(cwd, ".claude", "skills", "superbee");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, "somebody-elses.md"), "not ours\n");

  await assert.rejects(
    () => runSkill(["install"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /refused 1 target folder/);
      return true;
    },
  );
  // Refused folder untouched: the foreign file survives, no manifest, no assets.
  assert.deepEqual(readdirSync(claudeDir), ["somebody-elses.md"]);
  // The codex target was still processed to completion.
  assert.ok(existsSync(path.join(cwd, ".codex", "skills", "superbee", SKILL_MANIFEST_FILENAME)));
});

test("hand-edited managed files: status reports stale, reinstall converges back to installed", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });

  const edited = path.join(cwd, ".claude", "skills", "superbee", "SKILL.md");
  writeFileSync(edited, "tampered\n");

  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "stale");
  assert.equal(status.skill.hosts.codex.state, "installed");

  const receipt = await runSkill(["install"], { cwd, executable });
  assert.equal(receipt.skill.hosts.claude_code.changed, true);
  assert.equal(receipt.skill.hosts.codex.changed, false);
  assert.equal(receipt.skill.restart_required, true);
  assert.deepEqual(receipt.skill.affected_hosts, ["claude_code"]);
  assert.equal(readFileSync(edited, "utf8"), ASSET_FILES["SKILL.md"]);
  const after = await runSkill(["status"], { cwd, executable });
  assert.equal(after.skill.hosts.claude_code.state, "installed");
});

test("skill status: absent before install, unmanaged for a manifest-less folder, version reported when installed", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(path.join(cwd, ".codex", "skills", "superbee"), { recursive: true });
  writeFileSync(path.join(cwd, ".codex", "skills", "superbee", "stray.md"), "x\n");

  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "absent");
  assert.equal(status.skill.hosts.codex.state, "unmanaged");

  rmSync(path.join(cwd, ".codex"), { recursive: true, force: true });
  await runSkill(["install"], { cwd, executable });
  const installed = await runSkill(["status"], { cwd, executable });
  assert.equal(installed.skill.hosts.claude_code.state, "installed");
  assert.equal(installed.skill.hosts.claude_code.version, RUNNING_VERSION);
  assert.deepEqual(installed.skill.hosts.claude_code.compatibility, {
    state: "current",
    reason: null,
    installed_contract: 1,
    running_contract: 1,
    remedy: { action: "none", command: null },
  });
});

test("legacy owned receipts remain current and explicit install refreshes only the receipt", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  const manifestPath = path.join(dir, SKILL_MANIFEST_FILENAME);
  const current = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      package: "aslite",
      version: "0.0.1",
      installed_by: "aslite skill install",
      files: current.files,
    }, null, 2)}\n`,
  );
  const assetsBefore = new Map(
    current.files.map((relative: string) => [relative, readFileSync(path.join(dir, ...relative.split("/")))]),
  );

  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "installed");
  assert.equal(status.skill.hosts.claude_code.compatibility.state, "current");
  assert.equal(status.skill.hosts.claude_code.compatibility.reason, "legacy_receipt");

  await runSkill(["install"], { cwd, executable });
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).schema, "aslite.skill-manifest.v2");
  for (const [relative, bytes] of assetsBefore) {
    assert.ok(readFileSync(path.join(dir, ...relative.split("/"))).equals(bytes));
  }
});

test("matching assets ignore informational provenance while digest corruption is owned-stale", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  const manifestPath = path.join(cwd, ".claude", "skills", "superbee", SKILL_MANIFEST_FILENAME);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "99.0.0";
  manifest.source_identity = {
    release_version: "99.0.0",
    source_commit: "c".repeat(40),
    artifact_channel: "npm-package",
    artifact_sha256: null,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  let status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "installed");
  assert.equal(status.skill.hosts.claude_code.compatibility.state, "current");

  manifest.file_sha256["SKILL.md"] = `sha256:${"0".repeat(64)}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "stale");
  assert.equal(status.skill.hosts.claude_code.compatibility.reason, "receipt_invalid");
});

test("higher installed skill contracts are reported and never silently downgraded", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  const manifestPath = path.join(dir, SKILL_MANIFEST_FILENAME);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.compatibility_contract = 2;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const before = treeSnapshot(dir);

  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "installed");
  assert.equal(status.skill.hosts.claude_code.compatibility.state, "newer_contract");
  await assert.rejects(
    () => runSkill(["install"], { cwd, executable }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(String(error.details?.refused), /newer compatibility contract/);
      return true;
    },
  );
  assertSameTree(before, treeSnapshot(dir));
});

test("ownership field near-misses are never mutated", async () => {
  const candidates = [
    { ...scratch(), mutation: (manifest: any) => ({ ...manifest, package: "foreign" }) },
    { ...scratch(), mutation: (manifest: any) => ({ ...manifest, installed_by: "aslite skill install " }) },
  ];
  for (const candidate of candidates) {
    const cwd = path.join(candidate.base, "project");
    await runSkill(["install"], { cwd, executable: candidate.executable });
    const dir = path.join(cwd, ".claude", "skills", "superbee");
    const manifestPath = path.join(dir, SKILL_MANIFEST_FILENAME);
    const manifest = candidate.mutation(JSON.parse(readFileSync(manifestPath, "utf8")));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = treeSnapshot(dir);
    await assert.rejects(() => runSkill(["install"], { cwd, executable: candidate.executable }));
    assertSameTree(before, treeSnapshot(dir));
    await assert.rejects(() => runSkill(["uninstall"], { cwd, executable: candidate.executable }));
    assertSameTree(before, treeSnapshot(dir));
  }
});

test("a symlinked manifest never establishes ownership and neither mutator follows it", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  const manifestPath = path.join(dir, SKILL_MANIFEST_FILENAME);
  const victim = path.join(base, "outside-manifest.json");
  const victimBytes = readFileSync(manifestPath);
  writeFileSync(victim, victimBytes);
  rmSync(manifestPath);
  symlinkSync(victim, manifestPath);

  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "unmanaged");
  for (const verb of ["install", "uninstall"]) {
    await assert.rejects(() => runSkill([verb], { cwd, executable }));
    assert.equal(lstatSync(manifestPath).isSymbolicLink(), true);
    assert.ok(readFileSync(victim).equals(victimBytes));
  }
});

test("reserved manifest debris beside a foreign file is preserved on every refusal", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "foreign.md"), "keep\n");
  writeFileSync(path.join(dir, `${SKILL_MANIFEST_FILENAME}.tmp-4242-a1-b2`), "partial\n");
  const before = treeSnapshot(dir);
  for (const verb of ["install", "uninstall"]) {
    await assert.rejects(() => runSkill([verb], { cwd, executable }));
    assertSameTree(before, treeSnapshot(dir));
  }
});

test("backslash-traversal manifests make both mutators refuse without changing target bytes", async () => {
  for (const verb of ["install", "uninstall"]) {
    const { base, executable } = scratch();
    const cwd = path.join(base, "project");
    const dir = path.join(cwd, ".claude", "skills", "superbee");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "owned-looking\n");
    writeFileSync(
      path.join(dir, SKILL_MANIFEST_FILENAME),
      `${JSON.stringify({
        package: "@holaxis/aslite",
        version: RUNNING_VERSION,
        installed_by: "aslite skill install",
        files: ["SKILL.md", "references/..\\..\\victim.txt"],
      }, null, 2)}\n`,
    );
    const before = treeSnapshot(dir);
    await assert.rejects(() => runSkill([verb], { cwd, executable }));
    assertSameTree(before, treeSnapshot(dir));
  }
});

test("a failed persistent-install authority preflight leaves both host targets untouched", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const claudeDir = path.join(cwd, ".claude", "skills", "superbee");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, "foreign.md"), "keep\n");
  const beforeClaude = treeSnapshot(claudeDir);

  await assert.rejects(
    () =>
      runSkill(["install"], {
        cwd,
        executable,
        installAuthority: () => ({
          allowed: false,
          state: "unknown",
          reason: "transient npx cache",
          evidence: { npm_prefix: null, bin_path: null, executable_path: executable, runtime_path: process.execPath },
        }),
      }),
    /durable npm-global CLI/,
  );
  assertSameTree(beforeClaude, treeSnapshot(claudeDir));
  assert.equal(existsSync(path.join(cwd, ".codex")), false);
});

test("skill uninstall removes exactly the managed folders and leaves foreign sibling skills untouched", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const foreign = path.join(cwd, ".claude", "skills", "somebody-else");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(path.join(foreign, "SKILL.md"), "# foreign skill\n");
  await runSkill(["install"], { cwd, executable });

  const receipt = await runSkill(["uninstall"], { cwd, executable });
  assert.equal(receipt.skill.changed, true);
  assert.equal(existsSync(path.join(cwd, ".claude", "skills", "superbee")), false);
  assert.equal(existsSync(path.join(cwd, ".codex", "skills", "superbee")), false);
  assert.equal(readFileSync(path.join(foreign, "SKILL.md"), "utf8"), "# foreign skill\n");

  // Uninstalling again is a no-op, exit 0.
  const again = await runSkill(["uninstall"], { cwd, executable });
  assert.equal(again.skill.changed, false);
});

test("skill uninstall refuses unmanifested extra files — nothing at all is deleted", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  writeFileSync(path.join(dir, "user-notes.md"), "keep me\n");

  await assert.rejects(
    () => runSkill(["uninstall"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /refused 1 target folder/);
      return true;
    },
  );
  // The refusing folder kept EVERYTHING: assets, manifest, and the extra file.
  assert.equal(readFileSync(path.join(dir, "user-notes.md"), "utf8"), "keep me\n");
  assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), ASSET_FILES["SKILL.md"]);
  assert.ok(existsSync(path.join(dir, SKILL_MANIFEST_FILENAME)));
  // The clean codex folder was still uninstalled.
  assert.equal(existsSync(path.join(cwd, ".codex", "skills", "superbee")), false);
});

test("skill uninstall refuses a folder with no manifest and a folder whose manifest is malformed", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const claudeDir = path.join(cwd, ".claude", "skills", "superbee");
  const codexDir = path.join(cwd, ".codex", "skills", "superbee");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, "SKILL.md"), "unmanaged copy\n");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(path.join(codexDir, SKILL_MANIFEST_FILENAME), "{not json");

  await assert.rejects(
    () => runSkill(["uninstall"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /refused 2 target folder/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(claudeDir, "SKILL.md"), "utf8"), "unmanaged copy\n");
  assert.ok(existsSync(path.join(codexDir, SKILL_MANIFEST_FILENAME)));
});

test("a manifest naming paths outside the folder is malformed — uninstall refuses, nothing outside is touched", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  mkdirSync(dir, { recursive: true });
  const victim = path.join(cwd, ".claude", "skills", "victim.md");
  writeFileSync(victim, "outside the managed folder\n");
  writeFileSync(
    path.join(dir, SKILL_MANIFEST_FILENAME),
    JSON.stringify({ package: "aslite", version: "1.0.0", installed_by: "x", files: ["../victim.md"] }),
  );

  await assert.rejects(() => runSkill(["uninstall"], { cwd, executable }), CliError);
  assert.equal(readFileSync(victim, "utf8"), "outside the managed folder\n");
  assert.ok(existsSync(path.join(dir, SKILL_MANIFEST_FILENAME)));
});

test("--scope user honors host relocation and --scope global remains an alias", async () => {
  const { base, executable } = scratch();
  const home = path.join(base, "home");
  const claudeHome = path.join(base, "relocated-claude");
  const codexHome = path.join(base, "relocated-codex");
  mkdirSync(home, { recursive: true });

  const env = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  const receipt = await runSkill(["install", "--scope", "user"], { home, env, executable });
  assert.equal(receipt.skill.scope, "user");
  assert.ok(existsSync(path.join(claudeHome, "skills", "superbee", "SKILL.md")));
  assert.ok(existsSync(path.join(codexHome, "skills", "superbee", "SKILL.md")));
  assert.equal(existsSync(path.join(home, ".claude")), false);
  assert.equal(existsSync(path.join(home, ".codex")), false);

  const aliasStatus = await runSkill(["status", "--scope", "global"], { home, env, executable });
  assert.equal(aliasStatus.skill.scope, "user");
  assert.equal(aliasStatus.skill.hosts.claude_code.canonical.state, "installed");
  assert.equal(aliasStatus.skill.hosts.claude_code.legacy.state, "absent");

  await runSkill(["uninstall", "--scope", "global"], { home, env, executable });
  assert.equal(existsSync(path.join(claudeHome, "skills", "superbee")), false);
  assert.equal(existsSync(path.join(codexHome, "skills", "superbee")), false);

  // An EMPTY env value falls back to <home>/.<host> — the shell ${VAR:-default} rule.
  const targets = skillTargets("user", { home, env: { CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" } });
  assert.equal(targets.claude, path.join(home, ".claude", "skills", "superbee"));
  assert.equal(targets.codex, path.join(home, ".codex", "skills", "superbee"));
});

test("a distribution without shipped skill assets is a loud runtime error, not a partial install", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "aslite-skill-noassets-"));
  const root = path.join(base, "bare-pkg");
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "agentstate-lite.mjs"), "// bundle\n");
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await assert.rejects(
    () => runSkill(["install"], { cwd, executable: path.join(root, "dist", "agentstate-lite.mjs") }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /no skill assets/);
      return true;
    },
  );
  assert.equal(existsSync(path.join(cwd, ".claude")), false);
});

test("resolveSkillAssets uses running build version, not stale adjacent manifest, and lists assets", () => {
  const { executable } = scratch();
  const assets = resolveSkillAssets(executable);
  assert.equal(assets.version, RUNNING_VERSION);
  assert.deepEqual(assets.files, Object.keys(ASSET_FILES).sort());
  assert.equal(skillStatusForDir(path.join(assets.root, "does-not-exist"), assets).state, "absent");
});

test("isSafeManifestEntry: traversal, absolute, backslash, NUL, and empty-segment entries are all unsafe", () => {
  const cases: [entry: string, safe: boolean][] = [
    ["SKILL.md", true],
    ["references/views/view-authoring.md", true],
    ["..", false],
    ["../victim.md", false],
    ["references/../../victim.md", false],
    ["/etc/passwd", false],
    ["references\\evil.md", false],
    ["references/\0evil.md", false],
    ["", false],
    ["references//evil.md", false],
    ["./evil.md", false],
    [".", false],
  ];
  for (const [entry, safe] of cases) {
    assert.equal(isSafeManifestEntry(entry), safe, `isSafeManifestEntry(${JSON.stringify(entry)})`);
  }
});

test("a symlinked target folder is refused by install AND uninstall, reported unmanaged by status, and never followed", async () => {
  const { base, executable } = scratch();
  // A REAL managed install the symlink points at — its bytes must never change.
  const victimProject = path.join(base, "victim-project");
  mkdirSync(victimProject, { recursive: true });
  await runSkill(["install"], { cwd: victimProject, executable });
  const victimDir = path.join(victimProject, ".claude", "skills", "superbee");
  const victimBefore = treeSnapshot(victimDir);

  // The attacked project: claude target is a symlink to the victim's managed install.
  const cwd = path.join(base, "linked-project");
  mkdirSync(path.join(cwd, ".claude", "skills"), { recursive: true });
  symlinkSync(victimDir, path.join(cwd, ".claude", "skills", "superbee"));

  // install: refused on the symlinked host, structured error, sibling (codex) still processed.
  await assert.rejects(
    () => runSkill(["install"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /refused 1 target folder/);
      assert.match(JSON.stringify(err.details), /symlink/);
      return true;
    },
  );
  assertSameTree(victimBefore, treeSnapshot(victimDir));
  assert.ok(existsSync(path.join(cwd, ".codex", "skills", "superbee", SKILL_MANIFEST_FILENAME)));

  // status: the symlinked target is honestly unmanaged, never followed into the victim.
  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "unmanaged");
  assert.equal(status.skill.hosts.codex.state, "installed");

  // uninstall: refused on the symlinked host — the pointed-to managed install is byte-untouched
  // and the link survives — while the sibling codex host still uninstalls cleanly (exit 1 overall).
  await assert.rejects(
    () => runSkill(["uninstall"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(JSON.stringify(err.details), /symlink/);
      return true;
    },
  );
  assert.ok(lstatSync(path.join(cwd, ".claude", "skills", "superbee")).isSymbolicLink());
  assertSameTree(victimBefore, treeSnapshot(victimDir));
  assert.equal(existsSync(path.join(cwd, ".codex", "skills", "superbee")), false);
});

test("manifest-first: an interrupted install (manifest present, files missing) is managed-stale — status stale, install converges, uninstall cleans", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");

  // Simulate the interruption point after the manifest write: manifested files missing.
  rmSync(path.join(dir, "SKILL.md"));
  rmSync(path.join(dir, "references"), { recursive: true, force: true });

  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "stale");

  const converge = await runSkill(["install"], { cwd, executable });
  assert.equal(converge.skill.hosts.claude_code.changed, true);
  assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), ASSET_FILES["SKILL.md"]);
  assert.equal((await runSkill(["status"], { cwd, executable })).skill.hosts.claude_code.state, "installed");

  // And a partial state uninstalls without a throw (skip-missing).
  rmSync(path.join(dir, "SKILL.md"));
  const removed = await runSkill(["uninstall"], { cwd, executable });
  assert.equal(removed.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(dir), false);
});

test("a manifested file symlinked to an outside victim: uninstall unlinks the LINK only; install replaces the link; status reports stale", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  const victim = path.join(base, "victim.md");
  // Victim bytes IDENTICAL to the shipped asset — the link must still be detected and replaced.
  writeFileSync(victim, ASSET_FILES["SKILL.md"]);

  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  const linked = path.join(dir, "SKILL.md");
  rmSync(linked);
  symlinkSync(victim, linked);

  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "stale");

  // install replaces the LINK with a real file; the victim is byte-untouched.
  const receipt = await runSkill(["install"], { cwd, executable });
  assert.equal(receipt.skill.hosts.claude_code.changed, true);
  assert.equal(lstatSync(linked).isSymbolicLink(), false);
  assert.equal(readFileSync(victim, "utf8"), ASSET_FILES["SKILL.md"]);

  // uninstall over a re-linked file unlinks the link itself — the victim survives.
  rmSync(linked);
  symlinkSync(victim, linked);
  await runSkill(["uninstall"], { cwd, executable });
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(victim, "utf8"), ASSET_FILES["SKILL.md"]);
});

test("a killed atomic write's tmp orphan of an OWNED file is managed debris: install converges, uninstall cleans", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");

  writeFileSync(path.join(dir, "SKILL.md.tmp-99999-abc-def"), "stranded half-write\n");
  const converge = await runSkill(["install"], { cwd, executable });
  assert.equal(converge.skill.hosts.claude_code.changed, true, "debris removal must report changed");
  assert.equal(existsSync(path.join(dir, "SKILL.md.tmp-99999-abc-def")), false);
  assert.equal((await runSkill(["status"], { cwd, executable })).skill.hosts.claude_code.state, "installed");

  writeFileSync(path.join(dir, "SKILL.md.tmp-99999-abc-def"), "stranded again\n");
  const removed = await runSkill(["uninstall"], { cwd, executable });
  assert.equal(removed.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(dir), false);
});

test("a temp-patterned file with a FOREIGN base is NOT debris — install and uninstall still refuse, file intact", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  // The name MATCHES the temp regex shape exactly — only the owned-base check keeps it foreign,
  // so this test pins `owned.has(base)` itself, not the regex.
  writeFileSync(path.join(dir, "random-foreign.md.tmp-1-ab-cd"), "not ours\n");

  await assert.rejects(() => runSkill(["install"], { cwd, executable }), CliError);
  await assert.rejects(() => runSkill(["uninstall"], { cwd, executable }), CliError);
  assert.equal(readFileSync(path.join(dir, "random-foreign.md.tmp-1-ab-cd"), "utf8"), "not ours\n");
  assert.ok(existsSync(path.join(dir, "SKILL.md")), "refusal must delete nothing");
});

test("the manifest's own tmp orphan: state reads MANAGED (status ignores without deleting), install converges", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  const orphan = path.join(dir, ".aslite-skill.json.tmp-4242-q1w2-e3r4");
  writeFileSync(orphan, "{half-written manifest");

  // status is READ-ONLY: it ignores the debris (managed state, not unmanaged) and leaves it.
  const status = await runSkill(["status"], { cwd, executable });
  assert.equal(status.skill.hosts.claude_code.state, "installed");
  assert.ok(existsSync(orphan), "status must not delete anything");

  const converge = await runSkill(["install"], { cwd, executable });
  assert.equal(converge.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(orphan), false);

  // A FIRST-install kill strands only the manifest tmp: absent (not unmanaged), fresh install ok.
  const codexDir = path.join(cwd, ".codex", "skills", "superbee");
  await runSkill(["uninstall"], { cwd, executable });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(path.join(codexDir, ".aslite-skill.json.tmp-1-a2-b3"), "{");
  const early = await runSkill(["status"], { cwd, executable });
  assert.equal(early.skill.hosts.codex.state, "absent");
  const fresh = await runSkill(["install"], { cwd, executable });
  assert.equal(fresh.skill.hosts.codex.changed, true);
  assert.equal((await runSkill(["status"], { cwd, executable })).skill.hosts.codex.state, "installed");
});

// ── upgrade transitions: every intermediate state is owned by its manifest ──

const LEGACY_FILE = "references/legacy/old-contract.md";
const V1_FILES: Record<string, string> = { ...ASSET_FILES, [LEGACY_FILE]: "# retired contract\n" };
const UNION_FILES = [...new Set([...Object.keys(V1_FILES), ...Object.keys(ASSET_FILES)])].sort();

/** A scratch with BOTH a v1 (extra legacy asset) and a v2 (standard) distribution. */
function upgradeScratch(): { base: string; exe1: string; exe2: string } {
  const base = mkdtempSync(path.join(tmpdir(), "aslite-skill-upgrade-"));
  const exe1 = makeDistribution(path.join(base, "pkg-v1"), "1.0.0", V1_FILES);
  const exe2 = makeDistribution(path.join(base, "pkg-v2"), "9.9.9", ASSET_FILES);
  return { base, exe1, exe2 };
}

/** Hand-write the exact transitional manifest an interrupted v1→v2 upgrade leaves behind. */
function writeTransitionalManifest(dir: string): void {
  writeFileSync(
    path.join(dir, SKILL_MANIFEST_FILENAME),
    `${JSON.stringify({ package: "aslite", version: "9.9.9", installed_by: "aslite skill install", files: UNION_FILES }, null, 2)}\n`,
  );
}

test("upgrade end-to-end: obsolete v1 asset removed, final manifest is exactly the v2 set", async () => {
  const { base, exe1, exe2 } = upgradeScratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable: exe1 });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  assert.ok(existsSync(path.join(dir, ...LEGACY_FILE.split("/"))));

  const upgraded = await runSkill(["install"], { cwd, executable: exe2 });
  assert.equal(upgraded.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(path.join(dir, ...LEGACY_FILE.split("/"))), false, "obsolete v1 asset converges away");
  const manifest = JSON.parse(readFileSync(path.join(dir, SKILL_MANIFEST_FILENAME), "utf8"));
  assert.deepEqual(manifest.files, Object.keys(ASSET_FILES).sort(), "final manifest owns exactly the v2 set");
  assert.equal((await runSkill(["status"], { cwd, executable: exe2 })).skill.hosts.claude_code.state, "installed");
});

test("upgrade intermediate (transitional manifest + surviving v1 asset): stale, install converges, uninstall cleans", async () => {
  const { base, exe1, exe2 } = upgradeScratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  const dir = path.join(cwd, ".claude", "skills", "superbee");

  // The kill point right after the transitional-manifest write: v1 files intact, union manifest.
  const construct = async () => {
    rmSync(path.join(cwd, ".claude"), { recursive: true, force: true });
    rmSync(path.join(cwd, ".codex"), { recursive: true, force: true });
    await runSkill(["install"], { cwd, executable: exe1 });
    writeTransitionalManifest(dir);
  };

  await construct();
  assert.equal((await runSkill(["status"], { cwd, executable: exe2 })).skill.hosts.claude_code.state, "stale");
  const converge = await runSkill(["install"], { cwd, executable: exe2 });
  assert.equal(converge.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(path.join(dir, ...LEGACY_FILE.split("/"))), false);
  assert.equal((await runSkill(["status"], { cwd, executable: exe2 })).skill.hosts.claude_code.state, "installed");

  await construct();
  const removed = await runSkill(["uninstall"], { cwd, executable: exe2 });
  assert.equal(removed.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(dir), false, "uninstall from the transitional state removes every owned file");
});

test("upgrade intermediate (transitional manifest + partial v2 assets): stale, install converges, uninstall cleans", async () => {
  const { base, exe1, exe2 } = upgradeScratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  const dir = path.join(cwd, ".claude", "skills", "superbee");

  // The kill point mid-asset-writes: union manifest, one v2 asset missing, legacy still present.
  const construct = async () => {
    rmSync(path.join(cwd, ".claude"), { recursive: true, force: true });
    rmSync(path.join(cwd, ".codex"), { recursive: true, force: true });
    await runSkill(["install"], { cwd, executable: exe1 });
    writeTransitionalManifest(dir);
    rmSync(path.join(dir, "references", "views", "view-authoring.md"));
  };

  await construct();
  assert.equal((await runSkill(["status"], { cwd, executable: exe2 })).skill.hosts.claude_code.state, "stale");
  const converge = await runSkill(["install"], { cwd, executable: exe2 });
  assert.equal(converge.skill.hosts.claude_code.changed, true);
  assert.equal(
    readFileSync(path.join(dir, "references", "views", "view-authoring.md"), "utf8"),
    ASSET_FILES["references/views/view-authoring.md"],
  );
  assert.equal((await runSkill(["status"], { cwd, executable: exe2 })).skill.hosts.claude_code.state, "installed");

  await construct();
  const removed = await runSkill(["uninstall"], { cwd, executable: exe2 });
  assert.equal(removed.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(dir), false);
});

test("upgrade completed state (final manifest, exact v2 assets): installed, install no-op, uninstall cleans", async () => {
  const { base, exe1, exe2 } = upgradeScratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable: exe1 });
  await runSkill(["install"], { cwd, executable: exe2 });
  const dir = path.join(cwd, ".claude", "skills", "superbee");

  assert.equal((await runSkill(["status"], { cwd, executable: exe2 })).skill.hosts.claude_code.state, "installed");
  assert.equal((await runSkill(["install"], { cwd, executable: exe2 })).skill.changed, false);
  await runSkill(["uninstall"], { cwd, executable: exe2 });
  assert.equal(existsSync(dir), false);
});

test("UNMANAGED folder + asset-named tmp + foreign file: refusal deletes NEITHER (ownership not established)", async () => {
  // The reviewer's fixture: without a valid manifest, an asset-name-based tmp could shadow
  // foreign data — the sweep must not touch it; only the reserved manifest-name tmp is ours.
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  const claudeDir = path.join(cwd, ".claude", "skills", "superbee");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, "SKILL.md.tmp-123-abc-def"), "could be foreign data\n");
  writeFileSync(path.join(claudeDir, "foreign.md"), "definitely foreign\n");

  await assert.rejects(() => runSkill(["install"], { cwd, executable }), CliError);
  assert.equal(readFileSync(path.join(claudeDir, "SKILL.md.tmp-123-abc-def"), "utf8"), "could be foreign data\n");
  assert.equal(readFileSync(path.join(claudeDir, "foreign.md"), "utf8"), "definitely foreign\n");

  await assert.rejects(() => runSkill(["uninstall"], { cwd, executable }), CliError);
  assert.equal(readFileSync(path.join(claudeDir, "SKILL.md.tmp-123-abc-def"), "utf8"), "could be foreign data\n");
  assert.equal(readFileSync(path.join(claudeDir, "foreign.md"), "utf8"), "definitely foreign\n");
});

test("install adopts a pre-existing EMPTY real directory as a fresh install", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(path.join(cwd, ".claude", "skills", "superbee"), { recursive: true });
  const receipt = await runSkill(["install"], { cwd, executable });
  assert.equal(receipt.skill.hosts.claude_code.changed, true);
  assert.equal((await runSkill(["status"], { cwd, executable })).skill.hosts.claude_code.state, "installed");
});

test("an EMPTY directory at a manifested path: status stale (no crash), install converges, uninstall cleans", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  const squatted = path.join(dir, "SKILL.md");

  rmSync(squatted);
  mkdirSync(squatted);
  assert.equal((await runSkill(["status"], { cwd, executable })).skill.hosts.claude_code.state, "stale");

  const converge = await runSkill(["install"], { cwd, executable });
  assert.equal(converge.skill.hosts.claude_code.changed, true);
  assert.equal(lstatSync(squatted).isFile(), true, "the empty directory converges back to the real file");
  assert.equal(readFileSync(squatted, "utf8"), ASSET_FILES["SKILL.md"]);

  rmSync(squatted);
  mkdirSync(squatted);
  const removed = await runSkill(["uninstall"], { cwd, executable });
  assert.equal(removed.skill.hosts.claude_code.changed, true);
  assert.equal(existsSync(dir), false, "uninstall handles the empty-directory shape without a throw");
});

test("a NON-EMPTY directory at a manifested path: structured refusal, nested content intact, sibling processed, no crash", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  await runSkill(["install"], { cwd, executable });
  const dir = path.join(cwd, ".claude", "skills", "superbee");
  const squatted = path.join(dir, "SKILL.md");
  rmSync(squatted);
  mkdirSync(squatted);
  writeFileSync(path.join(squatted, "nested-foreign.txt"), "do not delete\n");

  assert.equal((await runSkill(["status"], { cwd, executable })).skill.hosts.claude_code.state, "stale");

  await assert.rejects(
    () => runSkill(["install"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(JSON.stringify(err.details), /directories with contents/);
      assert.match(JSON.stringify(err.details), /SKILL\.md/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(squatted, "nested-foreign.txt"), "utf8"), "do not delete\n");

  await assert.rejects(
    () => runSkill(["uninstall"], { cwd, executable }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(JSON.stringify(err.details), /directories with contents/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(squatted, "nested-foreign.txt"), "utf8"), "do not delete\n");
  assert.ok(existsSync(path.join(dir, SKILL_MANIFEST_FILENAME)), "refusal deletes nothing else either");
  // The sibling codex host was still processed on both verbs (install converged, uninstall removed).
  assert.equal(existsSync(path.join(cwd, ".codex", "skills", "superbee")), false);
});

test("skill usage errors: missing/unknown subcommand and bad scope are USAGE, not runtime", async () => {
  const { base, executable } = scratch();
  const cwd = path.join(base, "project");
  mkdirSync(cwd, { recursive: true });
  for (const argv of [[], ["frobnicate"], ["install", "--scope", "galaxy"]]) {
    await assert.rejects(
      () => runSkill(argv, { cwd, executable }),
      (err: unknown) => err instanceof CliError && err.code === "USAGE",
    );
  }
});
