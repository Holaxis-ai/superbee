/**
 * Observation-pass proofs: a bulk read lists each directory a constant number of times while every
 * path keeps the verdict a single `observeExact` reaches against the same state.
 *
 * - Scripted rows (every host) pin the trace: a port without a directory witness lists exactly as
 *   single reads do, and a witness that misses a change is caught by the end-of-pass listing.
 * - Scale rows (every host) count real `readdir` calls through `FilesystemBackend` and `query`.
 * - Native rows mutate a real case-insensitive volume mid-pass and compare each pass verdict with a
 *   single read of the same state. They use the production clock: fixtures are created once and
 *   left to settle past the reuse window, so a listing is reused only as it would be in production.
 *   Run them on coarse-timestamp volumes too by pointing TMPDIR at a mounted HFS+ or FAT32 image.
 *   They skip, with the reason, on a case-sensitive volume.
 */
import test, { before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { FilesystemBackend } from "../src/backend.js";
import { query } from "../src/engine.js";
import { FilesystemIdentityAliasError } from "../src/errors.js";
import {
  createNodeFilesystemIdentityPort,
  directoryWitnessTrusted,
  observeExact,
  openObservationPass,
  type DirectoryWitness,
  type FilesystemIdentityPort,
  type Observation,
  type PortHandle,
} from "../src/filesystem-identity.js";
import { detectHostAliasing, type HostAliasing } from "./host-class.js";
import { ScriptedPort } from "./scripted-identity-port.js";

/** For scripted ports only: a clock far enough ahead that every directory counts as settled. */
const settledClock = (): number => Date.now() + 60_000;

type Outcome = { state: "exact"; text: string } | { state: "absent" } | { error: string };

async function outcome(observation: Promise<Observation<Buffer>>): Promise<Outcome> {
  try {
    const observed = await observation;
    return observed.state === "exact" ? { state: "exact", text: observed.value.toString("utf8") } : { state: "absent" };
  } catch (error) {
    return { error: (error as Error).name };
  }
}

// ── scripted ──────────────────────────────────────────────────────────────────

const SCRIPTED_ROOT = path.resolve(path.parse(process.cwd()).root, "root");

function scriptedTree(port: ScriptedPort, count: number): string[] {
  const rels: string[] = [];
  for (let index = 0; index < count; index++) {
    const rel = `items/item-${index}.md`;
    port.file(path.join(SCRIPTED_ROOT, rel), `body ${index}`);
    rels.push(rel);
  }
  return rels;
}

/** A scripted port plus a directory witness driven by a generation the test advances. */
function witnessed(port: ScriptedPort): { port: FilesystemIdentityPort; bump(): void } {
  let generation = 0n;
  const witness = async (dir: string): Promise<DirectoryWitness | null> =>
    port.node(dir) === null ? null : { dev: 1n, ino: BigInt(port.node(dir)!.ino), mtimeNs: generation, ctimeNs: generation };
  const wrapped: FilesystemIdentityPort = {
    probe: (target) => port.probe(target),
    entries: (dir) => port.entries(dir),
    directoryWitness: witness,
    open: (target) => port.open(target),
    readAll: (handle) => port.readAll(handle),
    close: (handle) => port.close(handle),
    stat: (target) => port.stat(target),
    mkdir: (dir) => port.mkdir(dir),
    writeTemp: (dir, name, bytes) => port.writeTemp(dir, name, bytes),
    link: (from, to) => port.link(from, to),
    rename: (from, to) => port.rename(from, to),
    unlink: (target) => port.unlink(target),
    claim: (key, identity) => port.claim(key, identity),
  };
  return { port: wrapped, bump: () => void (generation += 1n) };
}

test("pass over a port without a directory witness makes exactly the single-read calls", async () => {
  const single = new ScriptedPort({ aliasing: true });
  const batched = new ScriptedPort({ aliasing: true });
  const rels = scriptedTree(single, 5);
  scriptedTree(batched, 5);

  for (const rel of rels) await observeExact(single, SCRIPTED_ROOT, rel, (handle) => single.readAll(handle));
  const pass = openObservationPass(batched, SCRIPTED_ROOT, settledClock);
  for (const rel of rels) await pass.observe(rel, (handle) => batched.readAll(handle));
  assert.deepEqual(await pass.finish(), []);

  assert.deepEqual(batched.trace, single.trace);
});

test("pass reuses a settled listing: one listing per directory, then one end-of-pass check", async () => {
  const scripted = new ScriptedPort({ aliasing: true });
  const rels = scriptedTree(scripted, 200);
  const { port } = witnessed(scripted);
  const pass = openObservationPass(port, SCRIPTED_ROOT, settledClock);
  for (const rel of rels) {
    const observed = await outcome(pass.observe(rel, (handle) => scripted.readAll(handle)));
    assert.equal(observed && "state" in observed ? observed.state : observed, "exact");
  }
  assert.equal(scripted.ops("entries").filter((line) => line.includes(`${SCRIPTED_ROOT}${path.sep}items`)).length, 1);
  assert.deepEqual(await pass.finish(), []);
  assert.equal(scripted.ops("entries").filter((line) => line.includes(`${SCRIPTED_ROOT}${path.sep}items`)).length, 2);
});

test("pass does not reuse a listing whose directory times have not settled", async () => {
  const scripted = new ScriptedPort({ aliasing: true });
  const rels = scriptedTree(scripted, 10);
  const { port } = witnessed(scripted);
  // Witness times are generation 0 ns (1970); a clock at 1 s after the epoch has not moved past them.
  const pass = openObservationPass(port, SCRIPTED_ROOT, () => 1_000);
  for (const rel of rels) await pass.observe(rel, (handle) => scripted.readAll(handle));
  const itemListings = scripted.ops("entries").filter((line) => line.includes(`${SCRIPTED_ROOT}${path.sep}items`)).length;
  assert.equal(itemListings, 2 * rels.length, "an unsettled directory is listed per use, exactly as single reads do");
  assert.deepEqual(await pass.finish(), []);
});

test("pass relists when the witness changes and reaches the single-read verdict for a mid-pass alias", async () => {
  const scripted = new ScriptedPort({ aliasing: true });
  const rels = scriptedTree(scripted, 10);
  const { port, bump } = witnessed(scripted);
  const pass = openObservationPass(port, SCRIPTED_ROOT, settledClock);
  for (const [index, rel] of rels.entries()) {
    if (index === 4) {
      scripted.respell(path.join(SCRIPTED_ROOT, "items/item-7.md"), "ITEM-7.md");
      bump();
    }
    const batched = await outcome(pass.observe(rel, (handle) => scripted.readAll(handle)));
    const single = await outcome(observeExact(scripted, SCRIPTED_ROOT, rel, (handle) => scripted.readAll(handle)));
    assert.deepEqual(batched, single, rel);
  }
  assert.deepEqual(await outcome(pass.observe("items/item-7.md", (handle) => scripted.readAll(handle))), {
    error: "FilesystemIdentityAliasError",
  });
  assert.deepEqual(await pass.finish(), []);
});

test("end-of-pass listing reports every path verified against a listing a missed change made stale", async () => {
  const scripted = new ScriptedPort({ aliasing: true });
  const rels = scriptedTree(scripted, 10);
  // No bump: the witness misses the respelling, as a clock that failed to advance would.
  const { port } = witnessed(scripted);
  const pass = openObservationPass(port, SCRIPTED_ROOT, settledClock);
  for (const [index, rel] of rels.entries()) {
    if (index === 4) scripted.respell(path.join(SCRIPTED_ROOT, "items/item-7.md"), "ITEM-7.md");
    await outcome(pass.observe(rel, (handle) => scripted.readAll(handle)));
  }
  const retry = await pass.finish();
  assert.deepEqual(retry, ["items/item-7.md"], "the one verdict the end-of-pass post-walk no longer supports is re-read");
  assert.deepEqual(await outcome(observeExact(scripted, SCRIPTED_ROOT, "items/item-7.md", (handle) => scripted.readAll(handle))), {
    error: "FilesystemIdentityAliasError",
  });
});

test("on Linux only known local filesystem types offer a directory witness; other platforms always do", () => {
  for (const local of [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]) assert.equal(directoryWitnessTrusted("linux", local), true);
  // NFS, CIFS, SMB2, FUSE, 9p, Ceph, an unknown type, and a failed statfs.
  for (const remote of [0x6969, 0xff534d42, 0xfe534d42, 0x65735546, 0x01021997, 0x00c36400, 0x12345678]) {
    assert.equal(directoryWitnessTrusted("linux", remote), false, remote.toString(16));
  }
  assert.equal(directoryWitnessTrusted("linux", null), false);
  assert.equal(directoryWitnessTrusted("darwin", null), true);
  assert.equal(directoryWitnessTrusted("win32", null), true);
});

test("a pass over a port that offers no witness for a directory lists it per use", async () => {
  const scripted = new ScriptedPort({ aliasing: true });
  const rels = scriptedTree(scripted, 6);
  const { port } = witnessed(scripted);
  const untrusted: FilesystemIdentityPort = { ...port, directoryWitness: async () => null };
  const pass = openObservationPass(untrusted, SCRIPTED_ROOT, settledClock);
  for (const rel of rels) await pass.observe(rel, (handle) => scripted.readAll(handle));
  assert.equal(scripted.ops("entries").filter((line) => line.includes(`${SCRIPTED_ROOT}${path.sep}items`)).length, 2 * rels.length);
  assert.deepEqual(await pass.finish(), []);
});

// ── scale (real filesystem, every host) ──────────────────────────────────────

async function generateBundle(prefix: string, count: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `superbee-identity-pass-${prefix}-`));
  await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n# scale\n");
  await mkdir(path.join(root, "menu-items"));
  for (let index = 0; index < count; index++) {
    const id = `item-${String(index).padStart(5, "0")}`;
    await writeFile(
      path.join(root, "menu-items", `${id}.md`),
      `---\ntype: MenuItem\ntitle: Item ${index}\ngenerated:\n  by: 'process:scale'\n  at: '2026-10-01T00:00:00.000Z'\n---\nItem ${index}.\n`,
    );
  }
  return root;
}

