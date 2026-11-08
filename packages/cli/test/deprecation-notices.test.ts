import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RETIRED_PROJECT_BINDING_FILE_NAME, SUPERBEE_PROJECT_BINDING_FILE_NAME } from "../src/bundle.js";
import {
  DEPRECATION_NOTICES,
  RETIRED_ENV,
  RETIRED_REMOTE_ENV,
  RETIRED_UNUSED_ENV,
  renderDeprecationNotice,
  stderrIsReserved,
  type DeprecationNoticeCode,
} from "../src/deprecation-notices.js";
import { canonicalUserStateDir, legacyUserStateDir } from "../src/user-state.js";
import { isolatedUserEnv } from "./support/user-env.js";

const CLI = fileURLToPath(new URL("../../superbee/dist/superbee.mjs", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Without a retired name in the inherited environment, so each case controls its own trigger. */
function cleanEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = isolatedUserEnv(home, { SUPERBEE_NO_UPDATE_CHECK: "1", SUPERBEE_NO_AUTOPULL: "1" });
  for (const [retired] of RETIRED_ENV) delete env[retired];
  for (const [retired] of RETIRED_UNUSED_ENV) delete env[retired];
  delete env[RETIRED_REMOTE_ENV];
  // Fixes below really install, so no inherited override may point them at a real host config.
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]) delete env[name];
  env.XDG_CONFIG_HOME = join(home, ".config");
  return { ...env, ...overrides };
}

/** {@link cleanEnv} with each given retired name set and its replacement absent. */
function retiredOnly(home: string, retired: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = cleanEnv(home, retired);
  for (const [name, replacement] of RETIRED_ENV) if (name in retired) delete env[replacement];
  return env;
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
  arrange?: (fixture: Fixture) => Promise<void>;
  /** Do what the fix says. Returns the arguments that replace the old form, when the fix changes them. */
  applyFix: (fixture: Fixture) => Promise<string[] | void>;
}

async function runFix(fixture: Fixture, args: string[]): Promise<Run> {
  const result = await run(args, fixture.project, cleanEnv(fixture.home));
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return result;
}

const LOCAL = ["list", "--dir", "bundle", "--json"];

/** Exactly one trigger per table row: the compile-time map is the agreement with the table. */
const TRIGGERS: Record<DeprecationNoticeCode, Trigger> = {
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
};

