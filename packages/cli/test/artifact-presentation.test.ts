import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, writeDoc, readDocVersioned } from "@superbee/core";
import { sha256Hex } from "@superbee/core/versioning";
import { presentManagedLocalDocument, openDocumentUi, type UiCliDeps } from "../src/commands/ui.js";
import { docOpen } from "../src/commands/doc/open.js";
import { cliInvocation } from "../src/invocation.js";
import { CliError } from "../src/errors.js";
import type { ManagedUiWorkerInput } from "../src/ui/managed-authority.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-open-"));
  const home = path.join(root, "private");
  const dir = path.join(root, "bundle");
  await initBundle(dir);
  for (const id of ["x", "x.md", "index.md", "docs/雪 🐝"]) await writeDoc({ root: dir }, { id, frontmatter: { type: "Doc", title: id }, body: `# ${id}` });
  let worker: ManagedUiWorkerInput | undefined;
  let spawns = 0, out = "", opened: string | undefined, live = true;
  const events: string[] = [];
  const browserError = new Error("launcher failed");
  let failBrowser = false;
  const deps: Partial<UiCliDeps> = {
    stdout: text => { events.push("stdout"); out += text; },
    openBrowser: url => { events.push("browser"); assert.ok(out.endsWith("\n")); opened = url; if (failBrowser) throw browserError; },
    managedController: {
      home,
      spawnWorker: async input => {
        events.push("start"); worker = input; spawns++; live = true;
        return { host: "127.0.0.1", port: 49152, browser_token: "browser-secret", launch_nonce: `launch-${spawns}`, pid: 42, started_at: "2026-10-03T00:00:00.000Z" };
      },
      fetch: (async (target, init) => {
        if (!live) throw Object.assign(new Error("listener absent"), { code: "ECONNREFUSED" });
        const pathname = new URL(String(target)).pathname;
        if (pathname.endsWith("/status")) return Response.json({ protocol: 1, mode: "dir", authority_key: worker!.authority.key, bundle_root: worker!.authority.bundle_root, launch_root: worker!.authority.launch_root, actor: worker!.authority.actor, launch_nonce: `launch-${spawns}`, state: "ready", active_clients: 0 });
        assert.equal(init?.method, "POST");
        return Response.json({ adopted: true, launch_nonce: `launch-${spawns}` });
      }) as typeof fetch,
    },
  };
  return { dir, deps, events, browserError, get spawns() { return spawns; }, get worker() { return worker; }, get out() { return out; }, get opened() { return opened; }, reset() { out = ""; events.length = 0; opened = undefined; }, fail() { failBrowser = true; }, dead() { live = false; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

for (const [raw, id] of [["x", "x"], ["x.md", "x.md"], ["./x.md", "x"], ["./x.md.md", "x.md"], ["./index.md.md", "index.md"], ["docs/雪 🐝", "docs/雪 🐝"]]) {
  test(`real managed local consumer preserves ${raw} -> ${id}`, async () => {
    const f = await fixture();
    try {
      const read = await readDocVersioned({ root: f.dir }, id!);
      const result = await presentManagedLocalDocument({ values: { dir: f.dir, port: "0", actor: "human:mike", json: true }, positionals: [raw!] }, f.deps);
      assert.equal(result.ok, true); if (!result.ok) throw new Error("expected success");
      assert.equal(result.target.documentId, id);
      assert.deepEqual(result.target.authority, { mode: "local", authorityKey: sha256Hex(await realpath(f.dir)) });
      assert.equal(result.target.bundleKey, "selected");
      assert.equal(JSON.stringify(result).includes(f.dir), false);
      assert.equal(result.presentation.state, "open_requested");
      assert.deepEqual(result.presentation.observation?.provenance, { state: "shared-confirmed", version: read.version, acknowledged: read.version });
      assert.deepEqual(result.presentation.observation?.lifecycle, { state: "unverified" });
      const legacy = JSON.parse(f.out);
      const url = `http://127.0.0.1:49152/?token=browser-secret&view=doc&id=${encodeURIComponent(id!).replaceAll('%20', '+')}`;
      assert.deepEqual(legacy, { ui: "managed", state: "started", url, mode: "dir", root: await realpath(f.dir), document: id, actor: "human:mike", actor_present: true, help: [`open ${url} in a browser`, `${cliInvocation()} ui --status --dir ${await realpath(f.dir)}`] });
      assert.equal(f.opened, legacy.url);
      assert.deepEqual(f.events, ["start", "stdout", "browser"]);
      assert.equal(f.worker?.authority.actor, "human:mike");
      assert.equal(f.worker?.authority.bundle_root, await realpath(f.dir));
      assert.equal(f.worker?.port, 0);
    } finally { await f.cleanup(); }
  });
}
test("public open returns void, keeps TOON output, and start/reuse/restart remain owned by managed UI", async () => {
  const f = await fixture();
  try {
    const first = await presentManagedLocalDocument({ values: { dir: f.dir, json: true }, positionals: ["x"] }, f.deps);
    f.reset();
    const second = await presentManagedLocalDocument({ values: { dir: f.dir, json: true }, positionals: ["x.md"] }, f.deps);
    assert.notEqual(first.invocationId, second.invocationId);
    assert.equal(JSON.parse(f.out).state, "reused");
    assert.equal(JSON.parse(f.out).document, "x.md");
    assert.equal(f.spawns, 1);
    assert.deepEqual(f.events, ["stdout", "browser"]);
    f.dead(); f.reset();
    assert.equal(await openDocumentUi(["x", "--dir", f.dir, "--json"], f.deps), undefined);
    assert.equal(JSON.parse(f.out).state, "started"); assert.equal(f.spawns, 2);
    f.reset();
    assert.equal(await docOpen(["./x.md", "--dir", f.dir], f.deps), undefined);
    assert.match(f.out, /^ui: managed\nstate: reused\nurl:/);
    assert.match(f.out, /\ndocument: x\n/);
  } finally { await f.cleanup(); }
});
test("throwing browser invocation preserves legacy stdout then rejects without presentation success", async () => {
  const f = await fixture(); f.fail();
  try {
    let resolved = false;
    await assert.rejects(async () => { await presentManagedLocalDocument({ values: { dir: f.dir, json: true }, positionals: ["x"] }, f.deps); resolved = true; }, error => error === f.browserError);
    assert.equal(resolved, false); assert.equal(JSON.parse(f.out).state, "started");
    assert.deepEqual(f.events, ["start", "stdout", "browser"]);
    f.reset();
    await assert.rejects(() => docOpen(["x", "--dir", f.dir, "--json"], f.deps), error => error === f.browserError);
    assert.equal(JSON.parse(f.out).state, "reused");
  } finally { await f.cleanup(); }
});
test("existing local errors precede any managed start, output or browser action", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.dir, "bad.md"), "---\ntype: [\n---\n");
    for (const [id, code] of [["missing", "NOT_FOUND"], ["../x", "USAGE"], ["bad", "RUNTIME"], ["index.md", "USAGE"]]) {
      await assert.rejects(() => docOpen([id!, "--dir", f.dir, "--json"], f.deps), error => error instanceof CliError && error.code === code);
      assert.equal(f.spawns, 0); assert.equal(f.out, ""); assert.equal(f.opened, undefined);
    }
    await assert.rejects(() => docOpen(["x", "--dir", f.dir, "--port", "-1"], f.deps), error => error instanceof CliError && error.code === "USAGE");
    assert.equal(f.spawns, 0);
  } finally { await f.cleanup(); }
});
test("portable binding and managed authority retain existing canonical-root selection for symlink input", async () => {
  const f = await fixture();
  const alias = `${f.dir}-alias`;
  try {
    await symlink(f.dir, alias);
    const result = await presentManagedLocalDocument({ values: { dir: alias, json: true }, positionals: ["x"] }, f.deps);
    assert.equal(result.target.authority.authorityKey, sha256Hex(await realpath(f.dir)));
    assert.equal(f.worker?.authority.launch_root, path.resolve(alias));
    assert.equal(JSON.parse(f.out).root, await realpath(f.dir));
  } finally { await rm(alias, { force: true }); await f.cleanup(); }
});
