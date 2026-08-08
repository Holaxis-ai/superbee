#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

export const BOT_BRANCH = "automation/version-bundle";
export const BASE_BRANCH = "main";
export const PLAN_SCHEMA = "aslite.version-bundle-bridge-plan.v1";
export const BOT_OWNED_PATHS = Object.freeze([
  ".claude-plugin/marketplace.json",
  "plugins/agentstate-lite/.codex-plugin/plugin.json",
  "plugins/agentstate-lite/skills/agentstate-lite/SKILL.md",
  "plugins/agentstate-lite/skills/agentstate-lite/scripts/agentstate-lite.mjs",
  "plugins/agentstate-lite/skills/agentstate-lite/references/**",
]);

export const ACTIONS = Object.freeze({
  CREATE_REF_AND_PR: "create_ref_and_pr",
  REUSE_REF_CREATE_PR: "reuse_ref_create_pr",
  REUSE_REF_RECONCILE_PR: "reuse_ref_reconcile_pr",
  REPLACE_REF_CREATE_PR: "replace_ref_create_pr",
  REPLACE_REF_RECONCILE_PR: "replace_ref_reconcile_pr",
  CLOSE_STALE_PR: "close_stale_pr",
  NOOP: "noop",
});

const MUTATING_ACTIONS = new Set(Object.values(ACTIONS).filter((action) => action !== ACTIONS.NOOP));
const CHANGE_KEYS = ["path", "change", "old_mode", "new_mode", "old_blob", "new_blob"];
const PR_KEYS = ["number", "state", "url", "base_ref", "head_ref", "head_repository", "head_oid"];
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MODE_RE = /^(?:100644|100755)$/;

