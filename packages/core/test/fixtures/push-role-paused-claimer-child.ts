/**
 * A push-role claimer suspended between its `mkdir` and its owner record, as Ctrl-Z or laptop
 * sleep leaves one: the first owner-record write reports `paused` and waits for `resume` before
 * it runs. Reports what the request then answered. The cross-process rollback row of
 * `filesystem-push-role.test.ts`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { filesystemPushRoleLocks } from "../../src/filesystem-push-role.js";

const [name, lockRoot] = process.argv.slice(2);
const resumed = new Promise<void>((resolve) => process.once("message", () => resolve()));
const writeFile = fs.writeFile;
let paused = false;
(fs as { writeFile: typeof fs.writeFile }).writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
  if (!paused && path.basename(String(args[0])) === "owner.json") {
    paused = true;
    process.send!({ type: "paused" });
    await resumed;
  }
  return Reflect.apply(writeFile, fs, args);
}) as typeof fs.writeFile;

let outcome: Record<string, unknown>;
try {
  outcome = await filesystemPushRoleLocks({ lockRoot: lockRoot!, contentionWaitMs: 50, pollMs: 10 }).request(name!, { ifAvailable: true }, async (lock) => ({ type: lock ? "held" : "held-elsewhere" }));
} catch (error) {
  outcome = { type: "rejected", message: error instanceof Error ? error.message : String(error), code: (error as NodeJS.ErrnoException).code };
}
process.send!(outcome, () => process.exit(0));
