import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTIONS,
  BOT_BRANCH,
  BOT_OWNED_PATHS,
  GitHubBridgeClient,
  LocalRepository,
  applyPlan,
  canonicalJson,
  chooseAction,
  classifyPullRequests,
  inspectPlan,
  isBotOwnedPath,
  planDigest,
  validatePlan,
} from "./ci-version-bundle-pr.mjs";

const OID = {
  base: "1111111111111111111111111111111111111111",
  baseTree: "2222222222222222222222222222222222222222",
  prior: "3333333333333333333333333333333333333333",
  current: "4444444444444444444444444444444444444444",
  new: "5555555555555555555555555555555555555555",
  blobOld: "6666666666666666666666666666666666666666",
  blobNew: "7777777777777777777777777777777777777777",
};

const change = Object.freeze({
  path: ".claude-plugin/marketplace.json",
  change: "M",
  old_mode: "100644",
  new_mode: "100644",
  old_blob: OID.blobOld,
  new_blob: OID.blobNew,
});

function ref(classification = "absent", oid = null) {
  return {
    present: oid !== null,
    oid,
    classification,
    parent_oid: classification === "replaceable_prior_proposal" ? OID.prior : classification === "current_candidate" ? OID.base : null,
    tree_oid: oid === null ? null : OID.baseTree,
  };
}

function prRow({ number = 7, base_ref = "main", head_oid = OID.current, head_repository = "Holaxis-ai/agentstate-lite", state = "open" } = {}) {
  return {
    number,
    state,
    url: `https://github.com/Holaxis-ai/agentstate-lite/pull/${number}`,
    base_ref,
    head_ref: BOT_BRANCH,
    head_repository,
    head_oid,
  };
}

const rows = [
  [true, "absent", "none", ACTIONS.CREATE_REF_AND_PR],
  [true, "current_candidate", "none", ACTIONS.REUSE_REF_CREATE_PR],
  [true, "current_candidate", "exact", ACTIONS.REUSE_REF_RECONCILE_PR],
  [true, "replaceable_prior_proposal", "none", ACTIONS.REPLACE_REF_CREATE_PR],
  [true, "replaceable_prior_proposal", "exact", ACTIONS.REPLACE_REF_RECONCILE_PR],
  [false, "absent", "none", ACTIONS.NOOP],
  [false, "current_candidate", "none", ACTIONS.NOOP],
  [false, "replaceable_prior_proposal", "none", ACTIONS.NOOP],
  [false, "current_candidate", "exact", ACTIONS.CLOSE_STALE_PR],
  [false, "replaceable_prior_proposal", "exact", ACTIONS.CLOSE_STALE_PR],
];

describe("normative generator × ref × PR table", () => {
  for (const [changed, refClass, prClass, expected] of rows) {
    test(`${changed ? "changed" : "unchanged"} / ${refClass} / ${prClass}`, () => {
      assert.equal(chooseAction({ changed, refClassification: refClass, prClassification: prClass }), expected);
    });
  }

  for (const invalid of [
    [true, "foreign", "none"],
    [false, "foreign", "none"],
    [true, "absent", "foreign"],
    [true, "current_candidate", "ambiguous"],
    [false, "absent", "exact"],
  ]) {
    test(`blocks ${invalid.join(" / ")}`, () => {
      assert.throws(
        () => chooseAction({ changed: invalid[0], refClassification: invalid[1], prClassification: invalid[2] }),
        /blocked/i,
      );
    });
  }
});

test("bot-owned paths are one closed allowlist", () => {
  assert.equal(BOT_BRANCH, "automation/version-bundle");
  assert.deepEqual(BOT_OWNED_PATHS.slice(0, 4), [
    ".claude-plugin/marketplace.json",
    "plugins/agentstate-lite/.codex-plugin/plugin.json",
    "plugins/agentstate-lite/skills/agentstate-lite/SKILL.md",
    "plugins/agentstate-lite/skills/agentstate-lite/scripts/agentstate-lite.mjs",
  ]);
  assert.equal(isBotOwnedPath("plugins/agentstate-lite/skills/agentstate-lite/references/release.md"), true);
  assert.equal(isBotOwnedPath("plugins/agentstate-lite/skills/agentstate-lite/references"), false);
  assert.equal(isBotOwnedPath("scripts/ci-version-bundle-pr.mjs"), false);
  assert.equal(isBotOwnedPath("plugins/agentstate-lite/skills/agentstate-lite/references/../SKILL.md"), false);
});