export function canonicalJson(value) {
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function planDigest(plan) {
  const { plan_sha256: _ignored, ...unsigned } = plan;
  return sha256(canonicalJson(unsigned));
}

function changesDigest(changes) {
  return sha256(canonicalJson(changes));
}

function equal(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function comparePaths(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function requireOid(value, label) {
  if (!OID_RE.test(value ?? "")) throw new Error(`${label} must be a full Git object ID`);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !equal(Object.keys(value), keys)) {
    throw new Error(`${label} does not have the canonical field set/order`);
  }
}

function assertChange(change, index) {
  assertExactKeys(change, CHANGE_KEYS, `change entry ${index}`);
  if (!isBotOwnedPath(change.path)) throw new Error(`change entry ${index} escapes the bot-owned path set: ${change.path}`);
  if (!["A", "M", "D"].includes(change.change)) throw new Error(`change entry ${index} has an invalid change kind`);
  for (const side of ["old", "new"]) {
    const mode = change[`${side}_mode`];
    const blob = change[`${side}_blob`];
    if ((mode === null) !== (blob === null)) throw new Error(`change entry ${index} has an incomplete ${side} binding`);
    if (mode !== null && !MODE_RE.test(mode)) throw new Error(`change entry ${index} has an invalid ${side} mode`);
    if (blob !== null) requireOid(blob, `change entry ${index} ${side} blob`);
  }
  if (change.change === "A" && (change.old_mode !== null || change.new_mode === null)) {
    throw new Error(`change entry ${index} has invalid add bindings`);
  }
  if (change.change === "D" && (change.new_mode !== null || change.old_mode === null)) {
    throw new Error(`change entry ${index} has invalid delete bindings`);
  }
  if (change.change === "M" && (change.old_mode === null || change.new_mode === null)) {
    throw new Error(`change entry ${index} has invalid modify bindings`);
  }
}

function assertPullRequestRow(row, index) {
  assertExactKeys(row, PR_KEYS, `pull-request row ${index}`);
  if (!Number.isSafeInteger(row.number) || row.number <= 0) throw new Error(`pull-request row ${index} has an invalid number`);
  if (row.state !== "open") throw new Error(`pull-request row ${index} is not open`);
  if (typeof row.url !== "string" || !row.url) throw new Error(`pull-request row ${index} has no URL`);
  for (const key of ["base_ref", "head_ref", "head_repository"]) {
    if (typeof row[key] !== "string" || !row[key]) throw new Error(`pull-request row ${index} has invalid ${key}`);
  }
  requireOid(row.head_oid, `pull-request row ${index} head`);
}

export function isBotOwnedPath(path) {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\0")) return false;
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) return false;
  if (BOT_OWNED_PATHS.slice(0, 4).includes(path)) return true;
  return path.startsWith("plugins/agentstate-lite/skills/agentstate-lite/references/");
}

export function classifyPullRequests(rows, { repository, refOid }) {
  if (rows.length === 0) return { classification: "none", pull_request: null };
  if (rows.length > 1) return { classification: "ambiguous", pull_request: null };
  const row = rows[0];
  const exact =
    refOid !== null &&
    row.state === "open" &&
    row.base_ref === BASE_BRANCH &&
    row.head_ref === BOT_BRANCH &&
    row.head_repository === repository &&
    row.head_oid === refOid;
  return exact
    ? { classification: "exact", pull_request: { number: row.number, head_oid: row.head_oid } }
    : { classification: "foreign", pull_request: null };
}

export function chooseAction({ changed, refClassification, prClassification }) {
  if (refClassification === "foreign" || prClassification === "ambiguous" || prClassification === "foreign") {
    throw new Error(`blocked repository state: ${refClassification} ref / ${prClassification} PR`);
  }
  if (refClassification === "absent" && prClassification !== "none") {
    throw new Error(`blocked inconsistent state: absent ref / ${prClassification} PR`);
  }
  if (changed) {
    if (refClassification === "absent" && prClassification === "none") return ACTIONS.CREATE_REF_AND_PR;
    if (refClassification === "current_candidate" && prClassification === "none") return ACTIONS.REUSE_REF_CREATE_PR;
    if (refClassification === "current_candidate" && prClassification === "exact") return ACTIONS.REUSE_REF_RECONCILE_PR;
    if (refClassification === "replaceable_prior_proposal" && prClassification === "none") return ACTIONS.REPLACE_REF_CREATE_PR;
    if (refClassification === "replaceable_prior_proposal" && prClassification === "exact") return ACTIONS.REPLACE_REF_RECONCILE_PR;
  } else {
    if (refClassification === "absent" && prClassification === "none") return ACTIONS.NOOP;
    if (["current_candidate", "replaceable_prior_proposal"].includes(refClassification)) {
      if (prClassification === "none") return ACTIONS.NOOP;
      if (prClassification === "exact") return ACTIONS.CLOSE_STALE_PR;
    }
  }
  throw new Error(`blocked repository state: no action for ${changed}/${refClassification}/${prClassification}`);
}

function validateAutomationRef(ref) {
  assertExactKeys(ref, ["present", "oid", "classification", "parent_oid", "tree_oid"], "automation ref");
  if (typeof ref.present !== "boolean") throw new Error("automation ref present flag must be boolean");
  if (!["absent", "current_candidate", "replaceable_prior_proposal", "foreign"].includes(ref.classification)) {
    throw new Error("automation ref classification is invalid");
  }
  if (!ref.present) {
    if (ref.oid !== null || ref.parent_oid !== null || ref.tree_oid !== null || ref.classification !== "absent") {
      throw new Error("absent automation ref carries object state");
    }
  } else {
    requireOid(ref.oid, "automation ref oid");
    requireOid(ref.tree_oid, "automation ref tree");
    if (ref.parent_oid !== null) requireOid(ref.parent_oid, "automation ref parent");
  }
}

export function validatePlan(plan) {
  assertExactKeys(
    plan,
    [
      "schema",
      "repository",
      "base_ref",
      "head_ref",
      "base",
      "generator",
      "changes",
      "changes_sha256",
      "automation_ref",
      "same_head_pull_requests",
      "action",
      "pull_request",
      "plan_sha256",
    ],
    "bridge plan",
  );
  if (plan.schema !== PLAN_SCHEMA) throw new Error(`unsupported bridge plan schema: ${plan.schema}`);
  if (!/^[^/]+\/[^/]+$/.test(plan.repository)) throw new Error("plan repository must be owner/name");
  if (plan.base_ref !== BASE_BRANCH || plan.head_ref !== BOT_BRANCH) throw new Error("plan refs are not the fixed bridge refs");
  assertExactKeys(plan.base, ["oid", "tree_oid"], "base");
  requireOid(plan.base.oid, "base oid");
  requireOid(plan.base.tree_oid, "base tree");
  assertExactKeys(plan.generator, ["changed", "manifest_version"], "generator");
  if (typeof plan.generator.changed !== "boolean") throw new Error("generator changed flag must be boolean");
  if (plan.generator.changed !== (plan.changes.length > 0)) throw new Error("generator changed flag disagrees with changes");
  if (plan.generator.changed) {
    if (!/^\d+\.\d+\.\d+$/.test(plan.generator.manifest_version ?? "")) throw new Error("changed plan has invalid manifest version");
  } else if (plan.generator.manifest_version !== null) {
    throw new Error("unchanged plan must bind a null generated manifest version");
  }
  if (!Array.isArray(plan.changes)) throw new Error("plan changes must be an array");
  plan.changes.forEach(assertChange);
  const sortedChanges = [...plan.changes].sort((a, b) => comparePaths(a.path, b.path));
  if (!equal(plan.changes, sortedChanges)) throw new Error("plan changes are not path-sorted");
  if (plan.changes_sha256 !== changesDigest(plan.changes)) throw new Error("changes digest mismatch");
  validateAutomationRef(plan.automation_ref);
  if (!Array.isArray(plan.same_head_pull_requests)) throw new Error("PR inventory must be an array");
  plan.same_head_pull_requests.forEach(assertPullRequestRow);
  const sortedPrs = [...plan.same_head_pull_requests].sort((a, b) => a.number - b.number);
  if (!equal(plan.same_head_pull_requests, sortedPrs)) throw new Error("PR inventory is not number-sorted");
  const prClass = classifyPullRequests(plan.same_head_pull_requests, {
    repository: plan.repository,
    refOid: plan.automation_ref.oid,
  });
  const expectedAction = chooseAction({
    changed: plan.generator.changed,
    refClassification: plan.automation_ref.classification,
    prClassification: prClass.classification,
  });
  if (plan.action !== expectedAction) throw new Error("plan action disagrees with the normative action table");
  if (!equal(plan.pull_request, prClass.pull_request)) throw new Error("plan PR identity disagrees with its inventory");
  if (plan.plan_sha256 !== planDigest(plan)) throw new Error("plan digest mismatch");
  return plan;
}

function normalizePullRequests(pulls) {
  return pulls
    .map((pull) => {
      if (PR_KEYS.every((key) => Object.hasOwn(pull, key))) {
        return Object.fromEntries(PR_KEYS.map((key) => [key, pull[key]]));
      }
      return {
        number: pull.number,
        state: pull.state,
        url: pull.html_url,
        base_ref: pull.base?.ref ?? null,
        head_ref: pull.head?.ref ?? null,
        head_repository: pull.head?.repo?.full_name ?? null,
        head_oid: pull.head?.sha ?? null,
      };
    })
    .sort((a, b) => a.number - b.number);
}

function splitRepository(repository) {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) throw new Error(`repository must be owner/name, got ${repository}`);
  return { owner, repo };
}

