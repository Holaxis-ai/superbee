import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, fork, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  UPDATE_CACHE_MAX_BYTES,
  UPDATE_CACHE_SCHEMA,
  UPDATE_CACHE_TTL_MS,
  UPDATE_LEASE_ACTIVE_MS,
  UPDATE_LEASE_MAX_BYTES,
  UPDATE_LEASE_SCHEMA,
  claimUpdateLease,
  inspectUpdateCache,
  isPassiveUpdateSuppressed,
  parseUpdateCacheText,
  parseUpdateLeaseText,
  projectUpdateNotice,
  releaseActiveUpdateLease,
  runPassiveUpdateOrientation,
  runUpdateRefreshWorker,
  serializeUpdateCache,
  serializeUpdateLease,
  updateCachePath,
  updateLeasePath,
  type UpdateCacheRecord,
  type UpdateLeaseRecord,
} from "../src/update-orientation.js";
import { LEGACY_NO_UPDATE_CHECK_ENV, SUPERBEE_NO_UPDATE_CHECK_ENV } from "../src/env-policy.js";
import type { UpdateCheckResult } from "../src/update-check.js";
import { buildHomeView, home } from "../src/commands/home.js";
import { sessionStart } from "../src/commands/session-start.js";
import { render } from "../src/output.js";
import { KNOWN_COMMANDS } from "../src/cli.js";
import { fileURLToPath } from "node:url";
import { credentialsDir } from "../src/credentials.js";
import { canonicalUserStateDir, ensureUserStateRootSync } from "../src/user-state.js";

const RUNNING = "0.1.0-pre.3";
const SELECTED = "0.1.0-pre.4";
const CHECKED_AT = "2026-08-05T12:00:00.000Z";
const NOW = new Date("2026-08-05T12:00:01.000Z");
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const BUILT_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/superbee.mjs",
);
const TEST_LOADER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ts-loader.mjs");
const CONCURRENCY_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/update-orientation-child.ts",
);

// Literal bytes with fixed identity/bin/invocation and no bundle/board/workspace/hook state.
// The first-use command intentionally carries init's create-only safety guard.
const HOME_BASELINE_TOON = [
  "superbee:",
  "  bin: /opt/superbee/dist/superbee.mjs",
  "  version: 0.1.0-pre.3",
  "  channel: local-dev",
  '  description: "read and write a local OKF knowledge bundle (context notes, docs, cross-links, live bundle Views)"',
  `getting_started: "no OKF bundle found in this directory — run \`superbee init --create-only --recipe none --dir '.superbee'\` to create a blank bundle, or \`superbee recipes\` to compare available workspace setups; create your chosen setup here with \`superbee init --create-only --recipe <name> --dir '.superbee'\`"`,
  "commands:",
  '  Bundle: "bundle locate, catalog, init, index generate, status"',
  '  "Documents & links": "doc write, doc update, doc read, doc open, doc history, doc delete, list, link"',
  '  Artifacts: "artifact create, promote, pull, blobs, delete"',
  '  Kinds: "new, kinds, kind field, recipes, recipe add, recipe evolve"',
  '  Remote: "serve, ui, mcp, view list, sync"',
  '  Session: "version, session-start, hook install|status|uninstall, skill install|status|uninstall, setup"',
  "commands_help: run `superbee <command> --help` (or `superbee --help`) for full usage",
  "kinds: kinds are declared per-bundle — run `superbee kinds` to list them",
  'remote_env: "bundle resolution: HTTP is activated only by explicit --remote <url>; otherwise an explicit --dir wins, then a committed .superbee.json or supported .agentstate.json local-path binding at or above the cwd, then local discovery walks up for an enclosing or conventional project bundle. Both binding names at one level conflict. URL-valued bindings and the retired AGENTSTATE_LITE_REMOTE ambient default fail with guidance to pass --remote explicitly"',
  "",
].join("\n");

const HOME_BASELINE_JSON = `${JSON.stringify({
  superbee: {
    bin: "/opt/superbee/dist/superbee.mjs",
    version: "0.1.0-pre.3",
    channel: "local-dev",
    description:
      "read and write a local OKF knowledge bundle (context notes, docs, cross-links, live bundle Views)",
  },
  getting_started:
    "no OKF bundle found in this directory — run `superbee init --create-only --recipe none --dir '.superbee'` to create a blank bundle, or `superbee recipes` to compare available workspace setups; create your chosen setup here with `superbee init --create-only --recipe <name> --dir '.superbee'`",
  commands: {
    Bundle: "bundle locate, catalog, init, index generate, status",
    "Documents & links": "doc write, doc update, doc read, doc open, doc history, doc delete, list, link",
    Artifacts: "artifact create, promote, pull, blobs, delete",
    Kinds: "new, kinds, kind field, recipes, recipe add, recipe evolve",
    Remote: "serve, ui, mcp, view list, sync",
    Session: "version, session-start, hook install|status|uninstall, skill install|status|uninstall, setup",
  },
  commands_help: "run `superbee <command> --help` (or `superbee --help`) for full usage",
  kinds: "kinds are declared per-bundle — run `superbee kinds` to list them",
  remote_env:
    "bundle resolution: HTTP is activated only by explicit --remote <url>; otherwise an explicit --dir wins, then a committed .superbee.json or supported .agentstate.json local-path binding at or above the cwd, then local discovery walks up for an enclosing or conventional project bundle. Both binding names at one level conflict. URL-valued bindings and the retired AGENTSTATE_LITE_REMOTE ambient default fail with guidance to pass --remote explicitly",
})}\n`;

