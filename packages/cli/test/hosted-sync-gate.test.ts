// `superbee sync` in a hosted checkout runs the declared sync gate (`git config superbee.syncGate`)
// after the pull and before anything is sent, against the stateful fake of the hosted sync routes.
// The gate comes from Git configuration as seen from the checkout folder, never from the host.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decode } from "@toon-format/toon";

import { CliError, EXIT } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

// Only this file's own configuration counts: no machine-wide or personal gate leaks in.
const isolatedGitConfig = path.join(await mkdtemp(path.join(tmpdir(), "sb-gate-gitconfig-")), "global-config");
await writeFile(isolatedGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = isolatedGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

interface Harness {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  out: string[];
}

async function harness(host = new FakeHost()): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-gate-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-gate-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  const h: Harness = { home, cwd, folder: path.join(cwd, "team"), auth, host, out: [] };
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  return h;
}

/** Make the harness's working directory a Git repository holding the checkout, with `config` set locally. */
function repositoryWith(h: Harness, config: Record<string, string>): void {
  execFileSync("git", ["init", "-q", h.cwd]);
  for (const [key, value] of Object.entries(config)) execFileSync("git", ["-C", h.cwd, "config", key, value]);
}

const instant = async () => {};

async function attempt(h: Harness): Promise<{ text: string; error?: CliError }> {
  h.out.length = 0;
  try {
    await sync(["--dir", h.folder], {
      stdout: (text: string) => void h.out.push(text),
      auth: h.auth,
      cwd: h.cwd,
      fetch: h.host.fetch,
      write: { sleep: instant, lookupDelayMs: 0 },
      sleep: instant,
      lockWaitMs: 200,
    });
    return { text: h.out.join("") };
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return { text: h.out.join(""), error };
  }
}

async function runSync(h: Harness): Promise<Record<string, unknown>> {
  const { text, error } = await attempt(h);
  assert.equal(error, undefined, error?.message);
  return decode(text.trim()) as Record<string, unknown>;
}

async function failingSync(h: Harness): Promise<{ text: string; error: CliError }> {
  const { text, error } = await attempt(h);
  assert.ok(error, `expected sync to fail; it printed ${text}`);
  return { text, error };
}

async function editAlpha(h: Harness, body: string): Promise<void> {
  const file = path.join(h.folder, "notes/alpha.md");
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace(/\n---\n[\s\S]*$/, `\n---\n${body}`));
}

const sent = (h: Harness) => h.host.writes.filter((call) => call.route !== "outcome").length + h.host.rootCalls.length;

async function stateDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "sb-gate-state-")));
}

test("a failing gate blocks the sync: exit 5 GATE_FAILED, nothing is sent, and the edit is kept for the next sync", async () => {
  const h = await harness();
  const state = await stateDir();
  const ran = path.join(state, "ran");
  repositoryWith(h, {
    "superbee.syncGate": `printf '%s %s %s %s\\n' "$SUPERBEE_SYNC_GATE" "$SUPERBEE_SYNC_HOME" "$SUPERBEE_HOSTED_BUNDLE_ID" "$PWD" >> '${ran}'; echo 'lint: alpha is broken'; exit 3`,
  });
  await editAlpha(h, "Alpha body, gated.\n");
  const before = h.host.docs.get("notes/alpha")!.raw;

  const { text, error } = await failingSync(h);
  assert.equal(error.code, "GATE_FAILED");
  assert.equal(error.exitCode, EXIT.CONFLICT);
  assert.equal(error.exitCode, 5);
  assert.equal(text, "", "a held sync prints no receipt; the envelope carries the facts");
  assert.match(error.message, /exited 3; nothing was sent/);
  const details = error.details as { reason: string; folder: string; unsent: number; gate: Record<string, unknown> };
  assert.equal(details.reason, "gate_failed");
  assert.equal(details.folder, h.folder);
  assert.equal(details.unsent, 1);
  assert.equal(details.gate.exit_status, 3);
  assert.match(String(details.gate.output_tail), /lint: alpha is broken/);
  assert.match(error.help ?? "", /git config --get superbee\.syncGate/);
  assert.equal(sent(h), 0, "no document and no front page was sent");
  assert.equal(h.host.docs.get("notes/alpha")!.raw, before);
  assert.equal(await readFile(ran, "utf8"), `1 hosted ${BUNDLE} ${h.folder}\n`);

  // The gate is fixed: the very same edit is sent by the next plain sync.
  execFileSync("git", ["-C", h.cwd, "config", "superbee.syncGate", `printf ok >> '${path.join(state, "passed")}'`]);
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced");
  assert.match(String(receipt.gate), /^passed: printf ok/);
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Alpha body, gated.\n");
  assert.equal(await readFile(path.join(state, "passed"), "utf8"), "ok");
});