async function observePullRequests(github, repository) {
  const { owner, repo } = splitRepository(repository);
  return normalizePullRequests(await github.listSameHeadPullRequests(owner, repo, `${owner}:${BOT_BRANCH}`));
}

export async function inspectPlan({ repository, github, repositoryName }) {
  splitRepository(repositoryName);
  const local = await repository.observeLocal();
  if (local.head_oid === undefined || local.head_tree_oid === undefined || local.index_tree_oid === undefined) {
    throw new Error("local observation is incomplete");
  }
  if (local.index_tree_oid !== local.head_tree_oid) throw new Error("ordinary index must equal the base tree before planning");
  const changes = [...local.changes].sort((a, b) => comparePaths(a.path, b.path));
  changes.forEach(assertChange);
  const remote = await repository.observeRemote({ baseOid: local.head_oid, changes });
  if (remote.main_oid !== local.head_oid) throw new Error("checked-out HEAD is not the current remote main tip");
  const pullRequests = await observePullRequests(github, repositoryName);
  pullRequests.forEach(assertPullRequestRow);
  const prClass = classifyPullRequests(pullRequests, {
    repository: repositoryName,
    refOid: remote.automation_ref.oid,
  });
  const action = chooseAction({
    changed: changes.length > 0,
    refClassification: remote.automation_ref.classification,
    prClassification: prClass.classification,
  });
  const unsigned = {
    schema: PLAN_SCHEMA,
    repository: repositoryName,
    base_ref: BASE_BRANCH,
    head_ref: BOT_BRANCH,
    base: { oid: local.head_oid, tree_oid: local.head_tree_oid },
    generator: { changed: changes.length > 0, manifest_version: changes.length > 0 ? local.manifest_version : null },
    changes,
    changes_sha256: changesDigest(changes),
    automation_ref: remote.automation_ref,
    same_head_pull_requests: pullRequests,
    action,
    pull_request: prClass.pull_request,
  };
  return validatePlan({ ...unsigned, plan_sha256: sha256(canonicalJson(unsigned)) });
}

