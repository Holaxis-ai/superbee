// The multi-backend rehearsal (designs/seamless-multi-backend-cli, section 7): one agent, in one
// session opened in a project, reads, edits, searches, links and syncs across a Git board (the
// project's `.superbee`), a local bundle and a hosted checkout, with the same commands (only the
// folder differs) and the same MCP tools. Every command runs the BUILT CLI from the project root.
//
// `STEPS` is this surface's per-row agreement table (CONTRIBUTING.md): one row per step and
// surface (the CLI, or the MCP app), run once per home. A CLI step is one argv template in which
// only the folder varies, so "the same commands" is structural; an MCP step is one tool call in
// which only the workspace varies.
//
// The hosted checkout talks to the golden-pinned `FakeHost` through a loopback bridge. The
// deny-network preload admits only the bridge's port and logs every connection, so a local or Git
// step is checked to make none at all, and a hosted step to reach only the fake.
//
// `KNOWN_GAPS` names each (step, surface, home) cell that does not hold yet, the design slice that
// owns it, and exactly how it fails today. Every row is checked to still fail in exactly that way,
// so an unrelated regression is not absorbed; a fixing PR deletes its rows. The table only shrinks:
// when it is empty, the scenario is enforced end to end.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readDocVersioned } from "@superbee/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensureUserStateRoot, userStateDir } from "../src/user-state.js";
import { startFakeHostBridge, type FakeHostBridge } from "./support/fake-host-bridge.js";
import { BUNDLE, FakeHost } from "./support/fake-hosted-sync.js";
import { seedHostedSession } from "./support/hosted-session.js";
import { isolatedUserEnv } from "./support/user-env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "../../superbee");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");
const preload = path.join(here, "fixtures", "deny-network.mjs");
const DEBUG = process.env.SUPERBEE_REHEARSAL_DEBUG === "1";

const HOMES = ["git", "local", "hosted"] as const;
type Home = (typeof HOMES)[number];
type Surface = "cli" | "mcp";

/** The slices of designs/seamless-multi-backend-cli section 8 a gap row may name. */
const SLICES: ReadonlySet<string> = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "G1", "G2", "G3"]);

/**
 * How a cell fails: a refusal (error code and `details.reason`); items the step expected and did
 * not find (receipt keys, catalog rows, documents the host should have received); or an invariant
 * the cell broke.
 */
type Failure =
  | { readonly code: string; readonly reason: string }
  | { readonly missing: readonly string[] }
  | { readonly invariant: string; readonly detail: string };

/** A second hosted bundle the person can reach and has not checked out (S3's listing row). */
const UNCHECKED = "team.archive";
/** The receipt keys a `sync --json` answer carries in every home once S4 lands. */
const SYNC_ENVELOPE = ["home", "sent", "received", "conflicts", "held", "next"] as const;

/**
 * Keyed `<step>/<surface>/<home>`. Only ever shrinks; a PR that makes a cell hold deletes its row.
 */
const KNOWN_GAPS: Readonly<Record<string, { readonly slice: string; readonly failure: Failure }>> = {
  // S1: `list_workspaces` does not say which home each workspace is.
  "discover/mcp/git": { slice: "S1", failure: { missing: ["home"] } },
  "discover/mcp/local": { slice: "S1", failure: { missing: ["home"] } },
  "discover/mcp/hosted": { slice: "S1", failure: { missing: ["home"] } },
  // S3: plain `catalog list` shows folders only.
  "discover-remote/cli/hosted": { slice: "S3", failure: { missing: [UNCHECKED] } },
  // S1: `superbee mcp` refuses to start with the cwd in a checkout, and every MCP write there.
  "start/mcp/hosted": { slice: "S1", failure: { code: "FORBIDDEN", reason: "not_syncable" } },
  "edit/mcp/hosted": { slice: "S1", failure: { invariant: "finish_view_action", detail: "failed: the trusted action could not be committed" } },
  // S4: `sync --json` has a different shape in each home.
  "sync/cli/git": { slice: "S4", failure: { missing: [...SYNC_ENVELOPE] } },
  "sync/cli/local": { slice: "S4", failure: { missing: [...SYNC_ENVELOPE] } },
  "sync/cli/hosted": { slice: "S4", failure: { missing: [...SYNC_ENVELOPE] } },
  // S2: the Stop hook syncs only the cwd bundle, so a checkout edited with --dir stays unsent.
  "turn-end/cli/hosted": { slice: "S2", failure: { missing: ["notes/beta"] } },
};