test("a passing gate lets the sync proceed, and the receipt names it", async () => {
  const h = await harness();
  repositoryWith(h, { "superbee.syncGate": "test -f notes/alpha.md" });
  await editAlpha(h, "Alpha body, passed.\n");
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced");
  assert.equal(receipt.gate, "passed: test -f notes/alpha.md (attempt 1)");
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Alpha body, passed.\n");
});

test("a gate that changes the checkout fails, and nothing is sent", async () => {
  const h = await harness();
  repositoryWith(h, { "superbee.syncGate": "printf extra > notes/written-by-gate.md" });
  await editAlpha(h, "Alpha body, judged.\n");
  const { error } = await failingSync(h);
  assert.equal(error.code, "GATE_FAILED");
  assert.equal((error.details as { gate: Record<string, unknown> }).gate.modified_board, true);
  assert.equal(sent(h), 0);
});

test("with no gate declared the output is unchanged; a declared gate is not run when nothing is to be sent", async () => {
  // The same edit in a checkout with no Git repository at all, and in one whose repository
  // declares an empty gate (which declares none): the same receipt, path for path.
  const plain = await harness();
  const empty = await harness();
  repositoryWith(empty, { "superbee.syncGate": "" });
  const normalized = (h: Harness, text: string) => text.split(h.cwd).join("<cwd>");
  for (const h of [plain, empty]) await editAlpha(h, "Alpha body, ungated.\n");
  const [first, second] = [await attempt(plain), await attempt(empty)];
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(normalized(empty, second.text), normalized(plain, first.text));
  assert.ok(!("gate" in (decode(first.text.trim()) as Record<string, unknown>)));

  // Nothing to send: a declared gate does not run, and the receipt matches the ungated one.
  const state = await stateDir();
  const ran = path.join(state, "ran");
  execFileSync("git", ["-C", empty.cwd, "config", "superbee.syncGate", `touch '${ran}'; exit 1`]);
  const [quietPlain, quietGated] = [await attempt(plain), await attempt(empty)];
  assert.equal(quietGated.error, undefined, quietGated.error?.message);
  assert.equal(normalized(empty, quietGated.text), normalized(plain, quietPlain.text));
  assert.equal(existsSync(ran), false);
});

test("the gate is never sourced from the host: documents that spell a Git config or a gate declare nothing", async () => {
  const host = new FakeHost();
  const state = await stateDir();
  const pwned = path.join(state, "pwned");
  const h = await harness(host);
  // The host serves documents shaped like a repository's config and a gate declaration.
  host.put(".git/config", { type: "Note", title: "config" }, `[superbee]\n\tsyncGate = touch '${pwned}'\n`);
  host.put(".git/HEAD", { type: "Note", title: "head" }, "ref: refs/heads/main\n");
  host.put("notes/gate", { type: "Note", title: "gate", "superbee.syncGate": `touch '${pwned}'`, syncGate: `touch '${pwned}'` }, "syncGate\n");
  await runSync(h);
  await editAlpha(h, "Alpha body, after the host's documents.\n");

  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced");
  assert.ok(!("gate" in receipt), "no gate ran");
  assert.equal(existsSync(pwned), false);
  assert.throws(() => execFileSync("git", ["-C", h.folder, "config", "--get", "superbee.syncGate"], { stdio: "pipe" }));
});