function proposalTitle(version) {
  return `ci: plugin ${version} — regenerate bundle + SKILL`;
}

function proposalBody(plan) {
  return [
    "This PR was created by the version-bundle automation bridge.",
    "",
    `Base: \`${plan.base.oid}\``,
    `Generated version: \`${plan.generator.manifest_version}\``,
    `Plan: \`${plan.plan_sha256}\``,
    "",
    "It requires the ordinary protected-branch checks and human review; the automation never merges it.",
  ].join("\n");
}

function requireSameLocalPlan(plan, local) {
  const actual = {
    head_oid: local.head_oid,
    head_tree_oid: local.head_tree_oid,
    index_tree_oid: local.index_tree_oid,
    changes: [...local.changes].sort((a, b) => comparePaths(a.path, b.path)),
    manifest_version: local.changes.length > 0 ? local.manifest_version : null,
  };
  const expected = {
    head_oid: plan.base.oid,
    head_tree_oid: plan.base.tree_oid,
    index_tree_oid: plan.base.tree_oid,
    changes: plan.changes,
    manifest_version: plan.generator.manifest_version,
  };
  if (!equal(actual, expected)) throw new Error("local HEAD/index/path/mode/blob/manifest inventory changed after inspect");
}

function requireSameRemotePlan(plan, remote) {
  if (remote.main_oid !== plan.base.oid) throw new Error("remote main moved after inspect; retry from the newer main event");
  if (!equal(remote.automation_ref, plan.automation_ref)) throw new Error("automation ref changed after inspect");
}

function requireSamePrPlan(plan, pulls) {
  if (!equal(pulls, plan.same_head_pull_requests)) throw new Error("same-head PR inventory changed after inspect");
}

function requireExactPrAtBarrier(rows, repository, candidateOid, expectedNumber) {
  const state = classifyPullRequests(rows, { repository, refOid: candidateOid });
  if (state.classification !== "exact" || state.pull_request.number !== expectedNumber) {
    throw new Error("PR identity race at the mutation barrier");
  }
}