// ---------------------------------------------------------------------------------------------
// Harness

interface Rehearsal {
  root: string;
  home: string;
  project: string;
  /** Each home's folder, as the agent names it with `--dir` from the project root. */
  dirs: Record<Home, string>;
  /** Each home's catalog label, as the agent names it to an MCP tool. */
  labels: Record<Home, string>;
  origin: string;
  host: FakeHost;
  bridge: FakeHostBridge;
  env: NodeJS.ProcessEnv;
  log: string;
  /** Documents edited in the hosted checkout, through the folder or MCP; the host must receive each. */
  hostedEdits: Set<string>;
  /** Every CLI and MCP output of the run, for the sign-in invariant. */
  transcript: string[];
}

type NetworkLine = { api: string; target: string; allowed?: boolean };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** The network log lines this command wrote. */
  network: NetworkLine[];
}

let r: Rehearsal;

before(async () => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
  r = await setUp();
});

after(async () => {
  await r?.bridge.close();
  if (r && !DEBUG) await rm(r.root, { recursive: true, force: true });
});

async function networkLines(): Promise<NetworkLine[]> {
  try {
    return (await readFile(r.log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as NetworkLine);
  } catch {
    return [];
  }
}

async function cli(args: string[], cwd: string = r.project): Promise<Run> {
  const seen = (await networkLines()).length;
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("node", [cliBin, ...args], { cwd, env: r.env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
  const network = (await networkLines()).slice(seen);
  r.transcript.push(result.stdout, result.stderr);
  if (DEBUG) console.log(`# ${args.join(" ")} -> ${result.code}\n${result.stdout}${result.stderr}`);
  return { ...result, network };
}

async function ok(args: string[], cwd?: string): Promise<Run> {
  const run = await cli(args, cwd);
  assert.equal(run.code, 0, `${args.join(" ")} (exit ${run.code}): ${run.stdout}${run.stderr}`);
  return run;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...r.env, NODE_OPTIONS: "" }, encoding: "utf8", stdio: "pipe" });
}

const folder = (home: Home): string => path.resolve(r.project, r.dirs[home]);

/** The Kind every home declares for its Notes: MCP View actions need a declared Kind. */
const NOTE_KIND = { type: "Convention", title: "Note", governs: "Note", fields: { required: ["title"], optional: ["tags", "owner"] } };
const NOTE_KIND_FILE = "---\ntype: Convention\ntitle: Note\ngoverns: Note\nfields:\n  required:\n    - title\n  optional:\n    - tags\n    - owner\n---\n";

