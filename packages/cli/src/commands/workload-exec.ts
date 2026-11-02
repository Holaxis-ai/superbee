// GitHub supplies the caller identity; this finite declaration asks for access, never grants it.
import { spawn } from "node:child_process";
import { constants, homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isHostedBundleId } from "@superbee/core";
import { createFetchCarrier } from "@superbee/core/hosted-transport";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { readExternalFileBytesNoFollowWithin } from "../external-file.js";
import { discoverHosted, followWorkspaceOrigin, resolveHostedTarget, type FetchLike } from "../hosted/discovery.js";
import { isWorkspaceSlug } from "../hosted/reference.js";
import { cliInvocation } from "../invocation.js";
import { parseUniqueJsonObject } from "../json-object.js";
import { renderUsage } from "../output.js";

export const WORKLOAD_EXEC_USAGE = `superbee workload exec — run with exactly the workload access requested

Usage:
  superbee workload exec --request-file <file> --url <HTTPS workspace origin> --workspace <slug> -- <command> [args...]

GitHub Actions only: the existing exchange derives identity from the job's signed GitHub token.
The UTF-8 JSON intent is at most 16 KiB: {version:1,displayName,events,bundles,sites?}. It contains
only requested capabilities, never repository IDs, workflow refs, environment or credentials.
No release.config.json, person login, app UUID or copied GitHub variable is required.

Pending approval returns FORBIDDEN (exit 2), details.reason workload_approval_pending and the
workspace administrator's review URL; no child starts and no bearer is emitted. Run the workflow
again after approval. Denied or expired requests remain terminal; there is no polling or retry.
Approved access starts the command directly, without a shell, with SUPERBEE_HOST and its temporary
SUPERBEE_ACCESS_TOKEN. SUPERBEE_WORKLOAD_APP_ID identifies the resolved app for native principal
verification; it is not a grant or a persistent app-ID variable. GitHub OIDC minting variables are removed from the child's environment.
Tokens are masked in GitHub Actions logs; do not print or upload the child's environment.
The child exit status is preserved. At most 128 command/argument tokens are accepted.

Options:
  --request-file <file>  Required bounded version1 JSON capability intent
  --url <origin>         Required canonical HTTPS workspace origin, no path/query/fragment
  --workspace <slug>     Required workspace slug matching the origin's discovery
  -h, --help             Show this help`;

export interface WorkloadExecDeps {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  now: () => number;
  stdout: (text: string) => void;
  child: (command: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<number>;
  exit: (code: number) => void;
}
interface WorkloadIntent {
  version: 1;
  displayName: string;
  events: string[];
  bundles: Record<string, "read" | "write">;
  sites?: string[];
}
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const uuid = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const MAX_BODY = 64 * 1024;
const EVENTS = new Set(["schedule", "repository_dispatch", "workflow_dispatch"]);
const site = (x: unknown): x is string => typeof x === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(x) && x.length >= 3 && x.length <= 32;
const usage = (reason: string, message: string) => new CliError("USAGE", message, { details: { reason }, help: `${cliInvocation()} workload exec --help` });
const unavailable = (reason: string) => new CliError("RUNTIME", "workload access could not be established; no child started", { details: { reason, child_started: false } });

function intent(value: unknown): WorkloadIntent {
  if (!object(value) || Object.keys(value).some(k => !["version", "displayName", "events", "bundles", "sites"].includes(k)) || value.version !== 1 ||
      typeof value.displayName !== "string" || value.displayName !== value.displayName.trim() || value.displayName.length < 1 || value.displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(value.displayName) ||
      !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 3 || !value.events.every(x => typeof x === "string" && EVENTS.has(x)) || new Set(value.events).size !== value.events.length ||
      !object(value.bundles) || Object.keys(value.bundles).length < 1 || Object.keys(value.bundles).length > 50 || !Object.entries(value.bundles).every(([k, v]) => isHostedBundleId(k) && (v === "read" || v === "write")) ||
      (value.sites !== undefined && (!Array.isArray(value.sites) || value.sites.length > 5 || !value.sites.every(site) || new Set(value.sites).size !== value.sites.length))) {
    throw usage("workload_request_invalid", "request file must contain only the bounded version1 display name, events, bundle capabilities and optional sites");
  }
  if (value.sites !== undefined && (value.sites as string[]).some(s => value.bundles && (value.bundles as Record<string, unknown>)[s] !== "read")) {
    throw usage("workload_request_invalid", "each requested site must have its matching read bundle capability");
  }
  return value as unknown as WorkloadIntent;
}

/** Read no further than the bound, including an upstream which omits Content-Length. */
async function githubAnswer(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw unavailable("github_oidc_unavailable");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw unavailable("github_oidc_invalid"); }
      parts.push(step.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } catch { throw unavailable("github_oidc_invalid"); }
  finally { reader.releaseLock(); }
}

