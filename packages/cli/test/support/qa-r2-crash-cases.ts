// Shared by the qa-r2-crash-*.test.ts files, which each register a subset of these cases so the
// suite's slowest sweeps run in parallel test processes (and CI shards) instead of one serial file.
// Adversarial QA round 2 (18466ef1): the adopted sweep plus a window case. Adversarial QA for PR 297 (head 2163424d): SIGKILL just before every side effect of the delete
// and re-create paths (a scan-journaled delete, keep and take on a deletion in conflict, the
// checkout's own re-create after its delete, and keep on "deleted remotely"), then recover and
// check the outcome matches the decision: one tombstone, no duplicate create, nothing lost.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, realpath, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode } from "@toon-format/toon";

import { CliError } from "../../src/errors.js";
import { checkout } from "../../src/commands/checkout.js";
import { sync } from "../../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./fake-hosted-sync.js";

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let current: FakeHost;
async function bridge(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers.set(k, v);
      try {
        const response = await current.fetch(`${HOST}${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks).toString("utf8") });
        const out: Record<string, string> = {};
        response.headers.forEach((v, k) => (out[k] = v));
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.socket?.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

interface S {
  host: FakeHost;
  home: string;
  cwd: string;
  folder: string;
  auth: HostedAuthDeps;
  /** The tombstone a re-create is expected to acknowledge, when the case has one. */
  tombstone?: string;
}

async function run(s: S, argv: string[] = []) {
  const out: string[] = [];
  try {
    await sync(["--dir", s.folder, ...argv], { stdout: (t: string) => void out.push(t), auth: s.auth, cwd: s.cwd, fetch: s.host.fetch, write: { sleep: async () => {}, lookupDelayMs: 0 }, sleep: async () => {}, lockWaitMs: 500 });
    return { ok: true as const, receipt: decode(out.at(-1)!.trim()) as Record<string, unknown>, error: null };
  } catch (error) {
    if (error instanceof CliError && error.details?.reason === "lock_orphaned" && typeof error.details.lock === "string") {
      await rm(error.details.lock, { recursive: true, force: true });
      return run(s, argv);
    }
    // Right after the kill, an owner-less lock reads as a claim in progress (busy) for the claim
    // grace. Let that time pass by aging the lock; the next run then reports it orphaned, as above.
    if (error instanceof CliError && error.details?.reason === "sync_busy" && typeof error.details.lock === "string" && !(await stat(path.join(error.details.lock, "owner.json")).catch(() => null))) {
      const past = new Date(Date.now() - 60_000);
      if (await utimes(error.details.lock, past, past).then(() => true, () => false)) return run(s, argv);
    }
    return { ok: false as const, receipt: out.length ? (decode(out.at(-1)!.trim()) as Record<string, unknown>) : null, error: error instanceof CliError ? error : new CliError("RUNTIME", `UNMAPPED ${String(error)}`) };
  }
}

async function base(): Promise<S> {
  const host = new FakeHost();
  current = host;
  const home = await mkdtemp(path.join(tmpdir(), "sb-qa297c-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-qa297c-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  return { host, home, cwd, folder: path.join(cwd, "team"), auth };
}

const LOCAL = '---\ntype: "Note"\ntitle: "Alpha"\n---\nLOCAL alpha.\n';
const alphaFile = (s: S) => path.join(s.folder, "notes/alpha.md");
const file = (s: S) => readFile(alphaFile(s), "utf8").catch(() => null);
const applied = (s: S) => s.host.applied.filter((x) => x === "notes/alpha").length;
const tombs = (s: S) => s.host.tombstones.get("notes/alpha")?.length ?? 0;

async function plainDelete(): Promise<S> {
  const s = await base();
  await unlink(alphaFile(s));
  return s;
}

async function deletionInConflict(): Promise<S> {
  const s = await base();
  await unlink(alphaFile(s));
  s.host.put("notes/alpha", { type: "Note", title: "Alpha" }, "HOST alpha v2.\n");
  const r = await run(s);
  assert.equal(r.ok, false);
  // Keeping the deletion removes the host's version, so it follows an --inspect (review S2).
  assert.equal((await run(s, ["--inspect", "notes/alpha"])).ok, true);
  return s;
}

async function ownRecreate(): Promise<S> {
  const s = await base();
  await unlink(alphaFile(s));
  const r = await run(s);
  assert.equal(r.ok, true);
  s.tombstone = s.host.latestTombstone("notes/alpha")!.tombstone;
  await writeFile(alphaFile(s), LOCAL);
  return s;
}

async function deletedRemotelyInspected(): Promise<S> {
  const s = await base();
  await writeFile(alphaFile(s), LOCAL);
  s.tombstone = s.host.deleteWithTombstone("notes/alpha");
  assert.equal((await run(s)).ok, false);
  // The replace's document_not_found names no tombstone: one inspect+keep round reaches the conflict that does.
  assert.equal((await run(s, ["--inspect", "notes/alpha"])).ok, true);
  await run(s, ["--resolve", "keep", "--doc", "notes/alpha"]);
  assert.equal((await run(s)).ok, false);
  const shown = await run(s, ["--inspect", "notes/alpha"]);
  assert.equal((shown.receipt?.remote as { deleted_as?: string } | undefined)?.deleted_as, s.tombstone);
  return s;
}

const BULK = Array.from({ length: 20 }, (_, i) => `bulk/n${String(i).padStart(2, "0")}`);
async function sevenOf23(): Promise<S> {
  const host = new FakeHost();
  for (const id of BULK) host.put(id, { type: "Note", title: id }, "x\n");
  current = host;
  const home = await mkdtemp(path.join(tmpdir(), "sb-qa297c-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-qa297c-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  const s = { host, home, cwd, folder: path.join(cwd, "team"), auth };
  for (const id of BULK.slice(0, 7)) await unlink(path.join(s.folder, `${id}.md`));
  return s;
}

function child(env: Record<string, unknown>): Promise<{ signal: NodeJS.Signals | null; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ["--import", "./test/ts-loader.mjs", "./test/support/qa-pr297-child.ts"], { cwd: CLI_ROOT, env: { ...process.env, QA_CHILD: JSON.stringify(env) }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

const settle = async (s: S, argv: string[]): Promise<string | null> => {
  if (argv.length > 0) {
    let again = await run(s, argv);
    // A killed keep may have spent the inspection; inspecting again is what the refusal's help says.
    if (!again.ok && ["not_inspected", "stale_review"].includes(String(again.error.details?.reason))) {
      await run(s, ["--inspect", "notes/alpha"]);
      again = await run(s, argv);
    }
    if (!again.ok && again.error.code !== "NOT_FOUND") return `re-run ${argv.join(" ")}: ${again.error.code} ${again.error.message} ${JSON.stringify(again.error.details)}`;
  }
  let last;
  for (let i = 0; i < 4; i += 1) {
    last = await run(s);
    if (last.ok && last.receipt.status === "up_to_date") return null;
  }
  return `never settles: ${last!.ok ? JSON.stringify(last!.receipt.rows) : `${last!.error.code} ${last!.error.message} ${JSON.stringify(last!.receipt?.rows ?? [])}`}`;
};

export type CrashCaseKey = "bulk-window" | "scan-delete" | "conflict-keep" | "conflict-take" | "own-recreate" | "remote-recreate";

interface Case {
  key: CrashCaseKey;
  name: string;
  setup: () => Promise<S>;
  argv: string[];
  check: (s: S) => Promise<string[]>;
}

const gone = async (s: S, expectTombs: number) => {
  const p: string[] = [];
  if (s.host.docs.has("notes/alpha")) p.push("alpha still on the host");
  if (tombs(s) !== expectTombs) p.push(`${tombs(s)} tombstones, expected ${expectTombs}`);
  if ((await file(s)) !== null) p.push("alpha.md back in the folder");
  return p;
};

const CASES: Case[] = [
  {
    key: "bulk-window",
    name: "7 of 23 deleted, sync; afterwards 7 more must still be held (the window survives the crash)",
    setup: sevenOf23,
    argv: [],
    check: async (s) => {
      const p: string[] = [];
      const gone = BULK.slice(0, 7).filter((id) => !s.host.docs.has(id)).length;
      if (gone !== 7) p.push(`${gone} of the first 7 deleted`);
      for (const id of BULK.slice(7, 14)) await unlink(path.join(s.folder, `${id}.md`));
      const r = await run(s);
      const held = ((r.receipt?.rows as { reason: string }[]) ?? []).filter((row) => row.reason === "bulk_deletion").length;
      if (held !== 7) p.push(`second batch held=${held} (window lost by the crash); host holds ${s.host.docs.size}`);
      return p;
    },
  },
  { key: "scan-delete", name: "scan-journaled delete, sync", setup: plainDelete, argv: [], check: (s) => gone(s, 1) },
  { key: "conflict-keep", name: "deletion in conflict, --resolve keep", setup: deletionInConflict, argv: ["--resolve", "keep", "--doc", "notes/alpha"], check: (s) => gone(s, 1) },
  {
    key: "conflict-take",
    name: "deletion in conflict, --resolve take",
    setup: deletionInConflict,
    argv: ["--resolve", "take", "--doc", "notes/alpha"],
    check: async (s) => {
      const p: string[] = [];
      if (s.host.docs.get("notes/alpha")?.body !== "HOST alpha v2.\n") p.push(`host alpha=${JSON.stringify(s.host.docs.get("notes/alpha")?.body)}`);
      if (tombs(s) !== 0) p.push(`${tombs(s)} tombstones after take`);
      if ((await file(s)) !== s.host.docs.get("notes/alpha")?.raw) p.push(`file alpha=${JSON.stringify(await file(s))}`);
      return p;
    },
  },
  {
    key: "own-recreate",
    name: "own delete then re-create, sync",
    setup: ownRecreate,
    argv: [],
    check: async (s) => {
      const p: string[] = [];
      if (s.host.docs.get("notes/alpha")?.body !== "LOCAL alpha.\n") p.push(`host alpha=${JSON.stringify(s.host.docs.get("notes/alpha")?.body)}`);
      if (applied(s) !== 1) p.push(`alpha applied ${applied(s)}x`);
      if (tombs(s) !== 1) p.push(`${tombs(s)} tombstones`);
      const creates = s.host.writes.filter((c) => c.route === "create");
      if (creates.some((c) => c.recreate !== s.tombstone)) p.push(`a create without the own tombstone: ${JSON.stringify(creates.map((c) => c.recreate))}`);
      return p;
    },
  },
  {
    key: "remote-recreate",
    name: "deleted remotely, inspected, --resolve keep (re-create)",
    setup: deletedRemotelyInspected,
    argv: ["--resolve", "keep", "--doc", "notes/alpha"],
    check: async (s) => {
      const p: string[] = [];
      if (s.host.docs.get("notes/alpha")?.body !== "LOCAL alpha.\n") p.push(`host alpha=${JSON.stringify(s.host.docs.get("notes/alpha")?.body)}`);
      if (applied(s) !== 1) p.push(`alpha applied ${applied(s)}x`);
      if (tombs(s) !== 1) p.push(`${tombs(s)} tombstones`);
      if (!(await file(s))?.includes("LOCAL alpha.")) p.push(`file alpha=${JSON.stringify(await file(s))}`);
      return p;
    },
  },
];

// Each group runs as its own test file (qa-r2-crash-<group>.test.ts); the groups are balanced by
// measured duration. Every case belongs to exactly one group, checked when this module loads.
export const CRASH_CASE_GROUPS = {
  delete: ["bulk-window", "scan-delete"],
  conflict: ["conflict-keep", "conflict-take"],
  recreate: ["own-recreate", "remote-recreate"],
} as const satisfies Record<string, readonly CrashCaseKey[]>;

assert.deepEqual(
  Object.values(CRASH_CASE_GROUPS).flat().sort(),
  CASES.map((c) => c.key).sort(),
  "every crash case must belong to exactly one group",
);

export function registerCrashCases(group: keyof typeof CRASH_CASE_GROUPS): void {
  const keys: readonly CrashCaseKey[] = CRASH_CASE_GROUPS[group];
  for (const c of CASES.filter((c) => keys.includes(c.key) && (!process.env.QA_ONLY || c.name.startsWith(process.env.QA_ONLY)))) {
    registerCase(c);
  }
}

function registerCase(c: Case): void {
  test(`SIGKILL at every step: ${c.name}`, { timeout: 1_800_000 }, async () => {
    const { server, url } = await bridge();
    const failures: string[] = [];
    let steps = 0;
    try {
      for (let killAt = 1; killAt < 400; killAt += 1) {
        const s = await c.setup();
        s.host.applied.length = 0;
        s.host.writes.length = 0;
        const r = await child({ home: s.home, cwd: s.cwd, folder: s.folder, bridge: url, token: TOKEN, killAt, argv: c.argv });
        const killed = r.signal === "SIGKILL";
        const label = /QA_KILL \d+ (.*)/.exec(r.stderr)?.[1] ?? "(completed)";
        if (!killed) steps = Number(/QA_STEPS (\d+)/.exec(r.stderr)?.[1] ?? 0);
        const problems: string[] = [];
        const settled = await settle(s, killed ? c.argv : []);
        if (settled) problems.push(settled);
        problems.push(...(await c.check(s)));
        if (problems.length > 0) failures.push(`#${killAt} kill before [${label}]: ${problems.join("; ")}`);
        if (!killed) break;
      }
    } finally {
      server.close();
    }
    console.log(`# ${c.name}: ${steps} side effects; ${failures.length} failing kill points`);
    for (const line of failures) console.log(`# FAIL ${line.slice(0, 600)}`);
    assert.deepEqual(failures, []);
  });
}