test("PR inventory is classified locally and binds base, repo, ref, and live OID", () => {
  const expected = { repository: "Holaxis-ai/agentstate-lite", refOid: OID.current };
  assert.equal(classifyPullRequests([], expected).classification, "none");
  assert.equal(classifyPullRequests([prRow()], expected).classification, "exact");
  assert.equal(classifyPullRequests([prRow({ base_ref: "develop" })], expected).classification, "foreign");
  assert.equal(classifyPullRequests([prRow({ head_oid: OID.prior })], expected).classification, "foreign");
  assert.equal(classifyPullRequests([prRow({ head_repository: "fork/agentstate-lite" })], expected).classification, "foreign");
  assert.equal(classifyPullRequests([prRow(), prRow({ number: 8 })], expected).classification, "ambiguous");
});

test("GitHub discovery is base-independent and paginates the complete same-head inventory", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    number: index + 2,
    state: "open",
    html_url: `https://example.invalid/${index + 2}`,
    base: { ref: index === 0 ? "wrong-base" : "main" },
    head: { ref: BOT_BRANCH, sha: OID.current, repo: { full_name: "Holaxis-ai/agentstate-lite" } },
  }));
  const finalRow = {
        number: 1,
        state: "open",
        html_url: "https://example.invalid/1",
        base: { ref: "main" },
        head: { ref: BOT_BRANCH, sha: OID.current, repo: { full_name: "Holaxis-ai/agentstate-lite" } },
      };
  const github = new GitHubBridgeClient({
    token: "read-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const page = new URL(url).searchParams.get("page");
      return new Response(JSON.stringify(page === "1" ? firstPage : [finalRow]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const inventory = await github.listSameHeadPullRequests("Holaxis-ai", "agentstate-lite", `${"Holaxis-ai"}:${BOT_BRANCH}`);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get("head"), `Holaxis-ai:${BOT_BRANCH}`);
    assert.equal(url.searchParams.get("state"), "open");
    assert.equal(url.searchParams.has("base"), false, "base filtering would hide hostile/wrong-base same-head PRs");
    assert.equal(call.options.method, "GET");
  }
  assert.equal(inventory.length, 101);
  assert.equal(inventory[0].base.ref, "wrong-base", "wrong-base rows must remain visible to local classification");
});

test("scratch Git repository binds real bytes/modes and creates one exact leased candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-version-bundle-pr-git-"));
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    await mkdir(remote);
    git(remote, ["init", "--bare"]);
    await mkdir(checkout);
    git(checkout, ["init", "-b", "main"]);
    git(checkout, ["config", "user.name", "fixture"]);
    git(checkout, ["config", "user.email", "fixture@example.invalid"]);
    await mkdir(join(checkout, ".claude-plugin"), { recursive: true });
    await mkdir(join(checkout, "plugins/agentstate-lite/.codex-plugin"), { recursive: true });
    await writeFile(
      join(checkout, ".claude-plugin/marketplace.json"),
      '{"plugins":[{"name":"agentstate-lite","version":"1.0.0"}]}\n',
    );
    await writeFile(
      join(checkout, "plugins/agentstate-lite/.codex-plugin/plugin.json"),
      '{"name":"agentstate-lite","version":"1.0.0"}\n',
    );
    git(checkout, ["add", "."]);
    git(checkout, ["commit", "-m", "base"]);
    git(checkout, ["remote", "add", "origin", remote]);
    git(checkout, ["push", "-u", "origin", "main"]);

    await writeFile(
      join(checkout, ".claude-plugin/marketplace.json"),
      '{"plugins":[{"name":"agentstate-lite","version":"1.0.1"}]}\n',
    );
    await writeFile(
      join(checkout, "plugins/agentstate-lite/.codex-plugin/plugin.json"),
      '{"name":"agentstate-lite","version":"1.0.1"}\n',
    );

    const repository = new LocalRepository({ cwd: checkout });
    const plan = await inspectPlan({
      repository,
      github: fakeGithub(),
      repositoryName: "Holaxis-ai/agentstate-lite",
    });
    assert.equal(plan.changes.length, 2);
    assert.ok(plan.changes.every((entry) => entry.change === "M" && entry.old_mode === "100644" && entry.new_mode === "100644"));
    assert.ok(plan.changes.every((entry) => entry.old_blob !== entry.new_blob));

    const candidate = await repository.stageAndCommit(plan);
    assert.equal(git(checkout, ["rev-parse", `${candidate}^`]), plan.base.oid);
    await repository.pushAutomationRef(candidate, null);
    assert.equal(await repository.readAutomationOid(), candidate);
    const observed = await repository.observeRemote({ baseOid: plan.base.oid, changes: plan.changes });
    assert.equal(observed.automation_ref.classification, "current_candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeRepo({ changed = true, refState = ref(), mainOid = OID.base, localChanges = changed ? [change] : [] } = {}) {
  const calls = [];
  const local = {
    head_oid: OID.base,
    head_tree_oid: OID.baseTree,
    index_tree_oid: OID.baseTree,
    changes: localChanges,
    manifest_version: changed ? "1.0.1" : null,
  };
  return {
    calls,
    async observeLocal() { return structuredClone(local); },
    async observeRemote({ baseOid, changes }) {
      assert.equal(baseOid, OID.base);
      assert.deepEqual(changes, localChanges);
      return { main_oid: mainOid, automation_ref: structuredClone(refState) };
    },
    async stageAndCommit(plan) { calls.push(["commit", plan.changes]); return OID.new; },
    async pushAutomationRef(candidateOid, expectedOid) { calls.push(["push", candidateOid, expectedOid]); },
  };
}

