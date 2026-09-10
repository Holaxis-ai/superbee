/**
 * The browser-local bundle path in real Chromium. Every proof before this one ran the IndexedDB
 * adapter in Node over fake-indexeddb; these scenarios run the same adapter and the same engine
 * mutation path in a real page with real IndexedDB, real reloads, a real browser restart, and
 * two pages on one origin.
 *
 * Harness: the driver (test/fixtures/driver.ts) is bundled with esbuild inside the spec and
 * served by a node:http server on 127.0.0.1, so every page in every context shares one origin
 * and therefore one IndexedDB. The reload-and-restart scenario uses a persistent Chromium
 * context over a temporary user-data directory, which is the way a browser restart keeps its
 * storage; the other scenarios use Playwright's default per-test context.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { chromium, expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";

import { FilesystemBackend, type OkfDocument } from "@superbee/core";
import { writeDocVersioned } from "@superbee/core/bundle-ops";
import { contentVersion, versionOfBytes } from "@superbee/core/versioning";

import type { Driver, DriverError, MutateReply, WriteReply } from "./fixtures/driver.ts";

const ROOT_INDEX = "---\nokf_version: '0.2'\n---\n# Browser-local proof\n";

/** Documents whose bytes exercise the hashing and serialization edges the Node parity row names. */
const PARITY_DOCS: ReadonlyArray<{ id: string; frontmatter: Record<string, unknown>; body: string }> = [
  {
    id: "parity/edges",
    frontmatter: { type: "Parity", title: "Edges 日本語 🐝", timestamp: "2026-09-01T00:00:00.000Z" },
    // CJK, emoji with a ZWJ family, combining marks (e + U+0301, a + U+0308), CRLF line endings,
    // and no trailing newline at all.
    body: "日本語の本文 and bee 🐝 family 👨‍👩‍👧\r\ncafé näive\r\nlast line without newline",
  },
  {
    id: "parity/plain",
    frontmatter: { type: "Parity", title: "Plain", timestamp: "2026-09-01T00:00:00.000Z" },
    body: "one\ntwo\n",
  },
  {
    id: "parity/literal-rule",
    frontmatter: { type: "Parity", title: "Rule", timestamp: "2026-09-01T00:00:00.000Z", tags: ["a", "b"] },
    body: "before\n---\nafter\n",
  },
];

const BLOB_KEY = "artifacts/invalid-utf8.bin";
const BLOB_BYTES = [0x80, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x90, 0x28, 0xbc];

