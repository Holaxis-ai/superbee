// Hosted sync triggers (C4): the automatic pull on reads and its staleness warning, the pull at
// session start, the end-of-turn sync hook and its opt-in, sign-in inside `setup`, and the two
// carry-overs from PR 295's QA (keep/revise need a current inspection; a crash during take leaves
// no temp file behind). Everything runs against the in-process fake host; no request leaves.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { hook } from "../src/commands/hook.js";
import { sessionStart, hostedSessionStartPull } from "../src/commands/session-start.js";
import { setupHosted } from "../src/commands/setup-hosted.js";
import { turnEnd } from "../src/commands/turn-end.js";
import { hostedCheckoutAt, maybeAutoPull, maybeHostedAutoPull } from "../src/autopull.js";
import { defaultHostedAuthDeps, readDefaultHost, sessionAccount, sessionDirFor, withSessionLock, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { resolveHostedTarget } from "../src/hosted-auth/discovery.js";
import { writeUserStateFileAtomic0600 } from "../src/user-state.js";
import { readDefaultWorkspace } from "../src/hosted/defaults.js";
import { readFreshness, recordPulled } from "../src/hosted/freshness.js";
import { digestOf } from "../src/hosted/projection.js";
import { recoverPlacements } from "../src/hosted/sync-scan.js";
import { hostedPull, type HostedSyncDeps } from "../src/hosted/sync.js";
import type { CheckoutBinding } from "../src/hosted/binding.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  binding: CheckoutBinding;
}

const instant = async () => {};

async function harness(host = new FakeHost()): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-trig-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-trig-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  const folder = path.join(cwd, "team");
  const binding = (await hostedCheckoutAt(folder, home))!;
  assert.ok(binding, "the checkout is found by its folder");
  host.requests.length = 0;
  return { home, cwd, folder, auth, host, binding };
}

function syncDeps(h: Harness): Partial<HostedSyncDeps> {
  return { auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant };
}

async function runSync(h: Harness, argv: string[] = []): Promise<Record<string, unknown>> {
  const out: string[] = [];
  await sync(["--dir", h.folder, ...argv], { ...syncDeps(h), stdout: (text: string) => void out.push(text) });
  return decode(out.at(-1)!.trim()) as Record<string, unknown>;
}

async function syncError(h: Harness, argv: string[] = []): Promise<CliError> {
  try {
    await sync(["--dir", h.folder, ...argv], { ...syncDeps(h), stdout: () => {}, lockWaitMs: 200 });
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail("expected sync to fail");
}

const writeRoutes = (h: Harness) => h.host.writes.filter((call) => call.route !== "outcome");
const fileOf = (h: Harness, id: string) => path.join(h.folder, `${id}.md`);

async function hostChangesAlpha(h: Harness, body = "Host alpha.\n"): Promise<string> {
  const before = h.host.docs.get("notes/alpha")!;
  return h.host.put("notes/alpha", before.frontmatter, body);
}

async function conflictOnAlpha(h: Harness): Promise<void> {
  await hostChangesAlpha(h);
  await writeFile(fileOf(h, "notes/alpha"), '---\ntype: "Note"\ntitle: "Alpha"\n---\nLocal alpha.\n');
  const error = await syncError(h);
  assert.equal(error.code, "CONFLICT");
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

// ------------------------------------------------------------------------ automatic pull on reads

test("a checkout starts fresh: a read right after it neither pulls nor warns", async () => {
  const h = await harness();
  assert.ok((await readFreshness(h.home, h.binding.checkout_id)).pulled_at, "checkout records its pull");
  const warnings: string[] = [];
  const outcome = await maybeHostedAutoPull(h.binding, { env: {}, stderr: (t) => void warnings.push(t), sync: syncDeps(h) });
  assert.equal(outcome, "fresh");
  assert.deepEqual(warnings, []);
  assert.equal(h.host.requests.length, 0);
});

test("a read pulls once the last pull is over five minutes old, then is throttled; it never sends", async () => {
  const h = await harness();
  await hostChangesAlpha(h);
  await writeFile(fileOf(h, "notes/beta"), '---\ntype: "Note"\ntitle: "Beta"\n---\nLocal beta edit.\n');
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(6));
  const outcome = await maybeHostedAutoPull(h.binding, { env: {}, stderr: () => {}, sync: syncDeps(h) });
  assert.equal(outcome, "pulled");
  assert.match(await readFile(fileOf(h, "notes/alpha"), "utf8"), /Host alpha\./);
  assert.match(await readFile(fileOf(h, "notes/beta"), "utf8"), /Local beta edit\./, "a local edit is never overwritten");
  assert.deepEqual(writeRoutes(h), [], "an automatic pull sends nothing");
  // The next sync still sends the local edit.
  const receipt = await runSync(h);
  assert.equal((receipt.rows as { id: string; state: string }[]).find((row) => row.id === "notes/beta")?.state, "committed");

});

test("a failed automatic pull backs off for the whole window", async () => {
  const h = await harness();
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(10));
  const offline = await maybeHostedAutoPull(h.binding, {
    env: {},
    stderr: () => {},
    sync: { ...syncDeps(h), fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch },
  });
  assert.equal(offline, "skipped");
  const again = await maybeHostedAutoPull(h.binding, { env: {}, stderr: () => {}, sync: syncDeps(h) });
  assert.equal(again, "throttled");
  assert.equal(h.host.requests.length, 0);
});