test("a front page edited after the gate judged it is not sent: it waits for the next sync's gate", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  repositoryWith(h, { "superbee.syncGate": "! grep -rq BAD --include=*.md ." });
  const root = path.join(h.folder, "index.md");
  await writeFile(root, `${await readFile(root, "utf8")}\nA judged front page.\n`);
  await editAlpha(h, "Alpha body, sent first.\n");
  // While the documents are being sent, after the gate passed, the front page gains what it rejects.
  h.host.hook = () => {
    writeFileSync(root, "# BAD front page\n");
    h.host.hook = undefined;
    return undefined;
  };
  const { text, error } = await failingSync(h);
  assert.equal(error.exitCode, EXIT.RUNTIME, "a paused row: run sync again");
  const receipt = decode(text.trim()) as { gate: string; rows: { id: string; state: string; reason: string }[] };
  assert.match(receipt.gate, /^passed:/);
  assert.deepEqual(receipt.rows.find((row) => row.id === "index.md"), { ...receipt.rows.find((row) => row.id === "index.md"), state: "paused", reason: "changed_since_gate" });
  assert.equal(h.host.rootCalls.length, 0, "the front page the gate never judged was not sent");
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Alpha body, sent first.\n");

  // The next sync judges it: the gate rejects it, and it is still not sent.
  const next = await failingSync(h);
  assert.equal(next.error.code, "GATE_FAILED");
  assert.equal(h.host.rootCalls.length, 0);
});

test("a Git configuration that cannot be read fails closed: GATE_FAILED, gate_config_unreadable, nothing is sent", async () => {
  const h = await harness();
  repositoryWith(h, { "superbee.syncGate": "exit 1" });
  await writeFile(path.join(h.cwd, ".git", "config"), "[superbee\n\tsyncGate = exit 1\n");
  await editAlpha(h, "Alpha body, unreadable config.\n");
  const { error } = await failingSync(h);
  assert.equal(error.code, "GATE_FAILED");
  assert.equal(error.exitCode, 5);
  const details = error.details as { reason: string; gate: { key: string; exit_status: number } };
  assert.equal(details.reason, "gate_config_unreadable");
  assert.equal(details.gate.key, "superbee.syncGate");
  assert.notEqual(details.gate.exit_status, 1);
  assert.equal(sent(h), 0);
});

test("a gate's writes inside a repository's own .git are not changes to the checkout", async () => {
  const h = await harness();
  // The checkout folder is its own repository root, and the gate refreshes its index.
  execFileSync("git", ["init", "-q", h.folder]);
  execFileSync("git", ["-C", h.folder, "config", "superbee.syncGate", "git add -A && touch .git/gate-ran"]);
  await editAlpha(h, "Alpha body, from a repository root.\n");
  const receipt = await runSync(h);
  assert.equal(receipt.status, "synced");
  assert.ok(existsSync(path.join(h.folder, ".git", "gate-ran")));
});

test("an interrupted sync takes the gate's whole process group down with it", async () => {
  const work = await stateDir();
  const pidFile = path.join(work, "gate.pid");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(work, "interrupted.mjs");
  const gateModule = pathToFileURL(path.join(here, "..", "src", "commands", "sync", "gate.ts")).href;
  await writeFile(
    script,
    `import { runHostedSyncGate } from ${JSON.stringify(gateModule)};\n` +
      `await runHostedSyncGate({ folder: ${JSON.stringify(work)}, origin: "https://hosted.example", bundleId: "b" }, { command: ${JSON.stringify(`echo $$ > '${pidFile}'; exec sleep 30`)}, timeoutSeconds: 60 });\n`,
  );
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(here, "ts-loader.mjs")).href, script], { stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
  const deadline = Date.now() + 20_000;
  while (!existsSync(pidFile) || (await readFile(pidFile, "utf8")).trim() === "") {
    assert.ok(Date.now() < deadline, "the gate started");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const gatePid = Number((await readFile(pidFile, "utf8")).trim());
  child.kill("SIGINT");
  assert.equal(await exited, "SIGINT", "the signal still ends the process");
  const alive = () => {
    try {
      process.kill(gatePid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = Date.now() + 5_000;
  while (alive() && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, "the gate did not outlive the sync");
});
