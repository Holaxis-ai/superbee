import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildHookLaunchSpec,
  buildOpenCodePluginSource,
  computeHookUninstall,
  computeSessionStartHookInstall,
  hook,
  readHookCompatibilityStatus,
} from "../src/commands/hook.js";
import { CliError } from "../src/errors.js";
import type { PersistentInstallAuthority } from "../src/install-authority.js";
import {
  MISMATCHED_NPM_NODE_COMMAND,
  NONCANONICAL_MANAGED_PATH_CASES,
} from "./hook-shell-fixtures.js";

const FOREIGN = [
  { type: "command", command: "echo agentstate-lite", timeout: 10 },
  { type: "command", command: "agentstate-lite backup", timeout: 10 },
  { type: "command", command: "npx -y @holaxis/aslite session-start", timeout: 10 },
  { type: "command", command: "aslite\nsession-start", timeout: 10 },
  { type: "command", command: String.raw`"\u0061slite" session-start`, timeout: 10 },
  { type: "command", command: "node /tmp/agentstate-lite.mjs session-start", timeout: 10 },
  { type: "command", command: MISMATCHED_NPM_NODE_COMMAND, timeout: 10 },
];

function capture(): { out: () => string; stdout: (value: string) => void } {
  let value = "";
  return { out: () => value, stdout: (next) => void (value += next) };
}

function legacyOpenCodeSource(program: string): string {
  return buildOpenCodePluginSource(program)
    .replace("managed opencode plugin: superbee", "managed opencode plugin: agentstate-lite")
    .replace('const marker = "superbee";', 'const marker = "agentstate-lite";')
    .replace("## AXI ambient context: superbee", "## AXI ambient context: agentstate-lite")
    .replace("AxiSuperbeeAmbientContextPlugin", "AxiAgentstateLiteAmbientContextPlugin");
}

test("JSON reconciliation owns exact generated forms and preserves every near-match", () => {
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [...FOREIGN] },
        {
          matcher: "",
          hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }],
        },
      ],
    },
  };
  const [installed, changed] = computeSessionStartHookInstall(settings, { command: "aslite session-start" });
  assert.equal(changed, true);
  assert.deepEqual(installed.hooks!.SessionStart![0]!.hooks, FOREIGN);
  assert.equal(installed.hooks!.SessionStart![1]!.hooks![0]!.command, "aslite session-start");

  const foreignOnly = { hooks: { SessionStart: [{ matcher: "", hooks: [...FOREIGN] }] } };
  const [uninstalled, removed] = computeHookUninstall(foreignOnly);
  assert.equal(removed, false);
  assert.equal(uninstalled, foreignOnly);
});

test("mismatched npm Node/package prefixes remain foreign through pure status, install, and uninstall", () => {
  const foreign = { type: "command", command: MISMATCHED_NPM_NODE_COMMAND, timeout: 10 };
  const settings = { hooks: { SessionStart: [{ matcher: "", hooks: [foreign] }] } };

  const status = readHookCompatibilityStatus(settings);
  assert.equal(status.installed, false);
  assert.equal(status.compatibility.state, "unmanaged");

  const [installed, installedChanged] = computeSessionStartHookInstall(settings, {
    command: "aslite session-start",
  });
  assert.equal(installedChanged, true);
  assert.deepEqual(installed.hooks!.SessionStart, [
    { matcher: "", hooks: [foreign] },
    { matcher: "", hooks: [{ type: "command", command: "aslite session-start", timeout: 10 }] },
  ]);

  const [uninstalled, uninstalledChanged] = computeHookUninstall(settings);
  assert.equal(uninstalledChanged, false);
  assert.equal(uninstalled, settings);
});

