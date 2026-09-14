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

function claudeCodeServer(entry: { command: string; args: readonly string[] }) {
  return { type: "stdio", command: entry.command, args: [...entry.args], env: {} };
}

function codexRow(entry: { command: string; args: readonly string[] }, enabled = true) {
  return {
    name: "superbee",
    enabled,
    disabled_reason: enabled ? null : "disabled",
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: "unsupported",
    transport: {
      type: "stdio",
      command: entry.command,
      args: [...entry.args],
      env: null,
      env_vars: [],
      cwd: null,
    },
  };
}

test("Codex native install is exact, actor-aware, idempotent, and exact-owned on uninstall", () => {
  let entry: { command: string; args: string[] } | undefined;
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execFile = (file: string, args: readonly string[]): string => {
    calls.push({ file, args });
    if (args.join(" ") === "mcp list --json") {
      return JSON.stringify(entry ? [codexRow(entry)] : []);
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

test("Codex Windows mutation reuses one resolved cmd shim for inspection, mutation, and read-back", () => {
  const home = String.raw`C:\Users\Mike`;
  const shim = String.raw`C:\Users\Mike\AppData\Roaming\npm\codex.cmd`;
  const comspec = String.raw`C:\Windows\System32\cmd.exe`;
  let entry: { command: string; args: string[] } | undefined;
  let shimLookups = 0;
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const receipt = mutateMcpRegistration("install", target("codex"), {}, {
    environment: {
      home,
      platform: "win32",
      env: {
        USERPROFILE: home,
        PATH: String.raw`C:\Users\Mike\AppData\Roaming\npm;C:\Windows\System32`,
        PATHEXT: ".CMD;.EXE",
        ComSpec: comspec,
      },
    },
    authority: () => stable,
    resolveCommandPath: (candidate) => {
      if (candidate.toLowerCase() === shim.toLowerCase()) {
        shimLookups += 1;
        return shim;
      }
      if (candidate.toLowerCase() === comspec.toLowerCase()) return comspec;
      return undefined;
    },
    execFile: (file, args) => {
      calls.push({ file, args: [...args] });
      const native = [...args[3]!.slice(1, -1).matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
      native.shift();
      if (native.join(" ") === "mcp list --json") {
        return JSON.stringify(entry ? [codexRow(entry)] : []);
      }
      if (native[0] === "mcp" && native[1] === "add") {
        const split = native.indexOf("--");
        entry = { command: native[split + 1]!, args: [...native.slice(split + 2)] };
        return "added";
      }
      throw new Error(`unexpected ${file} ${args.join(" ")}`);
    },
  });

  assert.equal(receipt.changed, true);
  assert.equal(receipt.after, "owned_current");
  assert.equal(shimLookups, 1);
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((call) => call.file === comspec));
  assert.ok(calls.every((call) => call.args[3]?.startsWith(`""${shim}" `)));
});

test("Codex refuses a disabled exact-command entry instead of reporting it current", () => {
  let mutations = 0;
  const entry = {
    command: stable.evidence.runtime_path!,
    args: [stable.evidence.executable_path!, "mcp"],
  };
  assert.throws(
    () => mutateMcpRegistration("install", target("codex"), {}, {
      environment: environment(),
      authority: () => stable,
      execFile: (_file, args) => {
        if (args.join(" ") === "mcp list --json") return JSON.stringify([codexRow(entry, false)]);
        mutations += 1;
        return "";
      },
    }),
    /outside the exact Superbee-managed shape/,
  );
  assert.equal(mutations, 0);
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
      type: "stdio",
      command: stable.evidence.runtime_path,
      args: [stable.evidence.executable_path, "mcp", "--actor", "old"],
      env: {},
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
      root.mcpServers.superbee = claudeCodeServer({ command: args[split + 1]!, args: args.slice(split + 2) });
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
      readFile: () => JSON.stringify({ mcpServers: current ? { superbee: claudeCodeServer(current) } : {} }),
      execFile,
    }),
    (error: unknown) => error instanceof McpRegistrationError && error.category === "runtime",
  );
  assert.deepEqual(current, prior);
  assert.equal(addAttempts, 2);
});

test("Claude Code reports partial failure when rollback does not survive read-back", () => {
  const prior = {
    command: stable.evidence.runtime_path!,
    args: [stable.evidence.executable_path!, "mcp", "--actor", "old"],
  };
  let current: typeof prior | undefined = prior;
  let addAttempts = 0;
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-code"), { actor: "new" }, {
      environment: environment(),
      authority: () => stable,
      readFile: () => JSON.stringify({ mcpServers: current ? { superbee: claudeCodeServer(current) } : {} }),
      execFile: (_file, args) => {
        if (args[1] === "remove") { current = undefined; return "removed"; }
        if (args[1] === "add") {
          addAttempts += 1;
          if (addAttempts === 1) throw new Error("replacement failed");
          return "rollback claimed success";
        }
        throw new Error("unexpected native command");
      },
    }),
    (error: unknown) => error instanceof McpRegistrationError
      && error.category === "runtime"
      && error.details.partial === true,
  );
  assert.equal(current, undefined);
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
    execFile: (file: string, args: readonly string[]) => {
      assert.equal(file, "opencode2");
      assert.deepEqual(args, ["--version"]);
      return "2.0.0-beta";
    },
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
  assert.match(text, /"disabled": false/);
  assert.doesNotMatch(text, /"enabled"/);
  assert.equal(mutateMcpRegistration("uninstall", target("opencode"), {}, deps).changed, true);
  assert.doesNotMatch(text, /"superbee"/);
  assert.match(text, /"foreign"/);
});