function exactCapabilities(value: unknown, expected: Record<string, "read" | "write">): boolean {
  return object(value) && Object.keys(value).length === Object.keys(expected).length && Object.entries(expected).every(([k, v]) => value[k] === v);
}

function refusal(status: number, body: unknown, origin: string, now: number): CliError {
  const code = object(body) && typeof body.refused === "string" ? body.refused : "workload_exchange_unavailable";
  if (status === 403 && code === "workload_approval_pending" && object(body) && uuid(body.requestId) && body.state === "pending" && Number.isSafeInteger(body.expiresAt) &&
      (body.expiresAt as number) > now && (body.expiresAt as number) <= now + 8 * 86400000 && body.reviewUrl === `${origin}/settings/workload-apps`) {
    return new CliError("FORBIDDEN", "workload access is waiting for workspace administrator approval; no child started", {
      details: { reason: code, request_id: body.requestId, state: "pending", expires_at: body.expiresAt, review_url: body.reviewUrl, child_started: false },
      help: "Open review_url as a workspace administrator, review the requested permissions, then run this workflow again after approval",
    });
  }
  if (status === 403 && ["workload_approval_denied", "workload_approval_expired", "workload_profile_conflict"].includes(code)) {
    return new CliError("FORBIDDEN", "workload access was not approved; no child started", { details: { reason: code, child_started: false } });
  }
  // Never echo remote prose, raw response bodies, tokens or untrusted URLs in failures.
  return unavailable(status === 401 ? "github_oidc_refused" : "workload_exchange_unavailable");
}