async function setUp(): Promise<Rehearsal> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sb-rehearsal-")));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");
  let host: FakeHost | undefined;
  const bridge = await startFakeHostBridge(() => host!);
  host = new FakeHost({ origin: bridge.url, bundles: [BUNDLE, UNCHECKED] });
  host.put("conventions/note", NOTE_KIND, "");
  host.put("notes/remote-seed", { type: "Note", title: "Seed" }, "Seed.\n");
  const log = path.join(root, "network.log");
  const env = isolatedUserEnv(home, {
    SUPERBEE_TEST_NETWORK_LOG: log,
    SUPERBEE_TEST_NETWORK_ALLOW: `127.0.0.1:${bridge.port}`,
    SUPERBEE_NO_UPDATE_CHECK: "1",
    SUPERBEE_CREDENTIAL_STORE: "file",
    SUPERBEE_ACTOR: "process:rehearsal",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  });
  for (const key of Object.keys(env)) {
    if (key === "AGENTSTATE_LITE_REMOTE" || key === "SUPERBEE_ACCESS_TOKEN" || key.startsWith("SUPERBEE_HOST") || key.endsWith("NO_AUTOPULL") || key.endsWith("NO_TURN_SYNC")) delete env[key];
  }
  const project = path.join(root, "project");
  const origin = path.join(root, "origin.git");
  r = {
    root, home, project, origin, host, bridge, env, log,
    dirs: { git: ".superbee", local: path.join(root, "personal"), hosted: path.join(root, "team") },
    labels: { git: "board", local: "personal", hosted: BUNDLE },
    hostedEdits: new Set(),
    transcript: [],
  };

  // A hosted session, as sign-in leaves it: an unexpired access token for the bridge's audience.
  await ensureUserStateRoot(home);
  await seedHostedSession(home, { host: bridge.url, accessToken: host.token, expiresAtMs: Date.now() + 24 * 60 * 60 * 1000 });

  // The Git board: the project's `.superbee`, shared through a local bare origin.
  execFileSync("git", ["init", "-q", "--bare", origin], { env: { ...env, NODE_OPTIONS: "" } });
  await mkdir(project);
  git(project, "init", "-q");
  git(project, "remote", "add", "origin", origin);
  git(project, "commit", "-q", "--allow-empty", "-m", "init");
  git(project, "push", "-q", "origin", "HEAD:main");
  await ok(["init", "--dir", ".superbee", "--recipe", "none"]);
  await ok(["sync", "--establish"]);
  await ok(["catalog", "add", r.labels.git, "--dir", ".superbee"]);

  // The local bundle.
  await ok(["init", "--dir", r.dirs.local, "--recipe", "none"]);
  await ok(["catalog", "add", r.labels.local, "--dir", r.dirs.local]);

  // The Git board and the local bundle hold what the hosted bundle serves: the Note Kind and the
  // same two Notes.
  for (const home of ["git", "local"] as const) {
    await mkdir(path.join(folder(home), "conventions"), { recursive: true });
    await writeFile(path.join(folder(home), "conventions", "note.md"), NOTE_KIND_FILE);
    await ok(["doc", "write", "notes/alpha", "--type", "Note", "--title", "Alpha", "--body", "Alpha.", "--dir", r.dirs[home]]);
    await ok(["doc", "write", "notes/beta", "--type", "Note", "--title", "Beta", "--body", "Beta.", "--dir", r.dirs[home]]);
  }
  await ok(["sync"]);

  // The hosted checkout, which catalogs itself.
  await ok(["checkout", BUNDLE, "--host", bridge.url, "--dir", r.dirs.hosted]);
  host.requests.length = 0;
  return r;
}

/** Make every freshness record in private state (the checkouts' and the Git board's) an hour old. */
async function ageFreshness(): Promise<void> {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".json")) {
        const text = await readFile(file, "utf8");
        const aged = text.replace(/"(pulled_at|attempt_at|updatedAt|autoPullAttemptAt)"(\s*):(\s*)"[^"]+"/g, `"$1"$2:$3"${past}"`);
        if (aged !== text) await writeFile(file, aged);
      }
    }
  };
  await walk(userStateDir(r.home));
}

// ---------------------------------------------------------------------------------------------
// MCP

interface Mcp {
  client: Client;
  stderr: () => string;
}

let catalogMcp: Mcp | undefined;

/** `superbee mcp` over stdio in `cwd`, as a host starts it; throws the server's error envelope when it refuses to start. */
async function startMcp(cwd: string): Promise<Mcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliBin, "mcp"], cwd, env: r.env as Record<string, string>, stderr: "pipe" });
  let err = "";
  transport.stderr?.on("data", (chunk: Buffer) => void (err += chunk.toString("utf8")));
  const client = new Client({ name: "rehearsal", version: "test" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    // Let the exited process's stderr drain.
    await new Promise((resolve) => setTimeout(resolve, 100));
    r.transcript.push(err);
    throw Object.assign(new Error(`mcp did not start: ${String(error)}`), { stderr: err });
  }
  return { client, stderr: () => err };
}