test("OpenCode V2 uses its native global add when the versioned CLI is available", () => {
  const path = "/users/mike/.config/opencode/opencode.json";
  let text = "{}\n";
  let exists = false;
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execFile = (file: string, args: readonly string[]): string => {
    calls.push({ file, args: [...args] });
    if (file === "opencode2" && args[0] === "--version") return "2.0.0-beta";
    if (file === "opencode2" && args[0] === "mcp") {
      exists = true;
      text = JSON.stringify({ mcp: { servers: {
        superbee: { type: "local", command: [stable.evidence.runtime_path, stable.evidence.executable_path, "mcp"] },
      } } }, null, 2);
      return "added";
    }
    throw new Error("unexpected native command");
  };
  const receipt = mutateMcpRegistration("install", target("opencode"), {}, {
    environment: environment({ XDG_CONFIG_HOME: "/users/mike/.config" }),
    authority: () => stable,
    execFile,
    readFile: (candidate) => candidate === path && exists ? text : (() => { throw missing(); })(),
  });
  assert.equal(receipt.changed, true);
  assert.deepEqual(calls.find((call) => call.args[0] === "mcp"), {
    file: "opencode2",
    args: [
      "mcp", "add", "superbee", "--global", "--", stable.evidence.runtime_path!,
      stable.evidence.executable_path!, "mcp",
    ],
  });
});

test("OpenCode carries the successful V2 probe binary into native apply", () => {
  const path = "/users/mike/.config/opencode/opencode.json";
  let text = "{}\n";
  let exists = false;
  const native: string[] = [];
  const receipt = mutateMcpRegistration("install", target("opencode"), {}, {
    environment: environment({ XDG_CONFIG_HOME: "/users/mike/.config" }),
    authority: () => stable,
    execFile: (file, args) => {
      if (file === "opencode2") throw new Error("not installed");
      if (file === "opencode" && args[0] === "--version") return "2.1.0";
      if (file === "opencode" && args[0] === "mcp") {
        native.push(file);
        exists = true;
        text = JSON.stringify({ mcp: { servers: {
          superbee: { type: "local", command: [stable.evidence.runtime_path, stable.evidence.executable_path, "mcp"] },
        } } });
        return "added";
      }
      throw new Error("unexpected native command");
    },
    readFile: (candidate) => candidate === path && exists ? text : (() => { throw missing(); })(),
  });
  assert.equal(receipt.changed, true);
  assert.deepEqual(native, ["opencode"]);
});

test("OpenCode V2 preserves and updates an existing supported V1-shaped config", () => {
  const path = "/custom/opencode.jsonc";
  let text = `{ "mcp": { "foreign": { "type": "local", "command": ["foreign"] } } }\n`;
  const receipt = mutateMcpRegistration("install", target("opencode"), {}, {
    environment: environment({ OPENCODE_CONFIG: path }),
    authority: () => stable,
    execFile: (file, args) => {
      if (file === "opencode2" && args[0] === "--version") return "2.0.0";
      throw new Error("file-backed update must not invoke native add");
    },
    readFile: (candidate) => candidate === path ? text : (() => { throw missing(); })(),
    writeFile: (_candidate, content) => { text = content; },
  });
  assert.equal(receipt.changed, true);
  assert.match(text, /"mcp"/);
  assert.match(text, /"superbee"/);
  assert.doesNotMatch(text, /"servers"/);
});

