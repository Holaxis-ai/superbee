import assert from "node:assert/strict";
import test from "node:test";

import {
  HostCommandError,
  resolveHostCommand,
  runHostCommand,
} from "../src/host-command.js";

test("Windows command resolution honors PATH and PATHEXT and safely launches cmd shims", () => {
  const shim = String.raw`C:\Users\Mike\AppData\Roaming\npm\codex.cmd`;
  const comspec = String.raw`C:\Windows\System32\cmd.exe`;
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const input = {
    cwd: String.raw`C:\Users\Mike`,
    platform: "win32",
    env: {
      PATH: String.raw`C:\Users\Mike\AppData\Roaming\npm;C:\Windows\System32`,
      PATHEXT: ".EXE;.CMD",
      ComSpec: comspec,
    },
  };
  const command = resolveHostCommand("codex", input, {
    resolvePath: (candidate) => {
      if (candidate.toLowerCase() === shim.toLowerCase()) return shim;
      if (candidate.toLowerCase() === comspec.toLowerCase()) return comspec;
      return undefined;
    },
  });
  const output = runHostCommand(command, ["mcp", "list", "--json"], input, {
    execFile: (file, args) => {
      calls.push({ file, args: [...args] });
      return "[]";
    },
  });

  assert.equal(output, "[]");
  assert.equal(command.display, "codex.cmd");
  assert.deepEqual(calls, [{
    file: comspec,
    args: ["/d", "/s", "/c", `"${shim}"`, "mcp", "list", "--json"],
  }]);
});

test("Windows command resolution distinguishes an absent command from unreadable command state", () => {
  const base = {
    cwd: String.raw`C:\Users\Mike`,
    platform: "win32",
    env: { PATH: String.raw`C:\missing`, PATHEXT: ".EXE;.CMD" },
  };
  assert.throws(
    () => resolveHostCommand("codex", base, { resolvePath: () => undefined }),
    (error: unknown) => error instanceof HostCommandError && error.state === "absent",
  );
  assert.throws(
    () => resolveHostCommand("codex", base, {
      resolvePath: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    }),
    (error: unknown) => error instanceof HostCommandError && error.state === "unreadable",
  );
});

test("cmd shim execution refuses shell-control bytes before invoking the command processor", () => {
  const shim = String.raw`C:\npm\codex.cmd`;
  const comspec = String.raw`C:\Windows\System32\cmd.exe`;
  const input = {
    cwd: String.raw`C:\Users\Mike`,
    platform: "win32",
    env: { PATH: String.raw`C:\npm`, PATHEXT: ".CMD", ComSpec: comspec },
  };
  const command = resolveHostCommand("codex", input, {
    resolvePath: (candidate) => candidate.toLowerCase() === shim.toLowerCase()
      ? shim
      : candidate.toLowerCase() === comspec.toLowerCase()
        ? comspec
        : undefined,
  });
  let executions = 0;
  assert.throws(
    () => runHostCommand(command, ["mcp", "add", "superbee", "--", "node", "entry", "--actor", "mike & whoami"], input, {
      execFile: () => { executions += 1; return ""; },
    }),
    (error: unknown) => error instanceof HostCommandError && error.state === "unreadable",
  );
  assert.equal(executions, 0);
});
