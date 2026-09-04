import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initBundle } from "@superbee/core";
import { credentialsDir } from "../src/credentials.js";
import { isolatedUserEnv } from "./support/user-env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");

before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

interface ChildResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(home: string, args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliBin, ...args], {
      env: isolatedUserEnv(home, { AGENTSTATE_LITE_NO_AUTOPULL: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

function childDiagnostics(results: readonly ChildResult[]): string {
  return results
    .map((result, index) => [
      `child ${index}: status=${result.status}`,
      `stdout:\n${result.stdout || "<empty>"}`,
      `stderr:\n${result.stderr || "<empty>"}`,
    ].join("\n"))
    .join("\n\n");
}

test("built CLI: concurrent catalog writers preserve every distinct registration", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agentstate-lite-catalog-process-")));
  try {
    const home = path.join(root, "home");
    await mkdir(home);
    const bundles = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const bundle = path.join(root, `bundle-${index}`);
        await initBundle(bundle);
        return bundle;
      }),
    );
    const results = await Promise.all(
      bundles.map((bundle, index) => run(home, ["catalog", "add", `workspace-${index}`, "--dir", bundle, "--json"])),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      Array(8).fill(0),
      childDiagnostics(results),
    );

    const listed = await run(home, ["catalog", "list", "--json"]);
    assert.equal(listed.status, 0, childDiagnostics([listed]));
    const receipt = JSON.parse(listed.stdout) as { count: number; entries: Array<{ label: string }> };
    assert.equal(receipt.count, 8);
    assert.deepEqual(
      receipt.entries.map((entry) => entry.label),
      Array.from({ length: 8 }, (_, index) => `workspace-${index}`),
    );
    const persisted = await readFile(path.join(credentialsDir(home), "catalog.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(persisted));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built CLI: racing labels for one path produces one winner and one stable conflict", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agentstate-lite-catalog-conflict-")));
  try {
    const home = path.join(root, "home");
    await mkdir(home);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const results = await Promise.all([
      run(home, ["catalog", "add", "alpha", "--dir", bundle, "--json"]),
      run(home, ["catalog", "add", "beta", "--dir", bundle, "--json"]),
    ]);
    assert.deepEqual(
      results.map((result) => result.status).sort((a, b) => a - b),
      [0, 5],
      childDiagnostics(results),
    );
    const loser = results.find((result) => result.status === 5)!;
    assert.match(loser.stdout, /ALREADY_EXISTS/);

    const listed = await run(home, ["catalog", "list", "--json"]);
    assert.equal(JSON.parse(listed.stdout).count, 1, childDiagnostics([listed]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
