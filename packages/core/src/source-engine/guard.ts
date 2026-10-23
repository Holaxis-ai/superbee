/**
 * The guarded transport a profile sees. It checks every URL and every redirect hop against the
 * run's host set (the profile's hosts within the connector's credential hosts and keyless domains)
 * and the address rule, reads and follows robots.txt for keyless hosts, applies the method rule and
 * the header allowlist, follows redirects itself with the guard re-run per hop, counts the request
 * budget, honours the deadline and maps statuses to outcomes. Any refusal or error status stops
 * the run: the call throws and the stop is recorded here, so a profile cannot swallow it.
 */
import { graphqlReadProblem, type DeclarationRequestRules } from "../connector-request.js";
import { credentialHosts, type Connector } from "../connectors.js";
import { redactUrl } from "../record-overlay/redact.js";
import { challenged, refusedAddress, robotsDecision, type FetchIdentity } from "./robots.js";
import type {
  HttpMethod,
  ProfileRequest,
  ProfileResponse,
  ProfileTransport,
  RequestRules,
  SourceBudget,
  SourceOutcome,
  SourceRequestRow,
  StatusRules,
  Transport,
  TransportResult,
} from "./types.js";

export const DEFAULT_SOURCE_BUDGET: Readonly<SourceBudget> = Object.freeze({
  requests: 100,
  maxBytes: 2 * 1024 * 1024,
  redirects: 5,
  pages: 50,
  deadlineMs: 300_000,
  requestTimeoutMs: 20_000,
});

/**
 * The engine's status sets. 503 is not deferred: it ends `provider_unavailable` with a retry and
 * any `retry_after`; a declaration's `errors` rows pass their own sets.
 */
export const DEFAULT_STATUS_RULES: Readonly<StatusRules> = Object.freeze({
  deferred: Object.freeze([429]),
  credential_refused: Object.freeze([401, 403]),
  not_found: Object.freeze([404, 410]),
});

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** RFC 9309 2.5: parse at least 500 KiB. A longer file is read whole and parsed up to here. */
const MAX_ROBOTS_BYTES = 512 * 1024;
/** RFC 9309 2.3.1.2: follow at least five redirects for robots.txt. */
const MAX_ROBOTS_REDIRECTS = 5;
const MAX_URL = 8192;
const MAX_HEADERS = 32;
const BASE_HEADERS = new Set(["accept"]);
const VALIDATOR_HEADERS = new Set(["if-none-match", "if-modified-since"]);
const NEVER_SENT = new Set([
  "authorization", "proxy-authorization", "cookie", "host", "user-agent",
  "x-http-method-override", "x-http-method", "x-method-override",
  "content-length", "transfer-encoding", "connection",
]);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE = /^[\t\x20-\x7e]{0,8192}$/;

/** Why a run stopped. */
export interface Stop {
  outcome: SourceOutcome;
  reason?: string;
  detail?: string;
  status?: number;
  retry: boolean;
  retry_after?: string;
}

/** Thrown through a profile when the run stops. */
export class SourceStop extends Error {
  readonly stop: Stop;
  constructor(stop: Stop) {
    super(`source run stopped: ${stop.outcome}${stop.reason ? ` (${stop.reason})` : ""}`);
    this.name = "SourceStop";
    this.stop = stop;
  }
}

export interface HostSet {
  /** Every host a request may reach. */
  allowed: ReadonlySet<string>;
  /** Hosts a transport may send the credential to. */
  credential: ReadonlySet<string>;
  /** Keyless hosts: the robots.txt gate applies. */
  keyless: ReadonlySet<string>;
}

/**
 * The run's host set: the profile's hosts, each of which must be a credential host of the auth
 * kind or a declared keyless domain. A host outside both is returned as undeclared.
 */
export function sourceHostSet(connector: Pick<Connector, "auth" | "domains">, hosts: readonly string[]): { ok: true; hosts: HostSet } | { ok: false; undeclared: string[] } {
  const credential = new Set(credentialHosts(connector.auth));
  const domains = new Set(connector.domains);
  const undeclared = hosts.filter((host) => !credential.has(host) && !domains.has(host));
  if (undeclared.length) return { ok: false, undeclared: [...new Set(undeclared)].sort() };
  const allowed = new Set(hosts);
  return {
    ok: true,
    hosts: {
      allowed,
      credential: new Set([...allowed].filter((host) => credential.has(host))),
      keyless: new Set([...allowed].filter((host) => domains.has(host) && !credential.has(host))),
    },
  };
}

