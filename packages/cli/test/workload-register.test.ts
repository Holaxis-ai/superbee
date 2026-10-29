// `superbee workload register`: the prefill link it builds for the hosted workload apps page
// (fragment format v1, owned by superbee-hosted `browser/workload-apps-entry.ts`), from a fake `gh`
// and a site repository's release.config.json. Nothing here opens a browser or reaches GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { workload } from "../src/commands/workload.js";
import { CliError } from "../src/errors.js";

const RELEASE_CONFIG = {
  workflow: { path: ".github/workflows/release.yml", defaultBranch: "main" },
  content: { kind: "hosted", origin: "https://mcp.getsuperbee.com", workspace: "holaxis-sites", bundle: "investor-plan" },
  code: { repository: "Holaxis-ai/holaxis-investor-plan-site" },
};
const REPOSITORY = { id: 1048576, full_name: "Holaxis-ai/holaxis-investor-plan-site", default_branch: "main", owner: { id: 2097152 } };
const REF = "Holaxis-ai/holaxis-investor-plan-site/.github/workflows/release.yml@refs/heads/main";

async function site(config: unknown = RELEASE_CONFIG, workflowFile = "release.yml"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-workload-"));
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(dir, ".github", "workflows", workflowFile), "on: workflow_dispatch\n");
  await writeFile(path.join(dir, "release.config.json"), JSON.stringify(config));
  return dir;
}

const opened: string[] = [];
async function run(argv: string[], cwd: string, gh: (args: readonly string[]) => Promise<string> = async () => JSON.stringify(REPOSITORY)) {
  const out: string[] = [];
  opened.length = 0;
  const calls: string[][] = [];
  await workload(["register", ...argv], {
    cwd,
    stdout: (text) => void out.push(text),
    openBrowser: (url) => void opened.push(url),
    gh: async (args) => {
      calls.push([...args]);
      return gh(args);
    },
  });
  return { receipt: (decode(out.join("")) as any).workload_register, opened, calls };
}

const fragment = (url: string) => new URLSearchParams(url.slice(url.indexOf("#") + 1));

test("builds the v1 prefill from gh and release.config.json and opens it, registering nothing", async () => {
  const { receipt, opened, calls } = await run([], await site());
  assert.deepEqual(calls, [["api", "repos/Holaxis-ai/holaxis-investor-plan-site"]]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0], receipt.url);
  assert.equal(receipt.status, "opened");
  assert.equal(receipt.registered, false);
  const [base] = receipt.url.split("#");
  assert.equal(base, "https://holaxis-sites.getsuperbee.com/settings/workload-apps");
  assert.deepEqual(
    [...fragment(receipt.url)],
    [
      ["v", "1"],
      ["displayName", "Holaxis-ai/holaxis-investor-plan-site"],
      ["repository", "Holaxis-ai/holaxis-investor-plan-site"],
      ["repositoryId", "1048576"],
      ["repositoryOwnerId", "2097152"],
      ["branch", "main"],
      ["workflowRefs", REF],
      ["jobWorkflowRefs", REF],
      ["environment", ""],
      ["events", "schedule"],
      ["events", "repository_dispatch"],
      ["events", "workflow_dispatch"],
      ["bundles", "investor-plan read"],
    ],
  );
  assert.equal(receipt.environment, null);
  assert.match(receipt.environment_note, /outside any GitHub environment/);
  assert.equal(receipt.set_variable, "gh variable set HOSTED_APP_ID --repo Holaxis-ai/holaxis-investor-plan-site --body <app-id>");
  assert.equal(receipt.notes, undefined);
});

test("--no-open prints the link only; --environment, --name and --url reach the fragment", async () => {
  const { receipt, opened } = await run(
    ["--no-open", "--environment", "release", "--name", "Investor site", "--url", "https://holaxis.getsuperbee.com/"],
    await site(),
  );
  assert.deepEqual(opened, []);
  assert.equal(receipt.status, "printed");
  assert.ok(receipt.url.startsWith("https://holaxis.getsuperbee.com/settings/workload-apps#"));
  assert.equal(receipt.page_from, "--url");
  const values = fragment(receipt.url);
  assert.equal(values.get("environment"), "release");
  assert.equal(values.get("displayName"), "Investor site");
});