let server: Server;
let origin: string;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL("./fixtures/driver.ts", import.meta.url).pathname],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: false,
    sourcemap: false,
    write: false,
    logLevel: "silent",
  });
  const script = bundle.outputFiles?.[0]?.text;
  if (!script) throw new Error("browser-local driver build produced no JavaScript.");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>browser-local</title></head><body><script src="/driver.js"></script></body></html>`;
  server = createServer((request, response) => {
    if (request.url === "/driver.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function load(page: Page): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => typeof window.superbeeLocal === "object")).toBe(true);
}

type DriverMethod = keyof Driver;
type Reply<M extends DriverMethod> = Awaited<ReturnType<Driver[M]>>;

/** Invoke one driver method in the page; every reply is JSON, errors included. */
function call<M extends DriverMethod>(page: Page, method: M, ...args: Parameters<Driver[M]>): Promise<Reply<M>> {
  return page.evaluate(
    ([name, params]) => (window.superbeeLocal[name as DriverMethod] as (...inner: unknown[]) => unknown)(...(params as unknown[])),
    [method, args] as const,
  ) as Promise<Reply<M>>;
}

function ok<T>(reply: T | DriverError, label: string): T {
  if (reply && typeof reply === "object" && "error" in reply) {
    const { error } = reply as DriverError;
    throw new Error(`${label}: ${error.name}: ${error.message}`);
  }
  return reply as T;
}

function isConflict(reply: MutateReply | DriverError): reply is DriverError {
  return "error" in reply && reply.error.name === "VersionConflict";
}

async function seed(page: Page, name: string): Promise<Map<string, WriteReply>> {
  ok(await call(page, "open", name), "open");
  const written = new Map<string, WriteReply>();
  for (const doc of PARITY_DOCS) {
    written.set(doc.id, ok(await call(page, "write", doc.id, doc.frontmatter, doc.body), `write ${doc.id}`));
  }
  return written;
}

test("a: local read, query, edit and commit issue zero network requests", async ({ page }) => {
  await load(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/*", (route) => route.abort());

  const written = await seed(page, "zero-network");
  const read = ok(await call(page, "read", "parity/edges"), "read");
  expect(read.version).toBe(written.get("parity/edges")!.version);
  const heads = ok(await call(page, "query", "parity/"), "query");
  expect(heads.map((head) => head.id)).toEqual(PARITY_DOCS.map((doc) => doc.id).sort());
  const mutated = ok(await call(page, "mutate", "parity/edges", read.version, "edited locally\n"), "mutate");
  expect(mutated.changed).toBe(true);
  expect(mutated.version).not.toBe(read.version);
  const blob = ok(await call(page, "writeBlob", BLOB_KEY, BLOB_BYTES), "writeBlob");
  const blobBack = ok(await call(page, "readBlob", BLOB_KEY), "readBlob");
  expect(blobBack).toMatchObject({ found: true, version: blob.version, bytes: BLOB_BYTES });
  expect((await call(page, "read", "parity/edges") as WriteReply).doc.body).toBe("edited locally\n");

  expect(requests).toEqual([]);
});

test("b: the working copy survives a real page reload and a browser restart", async ({ browser }) => {
  test.setTimeout(120_000);
  const userDataDir = await mkdtemp(path.join(tmpdir(), "superbee-browser-local-"));
  const before = new Map<string, WriteReply>();
  let blobVersion = "";
  try {
    const first = await chromium.launchPersistentContext(userDataDir, { headless: true });
    try {
      const page = first.pages()[0] ?? (await first.newPage());
      await load(page);
      await seed(page, "persist");
      // Compare read to read: a read returns the serializer-normalized body, a write reply the
      // caller's input, so the baseline is what the page could read back before any reload.
      for (const doc of PARITY_DOCS) before.set(doc.id, ok(await call(page, "read", doc.id), `read ${doc.id}`));
      blobVersion = ok(await call(page, "writeBlob", BLOB_KEY, BLOB_BYTES), "writeBlob").version;

      await page.reload({ waitUntil: "networkidle" });
      await expect.poll(() => page.evaluate(() => typeof window.superbeeLocal === "object")).toBe(true);
      const reopened = ok(await call(page, "open", "persist"), "reopen");
      expect(reopened.seeded).toBe(false);
      await expectSameWorkingCopy(page, before, blobVersion);
    } finally {
      await first.close();
    }

    const second = await chromium.launchPersistentContext(userDataDir, { headless: true });
    try {
      const page = second.pages()[0] ?? (await second.newPage());
      await load(page);
      const reopened = ok(await call(page, "open", "persist"), "reopen after restart");
      expect(reopened.seeded).toBe(false);
      await expectSameWorkingCopy(page, before, blobVersion);
      test.info().annotations.push({ type: "browser-restart", description: `data survived a Chromium ${browser.version()} restart` });
    } finally {
      await second.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

async function expectSameWorkingCopy(page: Page, before: Map<string, WriteReply>, blobVersion: string): Promise<void> {
  for (const doc of PARITY_DOCS) {
    const after = ok(await call(page, "read", doc.id), `read ${doc.id}`);
    const original = before.get(doc.id)!;
    expect(after.version).toBe(original.version);
    expect(after.doc).toEqual(original.doc);
  }
  const heads = ok(await call(page, "query", "parity/"), "query");
  expect(heads).toEqual(
    PARITY_DOCS.map((doc) => ({ id: doc.id, version: before.get(doc.id)!.version, type: "Parity" })).sort((a, b) => a.id.localeCompare(b.id)),
  );
  const blob = ok(await call(page, "readBlob", BLOB_KEY), "readBlob");
  expect(blob).toMatchObject({ found: true, version: blobVersion, bytes: BLOB_BYTES });
}

test("c: two pages on one origin cannot both win a compare-and-swap", async ({ context }) => {
  test.setTimeout(120_000);
  const ROUNDS = 40;
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await load(pageA);
  await load(pageB);
  ok(await call(pageA, "open", "race"), "open A");
  ok(await call(pageB, "open", "race"), "open B");
  const id = "race/target";
  ok(await call(pageA, "write", id, { type: "Race", title: "Race", timestamp: "2026-09-01T00:00:00.000Z" }, "round 0\n"), "seed");

  let winsA = 0;
  let winsB = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const [headA, headB] = await Promise.all([call(pageA, "read", id), call(pageB, "read", id)]);
    const head = ok(headA, "head A");
    expect(ok(headB, "head B").version).toBe(head.version);

    // Alternate which page's call is dispatched first so neither page is structurally favored.
    const attemptA = () => call(pageA, "mutate", id, head.version, `round ${round} from A\n`);
    const attemptB = () => call(pageB, "mutate", id, head.version, `round ${round} from B\n`);
    const [replyA, replyB] = round % 2 === 1
      ? await Promise.all([attemptA(), attemptB()])
      : await Promise.all([attemptB(), attemptA()]).then(([b, a]) => [a, b] as const);
    const aWon = !("error" in replyA);
    const bWon = !("error" in replyB);
    expect(aWon !== bWon, `round ${round}: exactly one page must win (A=${JSON.stringify(replyA)} B=${JSON.stringify(replyB)})`).toBe(true);
    const winner = ok(aWon ? replyA : replyB, "winner");
    const loser = aWon ? replyB : replyA;
    expect(isConflict(loser), `round ${round}: loser must report VersionConflict, got ${JSON.stringify(loser)}`).toBe(true);
    expect((loser as DriverError).error.expected).toBe(head.version);
    expect((loser as DriverError).error.actual).toBe(winner.version);
    expect(winner.changed).toBe(true);
    expect(winner.version).not.toBe(head.version);

    const after = ok(await call(pageB, "read", id), "read after round");
    expect(after.version).toBe(winner.version);
    expect(after.doc.body).toBe(`round ${round} from ${aWon ? "A" : "B"}\n`);
    if (aWon) winsA += 1;
    else winsB += 1;
  }
  expect(winsA + winsB).toBe(ROUNDS);
  const summary = `CAS race: ${ROUNDS} rounds, page A won ${winsA}, page B won ${winsB}, every loser saw the winner's version`;
  console.log(summary);
  test.info().annotations.push({ type: "cas-race", description: summary });
});

