// Operator tool: perform the mandatory staged-tarball inspection and emit the SIGNED receipt the
// finalize ordering gate consumes. Emission IS the inspection — the tool downloads the staged
// tarball itself, hashes it, compares against the draft's retained candidate.json, and only a
// MATCH can produce an inspection receipt; a mismatch prints the reject command and exits 1.
// `--decision approved` emits the approval receipt AFTER `npm stage approve` (+2FA), first
// checking the registry really shows the version public with the candidate's integrity.
//
// Runs on the OPERATOR's machine with their own gh auth + ssh key — no CI token can produce these
// receipts. Batch mode loops candidates so one sitting emits every receipt (one per candidate).
//
// Usage:
//   node scripts/release-inspect.mjs --stage-id <uuid> --version <semver> --draft-release-id <id> \
//     --key <ssh-private-key> [--decision inspected|approved] [--repo <owner/repo>]
//   node scripts/release-inspect.mjs --batch <candidates.json> --key <path> [--repo <owner/repo>]
//     (candidates.json: [{ "stage_id": "...", "version": "...", "draft_release_id": "...", "decision"?: "..." }])
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rejectOperation } from "./release-operations.mjs";
import { stageDownloadFilename } from "./release-receipts.mjs";
import { canonicalPayloadBytes, canonicalReceiptPayload, receiptAssetName, SIGN_NAMESPACE } from "./release-ordering.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const PKG = "@holaxis/aslite";

function arg(argv, flag, required = true) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if (!value || value.startsWith("--")) {
    if (required) throw new Error(`missing ${flag}`);
    return undefined;
  }
  return value;
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function gh(args, options = {}) {
  return run("gh", args, options);
}

async function emitReceipt({ decision, stageId, version, draftReleaseId, keyPath, repo }) {
  const scratch = mkdtempSync(path.join(tmpdir(), "aslite-release-inspect-"));
  try {
    const release = JSON.parse(gh(["api", `repos/${repo}/releases/${draftReleaseId}`]));
    if (release.draft !== true) throw new Error(`release ${draftReleaseId} is not an unpublished draft`);
    const expectedTag = `v${version}`;
    if (release.tag_name !== expectedTag) {
      throw new Error(`draft release tag ${String(release.tag_name)} does not match expected ${expectedTag}`);
    }
    const manifestAsset = (release.assets ?? []).find((asset) => asset?.name === "candidate.json");
    if (!manifestAsset) throw new Error("draft release carries no candidate.json asset");
    const manifestBytes = execFileSync(
      "gh",
      ["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${manifestAsset.id}`],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const candidate = JSON.parse(manifestBytes.toString("utf8"));
    if (candidate.version !== version) throw new Error(`draft candidate version ${candidate.version} != ${version}`);
    const expectedSha = candidate.tarball?.sha256;
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedSha ?? "")) throw new Error("candidate.json carries no tarball sha256");
    const actor = gh(["api", "user", "--jq", ".login"]).trim();

    let observed;
    if (decision === "inspected") {
      run("npm", ["stage", "download", stageId], { cwd: scratch, stdio: "inherit", encoding: undefined });
      const tarball = path.join(scratch, stageDownloadFilename(version, stageId));
      observed = `sha256:${createHash("sha256").update(await readFile(tarball)).digest("hex")}`;
      if (observed !== expectedSha) {
        console.error(`MISMATCH: staged tarball ${observed} != retained candidate ${expectedSha}`);
        console.error(`The staged bytes are NOT the retained candidate. Reject the stage:`);
        console.error(`  ${rejectOperation({ stageId }).command}`);
        throw new Error("inspection mismatch; receipt not emitted");
      }
      console.log(`MATCH: staged tarball ${observed}`);
    } else {
      const dist = JSON.parse(run("npm", ["view", `${PKG}@${version}`, "dist", "--json"]));
      if (dist?.integrity !== candidate.tarball?.integrity) {
        throw new Error(
          `registry does not show ${PKG}@${version} public with the candidate integrity — approve the stage (npm stage approve ${stageId}) before emitting the approval receipt`,
        );
      }
    }

    const payload = canonicalReceiptPayload({
      decision,
      stage_id: stageId,
      version,
      tarball_sha256: expectedSha,
      draft_release_id: String(draftReleaseId),
      actor,
      emitted_at: new Date().toISOString(),
      ...(decision === "inspected" ? { observed_sha256: observed } : {}),
    });
    const messagePath = path.join(scratch, "receipt-payload.json");
    await writeFile(messagePath, canonicalPayloadBytes(payload));
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", SIGN_NAMESPACE, messagePath], { stdio: "inherit" });
    const signature = await readFile(`${messagePath}.sig`, "utf8");

    const assetName = receiptAssetName(decision, stageId);
    const receiptPath = path.join(scratch, assetName);
    await writeFile(receiptPath, `${JSON.stringify({ payload, signature }, null, 2)}\n`);
    gh(["release", "upload", `v${version}`, receiptPath, "--repo", repo]);
    console.log(`uploaded ${assetName} to draft ${draftReleaseId} (actor ${actor})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const argv = process.argv.slice(2);
    const keyPath = arg(argv, "--key");
    const repo = arg(argv, "--repo", false) ?? gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
    const batchFile = arg(argv, "--batch", false);
    const candidates = batchFile
      ? JSON.parse(await readFile(batchFile, "utf8"))
      : [{
          stage_id: arg(argv, "--stage-id"),
          version: arg(argv, "--version"),
          draft_release_id: arg(argv, "--draft-release-id"),
          decision: arg(argv, "--decision", false) ?? "inspected",
        }];
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("--batch must list at least one candidate");
    for (const candidate of candidates) {
      await emitReceipt({
        decision: candidate.decision ?? "inspected",
        stageId: candidate.stage_id,
        version: candidate.version,
        draftReleaseId: candidate.draft_release_id,
        keyPath,
        repo,
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
