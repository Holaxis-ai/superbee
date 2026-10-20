import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { InventoryGuardConflict, InventoryGuardUnsupported, INVENTORY_GUARD_DOMAIN, inventoryGuardFor, type InventoryGuardRequest } from "../src/inventory-guard.js";
import { InvalidInputError } from "../src/errors.js";
import type { StorageBackend } from "../src/types.js";

const doc = (id = "conventions/item", body = "before") => ({ id, frontmatter: { type: "Convention", governs: "Item" }, body });
async function fixture(kind: "memory" | "filesystem") {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "inventory-guard-"));
  const backend: StorageBackend = kind === "memory" ? new MemoryBackend() : new FilesystemBackend(directory);
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  await backend.write("conventions/item", doc());
  return { backend, directory, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
async function request(backend: StorageBackend): Promise<InventoryGuardRequest> {
  const target = await inventoryGuardFor(backend).observeTarget();
  const ids = await backend.list();
  const inventory = await Promise.all(ids.map(async id => ({ id, version: (await backend.read(id)).version })));
  return { target, domain: INVENTORY_GUARD_DOMAIN, inventory, id: "conventions/item", expectedVersion: inventory.find(row => row.id === "conventions/item")!.version, doc: doc("conventions/item", "after"), options: { actor: "openai/codex" } };
}
for (const kind of ["memory", "filesystem"] as const) {
  for (const row of ["unchanged", "phantom", "delete", "retype", "body", "edition", "root", "target", "aba"] as const) {
    test(`${kind}: inventory agreement ${row}`, async () => {
      const f = await fixture(kind);
      try {
        if (["delete", "retype", "body", "aba"].includes(row)) await f.backend.write("items/a", { id: "items/a", frontmatter: { type: "Item" }, body: "a" });
        const input = await request(f.backend);
        const before = (await f.backend.read(input.id)).version;
        if (row === "phantom") await f.backend.write("items/new", { id: "items/new", frontmatter: { type: "Item" }, body: "new" });
        if (row === "delete" || row === "aba") await f.backend.delete("items/a");
        if (row === "aba") await f.backend.write("items/a", { id: "items/a", frontmatter: { type: "Item" }, body: "a" });
        if (row === "retype") await f.backend.write("items/a", { id: "items/a", frontmatter: { type: "Other" }, body: "a" });
        if (row === "body") await f.backend.write("items/a", { id: "items/a", frontmatter: { type: "Item" }, body: "changed" });
        if (row === "edition") await f.backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n");
        if (row === "root") await f.backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\nchanged\n");
        if (row === "target") await f.backend.write(input.id, doc(input.id, "other"));
        if (row === "unchanged" || row === "aba") {
          const result = await inventoryGuardFor(f.backend).compareInventoryAndWrite(input);
          assert.notEqual(result.version, before);
          assert.equal((await f.backend.read(input.id)).version, result.version);
          assert.match(result.inventory_digest, /^sha256:/);
          if (kind === "memory") assert.equal((await f.backend.versions(input.id))[0]!.actor, "openai/codex");
        } else {
          const immediate = (await f.backend.read(input.id)).version;
          await assert.rejects(inventoryGuardFor(f.backend).compareInventoryAndWrite(input), InventoryGuardConflict);
          assert.equal((await f.backend.read(input.id)).version, immediate);
        }
      } finally { await f.cleanup(); }
    });
  }
  test(`${kind}: cross-store identity, malformed data and unsupported overrides`, async () => {
    const a = await fixture(kind), b = await fixture(kind);
    try {
      const input = await request(a.backend);
      await assert.rejects(inventoryGuardFor(b.backend).compareInventoryAndWrite(input), error => error instanceof InventoryGuardConflict && error.reason === "identity");
      await assert.rejects(inventoryGuardFor(a.backend).compareInventoryAndWrite({ ...input, inventory: [...input.inventory, ...input.inventory] }), InvalidInputError);
      await assert.rejects(inventoryGuardFor(a.backend).compareInventoryAndWrite({ ...input, domain: "universal" } as never), InventoryGuardUnsupported);
      let invoked = false;
      const accessor = { ...input, get doc() { invoked = true; return input.doc; } };
      await assert.rejects(inventoryGuardFor(a.backend).compareInventoryAndWrite(accessor), InvalidInputError);
      assert.equal(invoked, false);
      const cap = inventoryGuardFor(a.backend);
      a.backend.write = async () => "sha256:override";
      await assert.rejects(cap.compareInventoryAndWrite(input), InventoryGuardUnsupported);
      assert.throws(() => inventoryGuardFor(a.backend), InventoryGuardUnsupported);
    } finally { await a.cleanup(); await b.cleanup(); }
  });
  test(`${kind}: captured request cannot be changed while queued`, async () => {
    const f = await fixture(kind);
    try {
      const input = await request(f.backend);
      const promise = inventoryGuardFor(f.backend).compareInventoryAndWrite(input);
      input.doc.body = "malicious late change";
      input.inventory.length = 0;
      const result = await promise;
      assert.equal((await f.backend.read(input.id)).doc.body.trim(), "after");
      assert.equal((await f.backend.read(input.id)).version, result.version);
    } finally { await f.cleanup(); }
  });
}
test("missing metadata, unsupported backend and subclasses refuse", async () => {
  const memory = new MemoryBackend();
  await assert.rejects(inventoryGuardFor(memory).observeTarget(), InventoryGuardUnsupported);
  assert.throws(() => inventoryGuardFor({} as StorageBackend), InventoryGuardUnsupported);
  assert.throws(() => inventoryGuardFor({ inventoryGuard: memory.inventoryGuard } as StorageBackend), InventoryGuardUnsupported);
  assert.throws(() => inventoryGuardFor(new Proxy(memory, {})), InventoryGuardUnsupported);
  class Child extends MemoryBackend {}
  assert.throws(() => inventoryGuardFor(new Child()), InventoryGuardUnsupported);
});
test("filesystem root replacement invalidates the observed physical identity", async () => {
  const f = await fixture("filesystem");
  const aside = `${f.directory}-aside`;
  try {
    const input = await request(f.backend);
    await fs.rename(f.directory, aside);
    await fs.cp(aside, f.directory, { recursive: true });
    await assert.rejects(inventoryGuardFor(f.backend).compareInventoryAndWrite(input), error => error instanceof InventoryGuardConflict && error.reason === "identity");
  } finally { await f.cleanup(); await fs.rm(aside, { recursive: true, force: true }); }
});

test("filesystem equivalent root spelling shares the target; another namespace does not", async () => {
  const f = await fixture("filesystem");
  const alias = `${f.directory}-alias`;
  const { captureFilesystemHostPolicy } = await import("../src/filesystem-host.js");
  const { filesystemMutationLockRoot } = await import("../src/filesystem-lock.js");
  const base = captureFilesystemHostPolicy();
  const otherPolicy = { ...base, runtimeOwnerKey: () => `${base.runtimeOwnerKey()}-inventory-guard-${process.pid}` };
  let otherLockRoot: string | undefined;
  try {
    await fs.symlink(f.directory, alias, "dir");
    const input = await request(f.backend);
    const aliased = new FilesystemBackend(alias);
    assert.equal((await aliased.inventoryGuard.observeTarget()).store, input.target.store);
    await aliased.inventoryGuard.compareInventoryAndWrite(input);
    const current = await request(f.backend);
    const anotherNamespace = new FilesystemBackend(f.directory, { hostPolicy: otherPolicy });
    otherLockRoot = filesystemMutationLockRoot(f.directory, otherPolicy);
    await assert.rejects(anotherNamespace.inventoryGuard.compareInventoryAndWrite(current), error => error instanceof InventoryGuardConflict && error.reason === "identity");
  } finally {
    await fs.rm(alias, { force: true });
    await f.cleanup();
    if (otherLockRoot) await fs.rm(otherLockRoot, { recursive: true, force: true });
  }
});

test("filesystem malformed document leaves the guarded definition unchanged", async () => {
  const f = await fixture("filesystem");
  try {
    const input = await request(f.backend);
    await fs.writeFile(path.join(f.directory, "malformed.md"), "---\ntype: [\n---\n");
    await assert.rejects(inventoryGuardFor(f.backend).compareInventoryAndWrite(input));
    assert.equal((await f.backend.read(input.id)).version, input.expectedVersion);
  } finally { await f.cleanup(); }
});
