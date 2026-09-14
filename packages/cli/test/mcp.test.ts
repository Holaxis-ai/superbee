import assert from "node:assert/strict";
import { test } from "node:test";

import type { Bundle } from "@superbee/core";
import type { McpWorkspaceResolver } from "@superbee/mcp-app";
import { KNOWN_COMMANDS } from "../src/cli.js";
import {
  MCP_INSTALL_USAGE,
  MCP_STATUS_USAGE,
  MCP_UNINSTALL_USAGE,
  MCP_USAGE,
  mcp,
} from "../src/commands/mcp.js";
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
  assert.match(output, /npm install -g superbee/);
  assert.match(output, /durable npm runtime once at user scope/);
  assert.match(output, /mcp install --host <id>/);
  assert.match(output, /show_document.*authoritative Markdown/s);
});

test("mcp status help is offline and does not open a bundle or server", async () => {
  let output = "";
  let opened = false;
  let started = false;
  await mcp(["status", "--help"], {
    stdout: (text) => { output += text; },
    openBundle: async () => { opened = true; return bundle; },
    startServer: async () => { started = true; },
  });
  assert.equal(output, MCP_STATUS_USAGE);
  assert.equal(opened, false);
  assert.equal(started, false);
  assert.match(output, /never scans.*writes configuration/s);
});

test("mcp status selects aliases and emits a stable read-only envelope", async () => {
  let output = "";
  let selected: readonly string[] = [];
  await mcp(["status", "--host", "chatgpt", "--json"], {
    stdout: (text) => { output += text; },
    inspectHosts: (targets) => {
      selected = targets.map(({ id }) => id);
      return targets.map((target) => ({
        host: target.id,
        label: target.label,
        state: "absent",
        config: "~/.codex/config.toml",
        reason: "no Superbee registration found",
        docs_url: target.docs_url,
      }));
    },
  });
  assert.deepEqual(selected, ["codex"]);
  assert.deepEqual(JSON.parse(output), {
    mcp_status: {
      count: 1,
      registration_mutation_available: true,
      hosts: [{
        host: "codex",
        label: "Codex / ChatGPT",
        state: "absent",
        config: "~/.codex/config.toml",
        reason: "no Superbee registration found",
        docs_url: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
      }],
    },
  });
});

test("mcp install and uninstall help are offline and explicit-host only", async () => {
  for (const [operation, expected] of [["install", MCP_INSTALL_USAGE], ["uninstall", MCP_UNINSTALL_USAGE]] as const) {
    let output = "";
    let mutated = false;
    await mcp([operation, "--help"], {
      stdout: (text) => { output += text; },
      mutateRegistration: () => {
        mutated = true;
        throw new Error("not reached");
      },
    });
    assert.equal(output, expected);
    assert.equal(mutated, false);
  }
  await assert.rejects(
    mcp(["install", "--json"], {}),
    (error: unknown) => error instanceof CliError && error.code === "USAGE",
  );
});

test("mcp install selects one host and emits a compact verified receipt", async () => {
  let output = "";
  let selected = "";
  let actor: string | undefined;
  await mcp(["install", "--host", "chatgpt", "--actor", "mike/test", "--json"], {
    stdout: (text) => { output += text; },
    mutateRegistration: (operation, target, options) => {
      assert.equal(operation, "install");
      selected = target.id;
      actor = options.actor;
      return {
        operation,
        host: target.id,
        label: target.label,
        changed: true,
        before: "absent",
        after: "owned_current",
        config: "~/.codex/config.toml",
        restart_required: true,
        help: ["Restart Codex / ChatGPT, then ask it to list Superbee workspaces."],
      };
    },
  });
  assert.equal(selected, "codex");
  assert.equal(actor, "mike/test");
  assert.deepEqual(JSON.parse(output).mcp_registration, {
    operation: "install",
    host: "codex",
    label: "Codex / ChatGPT",
    changed: true,
    before: "absent",
    after: "owned_current",
    config: "~/.codex/config.toml",
    restart_required: true,
    help: ["Restart Codex / ChatGPT, then ask it to list Superbee workspaces."],
  });
});

test("mcp uninstall rejects actor input before mutation", async () => {
  let mutated = false;
  await assert.rejects(
    mcp(["uninstall", "--host", "codex", "--actor", "mike"], {
      mutateRegistration: () => {
        mutated = true;
        throw new Error("not reached");
      },
    }),
    (error: unknown) => error instanceof CliError && error.code === "USAGE",
  );
  assert.equal(mutated, false);
});

test("mcp status rejects unknown hosts on the ordinary CLI error channel", async () => {
  await assert.rejects(
    mcp(["status", "--host", "other"], {}),
    (error: unknown) => error instanceof CliError && error.code === "USAGE" && !error.handled,
  );
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

test("bare mcp starts bundle-unbound from the private catalog without cwd discovery", async () => {
  let opened = false;
  let resolverActor: string | undefined;
  let startedResolver: McpWorkspaceResolver | undefined;
  let startedVersion: string | undefined;
  const resolver: McpWorkspaceResolver = {
    list: async () => [],
    open: async () => {
      throw new Error("not used");
    },
  };
  await mcp(["--actor", "mike/test"], {
    openBundle: async () => {
      opened = true;
      return bundle;
    },
    createWorkspaceResolver: (actor) => {
      resolverActor = actor;
      return resolver;
    },
    startServer: async (options) => {
      assert.ok("workspaceResolver" in options);
      startedResolver = options.workspaceResolver;
      startedVersion = options.version;
    },
  });
  assert.equal(opened, false);
  assert.equal(resolverActor, "mike/test");
  assert.equal(startedResolver, resolver);
  assert.equal(startedVersion, cliVersion());
});

test("mcp routes every pre-initialize failure to stderr and marks it handled", async () => {
  const rows: Array<{
    name: string;
    argv: string[];
    openBundle?: () => Promise<Bundle>;
    createWorkspaceResolver?: () => McpWorkspaceResolver;
    startServer?: () => Promise<void>;
    code: "USAGE" | "NOT_FOUND" | "RUNTIME";
  }> = [
    {
      name: "argument parsing",
      argv: ["--nope"],
      code: "USAGE",
    },
    {
      name: "workspace resolver creation",
      argv: [],
      createWorkspaceResolver: () => {
        throw new CliError("NOT_FOUND", "no bundle for MCP");
      },
      code: "NOT_FOUND",
    },
    {
      name: "server startup",
      argv: [],
      createWorkspaceResolver: () => ({
        list: async () => [],
        open: async () => { throw new Error("not used"); },
      }),
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
        ...(row.openBundle ? { openBundle: row.openBundle } : {}),
        ...(row.createWorkspaceResolver
          ? { createWorkspaceResolver: row.createWorkspaceResolver }
          : {}),
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