test("noncanonical managed-path near-matches remain foreign through pure status, install, and uninstall", () => {
  const foreign = NONCANONICAL_MANAGED_PATH_CASES.map(({ command }) => ({
    type: "command",
    command,
    timeout: 10,
  }));
  for (const entry of foreign) {
    const status = readHookCompatibilityStatus({
      hooks: { SessionStart: [{ matcher: "", hooks: [entry] }] },
    });
    assert.equal(status.installed, false, entry.command);
    assert.equal(status.compatibility.state, "unmanaged", entry.command);
  }

  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: foreign },
        { matcher: "", hooks: [{ type: "command", command: "aslite session-start", timeout: 10 }] },
      ],
    },
  };
  const [installed, installedChanged] = computeSessionStartHookInstall(settings, {
    command: "aslite session-start",
  });
  assert.equal(installedChanged, false);
  assert.equal(installed, settings);

  const foreignOnly = { hooks: { SessionStart: [{ matcher: "", hooks: foreign }] } };
  const [uninstalled, uninstalledChanged] = computeHookUninstall(foreignOnly);
  assert.equal(uninstalledChanged, false);
  assert.equal(uninstalled, foreignOnly);
});

test("a familiar command under a non-generated matcher is preserved and a managed group is appended", () => {
  const foreign = { type: "command", command: "lint-session", timeout: 30 };
  const settings = {
    hooks: {
      SessionStart: [
        {
          matcher: "tool",
          hooks: [foreign, { type: "command", command: "aslite session-start", timeout: 10 }],
        },
      ],
    },
  };
  const [updated, changed] = computeSessionStartHookInstall(settings, { command: "aslite session-start" });
  assert.equal(changed, true);
  assert.deepEqual(updated.hooks!.SessionStart, [
    {
      matcher: "tool",
      hooks: [foreign, { type: "command", command: "aslite session-start", timeout: 10 }],
    },
    { matcher: "", hooks: [{ type: "command", command: "aslite session-start", timeout: 10 }] },
  ]);
});

test("unknown type and timeout variants remain byte-preserved through install and uninstall", () => {
  const settings = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            { type: "prompt", command: "aslite session-start", timeout: 10 },
            { type: "command", command: "aslite session-start", timeout: 9 },
          ],
        },
      ],
    },
  };
  const [installed, changed] = computeSessionStartHookInstall(settings, { command: "agentstate-lite session-start" });
  assert.equal(changed, true);
  assert.deepEqual(installed.hooks!.SessionStart![0], settings.hooks.SessionStart[0]);
  assert.deepEqual(installed.hooks!.SessionStart![1], {
    matcher: "",
    hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }],
  });

  const [uninstalled, removed] = computeHookUninstall(settings);
  assert.equal(removed, false);
  assert.equal(uninstalled, settings);
});

test("status reports duplicate generated entries as stale", () => {
  const status = readHookCompatibilityStatus({
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "aslite session-start", timeout: 10 }] },
        { matcher: "", hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }] },
      ],
    },
  });
  assert.equal(status.installed, true);
  assert.equal(status.compatibility.state, "stale");
  assert.match(status.compatibility.reason, /2 generated hook entries/);
});

test("npm hook install collapses an exact historical marketplace plus npm hook to one npm hook", () => {
  const marketplace =
    "/Users/u/.claude/plugins/cache/holaxis/agentstate-lite/1.0.147/skills/agentstate-lite/scripts/agentstate-lite.mjs session-start";
  const legacyNpm =
    "/opt/aslite/bin/node /opt/aslite/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start";
  const canonicalNpm =
    "/opt/superbee/bin/node /opt/superbee/lib/node_modules/superbee/dist/superbee.mjs session-start";
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: marketplace, timeout: 10 }] },
        { matcher: "", hooks: [{ type: "command", command: legacyNpm, timeout: 10 }] },
      ],
    },
  };

  const before = readHookCompatibilityStatus(settings);
  assert.equal(before.installed, true);
  assert.equal(before.compatibility.state, "stale");
  assert.match(before.compatibility.reason, /2 generated hook entries/);

  const [installed, changed] = computeSessionStartHookInstall(settings, { command: canonicalNpm });
  assert.equal(changed, true);
  assert.deepEqual(installed.hooks!.SessionStart, [
    { matcher: "", hooks: [{ type: "command", command: canonicalNpm, timeout: 10 }] },
  ]);
  const after = readHookCompatibilityStatus(installed);
  assert.equal(after.installed, true);
  assert.equal(after.compatibility.state, "current");
});

