/**
 * Adversarial rows from the independent exact-SHA review of #437 (review 5497869163), adopted
 * as written except where the fix inverts what they observed: ADV-1 and ADV-2 recorded that the
 * end-of-pass check missed a stale verdict when the directory witness lies; they now require it to
 * be reported for a fresh single read. ADV-3 to ADV-5 run the production clock against a real
 * volume; point TMPDIR at a mounted HFS+ or FAT32 image to exercise coarse timestamps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { FilesystemBackend } from "../src/backend.js";
import {
  createNodeFilesystemIdentityPort,
  observeExact,
  openObservationPass,
  type DirectoryWitness,
  type FilesystemIdentityPort,
  type Observation,
  type PortHandle,
} from "../src/filesystem-identity.js";
import { detectHostAliasing } from "./host-class.js";
import { ScriptedPort } from "./scripted-identity-port.js";

type Outcome = { state: "exact"; text: string } | { state: "absent" } | { error: string };
async function outcome(o: Promise<Observation<Buffer>>): Promise<Outcome> {
  try {
    const r = await o;
    return r.state === "exact" ? { state: "exact", text: r.value.toString("utf8") } : { state: "absent" };
  } catch (e) {
    return { error: (e as Error).name };
  }
}

const ROOT = path.resolve(path.parse(process.cwd()).root, "root");
const settledClock = (): number => Date.now() + 60_000;

/** Witness driven by a generation, like the PR's own helper, but the test controls when it lies. */
function witnessed(port: ScriptedPort): { port: FilesystemIdentityPort; bump(): void } {
  let generation = 0n;
  const wrapped = Object.create(port) as FilesystemIdentityPort;
  wrapped.directoryWitness = async (dir: string): Promise<DirectoryWitness | null> =>
    port.node(dir) === null ? null : { dev: 1n, ino: BigInt(port.node(dir)!.ino), mtimeNs: generation, ctimeNs: generation };
  for (const k of ["probe", "entries", "open", "readAll", "close", "stat", "mkdir", "writeTemp", "link", "rename", "unlink", "claim"] as const) {
    (wrapped as unknown as Record<string, unknown>)[k] = (port as unknown as Record<string, (...a: unknown[]) => unknown>)[k]!.bind(port);
  }
  return { port: wrapped, bump: () => void (generation += 1n) };
}

test("ADV-1: a missed change followed by a witnessed one still has its stale verdict reported by finish()", async () => {
  const scripted = new ScriptedPort({ aliasing: true });
  const rels: string[] = [];
  for (let i = 0; i < 10; i++) {
    scripted.file(path.join(ROOT, `items/item-${i}.md`), `body ${i}`);
    rels.push(`items/item-${i}.md`);
  }
  const { port, bump } = witnessed(scripted);
  const pass = openObservationPass(port, ROOT, settledClock);
  const got = new Map<string, Outcome>();
  for (const [index, rel] of rels.entries()) {
    if (index === 4) scripted.respell(path.join(ROOT, "items/item-7.md"), "ITEM-7.md"); // witness misses this
    if (index === 8) bump(); // ... and sees a later, unrelated change (e.g. attribute cache expiry)
    got.set(rel, await outcome(pass.observe(rel, (h) => scripted.readAll(h))));
  }
  const retry = await pass.finish();
  const single = await outcome(observeExact(scripted, ROOT, "items/item-7.md", (h) => scripted.readAll(h)));
  assert.deepEqual(single, { error: "FilesystemIdentityAliasError" }, "persistent state is an alias");
  assert.deepEqual(got.get("items/item-7.md"), { state: "exact", text: "body 7" }, "the lying witness let the pass answer EXACT in the moment");
  assert.deepEqual(retry, ["items/item-7.md"], "so the end-of-pass check reports it for a fresh single read");
});

test("ADV-2: a transient foreign file under the alias spelling, put back before finish, is reported by finish()", async () => {
  const scripted = new ScriptedPort({ aliasing: true });
  for (let i = 0; i < 4; i++) scripted.file(path.join(ROOT, `items/item-${i}.md`), `body ${i}`);
  const { port } = witnessed(scripted);
  const pass = openObservationPass(port, ROOT, settledClock);
  await pass.observe("items/item-0.md", (h) => scripted.readAll(h)); // keep the listing
  // item-2 is replaced by a DIFFERENT document spelled ITEM-2.md (new inode), witness misses it.
  await scripted.unlink(path.join(ROOT, "items/item-2.md"));
  scripted.file(path.join(ROOT, "items/ITEM-2.md"), "foreign document");
  const batched = await outcome(pass.observe("items/item-2.md", (h) => scripted.readAll(h)));
  const single = await outcome(observeExact(scripted, ROOT, "items/item-2.md", (h) => scripted.readAll(h)));
  // ... and is put back before finish.
  await scripted.unlink(path.join(ROOT, "items/ITEM-2.md"));
  scripted.file(path.join(ROOT, "items/item-2.md"), "body 2 restored");
  const retry = await pass.finish();
  assert.deepEqual(single, { error: "FilesystemIdentityAliasError" });
  assert.deepEqual(batched, { state: "exact", text: "foreign document" }, "the lying witness let the pass answer EXACT in the moment");
  assert.deepEqual(retry, ["items/item-2.md"], "the restored file is a different inode, so finish() reports the verdict");
  assert.deepEqual(
    await outcome(observeExact(scripted, ROOT, "items/item-2.md", (h) => scripted.readAll(h))),
    { state: "exact", text: "body 2 restored" },
    "and the fresh single read answers with the restored document",
  );
});