test("the branch and refs follow GitHub's default branch, and a missing code.repository is read from gh", async () => {
  const config = { ...RELEASE_CONFIG, code: {} };
  const { receipt, calls } = await run(["--no-open"], await site(config), async (args) =>
    args[0] === "repo" ? "Holaxis-ai/holaxis-investor-plan-site\n" : JSON.stringify({ ...REPOSITORY, default_branch: "trunk" }),
  );
  assert.match(receipt.notes[0], /workflow.defaultBranch is main, but GitHub's default branch is trunk/);
  assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  assert.equal(fragment(receipt.url).get("branch"), "trunk");
  assert.equal(fragment(receipt.url).get("workflowRefs"), REF.replace("@refs/heads/main", "@refs/heads/trunk"));
});

test("a gh failure names gh's own first line, so no access and signed out read differently", async () => {
  await assert.rejects(
    run([], await site(), async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stderr: "HTTP 404: Not Found (https://api.github.com/repos/x)\nmore" });
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.deepEqual(error.details, { reason: "gh_failed", gh_error: "HTTP 404: Not Found (https://api.github.com/repos/x)" });
      return true;
    },
  );
});

test("refuses before opening anything: no config, a non-hosted site, a missing workflow, an unknown address, gh missing", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "sb-workload-empty-"));
  const cases: [string, () => Promise<unknown>, string][] = [
    ["no config", () => run([], empty), "no_release_config"],
    ["not hosted", async () => run([], await site({ ...RELEASE_CONFIG, content: { kind: "r2" } })), "release_config_not_hosted"],
    ["workflow missing", async () => run([], await site(RELEASE_CONFIG, "other.yml")), "workflow_missing"],
    [
      "unknown address",
      async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, origin: "https://example.com" } })),
      "workspace_url_unknown",
    ],
    ["bad environment", async () => run(["--environment", "a b"], await site()), "environment_invalid"],
    ["bundle not portable", async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, bundle: "Investor-Plan" } })), "release_config_bundle"],
    ["bundle with a space", async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, bundle: "investor plan" } })), "release_config_bundle"],
    ["no content bundle", async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, bundle: "" } })), "release_config_content"],
    ["workflow outside workflows", async () => run([], await site({ ...RELEASE_CONFIG, workflow: { path: "release.yml" } })), "release_config_workflow"],
    ["branch the page refuses", async () => run([], await site(), async () => JSON.stringify({ ...REPOSITORY, default_branch: "release+v2" })), "branch_unsupported"],
    ["name too long", async () => run(["--name", "x".repeat(81)], await site()), "name_invalid"],
    ["url not https", async () => run(["--url", "http://holaxis.example.com"], await site()), "url_invalid"],
    [
      "gh missing",
      async () => run([], await site(), async () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      }),
      "gh_missing",
    ],
  ];
  for (const [name, attempt, reason] of cases) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof CliError, name);
      assert.equal((error.details as any)?.reason, reason, name);
      return true;
    });
    assert.deepEqual(opened, [], name);
  }
});

const SITE_CONFIG = {
  ...RELEASE_CONFIG,
  reconcile: { adapter: "hosted", gateway: "https://mcp.getsuperbee.com", workspace: "holaxis-sites", app: "00000000-0000-4000-8000-000000000000", site: "investor-plan", environment: "portal-release", artifactDirectory: "dist" },
};

test("a hosted publisher requests only its site grant, pins reconcile.environment and points at reconcile.app", async () => {
  const { receipt } = await run(["--no-open"], await site(SITE_CONFIG));
  const values = fragment(receipt.url);
  assert.deepEqual(values.getAll("bundles"), ["investor-plan site"]);
  assert.deepEqual(receipt.bundles, ["investor-plan site"]);
  assert.equal(values.get("environment"), "portal-release");
  assert.equal(receipt.environment, "portal-release");
  assert.equal(receipt.site, "investor-plan");
  assert.equal(receipt.set_variable, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), /HOSTED_APP_ID/);
  assert.match(receipt.next[1], /release\.config\.json as reconcile\.app \(it now holds 00000000-0000-4000-8000-000000000000\)/);
});

test("a hosted site refuses a missing or different environment and a site that is not its bundle", async () => {
  const cases: [string, () => Promise<unknown>, string][] = [
    ["no environment", async () => run([], await site({ ...SITE_CONFIG, reconcile: { ...SITE_CONFIG.reconcile, environment: undefined } })), "site_environment_required"],
    ["other environment", async () => run(["--environment", "release"], await site(SITE_CONFIG)), "environment_mismatch"],
    ["other site", async () => run([], await site({ ...SITE_CONFIG, reconcile: { ...SITE_CONFIG.reconcile, site: "intro" } })), "release_config_site"],
    [
      "site name the page refuses",
      async () => run([], await site({ ...SITE_CONFIG, content: { ...SITE_CONFIG.content, bundle: "team.notes" }, reconcile: { ...SITE_CONFIG.reconcile, site: "team.notes" } })),
      "release_config_site_name",
    ],
  ];
  for (const [name, attempt, reason] of cases) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof CliError, name);
      assert.equal((error.details as any)?.reason, reason, name);
      return true;
    });
    assert.deepEqual(opened, [], name);
  }
});
