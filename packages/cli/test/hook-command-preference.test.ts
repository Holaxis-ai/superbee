/**
 * Hook-command stability: when `superbee` and the retired bin names all resolve on PATH to the
 * running executable, `hookCommand()` (and hence the written hook command) uses `superbee`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hookCommand, registerExecutableEntry } from "../src/invocation.js";
import { sessionStartHookCommand } from "../src/commands/hook.js";

test("hookCommand() prefers `superbee` when all managed bins resolve on PATH to the running executable", () => {
  // Under the test loader the "running executable" is src/invocation.ts itself; make all managed
  // bin names resolve to it from one PATH directory.
  const exe = realpathSync(fileURLToPath(new URL("../../superbee/dist/superbee.mjs", import.meta.url)));
  registerExecutableEntry(exe);
  const binDir = mkdtempSync(path.join(tmpdir(), "superbee-bin-preference-"));
  for (const name of ["aslite", "agentstate-lite", "superbee"]) {
    symlinkSync(exe, path.join(binDir, name));
  }
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
