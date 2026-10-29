// `superbee workload register` — open a hosted workspace's workload app registration page filled
// in from the site repository it runs in. Registration stays web-only: this command reads GitHub
// with the person's own `gh` and the repository's release configuration, builds the page's prefill
// link, and opens it; a workspace administrator reviews the values there and clicks Register.
//
// The prefill rides the URL fragment, which a browser never sends to a server. Its format (v1) is
// the hosted page's contract, defined in superbee-hosted `browser/workload-apps-entry.ts`:
// form-urlencoded pairs keyed by the form's field names, `v=1` first, one pair per line of a
// multi-line field and one per checked event.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { isHostedBundleId } from "@superbee/core";

import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandQuoted, commandToken, type CommandText } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { currentHost } from "../runtime-context.js";

export const WORKLOAD_USAGE = `superbee workload — register a site repository's CI as a hosted workload app

Usage:
  superbee workload register [--name <name>] [--environment <name>] [--url <workspace-url>] [--no-open] [--json]

Run in a site repository. Reads the repository and owner ids and the default branch with your
local GitHub CLI (gh api repos/<owner>/<repo>), and the workflow, hosted workspace and bundle from
release.config.json. Then opens the workspace's workload apps page with the form filled in. Nothing
is registered here: a workspace administrator reviews the values on the page and clicks Register.

A site that publishes to hosted (reconcile.adapter "hosted") also declares its site
(<bundle> site), and the app pins the GitHub environment reconcile.environment names. After
Register, put the App id the page shows in release.config.json as reconcile.app. A site that only
reads hosted content stores the id with the printed gh variable set command instead.

Defaults: events schedule, repository_dispatch and workflow_dispatch; the bundle at read; the
environment reconcile.environment names for a hosted site, else none (the job that mints the token
runs outside any GitHub environment).

Options:
  --name <name>          The app's name on the page (default: <owner>/<repo>)
  --environment <name>   The GitHub environment of the job that mints the token, if it has one
                         (default: reconcile.environment for a site that publishes to hosted)
  --url <workspace-url>  The workspace's address (default: derived from content.origin and
                         content.workspace, e.g. https://<workspace>.getsuperbee.com)
  --no-open              Print the link instead of opening a browser
  --json                 Emit compact JSON instead of TOON
  -h, --help             Show this help
`;

/** The hosted page's prefill limit: a longer fragment is refused there and fills nothing. */
const FRAGMENT_LIMIT = 8192;
const WORKLOAD_APP_EVENTS = ["schedule", "repository_dispatch", "workflow_dispatch"] as const;
const REGISTRATION_PATH = "/settings/workload-apps";
const CONFIG_FILE = "release.config.json";

export interface WorkloadDeps {
  stdout: (text: string) => void;
  /** The repository folder; release.config.json is read from here. */
  cwd: string;
  /** Run the person's GitHub CLI and return its stdout. */
  gh: (args: readonly string[]) => Promise<string>;
  openBrowser: (url: string) => void;
}

function defaultGh(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", [...args], { maxBuffer: 1 << 20, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout));
    });
  });
}

export async function workload(argv: string[], partial: Partial<WorkloadDeps> = {}): Promise<void> {
  const deps: WorkloadDeps = {
    stdout: partial.stdout ?? ((text: string) => void process.stdout.write(text)),
    cwd: partial.cwd ?? process.cwd(),
    gh: partial.gh ?? defaultGh,
    openBrowser: partial.openBrowser ?? ((url: string) => currentHost().openBrowser(url)),
  };
  const sub = argv[0];
  if (sub === "register") return register(argv.slice(1), deps);
  if (sub === undefined || sub === "-h" || sub === "--help") {
    deps.stdout(renderUsage(WORKLOAD_USAGE));
    return;
  }
  throw new CliError("USAGE", `unknown workload subcommand: ${sub} (expected register)`, { help: `${cliInvocation()} workload --help` });
}

const usage = (message: string, reason: string, help?: string) =>
  new CliError("USAGE", message, { details: { reason }, help: help ?? `${cliInvocation()} workload register --help` });