async function mcp(): Promise<Mcp> {
  catalogMcp ??= await startMcp(r.project);
  return catalogMcp;
}

after(async () => {
  await catalogMcp?.client.close();
});

async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: unknown; content: unknown }> {
  const result = (await (await mcp()).client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content: unknown };
  r.transcript.push(JSON.stringify(result));
  return result;
}

/** A CLI error envelope's code and reason, from JSON or TOON output. */
function refusalOf(text: string): { code: string; reason: string } | null {
  const code = /"?code"?\s*[:=]\s*"?([A-Z_]+)"?/.exec(text)?.[1];
  const reason = /"?reason"?\s*[:=]\s*"?([a-z_]+)"?/.exec(text)?.[1];
  return code ? { code, reason: reason ?? "" } : null;
}

/** Update a Note's title through a transient View action, confirmed through the trusted tools. */
async function mcpSetTitle(home: Home, id: string, title: string): Promise<Failure | null> {
  const launched = await callTool("show_view", { workspace: r.labels[home], mode: "transient", title: "Rehearsal editor", html: "<!doctype html><title>Rehearsal editor</title>", access: "bundle-propose" });
  if (launched.isError) return { invariant: "show_view", detail: JSON.stringify(launched.content) };
  const launchId = (launched.structuredContent as { launch: { launchId: string } }).launch.launchId;
  await callTool("authorize_durable_view", { launchId });
  const target = await readDocVersioned({ root: folder(home) }, id);
  const prepared = await callTool("prepare_view_action", {
    launchId,
    requestId: `rehearsal-${home}-${id}`,
    action: { kind: "document.set-field", docId: id, field: "title", value: title, expectedVersion: target.version },
  });
  const result = (prepared.structuredContent as { result?: { status: string; approvalToken?: string; message?: string } } | undefined)?.result;
  if (result?.status !== "prepared") return { invariant: "prepare_view_action", detail: JSON.stringify(prepared.structuredContent ?? prepared.content) };
  const finished = await callTool("finish_view_action", { launchId, approvalToken: result.approvalToken, decision: "commit" });
  const outcome = (finished.structuredContent as { result?: { status: string; message?: string } } | undefined)?.result;
  if (outcome?.status === "committed") return null;
  return { invariant: "finish_view_action", detail: outcome ? `${outcome.status}: ${outcome.message ?? ""}` : JSON.stringify(finished.content) };
}

// ---------------------------------------------------------------------------------------------
// The step table

interface Cell {
  /** Null when the cell holds. */
  readonly failure: Failure | null;
  /** What the cell printed, for the mechanical local/Git check. */
  readonly output: string;
  /** Network log lines the cell wrote. */
  readonly network: readonly NetworkLine[];
}

interface Step {
  readonly name: string;
  readonly surface: Surface;
  readonly homes: readonly Home[];
  /** `discover` and `start` name `checkout` for bundles with no folder and may reach the host (section 7). */
  readonly exempt?: true;
  run(home: Home): Promise<Cell>;
}

function missingKeys(value: unknown, keys: readonly string[]): Failure | null {
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const missing = keys.filter((key) => !(key in record));
  return missing.length === 0 ? null : { missing };
}

/** A CLI cell: the command must exit 0 (else its refusal is the failure), then `check` its JSON. */
async function cliCell(args: string[], check: (json: unknown, run: Run) => Failure | null | Promise<Failure | null> = () => null): Promise<Cell> {
  const run = await cli(args);
  const output = run.stdout + run.stderr;
  if (run.code !== 0) return { failure: refusalOf(output) ?? { invariant: "exit", detail: `${run.code}: ${output.slice(0, 400)}` }, output, network: run.network };
  let json: unknown = null;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    // Not every step asks for JSON.
  }
  return { failure: await check(json, run), output, network: run.network };
}

