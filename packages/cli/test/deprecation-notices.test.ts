import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROJECT_BINDING_FILE_NAME, SUPERBEE_PROJECT_BINDING_FILE_NAME } from "../src/bundle.js";
import type { InstallScope } from "../src/install-scope.js";
import {
  DEPRECATION_NOTICES,
  renderDeprecationNotice,
  stderrIsReserved,
  type DeprecationNoticeCode,
} from "../src/deprecation-notices.js";
import { canonicalUserStateDir, legacyUserStateDir } from "../src/user-state.js";
import { pluginFixture, registerFixture } from "./source-plugin-fixture.js";
import { isolatedUserEnv } from "./support/user-env.js";

const CLI = fileURLToPath(new URL("../../superbee/dist/superbee.mjs", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Without a legacy name in the inherited environment, so each row controls its own trigger. */
function cleanEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = isolatedUserEnv(home, { SUPERBEE_NO_UPDATE_CHECK: "1", SUPERBEE_NO_AUTOPULL: "1" });
  for (const row of DEPRECATION_NOTICES) if (row.env) delete env[row.env];
  // Fixes below really install, so no inherited override may point them at a real host config.
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]) delete env[name];
  env.XDG_CONFIG_HOME = join(home, ".config");
  return { ...env, ...overrides };
}

/** `until` ends a foreground server once its stdout shows it is up. */
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, until?: RegExp): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (until?.test(stdout)) child.kill("SIGTERM");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

interface Fixture {
  base: string;
  home: string;
  project: string;
  /** The built plugin folder a source pointer row registered from. */
  pluginRoot?: string;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "deprecation-notices-"));
  const home = join(base, "home");
  const project = join(base, "project");
  await mkdir(home);
  await mkdir(project);
  try {
    const init = await run(["init", "--dir", "bundle"], project, cleanEnv(home));
    assert.equal(init.code, 0, init.stdout + init.stderr);
    await body({ base, home, project });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

interface Trigger {
  args: string[];
  env?: NodeJS.ProcessEnv;
  until?: RegExp;
  /** Where the notice must say it found the old thing. */
  names?: string;
  /** The install scopes the fix must name. */
  scopes?: readonly InstallScope[];
  arrange?: (fixture: Fixture) => Promise<void>;
  /** Do what the fix says. Returns the arguments that replace the old form, when the fix changes them. */
  applyFix: (fixture: Fixture) => Promise<string[] | void>;
}

async function runFix(fixture: Fixture, args: string[]): Promise<Run> {
  const result = await run(args, fixture.project, cleanEnv(fixture.home));
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return result;
}

const LEGACY_HOOK = {
  hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "aslite session-start", timeout: 10 }] }] },
};

const LOCAL = ["list", "--dir", "bundle", "--json"];

