import { realpath } from "node:fs/promises";
import path from "node:path";

import { filesystemMutationLockPath } from "@superbee/core";
import { addCatalogEntry } from "../../src/catalog.js";
import {
  canonicalUserStateDir,
  ensureUserStateRoot,
  ensureUserStateRootForTest,
} from "../../src/user-state.js";

const [role, home, bundle] = process.argv.slice(2);
if (!role || !home) throw new Error("expected role and home");

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

async function waitForPublication(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onDisconnect = (): void => reject(new Error("parent disconnected before publication"));
    process.once("disconnect", onDisconnect);
    process.on("message", function onMessage(message: unknown) {
      if (!message || typeof message !== "object" || (message as Record<string, unknown>).type !== "publish") return;
      process.off("disconnect", onDisconnect);
      process.off("message", onMessage);
      resolve();
    });
  });
}

try {
  if (role === "creator") {
    const root = canonicalUserStateDir(home);
    const ready = await ensureUserStateRootForTest(home, {
      beforeMarkerPublication: async () => {
        send({
          type: "pre-marker",
          pid: process.pid,
          lockPath: filesystemMutationLockPath(await realpath(root), root),
        });
        await waitForPublication();
      },
    });
    send({ type: "result", status: "fulfilled", root: ready });
  } else if (role === "observer") {
    send({ type: "attempting", pid: process.pid });
    const ready = await ensureUserStateRoot(home);
    send({ type: "result", status: "fulfilled", root: ready });
  } else if (role === "catalog") {
    if (!bundle) throw new Error("catalog observer requires a bundle path");
    send({ type: "attempting", pid: process.pid });
    const result = await addCatalogEntry("observed", path.resolve(bundle), { home });
    send({ type: "result", status: "fulfilled", label: result.entry.label });
  } else {
    throw new Error(`unknown role: ${role}`);
  }
} catch (error) {
  send({
    type: "result",
    status: "rejected",
    message: error instanceof Error ? error.message : String(error),
  });
}

process.disconnect?.();
