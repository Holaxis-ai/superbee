import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FilesystemBackend } from "../src/backend.js";
import { filesystemRootMutationKey } from "../src/filesystem-identity.js";
import { filesystemIdentityLockPath } from "../src/filesystem-lock.js";
import { INVENTORY_GUARD_DOMAIN, type InventoryGuardRequest } from "../src/inventory-guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = (id: string, body = "before") => ({ id, frontmatter: { type: "Convention", governs: "Item" }, body });
async function arena() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "inventory-xproc-"));
  const root = path.join(directory, "bundle");
  const backend = new FilesystemBackend(root);
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  await backend.write("conventions/item", doc("conventions/item"));
  return { directory, root, backend };
}
async function inputFile(directory: string, backend: FilesystemBackend) {
  const inventory = await Promise.all((await backend.list()).map(async id => ({ id, version: (await backend.read(id)).version })));
  const input: InventoryGuardRequest = { target: await backend.inventoryGuard.observeTarget(), domain: INVENTORY_GUARD_DOMAIN, inventory, id: "conventions/item", expectedVersion: inventory.find(row => row.id === "conventions/item")!.version, doc: doc("conventions/item", "after") };
  const filename = path.join(directory, "request.json");
  await fs.writeFile(filename, JSON.stringify(input));
  return filename;
}
type Message = { type: string; owner?: { token: string }; reason?: string; result?: unknown };
class Child {
  process: ChildProcess;
  messages: Message[] = [];
  wake: (() => void)[] = [];
  closed = false;
  stderr = "";
  exit: Promise<void>;
  constructor(mode: string, root: string, input = "-", pause = "none", id = "items/new") {
    this.process = spawn(process.execPath, ["--import", path.join(here, "ts-loader.mjs"), path.join(here, "fixtures/inventory-guard-child.ts"), mode, root, input, pause, id], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    this.process.stderr?.on("data", chunk => { this.stderr += chunk; });
    this.process.on("message", message => { this.messages.push(message as Message); this.wake.splice(0).forEach(fn => fn()); });
    this.exit = new Promise(resolve => this.process.on("exit", () => { this.closed = true; this.wake.splice(0).forEach(fn => fn()); resolve(); }));
  }
  async next(type: string, bound = 15_000): Promise<Message> {
    const deadline = Date.now() + bound;
    for (;;) {
      const found = this.messages.find(message => message.type === type);
      if (found) return found;
      const result = this.messages.find(message => message.type === "fulfilled" || message.type === "refused");
      if (result) throw new Error(`Expected ${type} before result: ${JSON.stringify(result)}`);
      if (this.closed) throw new Error(`Child exited: ${this.stderr}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${type}: ${this.stderr}`);
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, remaining); this.wake.push(() => { clearTimeout(timer); resolve(); }); });
    }
  }
  resume() { this.process.send("resume"); }
  async stop() { if (!this.closed) this.process.kill("SIGKILL"); await this.exit; }
}
async function owner(root: string) {
  const key = await filesystemRootMutationKey(root);
  return JSON.parse(await fs.readFile(path.join(filesystemIdentityLockPath(key, root), "owner.json"), "utf8")) as { token: string };
}

test("filesystem participation: all mediated mutation entries wait for the guard root interval", async () => {
  const a = await arena(); const children: Child[] = [];
  try {
    const guard = new Child("guard", a.root, await inputFile(a.directory, a.backend), "leaf"); children.push(guard);
    await guard.next("paused");
    const held = await owner(a.root);
    for (const mode of ["write", "delete", "reserved", "blob", "delete-blob"]) children.push(new Child(mode, a.root));
    for (const child of children.slice(1)) assert.equal((await child.next("blocked")).owner?.token, held.token);
    assert.deepEqual(await a.backend.list(), ["conventions/item"]);
    guard.resume(); await guard.next("fulfilled");
    for (const child of children.slice(1)) await child.next("fulfilled");
    assert.equal((await a.backend.read("conventions/item")).doc.body.trim(), "after");
  } finally { await Promise.all(children.map(child => child.stop())); await fs.rm(a.directory, { recursive: true, force: true }); }
});