export async function applyPlan({ plan, repository, github, repositoryName }) {
  validatePlan(plan);
  if (repositoryName !== plan.repository) throw new Error("runtime repository differs from the signed plan");

  const local = await repository.observeLocal();
  requireSameLocalPlan(plan, local);
  const remote = await repository.observeRemote({ baseOid: plan.base.oid, changes: plan.changes });
  requireSameRemotePlan(plan, remote);
  const initialPulls = await observePullRequests(github, plan.repository);
  requireSamePrPlan(plan, initialPulls);

  if (plan.action === ACTIONS.NOOP) return { action: ACTIONS.NOOP };

  let candidateOid = plan.automation_ref.oid;
  if ([ACTIONS.CREATE_REF_AND_PR, ACTIONS.REPLACE_REF_CREATE_PR, ACTIONS.REPLACE_REF_RECONCILE_PR].includes(plan.action)) {
    candidateOid = await repository.stageAndCommit(plan);
    requireOid(candidateOid, "candidate commit");
    const prePushRemote = await repository.observeRemote({ baseOid: plan.base.oid, changes: plan.changes });
    requireSameRemotePlan(plan, prePushRemote);
    const expectedOid = plan.automation_ref.present ? plan.automation_ref.oid : null;
    await repository.pushAutomationRef(candidateOid, expectedOid);
  }

  if (typeof repository.readAutomationOid === "function") {
    const liveOid = await repository.readAutomationOid();
    if (liveOid !== candidateOid) throw new Error("automation ref does not equal the selected candidate at the PR barrier");
  }

  const barrierPulls = await observePullRequests(github, plan.repository);
  const { owner, repo } = splitRepository(plan.repository);
  const title = proposalTitle(plan.generator.manifest_version);
  const body = proposalBody(plan);
  let pullNumber = plan.pull_request?.number ?? null;

  if ([ACTIONS.CREATE_REF_AND_PR, ACTIONS.REUSE_REF_CREATE_PR, ACTIONS.REPLACE_REF_CREATE_PR].includes(plan.action)) {
    if (barrierPulls.length !== 0) throw new Error("PR inventory race at the create barrier");
    const created = await github.createPullRequest({ owner, repo, title, body, head: BOT_BRANCH, base: BASE_BRANCH });
    pullNumber = created.number;
  } else if ([ACTIONS.REUSE_REF_RECONCILE_PR, ACTIONS.REPLACE_REF_RECONCILE_PR].includes(plan.action)) {
    requireExactPrAtBarrier(barrierPulls, plan.repository, candidateOid, plan.pull_request.number);
    await github.reconcilePullRequest(owner, repo, plan.pull_request.number, title, body);
  } else if (plan.action === ACTIONS.CLOSE_STALE_PR) {
    requireExactPrAtBarrier(barrierPulls, plan.repository, candidateOid, plan.pull_request.number);
    await github.closePullRequest(owner, repo, plan.pull_request.number);
  } else {
    throw new Error(`apply refuses unknown action: ${plan.action}`);
  }

  const finalPulls = await observePullRequests(github, plan.repository);
  if (plan.action === ACTIONS.CLOSE_STALE_PR) {
    if (finalPulls.length !== 0) throw new Error("stale PR remains open after close");
    const closed = await github.getPullRequest(owner, repo, plan.pull_request.number);
    const identity = normalizePullRequests([{ ...closed, state: "open" }])[0];
    if (
      closed.state !== "closed" ||
      identity.number !== plan.pull_request.number ||
      identity.base_ref !== BASE_BRANCH ||
      identity.head_ref !== BOT_BRANCH ||
      identity.head_repository !== plan.repository ||
      identity.head_oid !== candidateOid
    ) {
      throw new Error("closed PR postcondition does not match the planned exact PR");
    }
  } else {
    requireExactPrAtBarrier(finalPulls, plan.repository, candidateOid, pullNumber);
    const reconciled = await github.getPullRequest(owner, repo, pullNumber);
    if (reconciled.title !== title || reconciled.body !== body) {
      throw new Error("PR metadata postcondition does not match the canonical title/body");
    }
  }

  if (typeof repository.readAutomationOid === "function" && (await repository.readAutomationOid()) !== candidateOid) {
    throw new Error("automation ref changed before the final postcondition");
  }
  return { action: plan.action, candidate_oid: candidateOid, pull_request_number: pullNumber };
}

async function executeGit(cwd, args, { allowExitCodes = [], gitEnv = {} } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...gitEnv },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const code = Number(error.code);
    if (allowExitCodes.includes(code)) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code };
    throw new Error(`git ${args[0]} failed (${error.code}): ${(error.stderr ?? error.message).trim()}`);
  }
}

function parseRawDiff(output) {
  if (!output) return [];
  const fields = output.split("\0");
  const changes = [];
  for (let index = 0; index < fields.length - 1; ) {
    const metadata = fields[index++];
    const path = fields[index++];
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMD])$/.exec(metadata);
    if (!match || !path) throw new Error("git returned a non-canonical raw diff");
    const [, oldMode, newMode, oldBlob, newBlob, status] = match;
    changes.push({
      path,
      change: status,
      old_mode: status === "A" ? null : oldMode,
      new_mode: status === "D" ? null : newMode,
      old_blob: status === "A" ? null : oldBlob,
      new_blob: status === "D" ? null : newBlob,
    });
  }
  return changes.sort((a, b) => comparePaths(a.path, b.path));
}

