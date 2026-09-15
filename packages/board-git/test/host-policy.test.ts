import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureBoardHostPolicy,
  detectBoardChannel,
  existingDirRefusal,
  isProvisioned,
  maybeAutoPull,
  type SyncStore,
  provisionBoardWorktree,
  resolveProvisionedBoardPath,
  worktreeRootResolvesForOwner,
  type BoardHostPolicy,
} from "../src/index.js";
import { makeTwoCloneTopology } from "./git-harness.js";

test("board host snapshots retain method receivers and member identity without freezing caller objects", () => {
  const source = {
    prefix: "selected",
    sameResolvedPath: (a: string, b: string) => a === b,
    moveAsideHelp(p: string, note: string) { return `${this.prefix}:${p}:${note}`; },
  };
  const captured = captureBoardHostPolicy(source);
  source.sameResolvedPath = () => false;
  source.moveAsideHelp = () => "changed";
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(captured.sameResolvedPath("a", "a"), true);
  assert.equal(captured.moveAsideHelp("root", "note"), "selected:root:note");
  assert.match(existingDirRefusal("foreign_checkout", "/root", "/owner", captured).help!, /^selected:/);
});

test("the selected policy reaches root/common-dir ownership, channel detection, provisioning and refusal", async (t) => {
  const topology = await makeTwoCloneTopology();
  t.after(() => topology.cleanup());
  const seen: Array<[string, string]> = [];
  const exact: BoardHostPolicy = {
    sameResolvedPath: (left, right) => { seen.push([left, right]); return left === right; },
    moveAsideHelp: (root, note) => `custom:${root}:${note}`,
  };
  assert.equal(worktreeRootResolvesForOwner(topology.a.board, topology.a.root, exact), true);
  assert.equal(seen.length, 2, "both worktree root and common-dir comparisons use the same policy");
  seen.length = 0;
  assert.equal(isProvisioned(topology.a.root, exact), true);
  assert.equal(resolveProvisionedBoardPath(topology.a.root, exact), topology.a.board);
  assert.equal(detectBoardChannel(topology.a.root, { hostPolicy: exact }).kind, "channel");
  assert.equal(provisionBoardWorktree(topology.a.root, {}, exact).kind, "already");
  assert.ok(seen.length >= 8, "each public path reaches the injected ownership comparisons");
  const neverMatches = { ...exact, sameResolvedPath: () => false };
  assert.equal(worktreeRootResolvesForOwner(topology.a.board, topology.a.root, neverMatches), false);
  assert.equal(isProvisioned(topology.a.root, neverMatches), false);
  assert.equal(resolveProvisionedBoardPath(topology.a.root, neverMatches), null);
  assert.throws(() => provisionBoardWorktree(topology.a.root, {}, neverMatches), (error: unknown) =>
    typeof error === "object" && error !== null && "help" in error && String(error.help).startsWith("custom:"));
  assert.equal(isProvisioned(topology.a.root, exact), true, "the second policy cannot leak into the first");
});

test("unsupported default provisioning rejects before creating or modifying a target", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "sb-board-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "unsupported-test-host" });
  try {
    assert.throws(() => provisionBoardWorktree(root), /explicit board host policy/);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});


test("autopull captures the host before awaiting state and forwards it to ownership proof", async (t) => {
  const topology = await makeTwoCloneTopology();
  t.after(() => topology.cleanup());
  let comparisons = 0;
  let attempts = 0;
  const hostPolicy = {
    sameResolvedPath: (left: string, right: string) => { comparisons++; return left === right; },
    moveAsideHelp: () => "unused",
  };
  const store = {
    async readSyncState() {
      await Promise.resolve();
      hostPolicy.sameResolvedPath = () => false;
      return {};
    },
    async recordAutoPullAttempt() { attempts++; throw new Error("stop before pull; ownership was checked"); },
  } as unknown as SyncStore;
  const outcome = await maybeAutoPull({
    store, hostPolicy, resolveBundleRoot: async () => topology.a.board,
  }, topology.a.board, { env: {} });
  assert.equal(outcome, "error");
  assert.equal(attempts, 1, "the captured exact policy admits the proven board after the caller member changes");
  assert.equal(comparisons, 2, "both root and common-dir proofs receive the captured policy");
});

test("board policy composition uses captured public data and sibling methods", () => {
  const source = {
    data: { prefix: "selected" },
    comparisonKey(value: string) { return `${this.data.prefix}:${value}`; },
    sameResolvedPath(a: string, b: string) { return this.comparisonKey(a) === this.comparisonKey(b); },
    moveAsideHelp(p: string) { return this.comparisonKey(p); },
  };
  const captured = captureBoardHostPolicy(source);
  source.comparisonKey = () => "changed";
  source.data.prefix = "changed";
  assert.equal(captured.sameResolvedPath("A", "a"), false);
  assert.equal(captured.moveAsideHelp("root", "note"), "selected:root");
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.data), false);
});
