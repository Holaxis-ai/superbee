import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { operationsFor } from "./release-run-operations.mjs";
import { loadReleaseTargets } from "./release-targets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staged = readFileSync(path.join(repoRoot, ".github", "workflows", "release-staged.yml"), "utf8");
const finalize = readFileSync(path.join(repoRoot, ".github", "workflows", "release-finalize.yml"), "utf8");
const verifyOrdering = readFileSync(path.join(repoRoot, "scripts", "release-verify-ordering.mjs"), "utf8");

// Split a workflow's `jobs:` mapping into { jobName -> rawJobText } using the 2-space job-header
// indentation. Dependency-free (no yaml package in the published boundary); the format is ours.
function extractJobs(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((l) => l === "jobs:");
  assert.notEqual(jobsAt, -1, "workflow must declare jobs:");
  const jobs = {};
  let current = null;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      if (current) jobs[current].push(line);
      continue;
    }
    // A comment at job-header depth is not structure: it neither opens a job nor ends the mapping,
    // and it belongs to no job. Comments indented deeper sit inside a job and are kept with it.
    if (/^ {0,2}#/.test(line)) continue;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs[current] = [];
      continue;
    }
    // A non-blank line indented 2 or fewer spaces ends the jobs: mapping.
    if (!/^ {3,}/.test(line)) break;
    if (current) jobs[current].push(line);
  }
  const out = {};
  for (const [k, v] of Object.entries(jobs)) out[k] = v.join("\n");
  return out;
}

// Extract the `permissions:` block of a job into { scope -> value }.
function permissionsOf(jobText) {
  const lines = jobText.split("\n");
  const at = lines.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
  if (at === -1) return null;
  const perms = {};
  for (let i = at + 1; i < lines.length; i++) {
    if (/^ {6}#/.test(lines[i])) continue; // comment lines inside the block are legitimate YAML
    const m = /^ {6}([a-z-]+):\s*(\S+)\s*$/.exec(lines[i]);
    if (!m) break;
    perms[m[1]] = m[2];
  }
  return perms;
}

function workflowTargetChoice(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^ {6}target:\s*$/.test(line));
  assert.notEqual(at, -1, "workflow_dispatch target input must exist");
  const result = { options: null, default: null };
  for (let i = at + 1; i < lines.length; i++) {
    if (!/^ {8}/.test(lines[i])) break;
    const optionsMatch = /^ {8}options: \[(.*)\]\s*$/.exec(lines[i]);
    if (optionsMatch) {
      result.options = optionsMatch[1]
        .split(",")
        .map((entry) => entry.trim().replace(/^"|"$/g, ""));
      continue;
    }
    const defaultMatch = /^ {8}default: "(.*)"\s*$/.exec(lines[i]);
    if (defaultMatch) result.default = defaultMatch[1];
  }
  assert.ok(Array.isArray(result.options), "workflow_dispatch target input must declare options");
  assert.equal(typeof result.default, "string", "workflow_dispatch target input must declare a default");
  return result;
}

// Tokens that mean "a build or a pack happened here". The artifact NAME/dir `release-candidate` and
// `release-candidate-<id>` are deliberately NOT in this list — only the command that BUILDS/PACKS.
const BUILD_PACK_TOKENS = ["release:candidate", "release-candidate.mjs", "build.mjs", "npm pack", "npm run build", "buildCli"];

// Tokens that mean "something outside this run changed". Shared by the read-only-job assertions.
const MUTATING_TOKENS = [
  "-X PATCH", "-X POST", "-X DELETE", "-X PUT",
  "--method PATCH", "--method POST", "--method DELETE",
  "gh release upload", "gh release create", "gh release edit", "gh release delete",
  "npm stage approve", "npm stage reject", "npm publish", "npm dist-tag",
  "release-verify-ordering.mjs apply", "--execute",
];

// npm subcommands that read the registry or nothing at all. Everything else — including a
// subcommand nobody has classified yet — is treated as a registry WRITE that needs credentials.
// The unknown case falling into the auth branch is the point: this list can only widen by review.
const NPM_NON_WRITING_SUBCOMMANDS = new Set([
  "view", "pack", "ping", "install", "ci", "run", "exec", "config", "audit", "help", "--version", "-v",
]);

/** Every flag `release-run-operations.mjs` reads, with a value each emitter accepts. */
const OPERATION_SAMPLE_ARGV = [
  "--stage-id", "stage1",
  "--version", "0.1.2",
  "--target", "successor-stable",
  "--track", "next",
  "--failed-version", "0.1.0",
  "--prior-version", "0.0.1",
  "--recovery-target", "bridge",
  "--release-id", "1",
  "--source-commit", "1".repeat(40),
];

