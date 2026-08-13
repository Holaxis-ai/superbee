import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildIdentityEnvelope } from "../src/build-identity.js";
import { CliError } from "../src/errors.js";
import { versionCommand } from "../src/commands/version.js";
import { UPDATE_CHECK_SCHEMA, type UpdateCheckResult } from "../src/update-check.js";

const CHECKED_AT = "2026-08-05T12:00:00.000Z";

function result(status: UpdateCheckResult["status"] = "current"): UpdateCheckResult {
  const unavailable = status === "unavailable";
  const upgrade = status === "upgrade_available";
  const rollback = status === "rollback_available";
  const actionable = upgrade || rollback;
  const selectedVersion = upgrade ? "0.1.0-pre.4" : rollback ? "0.1.0-pre.2" : "0.1.0-pre.3";
  return {
    schema: UPDATE_CHECK_SCHEMA,
    track: "latest",
    status,
    relation: unavailable ? "unknown" : upgrade ? "selected_newer" : rollback ? "selected_older" : "equal",
    checked_at: CHECKED_AT,
    running_version: "0.1.0-pre.3",
    selected_version: unavailable ? null : selectedVersion,
    running_deprecated: status === "deprecated" ? "registry policy needs repair" : null,
    selected_integrity: unavailable ? null : `sha512-${Buffer.alloc(64).toString("base64")}`,
    command: actionable ? `npm install --global superbee@${selectedVersion}` : null,
    verify: actionable
      ? [
          "superbee version --check",
          "superbee skill status --scope user",
          "superbee hook status --scope user",
        ]
      : [],
    unavailable: unavailable ? { code: "offline", message: "npm registry could not be reached" } : null,
  };
}

function capture() {
  let output = "";
  return { stdout: (text: string) => void (output += text), output: () => output };
}

test("version without --check retains the exact local identity envelope and performs no network", async () => {
  const cap = capture();
  let checks = 0;
  const identity = buildIdentityEnvelope();
  await versionCommand(["--json"], {
    stdout: cap.stdout,
    identity: () => identity,
    check: async () => {
      checks += 1;
      return result();
    },
  });
  assert.equal(cap.output(), `${JSON.stringify(identity)}\n`);
  assert.equal(checks, 0);
});

test("version --check renders identity plus the exact check and keeps successful states on exit 0", async () => {
  for (const argv of [["--check", "--json"], ["--check"]]) {
    const cap = capture();
    const exitCodes: number[] = [];
    const identity = buildIdentityEnvelope();
    await versionCommand(argv, {
      stdout: cap.stdout,
      identity: () => identity,
      check: async (input) => {
        assert.deepEqual(input, { runningVersion: identity.identity.package.version, track: "latest" });
        return result();
      },
      setExitCode: (code) => void exitCodes.push(code),
    });
    if (argv.includes("--json")) {
      const parsed = JSON.parse(cap.output());
      assert.deepEqual(Object.keys(parsed), ["identity", "check"]);
      assert.deepEqual(parsed.identity, identity.identity);
      assert.deepEqual(parsed.check, result());
    } else {
      assert.match(cap.output(), /schema: superbee\.update-check\.v1/);
      assert.match(cap.output(), /status: current/);
    }
    assert.deepEqual(exitCodes, []);
  }
});

test("only unavailable uses exit 1; every compared state remains exit 0", async () => {
  for (const status of ["current", "deprecated", "upgrade_available", "rollback_available"] as const) {
    const exitCodes: number[] = [];
    await versionCommand(["--check", "--json"], {
      stdout: () => {},
      check: async () => result(status),
      setExitCode: (code) => void exitCodes.push(code),
    });
    assert.deepEqual(exitCodes, [], status);
  }
});

test("version --check preserves identity on structured unavailable and requests exit 1", async () => {
  const cap = capture();
  const exitCodes: number[] = [];
  const identity = buildIdentityEnvelope();
  await versionCommand(["--check", "--json"], {
    stdout: cap.stdout,
    identity: () => identity,
    check: async () => result("unavailable"),
    setExitCode: (code) => void exitCodes.push(code),
  });
  const parsed = JSON.parse(cap.output());
  assert.deepEqual(parsed.identity, identity.identity);
  assert.equal(parsed.check.status, "unavailable");
  assert.deepEqual(exitCodes, [1]);
});

test("version --check forwards only the explicit next track and never writes local state", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aslite-version-check-no-write-"));
  const before = readdirSync(dir);
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const cap = capture();
    await versionCommand(["--check", "--tag", "next", "--json"], {
      stdout: cap.stdout,
      check: async (input) => {
        assert.equal(input.track, "next");
        return { ...result(), track: "next" };
      },
    });
    assert.deepEqual(readdirSync(dir), before);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version check argument and local-identity failures preserve the exit taxonomy", async () => {
  for (const argv of [["--tag", "next"], ["--check", "--tag", "beta"], ["--check", "extra"]]) {
    await assert.rejects(
      () => versionCommand(argv),
      (error: unknown) => error instanceof CliError && error.code === "USAGE" && error.exitCode === 2,
      argv.join(" "),
    );
  }
  await assert.rejects(
    () =>
      versionCommand(["--check"], {
        identity: () => ({
          ...buildIdentityEnvelope(),
          identity: {
            ...buildIdentityEnvelope().identity,
            package: { name: "superbee", version: "not-semver" },
          },
        }),
      }),
    (error: unknown) => error instanceof CliError && error.code === "RUNTIME" && error.exitCode === 1,
  );
});
