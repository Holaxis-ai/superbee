import assert from "node:assert/strict";
import { test } from "node:test";

import type { Bundle } from "@superbee/core";
import { KNOWN_COMMANDS } from "../src/cli.js";
import { MCP_USAGE, mcp } from "../src/commands/mcp.js";
import { CliError } from "../src/errors.js";
import { COMMAND_GROUPS } from "../src/reference.js";
import { cliVersion } from "../src/build-identity.js";

const bundle = { root: "/tmp/board" } as Bundle;

test("mcp is registered in command discovery", () => {
  assert.ok(KNOWN_COMMANDS.includes("mcp"));
  assert.ok(COMMAND_GROUPS.flatMap((group) => group.commands).some((command) => command.usage.startsWith("mcp ")));
});

test("mcp help is offline and does not open a bundle", async () => {
  let output = "";
  let opened = false;
  await mcp(["--help"], {
    stdout: (text) => {
      output += text;
    },
    openBundle: async () => {
      opened = true;
      return bundle;
    },
  });
  assert.equal(output, MCP_USAGE);
  assert.equal(opened, false);
  assert.match(output, /npm install -g @holaxis\/aslite/);
  assert.match(output, /command `aslite`.*argument `mcp`/s);
  assert.match(output, /does not scan or rewrite host MCP configuration/);
});

test("mcp opens the explicit local bundle and leaves stdout untouched for stdio protocol", async () => {
  let openedDir: string | undefined;
  let startedWith: Bundle | undefined;
  let startedActor: string | undefined;
  let startedBundleName: string | undefined;
  let startedVersion: string | undefined;
  let startedWithAuthorization = false;
  let output = "";
  await mcp(["--dir", "/tmp/board", "--actor", "mike/test"], {
    stdout: (text) => {
      output += text;
    },
    openBundle: async (dir) => {
      openedDir = dir;
      return bundle;
    },
    startServer: async ({ bundle: startedBundle, actor, bundleName, version, viewAuthorization }) => {
      startedWith = startedBundle;
      startedActor = actor;
      startedBundleName = bundleName;
      startedVersion = version;
      startedWithAuthorization = viewAuthorization !== undefined;
    },
  });
  assert.equal(openedDir, "/tmp/board");
  assert.equal(startedWith, bundle);
  assert.equal(startedActor, "mike/test");
  assert.equal(startedBundleName, "board");
  assert.equal(startedVersion, cliVersion());
  assert.equal(startedWithAuthorization, true);
  assert.equal(output, "");
});

test("mcp routes every pre-initialize failure to stderr and marks it handled", async () => {
  const rows: Array<{
    name: string;
    argv: string[];
    openBundle: () => Promise<Bundle>;
    startServer?: () => Promise<void>;
    code: "USAGE" | "NOT_FOUND" | "RUNTIME";
  }> = [
    {
      name: "argument parsing",
      argv: ["--nope"],
      openBundle: async () => bundle,
      code: "USAGE",
    },
    {
      name: "bundle resolution",
      argv: [],
      openBundle: async () => {
        throw new CliError("NOT_FOUND", "no bundle for MCP");
      },
      code: "NOT_FOUND",
    },
    {
      name: "server startup",
      argv: [],
      openBundle: async () => bundle,
      startServer: async () => {
        throw new Error("server could not start");
      },
      code: "RUNTIME",
    },
  ];

  for (const row of rows) {
    let stdout = "";
    let stderr = "";
    await assert.rejects(
      mcp(row.argv, {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        openBundle: row.openBundle,
        startServer: "startServer" in row ? row.startServer : async () => {},
      }),
      (error: unknown) =>
        error instanceof CliError && error.code === row.code && error.handled,
      row.name,
    );
    assert.equal(stdout, "", `${row.name}: protocol stdout`);
    assert.match(stderr, /^error:\n/, `${row.name}: structured envelope`);
    assert.match(stderr, new RegExp(`code: ${row.code}`), `${row.name}: error classification`);
  }
});