/** An MCP cell, with the network lines the MCP server wrote meanwhile. */
async function mcpCell(action: () => Promise<Failure | null>, output: () => string = () => ""): Promise<Cell> {
  const seen = (await networkLines()).length;
  const failure = await action();
  return { failure, output: output(), network: (await networkLines()).slice(seen) };
}

let catalogListing: Promise<Run> | undefined;
const listing = () => (catalogListing ??= cli(["catalog", "list", "--json"]));
let workspaceListing: Promise<unknown> | undefined;
let sessionStart: Promise<Run> | undefined;
let teammateReady = false;

async function teammate(): Promise<string> {
  const dir = path.join(r.root, "teammate");
  if (!teammateReady) {
    execFileSync("git", ["clone", "-q", r.origin, dir], { env: { ...r.env, NODE_OPTIONS: "" } });
    await ok(["sync"], dir);
    teammateReady = true;
  }
  return dir;
}

const STEPS: readonly Step[] = [
  {
    name: "discover",
    surface: "cli",
    homes: HOMES,
    exempt: true,
    async run(home) {
      const run = await listing();
      const entries = (JSON.parse(run.stdout) as { entries: { label: string; home: string }[] }).entries;
      const entry = entries.find((row) => row.label === r.labels[home]);
      return { failure: entry?.home === home ? null : { missing: [r.labels[home]] }, output: run.stdout, network: run.network };
    },
  },
  {
    name: "discover",
    surface: "mcp",
    homes: HOMES,
    exempt: true,
    run: (home) =>
      mcpCell(async () => {
        const listed = (await (workspaceListing ??= callTool("list_workspaces", {}).then((result) => result.structuredContent))) as { workspaces: { label: string; home?: string }[] };
        const entry = listed.workspaces.find((row) => row.label === r.labels[home]);
        if (!entry) return { missing: [r.labels[home]] };
        return entry.home === home ? null : { missing: ["home"] };
      }),
  },
  {
    name: "discover-remote",
    surface: "cli",
    homes: ["hosted"],
    exempt: true,
    async run() {
      const run = await listing();
      const entries = (JSON.parse(run.stdout) as { entries: { label: string; folder?: unknown }[] }).entries;
      const row = entries.find((entry) => entry.label === UNCHECKED && entry.folder === null);
      return { failure: row ? null : { missing: [UNCHECKED] }, output: run.stdout, network: run.network };
    },
  },
  {
    name: "start",
    surface: "cli",
    homes: HOMES,
    exempt: true,
    async run(home) {
      const run = await (sessionStart ??= cli(["session-start", "--json"]));
      const started = JSON.parse(run.stdout) as { bundle: { home: string }; board?: string; workspaces: { entries: { label: string; home: string; freshness: string }[] } };
      if (home === "git") {
        // The cwd board: pulled at session start.
        return { failure: started.bundle.home === "git" && started.board === "up to date" ? null : { invariant: "cwd board pulled", detail: run.stdout }, output: run.stdout, network: run.network };
      }
      const entry = started.workspaces.entries.find((row) => row.label === r.labels[home]);
      return { failure: entry?.home === home && typeof entry.freshness === "string" ? null : { missing: [r.labels[home]] }, output: run.stdout, network: run.network };
    },
  },
  {
    name: "start",
    surface: "mcp",
    homes: HOMES,
    async run(home) {
      try {
        const started = await startMcp(folder(home));
        const tools = await started.client.listTools();
        await started.client.close();
        return { failure: tools.tools.some((tool) => tool.name === "list_workspaces") ? null : { missing: ["list_workspaces"] }, output: "", network: [] };
      } catch (error) {
        // A refusal is written before the MCP transport starts; run the same command bare to read it.
        const refused = await new Promise<string>((resolve) => {
          execFile("node", [cliBin, "mcp"], { cwd: folder(home), env: r.env, encoding: "utf8", timeout: 20_000 }, (_error, stdout, stderr) => resolve(stdout + stderr));
        });
        r.transcript.push(refused);
        return { failure: refusalOf(refused) ?? { invariant: "start", detail: `${String(error)} ${(error as { stderr?: string }).stderr ?? ""}` }, output: refused, network: [] };
      }
    },
  },
  {
    name: "read",
    surface: "cli",
    homes: HOMES,
    run: (home) => cliCell(["doc", "read", "notes/alpha", "--dir", r.dirs[home], "--json"], (json) => missingKeys(json, ["id", "type", "title", "head_version", "body"])),
  },
  {
    name: "read",
    surface: "mcp",
    homes: HOMES,
    run: (home) =>
      mcpCell(async () => {
        const shown = await callTool("show_document", { workspace: r.labels[home], docId: "notes/alpha" });
        return shown.isError ? { invariant: "show_document", detail: JSON.stringify(shown.content) } : null;
      }),
  },
  {
    name: "edit",
    surface: "cli",
    homes: HOMES,
    async run(home) {
      const cell = await cliCell(["doc", "update", "notes/alpha", "--title", `Alpha, edited in ${home}`, "--dir", r.dirs[home], "--json"], (json) => missingKeys(json, ["doc", "id", "version"]));
      if (home === "hosted" && cell.failure === null) r.hostedEdits.add("notes/alpha");
      return cell;
    },
  },
  {
    name: "edit",
    surface: "mcp",
    homes: HOMES,
    async run(home) {
      const cell = await mcpCell(() => mcpSetTitle(home, "notes/beta", `Beta, edited through MCP in ${home}`));
      if (home === "hosted" && cell.failure === null) r.hostedEdits.add("notes/beta");
      return cell;
    },
  },
  {
    name: "search",
    surface: "cli",
    homes: HOMES,
    run: (home) =>
      cliCell(["list", "--type", "Note", "--dir", r.dirs[home], "--json"], (json) => {
        const docs = (json as { docs?: unknown[] } | null)?.docs ?? [];
        if (docs.length < 2) return { missing: ["notes/alpha", "notes/beta"] };
        return missingKeys(docs[0], ["id", "title"]);
      }),
  },
  {
    name: "link",
    surface: "cli",
    homes: HOMES,
    async run(home) {
      const added = await cli(["link", "add", "notes/alpha", "notes/beta", "--dir", r.dirs[home]]);
      if (added.code !== 0) return { failure: refusalOf(added.stdout + added.stderr) ?? { invariant: "exit", detail: added.stdout + added.stderr }, output: added.stdout + added.stderr, network: added.network };
      if (home === "hosted") r.hostedEdits.add("notes/alpha");
      const cell = await cliCell(["link", "show", "notes/alpha", "--dir", r.dirs[home], "--json"], (json) => {
        const outbound = (json as { outbound?: { to: string }[] } | null)?.outbound ?? [];
        return missingKeys(json, ["id", "outbound", "backlinks"]) ?? (outbound.some((edge) => edge.to === "notes/beta") ? null : { missing: ["notes/beta"] });
      });
      return { ...cell, output: added.stdout + added.stderr + cell.output, network: [...added.network, ...cell.network] };
    },
  },
  {
    name: "remote-change",
    surface: "cli",
    homes: ["git", "hosted"],
    async run(home) {
      // Someone else adds a document; after the stale window the next read pulls it.
      if (home === "git") {
        const mate = await teammate();
        await ok(["doc", "write", "notes/remote", "--type", "Note", "--title", "From a teammate", "--body", "Remote."], mate);
        await ok(["sync"], mate);
      } else {
        r.host.put("notes/remote", { type: "Note", title: "From the app" }, "Remote.\n");
      }
      await ageFreshness();
      return cliCell(["doc", "read", "notes/remote", "--dir", r.dirs[home], "--json"], (json) => missingKeys(json, ["id", "title"]));
    },
  },
  {
    name: "conflict",
    surface: "cli",
    homes: ["git", "hosted"],
    async run(home) {
      // The agent's unsent edit of notes/alpha (the edit step) meets someone else's change to it.
      if (home === "git") {
        const mate = await teammate();
        await ok(["sync"], mate);
        await ok(["doc", "update", "notes/alpha", "--body", "Teammate's alpha."], mate);
        await ok(["sync"], mate);
      } else {
        r.host.put("notes/alpha", { type: "Note", title: "Alpha from the app" }, "App's alpha.\n");
      }
      const collided = await cli(["sync", "--dir", r.dirs[home]]);
      const output: string[] = [collided.stdout, collided.stderr];
      const network = [...collided.network];
      if (collided.code !== 5) return { failure: { invariant: "sync reports the conflict (exit 5)", detail: `${collided.code}: ${output.join("")}`.slice(0, 400) }, output: output.join(""), network };
      // The starting state differs by home (L6, decided in D5): a Git board keeps the teammate's
      // version in the file and saves the agent's aside; a hosted checkout keeps the agent's file.
      const file = await readFile(path.join(folder(home), "notes", "alpha.md"), "utf8");
      const kept = home === "git" ? /Teammate's alpha\./.test(file) : /Alpha, edited in hosted/.test(file);
      if (!kept) return { failure: { invariant: "per-home starting state", detail: file }, output: output.join(""), network };
      for (const args of [
        ["sync", "--inspect", "--doc", "notes/alpha", "--dir", r.dirs[home], "--json"],
        ["sync", "--resolve", "keep", "--doc", "notes/alpha", "--dir", r.dirs[home]],
      ]) {
        const run = await cli(args);
        output.push(run.stdout, run.stderr);
        network.push(...run.network);
        if (run.code !== 0) return { failure: refusalOf(run.stdout + run.stderr) ?? { invariant: args[1]!, detail: run.stdout + run.stderr }, output: output.join(""), network };
      }
      return { failure: null, output: output.join(""), network };
    },
  },
  {
    name: "sync",
    surface: "cli",
    homes: HOMES,
    run: (home) => cliCell(["sync", "--dir", r.dirs[home], "--json"], (json) => missingKeys(json, SYNC_ENVELOPE)),
  },
  {
    name: "turn-end",
    surface: "cli",
    homes: ["git", "hosted"],
    async run(home) {
      // The agent edits notes/beta in this home with --dir and stops; the Stop hook runs from the
      // project root. The hosted edit is older than the hook's quiet period.
      await ok(["doc", "update", "notes/beta", "--title", `Beta at turn end in ${home}`, "--dir", r.dirs[home]]);
      if (home === "hosted") {
        r.hostedEdits.add("notes/beta");
        const past = new Date(Date.now() - 60_000);
        await utimes(path.join(folder(home), "notes", "beta.md"), past, past);
      }
      const run = await cli(["turn-end", "--git-boards"]);
      const output = run.stdout + run.stderr;
      if (run.code !== 0) return { failure: { invariant: "exit", detail: output }, output, network: run.network };
      const sent = home === "git"
        ? /Beta at turn end in git/.test(git(r.project, "--git-dir", r.origin, "show", "board:notes/beta.md"))
        : r.host.docs.get("notes/beta")?.frontmatter.title === "Beta at turn end in hosted";
      return { failure: sent ? null : { missing: ["notes/beta"] }, output, network: run.network };
    },
  },
];