/** Exactly one trigger per table row: the compile-time map is the agreement with the table. */
const renamedVariable = async (): Promise<void> => {};
const TRIGGERS: Record<DeprecationNoticeCode, Trigger> = {
  DEPRECATED_ENV_ACTOR: { args: LOCAL, env: { AGENTSTATE_LITE_ACTOR: "process:tester" }, applyFix: renamedVariable },
  DEPRECATED_ENV_API_KEY: { args: LOCAL, env: { AGENTSTATE_LITE_API_KEY: "secret-value" }, applyFix: renamedVariable },
  DEPRECATED_ENV_NO_UPDATE_CHECK: { args: LOCAL, env: { ASLITE_NO_UPDATE_CHECK: "1" }, applyFix: renamedVariable },
  DEPRECATED_ENV_NO_AUTOPULL: { args: LOCAL, env: { AGENTSTATE_LITE_NO_AUTOPULL: "1" }, applyFix: renamedVariable },
  DEPRECATED_PROJECT_BINDING: {
    args: ["list", "--json"],
    names: PROJECT_BINDING_FILE_NAME,
    arrange: ({ project }) => writeJson(join(project, PROJECT_BINDING_FILE_NAME), { bundle: "./bundle" }),
    applyFix: ({ project }) => rename(join(project, PROJECT_BINDING_FILE_NAME), join(project, SUPERBEE_PROJECT_BINDING_FILE_NAME)),
  },
  DEPRECATED_SOURCE_PLUGIN_POINTER: {
    args: ["source", "plugin", "list", "--json"],
    arrange: async (fixture) => {
      const { base, home } = fixture;
      const root = await pluginFixture(base);
      fixture.pluginRoot = root;
      await registerFixture(root, home);
      const file = join(canonicalUserStateDir(home), "source-plugin-github.json");
      const row = JSON.parse(await readFile(file, "utf8")).plugins[0];
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      await writeJson(file, {
        ...row,
        package: manifest.name,
        version: manifest.version,
        contract: 1,
        core: manifest.superbeeIntegration.core,
        profile: { id: "github-issues", version: 1 },
      });
    },
    applyFix: async (fixture) => {
      const preview = await runFix(fixture, ["source", "plugin", "register", fixture.pluginRoot!, "--json"]);
      await runFix(fixture, ["source", "plugin", "register", fixture.pluginRoot!, "--accept", JSON.parse(preview.stdout).digest, "--json"]);
    },
  },
  DEPRECATED_LEGACY_HOOK: {
    args: ["setup", "--host", "claude-code", "--json"],
    names: "settings.json",
    scopes: ["user"],
    arrange: ({ home }) => writeJson(join(home, ".claude", "settings.json"), LEGACY_HOOK),
    applyFix: async (fixture) => void await runFix(fixture, ["hook", "install", "--scope", "user"]),
  },
  DEPRECATED_LEGACY_SKILL_FOLDER: {
    args: ["setup", "--host", "claude-code", "--json"],
    names: join(".claude", "skills", "aslite"),
    scopes: ["user"],
    arrange: async (fixture) => {
      await runFix(fixture, ["skill", "install", "--scope", "user"]);
      const skills = join(fixture.home, ".claude", "skills");
      await rename(join(skills, "superbee"), join(skills, "aslite"));
    },
    applyFix: async (fixture) => void await runFix(fixture, ["skill", "install", "--scope", "user"]),
  },
  DEPRECATED_LEGACY_MCP_REGISTRATION: {
    args: ["setup", "--host", "opencode", "--json"],
    names: "opencode.json",
    arrange: ({ home }) => writeJson(join(home, ".config", "opencode", "opencode.json"), {
      mcp: { "aslite-views": { type: "local", command: ["aslite", "mcp"] } },
    }),
    // `mcp install` needs the host's own binary, so the proof stops at the part the notice depends on.
    applyFix: ({ home }) => writeJson(join(home, ".config", "opencode", "opencode.json"), { mcp: {} }),
  },
  DEPRECATED_LEGACY_USER_STATE: {
    args: ["setup", "--host", "claude-code", "--json"],
    arrange: async ({ home }) => {
      await rm(canonicalUserStateDir(home), { recursive: true, force: true });
      const legacy = legacyUserStateDir(home);
      await mkdir(legacy, { recursive: true, mode: 0o700 });
      await chmod(legacy, 0o700);
      await writeFile(join(legacy, "catalog.json"), `${JSON.stringify({ schema_version: 1, entries: [] })}\n`, { mode: 0o600 });
    },
    applyFix: async (fixture) => void await runFix(fixture, ["setup", "migrate-state"]),
  },
  DEPRECATED_REMOTE_FLAG: {
    args: ["list", "--remote", "http://127.0.0.1:9", "--json"],
    applyFix: async () => LOCAL,
  },
  DEPRECATED_SERVE: {
    args: ["serve", "--dir", "bundle", "--port", "0", "--json"],
    until: /listening/,
    applyFix: async () => LOCAL,
  },
};