function successfulCheck(
  status: "current" | "deprecated" | "successor_not_ready" | "upgrade_available" | "rollback_available" =
    "upgrade_available",
): UpdateCheckResult {
  const actionable = status === "upgrade_available" || status === "rollback_available";
  const selected =
    status === "rollback_available" || status === "successor_not_ready" ? "0.1.0-pre.2" : actionable ? SELECTED : RUNNING;
  return {
    schema: "superbee.update-check.v1",
    track: "latest",
    status,
    relation:
      status === "upgrade_available"
        ? "selected_newer"
        : status === "rollback_available"
          ? "selected_older"
          : status === "successor_not_ready"
            ? "selected_older"
          : "equal",
    checked_at: CHECKED_AT,
    running_version: RUNNING,
    selected_version: selected,
    running_deprecated: status === "deprecated" ? "unsupported" : null,
    selected_integrity: INTEGRITY,
    command: actionable ? `npm install --global superbee@${selected}` : null,
    verify: actionable
      ? [
          "superbee version --check",
          "superbee skill status --scope user",
          "superbee hook status --scope user",
        ]
      : [],
    unavailable: null,
  };
}

function cacheRecord(check: UpdateCheckResult = successfulCheck()): UpdateCacheRecord {
  return {
    schema: UPDATE_CACHE_SCHEMA,
    package: "superbee",
    running_version: RUNNING,
    track: "latest",
    check,
    checked_at: CHECKED_AT,
    expires_at: "2026-08-06T12:00:00.000Z",
  };
}

function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "aslite-update-orientation-"));
}

function activeLease(token = "a".repeat(64)): UpdateLeaseRecord {
  return {
    schema: UPDATE_LEASE_SCHEMA,
    state: "active",
    token,
    started_at: CHECKED_AT,
    lease_expires_at: "2026-08-05T12:00:30.000Z",
    cooldown_expires_at: "2026-08-06T12:00:00.000Z",
  };
}

function startConcurrencyFixture(input: {
  home: string;
  mode:
    | "claim"
    | "stale"
    | "paused-parent"
    | "cleanup-racer"
    | "aba-parent-a"
    | "passive-parent";
  now: string;
  token: string;
}): ChildProcess {
  return fork(CONCURRENCY_FIXTURE, [], {
    execArgv: ["--import", TEST_LOADER],
    env: {
      ...process.env,
      ASLITE_TEST_HOME: input.home,
      ASLITE_TEST_MODE: input.mode,
      ASLITE_TEST_NOW: input.now,
      ASLITE_TEST_TOKEN: input.token,
      ASLITE_NO_UPDATE_CHECK: "1",
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc", "pipe"],
  });
}

function nextChildMessage(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("update-orientation fixture message timed out"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`update-orientation fixture exited before message (${code})`));
    };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function releaseChildBarrier(child: ChildProcess): void {
  const barrier = child.stdio?.[4];
  assert.ok(barrier && "write" in barrier);
  (barrier as NodeJS.WritableStream).write(Buffer.from([1]));
}

function stopChildren(children: ChildProcess[]): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

test("N4 constants and cache serializer pin the frozen private contract", () => {
  assert.equal(UPDATE_CACHE_SCHEMA, "aslite.update-cache.v1");
  assert.equal(UPDATE_LEASE_SCHEMA, "aslite.update-lease.v1");
  assert.equal(UPDATE_CACHE_TTL_MS, 86_400_000);
  assert.equal(UPDATE_LEASE_ACTIVE_MS, 30_000);
  assert.equal(UPDATE_CACHE_MAX_BYTES, 65_536);
  assert.equal(UPDATE_LEASE_MAX_BYTES, 4_096);

  const serialized = serializeUpdateCache(successfulCheck());
  assert.equal(serialized, `${JSON.stringify(cacheRecord(), null, 2)}\n`);
  assert.ok(Buffer.byteLength(serialized) <= UPDATE_CACHE_MAX_BYTES);
});

