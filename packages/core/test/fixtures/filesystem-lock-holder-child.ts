import { acquireFilesystemMutationLock } from "../../src/filesystem-lock.js";

const [target, portableRoot, lockRoot] = process.argv.slice(2);
if (!target || !portableRoot || !lockRoot) throw new Error("expected target, portable root, and lock root");

await acquireFilesystemMutationLock(target, {
  portableRoot,
  lockRoot,
  waitMs: 2_000,
  pollMs: 10,
});
process.send?.({ type: "locked", pid: process.pid });
setInterval(() => {}, 1_000);
