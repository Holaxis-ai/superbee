import { readFile } from "node:fs/promises";

export async function waitForJsonFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      const retryable = error?.code === "ENOENT" || error instanceof SyntaxError;
      if (!retryable) throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for installed lock marker ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export function installedLockBoundaryPreloadSource() {
  return `import { promises as fs } from "node:fs";
import path from "node:path";

const barrierDir = process.env.ASLITE_INSTALLED_LOCK_BARRIER_DIR;
const role = process.env.ASLITE_INSTALLED_LOCK_BARRIER_ROLE;
if (!barrierDir || (role !== "holder" && role !== "contender")) {
  throw new Error("installed lock-boundary preload requires barrier directory and role");
}

const originalMkdir = fs.mkdir.bind(fs);
const originalWriteFile = fs.writeFile.bind(fs);
const releaseFile = path.join(barrierDir, "holder.release");
const holderAcquiredFile = path.join(barrierDir, "holder.acquired.json");
let boundaryObserved = false;
let holderLockPath;

async function waitFor(file) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error("timed out waiting for installed lock barrier " + file);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function mark(name, details) {
  await originalWriteFile(
    path.join(barrierDir, name),
    JSON.stringify({ ...details, node: process.versions.node }) + "\\n",
    "utf8",
  );
}

fs.mkdir = async function instrumentedMkdir(requested, options) {
  const lockPath = typeof requested === "string" ? requested : "";
  const lockRootName = lockPath ? path.basename(path.dirname(lockPath)) : "";
  const productionClaim =
    !boundaryObserved &&
    lockPath.endsWith(".lock") &&
    lockRootName.startsWith("agentstate-lite-mutation-locks-") &&
    options?.recursive !== true;
  if (!productionClaim) return originalMkdir(requested, options);

  boundaryObserved = true;
  await mark(role + ".attempt.json", { lock_path: lockPath });
  if (role === "holder") {
    const result = await originalMkdir(requested, options);
    holderLockPath = lockPath;
    return result;
  }

  await waitFor(holderAcquiredFile);
  try {
    const result = await originalMkdir(requested, options);
    await mark("contender.unexpected-acquire.json", { lock_path: lockPath });
    return result;
  } catch (error) {
    await mark("contender.contended.json", { lock_path: lockPath, fs_code: error?.code });
    throw error;
  }
};

// Let core finish its exclusive owner record write before stopping the holder.
// Until then core can recover the directory as an abandoned, ownerless claim.
fs.writeFile = async function instrumentedWriteFile(file, data, options) {
  const result = await originalWriteFile(file, data, options);
  if (holderLockPath && file === path.join(holderLockPath, "owner.json") && options?.flag === "wx") {
    await mark("holder.acquired.json", { lock_path: holderLockPath, owner_pid: process.pid });
    await waitFor(releaseFile);
  }
  return result;
};
`;
}
