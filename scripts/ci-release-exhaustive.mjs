import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";
import { verifyExhaustiveReleaseProof } from "./release-packet-exhaustive-proof.mjs";

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export function parseExpectedSha(argv) {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== "--expected-sha" || !/^[a-f0-9]{40}$/.test(argv[1])) {
    throw new Error("usage: ci-release-exhaustive.mjs [--expected-sha <40-hex-sha>]");
  }
  return argv[1];
}

export function assertExactCheckout(expectedSha) {
  const head = git("rev-parse", "HEAD");
  if (expectedSha && head !== expectedSha) {
    throw new Error(`exhaustive release proof expected ${expectedSha}, checked out ${head}`);
  }
  if (expectedSha) {
    const dirty = git("status", "--porcelain", "--untracked-files=no");
    if (dirty) throw new Error("exact-SHA exhaustive release proof requires a clean tracked checkout");
  }
  return head;
}

async function main(argv = process.argv.slice(2)) {
  const expectedSha = parseExpectedSha(argv);
  const before = assertExactCheckout(expectedSha);
  const npmCli = process.env.npm_execpath?.trim();
  if (!npmCli) throw new Error("npm_execpath is required; run this proof through npm");
  const receiptRoot = expectedSha ? mkdtempSync(path.join(tmpdir(), "superbee-exhaustive-proof-")) : null;
  const receipt = receiptRoot ? path.join(receiptRoot, "proof.json") : null;
  try {
    const proof = spawnSync(process.execPath, [npmCli, "run", "test:packet-candidates"], {
      stdio: "inherit",
      env: expectedSha ? {
        ...process.env,
        SUPERBEE_EXHAUSTIVE_SOURCE_COMMIT: expectedSha,
        SUPERBEE_EXHAUSTIVE_PROOF_OUT: receipt,
      } : process.env,
    });
    if (proof.status !== 0) throw new Error(`all-target release proof failed with exit ${proof.status ?? 1}`);
    if (expectedSha) {
      await verifyExhaustiveReleaseProof({ proof: receipt, commit: expectedSha });
    }
    const after = assertExactCheckout(expectedSha);
    if (after !== before) throw new Error(`checkout moved during exhaustive release proof: ${before} -> ${after}`);
    console.log(`all release targets proved from checked-out source ${after}`);
  } finally {
    if (receiptRoot) rmSync(receiptRoot, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
