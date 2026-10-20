import { promises as fs } from "node:fs";
import { FilesystemBackend } from "../../src/backend.js";
import { filesystemIdentityLockPath, FilesystemMutationLockError } from "../../src/filesystem-lock.js";
import { identityKey } from "../../src/filesystem-identity.js";
import type { InventoryGuardRequest } from "../../src/inventory-guard.js";

const [mode, root, inputPath, pause = "none", id = "items/new"] = process.argv.slice(2);
const backend = new FilesystemBackend(root!);
const input = inputPath && inputPath !== "-" ? JSON.parse(await fs.readFile(inputPath, "utf8")) as InventoryGuardRequest : undefined;
let released = false;
const resume = new Promise<void>(resolve => process.on("message", message => { if (message === "resume") { released = true; resolve(); } }));
const send = (data: Record<string, unknown>) => process.send?.(data);
const originalMkdir = fs.mkdir;
const originalRename = fs.rename;
const originalWriteFile = fs.writeFile;
const leaf = filesystemIdentityLockPath(await identityKey(root!, `${input?.id ?? id}.md`), root!);
let paused = false;
async function barrier(phase: string) { paused = true; send({ type: "paused", phase }); if (!released) await resume; }
fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
  if (!paused && pause === "leaf" && String(args[0]) === leaf) await barrier("after-comparison-before-leaf");
  return originalMkdir(...args);
}) as typeof fs.mkdir;
fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
  const result = await originalWriteFile(...args);
  if (!paused && pause === "established" && String(args[0]).includes(".tmp")) await barrier("root-established-before-publication");
  return result;
}) as typeof fs.writeFile;
fs.rename = async (from, to) => {
  const result = await originalRename(from, to);
  if (!paused && pause === "published" && String(to).endsWith(`${input?.id}.md`)) await barrier("published-before-response");
  return result;
};
send({ type: "attempting" });
for (;;) {
  try {
    let result: unknown;
    if (mode === "guard") result = await backend.inventoryGuard.compareInventoryAndWrite(input!);
    else if (mode === "observe") result = await backend.inventoryGuard.observeTarget();
    else if (mode === "reserved") result = await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
    else if (mode === "delete") result = await backend.delete(id!);
    else if (mode === "blob") result = await backend.writeBlob("artifacts/new.bin", new Uint8Array([1]));
    else if (mode === "delete-blob") result = await backend.deleteBlob("artifacts/missing.bin");
    else result = await backend.write(id!, { id: id!, frontmatter: { type: "Item" }, body: "phantom" });
    send({ type: "fulfilled", result });
    break;
  } catch (error) {
    if (error instanceof FilesystemMutationLockError) { send({ type: "blocked", owner: error.owner }); continue; }
    send({ type: "refused", name: (error as Error).name, reason: (error as { reason?: string }).reason, message: (error as Error).message });
    break;
  }
}
process.disconnect?.();