test("OpenCode refuses mixed V1/V2 reserved-name declarations before mutation", () => {
  const path = "/custom/opencode.json";
  const text = JSON.stringify({ mcp: {
    superbee: { type: "local", command: [stable.evidence.runtime_path, stable.evidence.executable_path, "mcp"] },
    servers: {},
  } });
  let writes = 0;
  assert.throws(
    () => mutateMcpRegistration("install", target("opencode"), {}, {
      environment: environment({ OPENCODE_CONFIG: path }),
      authority: () => stable,
      execFile: (file, args) => file === "opencode2" && args[0] === "--version"
        ? "2.0.0"
        : (() => { throw new Error("unexpected native command"); })(),
      readFile: (candidate) => candidate === path ? text : (() => { throw missing(); })(),
      writeFile: () => { writes += 1; },
    }),
    /mixes V1 and V2/,
  );
  assert.equal(writes, 0);
});

test("OpenCode inline config is reported by status and blocks lower-precedence mutation", () => {
  const inline = JSON.stringify({ mcp: { superbee: {
    type: "local",
    command: [stable.evidence.runtime_path, stable.evidence.executable_path, "mcp"],
    enabled: true,
  } } });
  let writes = 0;
  assert.throws(
    () => mutateMcpRegistration("install", target("opencode"), {}, {
      environment: environment({ OPENCODE_CONFIG_CONTENT: inline }),
      authority: () => stable,
      writeFile: () => { writes += 1; },
    }),
    /inline configuration is active/,
  );
  assert.equal(writes, 0);
});

test("MCP mutation requires durable-global authority, not a disposable local-dev build", () => {
  let reads = 0;
  let writes = 0;
  const local: PersistentInstallAuthority = {
    allowed: true,
    state: "local_dev",
    reason: "developer checkout",
    evidence: {
      npm_prefix: null,
      bin_path: null,
      executable_path: "/tmp/disposable/dist/superbee.mjs",
      runtime_path: process.execPath,
    },
  };
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-desktop"), {}, {
      environment: environment(),
      authority: () => local,
      readFile: () => { reads += 1; return "{}\n"; },
      writeFile: () => { writes += 1; },
    }),
    /cannot authorize/,
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("duplicate-key JSONC is refused before host configuration mutation", () => {
  let writes = 0;
  const ambiguous = `{
  "mcpServers": {},
  "mcpServers": { "foreign": { "command": "/bin/foreign" } }
}\n`;
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-desktop"), {}, {
      environment: environment(),
      authority: () => stable,
      readFile: () => ambiguous,
      writeFile: () => { writes += 1; },
    }),
    /configuration is unavailable/,
  );
  assert.equal(writes, 0);
});

test("native host failures do not expose captured stderr or private command paths", () => {
  const privateBytes = "/Users/private/checkout/dist/superbee.mjs: host stderr secret";
  assert.throws(
    () => mutateMcpRegistration("install", target("codex"), {}, {
      environment: environment(),
      authority: () => stable,
      execFile: (_file, args) => {
        if (args.join(" ") === "mcp list --json") return "[]";
        throw new Error(privateBytes);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpRegistrationError);
      assert.equal(error.category, "runtime");
      assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /private|checkout|stderr secret/);
      return true;
    },
  );
});

test("file inspection failures do not expose relocated absolute paths", () => {
  const privateBytes = "/Users/private/Library/Application Support/Claude/claude_desktop_config.json";
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-desktop"), {}, {
      environment: environment(),
      authority: () => stable,
      readFile: () => { throw Object.assign(new Error(`EACCES: ${privateBytes}`), { code: "EACCES" }); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpRegistrationError);
      assert.equal(error.category, "runtime");
      assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /Users\/private|Application Support/);
      return true;
    },
  );
});

test("Claude Code refuses same-command registrations with extra native authority fields", () => {
  let nativeCalls = 0;
  assert.throws(
    () => mutateMcpRegistration("install", target("claude-code"), { actor: "new" }, {
      environment: environment(),
      authority: () => stable,
      readFile: () => JSON.stringify({ mcpServers: { superbee: {
        type: "stdio",
        command: stable.evidence.runtime_path,
        args: [stable.evidence.executable_path, "mcp", "--actor", "old"],
        env: { KEEP_ME: "yes" },
      } } }),
      execFile: () => { nativeCalls += 1; return ""; },
    }),
    /outside the exact Superbee-managed shape/,
  );
  assert.equal(nativeCalls, 0);
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