export interface GuardContext {
  hosts: HostSet;
  transport: Transport;
  identity: FetchIdentity;
  budget: SourceBudget;
  rules: RequestRules;
  /** Private core constraints rechecked after application callbacks. */
  authority?: RequestRules & Pick<DeclarationRequestRules, "headers">;
  /** Core-owned GraphQL read paths. Execution awaits reviewed resource-scope semantics. */
  graphqlPaths?: readonly string[];
  statuses: StatusRules;
  now: () => Date;
  /**
   * Whether a request may be conditional. A complete observation must read the whole listing, so
   * it sends no validator and a not-modified answer stops it.
   */
  conditional: boolean;
  signal?: AbortSignal;
  /** Each request's own timeout. */
  requestTimeoutMs?: number;
}

export interface GuardedTransport {
  transport: ProfileTransport;
  /** Every request, sent or refused, in order. */
  requests: SourceRequestRow[];
  /** The first stop, if any. */
  stopped(): Stop | undefined;
  /** Requests left in the run. */
  remaining(): number;
  /** End the run: every later request throws, from a reference the profile kept or not. */
  close(): void;
}

type RobotsEntry = { status: number; text: string; challenged?: boolean };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The first 512 KiB of a robots.txt, cut back to the last whole line so no rule is shortened. */
function robotsPrefix(text: string): string {
  if (text.length <= MAX_ROBOTS_BYTES) return text;
  const cut = text.slice(0, MAX_ROBOTS_BYTES);
  const end = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf("\r"));
  return end === -1 ? "" : cut.slice(0, end);
}

/** `promise`, or a rejection once `signal` aborts; the abandoned promise's later failure is ignored. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  // A request abandoned at the deadline may still fail later; that is not this run's error.
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** A transport answer in the contract's shape, header names lowercased, or undefined. */
function readResult(result: unknown, maxBytes: number): TransportResult | undefined {
  if (!record(result)) return undefined;
  if (result.ok === false) return result.refused === "too_large" ? { ok: false, refused: "too_large" } : undefined;
  if (result.ok !== true) return undefined;
  const { status, headers, body, bytes } = result;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return undefined;
  if (typeof body !== "string" || typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || !record(headers)) return undefined;
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") return undefined;
    lower[name.toLowerCase()] = value;
  }
  // A decoded body never holds more UTF-16 units than the bytes it came from.
  if (bytes > maxBytes || body.length > maxBytes) return { ok: false, refused: "too_large" };
  return { ok: true, status, headers: lower, body, bytes };
}

