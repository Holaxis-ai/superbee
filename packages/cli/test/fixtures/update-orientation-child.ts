import { EventEmitter } from "node:events";
import { readSync } from "node:fs";

import {
  claimUpdateLease,
  runPassiveUpdateOrientation,
} from "../../src/update-orientation.js";

const home = process.env.ASLITE_TEST_HOME!;
const mode = process.env.ASLITE_TEST_MODE!;
const now = new Date(process.env.ASLITE_TEST_NOW!);
const token = process.env.ASLITE_TEST_TOKEN!;

function send(message: unknown): void {
  process.send?.(message);
}

function finish(message: unknown): void {
  process.send?.(message, () => process.disconnect?.());
}

function barrier(label: string): void {
  send({ type: label });
  const byte = Buffer.alloc(1);
  readSync(4, byte, 0, 1, null);
}

class SilentChild extends EventEmitter {
  unref(): void {}
}

function passiveParent(barriers: {
  afterClaim?: () => void;
  afterInitialCacheRead?: () => void;
} = {}): { spawns: number; notice: unknown } {
  let spawns = 0;
  const notice = runPassiveUpdateOrientation({
    home,
    runningVersion: "0.1.0-pre.3",
    now: () => now,
    token: () => token,
    executablePath: () => "/opt/aslite/dist/agentstate-lite.mjs",
    afterClaim: barriers.afterClaim,
    afterInitialCacheRead: barriers.afterInitialCacheRead,
    spawn: () => {
      spawns += 1;
      return new SilentChild();
    },
  });
  return { spawns, notice };
}

process.once("message", (message) => {
  if (message !== "go") return;
  if (mode === "claim") {
    const result = claimUpdateLease({ home, now, token });
    finish({ type: "result", state: result.state });
  } else if (mode === "stale") {
    const result = claimUpdateLease({
      home,
      now,
      token,
      beforeStaleReplace: () => barrier("before-stale-replace"),
    });
    finish({ type: "result", state: result.state });
  } else if (mode === "paused-parent") {
    const { spawns, notice } = passiveParent({
      afterInitialCacheRead: () => barrier("after-initial-cache-read"),
    });
    finish({ type: "result", state: "done", spawns, notice });
  } else if (mode === "cleanup-racer") {
    const result = claimUpdateLease({
      home,
      now,
      token,
      beforeExpiredCooldownCleanup: () => barrier("before-cooldown-cleanup"),
      afterExpiredCooldownCapture: () => barrier("after-cooldown-capture"),
    });
    finish({ type: "result", state: result.state });
  } else if (mode === "aba-parent-a") {
    const first = passiveParent();
    const second = passiveParent({ afterClaim: () => barrier("after-claim") });
    finish({
      type: "result",
      state: "done",
      spawns: first.spawns + second.spawns,
      notice: second.notice,
    });
  } else if (mode === "passive-parent") {
    const { spawns, notice } = passiveParent();
    finish({ type: "result", state: "done", spawns, notice });
  }
});
