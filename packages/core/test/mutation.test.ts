// `versionedMutation` (core's ONE read-decide-CAS-retry primitive, `mutation.ts`) — the structural
// tests below exercise it directly, over a tiny fake versioned store, deliberately WITHOUT any
// bundle/backend involved: the primitive is backend-neutral by design (S/R are caller-chosen), so a
// bundle-shaped harness would only add noise. Adversarial per-guard CLI tests (F1, schema-loss,
// dropped_fields, kind-field merge, link add) live in their own consumer test files — this file is
// the primitive's own contract, proven once.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ConcurrentReplacementError } from "../src/errors.js";
import { versionedMutation } from "../src/mutation.js";
import { VersionConflict } from "../src/versioning.js";
import type { Version } from "../src/types.js";

/**
 * A minimal versioned string store: `read`/`write` mirror `StorageBackend`'s CAS contract
 * (enforced, synchronous — no check-then-write window) and `raceWrite` mutates the store directly,
 * bypassing CAS entirely — simulating a DIFFERENT writer's successful concurrent change landing
 * between the primitive's own read and its own write.
 */
class FakeStore {
  private state: string | undefined;
  private version: Version | null = null;
  private seq = 0;

  seed(state: string): void {
    this.seq++;
    this.state = state;
    this.version = `v${this.seq}`;
  }

  read(): { state: string | undefined; version: Version | null } {
    return { state: this.state, version: this.version };
  }

  /** A competing writer's change, applied directly — never goes through CAS. */
  raceWrite(next: string): void {
    this.seq++;
    this.state = next;
    this.version = `v${this.seq}`;
  }

  write(next: string, expectedVersion: Version | null): Version {
    if (expectedVersion !== this.version) {
      throw new VersionConflict("fake", expectedVersion, this.version);
    }
    this.seq++;
    this.state = next;
    this.version = `v${this.seq}`;
    return this.version;
  }
}

test("re-derivation: decide re-runs against EVERY attempt's fresh read — a stale-retry implementation (decide once, retry the write with a newer token) fails this by construction", async () => {
  const store = new FakeStore();
  store.seed("a");
  const decideCalls: (string | undefined)[] = [];
  let raced = false;

  const outcome = await versionedMutation<string, string>({
    read: async () => store.read(),
    decide: async (state, attempt) => {
      decideCalls.push(state);
      if (attempt === 0 && !raced) {
        raced = true;
        // A concurrent writer lands between OUR read (just above) and OUR write (below).
        store.raceWrite(`${state}+race`);
      }
      return { action: "write", next: `${state}+mine`, result: `${state}+mine` };
    },
    write: async (next, expectedVersion) => store.write(next, expectedVersion),
  });

  // decide ran TWICE — once per attempt — never a decision computed once and blindly retried.
  assert.equal(decideCalls.length, 2);
  assert.equal(decideCalls[0], "a");
  assert.equal(decideCalls[1], "a+race"); // the 2nd decide saw the COMPETING state, not the stale one
  // The committed content is derived from the SECOND (post-race) decide, so the competing writer's
  // change survives inside our own committed result — a stale-retry helper (which would have
  // recomputed "a+mine" once and merely retried the CAS) fails this assertion by construction.
  assert.equal(outcome.result, "a+race+mine");
  assert.equal(store.read().state, "a+race+mine");
  assert.equal(outcome.wrote, true);
});

test("version pairing: each attempt's write CASes with THAT attempt's own read version, never a stale or a later one", async () => {
  const store = new FakeStore();
  store.seed("a");
  const readVersions: (Version | null)[] = [];
  const writeCalls: { expectedVersion: Version | null }[] = [];
  let raced = false;

  await versionedMutation<string, void>({
    read: async () => {
      const r = store.read();
      readVersions.push(r.version);
      return r;
    },
    decide: async (state, attempt) => {
      if (attempt === 0 && !raced) {
        raced = true;
        store.raceWrite(`${state}-raced`);
      }
      return { action: "write", next: `${state}-mine`, result: undefined };
    },
    write: async (next, expectedVersion) => {
      writeCalls.push({ expectedVersion });
      return store.write(next, expectedVersion);
    },
  });

  assert.equal(readVersions.length, 2);
  assert.equal(writeCalls.length, 2);
  // Attempt 0's write was CASed with attempt 0's OWN read version (which is why it conflicted)...
  assert.equal(writeCalls[0]!.expectedVersion, readVersions[0]);
  // ...and attempt 1's write was CASed with attempt 1's OWN (fresher) read version — never attempt
  // 0's stale one, and never some version from beyond attempt 1's own read.
  assert.equal(writeCalls[1]!.expectedVersion, readVersions[1]);
  assert.notEqual(readVersions[0], readVersions[1]);
});

test("budget: a competing writer before EVERY attempt exhausts maxAttempts and rethrows the FINAL VersionConflict unchanged", async () => {
  const store = new FakeStore();
  store.seed("a");
  let decides = 0;
  const maxAttempts = 3;

  await assert.rejects(
    () =>
      versionedMutation<string, void>({
        read: async () => store.read(),
        decide: async (state) => {
          decides++;
          // Race EVERY attempt — never lets a write actually land.
          store.raceWrite(`${state}-race${decides}`);
          return { action: "write", next: `${state}-mine`, result: undefined };
        },
        write: async (next, expectedVersion) => store.write(next, expectedVersion),
        maxAttempts,
      }),
    (err: unknown) => err instanceof VersionConflict,
  );

  assert.equal(decides, maxAttempts); // exactly the budget, no more, no fewer
});