test("the automatic pull gives up inside its budget when the host hangs", async () => {
  const h = await harness();
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(6));
  const hanging = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const started = Date.now();
  const outcome = await maybeHostedAutoPull(h.binding, { env: {}, budgetMs: 300, stderr: () => {}, sync: { ...syncDeps(h), fetch: hanging } });
  assert.equal(outcome, "skipped");
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("past thirty minutes a read warns on stderr with the sync command; the opt-out stops the pull, not the warning", async () => {
  const h = await harness();
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(45));
  const warnings: string[] = [];
  const outcome = await maybeHostedAutoPull(h.binding, { env: { SUPERBEE_NO_AUTOPULL: "1" }, stderr: (t) => void warnings.push(t), sync: syncDeps(h) });
  assert.equal(outcome, "disabled");
  assert.equal(h.host.requests.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /was last pulled 45m ago/);
  assert.match(warnings[0]!, /sync --dir /);
});

test("maybeAutoPull routes a read inside a hosted checkout (or a folder below it) to the hosted pull", async () => {
  const h = await harness();
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(6));
  await hostChangesAlpha(h);
  const outcome = await maybeAutoPull(path.join(h.folder, "notes"), { env: {}, hosted: { env: {}, stderr: () => {}, sync: syncDeps(h) } });
  assert.equal(outcome, "pulled");
  assert.match(await readFile(fileOf(h, "notes/alpha"), "utf8"), /Host alpha\./);
});

test("an automatic pull never starts a sign-in", async () => {
  const h = await harness();
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(6));
  const signedOut = { ...h.auth, env: {} };
  const result = await hostedPull(h.binding, { ...syncDeps(h), auth: signedOut });
  assert.deepEqual(result, { state: "signed_out" });
  assert.equal(h.host.requests.length, 0);
});

test("sync records its pull, so a read after it is fresh; push always follows a pull in the same run", async () => {
  const h = await harness();
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(60));
  await writeFile(fileOf(h, "notes/beta"), '---\ntype: "Note"\ntitle: "Beta"\n---\nSent.\n');
  await runSync(h);
  const paths = h.host.requests.map((request) => new URL(request.path, HOST).pathname.split("/").pop());
  assert.ok(paths.indexOf("heads") !== -1 && paths.indexOf("heads") < paths.findIndex((name) => name === "replace" || name === "create"), `order: ${paths.join(",")}`);
  const outcome = await maybeHostedAutoPull(h.binding, { env: {}, stderr: () => {}, sync: syncDeps(h) });
  assert.equal(outcome, "fresh");
});

