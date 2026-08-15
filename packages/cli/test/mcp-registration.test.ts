import assert from "node:assert/strict";
import test from "node:test";

import type { PersistentInstallAuthority } from "../src/install-authority.js";
import { resolveMcpInstallTarget, type McpStatusEnvironment } from "../src/mcp-install-targets.js";
import { McpRegistrationError, mutateMcpRegistration } from "../src/mcp-registration.js";

const stable: PersistentInstallAuthority = {
  allowed: true,
  state: "durable_global",
  reason: "test",
  evidence: {
    npm_prefix: "/opt/superbee",
    bin_path: "/opt/superbee/bin/superbee",
    executable_path: "/opt/superbee/lib/node_modules/superbee/dist/superbee.mjs",
    runtime_path: "/opt/superbee/bin/node",
  },
};

const environment = (overrides: NodeJS.ProcessEnv = {}, platform = "darwin"): McpStatusEnvironment => ({
  home: "/users/mike",
  env: { HOME: "/users/mike", ...overrides },
  platform,
});

function target(id: string) {
  const value = resolveMcpInstallTarget(id);
  assert.ok(value);
  return value;
}

function missing(): Error & { code: string } {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

test("Codex native install is exact, actor-aware, idempotent, and exact-owned on uninstall", () => {
  let entry: { command: string; args: string[] } | undefined;
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execFile = (file: string, args: readonly string[]): string => {
    calls.push({ file, args });
    if (args.join(" ") === "mcp list --json") {
      return JSON.stringify(entry ? [{ name: "superbee", transport: { type: "stdio", ...entry } }] : []);
    }
    if (args[0] === "mcp" && args[1] === "add") {
      const split = args.indexOf("--");
      entry = { command: args[split + 1]!, args: [...args.slice(split + 2)] };
      return "added";
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      entry = undefined;
      return "removed";
    }
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  };
  const deps = { environment: environment(), authority: () => stable, execFile };

  const installed = mutateMcpRegistration("install", target("codex"), { actor: "mike/test" }, deps);
  assert.equal(installed.changed, true);
  assert.deepEqual(entry, {
    command: stable.evidence.runtime_path,
    args: [stable.evidence.executable_path!, "mcp", "--actor", "mike/test"],
  });
  assert.deepEqual(calls.find((call) => call.args[1] === "add")?.args, [
    "mcp", "add", "superbee", "--", stable.evidence.runtime_path!,
    stable.evidence.executable_path!, "mcp", "--actor", "mike/test",
  ]);
  const count = calls.length;
  assert.equal(mutateMcpRegistration("install", target("codex"), { actor: "mike/test" }, deps).changed, false);
  assert.equal(calls.length, count + 1, "idempotent replay performs only read-back inspection");
  assert.equal(mutateMcpRegistration("uninstall", target("codex"), {}, deps).changed, true);
  assert.equal(entry, undefined);
});

test("foreign same-name and legacy registrations are refused without mutation", () => {
  for (const [name, command] of [["superbee", "/foreign/node"], ["aslite-views", stable.evidence.runtime_path!]]) {
    let writes = 0;
    const text = JSON.stringify({ mcpServers: { [name]: { command, args: ["foreign.mjs", "mcp"] } } });
    assert.throws(
      () => mutateMcpRegistration("install", target("claude-desktop"), {}, {
        environment: environment(),
        authority: () => stable,
        readFile: () => text,
        writeFile: () => { writes += 1; },
      }),
      (error: unknown) => error instanceof McpRegistrationError,
    );
    assert.equal(writes, 0);
  }
});

test("Claude Code uses user-scoped native commands and updates only exact-owned stale bytes", () => {
  const path = "/relocated/.claude.json";
  let config = JSON.stringify({ mcpServers: {
    superbee: {
      command: stable.evidence.runtime_path,
      args: [stable.evidence.executable_path, "mcp", "--actor", "old"],
    },
    foreign: { command: "/bin/foreign", args: [] },
  } });
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const execFile = (_file: string, args: readonly string[]): string => {
    mutableCalls.push([...args]);
    if (args[1] === "remove") {
      const root = JSON.parse(config);
      delete root.mcpServers.superbee;
      config = JSON.stringify(root);
      return "removed";
    }
    if (args[1] === "add") {
      const split = args.indexOf("--");
      const root = JSON.parse(config);
      root.mcpServers.superbee = { command: args[split + 1], args: args.slice(split + 2) };
      config = JSON.stringify(root);
      return "added";
    }
    throw new Error("unexpected native command");
  };
  const receipt = mutateMcpRegistration("install", target("claude-code"), { actor: "new" }, {
    environment: environment({ CLAUDE_CONFIG_DIR: "/relocated" }),
    authority: () => stable,
    readFile: (candidate) => candidate === path ? config : (() => { throw missing(); })(),
    execFile,
  });
  assert.equal(receipt.before, "owned_stale");
  assert.deepEqual(calls[0], ["mcp", "remove", "--scope", "user", "superbee"]);
  assert.deepEqual(calls[1]?.slice(0, 8), [
    "mcp", "add", "--scope", "user", "--transport", "stdio", "superbee", "--",
  ]);
  assert.equal(JSON.parse(config).mcpServers.foreign.command, "/bin/foreign");
});

test("Claude Code restores an exact prior registration when replacement add fails", () => {
  const prior = {
    command: stable.evidence.runtime_path!,
    args: [stable.evidence.executable_path!, "mcp", "--actor", "old"],
  };
  let current: typeof prior | undefined = { ...prior, args: [...prior.args] };
  let addAttempts = 0;
  const execFile = (_file: string, args: readonly string[]): string => {
    if (args[1] === "remove") {
      current = undefined;
      return "removed";
    }
    if (args[1] === "add") {
      addAttempts += 1;
      if (addAttempts === 1) throw new Error("host rejected replacement");
      const split = args.indexOf("--");
      current = { command: args[split + 1]!, args: [...args.slice(split + 2)] };
      return "restored";
    }
    throw new Error("unexpected native command");
  };
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-code"), { actor: "new" }, {
      environment: environment(),
      authority: () => stable,
      readFile: () => JSON.stringify({ mcpServers: current ? { superbee: current } : {} }),
      execFile,
    }),
    (error: unknown) => error instanceof McpRegistrationError && error.category === "runtime",
  );
  assert.deepEqual(current, prior);
  assert.equal(addAttempts, 2);
});