/** Logical shell commands in a `run:` block: comments dropped, backslash continuations joined. */
function shellCommands(runBlock) {
  return runBlock
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Does this argv write to the npm registry (and therefore need credentials)? Fails closed. */
function needsRegistryAuth(argv) {
  return argv[0] === "npm" && !NPM_NON_WRITING_SUBCOMMANDS.has(argv[1]);
}

// `npm` in COMMAND position: the start of a command, after a pipeline/list operator, inside a command
// substitution, or after then/else/do. Prose that merely MENTIONS npm — an ::error:: message naming
// the operator's command, a dry-run echo of what would run — is not an invocation and must not be
// scanned as one; a real invocation hidden inside `$(...)` still is.
const NPM_INVOCATION = /(?:^|[|&;(]\s*|\$\(\s*|\bthen\s+|\belse\s+|\bdo\s+)npm\s+([A-Za-z][A-Za-z-]*|--version)/g;

/** Does this job supply npm registry credentials — OIDC trusted publishing or a token? */
function declaresNpmCredentials(jobText) {
  const perms = permissionsOf(jobText) ?? {};
  const oidc = perms["id-token"] === "write" && /registry-url:/.test(jobText);
  return oidc || /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/.test(jobText);
}

/** `needs:` of a job, in both the scalar and the list form. */
function needsOf(jobText) {
  const scalar = /^ {4}needs: ([A-Za-z0-9_-]+)\s*$/m.exec(jobText);
  if (scalar) return [scalar[1]];
  const list = /^ {4}needs: \[([^\]]*)\]\s*$/m.exec(jobText);
  return list ? list[1].split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

/** Extract one workflow step by its explicit `id`, retaining its step-level `env` block. */
function stepWithId(jobText, id) {
  const lines = jobText.split("\n");
  const idAt = lines.findIndex((line) => line === `        id: ${id}`);
  assert.notEqual(idAt, -1, `workflow step ${id} must exist`);
  let start = idAt;
  while (start >= 0 && !/^ {6}- /.test(lines[start])) start -= 1;
  assert.notEqual(start, -1, `workflow step ${id} must start at step indentation`);
  let end = idAt + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

test("neither workflow grants ambient permissions — every job opts in", () => {
  assert.match(staged, /\npermissions: \{\}\n/, "release-staged.yml must set top-level permissions: {}");
  assert.match(finalize, /\npermissions: \{\}\n/, "release-finalize.yml must set top-level permissions: {}");
});

test("staged workflow: each job carries exactly its minimal permissions", () => {
  const jobs = extractJobs(staged);
  assert.deepEqual(Object.keys(jobs).sort(), ["candidate", "draft", "stage"]);
  assert.deepEqual(permissionsOf(jobs.candidate), { contents: "read" }, "candidate reads source only");
  assert.deepEqual(permissionsOf(jobs.draft), { actions: "read", contents: "write" });
  assert.deepEqual(
    permissionsOf(jobs.stage),
    { actions: "read", contents: "read", "id-token": "write" },
    "stage needs exact artifact read + source read + OIDC — never contents:write",
  );
});

test("finalize workflow: prepare and publish are the only mutators; proof is read-only", () => {
  // HONEST framing (live run 31507532220): the original design pinned the gate jobs read-only,
  // but GitHub 403s a read token on GET releases/<id> for an UNPUBLISHED draft — write is the
  // platform's price for LOOKING at a draft. The property that survives is behavioral, not
  // token-shaped: the gate jobs' steps contain no mutating command, pinned below.
  const jobs = extractJobs(finalize);
  assert.deepEqual(Object.keys(jobs).sort(), ["ordering-verified", "prepare", "proof", "publish", "registry-verify", "target-authorized"]);
  assert.deepEqual(permissionsOf(jobs["target-authorized"]), { contents: "read" });
  assert.deepEqual(permissionsOf(jobs["ordering-verified"]), { actions: "read", contents: "write" });
  assert.deepEqual(permissionsOf(jobs["registry-verify"]), { actions: "read", contents: "write" });
  assert.deepEqual(permissionsOf(jobs.prepare), { actions: "read", contents: "write" });
  assert.deepEqual(permissionsOf(jobs.publish), { actions: "read", contents: "write" });
  assert.deepEqual(permissionsOf(jobs.proof), { actions: "read", contents: "read" });
  // No gate job may carry a mutating gh/npm invocation — GETs and octet-stream downloads only.
  for (const name of ["target-authorized", "ordering-verified", "registry-verify", "proof"]) {
    const body = jobs[name];
    for (const token of MUTATING_TOKENS) {
      assert.ok(!body.includes(token), `gate job ${name} must not contain mutating token ${JSON.stringify(token)}`);
    }
  }
});

test("identity-only rehearsal targets stop after candidate verification", () => {
  const stagedJobs = extractJobs(staged);
  assert.match(stagedJobs.draft, /if: needs\.candidate\.outputs\.workflow_contract == 'full'/);
  assert.match(stagedJobs.stage, /if: needs\.candidate\.outputs\.workflow_contract == 'full'/);
  const finalJobs = extractJobs(finalize);
  assert.match(finalJobs["ordering-verified"], /needs: target-authorized/);
  assert.match(finalJobs["target-authorized"], /identity-only rehearsal targets have no finalization path/);
  assert.ok(!staged.includes("rehearsal-reject) TAG="), "workflow must not duplicate rehearsal tag literals outside the manifest");
});

test("workflow target choices enumerate the normalized manifest roster and keep a full-contract default", async () => {
  const manifest = await loadReleaseTargets();
  const expectedIds = Object.keys(manifest.targets);
  for (const [name, text] of [["release-staged.yml", staged], ["release-finalize.yml", finalize]]) {
    const choice = workflowTargetChoice(text);
    assert.deepEqual(choice.options, expectedIds, `${name} target choices must match release/targets.json exactly`);
    assert.ok(expectedIds.includes(choice.default), `${name} default target must exist in release/targets.json`);
    assert.equal(manifest.targets[choice.default].workflow_contract, "full", `${name} default target must be dispatchable`);
  }
});

test("the finalizer persists authority before provisional PATCH and proves publication afterward", () => {
  const jobs = extractJobs(finalize);
  // Job chain: target-authorized -> ordering-verified -> registry-verify -> prepare -> publish -> proof.
  assert.match(jobs["registry-verify"], /needs: ordering-verified/);
  assert.deepEqual(needsOf(jobs.prepare).sort(), ["registry-verify", "target-authorized"]);
  assert.deepEqual(needsOf(jobs.publish), ["prepare"]);
  assert.deepEqual(needsOf(jobs.proof).sort(), ["prepare", "publish"]);
  // The gate replays the state machine over signed receipts in the gate job AND pre-publish.
  for (const name of ["ordering-verified", "prepare"]) {
    assert.match(jobs[name], /release-verify-ordering\.mjs assets/, `${name} lists receipt assets via the one naming authority`);
    assert.match(jobs[name], /release-verify-ordering\.mjs verify/, `${name} verifies signed receipt ordering`);
    assert.match(jobs[name], /--allowed-signers \.github\/release-allowed-signers/, `${name} pins the committed signer file`);
  }
  // Prepare plans and normalizes the draft, proves the exact pre-publication bytes, then uploads
  // all three authority files before any publication PATCH can start.
  const prepare = jobs.prepare;
  const verifyAt = prepare.indexOf("release-verify-ordering.mjs verify");
  const planAt = prepare.indexOf("release-verify-ordering.mjs plan");
  const applyAt = prepare.indexOf("release-verify-ordering.mjs apply");
  const prePublicationQueryAt = prepare.indexOf('> final-draft-release.json');
  const finalAt = prepare.indexOf("release-verify-ordering.mjs final");
  const assembleAt = prepare.indexOf("Assemble the fixed pre-publication proof packet");
  const uploadAt = prepare.indexOf("Persist exact pre-publication authority before PATCH");
  assert.ok([verifyAt, planAt, applyAt, prePublicationQueryAt, finalAt, assembleAt, uploadAt].every((at) => at !== -1));
  assert.ok(
    verifyAt < planAt && planAt < applyAt && applyAt < prePublicationQueryAt
      && prePublicationQueryAt < finalAt && finalAt < assembleAt && assembleAt < uploadAt,
    "verify -> plan -> normalize -> pre-publication proof -> fixed packet -> immutable upload",
  );
  assert.doesNotMatch(prepare, /immutable-release|published-live/, "prepare must end after persisting pre-PATCH authority");
  assert.match(prepare, /retry-safe status --clobber/);

  // Publish independently proves the persisted packet, then performs only the provisional numeric-ID
  // PATCH. Proof independently re-proves the same packet and owns all remote observation/verdict work.
  const publish = jobs.publish;
  const publishPacketAt = publish.indexOf("release-verify-ordering.mjs prepared-artifact");
  const patchAt = publish.indexOf("release-run-operations.mjs --op immutable-release");
  assert.ok(publishPacketAt !== -1 && patchAt !== -1 && publishPacketAt < patchAt);
  assert.match(publish, /^ {4}continue-on-error: true$/m, "the entire publish job is provisional, never the verdict");
  assert.doesNotMatch(publish, /published-live|releases\/latest/, "publish must not own the post-PATCH observation or proof");
  const proof = jobs.proof;
  const proofPacketAt = proof.indexOf("release-verify-ordering.mjs prepared-artifact");
  const publishedProofAt = proof.indexOf("release-verify-ordering.mjs published-live");
  assert.ok(proofPacketAt !== -1 && publishedProofAt !== -1 && proofPacketAt < publishedProofAt);
  assert.doesNotMatch(proof, /immutable-release|--execute|-X PATCH/, "proof must be independently rerunnable and read-only");
  assert.match(verifyOrdering, /releases\/assets\/\$\{item\.id\}/, "cleanup targets exact release-asset IDs");
  assert.match(verifyOrdering, /"--clobber"/, "status upload is retry-safe");
  assert.match(verifyOrdering, /normalizeReceiptStatusBody/, "one owned-body normalizer prepares PATCH bytes");
  assert.match(prepare, /--mode "\$MODE"/, "dry-run traverses the same apply adapter with a zero-mutation mode");
  // The environment gate also binds the ordering job.
  assert.match(jobs["ordering-verified"], /environment: release/);
});

test("denylist scan (NOT a proof): no KNOWN build/pack token appears outside the candidate job", () => {
  // HONEST framing (review #1): this is a denylist of known build/pack commands, which a disguised
  // rebuild (e.g. a bare `npx esbuild ... --outfile x.tgz`) could evade. It is a lint, not the
  // guarantee. The REAL guarantee is the structural SHA-gate test below: what gets staged/published
  // is the re-verified retained artifact, so a disguised rebuild cannot change the staged bytes.
  const jobs = extractJobs(staged);
  for (const token of BUILD_PACK_TOKENS) {
    for (const [name, body] of Object.entries(jobs)) {
      if (name === "candidate") continue;
      assert.ok(!body.includes(token), `job ${name} must not contain build/pack token ${JSON.stringify(token)}`);
    }
  }
  assert.ok(jobs.candidate.includes("release:candidate"), "candidate job must run the release-candidate command");
  for (const token of BUILD_PACK_TOKENS) {
    assert.ok(!finalize.includes(token), `finalize workflow must not contain build/pack token ${JSON.stringify(token)}`);
  }
});

test("THE REAL INVARIANT: every downstream mutating step is preceded by the retained-bytes SHA gate", () => {
  const jobs = extractJobs(staged);
  // The retained-bytes gate token: the re-verify step that compares the downloaded tarball's SHA to
  // the prepared candidate output and `exit 1`s on mismatch.
  const shaGate = 'test "$ACTUAL" = "$EXPECTED_SHA256"';
  // Each downstream job that MUTATES must (a) contain the SHA gate and (b) place it BEFORE the
  // first mutating command — so a mutation can only ever act on re-verified retained bytes.
  const mutating = {
    draft: ["gh release create", "gh release edit", "gh release upload"],
    stage: ["npm stage publish"],
  };
  for (const [job, commands] of Object.entries(mutating)) {
    const body = jobs[job];
    const gateAt = body.indexOf(shaGate);
    assert.notEqual(gateAt, -1, `job ${job} must re-verify the retained SHA before mutating`);
    for (const command of commands) {
      const at = body.indexOf(command);
      if (at === -1) continue; // command not present in this job
      assert.ok(at > gateAt, `in job ${job}, "${command}" must appear AFTER the retained-bytes SHA gate`);
    }
    // And the mutation must target the LITERAL downloaded artifact, never a build output.
    assert.ok(body.includes("download-artifact"), `job ${job} must obtain the retained artifact by download, not build`);
  }
});

test("the stage job stages the LITERAL retained tarball, not a fresh build", () => {
  const jobs = extractJobs(staged);
  assert.match(jobs.stage, /download-artifact/, "stage must download the retained artifact");
  assert.match(jobs.stage, /artifact-ids: \$\{\{ needs\.candidate\.outputs\.artifact_id \}\}/);
  // The leading ./ is load-bearing: npm parses a bare dir/file.tgz as github:owner/repo
  // shorthand and never opens the file (live run 31499362043 died on git ls-remote there).
  assert.match(jobs.stage, /TARBALL="\.\/\$ARTIFACT_DIR\/\$TARBALL_FILENAME"/);
  assert.match(jobs.stage, /npm stage publish "\$TARBALL" --tag "\$POLICY_TAG"/);
  // And it re-verifies the retained bytes against the prepared SHA before staging.
  assert.match(jobs.stage, /needs\.candidate\.outputs\.tarball_sha256/);
});

test("the run ends with immutable identifiers and the interactive inspection instructions", () => {
  const jobs = extractJobs(staged);
  assert.match(jobs.candidate, /run_id: \$\{\{ github\.run_id \}\}/);
  assert.match(jobs.candidate, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(jobs.candidate, /artifact_digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
  assert.match(jobs.stage, /release-emit-receipt\.mjs/, "stage emits the immutable receipt + inspection instructions");
  assert.match(jobs.stage, /release-stage-receipt-/);
  assert.match(jobs.stage, /--stage-id/);
});

test("live registry/release mutation is guarded by MODE == live in BOTH workflows", () => {
  // Every stage/publish/dist-tag mutation sits behind a `[ "$MODE" = "live" ]` guard.
  for (const [name, text] of [["staged", staged], ["finalize", finalize]]) {
    const guardedMutations = /if \[ "\$MODE" = "live" \]/.test(text);
    assert.ok(guardedMutations, `${name} workflow must guard live mutation behind MODE == live`);
  }
  // The default mode is dry-run.
  assert.match(staged, /MODE: \$\{\{ inputs\.mode \|\| 'dry-run' \}\}/);
});

test("EVERY live-mutating/live-executing job binds the protected release environment", () => {
  const stagedJobs = extractJobs(staged);
  const finalizeJobs = extractJobs(finalize);
  // staged: draft (contents:write) + stage (OIDC publish) both gated; candidate (build only) is not.
  assert.match(stagedJobs.draft, /environment: release/, "draft job must bind the release environment");
  assert.match(stagedJobs.stage, /environment: release/, "stage job must bind the release environment");
  assert.doesNotMatch(stagedJobs.candidate, /environment: release/, "candidate builds only — no environment gate needed");
  // finalize: registry verification, draft normalization, and publication are protected; the
  // independently rerunnable read-only proof deliberately holds no environment mutation gate.
  assert.match(finalizeJobs["registry-verify"], /environment: release/, "registry-verify runs live exec — must be gated");
  assert.match(finalizeJobs.prepare, /environment: release/, "prepare mutates draft evidence — must be gated");
  assert.match(finalizeJobs.publish, /environment: release/, "publish PATCH must bind the release environment");
  assert.doesNotMatch(finalizeJobs.proof, /environment: release/, "read-only proof must remain independently rerunnable");
});

test("the finalizer is separately dispatched and consumes every immutable ID", () => {
  assert.match(finalize, /on:\n {2}workflow_dispatch:/, "finalize is workflow_dispatch only (no tag trigger)");
  for (const input of [
    "run_id",
    "artifact_id",
    "stage_receipt_artifact_id",
    "stage_receipt_artifact_digest",
    "stage_id",
    "draft_release_id",
    "version",
  ]) {
    assert.match(finalize, new RegExp(`\\n {6}${input}:`), `finalize must accept the ${input} identifier`);
  }
  assert.match(finalize, /run-id: \$\{\{ inputs\.run_id \}\}/);
  assert.match(finalize, /artifact-ids: \$\{\{ inputs\.artifact_id \}\}/);
  assert.match(finalize, /artifact-ids: \$\{\{ inputs\.stage_receipt_artifact_id \}\}/);
  assert.ok((finalize.match(/release-verify-chain\.mjs verify-finalizer/g) ?? []).length === 3);
  for (const name of ["ordering-verified", "registry-verify", "prepare"]) {
    assert.match(extractJobs(finalize)[name], /--draft-tag-phase pre-patch/, `${name} binds only GitHub's temporary draft identity before PATCH`);
  }
});

// F12 — the publication-policy resolve was a cheap precondition placed AFTER
// `release-verify-ordering.mjs apply --mode live` had already rewritten the draft's status asset and
// body. This pins the general property rather than that one step's position: the facts are resolved
// and the registry proved in a job that mutates nothing, and every mutating job is downstream of it.
test("F12: publication policy is resolved and proved in a non-mutating job, upstream of every mutation", () => {
  const jobs = extractJobs(finalize);
  const gate = jobs["target-authorized"];

  assert.match(gate, /release-resolve-target\.mjs --target "\$TARGET" --tag "v\$VERSION" --github-output "\$GITHUB_OUTPUT"/,
    "the manifest facts are resolved in the first job");
  assert.match(gate, /release-publication-policy\.mjs verify/, "the registry precondition runs in the first job");
  assert.deepEqual(permissionsOf(jobs["target-authorized"]), { contents: "read" }, "the precondition job cannot write anything");

  // Every job that mutates must be reachable FROM target-authorized through `needs:`, so no mutation
  // can ever run before the precondition — including a job added later.
  const ancestors = (name, seen = new Set()) => {
    for (const parent of needsOf(jobs[name] ?? "")) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      ancestors(parent, seen);
    }
    return seen;
  };
  for (const [name, body] of Object.entries(jobs)) {
    if (name === "target-authorized") continue;
    if (!MUTATING_TOKENS.some((token) => body.includes(token))) continue;
    assert.ok(ancestors(name).has("target-authorized"), `mutating job ${name} must depend on the precondition job`);
  }

  // No later job re-runs the target resolver to manufacture policy facts. The finalizer chain may
  // write its already-proven source commit to a step output; that is evidence, not policy.
  for (const [name, body] of Object.entries(jobs)) {
    if (name === "target-authorized") continue;
    assert.doesNotMatch(body, /release-resolve-target\.mjs[^\n]*--github-output/, `job ${name} must not re-resolve policy outputs`);
  }
  assert.match(jobs.prepare, /id: verified_chain/);
  assert.match(jobs.prepare, /--out verified-chain\.json --github-output "\$GITHUB_OUTPUT"/);
  assert.match(jobs.prepare, /source_commit: \$\{\{ steps\.verified_chain\.outputs\.source_commit \}\}/);
  assert.match(jobs.publish, /SOURCE_COMMIT: \$\{\{ needs\.prepare\.outputs\.source_commit \}\}/);
  assert.match(jobs.publish, /--source-commit "\$SOURCE_COMMIT"/);
  assert.doesNotMatch(jobs.publish, /needs\.target-authorized\.outputs\.github_latest/);
  assert.doesNotMatch(jobs.publish, /--github-latest|--github-prerelease/);
});

test("immutable publication accepts no caller-owned GitHub identity policy or tag flags", () => {
  const body = extractJobs(finalize).publish;
  const commands = runBlocks(body)
    .flatMap(shellCommands)
    .filter((command) => command.includes("release-run-operations.mjs --op immutable-release"));
  assert.ok(commands.length >= 1);
  for (const command of commands) {
    assert.match(command, /--target "\$TARGET"/);
    assert.match(command, /--version "\$VERSION"/);
    assert.match(command, /--release-id "\$DRAFT_RELEASE_ID"/);
    assert.match(command, /--source-commit "\$SOURCE_COMMIT"/);
    assert.doesNotMatch(command, /--tag|--github-latest|--github-prerelease|--prerelease|--make-latest/);
  }
});

// F1 — the promote step ran `npm dist-tag add` in a job with no npm credentials, AFTER the ordering
// `apply` step had already rewritten the draft. Under `set -euo pipefail` that leaves npm published
// and the GitHub release stranded as a draft. The class this pins is not "the promote step": it is
// "a registry-authenticated command in a job that cannot authenticate". Which operations authenticate
// is resolved through the real emitter (`operationsFor`), so a new op is classified automatically.
test("F1: no workflow job runs a registry-authenticated command without credentials for it", () => {
  const seen = { authenticated: 0, viaOperationsCli: 0 };
  for (const [workflow, text] of [["release-staged.yml", staged], ["release-finalize.yml", finalize]]) {
    for (const [name, body] of Object.entries(extractJobs(text))) {
      const credentialed = declaresNpmCredentials(body);
      for (const command of runBlocks(body).flatMap(shellCommands)) {
        // (a) operations executed through the release CLI, resolved by the emitter itself.
        if (command.includes("release-run-operations.mjs") && command.includes("--execute")) {
          const op = /--op\s+(\S+)/.exec(command)?.[1];
          assert.ok(op, `${workflow}:${name} runs the operations CLI without --op: ${command}`);
          seen.viaOperationsCli += 1;
          for (const { argv } of operationsFor(op, OPERATION_SAMPLE_ARGV)) {
            if (!needsRegistryAuth(argv)) continue;
            seen.authenticated += 1;
            assert.ok(credentialed, `${workflow}:${name} executes --op ${op} -> \`${argv.join(" ")}\`, which needs npm credentials the job does not declare`);
          }
        }
        // (b) npm invoked directly in the shell.
        for (const [, subcommand] of command.matchAll(NPM_INVOCATION)) {
          if (NPM_NON_WRITING_SUBCOMMANDS.has(subcommand)) continue;
          seen.authenticated += 1;
          assert.ok(credentialed, `${workflow}:${name} runs \`npm ${subcommand}\`, which needs npm credentials the job does not declare`);
        }
      }
    }
  }
  assert.ok(seen.viaOperationsCli > 0, "the scan must actually reach the operations CLI invocations");
  assert.ok(seen.authenticated > 0, "the scan must actually classify at least one authenticated command (the stage publish)");
});

// The scan above is only as good as its notion of "an npm command ran here". Prose that names npm —
// an operator remediation printed by an ::error:: annotation, a dry-run echo of the command that
// WOULD run — must not be mistaken for an invocation, or the gate reds on its own documentation; and
// an invocation hidden in a command substitution must still be caught, or the gate is trivial to evade.
test("F1: the npm-invocation matcher reads command position, not prose", () => {
  const subcommands = (text) => [...text.matchAll(NPM_INVOCATION)].map(([, sub]) => sub);
  for (const prose of [
    'echo "::error::npm registry unreachable - nothing has been mutated"',
    'echo "[dry-run] would run: npm stage publish $TARBALL --tag $POLICY_TAG"',
    'echo "run the operator promotion: npm dist-tag add superbee@0.1.0 latest"',
  ]) {
    assert.deepEqual(subcommands(prose), [], `prose must not read as an invocation: ${prose}`);
  }
  assert.deepEqual(subcommands("npm ci"), ["ci"]);
  assert.deepEqual(subcommands('npm install --global npm@11.15.0 --ignore-scripts'), ["install"], "npm@version is not a subcommand");
  assert.deepEqual(subcommands('test "$(npm --version)" = "11.15.0"'), ["--version"], "command substitution is a command position");
  assert.deepEqual(subcommands('npm stage publish "$TARBALL" --tag "$POLICY_TAG" | tee stage.json'), ["stage"]);
  assert.deepEqual(subcommands('gh api foo && npm dist-tag add pkg@1.0.0 latest'), ["dist-tag"], "an invocation after && is still an invocation");
  assert.equal(needsRegistryAuth(["npm", "dist-tag", "add"]), true);
  assert.equal(needsRegistryAuth(["npm", "view", "pkg"]), false);
  assert.equal(needsRegistryAuth(["npm", "some-command-nobody-classified"]), true, "an unknown subcommand fails closed into the auth branch");
  assert.equal(needsRegistryAuth(["gh", "api", "-X", "PATCH"]), false, "gh is not an npm credential question");
});

test("F1: the dist-tag promotion is operator-owned, and the finalizer proves it instead of performing it", () => {
  const jobs = extractJobs(finalize);
  // No job may EXECUTE the promote: this workflow holds no npm write credential by design.
  for (const [name, body] of Object.entries(jobs)) {
    for (const command of runBlocks(body).flatMap(shellCommands)) {
      assert.ok(
        !(command.includes("--op promote") && command.includes("--execute")),
        `job ${name} must not execute the dist-tag promotion; it is a 2FA operator action: ${command}`,
      );
    }
  }
  // What replaces it is a proof, run before any mutation and again immediately before the
  // persisted packet that authorizes publication.
  assert.match(jobs["target-authorized"], /release-publication-policy\.mjs verify/);
  const body = jobs.prepare;
  const proofAt = body.indexOf("release-publication-policy.mjs verify");
  const uploadAt = body.indexOf("Persist exact pre-publication authority before PATCH");
  assert.notEqual(proofAt, -1, "prepare must re-prove the declared publication policy before persisting authority");
  assert.ok(proofAt < uploadAt, "the re-proof must precede the persisted authority consumed by publication");
  // Both placements traverse the same adapter in dry-run rather than being skipped there.
  for (const [name, job] of [["target-authorized", jobs["target-authorized"]], ["prepare", body]]) {
    const proof = runBlocks(job)
      .flatMap(shellCommands)
      .find((command) => command.includes("release-publication-policy.mjs verify"));
    assert.ok(proof?.includes('--mode "$MODE"'), `${name}'s proof must run in both modes, got ${JSON.stringify(proof)}`);
  }
});

test("the staged workflow triggers on v* tags and on dry-run dispatch", () => {
  assert.match(staged, /on:\n {2}push:\n {4}tags: \["v\*"\]/);
  assert.match(staged, /workflow_dispatch:/);
});

function runBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s+)(?:- )?run:\s*\|\s*$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (i += 1; i < lines.length; i++) {
      if (lines[i].trim() && lines[i].match(/^\s*/)[0].length <= indent) {
        i -= 1;
        break;
      }
      body.push(lines[i]);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

test("untrusted GitHub expressions are never interpolated directly into shell scripts", () => {
  for (const [name, text] of [["staged", staged], ["finalize", finalize]]) {
    for (const block of runBlocks(text)) {
      assert.doesNotMatch(block, /\$\{\{/, `${name} run blocks must receive expressions through env, never script text`);
    }
  }
});

test("live mode fails closed without an explicit P5S environment enablement variable", () => {
  for (const [name, jobs] of [["draft", extractJobs(staged).draft], ["stage", extractJobs(staged).stage], ["registry", extractJobs(finalize)["registry-verify"]], ["prepare", extractJobs(finalize).prepare], ["publish", extractJobs(finalize).publish]]) {
    assert.match(jobs, /vars\.SUPERBEE_RELEASE_LIVE_ENABLED/, `${name} must bind the environment enablement variable`);
    assert.match(jobs, /test "\$LIVE_RELEASE_ENABLED" = "true"/, `${name} must fail unless explicitly enabled`);
  }
});

test("npm staged publishing pins the supported runtime and parses npm's JSON contract", () => {
  const stage = extractJobs(staged).stage;
  assert.match(stage, /node-version: 22\.14\.0/);
  assert.match(stage, /npm@11\.15\.0/);
  assert.match(stage, /npm stage publish "\$TARBALL" --tag "\$POLICY_TAG" --provenance --json/);
  assert.match(stage, /release-verify-chain\.mjs stage-id/);
  assert.doesNotMatch(stage, /sed -nE/);
  assert.doesNotMatch(stage, /stage download .*--out/);
});

test("cross-run downloads have actions:read and select artifacts by ID, not name", () => {
  const jobs = extractJobs(finalize);
  for (const name of ["ordering-verified", "registry-verify", "prepare"]) {
    const body = jobs[name];
    assert.match(body, /artifact-ids: \$\{\{ inputs\.artifact_id \}\}/);
    assert.match(body, /artifact-ids: \$\{\{ inputs\.stage_receipt_artifact_id \}\}/);
    assert.match(body, /run-id: \$\{\{ inputs\.run_id \}\}/);
  }
});

test("prepare, publish, and proof bind one fixed proof artifact by exact identity", () => {
  const jobs = extractJobs(finalize);
  assert.match(jobs.prepare, /name: release-finalization-proof/);
  assert.match(jobs.prepare, /proof_artifact_id: \$\{\{ steps\.upload_proof\.outputs\.artifact-id \}\}/);
  assert.match(jobs.prepare, /proof_artifact_digest: \$\{\{ steps\.upload_proof\.outputs\.artifact-digest \}\}/);
  assert.match(jobs.prepare, /cp verified-chain\.json publication-plan\.json final-publication-proof\.json/);
  for (const name of ["publish", "proof"]) {
    const body = jobs[name];
    assert.match(body, /artifact-ids: \$\{\{ needs\.prepare\.outputs\.proof_artifact_id \}\}/);
    assert.match(body, /PROOF_ARTIFACT_DIGEST: \$\{\{ needs\.prepare\.outputs\.proof_artifact_digest \}\}/);
    assert.match(body, /PROOF_ARTIFACT_HEAD_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(body, /SOURCE_COMMIT: \$\{\{ needs\.prepare\.outputs\.source_commit \}\}/);
    assert.match(body, /--artifact-digest "\$PROOF_ARTIFACT_DIGEST" --run-id "\$GITHUB_RUN_ID"/);
    assert.match(body, /--head-sha "\$PROOF_ARTIFACT_HEAD_SHA" --source-commit "\$SOURCE_COMMIT"/);
    assert.match(body, /release-verify-ordering\.mjs prepared-artifact/);
  }
  assert.doesNotMatch(jobs.proof, /needs\.publish\.outputs/, "proof identity must come only from prepare");
});

test("publication topology makes PATCH provisional and proof independently resumable", () => {
  const jobs = extractJobs(finalize);
  assert.deepEqual(needsOf(jobs.publish), ["prepare"]);
  assert.deepEqual(needsOf(jobs.proof).sort(), ["prepare", "publish"]);
  assert.match(jobs.proof, /if: \$\{\{ always\(\) && needs\.prepare\.result == 'success' && inputs\.mode == 'live' \}\}/);
  const immutableReleaseExecutions = Object.entries(jobs).flatMap(([job, body]) => runBlocks(body)
    .flatMap(shellCommands)
    .filter((command) => command.includes("release-run-operations.mjs --op immutable-release") && command.includes("--execute"))
    .map((command) => ({ job, command })));
  assert.deepEqual(
    immutableReleaseExecutions.map(({ job }) => job),
    ["publish"],
    "only publish may execute the immutable-release PATCH",
  );
  const patchStep = stepWithId(jobs.publish, "patch_release");
  assert.ok(
    patchStep.includes("release-run-operations.mjs --op immutable-release") && patchStep.includes("--execute"),
    "the credentialed step must issue the manifest-derived PATCH command",
  );
  assert.match(patchStep, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m, "the sole PATCH step receives its GitHub credential");
  assert.doesNotMatch(
    jobs.publish,
    /^ {4}env:\n(?: {6}.*\n)* {6}GH_TOKEN:/m,
    "the mutation credential must remain step-scoped rather than reaching every publish step",
  );
  // Step tolerance handles an ordinary client exit. Job tolerance is independently load-bearing:
  // without it a runner/job failure after an applied PATCH makes the workflow red even when the
  // always-running exact-state proof passes, inviting a retry of the ambiguous mutation.
  assert.match(jobs.publish, /id: patch_release\n {8}continue-on-error: true/, "the PATCH step exit is provisional");
  assert.match(jobs.publish, /^ {4}continue-on-error: true$/m, "publish job failure is provisional too, not just its PATCH step");
  assert.doesNotMatch(jobs.publish, /published-live|published-publication-proof/);
  assert.match(jobs.proof, /release-verify-ordering\.mjs published-live/);
  assert.doesNotMatch(jobs.proof, /^ {4}continue-on-error:/m, "proof failure must keep the workflow red");
  assert.doesNotMatch(jobs.proof, /^ {8}continue-on-error:/m, "no proof step may be tolerated");
  for (const token of MUTATING_TOKENS) {
    assert.ok(!jobs.proof.includes(token), `proof must not contain mutating token ${JSON.stringify(token)}`);
  }
});

// Regression: the first live run created its draft and then queried GET releases/tags/<tag> —
// an endpoint that returns only PUBLISHED releases, never drafts (verified empirically: minutes
// after creation, with both assets uploaded, it still 404s). Draft resolution must go through
// the releases LIST / numeric-id endpoints; the tag-addressed release endpoint is forbidden in
// both workflows.
test("no workflow queries the tag-addressed release endpoint (drafts are invisible to it)", () => {
  assert.ok(!staged.includes("releases/tags/"), "release-staged.yml must not query releases/tags/<tag>");
  assert.ok(!finalize.includes("releases/tags/"), "release-finalize.yml must not query releases/tags/<tag>");
  const jobs = extractJobs(staged);
  assert.match(jobs.draft, /resolve_release_id/, "draft job resolves the draft by numeric id");
  assert.match(jobs.draft, /releases\?per_page=100/, "draft resolution lists releases (the endpoint that includes drafts)");
  assert.match(jobs.draft, /releases\/\$RELEASE_ID" > draft-release\.json/, "draft capture fetches by numeric id");
});

// Live-path hardening (the desk-check unit after live runs 31498799904 and 31499362043): the
// draft job's post-create resolve retries the releases list (which lags a just-created draft)
// and still fails closed; the stage job's tarball spec carries the leading ./ that keeps npm
// from parsing dir/file.tgz as github:owner/repo shorthand.
test("the draft job retries post-create resolution and still fails closed", () => {
  const draft = extractJobs(staged).draft;
  const createAt = draft.indexOf("gh release create");
  const retryAt = draft.indexOf("not yet listed (attempt");
  const failAt = draft.indexOf("not resolvable by id");
  assert.ok(createAt !== -1 && retryAt !== -1 && failAt !== -1);
  assert.ok(createAt < retryAt && retryAt < failAt, "create -> bounded retry -> fail-closed guard");
});