const cellKey = (step: Step, home: Home) => `${step.name}/${step.surface}/${home}`;

// ---------------------------------------------------------------------------------------------
// Tests

test("the deny-network allowlist admits only the fake's loopback port, logs it, and takes only loopback entries", async () => {
  const probe = (env: NodeJS.ProcessEnv) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      const script = [
        `const allowed = await fetch(${JSON.stringify(`${r.bridge.url}/sync/v1/whoami`)}, { method: "POST", body: "{}" }).then((res) => res.status, (e) => String(e));`,
        "const other = await fetch('http://127.0.0.1:9/', { method: 'POST' }).then((res) => res.status, (e) => 'refused');",
        "console.error(JSON.stringify({ allowed, other }));",
      ].join("\n");
      execFile("node", ["--input-type=module", "-e", script], { env, encoding: "utf8" }, (error, _stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stderr }));
    });
  const seen = (await networkLines()).length;
  const answered = await probe(r.env);
  assert.deepEqual(JSON.parse(answered.stderr.trim().split("\n").at(-1)!), { allowed: 401, other: "refused" });
  const lines = (await networkLines()).slice(seen);
  assert.deepEqual(lines.map((line) => [line.target, line.allowed ?? false]), [[`${r.bridge.url}/sync/v1/whoami`, true], ["http://127.0.0.1:9/", false]]);
  const widened = await probe({ ...r.env, SUPERBEE_TEST_NETWORK_ALLOW: "example.com:443" });
  assert.notEqual(widened.code, 0);
  assert.match(widened.stderr, /only loopback endpoints may be allowed/);
});

