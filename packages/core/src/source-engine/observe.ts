import { validateConnectorRequest, declarationRequestRules, placeholders, providerRequestRules } from "../connector-request.js";
/**
 * The observation loop: run a profile page by page behind the guarded transport, diff each page
 * against the stored records into record-overlay changes, hand them to the caller's commit, and
 * only then store the cursor and the records. A change the commit asks to retry stays pending in
 * the machine state and is planned again before the next run fetches anything. Generic observers
 * may advance past a held record. The registered target consumer instead checkpoints the whole
 * supplying group before effects and cannot advance while any member remains unresolved.
 * A pass counts as a complete observation only when it ran in complete
 * mode from no cursor to its last page within this run, the profile claimed it complete and the
 * source is declared complete; only a complete observation counts a stored record as missing, and
 * a record is `disappeared` after `missing_threshold` of them.
 */
import { findingsFor, inspectSourceReadPolicy } from "../connectors.js";
import type { Finding } from "../record-overlay/types.js";
import { DEFAULT_SOURCE_BUDGET, DEFAULT_STATUS_RULES, guardTransport, raceAbort, sourceHostSet, type Stop } from "./guard.js";
import { hasProtectedSourcePending, isSourceState, type SourceState } from "./machine-state.js";
import type {
  ObserveSourceOptions,
  SourceBudget,
  SourceProfile,
  SourceRunReceipt,
  StatusRules,
} from "./types.js";

export { DEFAULT_MISSING_THRESHOLD, MAX_CURSOR_CHARS, MAX_REPLAY_FAILURES } from "./driver.js";
import { driveObservation, UNSUPPORTED_CONTENT } from "./driver.js";

const PROFILE_ID = /^[a-z][a-z0-9-]*$/;