/** A stored session whose access token has expired and that has no refresh token: signed out. */
async function deadSession(h: Harness): Promise<{ file: string; auth: HostedAuthDeps }> {
  const target = resolveHostedTarget(HOST);
  const dir = sessionDirFor(h.home, sessionAccount(target));
  const record = {
    schema: 1, host: target.origin, audience: target.audience, issuer: "https://issuer.example/", client_id: "cli",
    token_endpoint: "https://issuer.example/oauth/token", credential_store: "file", has_refresh_token: false,
    access_token: TOKEN, access_token_expires_at_ms: 0, subject: { sub: "auth0|person" }, signed_in_at_ms: 0,
  };
  await writeUserStateFileAtomic0600(h.home, dir, "session.json", `${JSON.stringify(record)}\n`);
  const auth = defaultHostedAuthDeps(h.home, {
    env: { SUPERBEE_CREDENTIAL_STORE: "file" },
    fetch: async () => {
      throw new Error("background work must not reach the issuer");
    },
  });
  return { file: path.join(dir, "session.json"), auth };
}

test("B1: a pull on a read with a dead stored session skips with a note, starts no sign-in, and leaves the session alone", async () => {
  const h = await harness();
  const { file, auth } = await deadSession(h);
  const before = await readFile(file, "utf8");
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(6));
  const notes: string[] = [];
  const outcome = await maybeHostedAutoPull(h.binding, { env: {}, stderr: (t) => void notes.push(t), sync: { ...syncDeps(h), auth } });
  assert.equal(outcome, "signed-out");
  assert.match(notes.join(""), /not signed in to https:\/\/hosted\.example, so the automatic pull was skipped/);
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.startsWith("pending")), []);
  assert.equal(h.host.requests.length, 0);
  // The session-start pull is the same.
  const block = await hostedSessionStartPull(h.binding, 2_000, { env: {}, sync: { ...syncDeps(h), auth } });
  assert.equal(block.pull, "signed_out");
  assert.equal(await readFile(file, "utf8"), before);
});

test("B2: a busy sign-in session lock never holds a read past its budget", async () => {
  const h = await harness();
  const { auth } = await deadSession(h);
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(6));
  let release!: () => void;
  const held = withSessionLock(resolveHostedTarget(HOST), auth, () => new Promise<void>((resolve) => (release = resolve)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const notes: string[] = [];
  const started = Date.now();
  const outcome = await maybeHostedAutoPull(h.binding, { env: {}, budgetMs: 400, stderr: (t) => void notes.push(t), sync: { ...syncDeps(h), auth } });
  const took = Date.now() - started;
  release();
  await held;
  assert.equal(outcome, "busy");
  assert.ok(took < 2_000, `took ${took} ms`);
  assert.match(notes.join(""), /another superbee command is using/);
});

// ------------------------------------------------------------------------ session start

test("session-start in a hosted checkout pulls from the host and appends the hosted_checkout block", async () => {
  const h = await harness();
  await hostChangesAlpha(h);
  const block = await hostedSessionStartPull(h.binding, 5_000, { env: {}, sync: syncDeps(h) });
  assert.equal(block.pull, "pulled");
  assert.equal(block.refreshed, 1);
  assert.match(await readFile(fileOf(h, "notes/alpha"), "utf8"), /Host alpha\./);
  assert.equal((await hostedSessionStartPull(h.binding, 5_000, { env: { SUPERBEE_NO_AUTOPULL: "1" }, sync: syncDeps(h) })).pull, "disabled");

  const out: string[] = [];
  await sessionStart(["--dir", h.folder, "--no-update-check"], {
    stdout: (text) => void out.push(text),
    hostedCheckout: async () => h.binding,
    hostedPull: async () => block,
    renderHome: async (_argv, deps) => void deps?.stdout?.("superbee:\n  home: rendered\n"),
  });
  const view = decode(out.join("")) as Record<string, Record<string, unknown>>;
  assert.equal(view.hosted_checkout!.pull, "pulled");
  assert.equal(view.superbee!.home, "rendered");

  const json: string[] = [];
  await sessionStart(["--dir", h.folder, "--json"], {
    stdout: (text) => void json.push(text),
    hostedCheckout: async () => h.binding,
    hostedPull: async () => block,
    renderHome: async (_argv, deps) => void deps?.stdout?.(`${JSON.stringify({ superbee: { home: "rendered" } })}\n`),
  });
  assert.equal(JSON.parse(json.join("")).hosted_checkout.pull, "pulled");
});

// ------------------------------------------------------------------------ end-of-turn sync

async function turnEndOutput(h: Harness, stdin: string | null = "{}", env: Record<string, string> = {}): Promise<string> {
  const out: string[] = [];
  await turnEnd(["--dir", h.folder], { stdout: (t) => void out.push(t), env, readStdin: async () => stdin, syncDeps: syncDeps(h) });
  return out.join("");
}

test("turn-end sends edits silently, and hands a conflict back to the agent once", async () => {
  const h = await harness();
  await writeFile(fileOf(h, "notes/beta"), '---\ntype: "Note"\ntitle: "Beta"\n---\nTurn edit.\n');
  assert.equal(await turnEndOutput(h), "");
  assert.equal(h.host.docs.get("notes/beta")!.body, "Turn edit.\n");

  await hostChangesAlpha(h);
  await writeFile(fileOf(h, "notes/alpha"), '---\ntype: "Note"\ntitle: "Alpha"\n---\nLocal alpha.\n');
  const decision = JSON.parse(await turnEndOutput(h)) as { decision: string; reason: string };
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /sync --inspect <id>/);
  assert.match(decision.reason, /notes\/alpha/);
  assert.match(decision.reason, /Superbee app is for the person/);
  // Already continuing because of this hook: never blocked twice.
  assert.equal(await turnEndOutput(h, JSON.stringify({ stop_hook_active: true })), "");
  // The same unresolved conflict on a later turn is not reported again.
  assert.equal(await turnEndOutput(h), "");
  // A new condition is.
  await writeFile(fileOf(h, "notes/beta"), '---\ntype: "Note"\ntitle: "Beta"\n---\nAnother edit.\n');
  const before = h.host.docs.get("notes/beta")!.version;
  h.host.put("notes/beta", h.host.docs.get("notes/beta")!.frontmatter, "Host beta.\n");
  assert.notEqual(h.host.docs.get("notes/beta")!.version, before);
  const second = JSON.parse(await turnEndOutput(h)) as { reason: string };
  assert.match(second.reason, /notes\/beta/);
  // Opt-out for a shell.
  assert.equal(await turnEndOutput(h, "{}", { SUPERBEE_NO_TURN_SYNC: "1" }), "");
});

