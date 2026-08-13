/**
 * `agentstate-lite blobs` — enumerate the store's blob (non-document) keys. The seam / RemoteBackend /
 * wire already implement `listBlobs`; this command is the CLI surface over it, symmetric with `list`
 * for documents. Runs in-process against a temp filesystem bundle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeBlob, type Bundle } from "@superbee/core";
import { blobs } from "../src/commands/blobs.js";
import { CliError } from "../src/errors.js";

async function tempBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-blobs-test-"));
  await initBundle(dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await blobs([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

test("blobs: lists the store's blob keys (sorted) with a count and a pull next-step", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    const bundle: Bundle = { root: dir };
    await writeBlob(bundle, "assets/logo.png", new Uint8Array([1, 2, 3]), "image/png");
    await writeBlob(bundle, "assets/hero.jpg", new Uint8Array([4, 5, 6]), "image/jpeg");
    await writeBlob(bundle, "reports/q1.html", new Uint8Array([7, 8]), "text/html");

    const out = await runJson(["--dir", dir]);
    assert.equal(out.count, 3);
    assert.deepEqual(out.blobs, ["assets/hero.jpg", "assets/logo.png", "reports/q1.html"]);
    assert.ok((out.help as string[]).some((h) => /pull --doc-key/.test(h)));
  } finally {
    await cleanup();
  }
});

test("blobs --prefix restricts; --limit caps with count staying the true total", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    const bundle: Bundle = { root: dir };
    for (let i = 0; i < 3; i++) await writeBlob(bundle, `assets/a${i}.bin`, new Uint8Array([i]), "application/octet-stream");
    await writeBlob(bundle, "other/x.bin", new Uint8Array([9]), "application/octet-stream");

    const prefixed = await runJson(["--prefix", "assets/", "--dir", dir]);
    assert.equal(prefixed.count, 3);
    assert.ok((prefixed.blobs as string[]).every((k) => k.startsWith("assets/")));

    const limited = await runJson(["--prefix", "assets/", "--limit", "2", "--dir", dir]);
    assert.equal(limited.count, 3, "count is the true total");
    assert.equal((limited.blobs as unknown[]).length, 2);
    assert.equal(limited.shown, 2);
    assert.ok((limited.help as string[]).some((h) => /showing 2 of 3/.test(h) && /--limit 0/.test(h)));
  } finally {
    await cleanup();
  }
});

test("blobs: a store with no blobs is a definitive empty state (count 0) with a promote hint", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    const out = await runJson(["--dir", dir]);
    assert.equal(out.count, 0);
    assert.deepEqual(out.blobs, []);
    assert.ok((out.help as string[]).some((h) => /no blobs in the store/.test(h) && /promote/.test(h)));
  } finally {
    await cleanup();
  }
});

test("blobs --limit abc: USAGE (exit 2), not a crash", async () => {
  const { dir, cleanup } = await tempBundle();
  try {
    await assert.rejects(
      () => blobs(["--limit", "abc", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => err instanceof CliError && err.code === "USAGE" && err.exitCode === 2,
    );
  } finally {
    await cleanup();
  }
});
