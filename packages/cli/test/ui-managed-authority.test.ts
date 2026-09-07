import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { initBundle, writeDoc } from "@superbee/core";

import {
  MANAGED_UI_PENDING_RECLAIM_MS,
  listManagedUiStatus,
  managedUiAuthority,
  managedUiRecordPath,
  parseManagedUiRecord,
  startOrReuseManagedUi,
  stopManagedUi,
  type ManagedUiControllerOptions,
  type ManagedUiWorkerInput,
} from "../src/ui/managed-authority.js";
import { CliError } from "../src/errors.js";
import { readUserStateFile, userStateDir, writeUserStateFileAtomic0600 } from "../src/user-state.js";
import { parseManagedUiWorkerInput, runManagedUiWorkerInput } from "../src/ui/managed-worker.js";

interface FakeService {
  input: ManagedUiWorkerInput;
  nonce: string;
  token: string;
  port: number;
  state: "ready" | "adopted" | "stopping";
  activeClients: number;
  available: boolean;
  stopStatusPolls: number;
}

function connectionRefused(): TypeError {
  return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}

test("management deadlines include stalled response bodies for status, adopt, and stop", { timeout: 20_000 }, async () => {
  for (const operation of ["status", "adopt", "stop"] as const) {
    const home = await mkdtemp(path.join(tmpdir(), "superbee-body-timeout-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const runtime = fakeRuntime(home);
    const authority = managedUiAuthority("/canonical/body-timeout", undefined);
    const ordinaryFetch = runtime.options.fetch!;
    try {
      if (operation !== "adopt") await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
      runtime.options.fetch = (async (url, init) => String(url).endsWith(`/${operation}`)
        ? fetch(`http://127.0.0.1:${address.port}/`, init)
        : ordinaryFetch(url, init)) as typeof fetch;
      const before = Date.now();
      if (operation === "status") {
        const receipt = await stopManagedUi(authority, { ...runtime.options, abandon: true });
        assert.equal(receipt.abandoned, true);
        assert.equal(runtime.services[0]!.state, "adopted");
      } else {
        await assert.rejects(() => operation === "adopt"
          ? startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options)
          : stopManagedUi(authority, runtime.options), /abort/i);
      }
      assert.ok(Date.now() - before < 6000, `${operation} exceeded its response deadline`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }
});

function fakeRuntime(home: string): {
  options: ManagedUiControllerOptions;
  services: FakeService[];
  spawnCount: () => number;
} {
  const services: FakeService[] = [];
  let spawns = 0;
  const options: ManagedUiControllerOptions = {
    home,
    launchIdentity: { canonical_root: "/canonical/fake", dev: "1", ino: "1" },
    spawnWorker: async (input) => {
      spawns += 1;
      // Widen the critical section so concurrent controllers genuinely contend on the shared lock.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const service: FakeService = {
        input,
        nonce: `nonce-${spawns}`,
        token: `browser-${spawns}`,
        port: input.port || 50_000 + spawns,
        state: "ready",
        activeClients: 0,
        available: true,
        stopStatusPolls: 0,
      };
      services.push(service);
      return {
        host: "127.0.0.1",
        port: service.port,
        browser_token: service.token,
        launch_nonce: service.nonce,
        pid: 100 + spawns,
        started_at: "2026-09-01T00:00:00.000Z",
      };
    },
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const service = services.find((item) => item.port === Number(url.port));
      if (!service?.available) throw connectionRefused();
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-superbee-management-secret"), service.input.management_secret);
      assert.equal(headers.get("x-superbee-launch-nonce"), service.nonce);
      if (url.pathname.endsWith("/status")) {
        if (service.state === "stopping" && service.stopStatusPolls <= 0) {
          service.available = false;
          throw connectionRefused();
        }
        if (service.state === "stopping") service.stopStatusPolls -= 1;
        return Response.json({
          protocol: service.input.authority.protocol,
          mode: "dir",
          authority_key: service.input.authority.key,
          bundle_root: service.input.authority.bundle_root,
          launch_root: service.input.authority.launch_root,
          actor: service.input.authority.actor,
          launch_nonce: service.nonce,
          state: service.state,
          active_clients: service.activeClients,
        });
      }
      if (url.pathname.endsWith("/adopt")) service.state = "adopted";
      if (url.pathname.endsWith("/stop")) service.state = "stopping";
      return Response.json({ launch_nonce: service.nonce });
    }) as typeof fetch,
  };
  return { options, services, spawnCount: () => spawns };
}