test("filesystem phantom comparison: a cooperating writer commits first, guard observes membership conflict", async () => {
  const a = await arena(); const children: Child[] = [];
  try {
    const input = await inputFile(a.directory, a.backend);
    const writer = new Child("write", a.root, "-", "leaf"); children.push(writer); await writer.next("paused");
    const held = await owner(a.root);
    const guard = new Child("guard", a.root, input); children.push(guard);
    assert.equal((await guard.next("blocked")).owner?.token, held.token);
    writer.resume(); await writer.next("fulfilled");
    assert.equal((await guard.next("refused")).reason, "membership");
    assert.equal((await a.backend.read("conventions/item")).doc.body.trim(), "before");
  } finally { await Promise.all(children.map(child => child.stop())); await fs.rm(a.directory, { recursive: true, force: true }); }
});

test("filesystem missing-root transition retains its coordination key and blocks a later guard", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "inventory-root-create-"));
  const root = path.join(directory, "not-yet-created"); const children: Child[] = [];
  try {
    const before = await filesystemRootMutationKey(root);
    const writer = new Child("reserved", root, "-", "established"); children.push(writer); await writer.next("paused");
    assert.equal(await filesystemRootMutationKey(root), before);
    const held = await owner(root);
    const observer = new Child("observe", root); children.push(observer);
    assert.equal((await observer.next("blocked")).owner?.token, held.token);
    writer.resume(); await writer.next("fulfilled"); await observer.next("fulfilled");
    assert.equal(await filesystemRootMutationKey(root), before);
  } finally { await Promise.all(children.map(child => child.stop())); await fs.rm(directory, { recursive: true, force: true }); }
});
for (const pause of ["leaf", "published"]) {
  test(`filesystem SIGKILL ${pause}: whole definition and existing dead-owner recovery`, async () => {
    const a = await arena(); const children: Child[] = [];
    try {
      const guard = new Child("guard", a.root, await inputFile(a.directory, a.backend), pause); children.push(guard); await guard.next("paused");
      await guard.stop();
      assert.equal((await a.backend.read("conventions/item")).doc.body.trim(), pause === "leaf" ? "before" : "after");
      await a.backend.write("items/recovered", { id: "items/recovered", frontmatter: { type: "Item" }, body: "recovered" });
      assert.equal(await a.backend.exists("items/recovered"), true);
    } finally { await Promise.all(children.map(child => child.stop())); await fs.rm(a.directory, { recursive: true, force: true }); }
  });
}
for (const direction of ["parent-guard", "child-guard"]) {
  test(`filesystem exact-root limitation: ${direction} does not cover independent overlapping roots`, async () => {
    const a = await arena(); const children: Child[] = [];
    try {
      const childRoot = path.join(a.root, "sub"); const childBackend = new FilesystemBackend(childRoot);
      await childBackend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
      await childBackend.write("conventions/item", doc("conventions/item"));
      const guarding = direction === "parent-guard" ? a.backend : childBackend;
      const guardedRoot = direction === "parent-guard" ? a.root : childRoot;
      const writingRoot = direction === "parent-guard" ? childRoot : a.root;
      const id = direction === "parent-guard" ? "items/new" : "sub/items/new";
      assert.notEqual(await filesystemRootMutationKey(guardedRoot), await filesystemRootMutationKey(writingRoot));
      const guard = new Child("guard", guardedRoot, await inputFile(a.directory, guarding), "leaf"); children.push(guard); await guard.next("paused");
      const writer = new Child("write", writingRoot, "-", "none", id); children.push(writer);
      await writer.next("fulfilled", 4_000);
      guard.resume(); await guard.next("fulfilled");
      assert.equal((await guarding.read("conventions/item")).doc.body.trim(), "after");
    } finally { await Promise.all(children.map(child => child.stop())); await fs.rm(a.directory, { recursive: true, force: true }); }
  });
}