/** What the command needs from release.config.json, checked. */
interface ReleaseConfig {
  readonly workflowPath: string;
  readonly workspace: string;
  readonly bundle: string;
  readonly origin: string;
  readonly repository: string | null;
  /** `workflow.defaultBranch`, compared with GitHub's own default branch. */
  readonly configBranch: string | null;
  /** The site the release publishes to hosted (`reconcile.adapter: "hosted"`), else null. */
  readonly site: { readonly name: string; readonly environment: string | null; readonly app: string | null } | null;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

async function readReleaseConfig(cwd: string): Promise<ReleaseConfig> {
  const file = path.join(cwd, CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw usage(`no ${CONFIG_FILE} in ${cwd}: run this in a site repository`, "no_release_config");
  }
  let config: any;
  try {
    config = JSON.parse(raw);
  } catch {
    throw usage(`${CONFIG_FILE} is not valid JSON`, "release_config_invalid");
  }
  const workflowPath = text(config?.workflow?.path);
  if (!workflowPath || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowPath))
    throw usage(`${CONFIG_FILE} workflow.path must be .github/workflows/<file>.yml`, "release_config_workflow");
  const content = config?.content;
  if (content?.kind !== "hosted")
    throw usage(`${CONFIG_FILE} content.kind is not "hosted": only a site whose content lives in hosted Superbee registers a workload app`, "release_config_not_hosted");
  const workspace = text(content.workspace);
  const bundle = text(content.bundle);
  const origin = text(content.origin);
  if (!workspace || !bundle || !origin)
    throw usage(`${CONFIG_FILE} content needs origin, workspace and bundle`, "release_config_content");
  if (!isHostedBundleId(bundle))
    throw usage(`${CONFIG_FILE} content.bundle ${commandQuoted(bundle)} is not a hosted bundle id`, "release_config_bundle");
  // The hosted target publishes the built site as the content bundle's site (Portal's hosted
  // target: reconcile.site is the bundle id, and the app pins reconcile.environment).
  const reconcile = config?.reconcile;
  let site: ReleaseConfig["site"] = null;
  if (reconcile?.adapter === "hosted") {
    const name = text(reconcile.site);
    if (name !== bundle)
      throw usage(`${CONFIG_FILE} reconcile.site must be the content bundle ${commandQuoted(bundle)}: a hosted site is its bundle's`, "release_config_site");
    site = { name, environment: text(reconcile.environment), app: text(reconcile.app) };
  }
  return {
    workflowPath,
    workspace,
    bundle,
    origin,
    repository: text(config?.code?.repository),
    configBranch: text(config?.workflow?.defaultBranch),
    site,
  };
}

interface GitHubRepository {
  readonly fullName: string;
  readonly id: string;
  readonly ownerId: string;
  readonly defaultBranch: string;
}

async function gh(deps: WorkloadDeps, args: readonly string[]): Promise<string> {
  try {
    return await deps.gh(args);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT")
      throw new CliError("RUNTIME", "the GitHub CLI (gh) is not installed", {
        details: { reason: "gh_missing" },
        help: "install it from https://cli.github.com, run gh auth login, then re-run this command",
      });
    const said = String((error as { stderr?: unknown }).stderr ?? "")
      .split("\n")
      .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, "").trim())
      .find(Boolean);
    throw new CliError("RUNTIME", `gh ${args.join(" ")} failed: check you are signed in to GitHub (gh auth status) and can read the repository`, {
      details: { reason: "gh_failed", ...(said ? { gh_error: said.slice(0, 200) } : {}) },
      help: "gh auth status",
    });
  }
}

async function readRepository(config: ReleaseConfig, deps: WorkloadDeps): Promise<GitHubRepository> {
  const named = config.repository ?? (await gh(deps, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(named))
    throw usage(`'${named}' is not an <owner>/<repo> repository`, "repository_invalid");
  let answer: any;
  try {
    answer = JSON.parse(await gh(deps, ["api", `repos/${named}`]));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("RUNTIME", `gh api repos/${named} did not answer JSON`, { details: { reason: "gh_failed" } });
  }
  const id = answer?.id;
  const ownerId = answer?.owner?.id;
  const fullName = text(answer?.full_name);
  const defaultBranch = text(answer?.default_branch);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(ownerId) || !fullName || !defaultBranch)
    throw new CliError("RUNTIME", `gh api repos/${named} did not name the repository's ids and default branch`, { details: { reason: "gh_failed" } });
  // The register verb's branch grammar: GitHub allows more, and the page would refuse those.
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(defaultBranch) || defaultBranch.length > 255 || defaultBranch.includes("..") || defaultBranch.endsWith(".lock"))
    throw new CliError("RUNTIME", `the default branch ${commandQuoted(defaultBranch)} has characters a workload app's branch can't hold: the registration page would refuse it`, {
      details: { reason: "branch_unsupported" },
    });
  return { fullName, id: String(id), ownerId: String(ownerId), defaultBranch };
}