export function guardTransport(ctx: GuardContext): GuardedTransport {
  const { rules, signal } = ctx;
  const { identity, budget, statuses } = structuredClone({identity: ctx.identity, budget: ctx.budget, statuses: ctx.statuses});
  const hosts: HostSet = {allowed: new Set(ctx.hosts.allowed), credential: new Set(ctx.hosts.credential), keyless: new Set(ctx.hosts.keyless)};
  const requests: SourceRequestRow[] = [];
  const robots = new Map<string, Promise<RobotsEntry>>();
  let left = budget.requests;
  let stop: Stop | undefined;
  let closed = false;

  function halt(next: Stop): never {
    stop ??= next;
    throw new SourceStop(stop);
  }

  const retryAfter = (value: string | undefined): { retry_after?: string } => {
    if (value === undefined) return {};
    const text = value.trim();
    if (/^\d{1,9}$/.test(text)) return { retry_after: new Date(ctx.now().getTime() + Number(text) * 1000).toISOString() };
    const at = Date.parse(text);
    return Number.isFinite(at) ? { retry_after: new Date(at).toISOString() } : {};
  };

  const statusStop = (status: number, headers: Readonly<Record<string, string>>): Stop | undefined => {
    if (status >= 200 && status < 300) return undefined;
    if (status === 304) return ctx.conditional ? undefined : { outcome: "provider_unavailable", reason: "not_modified", status, retry: true };
    if (statuses.credential_refused.includes(status)) return { outcome: "credential_refused", status, retry: false };
    if (statuses.not_found.includes(status)) return { outcome: "not_found", status, retry: false };
    if (statuses.deferred.includes(status)) return { outcome: "deferred", reason: "rate_limited", status, retry: true, ...retryAfter(headers["retry-after"]) };
    return { outcome: "provider_unavailable", reason: status >= 500 ? "server_error" : "status", status, retry: status >= 500, ...retryAfter(headers["retry-after"]) };
  };

  /** Why `url` may not be requested at all, coming from `from` on a redirect. */
  const hopRefusal = (url: URL, from: URL | undefined): { reason: string; detail?: string } | undefined => {
    if (url.protocol !== "https:") return { reason: "scheme_refused", detail: url.protocol };
    const address = refusedAddress(url);
    if (address) return { reason: "address_refused", detail: address };
    if (!hosts.allowed.has(url.hostname)) return { reason: "host_refused", detail: url.hostname };
    // A credential never crosses hosts, and no other host may steer a credentialed request's path.
    if (from && from.hostname !== url.hostname && (hosts.credential.has(from.hostname) || hosts.credential.has(url.hostname))) {
      return { reason: "redirect_refused", detail: `${from.hostname} to ${url.hostname}` };
    }
    return undefined;
  };

  const refuseRow = (method: HttpMethod, url: URL | string, purpose: SourceRequestRow["purpose"], refused: string): void => {
    requests.push({ method, url: redactUrl(typeof url === "string" ? url : url.href), purpose, refused });
  };

  /**
   * One transport call. Budget and deadline stop the run; a failed call returns "timeout" or
   * "failed".
   */
  const send = async (url: URL, method: HttpMethod, headers: Record<string, string>, body: string | undefined, maxBytes: number, purpose: SourceRequestRow["purpose"]): Promise<TransportResult | "failed" | "timeout"> => {
    if (signal?.aborted) halt({ outcome: "deferred", reason: "deadline", retry: true });
    if (left <= 0) halt({ outcome: "deferred", reason: "budget", retry: true });
    left -= 1;
    const row: SourceRequestRow = { method, url: redactUrl(url.href), purpose };
    requests.push(row);
    let requestSignal = signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let onRunAbort: (() => void) | undefined;
    if (ctx.requestTimeoutMs !== undefined) {
      const controller = new AbortController();
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, ctx.requestTimeoutMs);
      if (signal) signal.addEventListener("abort", onRunAbort = () => controller.abort(), { once: true });
      requestSignal = controller.signal;
    }
    let raw: unknown;
    try {
      raw = await raceAbort(ctx.transport.request({
        url: url.href, method, headers: { ...headers, "user-agent": identity.userAgent }, maxBytes,
        credentialHost: hosts.credential.has(url.hostname),
        ...(body !== undefined ? { body } : {}), ...(requestSignal ? { signal: requestSignal } : {}),
      }), requestSignal);
    } catch {
      if (signal?.aborted) {
        row.refused = "deadline";
        halt({ outcome: "deferred", reason: "deadline", retry: true });
      }
      row.refused = timedOut ? "timeout" : "transport";
      return timedOut ? "timeout" : "failed";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onRunAbort) signal!.removeEventListener("abort", onRunAbort);
    }
    const result = readResult(raw, maxBytes);
    if (!result) { row.refused = "transport_invalid"; return "failed"; }
    if (!result.ok) { row.refused = "too_large"; return result; }
    row.status = result.status;
    return result;
  };

  const readRobots = async (origin: string): Promise<RobotsEntry> => {
    let url = new URL("/robots.txt", origin);
    let from: URL | undefined;
    for (let hop = 0; hop <= MAX_ROBOTS_REDIRECTS; hop++) {
      const refusal = hopRefusal(url, from);
      if (refusal) { refuseRow("GET", url, "robots", refusal.reason); break; }
      const result = await send(url, "GET", { accept: "text/plain, */*;q=0.1" }, undefined, Math.max(budget.maxBytes, MAX_ROBOTS_BYTES), "robots");
      if (typeof result === "string" || !result.ok) break;
      if (REDIRECTS.has(result.status)) {
        const location = result.headers.location;
        if (!location) break;
        let next: URL;
        try { next = new URL(location, url); } catch { break; }
        next.hash = "";
        from = url;
        url = next;
        continue;
      }
      if (challenged(result.status, result.headers, result.body)) return { status: result.status, text: "", challenged: true };
      return { status: result.status, text: result.status >= 200 && result.status < 300 ? robotsPrefix(result.body) : "" };
    }
    return { status: 0, text: "" };
  };

  const robotsGate = async (url: URL, method: HttpMethod): Promise<void> => {
    let pending = robots.get(url.origin);
    if (!pending) robots.set(url.origin, pending = readRobots(url.origin));
    const entry = await pending;
    const refuse = (next: Stop): never => {
      refuseRow(method, url, "page", next.reason!);
      return halt(next);
    };
    if (entry.challenged) refuse({ outcome: "refused", reason: "bot_challenge", status: entry.status, retry: false });
    if (entry.status >= 400 && entry.status < 500) return;
    if (entry.status === 0 || entry.status >= 500) {
      refuse({ outcome: "refused", reason: "robots_unavailable", retry: true, ...(entry.status ? { status: entry.status } : {}) });
    }
    const decision = robotsDecision(entry.text, url.pathname + url.search, identity.productToken);
    if (!decision.allow) refuse({ outcome: "refused", reason: "robots_disallowed", retry: false, ...(decision.rule ? { detail: decision.rule } : {}) });
  };

  const headersFor = (entries: ReadonlyArray<[string, unknown]> | null, url: URL, method: HttpMethod): Record<string, string> => {
    const out: Record<string, string> = {};
    if (entries === null || entries.length > MAX_HEADERS) halt({ outcome: "refused", reason: "header_refused", retry: false });
    if (ctx.authority?.headers && !ctx.authority.headers(entries, ctx.conditional)) {
      refuseRow(method, url, "page", "header_refused");
      halt({outcome: "refused", reason: "header_refused", retry: false});
    }
    for (const [rawName, value] of entries) {
      const name = rawName.toLowerCase();
      const admitted = HEADER_NAME.test(name) && !NEVER_SENT.has(name) && typeof value === "string" && HEADER_VALUE.test(value)
        && (BASE_HEADERS.has(name) || (VALIDATOR_HEADERS.has(name) ? ctx.conditional : rules.header?.(name, new URL(url.href)) === true));
      if (!admitted) {
        refuseRow(method, url, "page", "header_refused");
        halt({ outcome: "refused", reason: "header_refused", detail: name.slice(0, 64), retry: false });
      }
      out[name] = value;
    }
    return out;
  };

  const request = async (input: ProfileRequest): Promise<ProfileResponse> => {
    if (stop) throw new SourceStop(stop);
    if (closed) throw new SourceStop({ outcome: "refused", reason: "run_ended", retry: false });
    if (!record(input)) halt({ outcome: "refused", reason: "url_invalid", retry: false });
    // Each field is read once: a getter answering differently on a second read changes nothing.
    const { url: rawUrl, method: rawMethod, headers: rawHeaders, body, maxBytes: rawMaxBytes } = input;
    const headerEntries = rawHeaders === undefined ? [] : record(rawHeaders) ? Object.entries(rawHeaders) : null;
    if (typeof rawUrl !== "string" || rawUrl.length > MAX_URL) halt({ outcome: "refused", reason: "url_invalid", retry: false });
    const method: HttpMethod = rawMethod ?? "GET";
    if (method !== "GET" && method !== "POST") halt({ outcome: "refused", reason: "method_refused", retry: false });
    if (body !== undefined && typeof body !== "string") halt({ outcome: "refused", reason: "body_refused", retry: false });
    if (rawMaxBytes !== undefined && !(typeof rawMaxBytes === "number" && Number.isInteger(rawMaxBytes) && rawMaxBytes > 0)) {
      halt({ outcome: "refused", reason: "request_invalid", detail: "maxBytes", retry: false });
    }
    const maxBytes = Math.min(rawMaxBytes ?? budget.maxBytes, budget.maxBytes);
    let url: URL;
    try { url = new URL(rawUrl); } catch { refuseRow(method, rawUrl.slice(0, 256), "page", "url_invalid"); halt({ outcome: "refused", reason: "url_invalid", retry: false }); }
    url.hash = "";
    if (method === "GET" && body !== undefined) { refuseRow(method, url, "page", "body_refused"); halt({ outcome: "refused", reason: "body_refused", retry: false }); }
    if (method === "POST" && hosts.credential.has(url.hostname) && ctx.graphqlPaths?.includes(url.pathname)) {
      let parsed: unknown;
      try {parsed = JSON.parse(body ?? "");} catch {parsed = undefined;}
      const problem = !record(parsed) ? "invalid GraphQL body" : graphqlReadProblem(parsed.query, parsed.variables, null);
      const reason = problem ? "method_refused" : "graphql_scope_unsupported";
      refuseRow(method, url, "page", reason);
      halt({outcome: "refused", reason, retry: false});
    }
    // A keyless host is read with GET only, whatever a rule says.
    if (method === "POST" && (!hosts.credential.has(url.hostname) || rules.post?.(new URL(url.href), body) !== true)) {
      refuseRow(method, url, "page", "method_refused");
      halt({ outcome: "refused", reason: "method_refused", retry: false });
    }
    let from: URL | undefined;
    for (let hop = 0; ; hop++) {
      const refusal = hopRefusal(url, from);
      if (refusal) {
        refuseRow(method, url, "page", refusal.reason);
        halt({ outcome: "refused", ...refusal, retry: false });
      }
      if (rules.url && rules.url(new URL(url.href), { method, redirect: hop > 0 }) !== true) {
        refuseRow(method, url, "page", "url_refused");
        halt({ outcome: "refused", reason: "url_refused", retry: false });
      }
      const headers = headersFor(headerEntries, url, method);
      // Callbacks receive disposable URL views. Check private authority again after every phase.
      const finalHop = hopRefusal(url, from);
      if (finalHop || ctx.authority?.headers?.(Object.entries(headers), ctx.conditional) === false || ctx.authority?.url?.(new URL(url.href), {method, redirect: hop > 0}) === false
        || method === "POST" && ctx.authority?.post?.(new URL(url.href), body) === false
        || Object.keys(headers).some(name => !BASE_HEADERS.has(name) && !VALIDATOR_HEADERS.has(name) && ctx.authority?.header?.(name, new URL(url.href)) === false)) {
        const reason = finalHop?.reason ?? "url_refused";
        refuseRow(method, url, "page", reason);
        halt({outcome: "refused", reason, retry: false});
      }
      if (hosts.keyless.has(url.hostname)) await robotsGate(url, method);
      const result = await send(url, method, headers, body, maxBytes, "page");
      if (result === "failed" || result === "timeout") halt({ outcome: "provider_unavailable", reason: result === "timeout" ? "timeout" : "transport", retry: true });
      if (!result.ok) halt({ outcome: "too_large", retry: false });
      const { status, headers: responseHeaders, body: responseBody } = result;
      // A bot-mitigation page is never content and never retried around.
      if (hosts.keyless.has(url.hostname) && challenged(status, responseHeaders, responseBody)) {
        halt({ outcome: "refused", reason: "bot_challenge", status, retry: false });
      }
      if (REDIRECTS.has(status)) {
        if (method !== "GET") halt({ outcome: "refused", reason: "redirect_refused", detail: method, status, retry: false });
        const location = responseHeaders.location;
        if (!location) halt({ outcome: "refused", reason: "redirect_invalid", status, retry: false });
        if (hop >= budget.redirects) halt({ outcome: "refused", reason: "redirect_limit", status, retry: false });
        let next: URL;
        try { next = new URL(location, url); } catch { halt({ outcome: "refused", reason: "url_invalid", status, retry: false }); }
        next.hash = "";
        from = url;
        url = next;
        continue;
      }
      const stopped = statusStop(status, responseHeaders);
      if (stopped) halt(stopped);
      const response = { status, headers: responseHeaders, body: responseBody, url: url.href };
      rules.response?.({...response, headers: {...response.headers}});
      return response;
    }
  };

  return {
    transport: { request },
    requests,
    stopped: () => stop,
    remaining: () => left,
    close: () => { closed = true; },
  };
}