test("convergence: a retry's decide can converge (done) instead of writing again — e.g. a competing writer already made the identical change", async () => {
  const store = new FakeStore();
  store.seed("a");
  let writeCalls = 0;
  let raced = false;

  const outcome = await versionedMutation<string, string>({
    read: async () => store.read(),
    decide: async (state, attempt) => {
      if (state === "a-mine") return { action: "done", result: "already-there" };
      if (attempt === 0 && !raced) {
        raced = true;
        // A competing writer makes the EXACT change we were about to make ourselves.
        store.raceWrite("a-mine");
      }
      return { action: "write", next: "a-mine", result: "wrote" };
    },
    write: async (next, expectedVersion) => {
      writeCalls++;
      return store.write(next, expectedVersion);
    },
  });

  // Attempt 0's write was attempted (and conflicted); attempt 1 never called write() at all —
  // decide converged instead.
  assert.equal(writeCalls, 1);
  assert.equal(outcome.wrote, false);
  assert.equal(outcome.result, "already-there");
  assert.equal(store.read().state, "a-mine"); // the competing writer's change, untouched by us
});

test("expect-absent race: a concurrent create between our absent-read and our create-write is retried against the fresh doc, not silently clobbered", async () => {
  const store = new FakeStore(); // starts absent (state undefined, version null)
  let raced = false;

  const outcome = await versionedMutation<string, string>({
    read: async () => store.read(),
    decide: async (state, attempt) => {
      if (attempt === 0 && !raced) {
        raced = true;
        store.raceWrite("concurrently-created");
      }
      return state === undefined
        ? { action: "write", next: "mine", result: "created" }
        : { action: "write", next: `${state}+mine`, result: "merged" };
    },
    write: async (next, expectedVersion) => store.write(next, expectedVersion),
  });

  assert.equal(outcome.result, "merged"); // the retry saw the concurrent create, not a stale absence
  assert.equal(store.read().state, "concurrently-created+mine");
});

test("maxAttempts: 1 makes a conflict TERMINAL — no retry even though a normal budget would allow one", async () => {
  const store = new FakeStore();
  store.seed("a");
  let decides = 0;

  await assert.rejects(
    () =>
      versionedMutation<string, void>({
        read: async () => store.read(),
        decide: async (state) => {
          decides++;
          store.raceWrite(`${state}-race`);
          return { action: "write", next: `${state}-mine`, result: undefined };
        },
        write: async (next, expectedVersion) => store.write(next, expectedVersion),
        maxAttempts: 1,
      }),
    (err: unknown) => err instanceof VersionConflict,
  );

  assert.equal(decides, 1);
});

// ── AC-19: read-phase ConcurrentReplacementError is the same contention, retried on the same budget ──

test("AC-19: a read that throws ConcurrentReplacementError twice then succeeds is retried; the mutation succeeds with two retries recorded", async () => {
  const store = new FakeStore();
  store.seed("a");
  let reads = 0;
  const attempts: number[] = [];
  const outcome = await versionedMutation<string, string>({
    read: async () => {
      reads++;
      if (reads <= 2) throw new ConcurrentReplacementError("concepts/a.md", 4);
      return store.read();
    },
    decide: async (state, attempt) => {
      attempts.push(attempt);
      return { action: "write", next: `${state}+mine`, result: "ok" };
    },
    write: async (next, expectedVersion) => store.write(next, expectedVersion),
  });
  assert.equal(reads, 3);
  assert.deepEqual(attempts, [2], "decide ran once, on the third attempt");
  assert.equal(outcome.result, "ok");
  assert.equal(outcome.wrote, true);
  assert.equal(store.read().state, "a+mine");
});

test("AC-19: a read that throws ConcurrentReplacementError beyond the bound propagates it unchanged; maxAttempts: 1 makes it terminal", async () => {
  const thrown = new ConcurrentReplacementError("concepts/a.md", 4);
  let reads = 0;
  await assert.rejects(
    () =>
      versionedMutation<string, string>({
        read: async () => {
          reads++;
          throw thrown;
        },
        decide: () => assert.fail("decide must not run without a read"),
        write: () => assert.fail("write must not run without a read"),
        maxAttempts: 3,
      }),
    (err: unknown) => err === thrown,
  );
  assert.equal(reads, 3, "read-phase retries share the attempt budget");

  reads = 0;
  await assert.rejects(
    () =>
      versionedMutation<string, string>({
        read: async () => {
          reads++;
          throw thrown;
        },
        decide: () => assert.fail("decide must not run"),
        write: () => assert.fail("write must not run"),
        maxAttempts: 1,
      }),
    (err: unknown) => err === thrown,
  );
  assert.equal(reads, 1);

  // Any other read error stays terminal on the first attempt.
  await assert.rejects(
    () =>
      versionedMutation<string, string>({
        read: async () => {
          throw new Error("disk on fire");
        },
        decide: () => assert.fail("decide must not run"),
        write: () => assert.fail("write must not run"),
      }),
    /disk on fire/,
  );
});
