// QA child: one `superbee sync` in its own process that SIGKILLs itself just before its Nth
// side effect (a filesystem mutation, a log write, or a request), so the parent can check that a
// crash at every step loses and duplicates nothing. The fake host lives in the parent, behind a
// loopback bridge.
import fs, { promises as fsp } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

import { sync } from "../../src/commands/sync.js";
import { defaultHostedAuthDeps } from "../../src/hosted-auth/session.js";

const cfg = JSON.parse(process.env.QA_CHILD!) as { home: string; cwd: string; folder: string; bridge: string; token: string; killAt: number };
let step = 0;
function tick(label: string): void {
  step += 1;
  if (step === cfg.killAt) {
    process.stderr.write(`QA_KILL ${step} ${label}\n`);
    process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
}
const short = (p: unknown) => (typeof p === "string" ? path.relative(cfg.home, p).startsWith("..") ? path.relative(cfg.folder, p) : `~/${path.relative(cfg.home, p)}` : "?");

for (const name of ["rename", "link", "unlink", "writeFile", "rm", "mkdir", "appendFile", "copyFile"] as const) {
  const original = (fsp as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
  (fsp as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    tick(`${name} ${short(args[0])}${name === "rename" || name === "link" ? ` -> ${short(args[1])}` : ""}`);
    return original.apply(fsp, args);
  };
}
const originalOpen = fsp.open;
(fsp as unknown as Record<string, unknown>).open = (file: unknown, flags?: unknown, mode?: unknown) => {
  if (typeof flags === "string" && /[wax+]/.test(flags)) tick(`open(${flags}) ${short(file)}`);
  return (originalOpen as (...a: unknown[]) => Promise<unknown>)(file, flags, mode);
};
// FileHandle writes (the journal log, exclusive creates).
const probe = await originalOpen(path.join(cfg.home, ".qa-probe"), "w");
const proto = Object.getPrototypeOf(probe) as Record<string, (...a: unknown[]) => unknown>;
await probe.close();
for (const name of ["write", "writeFile", "sync", "truncate"] as const) {
  const original = proto[name]!;
  proto[name] = function (this: unknown, ...args: unknown[]) {
    tick(`handle.${name}`);
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
void fs;

const bridged = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const route = url.pathname.replace(/^\/sync\/v1\//, "");
  tick(`send ${route}`);
  const response = await fetch(`${cfg.bridge}${url.pathname}`, init);
  const body = await response.arrayBuffer();
  tick(`answer ${route}`);
  return new Response(body.byteLength === 0 && (response.status === 304 || response.status === 204) ? null : body, { status: response.status, headers: response.headers });
}) as typeof fetch;

const auth = defaultHostedAuthDeps(cfg.home, { env: { SUPERBEE_ACCESS_TOKEN: cfg.token }, fetch: async () => { throw new Error("no sign-in"); } });
let code = 0;
try {
  await sync(["--dir", cfg.folder], {
    stdout: () => {},
    auth,
    cwd: cfg.cwd,
    fetch: bridged,
    write: { sleep: async () => {}, lookupDelayMs: 0 },
    sleep: async () => {},
    lockWaitMs: 2000,
  });
} catch (error) {
  process.stderr.write(`QA_ERROR ${(error as Error).message}\n`);
  code = 3;
}
process.stderr.write(`QA_STEPS ${step}\n`);
process.exit(code);