function parseNameStatus(output) {
  if (!output) return [];
  const fields = output.split("\0");
  const result = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (!/^[AMD]$/.test(status) || !path) throw new Error("working tree contains an unsupported change kind");
    result.push([path, status]);
  }
  return result;
}

function parseLsTree(output) {
  if (!output) return null;
  const match = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(output);
  if (!match) throw new Error("bot-owned path is not a regular Git blob");
  return { mode: match[1], blob: match[2] };
}

function parseManifestVersions(marketplaceText, pluginText) {
  let marketplace;
  let plugin;
  try {
    marketplace = JSON.parse(marketplaceText);
    plugin = JSON.parse(pluginText);
  } catch (error) {
    throw new Error(`generated manifest JSON is invalid: ${error.message}`);
  }
  const marketplaceVersion = marketplace.plugins?.find((entry) => entry.name === "agentstate-lite")?.version;
  const pluginVersion = plugin.version;
  if (!/^\d+\.\d+\.\d+$/.test(marketplaceVersion ?? "") || marketplaceVersion !== pluginVersion) {
    throw new Error("generated manifests do not contain the same plain semantic version");
  }
  return marketplaceVersion;
}

export class LocalRepository {
  constructor({ cwd = process.cwd(), run, remoteToken = null } = {}) {
    this.cwd = cwd;
    this.remoteToken = remoteToken;
    this.run = run ?? ((args, options) => executeGit(this.cwd, args, options));
  }

