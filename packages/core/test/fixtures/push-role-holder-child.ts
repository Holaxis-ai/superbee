/** Holds one push role from another process until killed: the cross-process row of `filesystem-push-role.test.ts`. */
import { filesystemPushRoleLocks } from "../../src/filesystem-push-role.js";

const [name, lockRoot] = process.argv.slice(2);
await filesystemPushRoleLocks({ lockRoot: lockRoot! }).request(name!, { ifAvailable: true }, async (lock) => {
  process.send!({ type: lock ? "holding" : "held-elsewhere" });
  await new Promise(() => setInterval(() => {}, 1_000));
});