test("every row names the old thing, its replacement, a runnable fix and a unique stable code", () => {
  const codes = DEPRECATION_NOTICES.map((row) => row.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual([...codes].sort(), Object.keys(TRIGGERS).sort());
  for (const row of DEPRECATION_NOTICES) {
    assert.match(row.code, /^DEPRECATED_[A-Z_]+$/);
    assert.ok(row.old.trim(), row.code);
    assert.ok(row.replacement.trim(), row.code);
    assert.ok(row.fix("superbee").trim().length > 10, row.code);
    const rendered = renderDeprecationNotice(row, "superbee", ["/a\nforged"]);
    assert.equal(rendered.split("\n").length, 2, "one line, newline terminated");
    assert.ok(rendered.includes(row.fix("superbee")), row.code);
    assert.ok(rendered.includes(`[${row.code}]`), row.code);
  }
});

for (const row of DEPRECATION_NOTICES) {
  test(`trigger emits ${row.code} once, on stderr only, with its fix`, () => withFixture(async (fixture) => {
    const trigger = TRIGGERS[row.code];
    await trigger.arrange?.(fixture);
    const result = await run(trigger.args, fixture.project, cleanEnv(fixture.home, trigger.env), trigger.until);
    assert.equal(result.stderr.split(`[${row.code}]`).length - 1, 1, result.stderr);
    for (const words of row.fix("\0").split("\0")) assert.ok(result.stderr.includes(words), result.stderr);
    if (trigger.names) assert.ok(result.stderr.includes(trigger.names), result.stderr);
    assert.ok(!result.stdout.includes(row.code), result.stdout);
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

const OLD_HOOK = { type: "command", command: "aslite session-start", timeout: 10 };
const hookSettings = (...entries: unknown[]) => ({ hooks: { SessionStart: [{ matcher: "", hooks: entries }] } });
const sessionStartCommands = async (file: string): Promise<string[]> =>
  JSON.parse(await readFile(file, "utf8")).hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) =>
    group.hooks.map((entry) => entry.command));
const exists = (file: string) => stat(file).then(() => true, () => false);

test("hook install replaces an unedited old aslite hook and says so, with no warning", () => withFixture(async (fixture) => {
  const settings = join(fixture.home, ".claude", "settings.json");
  await writeJson(settings, hookSettings(OLD_HOOK));
  const result = await runFix(fixture, ["hook", "install", "--scope", "user"]);
  assert.ok(result.stdout.includes("Removed old aslite hook from ~/.claude/settings.json. Installed superbee hook."), result.stdout);
  assert.ok(!result.stderr.includes("RETIRED_HOOK"), result.stderr);
  const commands = await sessionStartCommands(settings);
  assert.equal(commands.length, 1);
  assert.ok(!commands[0]!.includes("aslite"), commands[0]);
}));

test("hook install removes an unedited old agentstate-lite OpenCode plugin", () => withFixture(async (fixture) => {
  const plugin = join(fixture.home, ".config", "opencode", "plugins", "axi-agentstate-lite.js");
  await mkdir(join(plugin, ".."), { recursive: true });
  await writeFile(plugin, await readFile(new URL("./fixtures/opencode-aslite-pre3.js", import.meta.url), "utf8"));
  const result = await runFix(fixture, ["hook", "install", "--scope", "user"]);
  assert.ok(result.stdout.includes("Removed old aslite hook from ~/.config/opencode/plugins/axi-agentstate-lite.js."), result.stdout);
  assert.equal(await exists(plugin), false);
  assert.equal(await exists(join(plugin, "..", "axi-superbee.js")), true);
}));

test("an edited old hook stays, installs beside it, and warns in hook install, hook status and setup without failing", () => withFixture(async (fixture) => {
  const settings = join(fixture.home, ".claude", "settings.json");
  const edited = { type: "command", command: "aslite session-start --verbose", timeout: 10 };
  await writeJson(settings, hookSettings(edited));
  const warning = "~/.claude/settings.json has a hook that runs aslite or agentstate-lite, and Superbee did not remove it because it was edited. It may fail or duplicate context. To remove it, delete that entry. [RETIRED_HOOK]";
  const install = await runFix(fixture, ["hook", "install", "--scope", "user"]);
  assert.ok(install.stderr.includes(warning), install.stderr);
  assert.ok(!install.stdout.includes("Removed old"), install.stdout);
  assert.ok(!install.stderr.includes("--verbose"), "never echoes the hook command");
  const commands = await sessionStartCommands(settings);
  assert.equal(commands.length, 2);
  assert.equal(commands[0], edited.command);
  for (const args of [["hook", "status", "--scope", "user"], ["setup", "--host", "claude-code", "--json"]]) {
    const result = await run(args, fixture.project, cleanEnv(fixture.home));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stderr.split("[RETIRED_HOOK]").length - 1, 1, result.stderr);
  }
  const quiet = await run(["session-start"], fixture.project, cleanEnv(fixture.home));
  assert.ok(!quiet.stderr.includes("RETIRED_HOOK"), quiet.stderr);
}));

test("an edited old OpenCode plugin stays and warns", () => withFixture(async (fixture) => {
  const plugin = join(fixture.home, ".config", "opencode", "plugins", "axi-agentstate-lite.js");
  await mkdir(join(plugin, ".."), { recursive: true });
  const original = await readFile(new URL("./fixtures/opencode-aslite-pre3.js", import.meta.url), "utf8");
  await writeFile(plugin, `${original}// mine\n`);
  const result = await runFix(fixture, ["hook", "install", "--scope", "user"]);
  assert.ok(result.stderr.includes("~/.config/opencode/plugins/axi-agentstate-lite.js has the old agentstate-lite plugin name but does not match a file Superbee wrote, so Superbee left it. Delete it to stop it loading. [RETIRED_HOOK]"), result.stderr);
  assert.equal(await exists(plugin), true);
}));

test("skill install deletes an unedited old aslite skill folder and keeps an edited one with a warning", () => withFixture(async (fixture) => {
  const skills = join(fixture.home, ".claude", "skills");
  const old = join(skills, "aslite");
  await runFix(fixture, ["skill", "install", "--scope", "user"]);
  await rename(join(skills, "superbee"), old);
  const removed = await runFix(fixture, ["skill", "install", "--scope", "user"]);
  assert.ok(removed.stdout.includes("Removed old aslite skill from ~/.claude/skills/aslite."), removed.stdout);
  assert.ok(!removed.stderr.includes("RETIRED_SKILL_FOLDER"), removed.stderr);
  assert.equal(await exists(old), false);
  assert.equal(await exists(join(skills, "superbee", "SKILL.md")), true);

  await runFix(fixture, ["skill", "install", "--scope", "user"]);
  await mkdir(old);
  await writeFile(join(old, "SKILL.md"), "my notes\n");
  const kept = await runFix(fixture, ["skill", "install", "--scope", "user"]);
  const warning = "~/.claude/skills/aslite is the old aslite skill and has local edits, so Superbee left it. It teaches commands that no longer exist. Delete the folder. The current skill is at ~/.claude/skills/superbee. [RETIRED_SKILL_FOLDER]";
  assert.ok(kept.stderr.includes(warning), kept.stderr);
  assert.equal(await readFile(join(old, "SKILL.md"), "utf8"), "my notes\n");
  const setup = await run(["setup", "--host", "claude-code", "--json"], fixture.project, cleanEnv(fixture.home));
  assert.ok(setup.stderr.includes(warning), setup.stderr);
}));

test("an old skill folder that cannot be fully removed leaves the install in place and warns", { skip: process.getuid?.() === 0 }, () => withFixture(async (fixture) => {
  const skills = join(fixture.home, ".claude", "skills");
  const old = join(skills, "aslite");
  await runFix(fixture, ["skill", "install", "--scope", "user"]);
  await rename(join(skills, "superbee"), old);
  const locked = join(old, "references");
  await chmod(locked, 0o555);
  let lockedAside = locked;
  try {
    const result = await runFix(fixture, ["skill", "install", "--scope", "user"]);
    assert.ok(!result.stdout.includes("Removed old aslite skill"), result.stdout);
    assert.match(result.stderr, /The current skill is installed at ~\/\.claude\/skills\/superbee, but ~\/\.claude\/skills\/aslite\.removing-[0-9a-z-]+, the old aslite skill, could not be fully removed\. It teaches commands that no longer exist\. Delete the folder\. \[RETIRED_SKILL_FOLDER\]/);
    assert.ok(!result.stderr.includes("has local edits"), result.stderr);
    assert.equal(result.stderr.split("[RETIRED_SKILL_FOLDER]").length - 1, 1, result.stderr);
    assert.equal(await exists(join(skills, "superbee", "SKILL.md")), true);
    const aside = (await readdir(skills)).find((name) => name.startsWith("aslite.removing-"));
    assert.ok(aside, "the remains stay where the warning says");
    lockedAside = join(skills, aside, "references");
  } finally {
    await chmod(lockedAside, 0o755).catch(() => chmod(locked, 0o755));
  }
}));

test("old aslite MCP registration names are ignored like any other name", () => withFixture(async (fixture) => {
  await writeJson(join(fixture.home, ".config", "opencode", "opencode.json"), {
    mcp: { "aslite-views": { type: "local", command: ["aslite", "mcp"] } },
  });
  const result = await run(["setup", "--host", "opencode", "--json"], fixture.project, cleanEnv(fixture.home));
  assert.ok(!/aslite|agentstate-lite|legacy/i.test(result.stderr), result.stderr);
  assert.ok(!/known_legacy/.test(result.stdout), result.stdout);
}));

test("session-start with --remote writes nothing to stderr", () => withFixture(async ({ home, project }) => {
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
  test(`${label} refuses a retired variable on its stderr error channel, leaving stdout empty`, () => withFixture(async ({ home, project }) => {
    const clean = await run([...args], project, cleanEnv(home));
    assert.ok(clean.stderr.length > 0, "the command routes its own errors to stderr");
    const refused = await run([...args], project, cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester" }));
    assert.equal(refused.code, 2);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /code: RETIRED_ENV/);
    assert.match(refused.stderr, /rename AGENTSTATE_LITE_ACTOR to SUPERBEE_ACTOR/);
  }));
}

test("a clean run emits no notice", () => withFixture(async ({ home, project }) => {
  const result = await run(LOCAL, project, cleanEnv(home));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
}));

test("a notice in --json mode leaves stdout parseable, with exit 0", () => withFixture(async (fixture) => {
  const trigger = TRIGGERS.DEPRECATED_LEGACY_USER_STATE;
  await trigger.arrange?.(fixture);
  const noticed = await run(trigger.args, fixture.project, cleanEnv(fixture.home));
  assert.ok(noticed.stderr.includes("[DEPRECATED_LEGACY_USER_STATE]"), "the notice must fire for this proof to mean anything");
  assert.equal(noticed.code, 0);
  assert.equal(typeof JSON.parse(noticed.stdout), "object");
}));

test("hook commands never refuse: session-start exits 0 with an empty stderr and names each fix", () => withFixture(async ({ home, project }) => {
  await writeJson(join(project, RETIRED_PROJECT_BINDING_FILE_NAME), { bundle: "./bundle" });
  const result = await run(["session-start"], project, retiredOnly(home, { AGENTSTATE_LITE_NO_AUTOPULL: "1" }));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /retired_env: .*AGENTSTATE_LITE_NO_AUTOPULL is no longer read.*rename AGENTSTATE_LITE_NO_AUTOPULL to SUPERBEE_NO_AUTOPULL/);
  assert.match(result.stdout, /skips the update check and automatic pull/);
  assert.match(result.stdout, /project_binding_error: .*retired name \.agentstate\.json, which is no longer read; rename it to \.superbee\.json \(same contents\)/);
}));

test("a byte channel works with a retired name beside its replacement", () => withFixture(async ({ home, project }) => {
  const env = cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "process:tester", SUPERBEE_ACTOR: "process:tester" });
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

test("a closed stderr reader costs the notice and never changes the exit code", () => withFixture(async (fixture) => {
  const trigger = TRIGGERS.DEPRECATED_LEGACY_USER_STATE;
  await trigger.arrange?.(fixture);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...trigger.args], {
      cwd: fixture.project,
      env: cleanEnv(fixture.home),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.destroy();
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
}));

for (const [retired, why] of RETIRED_UNUSED_ENV) {
  test(`${retired} has no replacement and is refused whenever it is set, even beside --dir, never printing the value`, () => withFixture(async ({ home, project }) => {
    for (const value of ["secret-value", ""]) {
      const result = await run(LOCAL, project, cleanEnv(home, { [retired]: value }));
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stdout, /code: RETIRED_ENV/);
      assert.ok(result.stdout.includes(`${retired} is no longer read; ${why}.`), result.stdout);
      assert.ok(!(result.stdout + result.stderr).includes("secret-value"), "a refusal never prints a value");
    }
  }));
}

test("AGENTSTATE_LITE_API_KEY names removal and login, never a rename to an unread SUPERBEE_API_KEY", () => withFixture(async ({ home, project }) => {
  const result = await run(LOCAL, project, cleanEnv(home, { AGENTSTATE_LITE_API_KEY: "k", SUPERBEE_API_KEY: "k" }));
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stdout, /remove AGENTSTATE_LITE_API_KEY wherever it is set; it is no longer used\. Hosted bundles use .+ login\./);
  assert.doesNotMatch(result.stdout, /SUPERBEE_API_KEY/);
}));

test("SUPERBEE_API_KEY is ignored silently: nothing reads it and nothing refuses it", () => withFixture(async ({ home, project }) => {
  const result = await run(LOCAL, project, cleanEnv(home, { SUPERBEE_API_KEY: "k" }));
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
}));

for (const [retired, replacement] of RETIRED_ENV) {
  test(`${retired} alone is refused before any work, naming the rename and never the value`, () => withFixture(async ({ home, project }) => {
    const result = await run(LOCAL, project, retiredOnly(home, { [retired]: "secret-value" }));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /code: USAGE/);
    assert.match(result.stdout, /code: RETIRED_ENV/);
    assert.ok(result.stdout.includes(`${retired} is no longer read; Superbee reads only ${replacement}.`), result.stdout);
    assert.ok(result.stdout.includes(`rename ${retired} to ${replacement} wherever it is set`), result.stdout);
    assert.ok(result.stdout.includes("then run the command again."), result.stdout);
    assert.ok(!(result.stdout + result.stderr).includes("secret-value"), "a refusal never prints a value");
    // An empty value is still a setting the person meant.
    assert.equal((await run(LOCAL, project, retiredOnly(home, { [retired]: "" }))).code, 2);
  }));

  test(`${retired} beside ${replacement} is ignored quietly, whatever its value`, () => withFixture(async ({ home, project }) => {
    const clean = await run(LOCAL, project, cleanEnv(home, { [replacement]: "1" }));
    for (const value of ["", "different"]) {
      const result = await run(LOCAL, project, cleanEnv(home, { [replacement]: "1", [retired]: value }));
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, clean.stdout);
    }
  }));
}