test("turn-end does not touch the network when nothing changed and the last pull is recent", async () => {
  const h = await harness();
  assert.equal(await turnEndOutput(h), "");
  assert.equal(h.host.requests.length, 0);
  await recordPulled(h.home, h.binding.checkout_id, minutesAgo(10));
  assert.equal(await turnEndOutput(h), "");
  assert.ok(h.host.requests.length > 0, "a stale copy is synced");
  h.host.requests.length = 0;
  await writeFile(fileOf(h, "notes/beta"), '---\ntype: "Note"\ntitle: "Beta"\n---\nEdited.\n');
  assert.equal(await turnEndOutput(h), "");
  assert.equal(h.host.docs.get("notes/beta")!.body, "Edited.\n");
});

test("turn-end relays the sign-in link when the session is gone", async () => {
  const h = await harness();
  const out: string[] = [];
  await turnEnd(["--dir", h.folder], {
    stdout: (t) => void out.push(t),
    env: {},
    readStdin: async () => null,
    hostedCheckout: async () => h.binding,
    localState: async () => "changed",
    sync: async () => {
      throw new CliError("AUTH_REQUIRED", "sign-in to x is required", { details: { sign_in_url: "https://issuer.example/activate?user_code=ABCD" } });
    },
  });
  const decision = JSON.parse(out.join("")) as { decision: string; reason: string };
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Relay this sign-in link to the person: https:\/\/issuer\.example\/activate\?user_code=ABCD/);
});

