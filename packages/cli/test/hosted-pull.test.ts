import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle } from "@superbee/core";
import { checkout } from "../src/commands/checkout.js";
import { pull } from "../src/commands/pull.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps } from "../src/hosted-auth/session.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function harness(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sb-hosted-pull-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new FakeHost({ workspaces: [{ tenantId: "tenant-a", slug: "civic" }] });
  const auth = defaultHostedAuthDeps(path.join(root, "home"), {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in flow expected"); },
  });
  const folder = path.join(root, "bundle");
  await checkout([`civic/${BUNDLE}`, "--host", HOST, "--dir", folder], { stdout: () => {}, auth, cwd: root, fetch: host.fetch });
  const bytes = Buffer.from([0x72, 0x61, 0x77, 0xff]);
  const head = { key: "report.bin", version: digest(bytes), contentType: "text/plain; charset=iso-8859-1" };
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  let mode = "ok";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const route = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ route, body });
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    if (route.endsWith("/blob-heads")) {
      assert.equal(body.bundleId, `civic/${BUNDLE}`);
      if (mode === "denied") return Response.json({ error: { code: "access_denied" } }, { status: 403 });
      if (mode === "missing-route") return Response.json({ error: "not_found" }, { status: 404 });
      const heads = mode === "absent" ? [] : [head];
      return Response.json({ schemaVersion: 1, bundleId: BUNDLE, revision: 1,
        digest: digest(JSON.stringify([1, heads.map(h => [h.key, h.version, h.contentType])])),
        total: heads.length, heads, next: null });
    }
    if (route.endsWith("/blob-read")) {
      assert.deepEqual(body, { bundleId: `civic/${BUNDLE}`, ...head });
      if (mode === "race") return Response.json({ error: { code: "version_conflict" } }, { status: 409 });
      return new Response(mode === "corrupt" ? Buffer.from("fake") : bytes, { headers: {
        "content-type": "application/octet-stream", "content-length": String(bytes.length),
        "x-superbee-blob-version": head.version,
        "x-superbee-content-type": mode === "wrong-type" ? "application/octet-stream" : head.contentType,
      } });
    }
    const response = await host.fetch(input, init);
    if (route.endsWith("/capabilities")) {
      const caps = await response.json() as Record<string, unknown>;
      return Response.json({ ...caps, blobReads: mode === "unsupported" ? "refused" : "allowed",
        limits: { ...(caps.limits as object), blobReadBytes: 16 * 1024 * 1024 } });
    }
    return response;
  };
  calls.length = 0;
  await writeFile(path.join(folder, head.key), "unsent local edit");
  const out = path.join(root, "out.bin");
  const run = async (extra: string[] = []) => {
    let stdout = "", stderr = "";
    const streamed: Uint8Array[] = [];
    await pull(["--doc-key", head.key, "--out", out, "--dir", folder, "--json", ...extra], {
      stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, writeStdoutBytes: b => { streamed.push(b); }, hosted: { auth, fetch },
    });
    return { receipt: JSON.parse(stdout || stderr) as Record<string, unknown>, streamed };
  };
  return { root, folder, host, head, bytes, calls, out, run, mode: (value: string) => { mode = value; } };
}

test("explicit hosted pull preserves exact stored MIME and bytes without touching the unsent local copy", async t => {
  const h = await harness(t);
  const { receipt } = await h.run(["--from-host"]);
  assert.equal(receipt.source, "hosted");
  assert.equal(receipt.content_type, h.head.contentType);
  assert.equal(receipt.version, h.head.version);
  assert.deepEqual(await readFile(h.out), h.bytes);
  assert.equal(await readFile(path.join(h.folder, h.head.key), "utf8"), "unsent local edit");
  assert.deepEqual(h.calls.map(c => c.route), ["/sync/v1/whoami", "/sync/v1/capabilities", "/sync/v1/blob-heads", "/sync/v1/blob-read"]);
  const streamed = await h.run(["--from-host", "--out", "-"]);
  assert.equal(streamed.receipt.content_type, h.head.contentType);
  assert.deepEqual(Buffer.concat(streamed.streamed), h.bytes);
});

test("default hosted-checkout pull remains an offline local read, including unsent edits and inferred MIME", async t => {
  const h = await harness(t);
  const { receipt } = await h.run();
  assert.equal(receipt.source, undefined);
  assert.equal(receipt.content_type, "application/octet-stream");
  assert.equal(await readFile(h.out, "utf8"), "unsent local edit");
  assert.deepEqual(h.calls, []);
});

for (const [mode, code] of [["race", "CONFLICT"], ["corrupt", "RUNTIME"], ["wrong-type", "RUNTIME"], ["denied", "FORBIDDEN"], ["absent", "NOT_FOUND"], ["missing-route", "RUNTIME"], ["unsupported", "NOT_IMPLEMENTED"]]) {
  test(`hosted pull ${mode} refuses without output replacement or local fallback`, async t => {
    const h = await harness(t); h.mode(mode!);
    await writeFile(h.out, "preserve output");
    await assert.rejects(() => h.run(["--from-host"]), error => error instanceof CliError && error.code === code);
    assert.equal(await readFile(h.out, "utf8"), "preserve output");
    assert.equal(await readFile(path.join(h.folder, h.head.key), "utf8"), "unsent local edit");
  });
}

test("hosted pull checks the bound person before any blob request", async t => {
  const h = await harness(t); h.host.principal = "another-person";
  await assert.rejects(() => h.run(["--from-host"]), error => error instanceof CliError && error.code === "FORBIDDEN");
  assert.deepEqual(h.calls.map(c => c.route), ["/sync/v1/whoami"]);
});

test("hosted pull refuses document and explicit-remote combinations before contacting the host", async t => {
  const h = await harness(t);
  for (const extra of [["--doc-key", "note.md"], ["--remote", HOST]]) {
    await assert.rejects(() => h.run(["--from-host", ...extra]), error => error instanceof CliError && error.code === "USAGE");
  }
  assert.deepEqual(h.calls, []);
});

test("an explicitly selected nested local bundle cannot borrow its parent's hosted binding", async t => {
  const h = await harness(t);
  const nested = path.join(h.folder, "nested");
  await initBundle(nested);
  await assert.rejects(() => h.run(["--from-host", "--dir", nested]), error => error instanceof CliError && error.code === "USAGE");
  assert.deepEqual(h.calls, []);
});