test("strict cache parser accepts every successful status and projects only actionable notices", () => {
  for (const status of [
    "current",
    "deprecated",
    "successor_not_ready",
    "upgrade_available",
    "rollback_available",
  ] as const) {
    const check = successfulCheck(status);
    const parsed = parseUpdateCacheText(`${JSON.stringify(cacheRecord(check))}\n`, {
      runningVersion: RUNNING,
      now: NOW,
    });
    assert.deepEqual(parsed, check, status);
    const notice = projectUpdateNotice(parsed);
    if (status === "current" || status === "successor_not_ready") {
      assert.equal(notice, undefined);
    } else {
      assert.deepEqual(notice, {
        status,
        running_version: RUNNING,
        selected_version: check.selected_version,
        checked_at: CHECKED_AT,
        command: check.command,
      });
      assert.deepEqual(Object.keys(notice!), [
        "status",
        "running_version",
        "selected_version",
        "checked_at",
        "command",
      ]);
    }
  }
});

test("strict cache parser rejects drift, hostile commands, extra keys, noncanonical time, and expiry", () => {
  const cases: Array<[string, (record: any) => void]> = [
    ["package", (record) => (record.package = "foreign")],
    ["running version", (record) => (record.running_version = "0.1.0-pre.2")],
    ["track", (record) => (record.track = "next")],
    ["top/check time disagreement", (record) => (record.check.checked_at = "2026-08-05T12:00:00.001Z")],
    ["forged ttl", (record) => (record.expires_at = "2026-08-07T12:00:00.000Z")],
    ["noncanonical time", (record) => (record.checked_at = "2026-08-05T12:00:00Z")],
    ["extra key", (record) => (record.extra = true)],
    ["nested extra key", (record) => (record.check.extra = true)],
    ["command injection", (record) => (record.check.command = "rm -rf ~")],
    ["relation mismatch", (record) => (record.check.relation = "selected_older")],
    ["unavailable", (record) => {
      record.check.status = "unavailable";
      record.check.relation = "unknown";
      record.check.command = null;
      record.check.verify = [];
      record.check.unavailable = { code: "offline", message: "offline" };
    }],
  ];
  for (const [label, mutate] of cases) {
    const record: any = structuredClone(cacheRecord());
    mutate(record);
    assert.equal(
      parseUpdateCacheText(`${JSON.stringify(record)}\n`, { runningVersion: RUNNING, now: NOW }),
      null,
      label,
    );
  }

  assert.equal(
    parseUpdateCacheText(`${JSON.stringify(cacheRecord())}\n`, {
      runningVersion: RUNNING,
      now: new Date("2026-08-06T12:00:00.000Z"),
    }),
    null,
    "expires_at is exclusive",
  );
});

test("passive suppressors are exact tokens and environment-key presence, including empty and zero", () => {
  assert.equal(isPassiveUpdateSuppressed([], {}), false);
  assert.equal(isPassiveUpdateSuppressed(["--no-update-check"], {}), true);
  assert.equal(isPassiveUpdateSuppressed(["--no-update-check=false"], {}), false);
  assert.equal(isPassiveUpdateSuppressed(["--no-update-checker"], {}), false);
  for (const key of [SUPERBEE_NO_UPDATE_CHECK_ENV, LEGACY_NO_UPDATE_CHECK_ENV, "NO_UPDATE_NOTIFIER", "CI"]) {
    for (const value of ["", "0", "1"]) {
      assert.equal(isPassiveUpdateSuppressed([], { [key]: value }), true, `${key}=${value}`);
    }
  }
});