test("durable authority composes a stable npm-prefix Node launch", () => {
  const authority: PersistentInstallAuthority = {
    allowed: true,
    state: "durable_global",
    reason: "durable npm-global executable",
    evidence: {
      npm_prefix: "/opt/superbee",
      bin_path: "/opt/superbee/bin/superbee",
      runtime_path: "/opt/superbee/bin/node",
      executable_path: "/opt/superbee/lib/node_modules/superbee/dist/superbee.mjs",
    },
  };
  assert.deepEqual(buildHookLaunchSpec(authority), {
    program: "/opt/superbee/bin/node",
    args: [
      "/opt/superbee/lib/node_modules/superbee/dist/superbee.mjs",
      "session-start",
    ],
    command:
      "/opt/superbee/bin/node /opt/superbee/lib/node_modules/superbee/dist/superbee.mjs session-start",
  });
});

test("hook install refuses missing persistent authority before creating target files", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-authority-"));
  try {
    await assert.rejects(
      () =>
        hook(["install"], {
          base,
          installAuthority: () => ({
            allowed: false,
            state: "unknown",
            reason: "transient npm exec",
            evidence: { npm_prefix: null, bin_path: null, runtime_path: null, executable_path: null },
          }),
          stdout: () => {},
        }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.message, /durable npm-global CLI/);
        return true;
      },
    );
    assert.deepEqual(await readdir(base), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("OpenCode marker lookalikes are reported unmanaged and never overwritten or deleted", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-opencode-foreign-"));
  const plugin = path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  const authored = "// axi-sdk-js managed opencode plugin: superbee\nexport default 'mine';\n";
  try {
    await mkdir(path.dirname(plugin), { recursive: true });
    await writeFile(plugin, authored);

    const statusCapture = capture();
    await hook(["status", "--json"], { base, stdout: statusCapture.stdout });
    const status = JSON.parse(statusCapture.out());
    assert.equal(status.hook.opencode, false);
    assert.equal(status.hook.hosts.opencode.state, "unmanaged");

    const uninstallCapture = capture();
    await hook(["uninstall", "--json"], { base, stdout: uninstallCapture.stdout });
    const uninstall = JSON.parse(uninstallCapture.out());
    assert.deepEqual(uninstall.hook.notes, [
      `preserved unmanaged OpenCode plugin: ${plugin}`,
    ]);
    assert.equal(await readFile(plugin, "utf8"), authored);

    await assert.rejects(() => hook(["install"], { base, commandBase: "aslite", stdout: () => {} }), CliError);
    assert.equal(await readFile(plugin, "utf8"), authored);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("OpenCode exact generated source remains managed", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-opencode-owned-"));
  const plugin = path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  try {
    await mkdir(path.dirname(plugin), { recursive: true });
    await writeFile(plugin, buildOpenCodePluginSource("superbee"));
    await hook(["uninstall"], { base, stdout: () => {} });
    await assert.rejects(() => readFile(plugin, "utf8"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook install migrates the exact legacy OpenCode filename and source to one canonical plugin", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "superbee-hook-opencode-migrate-"));
  const oldPlugin = path.join(base, ".config", "opencode", "plugins", "axi-agentstate-lite.js");
  const newPlugin = path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  const program = "/workspace/superbee/packages/cli/dist/superbee.mjs";
  try {
    await mkdir(path.dirname(oldPlugin), { recursive: true });
    await writeFile(oldPlugin, legacyOpenCodeSource("aslite"));

    await hook(["install"], { base, commandBase: program, stdout: () => {} });

    await assert.rejects(() => readFile(oldPlugin, "utf8"));
    assert.equal(await readFile(newPlugin, "utf8"), buildOpenCodePluginSource(program));
    const statusCapture = capture();
    await hook(["status", "--json"], { base, commandBase: program, stdout: statusCapture.stdout });
    assert.equal(JSON.parse(statusCapture.out()).hook.hosts.opencode.state, "current");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook install preserves a foreign file at the legacy OpenCode filename", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "superbee-hook-opencode-legacy-foreign-"));
  const oldPlugin = path.join(base, ".config", "opencode", "plugins", "axi-agentstate-lite.js");
  const newPlugin = path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  const authored = "// user-owned legacy filename\nexport default 'mine';\n";
  const program = "/workspace/superbee/packages/cli/dist/superbee.mjs";
  try {
    await mkdir(path.dirname(oldPlugin), { recursive: true });
    await writeFile(oldPlugin, authored);

    await hook(["install"], { base, commandBase: program, stdout: () => {} });

    assert.equal(await readFile(oldPlugin, "utf8"), authored);
    assert.equal(await readFile(newPlugin, "utf8"), buildOpenCodePluginSource(program));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a foreign canonical OpenCode target blocks migration without deleting the managed legacy plugin", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "superbee-hook-opencode-blocked-migrate-"));
  const oldPlugin = path.join(base, ".config", "opencode", "plugins", "axi-agentstate-lite.js");
  const newPlugin = path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  const oldSource = legacyOpenCodeSource("aslite");
  const canonicalForeign = "// user-owned canonical filename\nexport default 'mine';\n";
  try {
    await mkdir(path.dirname(oldPlugin), { recursive: true });
    await writeFile(oldPlugin, oldSource);
    await writeFile(newPlugin, canonicalForeign);

    await assert.rejects(
      () => hook(["install"], {
        base,
        commandBase: "/workspace/superbee/packages/cli/dist/superbee.mjs",
        stdout: () => {},
      }),
      CliError,
    );

    assert.equal(await readFile(oldPlugin, "utf8"), oldSource);
    assert.equal(await readFile(newPlugin, "utf8"), canonicalForeign);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a canonical OpenCode symlink to the managed legacy plugin is refused without dangling the link", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "superbee-hook-opencode-canonical-symlink-"));
  const oldPlugin = path.join(base, ".config", "opencode", "plugins", "axi-agentstate-lite.js");
  const newPlugin = path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  const oldSource = legacyOpenCodeSource("aslite");
  try {
    await mkdir(path.dirname(oldPlugin), { recursive: true });
    await writeFile(oldPlugin, oldSource);
    await symlink(path.basename(oldPlugin), newPlugin);

    await assert.rejects(
      () => hook(["install"], {
        base,
        commandBase: "/workspace/superbee/packages/cli/dist/superbee.mjs",
        stdout: () => {},
      }),
      CliError,
    );

    assert.equal((await lstat(newPlugin)).isSymbolicLink(), true);
    assert.equal(await readFile(oldPlugin, "utf8"), oldSource);
    assert.equal(await readFile(newPlugin, "utf8"), oldSource);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a legacy OpenCode symlink is foreign: canonical install succeeds without changing its target", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "superbee-hook-opencode-legacy-symlink-"));
  const oldPlugin = path.join(base, ".config", "opencode", "plugins", "axi-agentstate-lite.js");
  const newPlugin = path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  const external = path.join(base, "managed-looking-external.js");
  const externalSource = legacyOpenCodeSource("aslite");
  const program = "/workspace/superbee/packages/cli/dist/superbee.mjs";
  try {
    await mkdir(path.dirname(oldPlugin), { recursive: true });
    await writeFile(external, externalSource);
    await symlink(external, oldPlugin);

    await hook(["install"], { base, commandBase: program, stdout: () => {} });

    assert.equal((await lstat(oldPlugin)).isSymbolicLink(), true);
    assert.equal(await readFile(external, "utf8"), externalSource);
    assert.equal(await readFile(newPlugin, "utf8"), buildOpenCodePluginSource(program));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