test("several retired names give one refusal listing each", () => withFixture(async ({ home, project }) => {
  const result = await run(LOCAL, project, retiredOnly(home, { AGENTSTATE_LITE_ACTOR: "a", ASLITE_NO_UPDATE_CHECK: "1" }));
  assert.equal(result.code, 2);
  assert.ok(result.stdout.includes("AGENTSTATE_LITE_ACTOR and ASLITE_NO_UPDATE_CHECK are no longer read"), result.stdout);
  assert.match(result.stdout, /retired_env\[2\]: AGENTSTATE_LITE_ACTOR,ASLITE_NO_UPDATE_CHECK/);
}));

test("help and version still answer with a retired name set", () => withFixture(async ({ home, project }) => {
  const env = cleanEnv(home, { AGENTSTATE_LITE_ACTOR: "a" });
  assert.equal((await run(["--help"], project, env)).code, 0);
  assert.equal((await run(["--version"], project, env)).code, 0);
}));

test("a .agentstate.json binding is refused with the rename, and doing the rename works", () => withFixture(async ({ home, project }) => {
  const retired = join(project, RETIRED_PROJECT_BINDING_FILE_NAME);
  await writeJson(retired, { bundle: "./bundle" });
  const refused = await run(["list", "--json"], project, cleanEnv(home));
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.stdout, /code: RETIRED_PROJECT_BINDING/);
  assert.match(refused.stdout, /project binding .*\/project\/\.agentstate\.json uses the retired name \.agentstate\.json, which is no longer read; rename it to \.superbee\.json/);
  assert.match(refused.stdout, /rename it to \.superbee\.json \(same contents\): mv .*\.agentstate\.json.* .*\.superbee\.json/);
  // --dir never consults a binding.
  assert.equal((await run(LOCAL, project, cleanEnv(home))).code, 0);
  await rename(retired, join(project, SUPERBEE_PROJECT_BINDING_FILE_NAME));
  const fixed = await run(["list", "--json"], project, cleanEnv(home));
  assert.equal(fixed.code, 0, fixed.stdout);
  assert.equal(fixed.stderr, "");
}));