test("turn-end does nothing outside a hosted checkout, and never blocks for offline or busy", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "sb-trig-plain-"));
  const home = await mkdtemp(path.join(tmpdir(), "sb-trig-home2-"));
  const out: string[] = [];
  let synced = false;
  await turnEnd(["--dir", plain], {
    stdout: (t) => void out.push(t),
    env: {},
    readStdin: async () => null,
    syncDeps: { auth: defaultHostedAuthDeps(home) },
    sync: async () => void (synced = true),
  });
  assert.equal(synced, false);
  assert.equal(out.join(""), "");

  const h = await harness();
  for (const failure of [new CliError("TRANSIENT", "offline"), new CliError("CONFLICT", "busy", { details: { reason: "sync_busy" } })]) {
    const lines: string[] = [];
    let ran = false;
    await turnEnd(["--dir", h.folder], {
      stdout: (t) => void lines.push(t),
      env: {},
      readStdin: async () => null,
      hostedCheckout: async () => h.binding,
      localState: async () => "changed",
      sync: async () => {
        ran = true;
        throw failure;
      },
    });
    assert.ok(ran);
    assert.equal(lines.join(""), "");
  }
});

test("hook install --turn-end-sync adds the Stop hook (opt-in); uninstall --turn-end-sync removes only it", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "sb-trig-hook-"));
  const program = path.join(base, "packages", "superbee", "dist", "superbee.mjs");
  const settingsOf = async (file: string) => JSON.parse(await readFile(path.join(base, file), "utf8")) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };

  const plain: string[] = [];
  await hook(["install", "--json"], { base, commandBase: program, stdout: (t) => void plain.push(t) });
  assert.equal((await settingsOf(".claude/settings.json")).hooks.Stop, undefined, "plain install never adds the Stop hook");
  assert.equal(JSON.parse(plain.join("")).hook.turn_end_sync.installed, false);

  const out: string[] = [];
  await hook(["install", "--turn-end-sync", "--json"], { base, commandBase: program, stdout: (t) => void out.push(t) });
  assert.equal(JSON.parse(out.join("")).hook.turn_end_sync.installed, true);
  for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
    const settings = await settingsOf(file);
    assert.equal(settings.hooks.Stop!.length, 1);
    assert.equal(settings.hooks.Stop![0]!.hooks[0]!.command, `${program} turn-end`);
    assert.equal(settings.hooks.Stop![0]!.hooks[0]!.timeout, 30);
    assert.equal(settings.hooks.SessionStart!.length, 1);
  }
  // Idempotent, and a plain reinstall keeps the opt-in.
  await hook(["install", "--turn-end-sync"], { base, commandBase: program, stdout: () => {} });
  await hook(["install"], { base, commandBase: program, stdout: () => {} });
  assert.equal((await settingsOf(".claude/settings.json")).hooks.Stop!.length, 1);

  const status: string[] = [];
  await hook(["status", "--json"], { base, commandBase: program, stdout: (t) => void status.push(t) });
  assert.deepEqual(JSON.parse(status.join("")).hook.turn_end_sync, { claude_code: true, codex: true });

  // A foreign Stop hook survives; opting out removes only ours and keeps SessionStart.
  const claude = await settingsOf(".claude/settings.json");
  claude.hooks.Stop!.push({ hooks: [{ command: "echo mine", timeout: 5 }] });
  await writeFile(path.join(base, ".claude/settings.json"), JSON.stringify(claude));
  await hook(["uninstall", "--turn-end-sync"], { base, commandBase: program, stdout: () => {} });
  const after = await settingsOf(".claude/settings.json");
  assert.deepEqual(after.hooks.Stop!.map((group) => group.hooks[0]!.command), ["echo mine"]);
  assert.equal(after.hooks.SessionStart!.length, 1);
  assert.equal((await settingsOf(".codex/hooks.json")).hooks.Stop, undefined);
});

// ------------------------------------------------------------------------ setup hosted

test("setup hosted signs in and chooses the only workspace in one step", async () => {
  const host = new FakeHost();
  const home = await mkdtemp(path.join(tmpdir(), "sb-trig-setup-"));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN } });
  const out: string[] = [];
  await setupHosted(["--url", HOST], { stdout: (t) => void out.push(t), auth, fetch: host.fetch });
  const receipt = (decode(out.join("")) as { setup_hosted: Record<string, unknown> }).setup_hosted;
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.workspace, "tenant-a");
  assert.equal(await readDefaultHost(home), HOST);
  assert.equal(await readDefaultWorkspace(home, HOST), "tenant-a");
});

