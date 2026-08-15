// Workflow-facing adapter for the operator-receipt ordering and exact-publication gate:
//   assets  — list "<assetId> <assetName>" for THIS stage id's receipt assets on the draft release
//   verify  — verify signatures/uploaders/timestamps, then evaluate ordering via the pure module
//   plan    — materialize status/body bytes and a draft-bound, ID-only cleanup manifest
//   apply   — dry-run no-op or the one live cleanup/upload/PATCH executor
//   final   — prove the re-queried exact asset inventory and owned body before publication
// Values arrive as argv/file data only (workflows bind expressions to env first); every signature
// is checked with `ssh-keygen -Y verify` against the committed allowed-signers file before the
// payload is trusted. Missing evidence is decided by the pure tier policy; this adapter fails
// closed on everything else.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isMainModule } from "./is-main-module.mjs";
import {
  PUBLICATION_PLAN_SCHEMA,
  buildPublicationPlan,
  buildReceiptStatusStamp,
  canonicalPayloadBytes,
  evaluateOrdering,
  normalizeReceiptStatusBody,
  parseAuxiliaryReleaseAssetName,
  parseReceiptFile,
  RECEIPT_DECISIONS,
  SIGN_NAMESPACE,
  stampAnnotation,
  stampAssetName,
  verifyFinalPublication,
} from "./release-ordering.mjs";
import { fileSha256 } from "./verify-npm-package.mjs";

function arg(argv, flag, required = true) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if (!value || value.startsWith("--")) {
    if (required) throw new Error(`missing ${flag}`);
    return undefined;
  }
  return value;
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Principals (first token per non-comment line) of an ssh allowed-signers file. */
export function allowedSignerPrincipals(text) {
  return [...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(/\s+/)[0]),
  )];
}

/**
 * Verify one signed receipt file's ssh signature against the allowed-signers file, requiring the
 * payload's actor as principal and the fixed namespace. Returns the validated payload.
 */