  #remoteOptions(options = {}) {
    if (!this.remoteToken) return options;
    const authorization = Buffer.from(`x-access-token:${this.remoteToken}`, "utf8").toString("base64");
    return {
      ...options,
      gitEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
      },
    };
  }

  async #result(args, options) {
    const result = await this.run(args, options);
    if (typeof result === "string") return { stdout: result, stderr: "", code: 0 };
    return { stdout: result?.stdout ?? "", stderr: result?.stderr ?? "", code: result?.code ?? 0 };
  }

  async #text(args, options) {
    return (await this.#result(args, options)).stdout.trim();
  }

  async #inventoryWorkingTree() {
    const tracked = parseNameStatus(await this.#text(["diff", "--name-status", "-z", "--no-renames", "HEAD", "--"]));
    const untrackedText = (await this.#result(["ls-files", "--others", "--exclude-standard", "-z", "--"])).stdout;
    const statuses = new Map(tracked);
    for (const path of untrackedText.split("\0").filter(Boolean)) statuses.set(path, "A");
    const changes = [];
    for (const [path, status] of [...statuses].sort(([a], [b]) => comparePaths(a, b))) {
      if (!isBotOwnedPath(path)) throw new Error(`generated change is outside the bot-owned path set: ${path}`);
      const oldEntry = parseLsTree((await this.#result(["ls-tree", "-z", "HEAD", "--", `:(literal)${path}`])).stdout);
      let newEntry = null;
      if (status !== "D") {
        const file = await lstat(resolve(this.cwd, path));
        if (!file.isFile()) throw new Error(`generated bot-owned path is not a regular file: ${path}`);
        newEntry = {
          mode: file.mode & 0o111 ? "100755" : "100644",
          blob: await this.#text(["hash-object", "--no-filters", "--", path]),
        };
      }
      changes.push({
        path,
        change: status,
        old_mode: oldEntry?.mode ?? null,
        new_mode: newEntry?.mode ?? null,
        old_blob: oldEntry?.blob ?? null,
        new_blob: newEntry?.blob ?? null,
      });
    }
    return changes;
  }

  async #worktreeManifestVersion() {
    const marketplace = await readFile(resolve(this.cwd, ".claude-plugin/marketplace.json"), "utf8");
    const plugin = await readFile(resolve(this.cwd, "plugins/agentstate-lite/.codex-plugin/plugin.json"), "utf8");
    return parseManifestVersions(marketplace, plugin);
  }

  async observeLocal() {
    const head_oid = await this.#text(["rev-parse", "HEAD"]);
    const head_tree_oid = await this.#text(["rev-parse", "HEAD^{tree}"]);
    const index_tree_oid = await this.#text(["write-tree"]);
    const changes = await this.#inventoryWorkingTree();
    const manifestVersion = await this.#worktreeManifestVersion();
    return {
      head_oid,
      head_tree_oid,
      index_tree_oid,
      changes,
      manifest_version: changes.length > 0 ? manifestVersion : null,
    };
  }

  async #remoteRefs() {
    const mainRef = `refs/heads/${BASE_BRANCH}`;
    const botRef = `refs/heads/${BOT_BRANCH}`;
    const output = await this.#text(["ls-remote", "--refs", "origin", mainRef, botRef], this.#remoteOptions());
    const refs = new Map();
    for (const line of output.split("\n").filter(Boolean)) {
      const [oid, name] = line.split(/\s+/);
      if (refs.has(name)) throw new Error(`remote returned duplicate ref ${name}`);
      refs.set(name, oid);
    }
    const mainOid = refs.get(mainRef);
    requireOid(mainOid, "remote main");
    return { mainOid, automationOid: refs.get(botRef) ?? null };
  }

  async #inventoryCommit(parentOid, oid) {
    const output = (await this.#result(["diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "-r", "-z", "--no-renames", parentOid, oid, "--"])).stdout;
    return parseRawDiff(output);
  }

  async #manifestVersionAt(oid) {
    const marketplace = (await this.#result(["show", `${oid}:.claude-plugin/marketplace.json`])).stdout;
    const plugin = (await this.#result(["show", `${oid}:plugins/agentstate-lite/.codex-plugin/plugin.json`])).stdout;
    return parseManifestVersions(marketplace, plugin);
  }

  async #classifyAutomationRef(oid, baseOid, changes) {
    if (oid === null) return { present: false, oid: null, classification: "absent", parent_oid: null, tree_oid: null };
    await this.#result(["fetch", "--no-tags", "--quiet", "origin", oid], this.#remoteOptions());
    const parentLine = await this.#text(["rev-list", "--parents", "-n", "1", oid]);
    const [, ...parents] = parentLine.split(" ");
    const tree_oid = await this.#text(["rev-parse", `${oid}^{tree}`]);
    if (parents.length !== 1) return { present: true, oid, classification: "foreign", parent_oid: null, tree_oid };
    const parent_oid = parents[0];
    const inventory = await this.#inventoryCommit(parent_oid, oid);
    if (parent_oid === baseOid && equal(inventory, changes)) {
      return { present: true, oid, classification: "current_candidate", parent_oid, tree_oid };
    }
    const ancestry = await this.#result(["merge-base", "--is-ancestor", parent_oid, baseOid], { allowExitCodes: [1] });
    const owned = inventory.length > 0 && inventory.every((entry) => isBotOwnedPath(entry.path));
    let version = null;
    try {
      version = await this.#manifestVersionAt(oid);
    } catch {
      // A malformed proposal is foreign.
    }
    const message = (await this.#result(["log", "-1", "--format=%B", oid])).stdout.replace(/\n+$/, "");
    const exactMessage = version === null ? null : `ci: plugin ${version} — regenerate bundle + SKILL (bot)`;
    const classification = ancestry.code === 0 && owned && version !== null && message === exactMessage
      ? "replaceable_prior_proposal"
      : "foreign";
    return { present: true, oid, classification, parent_oid, tree_oid };
  }

  async observeRemote({ baseOid, changes }) {
    const { mainOid, automationOid } = await this.#remoteRefs();
    return {
      main_oid: mainOid,
      automation_ref: await this.#classifyAutomationRef(automationOid, baseOid, changes),
    };
  }

  async stageAndCommit(plan) {
    await this.#result(["add", "-A", "--", ...plan.changes.map((entry) => `:(literal)${entry.path}`)]);
    const staged = parseRawDiff((await this.#result(["diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-renames", "HEAD", "--"])).stdout);
    if (!equal(staged, plan.changes)) {
      throw new Error(`staged inventory differs from the canonical plan: ${canonicalJson(staged)}`);
    }
    const unstaged = await this.#text(["diff", "--name-only", "-z", "--"]);
    const untracked = (await this.#result(["ls-files", "--others", "--exclude-standard", "-z", "--"])).stdout;
    if (unstaged || untracked) throw new Error("working tree gained an unplanned change before candidate commit");
    const message = `ci: plugin ${plan.generator.manifest_version} — regenerate bundle + SKILL (bot)`;
    await this.#result([
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=github-actions[bot]@users.noreply.github.com",
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ]);
    const oid = await this.#text(["rev-parse", "HEAD"]);
    const parentLine = await this.#text(["rev-list", "--parents", "-n", "1", oid]);
    const [, ...parents] = parentLine.split(" ");
    if (!equal(parents, [plan.base.oid])) throw new Error("candidate commit does not have exactly the planned base parent");
    if (!equal(await this.#inventoryCommit(plan.base.oid, oid), plan.changes)) {
      throw new Error("candidate commit diff differs from the canonical plan");
    }
    return oid;
  }

  async pushAutomationRef(candidateOid, expectedOid) {
    const ref = `refs/heads/${BOT_BRANCH}`;
    await this.run(
      ["push", "origin", `${candidateOid}:${ref}`, `--force-with-lease=${ref}:${expectedOid ?? ""}`],
      this.#remoteOptions(),
    );
  }

  async readAutomationOid() {
    return (await this.#remoteRefs()).automationOid;
  }
}

export class GitHubBridgeClient {
  constructor({ token, fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new Error("a GitHub token is required for the selected bridge phase");
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async #request(method, path, body) {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }

  async listSameHeadPullRequests(owner, repo, head) {
    const all = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        state: "open",
        head,
        sort: "created",
        direction: "asc",
        per_page: "100",
        page: String(page),
      });
      const rows = await this.#request("GET", `/repos/${owner}/${repo}/pulls?${query}`);
      if (!Array.isArray(rows)) throw new Error("GitHub pull-request inventory was not an array");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  }

  async createPullRequest({ owner, repo, title, body, head, base }) {
    return this.#request("POST", `/repos/${owner}/${repo}/pulls`, { title, body, head, base });
  }

  async reconcilePullRequest(owner, repo, number, title, body) {
    return this.#request("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, { title, body });
  }

  async closePullRequest(owner, repo, number) {
    return this.#request("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, { state: "closed" });
  }

  async getPullRequest(owner, repo, number) {
    return this.#request("GET", `/repos/${owner}/${repo}/pulls/${number}`);
  }
}

function parseCli(argv) {
  const [phase, flag, planPath, ...rest] = argv;
  if (!["inspect", "apply"].includes(phase) || flag !== "--plan" || !planPath || rest.length > 0) {
    throw new Error("usage: ci-version-bundle-pr.mjs <inspect|apply> --plan <path>");
  }
  return { phase, planPath };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { phase, planPath } = parseCli(argv);
  const repositoryName = env.GITHUB_REPOSITORY;
  splitRepository(repositoryName ?? "");
  if (phase === "inspect") {
    const repository = new LocalRepository({ remoteToken: env.GITHUB_TOKEN });
    const github = new GitHubBridgeClient({ token: env.GITHUB_TOKEN });
    const plan = await inspectPlan({ repository, github, repositoryName });
    await writeFile(planPath, `${canonicalJson(plan)}\n`, { mode: 0o600 });
    const needsMutation = MUTATING_ACTIONS.has(plan.action);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `needs_mutation=${needsMutation}\n`);
    process.stdout.write(`bridge plan ${plan.plan_sha256}: ${plan.action}\n`);
    return;
  }
  const repository = new LocalRepository({ remoteToken: env.VERSION_BUNDLE_APP_TOKEN });
  const github = new GitHubBridgeClient({ token: env.VERSION_BUNDLE_APP_TOKEN });
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const result = await applyPlan({ plan, repository, github, repositoryName });
  process.stdout.write(`bridge apply: ${result.action}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
