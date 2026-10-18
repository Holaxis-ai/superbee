/** Types of `@superbee/core/source-engine`. */
import type { BoundFeed, Connector, MappingDiagnostic } from "../connectors.js";
import type { Finding, RecordChange } from "../record-overlay/types.js";
import type { ConceptId } from "../types.js";
import type { MachineState } from "./machine-state.js";
import type { FetchIdentity } from "./robots.js";

export type HttpMethod = "GET" | "POST";

/** One record as a profile normalizes it: a JSON object the connector's mapping reads by dotted path. */
export type NormalizedRecord = Readonly<Record<string, unknown>>;

export type SpecResult<Spec> = { ok: true; spec: Spec } | { ok: false; errors: Array<{ path: string; message: string }> };

/** What the engine asks a transport for. A transport never follows a redirect itself. */
export interface TransportRequest {
  url: string;
  method: HttpMethod;
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** The most response body bytes to read; a longer body is refused, never truncated. */
  maxBytes: number;
  /**
   * The engine's own decision that `url` names one of the auth kind's credential hosts. A
   * transport sends its credential only when this is true and its own exact host match agrees.
   */
  credentialHost: boolean;
  /** Aborts the request: the run's deadline, or the per-request timeout. */
  signal?: AbortSignal;
}

/**
 * A response with lowercase header names and the body bytes read, or the refusal of a body over
 * `maxBytes`. A network failure rejects.
 */
export type TransportResult =
  | { ok: true; status: number; headers: Readonly<Record<string, string>>; body: string; bytes: number }
  | { ok: false; refused: "too_large" };

/**
 * The one network port. A credential-injecting transport adds a credential only toward the
 * connector's credential hosts over https, decided per URL, and never forwards it to another host;
 * `@superbee/core/source-harness` holds the conformance suite every transport passes.
 */
export interface Transport {
  request(input: TransportRequest): Promise<TransportResult>;
}

/** A request as a profile makes it, through the engine's guarded transport. */
export interface ProfileRequest {
  url: string;
  method?: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  maxBytes?: number;
}

/** A success (2xx), or in incremental mode a not-modified (304) answer; `url` is the final URL after redirects. */
export interface ProfileResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
  url: string;
}

/**
 * The transport a profile sees. Every other answer, and every refused request, stops the run: the
 * call throws and the engine discards the page, whatever the profile does with the error.
 */
export interface ProfileTransport {
  request(input: ProfileRequest): Promise<ProfileResponse>;
}

export interface ProfileDiagnostic {
  code: string;
  message: string;
  count?: number;
}

export interface ObserveContext<Spec, Cursor> {
  spec: Spec;
  bound: BoundFeed;
  /** The cursor the last committed page returned; null at the start of a pass. */
  cursor: Cursor | null;
  /** True on the first page of a run that continues a pass an earlier run left open. */
  resumed: boolean;
  mode: "incremental" | "complete";
  transport: ProfileTransport;
  /** Requests left in this run, and the byte bound per response. */
  budget: { requests: number; maxBytes: number };
  now: Date;
  /** Validators the last committed page stored; always null in complete mode. */
  validators: Readonly<Record<string, string>> | null;
}

/** One page of a pass. */
export interface ObservePage<Cursor> {
  records: readonly NormalizedRecord[];
  /** Stored once this page commits; the next page or run receives it. JSON data. */
  nextCursor: Cursor | null;
  /** Another page of this pass follows. */
  more: boolean;
  /** With `more: false`, the profile's claim that the pass listed every record of the resource. */
  complete: boolean;
  diagnostics?: readonly ProfileDiagnostic[];
  validators?: Readonly<Record<string, string>>;
}

/**
 * A versioned, named module that turns a bound Source Feed, a cursor and a transport into pages of
 * normalized records. It never opens a socket, never sees a credential, never names a Kind field
 * and never writes.
 */
export interface SourceProfile<Spec = unknown, Cursor = unknown> {
  readonly id: string;
  readonly version: number;
  readonly kind: "generic" | "extension";
  /** Profile semantics only. */
  validateSpec(spec: unknown): SpecResult<Spec>;
  /** Every host a run may touch. */
  hostsFor(spec: Spec, bound: BoundFeed): readonly string[];
  observe(ctx: ObserveContext<Spec, Cursor>): Promise<ObservePage<Cursor>>;
}

/**
 * Per-request hooks a declaration's provider rules feed. The engine's own rules hold whatever a
 * hook says: `authorization`, `cookie`, `proxy-authorization`, `host`, `user-agent` and the
 * method-override headers are never sent, and a POST is refused unless `post` admits it.
 */
export interface RequestRules {
  /**
   * A lowercase header name beyond `accept` toward `url`. The validators `if-none-match` and
   * `if-modified-since` are the engine's: sent in incremental mode, never in complete mode.
   */
  header?(name: string, url: URL): boolean;
  /** A POST toward `url` with `body`; absent, every POST is refused. */
  post?(url: URL, body: string | undefined): boolean;
  /** Every URL after the host guard admits it: the first request and each redirect hop. */
  url?(url: URL, hop: { method: HttpMethod; redirect: boolean }): boolean;
}