test("setup hosted with several workspaces asks for a choice, then records it", async () => {
  const host = new FakeHost({ tenants: ["tenant-a", "tenant-b"] });
  const home = await mkdtemp(path.join(tmpdir(), "sb-trig-setup2-"));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN } });
  const out: string[] = [];
  await setupHosted(["--url", HOST], { stdout: (t) => void out.push(t), auth, fetch: host.fetch });
  const choose = (decode(out.join("")) as { setup_hosted: Record<string, unknown> }).setup_hosted;
  assert.equal(choose.status, "choose_workspace");
  assert.equal((choose.help as string[]).length, 2);
  out.length = 0;
  await setupHosted(["--url", HOST, "--workspace", "tenant-b"], { stdout: (t) => void out.push(t), auth, fetch: host.fetch });
  assert.equal(await readDefaultWorkspace(home, HOST), "tenant-b");
  await assert.rejects(
    setupHosted(["--url", HOST, "--workspace", "tenant-z"], { stdout: () => {}, auth, fetch: host.fetch }),
    (error: unknown) => error instanceof CliError && error.code === "NOT_FOUND",
  );
});

test("setup hosted records no default when sign-in cannot complete", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sb-trig-setup3-"));
  const auth = defaultHostedAuthDeps(home, {
    env: {},
    fetch: async () => {
      throw new TypeError("no network in this test");
    },
  });
  await assert.rejects(setupHosted(["--url", HOST], { stdout: () => {}, auth }));
  assert.equal(await readDefaultWorkspace(home, HOST), null);
});

// ------------------------------------------------------------------------ carry-overs from PR 295 QA

test("keep and revise without an inspection are refused (not_inspected); take needs none", async () => {
  const h = await harness();
  await conflictOnAlpha(h);
  h.host.writes.length = 0;
  for (const choice of ["keep", "revise"]) {
    const error = await syncError(h, ["--resolve", choice, "--doc", "notes/alpha"]);
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.details?.reason, "not_inspected");
    assert.match(error.help ?? "", /sync --inspect notes\/alpha/);
  }
  assert.deepEqual(writeRoutes(h), []);
  // After the host moves on past the conflict the person saw, an inspection binds keep to it.
  await runSync(h, ["--inspect", "notes/alpha"]);
  await hostChangesAlpha(h, "Host v3, never inspected.\n");
  const stale = await syncError(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  assert.equal(stale.details?.reason, "stale_review");
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Host v3, never inspected.\n");
});

test("recovery drops a take's moved-aside local bytes once the host's bytes are in place", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "sb-trig-recover-"));
  await mkdir(path.join(folder, "notes"));
  const local = Buffer.from("---\ntype: Note\n---\nDiscarded local edit.\n");
  const hostBytes = Buffer.from("---\ntype: Note\n---\nHost version.\n");
  const temp = path.join(folder, "notes", ".alpha.md.superbee-pre-0a1b2c3d4e5f.tmp");

  // Without a recorded decision, bytes that match nothing are kept (never deleted).
  await writeFile(path.join(folder, "notes", "alpha.md"), hostBytes);
  await writeFile(temp, local);
  const undecided = { files: { "notes/alpha": { digest: "sha256:other", version: "v1" } }, root: null };
  await recoverPlacements(folder, undecided);
  assert.deepEqual(await readdir(path.join(folder, "notes")), [".alpha.md.superbee-pre-0a1b2c3d4e5f.tmp", "alpha.md"].sort());

  // With the take recorded before the replacement, the leftover is dropped and the record cleared.
  const decided: Parameters<typeof recoverPlacements>[1] = { ...undecided, discarded: { "notes/alpha": digestOf(local) } };
  await recoverPlacements(folder, decided);
  assert.deepEqual(await readdir(path.join(folder, "notes")), ["alpha.md"]);
  assert.equal(await readFile(path.join(folder, "notes", "alpha.md"), "utf8"), hostBytes.toString());
  assert.equal(decided.discarded, undefined);

  // A crash before the host's bytes landed restores the local file: the conflict still stands.
  await writeFile(temp, local);
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(folder, "notes", "alpha.md"));
  await recoverPlacements(folder, { ...undecided, discarded: { "notes/alpha": digestOf(local) } });
  assert.equal(await readFile(path.join(folder, "notes", "alpha.md"), "utf8"), local.toString());
});