async function publishRecord(home: string, authority: ReturnType<typeof managedUiAuthority>, value: object): Promise<void> {
  const recordFile = managedUiRecordPath(authority, home);
  await writeUserStateFileAtomic0600(home, userStateDir(home), path.basename(recordFile), `${JSON.stringify(value)}\n`);
}

test("authority identity uses canonical bundle + exact actor, not port or executable version", () => {
  const absent = managedUiAuthority("/canonical/bundle", undefined);
  const absentAgain = managedUiAuthority("/canonical/bundle", undefined);
  const mike = managedUiAuthority("/canonical/bundle", "mike");
  assert.equal(absent.key, absentAgain.key);
  assert.notEqual(absent.key, mike.key);
  assert.equal(absent.actor, null);
  assert.equal(mike.actor, "mike");
});

test("strict record parser rejects extra authority, partial live state, and PID-shaped pending claims", () => {
  const authority = managedUiAuthority("/canonical/bundle", undefined);
  const pending = {
    schema_version: 1,
    phase: "pending",
    operation_id: "operation",
    authority,
    management_secret: "secret",
    created_at: "2026-09-01T00:00:00.000Z",
  };
  assert.equal(parseManagedUiRecord(JSON.stringify(pending)).phase, "pending");
  assert.throws(() => parseManagedUiRecord(JSON.stringify({ ...pending, pid: 42 })), /pending record/);
  assert.throws(() => parseManagedUiRecord(JSON.stringify({ ...pending, surprise: true })), /unsupported shape/);
  assert.throws(() => parseManagedUiRecord(JSON.stringify({ ...pending, phase: "adopted", port: 1 })), /incomplete/);
  assert.throws(() => parseManagedUiRecord(JSON.stringify({ ...pending, authority: { ...authority, extra: true } })), /invalid authority/);
});

