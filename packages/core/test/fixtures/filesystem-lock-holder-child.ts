import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireFilesystemMutationLock } from "../../src/filesystem-lock.js";

const [target, portableRoot, lockRoot, mode] = process.argv.slice(2);
if (!target || !portableRoot || !lockRoot) throw new Error("expected target, portable root, and lock root");

// `pause-before-record` stops the claim after its lock directory exists and before its owner record
// is written, so the parent can kill this process inside that window.
if (mode === "pause-before-record") {
  const writeFile = fs.writeFile;
  Object.defineProperty(fs, "writeFile", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof writeFile>) => {
      if (path.basename(String(args[0])) !== "owner.json") return writeFile(...args);
      process.send?.({ type: "paused", lockPath: path.dirname(String(args[0])), pid: process.pid });
      return new Promise<void>(() => {});
    },
  });
}

await acquireFilesystemMutationLock(target, {
  portableRoot,
  lockRoot,
  waitMs: 2_000,
  pollMs: 10,
});
process.send?.({ type: "locked", pid: process.pid });
setInterval(() => {}, 1_000);
