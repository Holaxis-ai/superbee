import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readBundleTimeZone, setBundleTimeZone } from "../src/bundle-time-zone.js";
import { DEFAULT_BUNDLE_TIME_ZONE, validateBundleTimeZone } from "../src/time-zone.js";
import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { InvalidInputError, OkfActorError } from "../src/errors.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { VersionConflict } from "../src/versioning.js";
import { parseReservedMarkdown } from "../src/frontmatter.js";
import { readBundleOkfVersion } from "../src/engine.js";
import { applyIndexProjection, prepareIndexProjection, planIndexProjection, GENERATED_INDEX_MARKER } from "../src/index-projection.js";
import type { ReservedFilename, Version, WriteOptions } from "../src/types.js";

class RecordingBackend extends MemoryBackend {
  writes = 0;
  override async writeReserved(dir: string, name: ReservedFilename, content: string, options?: WriteOptions): Promise<Version> {
    const version = await super.writeReserved(dir, name, content, options);
    this.writes++;
    return version;
  }
}

test("time zone accepts named zones while rejecting offsets, abbreviations and nonstrings", () => {
  assert.equal(DEFAULT_BUNDLE_TIME_ZONE, "Etc/GMT");
  for (const value of ["Etc/GMT", "America/New_York", "America/Argentina/Buenos_Aires", "UTC", "GMT", "US/Eastern"]) {
    assert.equal(validateBundleTimeZone(value), value);
  }
  for (const value of [undefined, null, 4, {}, "", " EST", "EST", "EDT", "CET", "Eastern", "+05:00", "UTC+2", "Invalid/Zone", "America/New_York "]) {
    assert.throws(() => validateBundleTimeZone(value), InvalidInputError);
  }
});

test("absent roots and settings default without writes; set/reset retain missing edition", async () => {
  const backend = new RecordingBackend();
  assert.deepEqual(await readBundleTimeZone(backend), { timeZone: "Etc/GMT", source: "default", version: null });
  assert.equal((await setBundleTimeZone(backend, null)).changed, false);
  assert.equal(backend.writes, 0);
  const set = await setBundleTimeZone(backend, "America/New_York");
  assert.equal(set.source, "configured");
  assert.equal(await readBundleOkfVersion(backend), undefined);
  assert.deepEqual(await setBundleTimeZone(backend, "America/New_York"), { ...set, changed: false });
  assert.equal(backend.writes, 1);
  assert.equal((await setBundleTimeZone(backend, null)).source, "default");
  assert.equal(await readBundleOkfVersion(backend), undefined);
});

test("invalid inputs never write; setters repair invalid settings but reject malformed YAML", async () => {
  const backend = new RecordingBackend();
  await assert.rejects(setBundleTimeZone(backend, "EST"), InvalidInputError);
  assert.equal(backend.writes, 0);
  await backend.writeReserved("", "index.md", "---\nsuperbee_base_time_zone: 123\n---\ncurated");
  await assert.rejects(readBundleTimeZone(backend), /superbee_base_time_zone/);
  assert.equal((await setBundleTimeZone(backend, "UTC")).timeZone, "UTC");
  await backend.writeReserved("", "index.md", "---\nsuperbee_base_time_zone: [\n---\ncurated");
  const writes = backend.writes;
  await assert.rejects(setBundleTimeZone(backend, null));
  assert.equal(backend.writes, writes);
});