export async function workloadExec(argv: string[], partial: Partial<WorkloadExecDeps> = {}): Promise<void> {
  const deps: WorkloadExecDeps = {
    cwd: partial.cwd ?? process.cwd(), home: partial.home ?? homedir(), env: partial.env ?? process.env,
    fetch: partial.fetch ?? ((input, init) => fetch(input, init)), now: partial.now ?? Date.now,
    stdout: partial.stdout ?? (text => { process.stdout.write(text); }), child: partial.child ?? child,
    exit: partial.exit ?? (code => { process.exitCode = code; }),
  };
  const { values, positionals } = parseLeafOrUsage(() => parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
    "request-file": { type: "string" }, url: { type: "string" }, workspace: { type: "string" }, help: { type: "boolean", short: "h" },
  } }), CLI_LEAVES.workloadExec);
  if (values.help) { deps.stdout(renderUsage(WORKLOAD_EXEC_USAGE)); return; }
  const separator = argv.indexOf("--");
  if (separator < 0 || positionals.length !== argv.length - separator - 1 || !positionals[0] || positionals.some(x => x.includes("\0"))) throw usage("workload_command_invalid", "place the command and its arguments after --");
  if (!values["request-file"] || !values.url || !isWorkspaceSlug(values.workspace)) throw usage("workload_arguments_missing", "--request-file, --url and --workspace are required");
  let origin: URL;
  try { origin = new URL(values.url); } catch { throw usage("workload_origin_invalid", "--url must be one canonical HTTPS workspace origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.origin !== values.url || origin.pathname !== "/") throw usage("workload_origin_invalid", "--url must be one canonical HTTPS workspace origin");
  const acquired = await readExternalFileBytesNoFollowWithin(path.resolve(deps.cwd, values["request-file"]), 16 * 1024, deps.home);
  if (acquired.state !== "present") throw usage("workload_request_unreadable", "request file must be an ordinary readable file of at most 16 KiB outside private state");
  let parsed: unknown;
  try { parsed = parseUniqueJsonObject(new TextDecoder("utf-8", { fatal: true }).decode(acquired.bytes)); } catch { throw usage("workload_request_invalid", "request file must contain UTF-8 JSON"); }
  const requested = intent(parsed);
  const rawOidcUrl = deps.env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken = deps.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (deps.env.GITHUB_ACTIONS !== "true" || !rawOidcUrl || !requestToken || /[\r\n]/.test(requestToken)) throw new CliError("AUTH_REQUIRED", "workload exec requires this GitHub Actions job's id-token: write permission", { details: { reason: "github_oidc_required", child_started: false } });
  let oidcUrl: URL;
  try { oidcUrl = new URL(rawOidcUrl); } catch { throw unavailable("github_oidc_invalid"); }
  if (oidcUrl.protocol !== "https:" || oidcUrl.username || oidcUrl.password || oidcUrl.hash) throw unavailable("github_oidc_invalid");
  // Discovery carries no credential. A caller-selected origin may point only to its own parent's gateway.
  let selected;
  try {
    selected = await followWorkspaceOrigin(deps.fetch, resolveHostedTarget(origin.origin));
    if (!selected || selected.requestedOrigin !== origin.origin || selected.workspaceSlug !== values.workspace) throw unavailable("workspace_discovery_mismatch");
    await discoverHosted(deps.fetch, selected.target);
  } catch { throw unavailable("workspace_discovery_unavailable"); }
  oidcUrl.searchParams.set("audience", selected.requestedOrigin);
  let oidc: string;
  try {
    const body = await githubAnswer(await deps.fetch(oidcUrl.href, { method: "GET", headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) }));
    if (!object(body) || typeof body.value !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.value) || body.value.length > 16384) throw unavailable("github_oidc_invalid");
    oidc = body.value;
  } catch { throw unavailable("github_oidc_unavailable"); }
  deps.stdout(`::add-mask::${oidc}\n`);
  const carrier = createFetchCarrier({ baseUrl: selected.target.origin, credentials: async () => ({ Authorization: `Bearer ${oidc}` }), fetch: (url, init) => deps.fetch(String(url), init), deadlineMs: 30000 });
  let answer;
  try { answer = await carrier.json("/sync/v1/workload-exchange", { workspace: values.workspace, request: requested }, AbortSignal.timeout(30000), { maximum: MAX_BODY }); }
  catch { throw unavailable("workload_exchange_unavailable"); }
  if (answer.status !== 200) throw refusal(answer.status, answer.body, selected.requestedOrigin, deps.now());
  const b = answer.body;
  if (!object(b) || b.version !== 1 || typeof b.token !== "string" || !/^sbw_[A-Za-z0-9_-]{20,200}$/.test(b.token) || !uuid(b.appId) ||
      !Number.isSafeInteger(b.expiresAt) || (b.expiresAt as number) - deps.now() < 60000 || (b.expiresAt as number) - deps.now() > 3600000 ||
      !object(b.workspace) || b.workspace.slug !== values.workspace || b.workspace.origin !== selected.requestedOrigin || !exactCapabilities(b.bundles, requested.bundles) ||
      (!Array.isArray(b.sites) || b.sites.length !== (requested.sites ?? []).length || new Set(b.sites).size !== b.sites.length || !(requested.sites ?? []).every(s => (b.sites as unknown[]).includes(s)))) throw unavailable("workload_exchange_invalid");
  deps.stdout(`::add-mask::${b.token}\n`);
  const env: NodeJS.ProcessEnv = { ...deps.env, SUPERBEE_HOST: selected.target.origin, SUPERBEE_ACCESS_TOKEN: b.token, SUPERBEE_WORKLOAD_APP_ID: b.appId };
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const code = await deps.child(positionals, env, deps.cwd);
  deps.exit(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1);
}

async function child(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  return new Promise(resolve => {
    const running = spawn(command[0]!, command.slice(1), { env, cwd, stdio: "inherit", shell: false });
    running.once("error", () => resolve(127));
    running.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
  });
}
