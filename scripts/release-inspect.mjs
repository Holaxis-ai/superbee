// Operator tool for inspecting/approving one or more retained npm candidates and emitting signed
// receipts. Receipt publication is journaled and interruption-safe: an ordinary absent slot uses
// the same durable transaction as an explicitly pinned replacement, but only the latter can reach
// the one numeric-ID DELETE branch.
//
// Single row:
//   node scripts/release-inspect.mjs --stage-id <uuid> --version <semver> --draft-release-id <id> \
//     --key <ssh-private-key> [--decision inspected|approved] [--repo <owner/repo>] \
//     [--allowed-signers <path>] [--recovery-dir <absolute-path>] [--dry-run] \
//     [--replace-asset-id <id> --replace-asset-name <name> --replace-asset-digest <sha256:...>]
// Batch:
//   node scripts/release-inspect.mjs --batch <candidates.json> --key <path> [--repo <owner/repo>]
// Rows may carry decision and replace_existing:{asset_id,name,digest}. Global replacement flags
// are rejected with --batch. Results are emitted in input order with a deterministic summary.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rejectOperation } from "./release-operations.mjs";
import { stageDownloadFilenameFor } from "./release-receipts.mjs";
import { canonicalPayloadBytes, canonicalReceiptPayload, parseReceiptFile, receiptAssetName, SIGN_NAMESPACE } from "./release-ordering.mjs";
import { allowedSignerPrincipals } from "./release-verify-ordering.mjs";
import { executeRecoveryTransaction, normalizeAssetTriple, normalizeSlot, runRecoveryBatch, sha256Bytes } from "./release-inspect-recovery.mjs";
import { RELEASE_CANDIDATE_SCHEMA, assertWorkflowContract, defaultReleaseTargets } from "./release-targets.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const SCRUBBED_GITHUB_ENV = new Set([
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_REPO",
]);
const VALUE_FLAGS = new Set([
  "--stage-id", "--version", "--draft-release-id", "--key", "--decision", "--repo", "--batch",
  "--allowed-signers", "--recovery-dir", "--target", "--replace-asset-id", "--replace-asset-name", "--replace-asset-digest",
]);
const BOOLEAN_FLAGS = new Set(["--dry-run"]);

function fail(message) {
  throw new Error(`release inspect failed: ${message}`);
}

function scrubGitHubEnvironment(source = process.env) {
  const clean = {};
  for (const [name, value] of Object.entries(source)) {
    if (!SCRUBBED_GITHUB_ENV.has(name) && value !== undefined) clean[name] = value;
  }
  return clean;
}