function fakeGithub({ pulls = [] } = {}) {
  const calls = [];
  let metadata = { title: null, body: null };
  let closed = false;
  return {
    calls,
    async listSameHeadPullRequests() { return structuredClone(pulls); },
    async createPullRequest(input) {
      calls.push(["create", input]);
      metadata = { title: input.title, body: input.body };
      return { number: 9 };
    },
    async reconcilePullRequest(_owner, _repo, number, title, body) {
      calls.push(["update", number, { title, body }]);
      metadata = { title, body };
    },
    async closePullRequest(_owner, _repo, number) {
      calls.push(["update", number, { state: "closed" }]);
      closed = true;
    },
    async getPullRequest(_owner, _repo, number) {
      return {
        number,
        state: closed ? "closed" : "open",
        title: metadata.title,
        body: metadata.body,
        base: { ref: "main" },
        head: { ref: BOT_BRANCH, sha: OID.current, repo: { full_name: "Holaxis-ai/agentstate-lite" } },
      };
    },
  };
}

test("inspect emits canonical byte/mode/blob bindings and a self-verifying digest", async () => {
  const repository = fakeRepo();
  const github = fakeGithub();
  const plan = await inspectPlan({ repository, github, repositoryName: "Holaxis-ai/agentstate-lite" });
  assert.equal(plan.schema, "aslite.version-bundle-bridge-plan.v1");
  assert.deepEqual(plan.changes, [change]);
  assert.equal(plan.generator.changed, true);
  assert.equal(plan.generator.manifest_version, "1.0.1");
  assert.equal(plan.action, ACTIONS.CREATE_REF_AND_PR);
  assert.equal(plan.plan_sha256, planDigest(plan));
  assert.equal(validatePlan(JSON.parse(canonicalJson(plan))).plan_sha256, plan.plan_sha256);

  const weakened = structuredClone(plan);
  delete weakened.changes[0].new_mode;
  weakened.changes_sha256 = plan.changes_sha256;
  weakened.plan_sha256 = planDigest(weakened);
  assert.throws(() => validatePlan(weakened), /change entry|changes digest/i);
});

test("inspect rejects path escape before returning a mutation plan", async () => {
  const repository = fakeRepo({ localChanges: [...[change], { ...change, path: "README.md" }] });
  await assert.rejects(
    inspectPlan({ repository, github: fakeGithub(), repositoryName: "Holaxis-ai/agentstate-lite" }),
    /bot-owned path/i,
  );
  assert.deepEqual(repository.calls, []);
});

async function planned({ changed = true, refState = ref(), pulls = [] } = {}) {
  return inspectPlan({
    repository: fakeRepo({ changed, refState }),
    github: fakeGithub({ pulls }),
    repositoryName: "Holaxis-ai/agentstate-lite",
  });
}

test("apply blocks main movement before any local or external mutation", async () => {
  const plan = await planned();
  const repository = fakeRepo({ mainOid: OID.prior });
  const github = fakeGithub();
  await assert.rejects(applyPlan({ plan, repository, github, repositoryName: plan.repository }), /remote main moved/i);
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(github.calls, []);
});

test("apply revalidates exact local mode/blob inventory before mutation", async () => {
  const plan = await planned();
  const repository = fakeRepo({ localChanges: [{ ...change, new_mode: "100755" }] });
  const github = fakeGithub();
  await assert.rejects(applyPlan({ plan, repository, github, repositoryName: plan.repository }), /local.*changed|inventory/i);
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(github.calls, []);
});