test("every row names the old thing, its replacement, a runnable fix and a unique stable code", () => {
  const codes = DEPRECATION_NOTICES.map((row) => row.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual([...codes].sort(), Object.keys(TRIGGERS).sort());
  for (const row of DEPRECATION_NOTICES) {
    assert.match(row.code, /^DEPRECATED_[A-Z_]+$/);
    assert.ok(row.old.trim(), row.code);
    assert.ok(row.replacement.trim(), row.code);
    assert.ok(row.fix("superbee", ["user"]).trim().length > 10, row.code);
    const rendered = renderDeprecationNotice(row, "superbee", ["/a\nforged"], ["user"]);
    assert.equal(rendered.split("\n").length, 2, "one line, newline terminated");
    assert.ok(rendered.includes(row.fix("superbee", ["user"])), row.code);
    assert.ok(rendered.includes(`[${row.code}]`), row.code);
  }
});

test("the binding row spells the same file names bundle.ts resolves", () => {
  const row = DEPRECATION_NOTICES.find((candidate) => candidate.code === "DEPRECATED_PROJECT_BINDING")!;
  assert.ok(row.old.includes(PROJECT_BINDING_FILE_NAME));
  assert.equal(row.replacement, SUPERBEE_PROJECT_BINDING_FILE_NAME);
});

for (const row of DEPRECATION_NOTICES) {
  test(`trigger emits ${row.code} once, on stderr only, with its fix`, () => withFixture(async (fixture) => {
    const trigger = TRIGGERS[row.code];
    await trigger.arrange?.(fixture);
    const result = await run(trigger.args, fixture.project, cleanEnv(fixture.home, trigger.env), trigger.until);
    assert.equal(result.stderr.split(`[${row.code}]`).length - 1, 1, result.stderr);
    for (const words of row.fix("\0", trigger.scopes ?? []).split("\0")) assert.ok(result.stderr.includes(words), result.stderr);
    if (trigger.names) assert.ok(result.stderr.includes(trigger.names), result.stderr);
    assert.ok(!result.stdout.includes(row.code), result.stdout);
    assert.ok(!result.stderr.includes("secret-value"), "a notice never prints a value");
  }));

  test(`doing the fix clears ${row.code}`, () => withFixture(async (fixture) => {
    const trigger = TRIGGERS[row.code];
    await trigger.arrange?.(fixture);
    const before = await run(trigger.args, fixture.project, cleanEnv(fixture.home, trigger.env), trigger.until);
    assert.ok(before.stderr.includes(`[${row.code}]`), before.stderr);
    const replacement = await trigger.applyFix(fixture);
    const after = await run(replacement ?? trigger.args, fixture.project, cleanEnv(fixture.home), trigger.until);
    assert.ok(!after.stderr.includes(row.code), after.stderr);
  }));
}

test("a project-scope legacy hook names --scope project, and that install clears it", () => withFixture(async (fixture) => {
  const { home, project } = fixture;
  const args = ["setup", "--host", "claude-code", "--scope", "project", "--json"];
  await writeJson(join(project, ".claude", "settings.json"), LEGACY_HOOK);
  const before = await run(args, project, cleanEnv(home));
  assert.ok(before.stderr.includes("hook install --scope project"), before.stderr);
  assert.ok(!before.stderr.includes("--scope user"), before.stderr);
  await runFix(fixture, ["hook", "install", "--scope", "project"]);
  const after = await run(args, project, cleanEnv(home));
  assert.ok(!after.stderr.includes("DEPRECATED_LEGACY_HOOK"), after.stderr);
}));

test("a default setup also reaches a project-scope legacy hook and names its scope", () => withFixture(async ({ home, project }) => {
  await writeJson(join(project, ".claude", "settings.json"), LEGACY_HOOK);
  const result = await run(["setup", "--host", "claude-code", "--json"], project, cleanEnv(home));
  assert.ok(result.stderr.includes("hook install --scope project"), result.stderr);
  assert.ok(!result.stderr.includes("hook install --scope user"), result.stderr);
}));

test("a skill folder install cannot claim stays named until the person deletes it", () => withFixture(async (fixture) => {
  const { home, project } = fixture;
  const folder = join(home, ".claude", "skills", "aslite");
  const args = ["setup", "--host", "claude-code", "--json"];
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), "old\n");
  await runFix(fixture, ["skill", "install", "--scope", "user"]);
  const still = await run(args, project, cleanEnv(home));
  assert.ok(still.stderr.includes("delete the folder if it remains"), still.stderr);
  await rm(folder, { recursive: true });
  const after = await run(args, project, cleanEnv(home));
  assert.ok(!after.stderr.includes("DEPRECATED_LEGACY_SKILL_FOLDER"), after.stderr);
}));

test("bare home with --remote carries the notice, with the same stdout and exit code", () => withFixture(async ({ home, project }) => {
  const remote = ["--remote", "http://127.0.0.1:9"];
  const result = await run(remote, project, cleanEnv(home));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr.split("[DEPRECATED_REMOTE_FLAG]").length - 1, 1, result.stderr);
  assert.ok(!result.stdout.includes("DEPRECATED"), result.stdout);
}));

test("session-start with --remote stays silent", () => withFixture(async ({ home, project }) => {
  const result = await run(["session-start", "--remote", "http://127.0.0.1:9"], project, cleanEnv(home));
  assert.equal(result.stderr, "");
}));