test("start, compatible reuse, status, pinned-port refusal, and exact stop form one lifecycle", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-controller-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/bundle", undefined);
  try {
    const first = await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    assert.equal(first.state, "started");
    assert.equal(runtime.spawnCount(), 1);
    assert.equal(runtime.services[0]!.state, "adopted");

    const second = await startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options);
    assert.equal(second.state, "reused");
    assert.equal(runtime.spawnCount(), 1);
    assert.equal(new URL(second.url).searchParams.get("id"), "docs/two");

    const statuses = await listManagedUiStatus(authority.bundle_root, runtime.options);
    assert.deepEqual(statuses.map((item) => [item.phase, item.live, item.port]), [["adopted", true, first.record.port]]);

    await assert.rejects(
      () => startOrReuseManagedUi(authority, "docs/three", 55_555, runtime.options),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "CONFLICT");
        assert.match(error.help ?? "", /ui --stop/);
        assert.match(error.help ?? "", /--port 55555/);
        return true;
      },
    );

    assert.deepEqual(await stopManagedUi(authority, runtime.options), { stopped: true, abandoned: false, authority });
    assert.equal(runtime.services[0]!.state, "stopping");
    assert.deepEqual(await listManagedUiStatus(authority.bundle_root, runtime.options), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent launches converge through the shared cross-process authority lock", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-converge-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/concurrent", "agent");
  try {
    const receipts = await Promise.all(
      Array.from({ length: 6 }, (_, index) => startOrReuseManagedUi(authority, `docs/${index}`, undefined, runtime.options)),
    );
    assert.equal(runtime.spawnCount(), 1);
    assert.equal(new Set(receipts.map((item) => new URL(item.url).origin)).size, 1);
    assert.equal(receipts.filter((item) => item.state === "started").length, 1);
    assert.equal(receipts.filter((item) => item.state === "reused").length, 5);
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a valid startup longer than the generic five-second lock wait still converges", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-slow-converge-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/slow-concurrent", "agent");
  const spawnWorker = runtime.options.spawnWorker!;
  runtime.options.spawnWorker = async (input) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 5_200));
    return spawnWorker(input);
  };
  try {
    const [first, second] = await Promise.all([
      startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options),
      startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options),
    ]);
    assert.equal(runtime.spawnCount(), 1);
    assert.deepEqual(new Set([first.state, second.state]), new Set(["started", "reused"]));
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fresh and expired pending records have deterministic interruption recovery", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-pending-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/pending", undefined);
  const created = Date.parse("2026-09-01T00:00:00.000Z");
  const pending = {
    schema_version: 1,
    phase: "pending",
    operation_id: "interrupted-parent",
    authority,
    management_secret: "pending-secret",
    created_at: new Date(created).toISOString(),
  };
  try {
    await publishRecord(home, authority, pending);
    await assert.rejects(
      () => startOrReuseManagedUi(authority, "docs/one", undefined, {
        ...runtime.options,
        now: () => created + MANAGED_UI_PENDING_RECLAIM_MS - 1,
      }),
      (error: unknown) => error instanceof CliError && error.code === "TRANSIENT",
    );
    assert.equal(runtime.spawnCount(), 0);

    const recovered = await startOrReuseManagedUi(authority, "docs/one", undefined, {
      ...runtime.options,
      now: () => created + MANAGED_UI_PENDING_RECLAIM_MS,
    });
    assert.equal(recovered.state, "started");
    assert.equal(runtime.spawnCount(), 1);
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("startup transport preserves exact 64-bit filesystem identities instead of lossy JSON numbers", () => {
  const canonicalRoot = path.resolve("managed-large-identity");
  const authority = managedUiAuthority(canonicalRoot, undefined);
  const input = {
    schema_version: 1,
    operation_id: "large-identity",
    authority,
    management_secret: "a".repeat(32),
    startup_deadline_at: "2026-09-02T12:00:00.000Z",
    launch_identity: {
      canonical_root: canonicalRoot,
      dev: "18446744073709551615",
      ino: "9223372036854775808",
    },
    port: 0,
  } satisfies ManagedUiWorkerInput;
  assert.deepEqual(parseManagedUiWorkerInput(JSON.stringify(input)), input);
  assert.throws(
    () => parseManagedUiWorkerInput(JSON.stringify({ ...input, launch_identity: { ...input.launch_identity, ino: Number.MAX_SAFE_INTEGER + 1 } })),
    /inode identity is invalid/u,
  );
});

test("a child whose pre-listen boot exceeds the absolute operation deadline terminates before pending reclaim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-managed-deadline-"));
  const canonicalRoot = await realpath(root);
  const metadata = await stat(canonicalRoot, { bigint: true });
  const authority = managedUiAuthority(canonicalRoot, undefined, root);
  let terminated = false;
  const started = Date.now();
  try {
    await assert.rejects(
      () => runManagedUiWorkerInput({
        schema_version: 1,
        operation_id: "slow-pre-listen",
        authority,
        management_secret: "a".repeat(32),
        startup_deadline_at: new Date(started + 30).toISOString(),
        launch_identity: { canonical_root: canonicalRoot, dev: metadata.dev.toString(), ino: metadata.ino.toString() },
        port: 0,
      }, {
        terminate: () => { terminated = true; },
        launchUi: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 70));
        },
      }),
      /startup deadline expired/u,
    );
    assert.equal(terminated, true);
    assert.ok(Date.now() - started < MANAGED_UI_PENDING_RECLAIM_MS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready and adopted child states recover an interrupted parent adoption idempotently", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-adoption-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/adoption", "agent");
  try {
    const first = await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    const readyRecord = { ...first.record, phase: "ready" };
    await publishRecord(home, authority, readyRecord);
    runtime.services[0]!.state = "ready";

    const resumedReady = await startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options);
    assert.equal(resumedReady.state, "reused");
    assert.equal(resumedReady.record.phase, "adopted");
    assert.equal(runtime.services[0]!.state, "adopted");
    assert.equal(runtime.spawnCount(), 1);

    // Parent interruption after the child acknowledged adopt but before the record advanced.
    await publishRecord(home, authority, readyRecord);
    const resumedAdopted = await startOrReuseManagedUi(authority, "docs/three", undefined, runtime.options);
    assert.equal(resumedAdopted.state, "reused");
    assert.equal(resumedAdopted.record.phase, "adopted");
    assert.equal(runtime.spawnCount(), 1);
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an interrupted stop is resumed, exit is proven, and only then is the authority replaced", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-stopping-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/stopping", undefined);
  try {
    const first = await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    await publishRecord(home, authority, { ...first.record, phase: "stopping" });
    runtime.services[0]!.state = "stopping";
    runtime.services[0]!.stopStatusPolls = 2;
    const replacement = await startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options);
    assert.equal(replacement.state, "started");
    assert.equal(runtime.spawnCount(), 2);
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a transient or rejected status probe preserves the exact record and never starts a duplicate", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-uncertain-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/uncertain", undefined);
  try {
    await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    const ordinaryFetch = runtime.options.fetch!;
    let uncertain = true;
    runtime.options.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (uncertain && new URL(String(args[0])).pathname.endsWith("/status")) {
        return new Response("busy", { status: 503 });
      }
      return ordinaryFetch(...args);
    }) as typeof fetch;
    await assert.rejects(
      () => startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options),
      (error: unknown) => error instanceof CliError && error.code === "TRANSIENT",
    );
    assert.equal(runtime.spawnCount(), 1);
    assert.equal((await listManagedUiStatus(authority.bundle_root, runtime.options))[0]!.live, "unknown");
    uncertain = false;
    assert.equal((await startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options)).state, "reused");
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a listener that never answers is reported, refuses takeover, and is released only by explicit abandon", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-hung-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/hung", undefined);
  const other = managedUiAuthority("/canonical/hung", "other");
  try {
    const first = await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    const healthy = await startOrReuseManagedUi(other, "docs/one", undefined, runtime.options);
    const ordinaryFetch = runtime.options.fetch!;
    // The recorded listener accepts the connection and never produces a response, so only the
    // client's own timeout bound ends the probe: the reported managed-UI open failure.
    runtime.options.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = new URL(String(args[0]));
      if (Number(url.port) === first.record.port && url.pathname.endsWith("/status")) {
        return new Promise<Response>((_resolve, reject) => {
          // A referenced timer so the pending request itself keeps the loop alive, exactly as a real
          // socket would: the probe's own abort timer is unref'd and must not be the only work left.
          const stuck = setTimeout(() => reject(new Error("the probe never bounded its own wait")), 30_000);
          args[1]?.signal?.addEventListener("abort", () => {
            clearTimeout(stuck);
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        });
      }
      return ordinaryFetch(...args);
    }) as typeof fetch;

    await assert.rejects(
      () => startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "TRANSIENT");
        assert.deepEqual(error.details, {
          port: first.record.port,
          pid: first.record.pid,
          phase: "adopted",
          started_at: first.record.started_at,
        });
        assert.match(error.help ?? "", /ui --stop .*--abandon/u);
        return true;
      },
    );
    assert.equal(runtime.spawnCount(), 2);

    const hungStatus = (await listManagedUiStatus(authority.bundle_root, runtime.options))
      .find((item) => item.authority.actor === null)!;
    assert.equal(hungStatus.live, "unknown");
    assert.equal(hungStatus.pid, first.record.pid);

    // Without explicit authorization the documented stop is gated by the same unanswerable probe.
    await assert.rejects(
      () => stopManagedUi(authority, runtime.options),
      (error: unknown) => error instanceof CliError && error.code === "TRANSIENT",
    );

    assert.deepEqual(
      await stopManagedUi(authority, { ...runtime.options, abandon: true }),
      { stopped: false, abandoned: true, authority },
    );
    // The abandoned worker was never signaled, and no other actor's authority was touched.
    assert.equal(runtime.services[0]!.state, "adopted");
    assert.deepEqual(
      (await listManagedUiStatus(authority.bundle_root, runtime.options)).map((item) => [item.authority.actor, item.live]),
      [[healthy.authority.actor, true]],
    );

    const replacement = await startOrReuseManagedUi(authority, "docs/three", undefined, runtime.options);
    assert.equal(replacement.state, "started");
    assert.notEqual(replacement.record.launch_nonce, first.record.launch_nonce);
    await stopManagedUi(authority, runtime.options);
    await stopManagedUi(other, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("--abandon refuses an authority that answers as live", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-abandon-live-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/abandon-live", undefined);
  try {
    await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    await assert.rejects(
      () => stopManagedUi(authority, { ...runtime.options, abandon: true }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "CONFLICT");
        assert.match(error.help ?? "", /ui --stop/u);
        return true;
      },
    );
    assert.equal(runtime.services[0]!.state, "adopted");
    assert.equal((await listManagedUiStatus(authority.bundle_root, runtime.options)).length, 1);
    assert.equal((await stopManagedUi(authority, runtime.options)).stopped, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a responsive listener that proves it is not this authority releases the recorded slot", async () => {
  const foreign: Array<[string, () => Response]> = [
    ["forbidden", () => new Response("nope", { status: 403 })],
    ["unavailable", () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })],
    ["mismatched", () => Response.json({
      protocol: 1,
      mode: "dir",
      authority_key: "0".repeat(64),
      bundle_root: "/canonical/somewhere-else",
      launch_root: "/canonical/somewhere-else",
      actor: null,
      launch_nonce: "another-launch",
      state: "adopted",
      active_clients: 0,
    })],
  ];
  for (const [label, respond] of foreign) {
    const home = await mkdtemp(path.join(tmpdir(), `superbee-managed-foreign-${label}-`));
    const runtime = fakeRuntime(home);
    const authority = managedUiAuthority(`/canonical/foreign-${label}`, undefined);
    try {
      const first = await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
      const ordinaryFetch = runtime.options.fetch!;
      runtime.options.fetch = (async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]));
        if (Number(url.port) === first.record.port && url.pathname.endsWith("/status")) return respond();
        return ordinaryFetch(...args);
      }) as typeof fetch;

      const replacement = await startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options);
      assert.equal(replacement.state, "started", label);
      assert.equal(runtime.spawnCount(), 2, label);
      assert.notEqual(replacement.record.launch_nonce, first.record.launch_nonce);
      await stopManagedUi(authority, runtime.options);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("an unreachable exact record is replaced without using its recorded PID as authority", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-stale-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/stale", undefined);
  try {
    const first = await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    runtime.services[0]!.available = false;
    const second = await startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options);
    assert.equal(first.record.pid, 101);
    assert.equal(second.state, "started");
    assert.equal(runtime.spawnCount(), 2);
    assert.notEqual(first.record.launch_nonce, second.record.launch_nonce);
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an incompatible active authority refuses; once idle it is deliberately stopped and replaced", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-upgrade-"));
  const runtime = fakeRuntime(home);
  const authority = managedUiAuthority("/canonical/upgrade", undefined);
  try {
    const first = await startOrReuseManagedUi(authority, "docs/one", undefined, runtime.options);
    const recordFile = managedUiRecordPath(authority, home);
    const raw = await readUserStateFile(home, recordFile, 32 * 1024);
    const oldRecord = { ...JSON.parse(raw), authority: { ...JSON.parse(raw).authority, protocol: 2 } };
    runtime.services[0]!.input = { ...runtime.services[0]!.input, authority: oldRecord.authority };
    runtime.services[0]!.activeClients = 1;
    await writeUserStateFileAtomic0600(home, userStateDir(home), path.basename(recordFile), `${JSON.stringify(oldRecord)}\n`);

    await assert.rejects(
      () => startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "CONFLICT");
        assert.match(error.message, /incompatible/);
        return true;
      },
    );
    assert.equal(runtime.spawnCount(), 1);

    runtime.services[0]!.activeClients = 0;
    const replaced = await startOrReuseManagedUi(authority, "docs/two", undefined, runtime.options);
    assert.equal(replaced.state, "started");
    assert.equal(runtime.services[0]!.state, "stopping");
    assert.equal(runtime.spawnCount(), 2);
    assert.notEqual(replaced.record.launch_nonce, first.record.launch_nonce);
    await stopManagedUi(authority, runtime.options);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("built CLI returns while its managed document remains live, then reuses, reports, and stops it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-managed-built-"));
  const home = await mkdtemp(path.join(tmpdir(), "superbee-managed-built-home-"));
  const bundleRoot = path.join(root, "bundle");
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/superbee.mjs");
  await initBundle(bundleRoot);
  await writeDoc({ root: bundleRoot }, { id: "docs/live", frontmatter: { type: "Doc", title: "Live" }, body: "# Live" });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    // Prevent this test from opening a real browser. The URL remains the authoritative fallback.
    PATH: "",
  };
  const run = (args: string[]): Record<string, unknown> => {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  try {
    const first = run(["doc", "open", "docs/live", "--dir", bundleRoot]);
    assert.equal(first.state, "started");
    assert.equal((await fetch(String(first.url))).status, 200);

    const second = run(["doc", "open", "docs/live", "--dir", bundleRoot]);
    assert.equal(second.state, "reused");
    assert.equal(second.url, first.url);

    const literalAbsent = run(["doc", "open", "docs/live", "--dir", bundleRoot, "--actor", "absent"]);
    assert.equal(literalAbsent.state, "started");

    const status = run(["ui", "--status", "--dir", bundleRoot]);
    const instances = status.instances as Array<Record<string, unknown>>;
    assert.equal(status.count, 2);
    assert.equal(status.shown, 2);
    assert.deepEqual(
      instances
        .map((item) => [item.actor, item.actor_present, item.live])
        .sort((left, right) => Number(left[1]) - Number(right[1])),
      [[null, false, true], ["absent", true, true]],
    );
    const bounded = run(["ui", "--status", "--dir", bundleRoot, "--limit", "1"]);
    assert.equal(bounded.count, 2);
    assert.equal(bounded.shown, 1);
    assert.ok(Array.isArray(bounded.help));
    assert.match(String((bounded.help as string[])[0]), /ui --status .* --limit 0/u);

    const stopped = run(["ui", "--stop", "--dir", bundleRoot]);
    assert.equal(stopped.stopped, true);
    await assert.rejects(() => fetch(String(first.url)));
    assert.equal(run(["ui", "--stop", "--dir", bundleRoot, "--actor", "absent"]).stopped, true);

    const releasedPort = new URL(String(first.url)).port;
    const restarted = run(["doc", "open", "docs/live", "--dir", bundleRoot, "--port", releasedPort]);
    assert.equal(restarted.state, "started");
    assert.equal(new URL(String(restarted.url)).port, releasedPort);
    assert.equal((await fetch(String(restarted.url))).status, 200);
    assert.equal(run(["ui", "--stop", "--dir", bundleRoot]).stopped, true);
  } finally {
    // Best-effort exact-authority cleanup if an assertion failed before the ordinary stop.
    spawnSync(process.execPath, [cli, "ui", "--stop", "--dir", bundleRoot, "--json"], { env, encoding: "utf8", timeout: 5_000 });
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