test("new-ref apply commits once and pushes with an exact expected-absence lease", async () => {
  const plan = await planned();
  const repository = fakeRepo();
  const postPull = prRow({ number: 9, head_oid: OID.new });
  const github = fakeGithub();
  let reads = 0;
  github.listSameHeadPullRequests = async () => (++reads <= 2 ? [] : [postPull]);
  await applyPlan({ plan, repository, github, repositoryName: plan.repository });
  assert.deepEqual(repository.calls, [["commit", [change]], ["push", OID.new, null]]);
  assert.equal(github.calls[0][0], "create");
});

test("branch-only interruption recovery reuses the current head without another push", async () => {
  const current = ref("current_candidate", OID.current);
  const plan = await planned({ refState: current });
  const repository = fakeRepo({ refState: current });
  const github = fakeGithub();
  let reads = 0;
  github.listSameHeadPullRequests = async () => (++reads <= 2 ? [] : [prRow({ number: 9 })]);
  await applyPlan({ plan, repository, github, repositoryName: plan.repository });
  assert.deepEqual(repository.calls, [], "an exact current branch is proof of the already-built candidate");
  assert.equal(github.calls[0][0], "create");
});

test("prior proposal replacement leases the exact observed OID and reconciles only its exact PR", async () => {
  const priorRef = ref("replaceable_prior_proposal", OID.current);
  const oldPr = prRow({ head_oid: OID.current });
  const plan = await planned({ refState: priorRef, pulls: [oldPr] });
  const repository = fakeRepo({ refState: priorRef });
  const github = fakeGithub({ pulls: [oldPr] });
  let reads = 0;
  github.listSameHeadPullRequests = async () => (++reads === 1 ? [oldPr] : [prRow({ head_oid: OID.new })]);
  await applyPlan({ plan, repository, github, repositoryName: plan.repository });
  assert.deepEqual(repository.calls.at(-1), ["push", OID.new, OID.current]);
  assert.deepEqual(github.calls[0].slice(0, 2), ["update", 7]);
});

test("stale exact PR closes without pushing or deleting the automation ref", async () => {
  const current = ref("current_candidate", OID.current);
  const exact = prRow();
  const plan = await planned({ changed: false, refState: current, pulls: [exact] });
  const repository = fakeRepo({ changed: false, refState: current });
  const github = fakeGithub({ pulls: [exact] });
  let reads = 0;
  github.listSameHeadPullRequests = async () => (++reads <= 2 ? [exact] : []);
  await applyPlan({ plan, repository, github, repositoryName: plan.repository });
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(github.calls[0], ["update", 7, { state: "closed" }]);
});

test("wrong PR OID appearing at the PR mutation barrier fails closed", async () => {
  const current = ref("current_candidate", OID.current);
  const plan = await planned({ refState: current });
  const repository = fakeRepo({ refState: current });
  const github = fakeGithub();
  let reads = 0;
  github.listSameHeadPullRequests = async () => (++reads === 1 ? [] : [prRow({ head_oid: OID.prior })]);
  await assert.rejects(applyPlan({ plan, repository, github, repositoryName: plan.repository }), /PR.*race|inventory/i);
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(github.calls, []);
});

test("LocalRepository emits only the fixed branch push with exact force-with-lease", async () => {
  const commands = [];
  const run = async (args) => { commands.push(args); return ""; };
  const repository = new LocalRepository({ cwd: "/unused", run });
  await repository.pushAutomationRef(OID.new, null);
  await repository.pushAutomationRef(OID.new, OID.current);
  assert.deepEqual(commands, [
    ["push", "origin", `${OID.new}:refs/heads/automation/version-bundle`, "--force-with-lease=refs/heads/automation/version-bundle:"],
    [
      "push",
      "origin",
      `${OID.new}:refs/heads/automation/version-bundle`,
      `--force-with-lease=refs/heads/automation/version-bundle:${OID.current}`,
    ],
  ]);
  assert.equal(commands.flat().some((arg) => arg === "--force" || arg.includes("refs/heads/main") || arg.includes("refs/tags/")), false);
});

test("the apply credential authenticates Git without persisting or placing the token in argv", async () => {
  const calls = [];
  const repository = new LocalRepository({
    cwd: "/unused",
    remoteToken: "installation-secret",
    run: async (args, options) => { calls.push({ args, options }); return ""; },
  });
  await repository.pushAutomationRef(OID.new, OID.current);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].args.join(" "), /installation-secret/);
  assert.equal(calls[0].options.gitEnv.GIT_CONFIG_COUNT, "1");
  assert.equal(calls[0].options.gitEnv.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.match(calls[0].options.gitEnv.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
});
