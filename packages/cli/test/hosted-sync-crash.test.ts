// Adversarial QA (PR 295): SIGKILL a hosted `sync` just before each of its side effects, in turn,
// then re-run sync until it settles. Nothing may be lost or duplicated at any kill point.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(here, "..");

let current: FakeHost;
async function bridge(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length" && k !== "connection") headers.set(k, v);
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
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function scenario() {
  const host = new FakeHost();
  current = host;
  const home = await mkdtemp(path.join(tmpdir(), "sb-qa-crash-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-qa-crash-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  const folder = path.join(cwd, "team");
  // Local: a replace and a create. Host: a change to beta (refresh) and a deletion of plan (removal).
  await writeFile(path.join(folder, "notes/alpha.md"), '---\ntype: "Note"\ntitle: "Alpha"\n---\nLOCAL alpha.\n');
  await writeFile(path.join(folder, "notes/gamma.md"), '---\ntype: "Note"\ntitle: "Gamma"\n---\nLOCAL gamma.\n');
  host.put("notes/beta", { type: "Note", title: "Beta" }, "HOST beta.\n");
  host.remove("projects/2026/plan");
  return { host, home, cwd, folder, auth };
}

function child(env: Record<string, unknown>): Promise<{ signal: NodeJS.Signals | null; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ["--import", "./test/ts-loader.mjs", "./test/support/qa-sync-child.ts"], {
      cwd: CLI_ROOT,
      env: { ...process.env, QA_CHILD: JSON.stringify(env) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function inProcessSync(s: Awaited<ReturnType<typeof scenario>>) {
  const out: string[] = [];
  try {
    await sync(["--dir", s.folder], { stdout: (t: string) => void out.push(t), auth: s.auth, cwd: s.cwd, fetch: s.host.fetch, write: { sleep: async () => {}, lookupDelayMs: 0 }, sleep: async () => {}, lockWaitMs: 500 });
    return { ok: true as const, receipt: decode(out.at(-1)!.trim()) as Record<string, unknown> };
  } catch (error) {
    // A lock orphaned by the kill (a process killed while taking it) is refused as lock_orphaned,
    // not retryable, and its help says to remove it: do exactly that, as the person would.
    if (error instanceof CliError && error.details?.reason === "lock_orphaned" && typeof error.details.lock === "string") {
      await rm(error.details.lock, { recursive: true, force: true });
    }
    return { ok: false as const, error: error instanceof CliError ? `${error.code} ${error.message} ${JSON.stringify(error.details)}` : String(error), receipt: out.length ? (decode(out.at(-1)!.trim()) as Record<string, unknown>) : null };
  }
}

async function dotFiles(folder: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await dotFiles(folder, rel)));
    else if (entry.name.startsWith(".")) out.push(rel);
  }
  return out;
}

test("SIGKILL at every step of pull, export and push, then re-run: nothing lost or duplicated", { timeout: 1_800_000 }, async () => {
  const { server, url } = await bridge();
  const failures: string[] = [];
  const litter: string[] = [];
  let steps = 0;
  try {
    const only = process.env.QA_ONLY ? Number(process.env.QA_ONLY) : undefined;
    for (let killAt = only ?? 1; killAt < (only ? only + 1 : 400); killAt += 1) {
      const s = await scenario();
      const run = await child({ home: s.home, cwd: s.cwd, folder: s.folder, bridge: url, token: TOKEN, killAt });
      const killed = run.signal === "SIGKILL";
      const label = /QA_KILL \d+ (.*)/.exec(run.stderr)?.[1] ?? "(completed)";
      if (!killed) {
        steps = Number(/QA_STEPS (\d+)/.exec(run.stderr)?.[1] ?? 0);
        if (run.code !== 0) failures.push(`uninterrupted child failed: ${run.stderr.trim()}`);
      }
      // Recover: re-run until settled (a pause or lost answer may take one more run).
      let last;
      for (let i = 0; i < 5; i += 1) {
        last = await inProcessSync(s);
        if (last.ok && last.receipt.status === "up_to_date") break;
      }
      const problems: string[] = [];
      const alpha = s.host.docs.get("notes/alpha");
      const gamma = s.host.docs.get("notes/gamma");
      if (alpha?.body !== "LOCAL alpha.\n") problems.push(`host alpha=${JSON.stringify(alpha?.body)}`);
      if (gamma?.body !== "LOCAL gamma.\n") problems.push(`host gamma=${JSON.stringify(gamma?.body)}`);
      const counts = (id: string) => s.host.applied.filter((x) => x === id).length;
      if (counts("notes/alpha") !== 1) problems.push(`alpha applied ${counts("notes/alpha")}x`);
      if (counts("notes/gamma") !== 1) problems.push(`gamma applied ${counts("notes/gamma")}x`);
      if (counts("notes/beta") !== 0) problems.push(`beta applied ${counts("notes/beta")}x (host change overwritten)`);
      if (s.host.docs.has("projects/2026/plan")) problems.push("plan re-created");
      const file = async (id: string) => readFile(path.join(s.folder, `${id}.md`), "utf8").catch(() => null);
      if (!(await file("notes/alpha"))?.includes("LOCAL alpha.")) problems.push(`file alpha=${JSON.stringify(await file("notes/alpha"))}`);
      if (!(await file("notes/gamma"))?.includes("LOCAL gamma.")) problems.push(`file gamma=${JSON.stringify(await file("notes/gamma"))}`);
      if (!(await file("notes/beta"))?.includes("HOST beta.")) problems.push(`file beta=${JSON.stringify(await file("notes/beta"))}`);
      if ((await file("projects/2026/plan")) !== null) problems.push("plan.md still in folder");
      if (!last!.ok || last!.receipt.status !== "up_to_date") problems.push(`never settles: ${last!.ok ? JSON.stringify(last!.receipt.rows) : last!.error}`);
      const dots = await dotFiles(s.folder);
      if (dots.length > 0) litter.push(`#${killAt} ${label}: ${dots.join(", ")}`);
      if (only) console.log(`# detail #${killAt}: ${JSON.stringify(last)} projection-schema-before-recovery-n/a`);
      if (problems.length > 0) failures.push(`#${killAt} kill before [${label}]: ${problems.join("; ")}`);
      if (!killed) break;
    }
  } finally {
    server.close();
  }
  console.log(`# crash sweep: ${steps} side effects in an uninterrupted run; ${failures.length} failing kill points`);
  for (const line of litter) console.log(`# litter ${line}`);
  for (const line of failures) console.log(`# FAIL ${line}`);
  assert.deepEqual(failures, []);
  void stat;
});