/** Thrown by a profile that cannot read a provider's body; the run ends `unsupported_content`. */
export function unsupportedContent(detail: string): never {
  throw Object.assign(new Error(`unsupported content: ${detail}`), { code: UNSUPPORTED_CONTENT, detail });
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const clip = (text: string, n: number): string => text.length > n ? text.slice(0, n - 1) + "…" : text;

function budgetOf(given: Partial<SourceBudget> | undefined): SourceBudget | undefined {
  const budget = { ...DEFAULT_SOURCE_BUDGET, ...given };
  // Timer delays above 2^31 - 1 milliseconds overflow to an immediate timeout.
  const ok = (["requests", "maxBytes", "redirects", "pages", "deadlineMs", "requestTimeoutMs"] as const).every((key) => Number.isInteger(budget[key])
    && budget[key] >= (key === "redirects" ? 0 : 1) && budget[key] <= 2 ** 31 - 1);
  return ok ? budget : undefined;
}

function statusesOf(given: Partial<StatusRules> | undefined): StatusRules | undefined {
  const statuses = { ...DEFAULT_STATUS_RULES, ...given };
  const ok = Object.values(statuses).every((list) => Array.isArray(list) && list.every((s) => Number.isInteger(s) && s >= 400 && s <= 599));
  return ok ? statuses : undefined;
}

function profileProblem(profile: SourceProfile<unknown, unknown>): string | undefined {
  if (!record(profile)) return "not a profile";
  if (typeof profile.id !== "string" || !PROFILE_ID.test(profile.id)) return "id is a slug";
  if (!Number.isInteger(profile.version) || profile.version < 1) return "version is a positive integer";
  if (profile.kind !== "generic" && profile.kind !== "extension") return "kind is generic or extension";
  if (typeof profile.validateSpec !== "function" || typeof profile.hostsFor !== "function" || typeof profile.observe !== "function") return "missing a method";
  return undefined;
}

function emptyState(profile: { id: string; version: number }): SourceState {
  return { v: 1, profile: { id: profile.id, version: profile.version }, cursor: null, open: false, records: {}, complete_observations: 0 };
}

const OUTCOME_TEXT: Record<string, string> = {
  deferred: "the provider asked to slow down; the run stopped and resumes from the last committed page",
  credential_refused: "the provider refused the credential; runs stay stopped until the credential changes",
  provider_unavailable: "the provider did not answer usefully; nothing past the last committed page was read",
  not_found: "the provider says the resource does not exist",
  unsupported_content: "the provider sent a body the profile cannot read; nothing from it was written",
  too_large: "the provider sent a body over the byte bound; nothing from it was written",
  refused: "a request was refused before it was sent",
  failed: "the run failed before its page was stored",
};

/** One finding for a run that did not end as observed, keyed so a repeat collapses into one Signal. */
function outcomeFinding(source: string, stop: Stop, url: string | undefined): Finding | null {
  if (stop.outcome === "observed" || (stop.outcome === "deferred" && (stop.reason === "budget" || stop.reason === "deadline"))) return null;
  const where = url ? ` (${clip(url, 160)})` : "";
  const status = stop.status !== undefined ? ` Status ${stop.status}.` : "";
  return {
    key: `source:${source}:${stop.outcome}${stop.reason ? `:${stop.reason}` : ""}`,
    title: clip(`Source ${source}: ${stop.outcome.replaceAll("_", " ")}${stop.reason ? ` (${stop.reason.replaceAll("_", " ")})` : ""}`, 140),
    summary: clip(`${OUTCOME_TEXT[stop.outcome] ?? stop.outcome}.${status}${where}`, 600),
    priority: stop.outcome === "credential_refused" || stop.outcome === "refused" || stop.outcome === "failed" ? "normal" : "low",
    facts: { outcome: stop.outcome, reason: stop.reason ?? null, status: stop.status ?? null },
  };
}

/** A URL as a finding shows it: scheme, host and path, never the query. */
function findingUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Run one observation of a bound Source Feed. Returns a receipt; never throws for a provider,
 * profile, guard or commit problem, which all end the run with an outcome and a finding.
 */
export async function observeSource<Spec, Cursor>(options: ObserveSourceOptions<Spec, Cursor>): Promise<SourceRunReceipt> {
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  // Authority is private to this run: callback views cannot rewrite the checked declaration.
  const { bound, connector, readPolicyApproval } = structuredClone({bound: options.bound, connector: options.connector, readPolicyApproval: options.readPolicyApproval});
  const profile = options.profile as SourceProfile<unknown, unknown>;
  const requestedMode = options.mode ?? "incremental";
  const receipt: SourceRunReceipt = {
    feed: bound.policy.feed,
    provider: bound.policy.provider,
    source: bound.source.name,
    profile: { id: String(profile?.id), version: Number(profile?.version) },
    mode: requestedMode,
    observed_at: observedAt,
    outcome: "observed",
    retry: true,
    pages: 0,
    held: 0,
    pending: 0,
    requests: [],
    pass: { resumed: false, ended: false, complete: false },
    changes: { new: 0, changed: 0, disappeared: 0 },
    cursor: null,
    diagnostics: [],
    profile_diagnostics: [],
    findings: [],
  };
  let stop: Stop | undefined;
  let stopUrl: string | undefined;
  const extraFindings: Finding[] = [];
  const finish = (): SourceRunReceipt => {
    if (stop) {
      receipt.outcome = stop.outcome;
      receipt.retry = stop.retry;
      if (stop.reason !== undefined) receipt.reason = stop.reason;
      if (stop.detail !== undefined) receipt.detail = clip(stop.detail, 300);
      if (stop.status !== undefined) receipt.status = stop.status;
      if (stop.retry_after !== undefined) receipt.retry_after = stop.retry_after;
    }
    const mapping = findingsFor(receipt.diagnostics, { source: bound.source.name });
    const outcome = stop ? outcomeFinding(bound.source.name, stop, findingUrl(stopUrl)) : null;
    receipt.findings = [...(outcome ? [outcome] : []), ...extraFindings, ...mapping];
    return receipt;
  };
  const refuse = (reason: string, detail?: string): SourceRunReceipt => {
    stop = { outcome: "refused", reason, retry: false, ...(detail !== undefined ? { detail } : {}) };
    return finish();
  };
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  if (bound.source.request?.read_policy !== undefined) {
    try {
      const inspected = inspectSourceReadPolicy(connector, bound);
      if (readPolicyApproval?.contract !== 1 || readPolicyApproval.digest !== inspected.digest || Object.keys(readPolicyApproval).length !== 2) return refuse("read_policy_unapproved");
    } catch { return refuse("binding_invalid"); }
  }
  const problem = profileProblem(profile);
  if (problem) return refuse("profile_invalid", problem);
  if (profile.id !== bound.source.profile) return refuse("profile_mismatch", `the source names ${bound.source.profile}`);
  if (requestedMode !== "incremental" && requestedMode !== "complete") return refuse("mode_invalid");
  const declaredRequest = bound.source.request;
  if (declaredRequest !== undefined) {
    const problems = validateConnectorRequest(bound.source, connector);
    if (problems.length) return refuse("declaration_invalid", problems.map(p => `${p.path} ${p.message}`).join("; "));
  }
  if (declaredRequest && placeholders(bound.source.identity.resource).some(name => typeof bound.parameters[name] !== "string" || bound.parameters[name] === "" || [".", ".."].includes(bound.parameters[name]!))) return refuse("binding_invalid", "request requires every resource binding value");
  const budget = budgetOf(options.budget);
  if (!budget) return refuse("budget_invalid");
  if (declaredRequest?.rate) budget.requests = Math.min(budget.requests, declaredRequest.rate.requests);
  const statuses = statusesOf(declaredRequest?.errors ?? options.statuses);
  if (!statuses) return refuse("statuses_invalid");
  const identity = structuredClone(options.identity);
  if (!record(identity) || typeof identity.userAgent !== "string" || !/^[\x20-\x7e]{1,512}$/.test(identity.userAgent)
    || typeof identity.productToken !== "string" || !/^[A-Za-z_-]{1,64}$/.test(identity.productToken)) return refuse("identity_invalid");

  let spec: unknown;
  let hosts: readonly string[];
  try {
    const checked = profile.validateSpec(options.spec);
    if (!checked.ok) return refuse("spec_invalid", checked.errors.map((e) => `${e.path} ${e.message}`).join("; "));
    spec = checked.spec;
    hosts = profile.hostsFor(spec, structuredClone(bound));
  } catch (error) {
    stop = { outcome: "failed", reason: "profile_error", retry: false, detail: errorText(error) };
    return finish();
  }
  if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === "string")) return refuse("hosts_invalid");
  const hostSet = sourceHostSet(connector, hosts);
  if (!hostSet.ok) return refuse("hosts_undeclared", hostSet.undeclared.join(", "));

  if (hostSet.hosts.credential.size && !declaredRequest) return refuse("declaration_required", "credentialed sources require a binding-scoped request declaration");

  const key = bound.policy.feed;
  let version: string | null;
  let state: SourceState;
  try {
    const stored = await options.state.read(key);
    if (stored && !isSourceState(stored.state)) {
      stop = { outcome: "failed", reason: "state_invalid", retry: false };
      return finish();
    }
    version = stored?.version ?? null;
    state = stored?.state ?? emptyState(profile);
  } catch (error) {
    stop = { outcome: "failed", reason: "state_unreadable", retry: true, detail: errorText(error) };
    return finish();
  }
  const baseline = version === null;
  receipt.cursor = state.cursor;
  receipt.pending = Object.keys(state.pending ?? {}).length;
  let mode = requestedMode;
  if (state.profile.id !== profile.id || state.profile.version !== profile.version) {
    if (hasProtectedSourcePending(state)) {
      stop = { outcome: "failed", reason: "establishment_scope_changed", retry: false };
      return finish();
    }
    // A cursor is the profile's own format, so another profile's is never handed back.
    if (!baseline) receipt.cursor_reset = "profile_version";
    state = { ...state, profile: { id: profile.id, version: profile.version }, cursor: null, open: false };
    delete state.validators;
    if (!baseline) mode = "complete";
  }
  receipt.mode = mode;
  // A complete observation always lists from the start; an incremental one continues the stored cursor.
  const resumed = mode === "incremental" && state.open;
  receipt.pass.resumed = resumed;

  // Without the caller's deadline the run has its own; every request has its own timeout either way.
  const ownDeadline = options.signal ? undefined : new AbortController();
  const timer = ownDeadline ? setTimeout(() => ownDeadline.abort(), budget.deadlineMs) : undefined;
  const signal = options.signal ?? ownDeadline!.signal;
  const declarationRules = declaredRequest ? declarationRequestRules(connector, bound) : undefined;
  const customRules = options.rules;
  const rules = declarationRules ? {
    url: (url: URL, hop: {method: "GET" | "POST"; redirect: boolean}) => declarationRules.url!(url, hop) && (!customRules?.url || customRules.url(url, hop)),
    post: (url: URL, body: string | undefined) => declarationRules.post!(url, body) && (!customRules?.post || customRules.post(url, body)),
    header: (name: string, url: URL) => declarationRules.header!(name, url) && (!customRules?.header || customRules.header(name, url)),
    response: declarationRules.response,
  } : customRules ?? {};
  const guard = guardTransport({
    hosts: hostSet.hosts, transport: options.transport, identity, budget, rules, statuses, now, conditional: mode === "incremental",
    signal, requestTimeoutMs: budget.requestTimeoutMs, authority: declarationRules, graphqlPaths: providerRequestRules(connector.auth)?.read_posts.filter(p => p.graphql).map(p => p.path),
  });
  receipt.requests = guard.requests;

  try {
    await driveObservation({
      bound, state: options.state, initial: state, version, receipt, observedAt, mode, resumed, signal, pages: budget.pages,
      acquire: ({ cursor, resumed, mode, validators }) => raceAbort(profile.observe({
        spec, bound: structuredClone(bound), cursor, resumed, mode, transport: guard.transport,
        budget: { requests: guard.remaining(), maxBytes: budget.maxBytes }, now: now(), validators,
      }), signal),
      stopped: () => guard.stopped(), lastUrl: () => guard.requests.at(-1)?.url,
      stop: (value, url) => { stop = value; stopUrl = url; }, extraFindings, prepareCommit: options.prepareCommit, commit: options.commit,
    });
    return finish();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    guard.close();
  }
}