export function verifySignedReceipt({ text, allowedSignersPath }) {
  const { payload, signature } = parseReceiptFile(text);
  const scratch = mkdtempSync(path.join(tmpdir(), "aslite-receipt-verify-"));
  try {
    const sigPath = path.join(scratch, "receipt.sig");
    writeFileSync(sigPath, signature.endsWith("\n") ? signature : `${signature}\n`);
    execFileSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", allowedSignersPath, "-I", payload.actor, "-n", SIGN_NAMESPACE, "-s", sigPath],
      { input: canonicalPayloadBytes(payload), stdio: ["pipe", "pipe", "pipe"] },
    );
    return payload;
  } catch (error) {
    if (error?.status !== undefined) {
      throw new Error(
        `operator receipt verification failed: ssh signature check failed for ${payload.actor}: ${String(error.stderr ?? "").trim()}`,
      );
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Select this stage id's receipt assets from a GitHub release JSON. */
export function selectReceiptAssets(release, stageId) {
  const found = {};
  for (const asset of release?.assets ?? []) {
    const classified = parseAuxiliaryReleaseAssetName(asset?.name, { mode: "finalize", currentStageId: stageId });
    if (classified?.category !== "current_receipt") continue;
    const decision = classified.decision;
    if (found[decision]) throw new Error(`operator receipt verification failed: duplicate ${decision} receipt asset`);
    found[decision] = {
      id: String(asset.id),
      name: asset.name,
      digest: asset.digest,
      uploaderLogin: asset.uploader?.login,
      uploadedAt: asset.created_at,
    };
  }
  return found;
}

async function assetsCommand(argv) {
  const release = await jsonFile(arg(argv, "--release"));
  const assets = selectReceiptAssets(release, arg(argv, "--stage-id"));
  for (const asset of Object.values(assets)) {
    console.log(`${asset.id} ${asset.name}`);
  }
}

async function verifyCommand(argv) {
  const mode = arg(argv, "--mode");
  const chain = await jsonFile(arg(argv, "--chain"));
  const stageReceipt = await jsonFile(arg(argv, "--receipt"));
  const release = await jsonFile(arg(argv, "--release"));
  const receiptsDir = arg(argv, "--receipts-dir");
  const runCreatedAt = arg(argv, "--run-created-at");
  const allowedSignersPath = arg(argv, "--allowed-signers");
  const allowedActors = allowedSignerPrincipals(await readFile(allowedSignersPath, "utf8"));

  const assets = selectReceiptAssets(release, chain.stage_id);
  const receipts = {};
  for (const decision of RECEIPT_DECISIONS) {
    const asset = assets[decision];
    if (!asset) continue;
    const receiptPath = path.join(receiptsDir, asset.name);
    const localDigest = await fileSha256(receiptPath);
    if (localDigest !== asset.digest) {
      throw new Error(`operator receipt verification failed: ${decision} downloaded digest ${localDigest} != GitHub asset digest ${asset.digest}`);
    }
    const payload = verifySignedReceipt({
      text: await readFile(receiptPath, "utf8"),
      allowedSignersPath,
    });
    receipts[decision] = {
      payload,
      uploaderLogin: asset.uploaderLogin,
      uploadedAt: asset.uploadedAt,
      asset: { id: asset.id, name: asset.name, digest: localDigest },
    };
  }

  const result = evaluateOrdering({
    mode,
    chain,
    stageReceipt,
    inspected: receipts.inspected ?? null,
    approved: receipts.approved ?? null,
    runCreatedAt,
    allowedActors,
  });
  await writeFile(arg(argv, "--out"), `${JSON.stringify(result, null, 2)}\n`);
  if (result.missing.length > 0) {
    const consequence = result.mode === "live" ? "the publish will be stamped" : "live finalize would stamp (prerelease) or refuse (stable)";
    console.error(`::warning::missing operator receipts: ${result.missing.join(", ")} — ${consequence}`);
  }
  console.log(JSON.stringify(result));
}

async function planCommand(argv) {
  const result = await jsonFile(arg(argv, "--result"));
  const chain = await jsonFile(arg(argv, "--chain"));
  const release = await jsonFile(arg(argv, "--release"));
  const outDir = arg(argv, "--out-dir");
  const finalizeRunId = arg(argv, "--finalize-run-id");
  await mkdir(outDir, { recursive: true });
  let status = null;
  let annotation = null;
  if (result.stamp_required) {
    const stamp = buildReceiptStatusStamp({ result, finalizeRunId, emittedAt: new Date().toISOString() });
    const assetName = stampAssetName(stamp.stage_id);
    const assetPath = path.join(outDir, assetName);
    await writeFile(assetPath, `${JSON.stringify(stamp, null, 2)}\n`);
    status = { name: assetName, digest: await fileSha256(assetPath) };
    annotation = stampAnnotation(stamp);
  }
  const body = normalizeReceiptStatusBody(typeof release.body === "string" ? release.body : "", annotation);
  const plan = buildPublicationPlan({ release, chain, ordering: result, status, bodyAnnotation: annotation });
  await writeFile(path.join(outDir, "asset-name.txt"), status ? `${status.name}\n` : "");
  await writeFile(path.join(outDir, "body.txt"), body);
  await writeFile(arg(argv, "--out"), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify({ planned: true, delete: plan.delete, status: plan.keep.status, missing: result.missing }));
}

function isNotFound(error) {
  return /(?:HTTP 404|Not Found|status code 404)/i.test(`${String(error?.stderr ?? "")}\n${String(error?.message ?? error)}`);
}

function validatePlanForMutation(plan) {
  if (plan?.schema !== PUBLICATION_PLAN_SCHEMA) throw new Error("unknown publication plan schema");
  if (!Number.isSafeInteger(plan.draft_release_id) || plan.draft_release_id <= 0) throw new Error("publication plan has invalid draft release id");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(plan.tag ?? "")) {
    throw new Error("publication plan has invalid release tag");
  }
  if (!Array.isArray(plan.delete)) throw new Error("publication plan has no delete manifest");
  if (plan.keep?.status) {
    if (plan.keep.status.name !== stampAssetName(plan.stage_id) || !/^sha256:[a-f0-9]{64}$/.test(plan.keep.status.digest ?? "")) {
      throw new Error("publication plan has invalid generated status proof");
    }
  }
  let prior = -1;
  const ids = new Set();
  for (const item of plan.delete) {
    if (
      !Number.isSafeInteger(item?.id) || item.id <= 0 || typeof item.name !== "string"
      || !["current_status", "sibling"].includes(item.category)
    ) {
      throw new Error("publication plan has invalid delete entry");
    }
    if (ids.has(item.id) || item.id < prior) throw new Error("publication plan delete entries must be sorted and unique by id");
    ids.add(item.id);
    prior = item.id;
  }
}

/** The only live mutation executor; dry-run returns before invoking its injected command runner. */
export async function applyPublicationPlan({ mode, plan, repo, outDir, run = execFileSync }) {
  if (mode !== "dry-run" && mode !== "live") throw new Error(`unknown publication mode ${JSON.stringify(mode)}`);
  validatePlanForMutation(plan);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Error("invalid GitHub repository name");
  if (mode === "dry-run") return { mutated: false, calls: 0 };

  let calls = 0;
  for (const item of plan.delete) {
    try {
      calls += 1;
      run("gh", ["api", "-X", "DELETE", `repos/${repo}/releases/assets/${item.id}`], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  if (plan.keep.status) {
    const statusPath = path.join(outDir, plan.keep.status.name);
    const localDigest = await fileSha256(statusPath);
    if (localDigest !== plan.keep.status.digest) throw new Error(`generated status digest ${localDigest} != plan ${plan.keep.status.digest}`);
    calls += 1;
    run("gh", ["release", "upload", plan.tag, statusPath, "--repo", repo, "--clobber"], { encoding: "utf8", stdio: "pipe" });
  }
  calls += 1;
  run(
    "gh",
    ["api", "-X", "PATCH", `repos/${repo}/releases/${plan.draft_release_id}`, "-F", `body=@${path.join(outDir, "body.txt")}`],
    { encoding: "utf8", stdio: "pipe" },
  );
  return { mutated: true, calls };
}

async function applyCommand(argv) {
  const plan = await jsonFile(arg(argv, "--plan"));
  const result = await applyPublicationPlan({
    mode: arg(argv, "--mode"),
    plan,
    repo: arg(argv, "--repo"),
    outDir: arg(argv, "--out-dir"),
  });
  console.log(JSON.stringify(result));
}

async function finalCommand(argv) {
  const proof = verifyFinalPublication({
    release: await jsonFile(arg(argv, "--release")),
    plan: await jsonFile(arg(argv, "--plan")),
  });
  await writeFile(arg(argv, "--out"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "assets") return assetsCommand(rest);
  if (command === "verify") return verifyCommand(rest);
  if (command === "plan") return planCommand(rest);
  if (command === "apply") return applyCommand(rest);
  if (command === "final") return finalCommand(rest);
  throw new Error("usage: release-verify-ordering.mjs assets|verify|plan|apply|final ...");
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