/** Status sets: the declaration's `errors` rows. Any other status outside 2xx and 304 is `provider_unavailable`. */
export interface StatusRules {
  deferred: readonly number[];
  credential_refused: readonly number[];
  not_found: readonly number[];
}

export interface SourceBudget {
  /** Transport calls per run, robots.txt reads and redirect hops included. */
  requests: number;
  /** Response body bytes per request. */
  maxBytes: number;
  /** Redirects followed per request. */
  redirects: number;
  /** Pages committed per run. */
  pages: number;
  /** The run's deadline when the caller passes no `signal`; with one, the caller owns the run's time. */
  deadlineMs: number;
  /** Each request's timeout, with or without the caller's `signal`. */
  requestTimeoutMs: number;
}

export type SourceOutcome =
  /** The pass reached its end in this run. */
  | "observed"
  /** Stopped with work left (rate limit, budget, deadline); committed pages stay. */
  | "deferred"
  /** The credential was refused; a retry needs a changed credential. */
  | "credential_refused"
  /** A server error or a transport failure. */
  | "provider_unavailable"
  | "not_found"
  | "unsupported_content"
  | "too_large"
  /** A guard refused the run or a request before it was sent. */
  | "refused"
  /** The profile, the state store or the caller's commit failed. */
  | "failed";

export interface SourceRequestRow {
  method: HttpMethod;
  /** Redacted. */
  url: string;
  purpose: "page" | "robots";
  status?: number;
  /** A guard refusal (nothing was sent) or the transport's `too_large`. */
  refused?: string;
}

/** What the caller writes for one page: the record-overlay changes, and whether the pass ended complete. */
export interface PageCommit {
  feed: ConceptId;
  provider: string;
  observed_at: string;
  /** 1-based within the run; 0 for the replay of pending changes before the first request. */
  page: number;
  /** The changes were held by an earlier commit and are planned again. */
  replay: boolean;
  changes: readonly RecordChange[];
  /** The record values the changes name, for titles. */
  records: Readonly<Record<string, { fields: Record<string, unknown> }>>;
  /** No state was stored for this feed before this run. */
  baseline: boolean;
  /** This page ended a complete observation; disappearances are among the changes. */
  complete: boolean;
}

/**
 * External ids of changes the commit did not write. Either way the record's stored entry stays
 * where it was. A `retry` change (a lost compare-and-swap, a claimed Signal) is kept pending in the
 * machine state and planned again at the start of every run until it is written, refused for
 * good, or superseded by a newer observation of the record. A `hold` change is not pending: the
 * record is planned again when it is next observed.
 */
export interface CommitResult {
  hold?: readonly string[];
  retry?: readonly string[];
}

export interface SourceRunReceipt {
  feed: ConceptId;
  provider: string;
  source: string;
  profile: { id: string; version: number };
  mode: "incremental" | "complete";
  observed_at: string;
  outcome: SourceOutcome;
  reason?: string;
  detail?: string;
  status?: number;
  /** Whether the same run may succeed later without a change to the credential or declaration. */
  retry: boolean;
  retry_after?: string;
  /** Pages committed in this run. */
  pages: number;
  /** Changes this run's commits did not write (`hold` and `retry`), replays included. */
  held: number;
  /** Changes pending when the run ended. */
  pending: number;
  requests: SourceRequestRow[];
  pass: { resumed: boolean; ended: boolean; complete: boolean };
  changes: { new: number; changed: number; disappeared: number };
  /** The cursor stored when the run ended. */
  cursor: unknown;
  cursor_reset?: "profile_version";
  diagnostics: MappingDiagnostic[];
  profile_diagnostics: ProfileDiagnostic[];
  findings: Finding[];
}

export interface ObserveSourceOptions<Spec = unknown, Cursor = unknown> {
  /** The declaration's credential kind and keyless domains: the only hosts a run may reach. */
  connector: Pick<Connector, "auth" | "domains">;
  bound: BoundFeed;
  profile: SourceProfile<Spec, Cursor>;
  spec: unknown;
  transport: Transport;
  state: MachineState;
  identity: FetchIdentity;
  mode?: "incremental" | "complete";
  budget?: Partial<SourceBudget>;
  /**
   * The run's deadline: once aborted, no request starts, the one in flight and the profile's page
   * are abandoned, and the run ends `deferred`. Without one the budget's `deadlineMs` applies. A
   * commit or state write in progress is never abandoned, so a hung one holds the run.
   */
  signal?: AbortSignal;
  now?: () => Date;
  rules?: RequestRules;
  statuses?: Partial<StatusRules>;
  /** Write one page's changes; the cursor and record state are stored only after this resolves. */
  commit(page: PageCommit): Promise<CommitResult | void>;
}
