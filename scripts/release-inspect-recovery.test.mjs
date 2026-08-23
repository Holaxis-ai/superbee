import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireSlotOwner, canonicalSlotKey, ensureRecoveryDirectory, normalizeAssetTriple, normalizeSlot, publishNoReplace } from "./release-inspect-recovery.mjs";
import { main as inspectMain, parseInspectArgs, proveGitHubActor } from "./release-inspect.mjs";
import { canonicalPayloadBytes, canonicalReceiptPayload, SIGN_NAMESPACE } from "./release-ordering.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recoveryModule = pathToFileURL(path.join(repoRoot, "scripts", "release-inspect-recovery.mjs")).href;
const STAGE_ID = "123e4567-e89b-42d3-a456-426614174000";
const SHA = `sha256:${"a".repeat(64)}`;
const NAME = `receipt-inspected-${STAGE_ID}.json`;

function digest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function slot() {
  return {
    schema: "aslite.receipt-recovery-slot.v1",
    github_host: "github.com",
    repo: "Holaxis-ai/agentstate-lite",
    draft_release_id: "300",
    tag: "v0.1.0-pre.4",
    stage_id: STAGE_ID,
    version: "0.1.0-pre.4",
    tarball_sha256: SHA,
    decision: "inspected",
    receipt_name: NAME,
  };
}

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), "aslite-recovery-test-"));
  const statePath = path.join(root, "remote.json");
  const logPath = path.join(root, "calls.jsonl");
  const recoveryDir = path.join(root, "recovery");
  writeFileSync(statePath, `${JSON.stringify({ assets: [], next_id: 900 })}\n`);
  return { root, statePath, logPath, recoveryDir };
}

function readState(harness) {
  return JSON.parse(readFileSync(harness.statePath, "utf8"));
}

function calls(harness) {
  try {
    return readFileSync(harness.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const childSource = String.raw`
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const config = JSON.parse(Buffer.from(process.env.ASLITE_RECOVERY_CONFIG, "base64url").toString("utf8"));
const { executeRecoveryTransaction } = await import(config.module);
const log = (entry) => appendFileSync(config.logPath, JSON.stringify(entry) + "\n");
const load = () => JSON.parse(readFileSync(config.statePath, "utf8"));
const save = (state) => writeFileSync(config.statePath, JSON.stringify(state) + "\n");
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const proposedText = config.proposedText ?? JSON.stringify({ actor: config.signActor ?? "briand-ai", nonce: config.nonce ?? "one" }) + "\n";
let proofCount = 0;
const result = await executeRecoveryTransaction({
  slot: config.slot,
  replacement: config.replacement ?? null,
  recoveryDir: config.recoveryDir,
  dryRun: config.dryRun ?? false,
  adapters: {
    observe: async () => {
      const state = load();
      if (state.anchor_error) throw new Error(state.anchor_error);
      return {
        release: { id: 300, draft: true, tag_name: config.slot.tag, upload_url: "https://uploads.github.com/repos/Holaxis-ai/agentstate-lite/releases/300/assets{?name,label}" },
        slotAssets: state.assets,
      };
    },
    createProposal: async () => {
      log({ op: "sign", actor: config.signActor ?? "briand-ai", nonce: config.nonce ?? "one" });
      if (config.signDelay) await new Promise((resolve) => setTimeout(resolve, config.signDelay));
      return { bytes: Buffer.from(proposedText), actor: config.signActor ?? "briand-ai" };
    },
    verifyProposal: async (proposal) => {
      if (!proposal.bytes.length || !proposal.actor) throw new Error("bad proposal");
    },
    verifyAsset: async (asset, expected) => {
      if (asset.valid === false) throw new Error("invalid signed receipt");
      if (expected?.digest && asset.digest !== expected.digest) throw new Error("asset digest mismatch");
      if (expected?.bytes && asset.bytes !== Buffer.from(expected.bytes).toString("base64")) throw new Error("asset bytes mismatch");
      if (expected?.actor && asset.uploader?.login !== expected.actor) throw new Error("asset uploader mismatch");
      return { actor: asset.uploader?.login };
    },
    tokenForActor: async (actor) => {
      log({ op: "token", actor });
      return "canary-secret-token";
    },
    proveActor: async (_token, actor) => {
      proofCount += 1;
      log({ op: "user", actor, observed: config.tokenActor ?? actor });
      if ((config.tokenActor ?? actor) !== actor) throw new Error("pinned credential actor mismatch");
      if (config.moveOnProof === proofCount) {
        const state = load();
        if (config.proofMovement === "anchor") state.anchor_error = "ANCHOR_MOVED";
        else if (config.proofMovement === "competitor") {
          state.assets = [{ id: 777, name: config.slot.receipt_name, digest: "sha256:" + "7".repeat(64), uploader: { login: "other" }, valid: true }];
        }
        save(state);
      }
    },
    deleteAsset: async (id) => {
      if (config.requireJournalBeforeDelete) {
        const journalName = readdirSync(config.recoveryDir).find((name) => name.endsWith(".json"));
        if (!journalName) throw new Error("DELETE reached before durable journal publication");
        const journal = JSON.parse(readFileSync(config.recoveryDir + "/" + journalName, "utf8"));
        if (journal.prior?.kind !== "existing" || journal.prior.asset?.id !== id) throw new Error("DELETE lacks exact durable prior authority");
      }
      log({ op: "delete", id });
      const state = load();
      state.assets = state.assets.filter((asset) => asset.id !== id);
      save(state);
      if (config.loseDeleteResponse) throw new Error("lost DELETE response");
    },
    uploadAsset: async ({ name, bytes, actor }) => {
      log({ op: "upload", name, actor, digest: sha(bytes) });
      const state = load();
      if (state.assets.some((asset) => asset.name === name)) throw new Error("no-clobber upload conflict");
      const asset = { id: state.next_id++, name, digest: sha(bytes), bytes: Buffer.from(bytes).toString("base64"), uploader: { login: actor }, valid: true };
      state.assets.push(asset);
      save(state);
      if (config.loseUploadResponse) throw new Error("lost upload response");
      return asset;
    },
  },
});
process.stdout.write(JSON.stringify(result) + "\n");
`;

function childConfig(harness, overrides = {}) {
  return {
    module: recoveryModule,
    slot: slot(),
    statePath: harness.statePath,
    logPath: harness.logPath,
    recoveryDir: harness.recoveryDir,
    ...overrides,
  };
}

function runChild(harness, overrides = {}) {
  const config = childConfig(harness, overrides);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
    encoding: "utf8",
    env: { ...process.env, ASLITE_RECOVERY_CONFIG: Buffer.from(JSON.stringify(config)).toString("base64url") },
  });
  return result;
}

function spawnChild(harness, overrides = {}) {
  const config = childConfig(harness, overrides);
  return spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ASLITE_RECOVERY_CONFIG: Buffer.from(JSON.stringify(config)).toString("base64url") },
  });
}