for (const [label, args] of [
  ["catalog resolve --field path", ["catalog", "resolve", "absent", "--field", "path"]],
  ["catalog resolve --field=path", ["catalog", "resolve", "absent", "--field=path"]],
  ["doc read --field", ["doc", "read", "absent/doc", "--dir", "bundle", "--field", "head_version"]],
  ["doc read --out -", ["doc", "read", "absent/doc", "--dir", "bundle", "--out", "-"]],
  ["pull --out -", ["pull", "--doc-key", "absent/doc", "--dir", "bundle", "--out", "-"]],
  ["mcp", ["mcp", "--bogus"]],
] as const) {
  test(`a ${label} failure keeps its stderr envelope and exit code byte for byte`, () => withFixture(async ({ home, project }) => {
    const clean = await run([...args], project, cleanEnv(home));
    const noticed = await run([...args], project, cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester" }));
    assert.notEqual(clean.code, 0);
    assert.ok(clean.stderr.length > 0, "the proof needs an envelope on stderr");
    assert.equal(noticed.stderr, clean.stderr);
    assert.equal(noticed.stdout, clean.stdout);
    assert.equal(noticed.code, clean.code);
  }));
}

test("a clean run emits no notice", () => withFixture(async ({ home, project }) => {
  const result = await run(LOCAL, project, cleanEnv(home));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
}));

test("a notice in --json mode leaves stdout parseable and identical, with the same exit code", () => withFixture(async ({ home, project }) => {
  const clean = await run(LOCAL, project, cleanEnv(home));
  const noticed = await run(LOCAL, project, cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester" }));
  assert.ok(noticed.stderr.includes("[DEPRECATED_ENV_ACTOR]"), "the notice must fire for this proof to mean anything");
  assert.equal(noticed.code, clean.code);
  assert.equal(noticed.stdout, clean.stdout);
  assert.equal(typeof JSON.parse(noticed.stdout), "object");
}));

test("a failing command keeps its exit code and error envelope under a notice", () => withFixture(async ({ home, project }) => {
  const args = ["doc", "read", "missing/doc", "--dir", "bundle"];
  const clean = await run(args, project, cleanEnv(home));
  const noticed = await run(args, project, cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester" }));
  assert.notEqual(clean.code, 0);
  assert.equal(noticed.code, clean.code);
  assert.equal(noticed.stdout, clean.stdout);
}));

test("hook commands stay silent on stderr even with a legacy variable and binding", () => withFixture(async ({ home, project }) => {
  await writeJson(join(project, PROJECT_BINDING_FILE_NAME), { bundle: "./bundle" });
  const result = await run(["session-start"], project, cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester" }));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
}));

test("a byte channel keeps its stderr receipt parseable and its stdout raw", () => withFixture(async ({ home, project }) => {
  const env = cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester" });
  const write = await run(["doc", "write", "notes/raw", "--dir", "bundle", "--type", "Note", "--body", "payload", "--actor", "process:tester"], project, cleanEnv(home));
  assert.equal(write.code, 0, write.stdout);
  const result = await run(["doc", "read", "notes/raw", "--dir", "bundle", "--out", "-", "--json"], project, env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes("payload"));
  assert.equal(typeof JSON.parse(result.stderr), "object");
}));

test("commands whose stderr is a contract are reserved, in every flag spelling", () => {
  for (const argv of [
    ["session-start"],
    ["turn-end", "--json"],
    ["publish", "--json"],
    ["doc", "read", "a", "--out", "-"],
    ["doc", "read", "a", "--body-out=-"],
    ["pull", "a", "--out=-"],
    ["doc", "read", "a", "--rendered-out", "-"],
    ["doc", "read", "a", "--field", "head_version"],
    ["catalog", "resolve", "a", "--field=path"],
    ["mcp"],
  ]) assert.equal(stderrIsReserved(argv), true, argv.join(" "));
  for (const argv of [["publish"], ["doc", "read", "a", "--out", "file"], ["list", "--json", "--field", "a=b"], []]) {
    assert.equal(stderrIsReserved(argv), false, argv.join(" "));
  }
});

test("a closed stderr reader costs the notice and never changes the exit code", () => withFixture(async ({ home, project }) => {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...LOCAL], {
      cwd: project,
      env: cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester" }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.destroy();
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
}));