test("both binding names at one level refuse with the delete fix", () => withFixture(async ({ home, project }) => {
  await writeJson(join(project, RETIRED_PROJECT_BINDING_FILE_NAME), { bundle: "./bundle" });
  await writeJson(join(project, SUPERBEE_PROJECT_BINDING_FILE_NAME), { bundle: "./bundle" });
  const result = await run(["list", "--json"], project, cleanEnv(home));
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stdout, /code: RETIRED_PROJECT_BINDING/);
  assert.match(result.stdout, /has both \.superbee\.json and the retired \.agentstate\.json, which is no longer read/);
  assert.match(result.stdout, /delete .*\.agentstate\.json after checking that .*\.superbee\.json points at the bundle you want/);
}));

test("a nearer .agentstate.json refuses rather than falling through to a farther .superbee.json", () => withFixture(async ({ home, project }) => {
  const nested = join(project, "nested");
  await writeJson(join(project, SUPERBEE_PROJECT_BINDING_FILE_NAME), { bundle: "./bundle" });
  await writeJson(join(nested, RETIRED_PROJECT_BINDING_FILE_NAME), { bundle: "../bundle" });
  const result = await run(["list", "--json"], nested, cleanEnv(home));
  assert.equal(result.code, 2, result.stdout);
  assert.ok(result.stdout.includes(join(nested, RETIRED_PROJECT_BINDING_FILE_NAME)), result.stdout);
}));