function completion(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

test("subprocess exact replacement deletes only the pinned old ID then uploads the journaled bytes", () => {
  const h = scratch();
  try {
    const old = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: true };
    writeFileSync(h.statePath, `${JSON.stringify({ assets: [old], next_id: 900 })}\n`);
    const result = runChild(h, { replacement: { asset_id: 401, name: NAME, digest: old.digest }, requireJournalBeforeDelete: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "replaced");
    assert.deepEqual(calls(h).filter((call) => ["delete", "upload"].includes(call.op)).map((call) => [call.op, call.id ?? call.name]), [
      ["delete", 401],
      ["upload", NAME],
    ]);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("QA HOST AUTHORITY — real CLI subprocess pins every observation to github.com and scrubs ambient GH_HOST", () => {
  const h = scratch();
  try {
    const bin = path.join(h.root, "bin");
    const controlledTmp = path.join(h.root, "tmp");
    mkdirSync(bin);
    mkdirSync(controlledTmp);
    const signer = makeSigner(h.root, "briand-ai");
    const allowedPath = path.join(h.root, "allowed-signers");
    writeFileSync(allowedPath, `${signer.allowedLine}\n`);
    const tarballBytes = Buffer.from("host-pinned retained tarball");
    const tarballSha = digest(tarballBytes);
    const candidateText = JSON.stringify({
      schema: "superbee.release-candidate.v1",
      target: "bridge",
      package: { name: "@holaxis/aslite" },
      tag: "v0.1.0-pre.4",
      version: "0.1.0-pre.4",
      tarball: { version: "0.1.0-pre.4", sha256: tarballSha, integrity: "sha512-YWJjZA==" },
    });
    const candidatePath = path.join(h.root, "candidate.json");
    writeFileSync(candidatePath, candidateText);
    const candidateDigest = digest(candidateText);
    const ghLog = path.join(h.root, "gh-host.log");
    const ghStub = path.join(bin, "gh");
    writeFileSync(ghStub, `#!/bin/sh
printf 'GH_HOST=%s GH_REPO=%s ARGS=%s\\n' "\${GH_HOST-<unset>}" "\${GH_REPO-<unset>}" "$*" >> "$ASLITE_TEST_GH_HOST_LOG"
case "$*" in
  *'repo view --json nameWithOwner --jq .nameWithOwner'*) printf '%s\\n' 'Holaxis-ai/agentstate-lite' ;;
  *'releases/assets/22'*) exec /bin/cat "$ASLITE_TEST_CANDIDATE" ;;
  *'releases/300/assets?per_page=100'*) printf '%s\\n' '[[{"id":22,"name":"candidate.json","digest":"${candidateDigest}"}]]' ;;
  *'repos/Holaxis-ai/agentstate-lite/releases/300'*) printf '%s\\n' '{"id":300,"draft":true,"tag_name":"v0.1.0-pre.4","upload_url":"https://uploads.github.com/repos/Holaxis-ai/agentstate-lite/releases/300/assets{?name,label}"}' ;;
  *'user --jq .login'*) printf '%s\\n' 'briand-ai' ;;
  *) exit 91 ;;
esac
`);
    const npmStub = path.join(bin, "npm");
    writeFileSync(npmStub, `#!/bin/sh
if [ "$1:$2:$3" = "stage:download:${STAGE_ID}" ]; then
  printf '%s' 'host-pinned retained tarball' > "$ASLITE_TEST_DOWNLOAD_NAME"
  exit 0
fi
exit 92
`);
    chmodSync(ghStub, 0o755);
    chmodSync(npmStub, 0o755);

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "release-inspect.mjs"),
      "--stage-id", STAGE_ID,
      "--version", "0.1.0-pre.4",
      "--draft-release-id", "300",
      "--decision", "inspected",
      "--key", signer.keyPath,
      "--allowed-signers", allowedPath,
      "--recovery-dir", h.recoveryDir,
      "--dry-run",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: controlledTmp,
        GH_HOST: "attacker-controlled.example",
        GH_REPO: "attacker-controlled.example/evil/repository",
        ASLITE_TEST_GH_HOST_LOG: ghLog,
        ASLITE_TEST_CANDIDATE: candidatePath,
        ASLITE_TEST_DOWNLOAD_NAME: `holaxis-aslite-0.1.0-pre.4-${STAGE_ID}.tgz`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const transcript = readFileSync(ghLog, "utf8").trim().split("\n");
    assert.ok(transcript.some((line) => line.includes("ARGS=repo view")), "fixture covers repository discovery");
    assert.ok(transcript.some((line) => line.includes("releases/300/assets?per_page=100")), "fixture covers complete inventory");
    assert.ok(transcript.some((line) => line.includes("releases/assets/22")), "fixture covers asset download");
    assert.ok(transcript.some((line) => line.includes("user --jq .login")), "fixture covers active signer lookup");
    for (const line of transcript) {
      assert.match(line, /^GH_HOST=<unset> GH_REPO=<unset> /, `ambient host/repository reached child: ${line}`);
      if (line.includes("ARGS=api ")) assert.match(line, /--hostname github\.com/, `observation is not host-explicit: ${line}`);
    }
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

for (const movement of ["anchor", "competitor"]) {
  test(`M1 DELETE BARRIER — ${movement} movement during /user proof makes DELETE unreachable`, () => {
    const h = scratch();
    try {
      const old = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: true };
      writeFileSync(h.statePath, `${JSON.stringify({ assets: [old], next_id: 900 })}\n`);
      const result = runChild(h, {
        replacement: { asset_id: 401, name: NAME, digest: old.digest },
        moveOnProof: 1,
        proofMovement: movement,
      });
      assert.notEqual(result.status, 0);
      assert.equal(calls(h).some((call) => call.op === "delete"), false, result.stderr);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  });
}

for (const transaction of ["absent", "replacement"]) {
  for (const movement of ["anchor", "competitor"]) {
    test(`M1 UPLOAD BARRIER — ${transaction} ${movement} movement during final /user proof makes upload unreachable`, () => {
      const h = scratch();
      try {
        let replacement = null;
        if (transaction === "replacement") {
          const old = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: true };
          writeFileSync(h.statePath, `${JSON.stringify({ assets: [old], next_id: 900 })}\n`);
          replacement = { asset_id: 401, name: NAME, digest: old.digest };
        }
        const result = runChild(h, {
          replacement,
          moveOnProof: transaction === "replacement" ? 2 : 1,
          proofMovement: movement,
        });
        assert.notEqual(result.status, 0);
        assert.equal(calls(h).some((call) => call.op === "upload"), false, result.stderr);
      } finally { rmSync(h.root, { recursive: true, force: true }); }
    });
  }
}

test("subprocess absent first emission journals prior absent and never reaches DELETE", () => {
  const h = scratch();
  try {
    const result = runChild(h, { loseUploadResponse: true });
    assert.notEqual(result.status, 0, "response loss leaves a resumable journal");
    const journal = readdirSync(h.recoveryDir).find((name) => name.endsWith(".json"));
    assert.ok(journal);
    assert.deepEqual(JSON.parse(readFileSync(path.join(h.recoveryDir, journal), "utf8")).prior, { kind: "absent" });
    assert.equal(calls(h).some((call) => call.op === "delete"), false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

for (const kind of ["absent", "replace"]) {
  test(`simultaneous ${kind} subprocesses admit one owner/proposal and at most one mutation transcript`, async () => {
    const h = scratch();
    try {
      let replacement = null;
      if (kind === "replace") {
        const old = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: true };
        writeFileSync(h.statePath, `${JSON.stringify({ assets: [old], next_id: 900 })}\n`);
        replacement = { asset_id: 401, name: NAME, digest: old.digest };
      }
      const one = spawnChild(h, { replacement, nonce: "one", signDelay: 250 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const two = spawnChild(h, { replacement, nonce: "two" });
      const results = await Promise.all([completion(one), completion(two)]);
      assert.equal(results.filter((result) => result.status === 0).length, 1, JSON.stringify(results));
      assert.equal(calls(h).filter((call) => call.op === "sign").length, 1, "live loser fails before signing");
      assert.ok(calls(h).filter((call) => call.op === "upload").length <= 1);
      assert.equal(new Set(calls(h).filter((call) => call.op === "upload").map((call) => call.digest)).size, 1);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  });
}

test("upload response loss resumes from the winning journal digest without a second upload", () => {
  const h = scratch();
  try {
    const first = runChild(h, { loseUploadResponse: true, nonce: "winner" });
    assert.notEqual(first.status, 0);
    const second = runChild(h, { nonce: "different-loser" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, "resumed");
    assert.equal(calls(h).filter((call) => call.op === "sign").length, 1, "retry loads before signing");
    assert.equal(calls(h).filter((call) => call.op === "upload").length, 1, "retry proves convergence");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("ordinary current-valid receipt returns already_present without signing, token selection, DELETE, or upload", () => {
  const h = scratch();
  try {
    const current = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: true };
    writeFileSync(h.statePath, `${JSON.stringify({ assets: [current], next_id: 900 })}\n`);
    const result = runChild(h);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "already_present");
    assert.deepEqual(calls(h), []);
    assert.deepEqual(readState(h).assets, [current]);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("a competing same-name digest after absent journaling is preserved and blocks every mutation", () => {
  const h = scratch();
  try {
    const blocked = runChild(h, { tokenActor: "mikec-ai", signActor: "briand-ai", nonce: "winner" });
    assert.notEqual(blocked.status, 0, "actor mismatch leaves the absent journal before upload");
    const competitor = { id: 777, name: NAME, digest: `sha256:${"7".repeat(64)}`, uploader: { login: "other" }, valid: true };
    writeFileSync(h.statePath, `${JSON.stringify({ assets: [competitor], next_id: 900 })}\n`);
    const before = calls(h).length;
    const retry = runChild(h, { tokenActor: "briand-ai" });
    assert.notEqual(retry.status, 0);
    assert.equal(calls(h).slice(before).some((call) => call.op === "delete" || call.op === "upload"), false);
    assert.deepEqual(readState(h).assets, [competitor]);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("lost DELETE acknowledgment is reconciled from exact empty state with no second deletion", () => {
  const h = scratch();
  try {
    const old = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: true };
    writeFileSync(h.statePath, `${JSON.stringify({ assets: [old], next_id: 900 })}\n`);
    const result = runChild(h, {
      replacement: { asset_id: 401, name: NAME, digest: old.digest },
      loseDeleteResponse: true,
      requireJournalBeforeDelete: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "replaced");
    assert.equal(calls(h).filter((call) => call.op === "delete").length, 1);
    assert.equal(calls(h).filter((call) => call.op === "upload").length, 1);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("actor switch after journal publication blocks upload until the journal actor credential proves /user", () => {
  const h = scratch();
  try {
    const blocked = runChild(h, { tokenActor: "mikec-ai", signActor: "briand-ai" });
    assert.notEqual(blocked.status, 0);
    assert.equal(calls(h).filter((call) => call.op === "upload").length, 0);
    const resumed = runChild(h, { tokenActor: "briand-ai", signActor: "mikec-ai" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, "resumed");
    assert.deepEqual(calls(h).filter((call) => call.op === "token").map((call) => call.actor), ["briand-ai", "briand-ai"]);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("ordered batch advances across already_present and stops later rows after the first uncertain result", async () => {
  const { runRecoveryBatch } = await import("./release-inspect-recovery.mjs");
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const advanced = await runRecoveryBatch(rows.slice(0, 2), async (row) => ({ status: row.id === 1 ? "already_present" : "uploaded" }));
  assert.deepEqual(advanced.rows.map((row) => row.status), ["already_present", "uploaded"]);
  const stopped = await runRecoveryBatch(rows, async (row) => {
    if (row.id === 2) throw new Error("remote state uncertain");
    return { status: "resumed" };
  });
  assert.deepEqual(stopped.rows.map((row) => row.status), ["resumed", "failed", "not_attempted"]);
});

test("dry-run plans through signing and verification with zero durable or remote mutations", () => {
  const h = scratch();
  try {
    const result = runChild(h, { dryRun: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "uploaded");
    assert.deepEqual(calls(h).map((call) => call.op), ["sign"]);
    assert.equal(readState(h).assets.length, 0);
    assert.equal(readdirSync(h.root).includes("recovery"), false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("canonical slot key is the SHA-256 of exactly the normalized slot authority", () => {
  const normalized = normalizeSlot(slot());
  const expected = createHash("sha256").update(`${JSON.stringify(normalized, null, 2)}\n`).digest("hex");
  assert.equal(canonicalSlotKey(slot()), expected);
  assert.equal(canonicalSlotKey({ ...slot(), emitted_at: "2099-01-01T00:00:00Z", proposed_digest: `sha256:${"f".repeat(64)}` }), expected);
  for (const [field, value] of [
    ["draft_release_id", "301"],
    ["stage_id", "223e4567-e89b-42d3-a456-426614174000"],
    ["tarball_sha256", `sha256:${"b".repeat(64)}`],
    ["decision", "approved"],
  ]) {
    const changed = { ...slot(), [field]: value };
    if (field === "decision") changed.receipt_name = `receipt-approved-${STAGE_ID}.json`;
    if (field === "stage_id") changed.receipt_name = `receipt-inspected-${value}.json`;
    assert.notEqual(canonicalSlotKey(changed), expected, field);
  }
  assert.throws(() => normalizeSlot({ ...slot(), schema: "aslite.receipt-recovery-slot.v2" }), /invalid slot schema/);
});

test("first publication is no-replace mode-0600 and a symlinked recovery directory fails closed", async () => {
  const h = scratch();
  try {
    mkdirSync(h.recoveryDir, { mode: 0o700 });
    const file = path.join(h.recoveryDir, "record.json");
    assert.equal(await publishNoReplace(file, "first\n"), true);
    assert.equal(await publishNoReplace(file, "second\n"), false);
    assert.equal(readFileSync(file, "utf8"), "first\n");
    assert.equal((await import("node:fs")).statSync(file).mode & 0o777, 0o600);

    const target = path.join(h.root, "target");
    mkdirSync(target);
    const linked = path.join(h.root, "linked-recovery");
    symlinkSync(target, linked);
    await assert.rejects(ensureRecoveryDirectory(linked), /not a real directory/);
    const dry = runChild(h, { dryRun: true, recoveryDir: linked });
    assert.notEqual(dry.status, 0);
    assert.equal(calls(h).length, 0, "dry-run rejects the symlink before signing");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("owner records reject live/cross-host ambiguity and reclaim only a definitely dead same-host PID", async () => {
  const h = scratch();
  try {
    mkdirSync(h.recoveryDir, { mode: 0o700 });
    const ownerPath = path.join(h.recoveryDir, `${canonicalSlotKey(slot())}.lock`);
    const base = {
      schema: "aslite.receipt-recovery-owner.v1",
      version: 1,
      hostname: (await import("node:os")).hostname(),
      pid: process.pid,
      started_at: "2026-08-09T10:00:00Z",
      token: "123e4567-e89b-42d3-a456-426614174000",
    };
    writeFileSync(ownerPath, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(acquireSlotOwner(ownerPath), /owner PID .* live/);
    writeFileSync(ownerPath, `${JSON.stringify({ ...base, hostname: "another-host.invalid" }, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(acquireSlotOwner(ownerPath), /owned on another host/);
    writeFileSync(ownerPath, `${JSON.stringify({ ...base, pid: 2_147_483_647 }, null, 2)}\n`, { mode: 0o600 });
    const reclaimed = await acquireSlotOwner(ownerPath);
    assert.equal(reclaimed.pid, process.pid);
    assert.notEqual(reclaimed.token, base.token);
    assert.equal(readdirSync(h.recoveryDir).filter((name) => name.includes(".stale.")).length, 0);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("stale owner reclamation never renames away a newly published live owner", async () => {
  const h = scratch();
  try {
    mkdirSync(h.recoveryDir, { mode: 0o700 });
    const ownerPath = path.join(h.recoveryDir, `${canonicalSlotKey(slot())}.lock`);
    const dead = {
      schema: "aslite.receipt-recovery-owner.v1",
      version: 1,
      hostname: (await import("node:os")).hostname(),
      pid: 2_147_483_647,
      started_at: "2026-08-09T10:00:00Z",
      token: "123e4567-e89b-42d3-a456-426614174000",
    };
    const live = {
      ...dead,
      pid: process.pid,
      started_at: "2026-08-09T10:01:00Z",
      token: "223e4567-e89b-42d3-a456-426614174000",
    };
    writeFileSync(ownerPath, `${JSON.stringify(dead, null, 2)}\n`, { mode: 0o600 });
    let injected = false;
    await assert.rejects(
      acquireSlotOwner(ownerPath, {
        async beforeStaleOwnerRename() {
          injected = true;
          await (await import("node:fs/promises")).rename(ownerPath, `${ownerPath}.other-stale`);
          assert.equal(await publishNoReplace(ownerPath, `${JSON.stringify(live, null, 2)}\n`), true);
        },
      }),
      /owner PID .* live|stale owner changed during reclamation|could not acquire/,
    );
    assert.equal(injected, true, "test must intercept the stale-owner rename boundary");
    assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")), live);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("dead reclaim marker does not permanently wedge stale-owner recovery", async () => {
  const h = scratch();
  try {
    mkdirSync(h.recoveryDir, { mode: 0o700 });
    const ownerPath = path.join(h.recoveryDir, `${canonicalSlotKey(slot())}.lock`);
    const hostname = (await import("node:os")).hostname();
    const dead = {
      schema: "aslite.receipt-recovery-owner.v1",
      version: 1,
      hostname,
      pid: 2_147_483_647,
      started_at: "2026-08-09T10:00:00Z",
      token: "123e4567-e89b-42d3-a456-426614174000",
    };
    const deadReclaim = {
      ...dead,
      pid: 2_147_483_646,
      started_at: "2026-08-09T10:01:00Z",
      token: "323e4567-e89b-42d3-a456-426614174000",
    };
    writeFileSync(ownerPath, `${JSON.stringify(dead, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(`${ownerPath}.reclaim`, `${JSON.stringify(deadReclaim, null, 2)}\n`, { mode: 0o600 });

    const reclaimed = await acquireSlotOwner(ownerPath);
    assert.equal(reclaimed.pid, process.pid);
    assert.notEqual(reclaimed.token, dead.token);
    assert.equal(readdirSync(h.recoveryDir).some((name) => name.endsWith(".reclaim")), false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("dead reclaim cleanup marker does not permanently wedge stale-owner recovery", async () => {
  const h = scratch();
  try {
    mkdirSync(h.recoveryDir, { mode: 0o700 });
    const ownerPath = path.join(h.recoveryDir, `${canonicalSlotKey(slot())}.lock`);
    const hostname = (await import("node:os")).hostname();
    const dead = {
      schema: "aslite.receipt-recovery-owner.v1",
      version: 1,
      hostname,
      pid: 2_147_483_647,
      started_at: "2026-08-09T10:00:00Z",
      token: "123e4567-e89b-42d3-a456-426614174000",
    };
    const deadReclaim = {
      ...dead,
      pid: 2_147_483_646,
      started_at: "2026-08-09T10:01:00Z",
      token: "323e4567-e89b-42d3-a456-426614174000",
    };
    const deadCleanup = {
      ...dead,
      pid: 2_147_483_645,
      started_at: "2026-08-09T10:02:00Z",
      token: "423e4567-e89b-42d3-a456-426614174000",
    };
    writeFileSync(ownerPath, `${JSON.stringify(dead, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(`${ownerPath}.reclaim`, `${JSON.stringify(deadReclaim, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(`${ownerPath}.reclaim.cleanup`, `${JSON.stringify(deadCleanup, null, 2)}\n`, { mode: 0o600 });

    const reclaimed = await acquireSlotOwner(ownerPath);
    assert.equal(reclaimed.pid, process.pid);
    assert.notEqual(reclaimed.token, dead.token);
    assert.equal(readdirSync(h.recoveryDir).some((name) => name.includes(".reclaim")), false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("an invalid old receipt remains present and makes replacement DELETE unreachable", () => {
  const h = scratch();
  try {
    const old = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: false };
    writeFileSync(h.statePath, `${JSON.stringify({ assets: [old], next_id: 900 })}\n`);
    const result = runChild(h, { replacement: { asset_id: 401, name: NAME, digest: old.digest } });
    assert.notEqual(result.status, 0);
    assert.equal(calls(h).some((call) => call.op === "delete" || call.op === "upload"), false);
    assert.deepEqual(readState(h).assets, [old]);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("EXACT COMPARATOR rejects a name-only selector with wrong ID/digest before signing or DELETE", () => {
  const h = scratch();
  try {
    const old = { id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, uploader: { login: "briand-ai" }, valid: true };
    writeFileSync(h.statePath, `${JSON.stringify({ assets: [old], next_id: 900 })}\n`);
    const result = runChild(h, {
      replacement: { asset_id: 999, name: NAME, digest: `sha256:${"2".repeat(64)}` },
      requireJournalBeforeDelete: true,
    });
    assert.notEqual(result.status, 0);
    assert.equal(calls(h).some((call) => ["sign", "delete", "upload"].includes(call.op)), false);
    assert.deepEqual(readState(h).assets, [old]);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("dry-run reads an interrupted journal and converges its plan without owner, journal, token, or mutation writes", () => {
  const h = scratch();
  try {
    const first = runChild(h, { loseUploadResponse: true, nonce: "winner" });
    assert.notEqual(first.status, 0);
    const beforeFiles = readdirSync(h.recoveryDir).sort();
    const beforeCalls = calls(h).length;
    const dry = runChild(h, { dryRun: true, nonce: "must-not-sign" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).status, "resumed");
    assert.deepEqual(readdirSync(h.recoveryDir).sort(), beforeFiles);
    assert.equal(calls(h).length, beforeCalls, "dry resume emits no sign/token/user/mutation call");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("CLI replacement authority is all-or-none and batch replacement is row-local only", async () => {
  const base = ["--key", "/tmp/key", "--repo", "Holaxis-ai/agentstate-lite"];
  const readableKey = async () => {};
  await assert.rejects(
    parseInspectArgs([...base, "--stage-id", STAGE_ID, "--version", "0.1.0-pre.4", "--draft-release-id", "300", "--replace-asset-id", "401"], { accessKey: readableKey, resolveRepo: async () => "unused" }),
    /requires id, name, and digest together/,
  );
  const h = scratch();
  try {
    const batchPath = path.join(h.root, "batch.json");
    writeFileSync(batchPath, JSON.stringify([{ stage_id: STAGE_ID, version: "0.1.0-pre.4", draft_release_id: "300" }]));
    await assert.rejects(
      parseInspectArgs([...base, "--batch", batchPath, "--replace-asset-id", "401", "--replace-asset-name", NAME, "--replace-asset-digest", `sha256:${"1".repeat(64)}`], { accessKey: readableKey, resolveRepo: async () => "unused" }),
      /global replacement flags are forbidden/,
    );
    writeFileSync(batchPath, JSON.stringify([{
      stage_id: STAGE_ID,
      version: "0.1.0-pre.4",
      draft_release_id: "300",
      replace_existing: { asset_id: 401, name: NAME, digest: `sha256:${"1".repeat(64)}`, extra: true },
    }]));
    await assert.rejects(parseInspectArgs([...base, "--batch", batchPath], { accessKey: readableKey, resolveRepo: async () => "unused" }), /requires exactly/);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("inspection key defaults from a local environment path while explicit --key wins", async () => {
  const row = ["--stage-id", STAGE_ID, "--version", "0.1.0-pre.4", "--draft-release-id", "300"];
  const environment = { SUPERBEE_RELEASE_INSPECTION_KEY: "/tmp/environment-inspection-key" };
  const accessCalls = [];
  const fromEnvironment = await parseInspectArgs(row, {
    env: environment,
    accessKey: async (...args) => { accessCalls.push(args); },
    resolveRepo: async () => "Holaxis-ai/agentstate-lite",
  });
  assert.equal(fromEnvironment.keyPath, environment.SUPERBEE_RELEASE_INSPECTION_KEY);
  assert.deepEqual(accessCalls, [[environment.SUPERBEE_RELEASE_INSPECTION_KEY, constants.R_OK]]);
  const explicitAccessCalls = [];
  const explicit = await parseInspectArgs([...row, "--key", "/tmp/explicit-inspection-key"], {
    env: environment,
    accessKey: async (...args) => { explicitAccessCalls.push(args); },
    resolveRepo: async () => "Holaxis-ai/agentstate-lite",
  });
  assert.equal(explicit.keyPath, "/tmp/explicit-inspection-key");
  assert.deepEqual(explicitAccessCalls, [["/tmp/explicit-inspection-key", constants.R_OK]]);
  await assert.rejects(
    parseInspectArgs(row, { env: { SUPERBEE_RELEASE_INSPECTION_KEY: "  " }, resolveRepo: async () => "Holaxis-ai/agentstate-lite" }),
    /missing --key; pass --key <ssh-private-key> or set SUPERBEE_RELEASE_INSPECTION_KEY/,
  );
  let resolvedAfterUnreadableKey = false;
  await assert.rejects(
    parseInspectArgs(row, {
      env: environment,
      accessKey: async () => { throw new Error("ENOENT"); },
      resolveRepo: async () => {
        resolvedAfterUnreadableKey = true;
        return "Holaxis-ai/agentstate-lite";
      },
    }),
    /SUPERBEE_RELEASE_INSPECTION_KEY is not a readable local key path/,
  );
  assert.equal(resolvedAfterUnreadableKey, false);
  let resolvedAfterUnreadableExplicitKey = false;
  await assert.rejects(
    parseInspectArgs([...row, "--key", "/tmp/missing-explicit-inspection-key"], {
      env: environment,
      accessKey: async () => { throw new Error("ENOENT"); },
      resolveRepo: async () => {
        resolvedAfterUnreadableExplicitKey = true;
        return "Holaxis-ai/agentstate-lite";
      },
    }),
    /--key is not a readable local key path/,
  );
  assert.equal(resolvedAfterUnreadableExplicitKey, false);
});

test("GitHub actor proof is exact, non-redirecting, and never accepts a redirect or other login", async () => {
  const seen = [];
  await proveGitHubActor({
    token: "secret",
    actor: "briand-ai",
    request: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ login: "briand-ai" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(seen[0].url, "https://api.github.com/user");
  assert.equal(seen[0].init.redirect, "manual");
  assert.equal(seen[0].init.headers.Authorization, "Bearer secret");
  await assert.rejects(
    proveGitHubActor({ token: "secret", actor: "briand-ai", request: async () => new Response(null, { status: 302 }) }),
    /HTTP 302/,
  );
  await assert.rejects(
    proveGitHubActor({
      token: "secret",
      actor: "briand-ai",
      request: async () => new Response(JSON.stringify({ login: "mikec-ai" }), { status: 200 }),
    }),
    /does not match the journal actor/,
  );
});

test("M2 RESPONSE REDACTION — reflected /user login and invalid uploaded identity never reach diagnostics", async () => {
  const canary = "canary-secret-token";
  await assert.rejects(
    proveGitHubActor({
      token: canary,
      actor: "briand-ai",
      request: async () => new Response(JSON.stringify({ login: canary }), { status: 200 }),
    }),
    (error) => !String(error?.message ?? error).includes(canary),
  );

  for (const body of [
    { id: canary, name: NAME, digest: SHA, uploader: { login: "briand-ai" } },
    { id: 900, name: `${canary}/`, digest: SHA, uploader: { login: "briand-ai" } },
    { id: 900, name: NAME, digest: canary, uploader: { login: "briand-ai" } },
  ]) {
    assert.throws(
      () => normalizeAssetTriple(body, "uploaded asset"),
      (error) => !String(error?.message ?? error).includes(canary),
    );
  }

  const module = await import("./release-inspect.mjs");
  assert.equal(typeof module.validateUploadedAssetResponse, "function", "upload response has one redacting validator");
  const expected = { name: NAME, digest: SHA, actor: "briand-ai" };
  for (const body of [
    null,
    { id: canary, name: NAME, digest: SHA, uploader: { login: "briand-ai" } },
    { id: 900, name: canary, digest: SHA, uploader: { login: "briand-ai" } },
    { id: 900, name: NAME, digest: canary, uploader: { login: "briand-ai" } },
    { id: 900, name: NAME, digest: SHA, uploader: { login: canary } },
  ]) {
    assert.throws(
      () => module.validateUploadedAssetResponse(body, expected),
      (error) => !String(error?.message ?? error).includes(canary),
    );
  }

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { proveGitHubActor } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts", "release-inspect.mjs")).href)};
    const canary = process.env.ASLITE_REFLECTION_CANARY;
    try {
      await proveGitHubActor({ token: canary, actor: "briand-ai", request: async () => new Response(JSON.stringify({ login: canary }), { status: 200 }) });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `], {
    encoding: "utf8",
    env: { ...process.env, ASLITE_REFLECTION_CANARY: canary },
  });
  assert.equal(child.status, 1);
  assert.equal(`${child.stdout}\n${child.stderr}`.includes(canary), false, "CLI diagnostics redact reflected token canary");
});

function makeSigner(root, principal) {
  const keyPath = path.join(root, `${principal}-key`);
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", principal, "-f", keyPath]);
  const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  return { keyPath, allowedLine: `${principal} namespaces="${SIGN_NAMESPACE}" ${publicKey}` };
}

function signedReceipt(root, signer, payload) {
  const message = path.join(root, `message-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(message, canonicalPayloadBytes(payload));
  execFileSync("ssh-keygen", ["-Y", "sign", "-f", signer.keyPath, "-n", SIGN_NAMESPACE, message], { stdio: "pipe" });
  return Buffer.from(`${JSON.stringify({ payload, signature: readFileSync(`${message}.sig`, "utf8") }, null, 2)}\n`);
}

test("resumed inspected journal with wrong observed SHA cannot reach DELETE or upload", async () => {
  const h = scratch();
  const token = "canary-pinned-token";
  try {
    mkdirSync(h.recoveryDir, { mode: 0o700 });
    const signer = makeSigner(h.root, "briand-ai");
    const allowedPath = path.join(h.root, "allowed-signers");
    writeFileSync(allowedPath, `${signer.allowedLine}\n`);
    const tarballBytes = Buffer.from("retained tarball bytes");
    const tarballSha = digest(tarballBytes);
    const wrongObservedSha = `sha256:${"b".repeat(64)}`;
    const candidateBytes = Buffer.from(JSON.stringify({
      schema: "superbee.release-candidate.v1",
      target: "bridge",
      package: { name: "@holaxis/aslite" },
      tag: "v0.1.0-pre.4",
      version: "0.1.0-pre.4",
      tarball: { version: "0.1.0-pre.4", sha256: tarballSha, integrity: "sha512-YWJjZA==" },
    }));
    const candidate = { id: 22, name: "candidate.json", digest: digest(candidateBytes), uploader: { login: "github-actions[bot]" } };
    const oldPayload = canonicalReceiptPayload({
      decision: "inspected", stage_id: STAGE_ID, version: "0.1.0-pre.4", tarball_sha256: tarballSha,
      draft_release_id: "300", actor: "briand-ai", emitted_at: "2026-08-09T10:00:00Z", observed_sha256: tarballSha,
    });
    const oldBytes = signedReceipt(h.root, signer, oldPayload);
    const old = { id: 401, name: NAME, digest: digest(oldBytes), uploader: { login: "briand-ai" } };
    const badPayload = canonicalReceiptPayload({
      decision: "inspected", stage_id: STAGE_ID, version: "0.1.0-pre.4", tarball_sha256: tarballSha,
      draft_release_id: "300", actor: "briand-ai", emitted_at: "2026-08-09T11:00:00Z", observed_sha256: wrongObservedSha,
    });
    const badBytes = signedReceipt(h.root, signer, badPayload);
    let assets = [candidate, old];
    const bytesById = new Map([[22, candidateBytes], [401, oldBytes]]);
    const requests = [];
    const slotAuthority = {
      schema: "aslite.receipt-recovery-slot.v1",
      github_host: "github.com",
      repo: "Holaxis-ai/agentstate-lite",
      draft_release_id: "300",
      tag: "v0.1.0-pre.4",
      stage_id: STAGE_ID,
      version: "0.1.0-pre.4",
      tarball_sha256: tarballSha,
      decision: "inspected",
      receipt_name: NAME,
    };
    const key = canonicalSlotKey(slotAuthority);
    writeFileSync(path.join(h.recoveryDir, `${key}.json`), `${JSON.stringify({
      schema: "aslite.receipt-recovery-journal.v1",
      version: 1,
      slot_key: key,
      slot: slotAuthority,
      prior: { kind: "existing", asset: { id: old.id, name: old.name, digest: old.digest } },
      proposed: { bytes_base64: badBytes.toString("base64"), digest: digest(badBytes), actor: "briand-ai" },
      revision: 1,
      phase: "prepared",
      remote: {},
      owner_token: "323e4567-e89b-42d3-a456-426614174000",
      updated_at: "2026-08-09T11:00:01Z",
    }, null, 2)}\n`, { mode: 0o600 });

    function run(command, args, options = {}) {
      if (command === "gh" && args[0] === "api" && args.includes("--paginate")) return JSON.stringify([assets]);
      if (command === "gh" && args[0] === "api" && args.includes("repos/Holaxis-ai/agentstate-lite/releases/300")) {
        return JSON.stringify({
          id: 300, draft: true, tag_name: "v0.1.0-pre.4",
          upload_url: "https://uploads.github.com/repos/Holaxis-ai/agentstate-lite/releases/300/assets{?name,label}",
        });
      }
      if (command === "gh" && args[0] === "api" && args.includes("Accept: application/octet-stream")) {
        const id = Number(args.at(-1).split("/").at(-1));
        return bytesById.get(id);
      }
      if (command === "gh" && args[0] === "auth") return `${token}\n`;
      if (command === "ssh-keygen") return execFileSync(command, args, options);
      throw new Error(`unexpected child command: ${command} ${args.join(" ")}`);
    }

    async function request(url, init) {
      const href = String(url);
      requests.push({ href, method: init.method });
      if (href === "https://api.github.com/user") return new Response(JSON.stringify({ login: "briand-ai" }), { status: 200 });
      if (init.method === "DELETE") {
        assets = assets.filter((asset) => asset.id !== 401);
        return new Response(null, { status: 204 });
      }
      if (init.method === "POST") {
        const bytes = Buffer.from(init.body);
        const created = { id: 900, name: NAME, digest: digest(bytes), uploader: { login: "briand-ai" } };
        assets.push(created);
        bytesById.set(900, bytes);
        return new Response(JSON.stringify(created), { status: 201 });
      }
      throw new Error(`unexpected request ${init.method} ${href}`);
    }

    const result = await inspectMain([
      "--stage-id", STAGE_ID, "--version", "0.1.0-pre.4", "--draft-release-id", "300",
      "--decision", "inspected", "--key", signer.keyPath, "--repo", "Holaxis-ai/agentstate-lite",
      "--allowed-signers", allowedPath, "--recovery-dir", h.recoveryDir,
      "--replace-asset-id", "401", "--replace-asset-name", NAME, "--replace-asset-digest", old.digest,
    ], { run, request, now: () => "2026-08-09T11:00:00Z" });
    assert.deepEqual(result.rows.map((row) => row.status), ["failed"]);
    assert.match(result.rows[0].error, /observed SHA/i);
    assert.equal(requests.some((item) => item.method === "DELETE" || item.method === "POST"), false);
    assert.deepEqual(assets, [candidate, old]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("production CLI adapter performs paginated exact replacement with one scrubbed signer-pinned token", async () => {
  const h = scratch();
  const token = "canary-pinned-token";
  const priorEnv = Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_REPO"].map((name) => [name, process.env[name]]));
  try {
    for (const name of Object.keys(priorEnv)) process.env[name] = `ambient-${name}`;
    const signer = makeSigner(h.root, "briand-ai");
    const allowedPath = path.join(h.root, "allowed-signers");
    writeFileSync(allowedPath, `${signer.allowedLine}\n`);
    const tarballBytes = Buffer.from("retained tarball bytes");
    const tarballSha = digest(tarballBytes);
    const candidateBytes = Buffer.from(JSON.stringify({
      schema: "superbee.release-candidate.v1",
      target: "bridge",
      package: { name: "@holaxis/aslite" },
      tag: "v0.1.0-pre.4",
      version: "0.1.0-pre.4",
      tarball: { version: "0.1.0-pre.4", sha256: tarballSha, integrity: "sha512-YWJjZA==" },
    }));
    const candidate = { id: 22, name: "candidate.json", digest: digest(candidateBytes), uploader: { login: "github-actions[bot]" } };
    const oldPayload = canonicalReceiptPayload({
      decision: "inspected", stage_id: STAGE_ID, version: "0.1.0-pre.4", tarball_sha256: tarballSha,
      draft_release_id: "300", actor: "briand-ai", emitted_at: "2026-08-09T10:00:00Z", observed_sha256: tarballSha,
    });
    const oldBytes = signedReceipt(h.root, signer, oldPayload);
    const old = { id: 401, name: NAME, digest: digest(oldBytes), uploader: { login: "briand-ai" } };
    let assets = [candidate, old];
    const bytesById = new Map([[22, candidateBytes], [401, oldBytes]]);
    const commands = [];
    const requests = [];

    function run(command, args, options = {}) {
      commands.push({ command, args: [...args], env: { ...(options.env ?? {}) } });
      for (const name of Object.keys(priorEnv)) assert.equal(options.env?.[name], undefined, `${command} child inherited ${name}`);
      if (command === "gh" && args[0] === "api" && args.includes("--paginate")) return JSON.stringify([assets]);
      if (command === "gh" && args[0] === "api" && args.includes("repos/Holaxis-ai/agentstate-lite/releases/300")) {
        return JSON.stringify({
          id: 300, draft: true, tag_name: "v0.1.0-pre.4",
          upload_url: "https://uploads.github.com/repos/Holaxis-ai/agentstate-lite/releases/300/assets{?name,label}",
        });
      }
      if (command === "gh" && args[0] === "api" && args.includes("Accept: application/octet-stream")) {
        const id = Number(args.at(-1).split("/").at(-1));
        return bytesById.get(id);
      }
      if (command === "gh" && args.join(" ") === "api --hostname github.com user --jq .login") return "briand-ai\n";
      if (command === "gh" && args[0] === "auth") {
        assert.deepEqual(args, ["auth", "token", "--hostname", "github.com", "--user", "briand-ai"]);
        return `${token}\n`;
      }
      if (command === "npm" && args[0] === "stage") {
        writeFileSync(path.join(options.cwd, `holaxis-aslite-0.1.0-pre.4-${STAGE_ID}.tgz`), tarballBytes);
        return "";
      }
      if (command === "ssh-keygen") return execFileSync(command, args, options);
      throw new Error(`unexpected child command: ${command} ${args.join(" ")}`);
    }

    async function request(url, init) {
      const href = String(url);
      requests.push({ href, init });
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      if (href === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "briand-ai" }), { status: 200 });
      }
      if (init.method === "DELETE") {
        assert.equal(href, "https://api.github.com/repos/Holaxis-ai/agentstate-lite/releases/assets/401");
        assets = assets.filter((asset) => asset.id !== 401);
        return new Response(null, { status: 204 });
      }
      if (init.method === "POST") {
        assert.equal(href, `https://uploads.github.com/repos/Holaxis-ai/agentstate-lite/releases/300/assets?name=${encodeURIComponent(NAME)}`);
        const bytes = Buffer.from(init.body);
        const created = { id: 900, name: NAME, digest: digest(bytes), uploader: { login: "briand-ai" } };
        assets.push(created);
        bytesById.set(900, bytes);
        return new Response(JSON.stringify(created), { status: 201 });
      }
      throw new Error(`unexpected request ${init.method} ${href}`);
    }

    const result = await inspectMain([
      "--stage-id", STAGE_ID, "--version", "0.1.0-pre.4", "--draft-release-id", "300",
      "--decision", "inspected", "--key", signer.keyPath, "--repo", "Holaxis-ai/agentstate-lite",
      "--allowed-signers", allowedPath, "--recovery-dir", h.recoveryDir,
      "--replace-asset-id", "401", "--replace-asset-name", NAME, "--replace-asset-digest", old.digest,
    ], { run, request, now: () => "2026-08-09T11:00:00Z" });
    assert.deepEqual(result.rows.map((row) => row.status), ["replaced"]);
    assert.equal(requests.filter((item) => item.init.method === "DELETE").length, 1);
    assert.equal(requests.filter((item) => item.init.method === "POST").length, 1);
    assert.equal(requests.filter((item) => item.href === "https://api.github.com/user").length, 2, "same token is proved before DELETE and upload");
    assert.ok(commands.some((item) => item.args.includes("--paginate") && item.args.includes("--slurp")));
    for (const item of commands.filter((entry) => entry.command === "gh" && entry.args[0] === "api")) {
      assert.deepEqual(item.args.slice(0, 3), ["api", "--hostname", "github.com"]);
    }
    assert.equal(assets.filter((asset) => asset.name === NAME).length, 1);
    assert.equal(readdirSync(h.recoveryDir).length, 0);
    const commandText = JSON.stringify(commands);
    assert.equal(commandText.includes(token), false, "raw token never enters child argv or environment");
  } finally {
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("approval inspection verifies the successor package coordinate from candidate target metadata", async () => {
  const h = scratch();
  try {
    const signer = makeSigner(h.root, "briand-ai");
    const allowedPath = path.join(h.root, "allowed-signers");
    writeFileSync(allowedPath, `${signer.allowedLine}\n`);
    const tarballSha = `sha256:${"d".repeat(64)}`;
    const candidateBytes = Buffer.from(JSON.stringify({
      schema: "superbee.release-candidate.v1",
      target: "successor-preview",
      package: { name: "superbee" },
      tag: "v0.1.1-pre.1",
      version: "0.1.1-pre.1",
      tarball: { version: "0.1.1-pre.1", sha256: tarballSha, integrity: "sha512-c3VwZXJiZWU=" },
    }));
    const candidate = { id: 22, name: "candidate.json", digest: digest(candidateBytes), uploader: { login: "github-actions[bot]" } };
    const commands = [];
    const requests = [];

    function run(command, args, options = {}) {
      commands.push({ command, args: [...args] });
      if (command === "gh" && args[0] === "api" && args.includes("--paginate")) return JSON.stringify([[candidate]]);
      if (command === "gh" && args[0] === "api" && args.includes("repos/Holaxis-ai/superbee-rename-mirror/releases/300")) {
        return JSON.stringify({
          id: 300, draft: true, tag_name: "v0.1.1-pre.1",
          upload_url: "https://uploads.github.com/repos/Holaxis-ai/superbee-rename-mirror/releases/300/assets{?name,label}",
        });
      }
      if (command === "gh" && args[0] === "api" && args.includes("Accept: application/octet-stream")) return candidateBytes;
      if (command === "gh" && args.join(" ") === "api --hostname github.com user --jq .login") return "briand-ai\n";
      if (command === "gh" && args[0] === "auth") return "token\n";
      if (command === "npm" && args[0] === "view") {
        assert.deepEqual(args, ["view", "superbee@0.1.1-pre.1", "dist", "--json"]);
        return JSON.stringify({ integrity: "sha512-c3VwZXJiZWU=" });
      }
      if (command === "ssh-keygen") return execFileSync(command, args, options);
      throw new Error(`unexpected child command: ${command} ${args.join(" ")}`);
    }

    async function request(url, init) {
      requests.push({ href: String(url), method: init.method });
      if (String(url) === "https://api.github.com/user") return new Response(JSON.stringify({ login: "briand-ai" }), { status: 200 });
      if (init.method === "POST") {
        const bytes = Buffer.from(init.body);
        return new Response(JSON.stringify({ id: 900, name: `receipt-approved-${STAGE_ID}.json`, digest: digest(bytes), uploader: { login: "briand-ai" } }), { status: 201 });
      }
      throw new Error(`unexpected request ${init.method} ${String(url)}`);
    }

    const result = await inspectMain([
      "--stage-id", STAGE_ID,
      "--version", "0.1.1-pre.1",
      "--draft-release-id", "300",
      "--decision", "approved",
      "--target", "successor-preview",
      "--key", signer.keyPath,
      "--repo", "Holaxis-ai/superbee-rename-mirror",
      "--allowed-signers", allowedPath,
      "--recovery-dir", h.recoveryDir,
      "--dry-run",
    ], { run, request, now: () => "2026-08-09T11:00:00Z" });
    assert.deepEqual(result.rows.map((row) => row.status), ["uploaded"]);
    assert.ok(commands.some((item) => item.command === "npm" && item.args[1] === "superbee@0.1.1-pre.1"));
    assert.equal(requests.some((item) => item.method === "POST"), false, "dry-run still emits no upload");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("approval inspection rejects an ambiguous package-only Superbee candidate without an explicit target", async () => {
  const h = scratch();
  try {
    const signer = makeSigner(h.root, "briand-ai");
    const allowedPath = path.join(h.root, "allowed-signers");
    writeFileSync(allowedPath, `${signer.allowedLine}\n`);
    const candidateBytes = Buffer.from(JSON.stringify({
      schema: "superbee.release-candidate.v1",
      package: { name: "superbee" },
      tag: "v0.1.1-pre.1",
      version: "0.1.1-pre.1",
      tarball: { version: "0.1.1-pre.1", sha256: `sha256:${"d".repeat(64)}`, integrity: "sha512-c3VwZXJiZWU=" },
    }));
    const candidate = { id: 22, name: "candidate.json", digest: digest(candidateBytes), uploader: { login: "github-actions[bot]" } };
    const commands = [];

    function run(command, args, options = {}) {
      commands.push({ command, args: [...args] });
      if (command === "gh" && args[0] === "api" && args.includes("--paginate")) return JSON.stringify([[candidate]]);
      if (command === "gh" && args[0] === "api" && args.includes("repos/Holaxis-ai/superbee-rename-mirror/releases/300")) {
        return JSON.stringify({
          id: 300,
          draft: true,
          tag_name: "v0.1.1-pre.1",
          upload_url: "https://uploads.github.com/repos/Holaxis-ai/superbee-rename-mirror/releases/300/assets{?name,label}",
        });
      }
      if (command === "gh" && args.includes("Accept: application/octet-stream")) return candidateBytes;
      if (command === "gh" && args.join(" ") === "api --hostname github.com user --jq .login") return "briand-ai\n";
      if (command === "gh" && args[0] === "auth") return "token\n";
      if (command === "ssh-keygen") return execFileSync(command, args, options);
      throw new Error(`unexpected child command: ${command} ${args.join(" ")}`);
    }

    async function request(url, init) {
      if (String(url) === "https://api.github.com/user") return new Response(JSON.stringify({ login: "briand-ai" }), { status: 200 });
      throw new Error(`unexpected request ${init.method} ${String(url)}`);
    }

    const result = await inspectMain([
        "--stage-id", STAGE_ID,
        "--version", "0.1.1-pre.1",
        "--draft-release-id", "300",
        "--decision", "approved",
        "--key", signer.keyPath,
        "--repo", "Holaxis-ai/superbee-rename-mirror",
        "--allowed-signers", allowedPath,
        "--recovery-dir", h.recoveryDir,
        "--dry-run",
      ], { run, request, now: () => "2026-08-09T11:00:00Z" });
    assert.deepEqual(result.rows.map((row) => row.status), ["failed"]);
    assert.match(result.rows[0].error ?? "", /ambiguous across targets successor-preview, successor-stable; explicit target required/);
    assert.equal(commands.some((item) => item.command === "npm"), false, "inspection must fail before any bridge registry lookup");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
