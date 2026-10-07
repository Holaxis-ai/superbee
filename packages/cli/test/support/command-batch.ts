import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedUserEnv } from "./user-env.js";

export interface CommandRow { readonly id: string; readonly argv: readonly string[] }
export interface CommandResult { readonly status: number; readonly stdout: string; readonly stderr: string }
export const BUILT_COMMAND = fileURLToPath(new URL("../../../superbee/dist/superbee.mjs", import.meta.url));
const worker = fileURLToPath(new URL("./command-batch-worker.ts", import.meta.url));
const loader = fileURLToPath(new URL("../ts-loader.mjs", import.meta.url));

export function commandEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return isolatedUserEnv(home, {
    ...overrides,
    ASLITE_NO_UPDATE_CHECK: "1", SUPERBEE_NO_UPDATE_CHECK: "1",
    AGENTSTATE_LITE_NO_AUTOPULL: "1", SUPERBEE_NO_AUTOPULL: "1",
  });
}

/** Protocol validation is independent of CLI metadata and never accepts partial completion. */
export function decodeBatch(rows: readonly CommandRow[], payload: string): Map<string, CommandResult> {
  const expected = new Set(rows.map(({ id }) => id));
  assert.equal(expected.size, rows.length, "duplicate requested row id");
  const results = new Map<string, CommandResult>();
  const decoded: unknown = JSON.parse(payload);
  assert.ok(Array.isArray(decoded), "batch response must be an array");
  for (const row of decoded) {
    assert.ok(row && typeof row.id === "string" && expected.has(row.id), "unexpected response row");
    assert.ok(!results.has(row.id), `duplicate response row: ${row.id}`);
    assert.ok(Number.isInteger(row.status) && typeof row.stdout === "string" && typeof row.stderr === "string", "invalid response row");
    results.set(row.id, { status: row.status, stdout: row.stdout, stderr: row.stderr });
  }
  assert.equal(results.size, expected.size, "missing response rows");
  return results;
}

export function runCommandBatch(rows: readonly CommandRow[], options: {
  cwd: string; home: string; env?: NodeJS.ProcessEnv; timeout?: number;
  /** Only harness failure tests replace the worker. */
  worker?: string;
}): Map<string, CommandResult> {
  assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length, "duplicate requested row id");
  const child = spawnSync(process.execPath, ["--import", loader, options.worker ?? worker], {
    cwd: options.cwd, env: commandEnv(options.home, options.env), input: JSON.stringify(rows),
    encoding: "utf8", timeout: options.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, `batch worker signal: ${child.signal}`);
  assert.equal(child.status, 0, `batch worker failed: ${child.stderr}`);
  assert.equal(child.stdout, "", "uncaptured batch worker stdout");
  assert.equal(child.stderr, "", "uncaptured batch worker stderr");
  return decodeBatch(rows, String(child.output[3] ?? ""));
}

export function assertCommandParity(actual: CommandResult, expected: CommandResult, label: string): void {
  assert.deepEqual(actual, expected, `${label}: batch and executable differ`);
}

/** Only serial parse/arity probes belong here; long-lived and side-effect probes use executables. */
export async function captureCommand(run: () => Promise<unknown>): Promise<CommandResult> {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const exitCode = process.exitCode;
  const cwd = process.cwd();
  const env = { ...process.env };
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const capture = (chunks: Buffer[]): typeof process.stdout.write => ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) process.nextTick(done);
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
  process.stdout.write = capture(out);
  process.stderr.write = capture(err);
  try {
    await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(process.cwd(), cwd, "command changed batch cwd");
    assert.deepEqual({ ...process.env }, env, "command changed batch environment");
    return { status: Number(process.exitCode ?? 0), stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    process.exitCode = exitCode;
  }
}