test("every known gap is a cell of the step table and names a design slice", () => {
  const cells = new Set(STEPS.flatMap((step) => step.homes.map((home) => cellKey(step, home))));
  for (const [key, gap] of Object.entries(KNOWN_GAPS)) {
    assert.ok(cells.has(key), `KNOWN_GAPS row ${key} is not a cell of the step table`);
    assert.ok(SLICES.has(gap.slice), `KNOWN_GAPS row ${key} names ${gap.slice}, which is not a slice of the design`);
  }
});

test("one session across a Git board, a local bundle and a hosted checkout: same commands, same tools", async () => {
  const problems: string[] = [];
  for (const step of STEPS) {
    for (const home of step.homes) {
      const key = cellKey(step, home);
      const cell = await step.run(home);
      const gap = KNOWN_GAPS[key];
      if (gap) {
        // A known gap must still fail in exactly its pinned way; anything else is a regression, or
        // a fix that must delete the row.
        if (JSON.stringify(cell.failure) !== JSON.stringify(gap.failure)) {
          problems.push(`${key}: pinned as ${JSON.stringify(gap.failure)} (${gap.slice}), now ${JSON.stringify(cell.failure)}${cell.failure === null ? ": it holds, so delete its KNOWN_GAPS row" : ""}`);
        }
      } else if (cell.failure !== null) {
        problems.push(`${key}: ${JSON.stringify(cell.failure)}`);
      }
      // Invariant 3: local and Git make no connection at all; a hosted step reaches only the fake.
      if (!step.exempt) {
        if (home !== "hosted" && cell.network.length > 0) problems.push(`${key}: network in a ${home} bundle: ${JSON.stringify(cell.network)}`);
        const refused = cell.network.filter((line) => !line.allowed);
        if (refused.length > 0) problems.push(`${key}: refused network: ${JSON.stringify(refused)}`);
      }
      // Invariant 1: nothing hosted-specific is said in a local or Git bundle.
      if (!step.exempt && home !== "hosted") {
        const said = /do_this_in|--host\b|setup hosted|\bcheckout\b/.exec(cell.output);
        if (said) problems.push(`${key}: hosted-specific output in a ${home} bundle: '${said[0]}'`);
      }
    }
  }
  assert.deepEqual(problems, []);

  // Invariant 5: every document edited in the checkout, through the folder or through MCP, reached
  // the host, and nothing else did (the fake applies each write identity once).
  await ok(["sync", "--dir", r.dirs.hosted]);
  const applied = new Set(r.host.applied);
  const expected = new Set(r.hostedEdits);
  assert.deepEqual([...applied].sort(), [...expected].sort());

  // Invariant 4: the seeded session carried the whole run: no sign-in was asked for.
  assert.doesNotMatch(r.transcript.join("\n"), /AUTH_REQUIRED/);
});
