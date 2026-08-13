/**
 * Hook-command stability across the coordinate rename: when all managed bin names resolve on
 * PATH to the running executable, `hookCommand()` (and hence the written hook command) uses the
 * preferred `superbee` bin — BIN_NAMES order, not PATH order, decides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BIN_NAMES, hookCommand } from "../src/invocation.js";
import { sessionStartHookCommand } from "../src/commands/hook.js";

test("hookCommand() prefers `superbee` when all managed bins resolve on PATH to the running executable", () => {
  assert.deepEqual([...BIN_NAMES], ["superbee", "aslite", "agentstate-lite"], "superbee must be the preferred successor bin");
  // Under the test loader the "running executable" is src/invocation.ts itself; make all managed
  // bin names resolve to it from one PATH directory.
  const exe = realpathSync(fileURLToPath(new URL("../src/invocation.ts", import.meta.url)));
  const binDir = mkdtempSync(path.join(tmpdir(), "superbee-bin-preference-"));
  symlinkSync(exe, path.join(binDir, "superbee"));
  symlinkSync(exe, path.join(binDir, "aslite"));
  symlinkSync(exe, path.join(binDir, "agentstate-lite"));
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  try {
    assert.equal(hookCommand(), "superbee");
    assert.equal(sessionStartHookCommand(), "superbee session-start");
  } finally {
    process.env.PATH = previousPath;
    rmSync(binDir, { recursive: true, force: true });
  }
});