test("Claude Desktop JSONC install and uninstall preserve comments and foreign entries", () => {
  const path = "/users/mike/Library/Application Support/Claude/claude_desktop_config.json";
  let text = `{
  // keep this user comment
  "theme": "dark",
  "mcpServers": {
    "foreign": { "command": "/bin/foreign", "args": [] }
  }
}\n`;
  const deps = {
    environment: environment(),
    authority: () => stable,
    readFile: (candidate: string) => candidate === path ? text : (() => { throw missing(); })(),
    writeFile: (candidate: string, content: string) => {
      assert.equal(candidate, path);
      text = content;
    },
  };
  assert.equal(mutateMcpRegistration("install", target("claude-desktop"), {}, deps).changed, true);
  assert.match(text, /keep this user comment/);
  assert.match(text, /"theme": "dark"/);
  assert.match(text, /"foreign"/);
  assert.match(text, /"superbee"/);
  assert.equal(mutateMcpRegistration("install", target("claude-desktop"), {}, deps).changed, false);
  assert.equal(mutateMcpRegistration("uninstall", target("claude-desktop"), {}, deps).changed, true);
  assert.doesNotMatch(text, /"superbee"/);
  assert.match(text, /keep this user comment/);
  assert.match(text, /"foreign"/);
});

test("OpenCode updates the one explicit JSONC source and preserves its schema generation", () => {
  const path = "/custom/opencode.jsonc";
  let text = `{
  // v2-shaped user file
  "mcp": { "servers": { "foreign": { "type": "local", "command": ["foreign"] } } }
}\n`;
  const deps = {
    environment: environment({ OPENCODE_CONFIG: path }),
    authority: () => stable,
    readFile: (candidate: string) => candidate === path ? text : (() => { throw missing(); })(),
    writeFile: (candidate: string, content: string) => {
      assert.equal(candidate, path);
      text = content;
    },
  };
  assert.equal(mutateMcpRegistration("install", target("opencode"), {}, deps).changed, true);
  assert.match(text, /v2-shaped user file/);
  assert.match(text, /"servers"/);
  assert.match(text, /"superbee"/);
  assert.match(text, /"type": "local"/);
  assert.equal(mutateMcpRegistration("uninstall", target("opencode"), {}, deps).changed, true);
  assert.doesNotMatch(text, /"superbee"/);
  assert.match(text, /"foreign"/);
});

test("persistent authority and ambiguous OpenCode sources fail before writes", () => {
  let writes = 0;
  const denied: PersistentInstallAuthority = {
    allowed: false,
    state: "unknown",
    reason: "npx cache",
    evidence: { npm_prefix: null, bin_path: null, executable_path: null, runtime_path: null },
  };
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-desktop"), {}, {
      environment: environment(), authority: () => denied, writeFile: () => { writes += 1; },
    }),
    /cannot authorize/,
  );
  assert.equal(writes, 0);

  const command = stable.evidence.runtime_path;
  const args = [stable.evidence.executable_path, "mcp"];
  assert.throws(
    () => mutateMcpRegistration("install", target("opencode"), {}, {
      environment: environment({ XDG_CONFIG_HOME: "/xdg" }),
      authority: () => stable,
      readFile: (path) => {
        if (path.endsWith("opencode.json") || path.endsWith("opencode.jsonc")) {
          return JSON.stringify({ mcp: { superbee: { type: "local", command: [command, ...args] } } });
        }
        throw missing();
      },
      writeFile: () => { writes += 1; },
    }),
    /multiple OpenCode config sources/,
  );
  assert.equal(writes, 0);
});

test("file-backed write failure reports runtime failure and never claims success", () => {
  const original = `{"theme":"dark"}\n`;
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-desktop"), {}, {
      environment: environment(),
      authority: () => stable,
      readFile: () => original,
      writeFile: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
    }),
    (error: unknown) => error instanceof McpRegistrationError
      && error.category === "runtime"
      && error.details.host === "claude-desktop",
  );
});

test("a same-name ownership change between plan and apply is refused before mutation", () => {
  let reads = 0;
  let writes = 0;
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-desktop"), {}, {
      environment: environment(),
      authority: () => stable,
      readFile: () => {
        reads += 1;
        if (reads === 1) throw missing();
        return JSON.stringify({ mcpServers: {
          superbee: { command: "/foreign/node", args: ["foreign.mjs"] },
        } });
      },
      writeFile: () => { writes += 1; },
    }),
    /changed during the operation/,
  );
  assert.equal(writes, 0);
});