/** The workspace's address: --url, else content.origin's gateway host with the workspace in front
 * (`https://mcp.getsuperbee.com` and `holaxis-sites` give `https://holaxis-sites.getsuperbee.com`). */
function workspaceOrigin(flag: string | undefined, config: ReleaseConfig): { origin: string; from: "--url" | "derived" } {
  const parse = (value: string, what: string) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw usage(`${what} '${value}' is not a URL`, "url_invalid");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      throw usage(`${what} '${value}' is not an https address`, "url_invalid");
    return url;
  };
  if (flag !== undefined) return { origin: parse(flag, "--url").origin, from: "--url" };
  const gateway = parse(config.origin, `${CONFIG_FILE} content.origin`);
  if (!gateway.hostname.startsWith("mcp.") || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.workspace))
    throw usage(
      `can't tell the workspace's address from content.origin ${config.origin} and workspace ${config.workspace}: pass --url`,
      "workspace_url_unknown",
      `${cliInvocation()} workload register --url https://<workspace host>`,
    );
  return { origin: `${gateway.protocol}//${config.workspace}.${gateway.host.slice("mcp.".length)}`, from: "derived" };
}

/** One bundle line as the page takes it: `<bundle-id> read|write`, or `<bundle-id> site`. */
type BundleGrant = `${string} ${"read" | "write" | "site"}`;

/**
 * The bundle lines a site's app asks for: it reads its content bundle, and a site that publishes to
 * hosted also declares that bundle's site (`<bundle> site`, board design `hosted-site-serving` D7;
 * the page puts it in the app's site list, not its grants).
 */
function bundleGrants(config: ReleaseConfig): BundleGrant[] {
  return [`${config.bundle} read`, ...(config.site ? [`${config.site.name} site` as const] : [])];
}

/** The page's prefill link, format v1, keys in the form's order. */
export function registrationLink(
  origin: string,
  values: {
    displayName: string;
    repository: string;
    repositoryId: string;
    repositoryOwnerId: string;
    branch: string;
    workflowRefs: readonly string[];
    jobWorkflowRefs: readonly string[];
    environment: string;
    events: readonly string[];
    bundles: readonly string[];
  },
): string {
  const pairs = new URLSearchParams([
    ["v", "1"],
    ["displayName", values.displayName],
    ["repository", values.repository],
    ["repositoryId", values.repositoryId],
    ["repositoryOwnerId", values.repositoryOwnerId],
    ["branch", values.branch],
    ...values.workflowRefs.map((ref): [string, string] => ["workflowRefs", ref]),
    ...values.jobWorkflowRefs.map((ref): [string, string] => ["jobWorkflowRefs", ref]),
    ["environment", values.environment],
    ...values.events.map((event): [string, string] => ["events", event]),
    ...values.bundles.map((line): [string, string] => ["bundles", line]),
  ] as [string, string][]);
  return `${origin}${REGISTRATION_PATH}#${pairs.toString()}`;
}