test("d: browser tokens and read bodies equal the Node engine's for the same documents", async ({ page }) => {
  await load(page);
  const inBrowser = await seed(page, "parity");

  const root = await mkdtemp(path.join(tmpdir(), "superbee-browser-local-parity-"));
  try {
    const disk = new FilesystemBackend(root);
    await disk.writeReserved("", "index.md", ROOT_INDEX);
    for (const source of PARITY_DOCS) {
      const browserWrite = inBrowser.get(source.id)!;
      const browserRead = ok(await call(page, "read", source.id), `read ${source.id}`);
      const browserHash = ok(await call(page, "contentVersionOf", source.id), `contentVersionOf ${source.id}`);

      const doc: OkfDocument = { id: source.id, frontmatter: source.frontmatter, body: source.body };
      const onDisk = await writeDocVersioned({ root, backend: disk }, doc);
      const diskRead = await disk.read(source.id);
      const diskBytes = await readFile(path.join(root, `${source.id}.md`), "utf8");

      // The engine's token for the same input, minted in Node over the filesystem adapter.
      expect(browserWrite.version, `${source.id}: write token`).toBe(onDisk.version);
      expect(browserRead.version, `${source.id}: read token`).toBe(diskRead.version);
      // The pure primitives agree with each other across runtimes and with the on-disk bytes.
      expect(browserHash.version, `${source.id}: page contentVersion`).toBe(contentVersion(onDisk.doc));
      expect(contentVersion(onDisk.doc), `${source.id}: node contentVersion`).toBe(versionOfBytes(diskBytes));
      expect((await call(page, "versionOfBytes", diskBytes)).version, `${source.id}: page versionOfBytes`).toBe(versionOfBytes(diskBytes));
      // The read body is the same normalized body the filesystem adapter returns.
      expect(browserRead.doc.body, `${source.id}: read body`).toBe(diskRead.doc.body);
      expect(browserRead.doc.frontmatter, `${source.id}: read frontmatter`).toEqual(diskRead.doc.frontmatter);
      expect(browserWrite.doc, `${source.id}: saved document`).toEqual({ id: onDisk.doc.id, frontmatter: onDisk.doc.frontmatter, body: onDisk.doc.body });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("e: the adapter refuses a foreign IndexedDB schema and leaves it untouched", async ({ page }) => {
  await load(page);

  const newer = ok(await call(page, "createForeignDatabase", "foreign-v2", 2, "somebody-elses-store"), "create v2");
  expect(newer).toEqual({ ok: true, version: 2, stores: ["somebody-elses-store"] });
  const refusedNewer = await call(page, "open", "foreign-v2");
  expect(refusedNewer).toMatchObject({ error: { name: "IndexedDbSchemaError" } });
  expect((refusedNewer as DriverError).error.message).toMatch(/newer schema version/);

  const wrongStores = ok(await call(page, "createForeignDatabase", "foreign-v1", 1, "somebody-elses-store"), "create v1");
  expect(wrongStores).toEqual({ ok: true, version: 1, stores: ["somebody-elses-store"] });
  const refusedStores = await call(page, "open", "foreign-v1");
  expect(refusedStores).toMatchObject({ error: { name: "IndexedDbSchemaError" } });
  expect((refusedStores as DriverError).error.message).toMatch(/does not carry this adapter's object stores/);

  // Both refusals left the foreign databases exactly as they were.
  const databases = await page.evaluate(async () => {
    const rows = await indexedDB.databases();
    return rows.filter((row) => row.name?.startsWith("foreign-")).map((row) => ({ name: row.name, version: row.version })).sort((a, b) => a.name!.localeCompare(b.name!));
  });
  expect(databases).toEqual([
    { name: "foreign-v1", version: 1 },
    { name: "foreign-v2", version: 2 },
  ]);
  // The refusal is not sticky: a fresh name on the same page opens normally.
  ok(await call(page, "open", "after-refusal"), "open after refusal");
  expect(ok(await call(page, "query", ""), "query after refusal")).toEqual([]);
});

test("f: storage persistence request and footprint are recorded, not asserted", async ({ page, browser }) => {
  await load(page);
  const persist = await call(page, "requestPersist");
  const before = await call(page, "storage");

  ok(await call(page, "open", "footprint"), "open");
  const filler = "x".repeat(1024);
  for (let index = 0; index < 200; index += 1) {
    ok(await call(page, "write", `footprint/doc-${String(index).padStart(3, "0")}`, { type: "Footprint", title: `Doc ${index}` }, `${filler}\n`), `write ${index}`);
  }
  const blob = Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
  ok(await call(page, "writeBlob", "artifacts/footprint.bin", blob), "writeBlob");
  const after = await call(page, "storage");

  const lines = [
    `Chromium ${browser.version()}`,
    `navigator.storage.persist() -> ${JSON.stringify(persist)}`,
    `estimate before writes: usage=${before.usage} quota=${before.quota} persisted=${before.persisted}`,
    `estimate after 200 x 1 KiB documents + 256 KiB blob: usage=${after.usage} quota=${after.quota} persisted=${after.persisted}`,
  ];
  for (const line of lines) {
    console.log(`[storage] ${line}`);
    test.info().annotations.push({ type: "storage", description: line });
  }
  expect(ok(await call(page, "query", "footprint/"), "query")).toHaveLength(200);
});