function parseFlags(argv) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (booleans.has(flag)) fail(`duplicate ${flag}`);
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) fail(`unknown argument ${JSON.stringify(flag)}`);
    if (values.has(flag)) fail(`duplicate ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  return {
    get(flag, required = false) {
      const value = values.get(flag);
      if (required && value === undefined) fail(`missing ${flag}`);
      return value;
    },
    has(flag) {
      return booleans.has(flag) || values.has(flag);
    },
  };
}

function runDefault(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env: scrubGitHubEnvironment(options.env ?? process.env),
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function safeId(name, value) {
  const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) fail(`invalid ${name}`);
  return normalized;
}

function normalizeRow(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("candidate row must be an object");
  const allowed = new Set(["stage_id", "version", "draft_release_id", "decision", "replace_existing", "target"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`unknown batch row field ${JSON.stringify(key)}`);
  if (input.replace_existing !== null && input.replace_existing !== undefined) {
    if (typeof input.replace_existing !== "object" || Array.isArray(input.replace_existing)) fail("replace_existing must be an object");
    const replacementKeys = Object.keys(input.replace_existing).sort();
    if (JSON.stringify(replacementKeys) !== JSON.stringify(["asset_id", "digest", "name"])) {
      fail("replace_existing requires exactly asset_id, name, and digest");
    }
  }
  return {
    stage_id: input.stage_id,
    version: input.version,
    draft_release_id: input.draft_release_id,
    decision: input.decision ?? "inspected",
    replace_existing: input.replace_existing ?? null,
    target: input.target,
  };
}

export function defaultRecoveryDirectory(env = process.env) {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, "agentstate-lite", "release-receipt-recovery")
    : path.join(homedir(), ".local", "state", "agentstate-lite", "release-receipt-recovery");
}

export async function parseInspectArgs(argv, { read = readFile, resolveRepo } = {}) {
  const flags = parseFlags(argv);
  const keyPath = flags.get("--key", true);
  const batchPath = flags.get("--batch");
  const replaceFlags = ["--replace-asset-id", "--replace-asset-name", "--replace-asset-digest"];
  const replacementCount = replaceFlags.filter((flag) => flags.has(flag)).length;
  if (batchPath && replacementCount > 0) fail("global replacement flags are forbidden with --batch; use row-local replace_existing");
  if (!batchPath && replacementCount !== 0 && replacementCount !== 3) fail("replacement requires id, name, and digest together");
  const repo = flags.get("--repo") ?? await resolveRepo();
  const batchRows = batchPath ? parseJson(await read(batchPath, "utf8"), "batch file") : null;
  if (batchPath && !Array.isArray(batchRows)) fail("--batch must contain a JSON array");
  const rows = batchPath
    ? batchRows.map(normalizeRow)
    : [normalizeRow({
        stage_id: flags.get("--stage-id", true),
        version: flags.get("--version", true),
        draft_release_id: flags.get("--draft-release-id", true),
        decision: flags.get("--decision") ?? "inspected",
        target: flags.get("--target"),
        replace_existing: replacementCount === 3 ? {
          asset_id: flags.get("--replace-asset-id"),
          name: flags.get("--replace-asset-name"),
          digest: flags.get("--replace-asset-digest"),
        } : null,
      })];
  if (!Array.isArray(rows) || rows.length === 0) fail("--batch must list at least one candidate");
  return {
    keyPath,
    repo,
    rows,
    dryRun: flags.has("--dry-run"),
    recoveryDir: flags.get("--recovery-dir") ?? defaultRecoveryDirectory(),
    allowedSignersPath: flags.get("--allowed-signers") ?? path.join(repoRoot, ".github", "release-allowed-signers"),
    batch: Boolean(batchPath),
  };
}

function exactUploadTemplate({ repo, releaseId, uploadUrl }) {
  const expected = `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets{?name,label}`;
  if (uploadUrl !== expected) fail(`draft release carries an invalid GitHub.com upload_url`);
  return expected;
}

function mutationHeaders(token, extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    fail(`${label} returned malformed JSON`);
  }
}

export async function proveGitHubActor({ token, actor, request = fetch }) {
  const response = await request("https://api.github.com/user", {
    method: "GET",
    redirect: "manual",
    headers: mutationHeaders(token),
  });
  if (response.status !== 200 || (response.status >= 300 && response.status < 400)) fail(`GitHub /user proof failed with HTTP ${response.status}`);
  const body = await responseJson(response, "GitHub /user proof");
  if (body?.login !== actor) fail("pinned GitHub credential does not match the journal actor");
}

export function validateUploadedAssetResponse(body, expected) {
  let triple;
  try {
    triple = normalizeAssetTriple(body, "uploaded asset");
  } catch {
    fail("GitHub upload response has an invalid asset identity");
  }
  if (triple.name !== expected.name || triple.digest !== expected.digest) fail("GitHub upload response does not name the exact journaled asset");
  if (body?.uploader?.login !== expected.actor) fail("GitHub upload response uploader does not match the journal actor");
  return { ...body, ...triple };
}

function childEnvForCredential(source = process.env) {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK"];
  const environment = {};
  for (const name of keep) if (source[name] !== undefined) environment[name] = source[name];
  return environment;
}

function createProductionDependencies(overrides = {}) {
  const run = overrides.run ?? runDefault;
  const request = overrides.request ?? fetch;
  const now = overrides.now ?? (() => new Date().toISOString());

  function ghText(args, options = {}) {
  return run("gh", args, { encoding: "utf8", stdio: "pipe", ...options });
  }

  function ghBytes(args) {
    return run("gh", args, { encoding: null, stdio: "pipe" });
  }

  async function verifySignedReceiptLocally({ text, allowedSignersPath }) {
    const { payload, signature } = parseReceiptFile(text);
    const scratch = mkdtempSync(path.join(tmpdir(), "aslite-receipt-verify-"));
    try {
      const signaturePath = path.join(scratch, "receipt.sig");
      await writeFile(signaturePath, signature.endsWith("\n") ? signature : `${signature}\n`, { mode: 0o600 });
      try {
        run(
          "ssh-keygen",
          ["-Y", "verify", "-f", allowedSignersPath, "-I", payload.actor, "-n", SIGN_NAMESPACE, "-s", signaturePath],
          { input: canonicalPayloadBytes(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: scrubGitHubEnvironment() },
        );
      } catch {
        fail(`SSH signature verification failed for receipt actor ${payload.actor}`);
      }
      return payload;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async function releaseAndAssets(repo, releaseId, expectedTag) {
    const release = parseJson(ghText(["api", "--hostname", "github.com", `repos/${repo}/releases/${releaseId}`]), "draft release response");
    if (safeId("release id", release?.id) !== releaseId) fail("GitHub returned a different release ID");
    if (release.draft !== true) fail(`release ${releaseId} is not an unpublished draft`);
    if (release.tag_name !== expectedTag) fail(`draft release tag does not match expected ${expectedTag}`);
    const pages = parseJson(
      ghText(["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${repo}/releases/${releaseId}/assets?per_page=100`]),
      "paginated release assets",
    );
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) fail("paginated release asset response is incomplete");
    return { release, assets: pages.flat() };
  }

  async function downloadAsset(repo, assetId) {
    return Buffer.from(ghBytes(["api", "--hostname", "github.com", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${assetId}`]));
  }

  function candidateTarget(candidate, row) {
    const targetId = candidate?.target ?? row.target;
    if (!targetId) throw new Error("candidate inspection requires an explicit target");
    const target = defaultReleaseTargets()[targetId];
    if (!target) fail(`unknown release target ${JSON.stringify(targetId)}`);
    if (row.target !== undefined && row.target !== target.id) fail(`candidate target ${target.id} does not match requested target ${row.target}`);
    if (candidate?.package?.name !== undefined && candidate.package.name !== target.package.name) {
      fail(`candidate package ${candidate.package.name} does not match target ${target.package.name}`);
    }
    return assertWorkflowContract(target);
  }

  async function inspectAnchor({ repo, row }) {
    const releaseId = safeId("draft release id", row.draft_release_id);
    const { release, assets } = await releaseAndAssets(repo, releaseId, `v${row.version}`);
    exactUploadTemplate({ repo, releaseId, uploadUrl: release.upload_url });
    const candidates = assets.filter((asset) => asset?.name === "candidate.json");
    if (candidates.length !== 1) fail(`draft release must carry exactly one candidate.json asset, found ${candidates.length}`);
    const candidateAsset = normalizeAssetTriple(candidates[0], "candidate asset");
    const candidateBytes = await downloadAsset(repo, candidateAsset.id);
    if (sha256Bytes(candidateBytes) !== candidateAsset.digest) fail("downloaded candidate.json digest does not match GitHub metadata");
    const candidate = parseJson(candidateBytes.toString("utf8"), "candidate.json");
    if (candidate.schema !== RELEASE_CANDIDATE_SCHEMA) fail("candidate.json has an unknown schema");
    const target = candidateTarget(candidate, row);
    if (candidate.version !== row.version || candidate.tag !== `v${row.version}` || candidate.tarball?.version !== row.version) {
      fail("candidate.json does not match the requested tag/version");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(candidate.tarball?.sha256 ?? "")) fail("candidate.json carries no tarball sha256");
    return { release, assets, candidate, candidateAsset, candidateBytes, target };
  }

  return {
    resolveRepo() {
      return ghText(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
    },
    async executeRow({ row, options }) {
      const first = await inspectAnchor({ repo: options.repo, row });
      const slot = normalizeSlot({
        schema: "aslite.receipt-recovery-slot.v1",
        github_host: "github.com",
        repo: options.repo,
        draft_release_id: String(first.release.id),
        tag: first.release.tag_name,
        stage_id: row.stage_id,
        version: row.version,
        tarball_sha256: first.candidate.tarball.sha256,
          decision: row.decision,
          receipt_name: receiptAssetName(row.decision, row.stage_id),
      });
      const allowedText = await readFile(options.allowedSignersPath, "utf8");
      const allowedActors = allowedSignerPrincipals(allowedText);
      if (allowedActors.length === 0) fail("allowed-signers principal list is empty");

      async function observe() {
        const current = await inspectAnchor({ repo: options.repo, row });
        if (
          String(current.release.id) !== slot.draft_release_id || current.release.tag_name !== slot.tag
          || current.candidate.tarball.sha256 !== slot.tarball_sha256
          || current.candidateAsset.id !== first.candidateAsset.id || current.candidateAsset.digest !== first.candidateAsset.digest
        ) fail("release/candidate anchor changed during receipt recovery");
        return {
          release: current.release,
          slotAssets: current.assets.filter((asset) => asset?.name === slot.receipt_name),
        };
      }

      async function verifyAsset(asset, expected) {
        const triple = normalizeAssetTriple(asset);
        if (expected?.digest && triple.digest !== expected.digest) fail("receipt metadata digest changed");
        const bytes = await downloadAsset(options.repo, triple.id);
        if (sha256Bytes(bytes) !== triple.digest) fail("downloaded receipt digest does not match GitHub metadata");
        if (expected?.bytes && !bytes.equals(Buffer.from(expected.bytes))) fail("downloaded receipt bytes do not match the journal");
        const payload = await verifySignedReceiptLocally({ text: bytes.toString("utf8"), allowedSignersPath: options.allowedSignersPath });
        for (const [name, value] of Object.entries({
          decision: slot.decision,
          stage_id: slot.stage_id,
          version: slot.version,
          tarball_sha256: slot.tarball_sha256,
          draft_release_id: slot.draft_release_id,
        })) if (payload[name] !== value) fail(`signed receipt ${name} does not match this candidate`);
        if (payload.decision === "inspected" && payload.observed_sha256 !== slot.tarball_sha256) fail("inspection receipt observed SHA does not match candidate");
        if (!allowedActors.includes(payload.actor)) fail(`receipt actor ${payload.actor} is not allowed`);
        if (asset?.uploader?.login !== payload.actor) fail("receipt uploader does not equal signed actor");
        if (expected?.actor && payload.actor !== expected.actor) fail("journal actor differs from signed receipt actor");
        return { payload, bytes, actor: payload.actor };
      }

      async function createProposal() {
        const scratch = mkdtempSync(path.join(tmpdir(), "aslite-release-inspect-"));
        try {
          if (slot.decision === "inspected") {
            run("npm", ["stage", "download", slot.stage_id], {
              cwd: scratch,
              stdio: "inherit",
              encoding: null,
              env: scrubGitHubEnvironment(),
            });
            const tarball = await readFile(path.join(scratch, stageDownloadFilenameFor(first.target.id, slot.version, slot.stage_id)));
            const observed = sha256Bytes(tarball);
            if (observed !== slot.tarball_sha256) {
              console.error(`MISMATCH: staged tarball ${observed} != retained candidate ${slot.tarball_sha256}`);
              console.error("The staged bytes are NOT the retained candidate. Reject the stage:");
              console.error(`  ${rejectOperation({ stageId: slot.stage_id }).command}`);
              fail("inspection mismatch; receipt not emitted");
            }
            console.log(`MATCH: staged tarball ${observed}`);
          } else {
            const coordinate = `${first.target.package.name}@${slot.version}`;
            const dist = parseJson(run("npm", ["view", coordinate, "dist", "--json"], {
              encoding: "utf8", stdio: "pipe", env: scrubGitHubEnvironment(),
            }), "npm registry dist");
            if (dist?.integrity !== first.candidate.tarball?.integrity) {
              fail(`registry does not show ${coordinate} public with the candidate integrity`);
            }
          }
          const actor = ghText(["api", "--hostname", "github.com", "user", "--jq", ".login"]).trim();
          if (!allowedActors.includes(actor)) fail("active signer is not in the allowed-signers file");
          const payload = canonicalReceiptPayload({
            decision: slot.decision,
            stage_id: slot.stage_id,
            version: slot.version,
            tarball_sha256: slot.tarball_sha256,
            draft_release_id: slot.draft_release_id,
            actor,
            emitted_at: now(),
            ...(slot.decision === "inspected" ? { observed_sha256: slot.tarball_sha256 } : {}),
          });
          const messagePath = path.join(scratch, "receipt-payload.json");
          await writeFile(messagePath, canonicalPayloadBytes(payload), { mode: 0o600 });
          run("ssh-keygen", ["-Y", "sign", "-f", options.keyPath, "-n", SIGN_NAMESPACE, messagePath], {
            encoding: "utf8", stdio: "pipe", env: scrubGitHubEnvironment(),
          });
          const signature = await readFile(`${messagePath}.sig`, "utf8");
          const bytes = Buffer.from(`${JSON.stringify({ payload, signature }, null, 2)}\n`);
          const verified = await verifySignedReceiptLocally({ text: bytes.toString("utf8"), allowedSignersPath: options.allowedSignersPath });
          if (verified.actor !== actor) fail("local signature verification returned a different actor");
          return { bytes, actor, payload };
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }

      const adapters = {
        observe,
        createProposal,
        async verifyProposal(proposal) {
          const payload = await verifySignedReceiptLocally({ text: proposal.bytes.toString("utf8"), allowedSignersPath: options.allowedSignersPath });
          if (payload.actor !== proposal.actor) fail("journal actor does not match the locally verified signature");
          for (const [name, value] of Object.entries({
            decision: slot.decision, stage_id: slot.stage_id, version: slot.version,
            tarball_sha256: slot.tarball_sha256, draft_release_id: slot.draft_release_id,
          })) if (payload[name] !== value) fail(`journaled receipt ${name} does not match this candidate`);
          if (slot.decision === "inspected" && payload.observed_sha256 !== slot.tarball_sha256) {
            fail("journaled inspection observed SHA does not match this candidate");
          }
        },
        verifyAsset,
        async tokenForActor(actor) {
          try {
            const token = run("gh", ["auth", "token", "--hostname", "github.com", "--user", actor], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              env: childEnvForCredential(),
            }).trim();
            if (!token || /[\r\n]/.test(token)) fail("selected GitHub credential is malformed");
            return token;
          } catch {
            fail(`could not select a GitHub credential for journal actor ${actor}`);
          }
        },
        async proveActor(token, actor) {
          await proveGitHubActor({ token, actor, request });
        },
        async deleteAsset(assetId, token) {
          const url = `https://api.github.com/repos/${options.repo}/releases/assets/${safeId("delete asset id", assetId)}`;
          const response = await request(url, { method: "DELETE", redirect: "manual", headers: mutationHeaders(token) });
          if (response.status === 204) return;
          const error = new Error(`exact receipt DELETE failed with HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        },
        async uploadAsset({ release, releaseId, name, bytes, digest, actor, token }) {
          exactUploadTemplate({ repo: options.repo, releaseId, uploadUrl: release?.upload_url });
          const url = new URL(`https://uploads.github.com/repos/${options.repo}/releases/${releaseId}/assets`);
          url.searchParams.set("name", name);
          const response = await request(url, {
            method: "POST",
            redirect: "manual",
            headers: mutationHeaders(token, { "Content-Type": "application/octet-stream" }),
            body: bytes,
          });
          if (response.status !== 201 || (response.status >= 300 && response.status < 400)) fail(`exact receipt upload failed with HTTP ${response.status}`);
          return validateUploadedAssetResponse(await responseJson(response, "GitHub upload"), { name, digest, actor });
        },
      };

      return executeRecoveryTransaction({
        slot,
        replacement: row.replace_existing,
        recoveryDir: options.recoveryDir,
        dryRun: options.dryRun,
        adapters,
      });
    },
  };
}

export async function main(argv, dependencyOverrides = {}) {
  const dependencies = createProductionDependencies(dependencyOverrides);
  const options = await parseInspectArgs(argv, { resolveRepo: dependencies.resolveRepo });
  const batch = await runRecoveryBatch(options.rows, async (row) => dependencies.executeRow({ row, options }));
  for (const row of batch.rows) console.log(JSON.stringify({ type: "release_inspect_row", ...row }));
  console.log(JSON.stringify({ type: "release_inspect_summary", ...batch.summary }));
  return batch;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await main(process.argv.slice(2));
    for (const row of result.rows) if (row.status === "failed") console.error(row.error);
    if (result.rows.some((row) => row.status === "failed" || row.status === "not_attempted")) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