async function register(argv: string[], deps: WorkloadDeps): Promise<void> {
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          name: { type: "string" },
          environment: { type: "string" },
          url: { type: "string" },
          "no-open": { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.workloadRegister,
  );
  if (values.help) {
    deps.stdout(renderUsage(WORKLOAD_USAGE));
    return;
  }
  const mode = resolveMode(values);
  const config = await readReleaseConfig(deps.cwd);
  // Hosted compares the environment exactly, and refuses a site app without one.
  const environment = values.environment?.trim() ?? config.site?.environment ?? "";
  if (environment !== "" && !/^[A-Za-z0-9._-]{1,255}$/.test(environment))
    throw usage(`${values.environment === undefined ? `${CONFIG_FILE} reconcile.environment` : "--environment"} ${commandQuoted(environment)} is not a GitHub environment name`, "environment_invalid");
  if (config.site && environment === "")
    throw usage(`a site that publishes to hosted needs a GitHub environment: set reconcile.environment in ${CONFIG_FILE} (the template uses portal-release)`, "site_environment_required");
  if (config.site && config.site.environment !== null && environment !== config.site.environment)
    throw usage(`--environment ${commandQuoted(environment)} is not ${CONFIG_FILE} reconcile.environment ${commandQuoted(config.site.environment)}: the release refuses a token from any other environment`, "environment_mismatch");
  try {
    await fs.access(path.join(deps.cwd, config.workflowPath));
  } catch {
    throw usage(`${CONFIG_FILE} names ${config.workflowPath}, which is not in this repository`, "workflow_missing");
  }
  const page = workspaceOrigin(values.url, config);
  const repository = await readRepository(config, deps);
  const displayName = (values.name ?? repository.fullName).trim();
  if (displayName === "" || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName))
    throw usage("--name must be one plain line of 1 to 80 characters", "name_invalid");
  const workflowRef = `${repository.fullName}/${config.workflowPath}@refs/heads/${repository.defaultBranch}`;
  const bundles = bundleGrants(config);
  const url = registrationLink(page.origin, {
    displayName,
    repository: repository.fullName,
    repositoryId: repository.id,
    repositoryOwnerId: repository.ownerId,
    branch: repository.defaultBranch,
    workflowRefs: [workflowRef],
    jobWorkflowRefs: [workflowRef],
    environment,
    events: WORKLOAD_APP_EVENTS,
    bundles,
  });
  if (url.length - url.indexOf("#") > FRAGMENT_LIMIT)
    throw usage("the registration link is longer than the page accepts: shorten --name", "link_too_long");
  const open = !values["no-open"];
  if (open) deps.openBrowser(url);
  const notes =
    config.configBranch !== null && config.configBranch !== repository.defaultBranch
      ? [`${CONFIG_FILE} workflow.defaultBranch is ${config.configBranch}, but GitHub's default branch is ${repository.defaultBranch}: the app is registered for ${repository.defaultBranch}, where schedule and repository_dispatch run; fix the configuration if that is wrong`]
      : [];
  // A hosted site reads its app id from release.config.json (reconcile.app); a site that only
  // reads hosted content keeps it in a repository variable its token script reads.
  const setVariable: CommandText | null = config.site
    ? null
    : commandFragment`gh variable set HOSTED_APP_ID --repo ${commandToken(repository.fullName)} --body <app-id>`;
  const appStep = config.site
    ? `then put the App id the page shows in ${CONFIG_FILE} as reconcile.app${config.site.app !== null ? ` (it now holds ${config.site.app})` : ""}, and commit it to ${repository.defaultBranch}`
    : "then run set_variable with the App id the page shows in place of <app-id>";
  deps.stdout(
    render(
      {
        workload_register: {
          status: open ? "opened" : "printed",
          registered: false,
          page: `${page.origin}${REGISTRATION_PATH}`,
          page_from: page.from,
          workspace: config.workspace,
          display_name: displayName,
          repository: repository.fullName,
          repository_id: repository.id,
          repository_owner_id: repository.ownerId,
          branch: repository.defaultBranch,
          workflow_ref: workflowRef,
          job_workflow_ref: workflowRef,
          events: [...WORKLOAD_APP_EVENTS],
          bundles,
          environment: environment === "" ? null : environment,
          environment_note:
            environment === ""
              ? "none: the job that mints the token runs outside any GitHub environment, so the app admits tokens from no environment; pass --environment <name> only if that job declares one"
              : `tokens are admitted only from jobs in the GitHub environment ${environment}`,
          url,
          ...(config.site ? { site: config.site.name } : {}),
          ...(notes.length > 0 ? { notes } : {}),
          ...(setVariable ? { set_variable: setVariable } : {}),
          next: [
            open
              ? "a workspace administrator reviews the values on the opened page and clicks Register"
              : "open url in a browser signed in as a workspace administrator, review the values and click Register",
            appStep,
          ],
        },
      },
      mode,
    ),
  );
}
