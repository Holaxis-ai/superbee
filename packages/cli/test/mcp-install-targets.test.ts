import assert from "node:assert/strict";
import test from "node:test";

import type { PersistentInstallAuthority } from "../src/install-authority.js";
import {
  classifyMcpRegistration,
  inspectMcpHost,
  MCP_INSTALL_TARGETS,
  resolveMcpInstallTarget,
  type McpStatusEnvironment,
} from "../src/mcp-install-targets.js";

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

const unknown: PersistentInstallAuthority = {
  allowed: false,
  state: "unknown",
  reason: "test",
  evidence: { npm_prefix: null, bin_path: null, executable_path: null, runtime_path: null },
};

const env = (overrides: NodeJS.ProcessEnv = {}, platform = "darwin"): McpStatusEnvironment => ({
  home: "/users/mike",
  env: { HOME: "/users/mike", ...overrides },
  platform,
});

function target(id: string) {
  const resolved = resolveMcpInstallTarget(id);
  assert.ok(resolved);
  return resolved;
}

test("MCP install target IDs and aliases are stable and unambiguous", () => {
  assert.deepEqual(MCP_INSTALL_TARGETS.map(({ id }) => id), [
    "codex",
    "claude-code",
    "claude-desktop",
    "opencode",
  ]);
  assert.equal(resolveMcpInstallTarget("chatgpt")?.id, "codex");
  assert.equal(resolveMcpInstallTarget("claude")?.id, "claude-code");
  assert.equal(resolveMcpInstallTarget("claude-app")?.id, "claude-desktop");
  assert.equal(resolveMcpInstallTarget("open-code")?.id, "opencode");
  const names = MCP_INSTALL_TARGETS.flatMap(({ id, aliases }) => [id, ...aliases]);
  assert.equal(new Set(names).size, names.length);
});

test("registration ownership is exact and legacy names remain migration-only candidates", () => {
  const executable = stable.evidence.executable_path!;
  const runtime = stable.evidence.runtime_path!;
  const entry = (name: string, command = runtime, args: string[] = [executable, "mcp"]) => ({ name, command, args });

  assert.equal(classifyMcpRegistration(undefined, stable).state, "absent");
  assert.equal(classifyMcpRegistration(entry("superbee"), stable).state, "owned_current");
  assert.equal(
    classifyMcpRegistration(entry("superbee", runtime, [executable, "mcp", "--actor", "mike/test"]), stable).state,
    "owned_current",
  );
  assert.equal(
    classifyMcpRegistration(entry("superbee", runtime, [executable, "mcp", "--dir", "/bundle"]), stable).state,
    "owned_stale",
  );
  assert.equal(classifyMcpRegistration(entry("superbee", "node", ["other.mjs", "mcp"]), stable).state, "foreign");
  assert.equal(classifyMcpRegistration(entry("superbee"), unknown).state, "unverified");
  assert.equal(classifyMcpRegistration(entry("aslite-views"), stable).state, "known_legacy");
});

