/**
 * Observation-pass proofs: a bulk read lists each directory a constant number of times while every
 * path keeps the verdict a single `observeExact` reaches against the same state.
 *
 * - Scripted rows (every host) pin the trace: a port without a directory witness lists exactly as
 *   single reads do, and a witness that misses a change is caught by the end-of-pass listing.
 * - Scale rows (every host) count real `readdir` calls through `FilesystemBackend` and `query`.
 * - Native rows mutate a real case-insensitive volume mid-pass and compare each pass verdict with a
 *   single read of the same state. They skip, with the reason, on a case-sensitive volume.
 */
import test, { type TestContext } from "node:test";
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
  observeExact,
  openObservationPass,
  type DirectoryWitness,
  type FilesystemIdentityPort,
  type Observation,
  type PortHandle,
} from "../src/filesystem-identity.js";
import { detectHostAliasing, type HostAliasing } from "./host-class.js";
import { ScriptedPort } from "./scripted-identity-port.js";

/** A clock far enough ahead that every directory counts as settled, so reuse is exercised. */
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
  assert.deepEqual([...retry].sort(), [...rels].sort(), "every dependent of the stale listing is re-read");
  assert.deepEqual(await outcome(observeExact(scripted, SCRIPTED_ROOT, "items/item-7.md", (handle) => scripted.readAll(handle))), {
    error: "FilesystemIdentityAliasError",
  });
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
    await assert.rejects(backend.readMany(absent), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
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
): Promise<Map<string, Outcome>> {
  const single = createNodeFilesystemIdentityPort();
  const pass = openObservationPass(port, root, settledClock);
  const outcomes = new Map<string, Outcome>();
  for (const [index, name] of ITEMS.entries()) {
    await between(index);
    const rel = `menu-items/${name}.md`;
    const batched = await outcome(pass.observe(rel, (handle) => port.readAll(handle)));
    const reference = await outcome(observeExact(single, root, rel, (handle) => single.readAll(handle)));
    assert.deepEqual(batched, reference, `${rel}: the pass and a single read disagree`);
    outcomes.set(name, batched);
  }
  assert.deepEqual(await pass.finish(), [], "a witnessed change never needs an end-of-pass re-read");
  return outcomes;
}

test("native pass: an alias created mid-pass is refused exactly as a single read refuses it", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = await nativeFixture("alias", ITEMS);
  try {
    const { port, listings } = nativePort();
    const outcomes = await passMatchesSingleReads(root, port, async (index) => {
      if (index === 5) await rename(path.join(root, "menu-items", "item-12.md"), path.join(root, "menu-items", "ITEM-12.md"));
    });
    assert.deepEqual(outcomes.get("item-12"), { error: "FilesystemIdentityAliasError" });
    assert.deepEqual(outcomes.get("item-13"), { state: "exact", text: "body of item-13" });
    assert.ok(listings() <= 4, `menu-items/ listed ${listings()} times: the listing was not reused`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: an alias created while a document is being read is refused at its post-walk", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = await nativeFixture("alias-during-read", ITEMS);
  const from = path.join(root, "menu-items", "item-07.md");
  try {
    const { port } = nativePort(async (target) => {
      if (target === from) await rename(from, path.join(root, "menu-items", "ITEM-07.md"));
    });
    const pass = openObservationPass(port, root, settledClock);
    for (const name of ITEMS.slice(0, 7)) await pass.observe(`menu-items/${name}.md`, (handle) => port.readAll(handle));
    await assert.rejects(pass.observe("menu-items/item-07.md", (handle) => port.readAll(handle)), FilesystemIdentityAliasError);
    assert.deepEqual(await pass.finish(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native pass: renames between the start and end listings reach the single-read verdicts", async (t) => {
  if (!(await requireCaseInsensitive(t))) return;
  const root = await nativeFixture("rename", ITEMS);
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
    });
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
  const root = await nativeFixture("stale-witness", ITEMS);
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
    const pass = openObservationPass(port, root, settledClock);
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
  const root = await nativeFixture("collision", ["Item-Mixed", ...ITEMS]);
  try {
    await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n# collision\n");
    const backend = new FilesystemBackend(root);
    assert.equal((await backend.readMany(["menu-items/Item-Mixed"]))[0]!.doc.body.trim(), "body of Item-Mixed");
    await assert.rejects(backend.readMany(["menu-items/Item-Mixed", "menu-items/item-mixed"]), FilesystemIdentityAliasError);
    await assert.rejects(backend.readMany(["menu-items/ITEM-MIXED"]), FilesystemIdentityAliasError);

    const { port } = nativePort();
    const pass = openObservationPass(port, root, settledClock);
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
  const nfd = "café-menu";
  const nfc = nfd.normalize("NFC");
  const root = await nativeFixture("normalization", [nfd, ...ITEMS]);
  try {
    const { port } = nativePort();
    const single = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, root, settledClock);
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
  const root = await nativeFixture("replace", ITEMS);
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
    const pass = openObservationPass(port, root, settledClock);
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
  const target = await nativeFixture("linked-root", []);
  const link = `${target}-link`;
  try {
    for (const name of ITEMS) await writeFile(path.join(target, `${name}.md`), `body of ${name}`);
    await symlink(target, link, "dir");
    const port = createNodeFilesystemIdentityPort();
    const pass = openObservationPass(port, link, settledClock);
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
