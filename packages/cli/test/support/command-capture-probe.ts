import assert from "node:assert/strict";
import { captureCommand } from "./command-batch.js";
const stdout = process.stdout.write;
const stderr = process.stderr.write;
const exitCode = process.exitCode;
const result = await captureCommand(async () => {
  process.exitCode = 2;
  process.stdout.write(Buffer.from([0x68, 0xc3]));
  process.stdout.write(Buffer.from([0xa9]));
  await new Promise<void>((resolve) => process.stderr.write("error", () => resolve()));
});
assert.deepEqual(result, { status: 2, stdout: "hé", stderr: "error" });
assert.deepEqual(await captureCommand(async () => {}), { status: 0, stdout: "", stderr: "" });
await assert.rejects(captureCommand(async () => { throw new Error("probe throw"); }), /probe throw/);
assert.equal(process.stdout.write, stdout);
assert.equal(process.stderr.write, stderr);
assert.equal(process.exitCode, exitCode);
const previous = process.env.SUPERBEE_BATCH_RED;
try {
  await assert.rejects(captureCommand(async () => { process.env.SUPERBEE_BATCH_RED = "changed"; }), /changed batch environment/);
} finally {
  if (previous === undefined) delete process.env.SUPERBEE_BATCH_RED;
  else process.env.SUPERBEE_BATCH_RED = previous;
}
const cwd = process.cwd();
try {
  await assert.rejects(captureCommand(async () => { process.chdir(".."); }), /changed batch cwd/);
} finally {
  process.chdir(cwd);
}
assert.equal(process.stdout.write, stdout);
assert.equal(process.stderr.write, stderr);
assert.equal(process.exitCode, exitCode);