test("explicit stale versions conflict even on no-op; concurrent setters cannot overwrite", async () => {
  const backend = new RecordingBackend();
  const initial = await setBundleTimeZone(backend, "UTC");
  await assert.rejects(setBundleTimeZone(backend, "UTC", { expectedVersion: null }), VersionConflict);
  const results = await Promise.allSettled([
    setBundleTimeZone(backend, "America/New_York", { expectedVersion: initial.version }),
    setBundleTimeZone(backend, "Etc/GMT", { expectedVersion: initial.version }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof VersionConflict);
});

test("v0.2 actor validation precedes no-op without adding attribution writes", async () => {
  const backend = new RecordingBackend();
  await backend.writeReserved("", "index.md", '---\nokf_version: "0.2"\n---\n');
  await assert.rejects(setBundleTimeZone(backend, null, { actor: "bad actor" }), OkfActorError);
  assert.equal((await setBundleTimeZone(backend, null, { actor: "process:test" })).changed, false);
  assert.equal(backend.writes, 1);
});

test("remote settings preserve the same bytes and conditional write semantics", async () => {
  const storage = new MemoryBackend();
  const remote = new RemoteBackend({
    baseUrl: "http://timezone.local", bundle: "test",
    fetchImpl: async (req) => {
      assert.match(new URL(req.url).pathname, /\/reserved\/index\.md$/);
      if (req.method === "GET") {
        const current = await storage.readReserved("", "index.md");
        return current ? new Response(JSON.stringify({ content: current.content }), { headers: { "X-Version": current.version } }) : new Response(null, { status: 404 });
      }
      assert.equal(req.method, "PUT");
      const current = await storage.readReserved("", "index.md");
      assert.equal(req.headers.get(current ? "If-Match" : "If-None-Match"), current?.version ?? "*");
      const payload = await req.json() as { content: string };
      const version = await storage.writeReserved("", "index.md", payload.content, { expectedVersion: current?.version ?? null });
      return new Response(JSON.stringify({ version }), { headers: { "X-Version": version } });
    },
  });
  assert.equal((await readBundleTimeZone(remote)).timeZone, "Etc/GMT");
  const configured = await setBundleTimeZone(remote, "America/New_York");
  assert.deepEqual(await readBundleTimeZone(storage), { timeZone: configured.timeZone, source: configured.source, version: configured.version });
  assert.equal((await setBundleTimeZone(remote, "UTC", { expectedVersion: configured.version })).timeZone, "UTC");
  await assert.rejects(setBundleTimeZone(remote, "UTC", { expectedVersion: configured.version }), VersionConflict);
});

test("filesystem setting preserves body bytes, unknown timestamps, edition, and concept bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-time-zone-"));
  try {
    const backend = new FilesystemBackend(root);
    const body = "# Curated\r\n\r\nexact ending";
    const frontmatter = 'okf_version: "7.2"\ntimestamp: 2026-01-02T00:00:00-05:00\ncustom:\n  date: 2026-01-02\n';
    await writeFile(path.join(root, "index.md"), `---\n${frontmatter}---\n${body}`);
    const concept = "---\ntype: Note\n---\nunchanged bytes";
    await writeFile(path.join(root, "note.md"), concept);
    await setBundleTimeZone(backend, "America/New_York");
    const parsed = parseReservedMarkdown((await backend.readReserved("", "index.md"))!.content);
    assert.equal(parsed.body, body);
    assert.equal(parsed.frontmatter.timestamp, "2026-01-02T00:00:00-05:00");
    assert.deepEqual(parsed.frontmatter.custom, { date: "2026-01-02" });
    assert.equal(parsed.frontmatter.okf_version, "7.2");
    assert.equal(await readFile(path.join(root, "note.md"), "utf8"), concept);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("projection preserves settings and unknown metadata both normally and under force", async () => {
  for (const force of [false, true]) {
    const backend = new MemoryBackend();
    const bundle = { root: "mem://timezone", backend };
    await backend.writeReserved("", "index.md", `---\nokf_version: "7.2"\nsuperbee_base_time_zone: America/New_York\ncustom: 2026-01-02\n---\n${force ? "curated" : GENERATED_INDEX_MARKER}\n`);
    const prepared = await prepareIndexProjection(bundle, planIndexProjection("test", []), { force });
    assert.equal(prepared.ready, true);
    await applyIndexProjection(bundle, prepared);
    const parsed = parseReservedMarkdown((await backend.readReserved("", "index.md"))!.content);
    assert.deepEqual(parsed.frontmatter, { okf_version: "7.2", superbee_base_time_zone: "America/New_York", custom: "2026-01-02" });
  }
});

test("projection and configuration writers reject stale premises in both orders", async () => {
  const backend = new MemoryBackend();
  const bundle = { root: "mem://timezone", backend };
  await backend.writeReserved("", "index.md", `---\nokf_version: "0.2"\n---\n${GENERATED_INDEX_MARKER}\n`);
  const prepared = await prepareIndexProjection(bundle, planIndexProjection("test", []));
  await setBundleTimeZone(backend, "America/New_York");
  await assert.rejects(applyIndexProjection(bundle, prepared), (error: unknown) => error instanceof Error && error.cause instanceof VersionConflict);
  assert.equal((await readBundleTimeZone(backend)).timeZone, "America/New_York");
  const before = (await backend.readReserved("", "index.md"))!;
  const again = await prepareIndexProjection(bundle, planIndexProjection("test", []));
  await applyIndexProjection(bundle, again);
  await assert.rejects(setBundleTimeZone(backend, "UTC", { expectedVersion: before.version }), VersionConflict);
});

test("reset preserves body-leading delimiters without reinterpreting them as metadata", async () => {
  const backend = new MemoryBackend();
  const body = "---\nthis is prose, not metadata";
  await backend.writeReserved("", "index.md", `---\nsuperbee_base_time_zone: UTC\n---\n${body}`);
  await setBundleTimeZone(backend, null);
  assert.equal((await readBundleTimeZone(backend)).source, "default");
  assert.equal(parseReservedMarkdown((await backend.readReserved("", "index.md"))!.content).body, body);
});

test("projection retains absent editions and refuses malformed root YAML even with force", async () => {
  const backend = new MemoryBackend();
  const bundle = { root: "mem://timezone", backend };
  await backend.writeReserved("", "index.md", `---\nsuperbee_base_time_zone: UTC\n---\n${GENERATED_INDEX_MARKER}\n`);
  await applyIndexProjection(bundle, await prepareIndexProjection(bundle, planIndexProjection("test", [])));
  assert.equal(await readBundleOkfVersion(backend), undefined);
  await backend.writeReserved("", "index.md", "---\ninvalid: [\n---\ncurated");
  assert.equal((await prepareIndexProjection(bundle, planIndexProjection("test", []), { force: true })).ready, false);
});

test("remote timezone cancellation stops retries and a fresh read can recover", async () => {
  const storage = new MemoryBackend();
  const version = await storage.writeReserved("", "index.md", "---\nsuperbee_base_time_zone: America/New_York\n---\n");
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const remote = new RemoteBackend({ baseUrl: "http://timezone.local", bundle: "test", fetchImpl: async (request) => {
    calls++;
    if (calls === 1) {
      entered();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    }
    return new Response(JSON.stringify({ content: "---\nsuperbee_base_time_zone: America/New_York\n---\n" }), { headers: { "X-Version": version } });
  } });
  const controller = new AbortController();
  const pending = readBundleTimeZone(remote, { signal: controller.signal });
  await started;
  const reason = new Error("settings deadline");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 1, "cancellation must not retry the blocked transport");
  assert.equal((await readBundleTimeZone(remote)).timeZone, "America/New_York");
  assert.equal(calls, 2);
  await assert.rejects(readBundleTimeZone(remote, { signal: controller.signal }), (error) => error === reason);
  assert.equal(calls, 2, "already aborted reads must not start transport");
});