/** Count real `readdir` calls per directory basename while `fn` runs. */
async function countListings<T>(fn: () => Promise<T>): Promise<{ result: T; listings: Map<string, number> }> {
  const listings = new Map<string, number>();
  const original = fsp.readdir;
  fsp.readdir = (async (dir: Parameters<typeof original>[0], ...rest: unknown[]) => {
    const name = path.basename(String(dir));
    listings.set(name, (listings.get(name) ?? 0) + 1);
    return (original as (...args: unknown[]) => unknown)(dir, ...rest);
  }) as typeof original;
  try {
    return { result: await fn(), listings };
  } finally {
    fsp.readdir = original;
  }
}

test("a whole-bundle query over 3,000 documents in one directory lists that directory a constant number of times", async () => {
  const root = await generateBundle("scale", 3_000);
  try {
    // A listing is reused only once the directory's times have settled (see SETTLED_AFTER_NS).
    await sleep(3_200);
    const backend = new FilesystemBackend(root);
    const { result, listings } = await countListings(() => query(backend));
    assert.equal(result.length, 3_000);
    // list() walks the directory once; the pass lists it once and checks it once at the end.
    const menuListings = listings.get("menu-items") ?? 0;
    assert.ok(menuListings >= 2, `menu-items/ was listed ${menuListings} times: the count no longer sees listings`);
    assert.ok(menuListings <= 4, `menu-items/ was listed ${menuListings} times for 3,000 documents`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readMany answers exactly what per-document reads answer, including the first failure", async () => {
  const root = await generateBundle("equivalence", 60);
  try {
    await mkdir(path.join(root, "menu-items", "nested"));
    await writeFile(path.join(root, "menu-items", "nested", "deep.md"), "---\ntype: MenuItem\n---\nDeep.\n");
    await sleep(3_200);
    const backend = new FilesystemBackend(root);
    const ids = [...(await backend.list())];
    const batched = await backend.readMany(ids);
    const single = [];
    for (const id of ids) single.push(await backend.read(id));
    assert.deepEqual(batched, single);

    const absent = [ids[0]!, "menu-items/missing", ids[1]!];
    // The backend's own not-found (no `errno`), never a raw filesystem error.
    await assert.rejects(backend.readMany(absent), (error: NodeJS.ErrnoException) => error.code === "ENOENT" && error.errno === undefined);
    await writeFile(path.join(root, "menu-items", "item-00003.md"), "---\ntype: [unclosed\n---\nbroken\n");
    await assert.rejects(backend.readMany(ids), (error: Error) => error.name === "MalformedDocumentError");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── native: a real case-insensitive volume ────────────────────────────────────

let hostPromise: Promise<HostAliasing> | undefined;
const host = (): Promise<HostAliasing> => (hostPromise ??= detectHostAliasing());

/** Skip, with the reason, unless the temp volume equates differently cased spellings. */
async function requireCaseInsensitive(t: TestContext): Promise<HostAliasing | null> {
  const detected = await host();
  if (!detected.case) {
    t.skip(`needs a case-insensitive filesystem (e.g. default macOS APFS); ${tmpdir()} is case-sensitive (host class '${detected.hostClass}')`);
    return null;
  }
  return detected;
}

async function nativeFixture(prefix: string, names: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `superbee-identity-pass-native-${prefix}-`));
  await mkdir(path.join(root, "menu-items"));
  for (const name of names) await writeFile(path.join(root, "menu-items", `${name}.md`), `body of ${name}`);
  return root;
}

const ITEMS = Array.from({ length: 20 }, (_, index) => `item-${String(index).padStart(2, "0")}`);
const NFD_NAME = "cafe\u0301-menu";

/**
 * Every native fixture, created once and then left alone past the reuse window, so each row runs
 * against settled directories with the production clock, as a bulk read in production would.
 */
const fixtures = new Map<string, string>();
const fixture = (name: string): string => {
  const root = fixtures.get(name);
  assert.ok(root, `fixture ${name} was not prepared`);
  return root;
};

before(async () => {
  if (!(await host()).case) return;
  for (const name of ["alias", "alias-during-read", "rename", "stale-witness", "replace"]) {
    fixtures.set(name, await nativeFixture(name, ITEMS));
  }
  const collision = await nativeFixture("collision", ["Item-Mixed", ...ITEMS]);
  await writeFile(path.join(collision, "index.md"), "---\nokf_version: '0.2'\n---\n# collision\n");
  fixtures.set("collision", collision);
  fixtures.set("normalization", await nativeFixture("normalization", [NFD_NAME, ...ITEMS]));
  const linked = await nativeFixture("linked-root", []);
  for (const name of ITEMS) await writeFile(path.join(linked, `${name}.md`), `body of ${name}`);
  fixtures.set("linked-root", linked);
  await sleep(SETTLE_MS);
});

/** Past the pass's three-second reuse window (`SETTLED_AFTER_NS`). */
const SETTLE_MS = 3_300;

/** The production port with its listings counted and an optional hook run after each read. */
function nativePort(afterRead?: (target: string) => Promise<void>): { port: FilesystemIdentityPort; listings: () => number } {
  const base = createNodeFilesystemIdentityPort();
  let count = 0;
  const targets = new WeakMap<object, string>();
  const port: FilesystemIdentityPort = {
    ...base,
    async entries(dir) {
      if (path.basename(dir) === "menu-items") count++;
      return base.entries(dir);
    },
    async open(target) {
      const opened = await base.open(target);
      targets.set(opened.handle, target);
      return opened;
    },
    async readAll(handle: PortHandle) {
      const bytes = await base.readAll(handle);
      if (afterRead) await afterRead(targets.get(handle) ?? "");
      return bytes;
    },
  };
  return { port, listings: () => count };
}

/** Run a pass over `ITEMS`, calling `between(index)` before each, and compare with a single read of the same state. */
async function passMatchesSingleReads(
  root: string,
  port: FilesystemIdentityPort,
  between: (index: number) => Promise<void>,
  changedAfterRead: string[] = [],
): Promise<Map<string, Outcome>> {
  const single = createNodeFilesystemIdentityPort();
  const pass = openObservationPass(port, root);
  const outcomes = new Map<string, Outcome>();
  for (const [index, name] of ITEMS.entries()) {
    await between(index);
    const rel = `menu-items/${name}.md`;
    const batched = await outcome(pass.observe(rel, (handle) => port.readAll(handle)));
    const reference = await outcome(observeExact(single, root, rel, (handle) => single.readAll(handle)));
    assert.deepEqual(batched, reference, `${rel}: the pass and a single read disagree`);
    outcomes.set(name, batched);
  }
  // finish() repeats the post-walk without trusting timestamps, so exactly the documents changed
  // after they were read are handed back for a fresh single read.
  assert.deepEqual(await pass.finish(), changedAfterRead);
  return outcomes;
}

test("native pass: an alias created mid-pass is refused exactly as a single read refuses it", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = fixture("alias");
  try {
    const { port, listings } = nativePort();
    let listedBeforeChange = 0;
    const outcomes = await passMatchesSingleReads(root, port, async (index) => {
      if (index === 5) {
        listedBeforeChange = listings();
        await rename(path.join(root, "menu-items", "item-12.md"), path.join(root, "menu-items", "ITEM-12.md"));
      }
    });
    assert.equal(listedBeforeChange, 1, "the settled listing was taken once and reused for the first five documents");
    assert.deepEqual(outcomes.get("item-12"), { error: "FilesystemIdentityAliasError" });
    assert.deepEqual(outcomes.get("item-13"), { state: "exact", text: "body of item-13" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: an alias created while a document is being read is refused at its post-walk", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = fixture("alias-during-read");
  const from = path.join(root, "menu-items", "item-07.md");
  try {
    const { port } = nativePort(async (target) => {
      if (target === from) await rename(from, path.join(root, "menu-items", "ITEM-07.md"));
    });
    const pass = openObservationPass(port, root);
    for (const name of ITEMS.slice(0, 7)) await pass.observe(`menu-items/${name}.md`, (handle) => port.readAll(handle));
    await assert.rejects(pass.observe("menu-items/item-07.md", (handle) => port.readAll(handle)), FilesystemIdentityAliasError);
    assert.deepEqual(await pass.finish(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: renames between the start and end listings reach the single-read verdicts", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = fixture("rename");
  const dir = path.join(root, "menu-items");
  try {
    const { port } = nativePort();
    const outcomes = await passMatchesSingleReads(root, port, async (index) => {
      if (index === 6) {
        await rename(path.join(dir, "item-03.md"), path.join(dir, "item-03-old.md")); // already read
        await rename(path.join(dir, "item-15.md"), path.join(dir, "item-15-moved.md")); // not yet read
        await rename(path.join(dir, "item-16.md"), path.join(dir, "Item-16.md")); // case-only rename
        await rename(path.join(dir, "item-17.md"), path.join(dir, "ITEM-17.md")); // away ...
        await rename(path.join(dir, "ITEM-17.md"), path.join(dir, "item-17.md")); // ... and back
      }
    }, ["menu-items/item-03.md"]);
    assert.deepEqual(outcomes.get("item-03"), { state: "exact", text: "body of item-03" });
    assert.deepEqual(outcomes.get("item-15"), { state: "absent" });
    assert.deepEqual(outcomes.get("item-16"), { error: "FilesystemIdentityAliasError" });
    assert.deepEqual(outcomes.get("item-17"), { state: "exact", text: "body of item-17" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: the end-of-pass listing catches a rename the directory witness missed", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = fixture("stale-witness");
  const dir = path.join(root, "menu-items");
  try {
    const base = nativePort().port;
    let frozen: DirectoryWitness | null = null;
    // A witness frozen at its first answer: the timestamps-lie case the end check exists for.
    const port: FilesystemIdentityPort = {
      ...base,
      async directoryWitness(target) {
        if (path.basename(target) !== "menu-items") return base.directoryWitness!(target);
        return (frozen ??= await base.directoryWitness!(target));
      },
    };
    const pass = openObservationPass(port, root);
    for (const [index, name] of ITEMS.entries()) {
      if (index === 5) await rename(path.join(dir, "item-12.md"), path.join(dir, "ITEM-12.md"));
      await outcome(pass.observe(`menu-items/${name}.md`, (handle) => port.readAll(handle)));
    }
    const retry = await pass.finish();
    assert.ok(retry.includes("menu-items/item-12.md"), "the stale verdict is reported for a fresh read");
    await assert.rejects(
      observeExact(base, root, "menu-items/item-12.md", (handle) => base.readAll(handle)),
      FilesystemIdentityAliasError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: a mixed-case collision is refused through readMany and the pass alike", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = fixture("collision");
  try {
    const backend = new FilesystemBackend(root);
    assert.equal((await backend.readMany(["menu-items/Item-Mixed"]))[0]!.doc.body.trim(), "body of Item-Mixed");
    await assert.rejects(backend.readMany(["menu-items/Item-Mixed", "menu-items/item-mixed"]), FilesystemIdentityAliasError);
    await assert.rejects(backend.readMany(["menu-items/ITEM-MIXED"]), FilesystemIdentityAliasError);

    const { port } = nativePort();
    const pass = openObservationPass(port, root);
    const read = (handle: PortHandle) => port.readAll(handle);
    assert.deepEqual(await outcome(pass.observe("menu-items/Item-Mixed.md", read)), { state: "exact", text: "body of Item-Mixed" });
    assert.deepEqual(await outcome(pass.observe("menu-items/item-mixed.md", read)), { error: "FilesystemIdentityAliasError" });
    assert.deepEqual(await outcome(pass.observe("Menu-Items/item-00.md", read)), { error: "FilesystemIdentityAliasError" });
    assert.deepEqual(await pass.finish(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: a normalization variant (NFC vs NFD) reaches the single-read verdict", async (t) => {
  const detected = await requireCaseInsensitive(t);
  if (!detected) return;
  const nfd = NFD_NAME;
  const nfc = nfd.normalize("NFC");
  const root = fixture("normalization");
  try {
    const { port } = nativePort();
    const single = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, root);
    for (const name of [...ITEMS, nfd, nfc]) {
      const rel = `menu-items/${name}.md`;
      const batched = await outcome(pass.observe(rel, (handle) => port.readAll(handle)));
      assert.deepEqual(batched, await outcome(observeExact(single, root, rel, (handle) => single.readAll(handle))), rel);
    }
    assert.deepEqual(await outcome(pass.observe(`menu-items/${nfd}.md`, (handle) => port.readAll(handle))), {
      state: "exact",
      text: `body of ${nfd}`,
    });
    assert.deepEqual(
      await outcome(pass.observe(`menu-items/${nfc}.md`, (handle) => port.readAll(handle))),
      detected.normalization ? { error: "FilesystemIdentityAliasError" } : { state: "absent" },
    );
    assert.deepEqual(await pass.finish(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: a file replaced during the pass returns a real state of that file", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = fixture("replace");
  const dir = path.join(root, "menu-items");
  const replace = async (name: string, text: string): Promise<void> => {
    const tmp = path.join(dir, `.${name}.replacement.tmp`);
    await writeFile(tmp, text);
    await rename(tmp, path.join(dir, `${name}.md`));
  };
  const duringRead = path.join(dir, "item-11.md");
  let replacedDuringRead = false;
  try {
    const { port } = nativePort(async (target) => {
      if (target === duringRead && !replacedDuringRead) {
        replacedDuringRead = true;
        await replace("item-11", "item-11 replaced during its read");
      }
    });
    const outcomes = new Map<string, Outcome>();
    const pass = openObservationPass(port, root);
    for (const [index, name] of ITEMS.entries()) {
      if (index === 5) await replace("item-10", "item-10 replaced between reads");
      outcomes.set(name, await outcome(pass.observe(`menu-items/${name}.md`, (handle) => port.readAll(handle))));
    }
    assert.deepEqual(await pass.finish(), []);
    assert.deepEqual(outcomes.get("item-10"), { state: "exact", text: "item-10 replaced between reads" });
    // The post-walk sees the leaf no longer reaches the handle's inode and restarts on the new file.
    assert.deepEqual(outcomes.get("item-11"), { state: "exact", text: "item-11 replaced during its read" });
    assert.deepEqual(outcomes.get("item-12"), { state: "exact", text: "body of item-12" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: a bundle root reached through a symbolic link is witnessed by the directory it names", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const target = fixture("linked-root");
  const link = `${target}-link`;
  try {
    try {
      await symlink(target, link, "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
      t.skip(`needs symbolic links; ${tmpdir()} refused one (${code}), as FAT volumes do`);
      return;
    }
    const port = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, link);
    const read = (handle: PortHandle) => port.readAll(handle);
    assert.deepEqual(await outcome(pass.observe("item-00.md", read)), { state: "exact", text: "body of item-00" });
    await rename(path.join(target, "item-05.md"), path.join(target, "ITEM-05.md"));
    assert.deepEqual(await outcome(pass.observe("item-05.md", read)), { error: "FilesystemIdentityAliasError" });
    assert.deepEqual(await pass.finish(), []);
  } finally {
    await rm(link, { force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("native pass: a directory changed moments ago is not reused, so a same-tick alias is refused in the moment", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  // Created now and NOT left to settle: on a volume with 1 s (HFS+) or 2 s (FAT) ticks, the rename
  // below usually lands in the same tick as the fixture's last write and leaves the times unchanged.
  // Only the settle window keeps the pass from trusting that witness.
  const root = await nativeFixture("unsettled", ITEMS);
  try {
    const port = createNodeFilesystemIdentityPort();
    const single = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, root);
    const read = (handle: PortHandle) => port.readAll(handle);
    assert.deepEqual(await outcome(pass.observe("menu-items/item-00.md", read)), { state: "exact", text: "body of item-00" });
    await rename(path.join(root, "menu-items", "item-05.md"), path.join(root, "menu-items", "ITEM-05.md"));
    const batched = await outcome(pass.observe("menu-items/item-05.md", read));
    assert.deepEqual(batched, { error: "FilesystemIdentityAliasError" });
    assert.deepEqual(batched, await outcome(observeExact(single, root, "menu-items/item-05.md", (handle) => single.readAll(handle))));
    assert.deepEqual(await pass.finish(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
