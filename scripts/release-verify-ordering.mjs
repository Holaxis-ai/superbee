// Workflow-facing adapter for the operator-receipt ordering and exact-publication gate:
//   assets  — list "<assetId> <assetName>" for THIS stage id's receipt assets on the draft release
//   verify  — verify signatures/uploaders/timestamps, then evaluate ordering via the pure module
//   plan    — materialize status/body bytes and a draft-bound, ID-only cleanup manifest
//   apply   — dry-run no-op or the one live cleanup/upload/PATCH executor
//   final/published — prove exact inventory/body before publication and full identity after it
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
  stampAnnotation, stampAssetName,
  verifyFinalPublication, verifyPersistedPublicationProofs, verifyPublishedPublication,
} from "./release-ordering.mjs";
import { verifyArtifactMetadata } from "./release-receipts.mjs";
import { defaultReleaseManifest, resolveAllowedTuple } from "./release-targets.mjs";
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

async function publishedCommand(argv) {
  const chain = await jsonFile(arg(argv, "--chain"));
  const manifest = defaultReleaseManifest();
  const tuple = resolveAllowedTuple(manifest, {
    target: chain.target,
    version: chain.version,
    tag: chain.tag,
  });
  const proof = verifyPublishedPublication({
    release: await jsonFile(arg(argv, "--release")),
    latestRelease: await jsonFile(arg(argv, "--latest-release")),
    plan: await jsonFile(arg(argv, "--plan")),
    chain,
    tuple,
  });
  await writeFile(arg(argv, "--out"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
}

const FINALIZATION_PROOF_ARTIFACT_NAME = "release-finalization-proof";
export const PUBLISHED_CONVERGENCE_ATTEMPTS = 6;
const PUBLISHED_CONVERGENCE_DELAY_MS = 2_000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

async function preparedArtifactCommand(argv) {
  const chain = await jsonFile(arg(argv, "--chain"));
  const binding = verifyPersistedPublicationProofs({
    chain,
    plan: await jsonFile(arg(argv, "--plan")),
    finalProof: await jsonFile(arg(argv, "--final-proof")),
  });
  const expectedHead = arg(argv, "--head-sha");
  const expectedSourceCommit = arg(argv, "--source-commit");
  verifyArtifactMetadata("finalization proof artifact", await jsonFile(arg(argv, "--artifact")), {
    id: arg(argv, "--artifact-id"),
    name: FINALIZATION_PROOF_ARTIFACT_NAME,
    digest: arg(argv, "--artifact-digest"),
    runId: arg(argv, "--run-id"),
    commit: expectedHead,
  });
  if (binding.source_commit !== expectedSourceCommit) {
    throw new Error("persisted finalization proof source commit differs from the prepare output");
  }
  console.log(JSON.stringify({ verified: true, artifact: FINALIZATION_PROOF_ARTIFACT_NAME, ...binding }));
}

function githubHeaders(token) {
  if (typeof token !== "string" || token.length === 0) throw new Error("missing GH_TOKEN");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function observeGithubJson({ url, endpoint, token, allowNotFound, fetchImpl, requestTimeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: githubHeaders(token), signal: controller.signal });
  } catch (error) {
    return { retry: `network failure (${error instanceof Error ? error.name : "unknown"})` };
  } finally {
    clearTimeout(timer);
  }
  if (!Number.isSafeInteger(response?.status)) throw new Error("GitHub response lacks a numeric HTTP status");
  if (response.status === 404) {
    return allowNotFound ? { value: null } : { retry: `${endpoint} returned HTTP 404` };
  }
  if (response.status === 429 || (response.status === 403 && endpoint === "exact release")) {
    return { retry: `${endpoint} returned HTTP ${response.status}` };
  }
  if (response.status >= 500 && response.status <= 599) return { retry: `${endpoint} returned HTTP ${response.status}` };
  if (response.status >= 400 && response.status <= 499) throw new Error(`${endpoint} returned non-retryable HTTP ${response.status}`);
  if (response.status < 200 || response.status >= 300) throw new Error(`${endpoint} returned unexpected HTTP ${response.status}`);
  try {
    return { value: await response.json() };
  } catch {
    return { retry: `GitHub returned invalid JSON at HTTP ${response.status}` };
  }
}

/** Read-only bounded convergence. It never invokes gh, PATCH, draft validation, or any mutation. */
export async function convergePublishedPublication({
  repo,
  token,
  chain,
  plan,
  tuple,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = PUBLISHED_CONVERGENCE_ATTEMPTS,
  retryDelayMs = PUBLISHED_CONVERGENCE_DELAY_MS,
  requestTimeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
}) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("invalid GitHub repository name");
  if (typeof fetchImpl !== "function") throw new Error("GitHub fetch implementation is unavailable");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("invalid convergence attempt bound");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new Error("invalid convergence retry delay");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("invalid GitHub request timeout");
  githubHeaders(token);
  const releaseId = Number(chain?.draft_release_id);
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) throw new Error("invalid persisted numeric release id");
  const base = `https://api.github.com/repos/${repo}/releases`;
  let lastReason = "no observation";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const exact = await observeGithubJson({
      url: `${base}/${releaseId}`,
      endpoint: "exact release",
      token,
      allowNotFound: false,
      fetchImpl,
      requestTimeoutMs,
    });
    if (exact.retry) {
      lastReason = exact.retry;
    } else {
      const latest = await observeGithubJson({
        url: `${base}/latest`,
        endpoint: "latest release",
        token,
        allowNotFound: true,
        fetchImpl,
        requestTimeoutMs,
      });
      if (latest.retry) {
        lastReason = latest.retry;
      } else {
        try {
          return verifyPublishedPublication({ release: exact.value, latestRelease: latest.value, plan, chain, tuple });
        } catch (error) {
          lastReason = error instanceof Error ? error.message : String(error);
        }
      }
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  throw new Error(`published release did not converge after ${maxAttempts} attempts: ${lastReason}`);
}

async function publishedLiveCommand(argv) {
  const chain = await jsonFile(arg(argv, "--chain"));
  const plan = await jsonFile(arg(argv, "--plan"));
  const manifest = defaultReleaseManifest();
  const tuple = resolveAllowedTuple(manifest, { target: chain.target, version: chain.version, tag: chain.tag });
  const proof = await convergePublishedPublication({
    repo: arg(argv, "--repo"),
    token: process.env.GH_TOKEN,
    chain,
    plan,
    tuple,
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
  if (command === "published") return publishedCommand(rest);
  if (command === "prepared-artifact") return preparedArtifactCommand(rest);
  if (command === "published-live") return publishedLiveCommand(rest);
  throw new Error("usage: release-verify-ordering.mjs assets|verify|plan|apply|final|published|prepared-artifact|published-live ...");
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