test("handle-based cache inspection distinguishes safe invalid state from unsafe filesystem state", () => {
  const home = tempHome();
  try {
    assert.deepEqual(inspectUpdateCache({ home, runningVersion: RUNNING, now: NOW }), {
      state: "refreshable",
    });

    ensureUserStateRootSync(home);
    writeFileSync(updateCachePath(home), serializeUpdateCache(successfulCheck()), { mode: 0o600 });
    assert.equal(
      inspectUpdateCache({ home, runningVersion: RUNNING, now: NOW }).state,
      "fresh",
    );

    writeFileSync(updateCachePath(home), "{bad json}\n", { mode: 0o600 });
    assert.deepEqual(inspectUpdateCache({ home, runningVersion: RUNNING, now: NOW }), {
      state: "refreshable",
    });

    rmSync(updateCachePath(home));
    symlinkSync(path.join(home, "outside"), updateCachePath(home));
    assert.deepEqual(inspectUpdateCache({ home, runningVersion: RUNNING, now: NOW }), {
      state: "unsafe",
    });
    assert.ok(lstatSync(updateCachePath(home)).isSymbolicLink());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cache safety is bounded, nonblocking for FIFO, and fail-closed on modes and state directory", () => {
  const variants: Array<[string, (home: string, cache: string) => void]> = [
    ["oversized", (_home, cache) => writeFileSync(cache, "x".repeat(UPDATE_CACHE_MAX_BYTES + 1), { mode: 0o600 })],
    ["loose file", (_home, cache) => writeFileSync(cache, "{}", { mode: 0o644 })],
    ["directory", (_home, cache) => mkdirSync(cache, { mode: 0o600 })],
    ["fifo", (_home, cache) => execFileSync("mkfifo", [cache])],
  ];
  for (const [label, plant] of variants) {
    const home = tempHome();
    try {
      ensureUserStateRootSync(home);
      const cache = updateCachePath(home);
      plant(home, cache);
      const started = Date.now();
      assert.deepEqual(
        inspectUpdateCache({ home, runningVersion: RUNNING, now: NOW }),
        { state: "unsafe" },
        label,
      );
      assert.ok(Date.now() - started < 1_000, `${label} must not block`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  const looseHome = tempHome();
  try {
    mkdirSync(path.dirname(credentialsDir(looseHome)), { recursive: true, mode: 0o700 });
    mkdirSync(credentialsDir(looseHome), { mode: 0o755 });
    assert.deepEqual(inspectUpdateCache({ home: looseHome, runningVersion: RUNNING, now: NOW }), {
      state: "unsafe",
    });
    assert.equal(lstatSync(credentialsDir(looseHome)).mode & 0o777, 0o755);
  } finally {
    rmSync(looseHome, { recursive: true, force: true });
  }
});

test("lease serializer/parser pin exact active and cooldown unions", () => {
  const active = activeLease();
  assert.equal(serializeUpdateLease(active), `${JSON.stringify(active, null, 2)}\n`);
  assert.deepEqual(parseUpdateLeaseText(JSON.stringify(active)), active);

  const cooldown: UpdateLeaseRecord = {
    schema: UPDATE_LEASE_SCHEMA,
    state: "cooldown",
    token: active.token,
    started_at: active.started_at,
    expires_at: active.cooldown_expires_at,
  };
  assert.deepEqual(parseUpdateLeaseText(JSON.stringify(cooldown)), cooldown);
  for (const mutate of [
    (record: any) => (record.token = "z".repeat(64)),
    (record: any) => (record.lease_expires_at = "2026-08-05T12:00:30Z"),
    (record: any) => (record.cooldown_expires_at = "2026-08-06T12:00:00.001Z"),
    (record: any) => (record.extra = true),
  ]) {
    const record: any = structuredClone(active);
    mutate(record);
    assert.equal(parseUpdateLeaseText(JSON.stringify(record)), null);
  }
});

test("hard-link claim, continuous stale conversion, cooldown cleanup, and token-scoped release", () => {
  const home = tempHome();
  const tokenA = "a".repeat(64);
  const tokenB = "b".repeat(64);
  try {
    ensureUserStateRootSync(home);
    const first = claimUpdateLease({ home, now: new Date(CHECKED_AT), token: tokenA });
    assert.equal(first.state, "claimed");
    assert.deepEqual(parseUpdateLeaseText(readFileSync(updateLeasePath(home), "utf8")), activeLease(tokenA));
    assert.equal(lstatSync(updateLeasePath(home)).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.dirname(updateLeasePath(home))).mode & 0o777, 0o700);

    assert.deepEqual(
      claimUpdateLease({ home, now: new Date("2026-08-05T12:00:29.999Z"), token: tokenB }),
      { state: "occupied" },
    );

    assert.deepEqual(
      claimUpdateLease({ home, now: new Date("2026-08-05T12:00:30.000Z"), token: tokenB }),
      { state: "occupied" },
      "stale active converts to cooldown but this visit never acquires",
    );
    const cooldown = parseUpdateLeaseText(readFileSync(updateLeasePath(home), "utf8"));
    assert.deepEqual(cooldown, {
      schema: UPDATE_LEASE_SCHEMA,
      state: "cooldown",
      token: tokenA,
      started_at: CHECKED_AT,
      expires_at: "2026-08-06T12:00:00.000Z",
    });
    assert.equal(releaseActiveUpdateLease(home, tokenB), false);
    assert.equal(releaseActiveUpdateLease(home, tokenA), false, "cooldown is never an active release target");

    assert.deepEqual(
      claimUpdateLease({ home, now: new Date("2026-08-06T12:00:00.000Z"), token: tokenB }),
      { state: "cleaned" },
      "expired cooldown visit is cleanup-only",
    );
    assert.equal(lstatSync(path.dirname(updateLeasePath(home))).isDirectory(), true);
    assert.deepEqual(
      claimUpdateLease({ home, now: new Date("2026-08-06T12:00:00.001Z"), token: tokenB }).state,
      "claimed",
    );
    assert.equal(releaseActiveUpdateLease(home, tokenA), false);
    assert.equal(releaseActiveUpdateLease(home, tokenB), true);
    assert.equal(lstatSync(path.dirname(updateLeasePath(home))).isDirectory(), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

class FakeDetachedChild extends EventEmitter {
  unrefCalled = false;

  unref(): void {
    this.unrefCalled = true;
  }
}

test("passive update orientation never initializes an absent durable state root", () => {
  const home = tempHome();
  let spawns = 0;
  try {
    assert.equal(
      runPassiveUpdateOrientation({
        home,
        runningVersion: RUNNING,
        now: () => NOW,
        executablePath: () => "/opt/superbee/dist/superbee.mjs",
        spawn: () => {
          spawns += 1;
          return new FakeDetachedChild();
        },
        token: () => "a".repeat(64),
      }),
      undefined,
    );
    assert.equal(spawns, 0);
    assert.equal(existsSync(canonicalUserStateDir(home)), false);
    assert.deepEqual(
      claimUpdateLease({ home, now: NOW, token: "a".repeat(64) }),
      { state: "occupied" },
    );
    assert.equal(existsSync(canonicalUserStateDir(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("passive parent returns cached notice or launches one exact detached private worker", () => {
  const home = tempHome();
  const calls: Array<{ command: string; argv: string[]; options: Record<string, unknown> }> = [];
  const child = new FakeDetachedChild();
  try {
    ensureUserStateRootSync(home);
    const notice = runPassiveUpdateOrientation({
      home,
      runningVersion: RUNNING,
      now: () => NOW,
      executablePath: () => "/opt/superbee/dist/superbee.mjs",
      spawn: (command, argv, options) => {
        calls.push({ command, argv, options });
        return child;
      },
      token: () => "a".repeat(64),
    });
    assert.equal(notice, undefined);
    assert.deepEqual(calls, [
      {
        command: process.execPath,
        argv: [
          "/opt/superbee/dist/superbee.mjs",
          "__update-refresh-v1",
          "a".repeat(64),
        ],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
    assert.equal(child.unrefCalled, true);

    const second = runPassiveUpdateOrientation({
      home,
      runningVersion: RUNNING,
      now: () => NOW,
      spawn: () => {
        throw new Error("must not spawn while active");
      },
    });
    assert.equal(second, undefined);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const cachedHome = tempHome();
  try {
    ensureUserStateRootSync(cachedHome);
    writeFileSync(updateCachePath(cachedHome), serializeUpdateCache(successfulCheck()), {
      mode: 0o600,
    });
    assert.deepEqual(
      runPassiveUpdateOrientation({
        home: cachedHome,
        runningVersion: RUNNING,
        now: () => NOW,
        spawn: () => {
          throw new Error("fresh cache must not spawn");
        },
      }),
      projectUpdateNotice(successfulCheck()),
    );
  } finally {
    rmSync(cachedHome, { recursive: true, force: true });
  }
});

test("post-claim cache recheck releases an unused claim and spawn failure releases only its token", () => {
  const home = tempHome();
  try {
    ensureUserStateRootSync(home);
    writeFileSync(updateCachePath(home), "{}\n", { mode: 0o600 });
    let spawns = 0;
    const notice = runPassiveUpdateOrientation({
      home,
      runningVersion: RUNNING,
      now: () => NOW,
      token: () => "a".repeat(64),
      afterClaim: () => {
        writeFileSync(updateCachePath(home), serializeUpdateCache(successfulCheck()), {
          mode: 0o600,
        });
      },
      spawn: () => {
        spawns += 1;
        return new FakeDetachedChild();
      },
    });
    assert.deepEqual(notice, projectUpdateNotice(successfulCheck()));
    assert.equal(spawns, 0);
    assert.equal(lstatSync(updateCachePath(home)).isFile(), true);
    assert.equal(
      claimUpdateLease({ home, now: NOW, token: "b".repeat(64) }).state,
      "claimed",
      "unused active claim was released",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const throwHome = tempHome();
  try {
    ensureUserStateRootSync(throwHome);
    runPassiveUpdateOrientation({
      home: throwHome,
      runningVersion: RUNNING,
      now: () => NOW,
      token: () => "a".repeat(64),
      executablePath: () => "/opt/aslite.mjs",
      spawn: () => {
        throw new Error("spawn failed");
      },
    });
    assert.equal(
      claimUpdateLease({ home: throwHome, now: NOW, token: "b".repeat(64) }).state,
      "claimed",
    );
  } finally {
    rmSync(throwHome, { recursive: true, force: true });
  }
});

test("asynchronous spawn error is swallowed and releases the matching active claim", () => {
  const home = tempHome();
  const child = new FakeDetachedChild();
  try {
    ensureUserStateRootSync(home);
    runPassiveUpdateOrientation({
      home,
      runningVersion: RUNNING,
      now: () => NOW,
      token: () => "a".repeat(64),
      executablePath: () => "/opt/aslite.mjs",
      spawn: () => child,
    });
    child.emit("error", new Error("async spawn failure"));
    assert.equal(
      claimUpdateLease({ home, now: NOW, token: "b".repeat(64) }).state,
      "claimed",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("private worker requires active token authority, caches success, and cools down unavailable checks", async () => {
  const invalidHome = tempHome();
  try {
    let checks = 0;
    await runUpdateRefreshWorker("not-a-token", {
      home: invalidHome,
      runningVersion: RUNNING,
      now: () => NOW,
      check: async () => {
        checks += 1;
        return successfulCheck();
      },
    });
    assert.equal(checks, 0);
    assert.equal(existsSync(credentialsDir(invalidHome)), false);
  } finally {
    rmSync(invalidHome, { recursive: true, force: true });
  }

  const successHome = tempHome();
  const token = "a".repeat(64);
  try {
    ensureUserStateRootSync(successHome);
    assert.equal(claimUpdateLease({ home: successHome, now: new Date(CHECKED_AT), token }).state, "claimed");
    await runUpdateRefreshWorker(token, {
      home: successHome,
      runningVersion: RUNNING,
      now: () => NOW,
      check: async (input) => {
        assert.deepEqual(input, { runningVersion: RUNNING, track: "latest" });
        return successfulCheck();
      },
    });
    assert.equal(inspectUpdateCache({ home: successHome, runningVersion: RUNNING, now: NOW }).state, "fresh");
    assert.equal(
      claimUpdateLease({ home: successHome, now: NOW, token: "b".repeat(64) }).state,
      "claimed",
      "cache is published before the matching active claim is removed",
    );
  } finally {
    rmSync(successHome, { recursive: true, force: true });
  }

  const unavailableHome = tempHome();
  try {
    ensureUserStateRootSync(unavailableHome);
    assert.equal(claimUpdateLease({ home: unavailableHome, now: new Date(CHECKED_AT), token }).state, "claimed");
    const unavailable: UpdateCheckResult = {
      ...successfulCheck(),
      status: "unavailable",
      relation: "unknown",
      selected_version: null,
      selected_integrity: null,
      command: null,
      verify: [],
      unavailable: { code: "offline", message: "npm registry could not be reached" },
    };
    await runUpdateRefreshWorker(token, {
      home: unavailableHome,
      runningVersion: RUNNING,
      now: () => NOW,
      check: async () => unavailable,
    });
    assert.equal(lstatSync(updateLeasePath(unavailableHome)).isFile(), true);
    assert.equal(parseUpdateLeaseText(readFileSync(updateLeasePath(unavailableHome), "utf8"))?.state, "cooldown");
    assert.equal(lstatSync(updateCachePath(unavailableHome), { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(unavailableHome, { recursive: true, force: true });
  }
});

test("worker revalidates token immediately before cache commit", async () => {
  const home = tempHome();
  const tokenA = "a".repeat(64);
  const tokenB = "b".repeat(64);
  try {
    ensureUserStateRootSync(home);
    assert.equal(claimUpdateLease({ home, now: new Date(CHECKED_AT), token: tokenA }).state, "claimed");
    await runUpdateRefreshWorker(tokenA, {
      home,
      runningVersion: RUNNING,
      now: () => NOW,
      check: async () => successfulCheck(),
      beforeCacheCommit: () => {
        writeFileSync(updateLeasePath(home), serializeUpdateLease(activeLease(tokenB)), {
          mode: 0o600,
        });
      },
    });
    assert.equal(lstatSync(updateCachePath(home), { throwIfNoEntry: false }), undefined);
    assert.equal(parseUpdateLeaseText(readFileSync(updateLeasePath(home), "utf8"))?.token, tokenB);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("home bytes stay exact and notice is one five-field block immediately after identity", () => {
  const deps = {
    binPath: () => "/opt/superbee/dist/superbee.mjs",
    invocation: () => "superbee",
    identity: () => ({ version: "0.1.0-pre.3", channel: "local-dev" as const }),
  };
  const baseline = buildHomeView(deps, null);
  assert.equal(render(baseline, "default"), HOME_BASELINE_TOON);
  assert.equal(render(baseline, "json"), HOME_BASELINE_JSON);

  const notice = projectUpdateNotice(successfulCheck())!;
  const withNotice = buildHomeView(
    deps,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    notice,
  );
  assert.deepEqual(Object.keys(withNotice).slice(0, 3), [
    "superbee",
    "update_notice",
    "getting_started",
  ]);
  assert.deepEqual(withNotice.update_notice, notice);
  assert.equal(Object.keys(withNotice.update_notice as object).length, 5);
});

test("home JSON and every exact suppressor bypass the orientation seam; default TOON calls it once", async () => {
  const base = {
    binPath: () => "/opt/superbee/dist/superbee.mjs",
    invocation: () => "superbee",
    stdout: (_value: string) => {},
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    autoPull: async () => {},
    hookNeedsUpdate: () => false,
    loadWorkspaces: async () => [],
    updateEnvironment: {} as Record<string, string | undefined>,
  };
  let calls = 0;
  const updateOrientation = () => {
    calls += 1;
    return projectUpdateNotice(successfulCheck());
  };

  await home([], { ...base, updateOrientation });
  assert.equal(calls, 1);
  for (const argv of [
    ["--json"],
    ["--no-update-check"],
    ["--no-update-check", "--bogus"],
  ]) {
    await home(argv, { ...base, updateOrientation });
    assert.equal(calls, 1, argv.join(" "));
  }
  for (const key of ["ASLITE_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"]) {
    await home([], {
      ...base,
      updateEnvironment: { [key]: "" },
      updateOrientation,
    });
    assert.equal(calls, 1, key);
  }
});

test("session-start parses and forwards --no-update-check without changing its pull budget", async () => {
  let renderedArgv: string[] | undefined;
  const started = Date.now();
  await sessionStart(["--no-update-check"], {
    budgetMs: 50,
    pull: async () => undefined,
    stdout: () => {},
    renderHome: async (argv) => {
      renderedArgv = argv;
    },
  });
  assert.deepEqual(renderedArgv, ["--no-update-check"]);
  assert.ok(Date.now() - started < 1_000);
});

test("built hidden route is silent, private, and invalid/no-authority invocations perform zero work", () => {
  assert.equal(KNOWN_COMMANDS.includes("__update-refresh-v1" as never), false);
  const home = tempHome();
  try {
    for (const argv of [
      ["__update-refresh-v1"],
      ["__update-refresh-v1", "bad-token"],
      ["__update-refresh-v1", "a".repeat(64), "extra"],
      ["__update-refresh-v1", "a".repeat(64)],
    ]) {
      const result = spawnSync(process.execPath, [BUILT_CLI, ...argv], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AGENTSTATE_LITE_NO_AUTOPULL: "1",
        },
        encoding: "utf8",
        timeout: 2_000,
      });
      assert.equal(result.status, 0, `${argv.join(" ")} stderr=${result.stderr}`);
      assert.equal(result.stdout, "", argv.join(" "));
      assert.equal(result.stderr, "", argv.join(" "));
      assert.equal(existsSync(credentialsDir(home)), false, argv.join(" "));
    }
    const help = spawnSync(process.execPath, [BUILT_CLI, "--help"], {
      env: { ...process.env, ASLITE_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.doesNotMatch(help.stdout, /__update-refresh-v1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("built JSON and suppressed default routes perform zero update-state work", () => {
  for (const argv of [
    ["--json"],
    ["--no-update-check"],
    ["session-start", "--json"],
    ["session-start", "--no-update-check"],
  ]) {
    const home = tempHome();
    try {
      const result = spawnSync(process.execPath, [BUILT_CLI, ...argv], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AGENTSTATE_LITE_NO_AUTOPULL: "1",
          ASLITE_NO_UPDATE_CHECK: undefined,
          NO_UPDATE_NOTIFIER: undefined,
          CI: undefined,
        },
        encoding: "utf8",
        timeout: 3_000,
      });
      assert.equal(result.status, 0, `${argv.join(" ")} stderr=${result.stderr}`);
      assert.equal(result.stderr, "");
      assert.equal(existsSync(credentialsDir(home)), false, argv.join(" "));
      if (argv.includes("--json")) assert.doesNotThrow(() => JSON.parse(result.stdout));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("barrier/IPC: concurrent processes produce exactly one hard-link claim winner", async () => {
  const home = tempHome();
  ensureUserStateRootSync(home);
  const children = Array.from({ length: 6 }, (_, index) =>
    startConcurrencyFixture({
      home,
      mode: "claim",
      now: CHECKED_AT,
      token: index.toString(16).padStart(64, "0"),
    }),
  );
  try {
    const results = children.map((child) => nextChildMessage(child));
    for (const child of children) child.send("go");
    const messages = await Promise.all(results);
    assert.equal(messages.filter((message) => message.state === "claimed").length, 1);
    assert.equal(messages.filter((message) => message.state === "occupied").length, 5);
    assert.equal(parseUpdateLeaseText(readFileSync(updateLeasePath(home), "utf8"))?.state, "active");
  } finally {
    stopChildren(children);
    rmSync(home, { recursive: true, force: true });
  }
});

test("barrier/IPC: stale active replacement stays occupied before and after the atomic rename", async () => {
  const home = tempHome();
  const tokenA = "a".repeat(64);
  const child = startConcurrencyFixture({
    home,
    mode: "stale",
    now: "2026-08-05T12:00:30.000Z",
    token: "b".repeat(64),
  });
  try {
    ensureUserStateRootSync(home);
    assert.equal(claimUpdateLease({ home, now: new Date(CHECKED_AT), token: tokenA }).state, "claimed");
    child.send("go");
    assert.deepEqual(await nextChildMessage(child), { type: "before-stale-replace" });
    assert.equal(
      claimUpdateLease({
        home,
        now: new Date("2026-08-05T12:00:29.999Z"),
        token: "c".repeat(64),
      }).state,
      "occupied",
    );
    assert.equal(existsSync(updateLeasePath(home)), true);
    releaseChildBarrier(child);
    assert.deepEqual(await nextChildMessage(child), { type: "result", state: "occupied" });
    assert.equal(parseUpdateLeaseText(readFileSync(updateLeasePath(home), "utf8"))?.state, "cooldown");
    assert.equal(
      claimUpdateLease({
        home,
        now: new Date("2026-08-05T12:00:30.001Z"),
        token: "c".repeat(64),
      }).state,
      "occupied",
    );
  } finally {
    stopChildren([child]);
    rmSync(home, { recursive: true, force: true });
  }
});

test("barrier/IPC: expired-cooldown ABA starts only the successor's worker", async () => {
  const home = tempHome();
  const now = "2026-08-06T12:00:01.000Z";
  const tokenA = "a".repeat(64);
  const tokenB = "b".repeat(64);
  const tokenC = "c".repeat(64);
  const cleaner = startConcurrencyFixture({ home, mode: "cleanup-racer", now, token: tokenC });
  const parentA = startConcurrencyFixture({ home, mode: "aba-parent-a", now, token: tokenA });
  const parentB = startConcurrencyFixture({ home, mode: "passive-parent", now, token: tokenB });
  try {
    ensureUserStateRootSync(home);
    writeFileSync(
      updateLeasePath(home),
      serializeUpdateLease({
        schema: UPDATE_LEASE_SCHEMA,
        state: "cooldown",
        token: "d".repeat(64),
        started_at: CHECKED_AT,
        expires_at: "2026-08-06T12:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    const cleanerBeforeCleanup = nextChildMessage(cleaner);
    cleaner.send("go");
    assert.deepEqual(await cleanerBeforeCleanup, { type: "before-cooldown-cleanup" });

    const parentAAfterClaim = nextChildMessage(parentA);
    parentA.send("go");
    assert.deepEqual(await parentAAfterClaim, { type: "after-claim" });

    const cleanerAfterCapture = nextChildMessage(cleaner);
    releaseChildBarrier(cleaner);
    assert.deepEqual(await cleanerAfterCapture, { type: "after-cooldown-capture" });

    const parentBResult = nextChildMessage(parentB);
    parentB.send("go");
    assert.deepEqual(await parentBResult, {
      type: "result",
      state: "done",
      spawns: 1,
    });

    const cleanerResult = nextChildMessage(cleaner);
    releaseChildBarrier(cleaner);
    assert.deepEqual(await cleanerResult, { type: "result", state: "occupied" });

    const parentAResult = nextChildMessage(parentA);
    releaseChildBarrier(parentA);
    assert.deepEqual(await parentAResult, {
      type: "result",
      state: "done",
      spawns: 0,
    });
    assert.equal(
      parseUpdateLeaseText(readFileSync(updateLeasePath(home), "utf8"))?.token,
      tokenB,
      "lost-token cleanup must not touch the successor's active lease",
    );
  } finally {
    stopChildren([cleaner, parentA, parentB]);
    rmSync(home, { recursive: true, force: true });
  }
});

test("barrier/IPC: paused parent rechecks newly published cache after claim and starts zero workers", async () => {
  const home = tempHome();
  const child = startConcurrencyFixture({
    home,
    mode: "paused-parent",
    now: "2026-08-05T12:00:01.000Z",
    token: "b".repeat(64),
  });
  try {
    ensureUserStateRootSync(home);
    writeFileSync(updateCachePath(home), "{}\n", { mode: 0o600 });
    child.send("go");
    assert.deepEqual(await nextChildMessage(child), { type: "after-initial-cache-read" });
    writeFileSync(updateCachePath(home), serializeUpdateCache(successfulCheck()), { mode: 0o600 });
    releaseChildBarrier(child);
    const result = await nextChildMessage(child);
    assert.equal(result.state, "done");
    assert.equal(result.spawns, 0);
    assert.deepEqual(result.notice, projectUpdateNotice(successfulCheck()));
    assert.equal(
      claimUpdateLease({ home, now: NOW, token: "c".repeat(64) }).state,
      "claimed",
      "the paused parent's unused claim was released",
    );
  } finally {
    stopChildren([child]);
    rmSync(home, { recursive: true, force: true });
  }
});