// ── production clock, real volume (run with TMPDIR on APFS / HFS+ / FAT32 images) ──

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sb-adv-"));
  await mkdir(path.join(root, "m"));
  for (let i = 0; i < 20; i++) await writeFile(path.join(root, "m", `item-${String(i).padStart(2, "0")}.md`), `body ${i}`);
  return root;
}

test("ADV-3 (production clock): same-tick case rename after the listing settles is refused like a single read", async () => {
  const root = await fixture();
  try {
    await sleep(3_300);
    const port = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, root); // Date.now, as production
    let entries = 0;
    const counted: FilesystemIdentityPort = { ...port, entries: async (d) => (entries++, port.entries(d)) };
    const p2 = openObservationPass(counted, root);
    for (let i = 0; i < 20; i++) {
      const rel = `m/item-${String(i).padStart(2, "0")}.md`;
      if (i === 5) {
        // Many changes inside one coarse tick: away, back, away.
        await rename(path.join(root, "m/item-12.md"), path.join(root, "m/ITEM-12.md"));
        await rename(path.join(root, "m/ITEM-12.md"), path.join(root, "m/item-12.md"));
        await rename(path.join(root, "m/item-12.md"), path.join(root, "m/Item-12.md"));
      }
      const a = await outcome(pass.observe(rel, (h) => port.readAll(h)));
      const b = await outcome(p2.observe(rel, (h) => counted.readAll(h)));
      const s = await outcome(observeExact(port, root, rel, (h) => port.readAll(h)));
      assert.deepEqual(a, s, rel);
      assert.deepEqual(b, s, rel);
    }
    assert.deepEqual(await pass.finish(), []);
    assert.deepEqual(await p2.finish(), []);
    // After the change at i=5 the directory is unsettled for 3 s: listings fall back to per-use.
    console.log(`# entries() calls for 20 docs after a mid-pass change: ${entries}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ADV-4 (production clock): delete-and-recreate the parent directory mid-pass (dev/ino reuse) is not reused", async () => {
  const root = await fixture();
  try {
    await sleep(3_300);
    const port = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, root);
    assert.equal((await outcome(pass.observe("m/item-00.md", (h) => port.readAll(h)))).hasOwnProperty("state"), true);
    await rm(path.join(root, "m"), { recursive: true });
    await mkdir(path.join(root, "m"));
    await writeFile(path.join(root, "m", "ITEM-01.md"), "foreign");
    const a = await outcome(pass.observe("m/item-01.md", (h) => port.readAll(h)));
    const s = await outcome(observeExact(port, root, "m/item-01.md", (h) => port.readAll(h)));
    assert.deepEqual(a, s);
    // item-00 was read before its directory was replaced, so finish() hands it back for a fresh read.
    assert.deepEqual(await pass.finish(), ["m/item-00.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ADV-5: readMany through the backend with a mid-batch alias created in-tick (production clock)", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n# x\n");
    await sleep(3_300);
    const backend = new FilesystemBackend(root);
    const ids = Array.from({ length: 20 }, (_, i) => `m/item-${String(i).padStart(2, "0")}`);
    // The backend's typed absence: the ENOENT-shaped rejection `notFound` builds, naming the exact
    // requested path. `readManyExisting` keys its per-document fallback on this code.
    const isNotFound = (rel: string) => (e: NodeJS.ErrnoException): boolean =>
      e.code === "ENOENT" && e.syscall === "open" && e.path === path.join(root, rel);
    // Respell before the batch. A case-insensitive host still reaches the file through the other
    // spelling, which is an alias; a case-sensitive host (ext4) has no `item-09.md` at all, which is
    // absence. Either way the batch rejects exactly as a per-document read of the same state does.
    await rename(path.join(root, "m/item-09.md"), path.join(root, "m/ITEM-09.md"));
    const caseAliasing = (await detectHostAliasing()).case;
    const respelled = caseAliasing
      ? (e: Error): boolean => e.name === "FilesystemIdentityAliasError"
      : isNotFound("m/item-09.md");
    await assert.rejects(backend.readMany(ids), respelled);
    await assert.rejects(backend.read("m/item-09"), respelled);
    await unlink(path.join(root, "m/ITEM-09.md"));
    // Gone under every spelling: typed absence on every host.
    await assert.rejects(backend.readMany(ids), isNotFound("m/item-09.md"));
    await assert.rejects(backend.read("m/item-09"), isNotFound("m/item-09.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ADV-5b (every host): a document deleted mid-pass after the listing was reused is a typed absence, never a thrown fs error", async () => {
  const root = await fixture();
  try {
    await sleep(3_300);
    const port = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, root);
    const read = (h: PortHandle) => port.readAll(h);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await outcome(pass.observe(`m/item-${String(i).padStart(2, "0")}.md`, read)), { state: "exact", text: `body ${i}` });
    }
    await unlink(path.join(root, "m/item-12.md"));
    await unlink(path.join(root, "m/item-03.md")); // already read: handed back by finish()
    assert.deepEqual(await outcome(pass.observe("m/item-12.md", read)), { state: "absent" });
    assert.deepEqual(await pass.finish(), ["m/item-03.md"]);
    assert.deepEqual(await outcome(observeExact(port, root, "m/item-03.md", read)), { state: "absent" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