test("host config paths honor relocated roots and remain read-only", () => {
  const seen: string[] = [];
  const authority = () => stable;
  const cases = [
    ["claude-code", "/relocated/claude/.claude.json", env({ CLAUDE_CONFIG_DIR: "/relocated/claude" })],
    ["claude-desktop", "/users/mike/Library/Application Support/Claude/claude_desktop_config.json", env()],
    ["opencode", "/relocated/xdg/opencode/opencode.json", env({
      XDG_CONFIG_HOME: "/relocated/xdg",
      OPENCODE_CONFIG_DIR: "/resource-directory-not-global-config",
    })],
    ["opencode", "/one/opencode.json", env({ OPENCODE_CONFIG: "/one/opencode.json" })],
  ] as const;
  for (const [id, expected, environment] of cases) {
    const readFile = (path: string): string => {
      seen.push(path);
      if (path === expected) return "{}";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const result = inspectMcpHost(target(id), { environment, authority, readFile });
    assert.equal(result.config, expected);
    assert.equal(result.state, "absent");
  }
  for (const [, expected] of cases) assert.ok(seen.includes(expected));
});

test("Windows MCP targets use documented profile roots and AppData only for Claude Desktop", () => {
  const home = String.raw`C:\Users\Mike`;
  const environment: McpStatusEnvironment = {
    home,
    platform: "win32",
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: String.raw`C:\Users\Mike\AppData\Roaming`,
    },
  };
  const expected = new Map([
    ["codex", String.raw`C:\Users\Mike\.codex\config.toml`],
    ["claude-code", String.raw`C:\Users\Mike\.claude.json`],
    ["claude-desktop", String.raw`C:\Users\Mike\AppData\Roaming\Claude\claude_desktop_config.json`],
    ["opencode", String.raw`C:\Users\Mike\.config\opencode\opencode.json`],
  ]);
  for (const [id, config] of expected) {
    const result = inspectMcpHost(target(id), {
      environment,
      authority: () => unknown,
      readFile: (candidate) => {
        if (candidate === config) return "{}";
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      execFile: () => "[]",
    });
    assert.equal(result.config, config);
  }
});

test("Windows Codex status uses the resolved cmd shim and distinguishes command failures", () => {
  const home = String.raw`C:\Users\Mike`;
  const shim = String.raw`C:\Users\Mike\AppData\Roaming\npm\codex.cmd`;
  const comspec = String.raw`C:\Windows\System32\cmd.exe`;
  const base = {
    environment: {
      home,
      platform: "win32",
      env: {
        USERPROFILE: home,
        PATH: String.raw`C:\Users\Mike\AppData\Roaming\npm;C:\Windows\System32`,
        PATHEXT: ".EXE;.CMD",
        ComSpec: comspec,
      },
    },
    authority: () => stable,
    resolveCommandPath: (candidate: string) => {
      if (candidate.toLowerCase() === shim.toLowerCase()) return shim;
      if (candidate.toLowerCase() === comspec.toLowerCase()) return comspec;
      return undefined;
    },
  };
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const empty = inspectMcpHost(target("codex"), {
    ...base,
    execFile: (file, args) => {
      calls.push({ file, args: [...args] });
      return "[]";
    },
  });
  assert.equal(empty.state, "absent");
  assert.deepEqual(calls, [{
    file: comspec,
    args: ["/d", "/s", "/c", `"${shim}"`, "mcp", "list", "--json"],
  }]);

  const absent = inspectMcpHost(target("codex"), {
    ...base,
    resolveCommandPath: () => undefined,
  });
  assert.equal(absent.state, "cli_absent");

  const unreadable = inspectMcpHost(target("codex"), {
    ...base,
    execFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
  });
  assert.equal(unreadable.state, "unreadable");
});

test("OpenCode recognizes the canonical JSONC filename without guessing comment syntax", () => {
  const command = stable.evidence.runtime_path!;
  const args = [stable.evidence.executable_path!, "mcp"];
  const jsonc = "/xdg/opencode/opencode.jsonc";
  const result = inspectMcpHost(target("opencode"), {
    environment: env({ XDG_CONFIG_HOME: "/xdg" }),
    authority: () => stable,
    readFile: (path) => {
      if (path === jsonc) {
        return JSON.stringify({ mcp: { superbee: { type: "local", command: [command, ...args] } } });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(result.config, jsonc);
  assert.equal(result.state, "owned_current");
});

test("OpenCode status merges inline configuration over lower-precedence files", () => {
  let reads = 0;
  const command = stable.evidence.runtime_path!;
  const args = [stable.evidence.executable_path!, "mcp"];
  const result = inspectMcpHost(target("opencode"), {
    environment: env({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }),
    }),
    authority: () => stable,
    readFile: (path) => {
      reads += 1;
      if (path.endsWith("opencode.json")) {
        return JSON.stringify({ mcp: {
          superbee: { type: "local", command: [command, ...args], enabled: true },
        } });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.match(result.config ?? "", /opencode\.json$/);
  assert.equal(result.state, "owned_current");
  assert.ok(reads > 0);
});

test("Claude, OpenCode v1/v2, and Codex registrations share one normalized classifier", () => {
  const command = stable.evidence.runtime_path!;
  const args = [stable.evidence.executable_path!, "mcp"];
  const authority = () => stable;
  const claude = inspectMcpHost(target("claude-code"), {
    environment: env(),
    authority,
    readFile: () => JSON.stringify({ mcpServers: {
      superbee: { type: "stdio", command, args, env: {} },
    } }),
  });
  const opencodeV1 = inspectMcpHost(target("opencode"), {
    environment: env(),
    authority,
    readFile: (path) => {
      if (path.endsWith("opencode.json")) {
        return JSON.stringify({ mcp: { superbee: { type: "local", command: [command, ...args] } } });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  const opencodeV2 = inspectMcpHost(target("opencode"), {
    environment: env(),
    authority,
    readFile: (path) => {
      if (path.endsWith("opencode.json")) {
        return JSON.stringify({ mcp: { servers: { superbee: { type: "local", command: [command, ...args] } } } });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  let codexArgs: readonly string[] = [];
  const codex = inspectMcpHost(target("codex"), {
    environment: env({ PATH: "/bin" }),
    authority,
    execFile: (_file, passed) => {
      codexArgs = passed;
      return JSON.stringify([{
        name: "superbee",
        enabled: true,
        disabled_reason: null,
        startup_timeout_sec: null,
        tool_timeout_sec: null,
        auth_status: "unsupported",
        transport: { type: "stdio", command, args, env: null, env_vars: [], cwd: null },
      }]);
    },
  });
  assert.deepEqual([claude.state, opencodeV1.state, opencodeV2.state, codex.state], [
    "owned_current",
    "owned_current",
    "owned_current",
    "owned_current",
  ]);
  assert.deepEqual(codexArgs, ["mcp", "list", "--json"]);
});

test("host-native ownership includes activation and target-specific Claude shape", () => {
  const command = stable.evidence.runtime_path!;
  const args = [stable.evidence.executable_path!, "mcp"];
  const authority = () => stable;
  const codex = (enabled: boolean, startup: number | null = null) => inspectMcpHost(target("codex"), {
    environment: env(),
    authority,
    execFile: () => JSON.stringify([{
      name: "superbee",
      enabled,
      disabled_reason: enabled ? null : "disabled",
      startup_timeout_sec: startup,
      tool_timeout_sec: null,
      auth_status: "unsupported",
      transport: { type: "stdio", command, args, env: null, env_vars: [], cwd: null },
    }]),
  });
  assert.equal(codex(true).state, "owned_current");
  assert.equal(codex(false).state, "foreign");
  assert.equal(codex(true, 30).state, "foreign");

  const desktopShape = JSON.stringify({ mcpServers: { superbee: { command, args } } });
  const codeShape = JSON.stringify({ mcpServers: {
    superbee: { type: "stdio", command, args, env: {} },
  } });
  assert.equal(inspectMcpHost(target("claude-code"), {
    environment: env(), authority, readFile: () => desktopShape,
  }).state, "foreign");
  assert.equal(inspectMcpHost(target("claude-desktop"), {
    environment: env(), authority, readFile: () => codeShape,
  }).state, "foreign");
});

test("commented JSONC is read losslessly while malformed config and unsupported platforms fail closed", () => {
  const commented = inspectMcpHost(target("opencode"), {
    environment: env(),
    authority: () => stable,
    readFile: (path) => {
      if (path.endsWith("opencode.jsonc")) return "// user comment\n{}";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  const malformed = inspectMcpHost(target("opencode"), {
    environment: env(),
    authority: () => stable,
    readFile: (path) => {
      if (path.endsWith("opencode.jsonc")) return "{ nope";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  const duplicate = inspectMcpHost(target("claude-desktop"), {
    environment: env(),
    authority: () => stable,
    readFile: () => '{"mcpServers":{},"mcpServers":{}}',
  });
  const unsupported = inspectMcpHost(target("claude-desktop"), {
    environment: env({}, "linux"),
    authority: () => stable,
  });
  assert.equal(commented.state, "absent");
  assert.equal(malformed.state, "unreadable");
  assert.match(malformed.reason, /status unavailable/);
  assert.doesNotMatch(malformed.reason, /users\/mike|opencode\.jsonc/);
  assert.equal(duplicate.state, "unreadable");
  assert.equal(unsupported.state, "unsupported");
  assert.equal(unsupported.config, null);
});

test("read-only status never includes absolute host paths in unreadable reasons", () => {
  const privatePath = "/users/mike/Library/Application Support/Claude/claude_desktop_config.json";
  const result = inspectMcpHost(target("claude-desktop"), {
    environment: env(),
    authority: () => stable,
    readFile: () => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${privatePath}'`), { code: "EACCES" });
    },
  });
  assert.equal(result.state, "unreadable");
  assert.doesNotMatch(result.reason, /users\/mike|Application Support|claude_desktop_config/);
});
