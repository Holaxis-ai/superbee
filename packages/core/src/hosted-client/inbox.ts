// The inbox of a hosted Superbee, over the sync family's attention routes
// (`POST <prefix>/attention/<operationId>`): one route per operation, its JSON body the operation's
// input, its answer the catalog's `{ ok, operationId, data | error }`. Every request names the
// workspace it acts in (`Superbee-Workspace`), because a sync admission spans all of the person's
// workspaces. The shapes are the open notification contracts; the store, delivery and every check
// stay with the host.
//
// Refusals become `HostedAttentionRefusal` with the catalog's code and this module's own words:
// nothing the host wrote (message, hint) is repeated, because a message is the host's to change and
// a hint may grow. A request that may have reached the host and has no answer is retried with the
// same ticket, which the host answers as a replay of the first, never as a second item.
import type { DocumentTargetV1 } from "../artifact-contract.js";
import { HostedCarrierError } from "../hosted-transport/carrier.js";
import { isWorkspaceTenantId, isAgentLabelVia } from "../hosted-transport/carrier.js";
import { REFUSAL_CODE } from "../hosted-transport/read-adapter.js";
import { MalformedAnswer, RemoteError } from "../remote-error.js";
import type { HostedClient } from "./client.js";
import { HostedRouteNotServed } from "./errors.js";

/** The largest inbox answer read, in bytes: 100 entries with full notes and meta fit well inside. */
export const INBOX_ANSWER_BYTES = 1024 * 1024;
/** The most a note may hold after normalization, in characters. */
export const INBOX_NOTE_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------------------------
// The open contract shapes.

export const ATTENTION_OPERATION_IDS = Object.freeze({
  request: "attention.request.v1",
  cancel: "attention.cancel.v1",
  list: "inbox.list.v1",
  threads: "inbox.threads.v1",
  summary: "inbox.summary.v1",
  get: "inbox.get.v1",
  open: "inbox.open.v1",
  ack: "inbox.ack.v1",
  directory: "members.directory.v1",
} as const);
export type AttentionOperationId = (typeof ATTENTION_OPERATION_IDS)[keyof typeof ATTENTION_OPERATION_IDS];

/** v1 addresses principals only. */
export interface InboxRecipient {
  readonly kind: "principal";
  readonly principalId: string;
}

/** The kinds a person's caller may send. `ready` and `review_requested` need a document target. */
export const PERSON_ITEM_KINDS = ["ready", "needs_input", "review_requested", "reply"] as const;
export type PersonItemKind = (typeof PERSON_ITEM_KINDS)[number];
export type InboxItemKind = PersonItemKind | `system.${string}`;
/** The kinds the host refuses without a document target. */
export const TARGET_REQUIRED_KINDS: readonly PersonItemKind[] = Object.freeze(["ready", "review_requested"]);

export const INBOX_ITEM_STATES = ["unread", "read", "acknowledged", "expired", "withdrawn"] as const;
export type InboxItemState = (typeof INBOX_ITEM_STATES)[number];

export const PROVENANCE_SURFACES = ["browser", "mcp", "mcp_agent", "sync", "workload", "ops", "operator_workflow", "host_job"] as const;
export type ProvenanceSurface = (typeof PROVENANCE_SURFACES)[number];

/** App metadata: lowercase dotted namespaces of JSON objects, untrusted, at most 1 KiB. */
export type InboxAppMeta = Record<string, Record<string, unknown>>;

/** In a fact filter's `principalId`, the caller's own principal. */
export const SELF_PRINCIPAL = "self";

/** An exact-match predicate over an item's producer facts; every given field must match. */
export interface InboxFactMatch {
  readonly surface?: readonly ProvenanceSurface[];
  readonly credentialId?: readonly string[];
  readonly clientId?: readonly string[];
  readonly agentId?: readonly string[];
  readonly principalId?: readonly string[];
  readonly kind?: readonly InboxItemKind[];
  readonly metaNamespace?: readonly string[];
}

export interface InboxListInput {
  /** Every item of a thread you take part in, both directions. */
  readonly threadId?: string;
  /** Default `["unread", "read"]`. */
  readonly states?: readonly InboxItemState[];
  readonly include?: InboxFactMatch;
  /** One predicate, or up to four where any match drops the item. */
  readonly exclude?: InboxFactMatch | readonly InboxFactMatch[];
  /** Pull cursor (exclusive): ascending by seq when set, else newest first. */
  readonly afterSeq?: number;
  /** At most 100. */
  readonly limit?: number;
}

export interface InboxThreadsInput {
  readonly scope?: "all" | "sent" | "received" | "self";
  /** The previous page's `nextBefore`. */
  readonly before?: string;
  readonly limit?: number;
}

export interface InboxSummaryInput {
  readonly exclude?: InboxFactMatch | readonly InboxFactMatch[];
}

export interface InboxAckInput {
  /** The revision you read; a newer one is `version_conflict`. */
  readonly expectedRevision: number;
  /** The document version you were shown, recorded with the acknowledgment. */
  readonly shownVersion?: string;
}

/** What to send. `ticket` is minted here when absent; pass the one a failed send carried to retry it. */
export interface AttentionRequestInput {
  readonly ticket?: string;
  readonly threadId?: string;
  readonly recipient?: InboxRecipient;
  readonly kind: PersonItemKind;
  /** A saved document version the recipient can open; it must be the document's current version. */
  readonly target?: { readonly document: DocumentTargetV1; readonly eventVersion: string };
  readonly note?: string;
  readonly meta?: InboxAppMeta;
  /** `none`: inbox only, no email. */
  readonly alert?: "default" | "none";
}

/** A producer's facts: the reader's own (or a host job's) in full, another person's reduced to who. */
export interface InboxProducerFacts {
  readonly tenantId: string;
  readonly principalId?: string;
  readonly credentialId?: string;
  readonly clientId?: string;
  readonly agentId?: string;
  readonly connectionId?: string;
  readonly surface?: ProvenanceSurface;
  readonly membershipEpoch?: string;
  readonly job?: string;
  /** The tool's own unverified label. */
  readonly via?: string;
}

/** Names the host resolved at read time from its own records, never the producer's words. */
export interface InboxProducerDisplay {
  readonly personName: string | null;
  readonly clientName?: string;
  readonly agentName?: string;
  readonly firstPartyName?: string;
}

export interface InboxEntryTarget {
  /** Null when the reader can't see the document. */
  readonly document: DocumentTargetV1 | null;
  /** The current title, read live under the reader's access; never stored. */
  readonly title: string | null;
  readonly eventVersion: string | null;
  readonly comparison: "same" | "different" | null;
  readonly openUrl: string | null;
  readonly unavailable?: "no_access" | "deleted" | "replaced" | "temporarily";
}

export interface InboxEntry {
  readonly itemId: string;
  readonly seq: number;
  readonly threadId: string;
  readonly revision: number;
  readonly kind: InboxItemKind;
  readonly state: InboxItemState;
  readonly recipient: InboxRecipient;
  readonly producer: InboxProducerFacts;
  readonly producerDisplay: InboxProducerDisplay;
  readonly target: InboxEntryTarget | null;
  /** The sender's own words: untrusted text. */
  readonly note: string | null;
  /** The sender's app metadata: untrusted. */
  readonly meta: InboxAppMeta | null;
  readonly alert: "default" | "none";
  readonly withdrawReason: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly readAt: number | null;
  readonly readBy: InboxProducerFacts | null;
  readonly acknowledgedAt: number | null;
  readonly acknowledgedBy: InboxProducerFacts | null;
}

export interface InboxListPage {
  readonly entries: readonly InboxEntry[];
  readonly nextAfterSeq: number | null;
}

export interface InboxThread {
  readonly threadId: string;
  readonly startedByYou: boolean;
  readonly self: boolean;
  readonly system: boolean;
  readonly counterpart: { readonly tenantId: string; readonly principalId: string; readonly personName: string | null };
  readonly initiator: InboxProducerFacts;
  readonly createdAt: number;
  readonly lastItemAt: number;
  readonly last: null | {
    readonly itemId: string;
    readonly seq: number;
    readonly kind: InboxItemKind;
    readonly state: InboxItemState;
    readonly createdAt: number;
    readonly sentByYou: boolean;
  };
  readonly openToYou: number;
  readonly unreadToYou: number;
  readonly openFromYou: number;
}

export interface InboxThreadsPage {
  readonly threads: readonly InboxThread[];
  readonly nextBefore: string | null;
}

export interface InboxCount {
  readonly count: number;
  /** True: `count` is a floor. */
  readonly capped: boolean;
}

export interface InboxSummary {
  readonly waitingThreads: InboxCount;
  readonly unreadUpdates: InboxCount;
  /** Your inbox's highest seq, for `list({ afterSeq })`; 0 when empty. */
  readonly newestSeq: number;
}

export interface AttentionReceipt {
  readonly itemId: string;
  readonly threadId: string;
  readonly itemRevision: number;
  /** True when the host had this ticket already and answered the first send's item. */
  readonly replayed: boolean;
  readonly delivery: { readonly inApp: "visible"; readonly email: "pending" | "off" };
  /** The ticket this send went under. */
  readonly ticket: string;
}

/** The most members one directory page lists. */
export const DIRECTORY_PAGE_MAX = 100;

export interface DirectoryInput {
  /** The previous page's `nextAfter`: members whose principal id sorts after it. */
  readonly after?: string;
  /** At most {@link DIRECTORY_PAGE_MAX} (the default). */
  readonly limit?: number;
}

/**
 * One workspace member the caller can notify. The name (and email, when the host shares it) is
 * the host's record, for presentation and matching only: a request still names `principalId`.
 */
export interface DirectoryMember {
  readonly principalId: string;
  readonly displayName: string | null;
  /** Present only where the host's policy shares addresses (off by default). */
  readonly email?: string | null;
  /** The caller, listed once whatever their own preference. */
  readonly self: boolean;
}

export interface DirectoryPage {
  readonly members: readonly DirectoryMember[];
  /** Pass as `after` for the next page; null on the last. */
  readonly nextAfter: string | null;
}

export interface AttentionCancelResult {
  readonly itemId: string;
  readonly state: InboxItemState;
  readonly revision: number;
}

// ---------------------------------------------------------------------------------------------
// Refusals.

/** The codes an attention refusal carries: the operation catalog's, plus the workspace header's. */
export const ATTENTION_REFUSAL_CODES = [
  "invalid_input",
  "insufficient_scope",
  "attention_disabled",
  "not_found",
  "target_unavailable",
  "target_unsupported",
  "request_conflict",
  "version_conflict",
  "workspace_unsupported",
  "workspace_not_available",
  "quota_exceeded",
  "ticket_expired",
  "internal_error",
  "backend_unavailable",
  "cancelled",
  "deadline_exceeded",
] as const;
export type AttentionRefusalCode = (typeof ATTENTION_REFUSAL_CODES)[number];

const REFUSAL_WORDS: Readonly<Record<AttentionRefusalCode, string>> = Object.freeze({
  invalid_input: "the host refused the input",
  insufficient_scope: "this sign-in may not use the inbox",
  attention_disabled: "the inbox is not turned on for this workspace",
  not_found: "not available: no such item, not addressed to you, or the recipient is not an active member of this workspace",
  target_unavailable: "the document is not available to you at that version",
  target_unsupported: "this document predates change tracking; save it once and try again",
  request_conflict: "this ticket was already used with a different input",
  version_conflict: "the item changed since it was read",
  workspace_unsupported: "this connection names no single workspace",
  workspace_not_available: "the workspace is not available to this sign-in",
  quota_exceeded: "the request limit for this workspace was reached",
  ticket_expired: "the ticket is too old or too far ahead; send with a new one",
  internal_error: "the host could not complete the operation",
  backend_unavailable: "the inbox is unavailable right now",
  cancelled: "the host cancelled the operation",
  deadline_exceeded: "the host's deadline passed",
});

/**
 * The host refused an attention operation. `code` is the catalog's; the message is this client's
 * own. `serverTime` comes with `ticket_expired` (the host's clock, for a caller whose clock is off).
 */
export class HostedAttentionRefusal extends RemoteError {
  override readonly code: AttentionRefusalCode;
  readonly operationId: AttentionOperationId;
  readonly retryable: boolean;
  readonly serverTime?: number;
  /** What the refusal means, in this client's words, without the operation id. */
  readonly reason: string;
  constructor(operationId: AttentionOperationId, code: AttentionRefusalCode, status: number, retryable: boolean, serverTime?: number) {
    super(`${operationId}: ${REFUSAL_WORDS[code]}`, code, status);
    this.name = "HostedAttentionRefusal";
    this.reason = REFUSAL_WORDS[code];
    this.code = code;
    this.operationId = operationId;
    this.retryable = retryable;
    if (serverTime !== undefined) this.serverTime = serverTime;
  }
}

export function isAttentionRefusal(error: unknown): error is HostedAttentionRefusal {
  return error instanceof HostedAttentionRefusal;
}

/**
 * A send whose outcome is unknown after every retry: it may or may not have created the item.
 * Sending again with `ticket` is safe for 24 hours from when it was minted: the host answers the
 * first send's item, or creates it once.
 */
export class HostedAttentionOutcomeUnknown extends Error {
  readonly code = "attention_outcome_unknown";
  readonly ticket: string;
  constructor(ticket: string, cause: unknown) {
    super("the send may have reached the host; send again with the same ticket", { cause });
    this.name = "HostedAttentionOutcomeUnknown";
    this.ticket = ticket;
  }
}

export function isAttentionOutcomeUnknown(error: unknown): error is HostedAttentionOutcomeUnknown {
  return error instanceof HostedAttentionOutcomeUnknown;
}

// ---------------------------------------------------------------------------------------------
// The client.

export interface HostedInboxOptions {
  /** The workspace (tenant id) every request acts in, sent as `Superbee-Workspace`. */
  readonly tenantId: string;
  /**
   * The agent the caller runs under (`X-Superbee-Via`), recorded with a send as the tool's own
   * unverified label. Only a token the host admits is sent; anything else is a `TypeError`.
   */
  readonly via?: string;
  /** How many times a send is tried when its answer is unclear. Default 3. */
  readonly sendAttempts?: number;
  /** The wait between those tries, in milliseconds. Default 250. */
  readonly retryDelayMs?: number;
  /** The clock tickets are minted from, in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

export interface HostedInbox {
  readonly tenantId: string;
  /** Your inbox, newest first, or a thread's items (`threadId`); ascending past `afterSeq`. */
  list(input?: InboxListInput): Promise<InboxListPage>;
  /** The threads you take part in, newest activity first. */
  threads(input?: InboxThreadsInput): Promise<InboxThreadsPage>;
  /** What is waiting on you, and your inbox's newest seq. */
  summary(input?: InboxSummaryInput): Promise<InboxSummary>;
  /** One item addressed to you or on a thread you take part in; does not mark it read. */
  get(itemId: string): Promise<InboxEntry>;
  /** One item addressed to you, marked read. */
  open(itemId: string): Promise<InboxEntry>;
  /** Mark an item addressed to you as handled at the revision you read. Repeating it on a handled item returns it. */
  ack(itemId: string, input: InboxAckInput): Promise<InboxEntry>;
  /**
   * Ask a person (yourself included) to look at something. One ticket per send, minted here unless
   * given; an unclear answer is retried with it, and a send that stays unclear throws
   * {@link HostedAttentionOutcomeUnknown} carrying it.
   */
  request(input: AttentionRequestInput): Promise<AttentionReceipt>;
  /** Withdraw an unread or read item you sent. */
  cancel(itemId: string): Promise<AttentionCancelResult>;
  /**
   * One page of the members you can notify, by principal id. Offered only where the identity's
   * `notificationDirectoryWorkspaces` names this workspace; {@link readDirectory} reads every page.
   */
  directory(input?: DirectoryInput): Promise<DirectoryPage>;
}

/** A fresh UUIDv7 (RFC 9562): 48-bit millisecond time, version 7, 74 random bits. */
export function mintAttentionTicket(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let time = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Whether `value` is a UUIDv7, the shape tickets and thread ids take. */
export function isAttentionTicket(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

/**
 * The inbox of `client`'s person in one workspace, over the client's carrier, prefix and signal
 * (its credential, deadline and abort). A `within` client serves as well: no attention input
 * names a bundle.
 */
export function createHostedInbox(client: Pick<HostedClient, "prefix" | "carrier" | "signal">, options: HostedInboxOptions): HostedInbox {
  const { tenantId } = options;
  if (!isWorkspaceTenantId(tenantId)) throw new TypeError("a hosted inbox names its workspace by tenant id");
  if (options.via !== undefined && !isAgentLabelVia(options.via)) throw new TypeError("a hosted inbox's via is not a token the host admits");
  const attempts = Math.max(1, Math.floor(options.sendAttempts ?? 3));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  const now = options.now ?? Date.now;

  async function call(operationId: AttentionOperationId, input: object, via?: string): Promise<Record<string, unknown>> {
    const route = `${client.prefix}/attention/${operationId}`;
    const answer = await client.carrier.json(route, input, client.signal, {
      maximum: INBOX_ANSWER_BYTES,
      workspace: tenantId,
      ...(via === undefined ? {} : { via }),
    });
    const body = answer.body as Record<string, unknown> | undefined;
    if (answer.status === 200 && body?.ok === true) {
      if (body.operationId !== operationId || !isRecord(body.data)) throw new MalformedAnswer("not an attention answer", route);
      return body.data;
    }
    throw refusalOf(operationId, route, answer.status, body);
  }

  const read = <T>(operationId: AttentionOperationId, input: object, decode: (data: Record<string, unknown>, route: string) => T) =>
    call(operationId, input).then((data) => decode(data, `${client.prefix}/attention/${operationId}`));

  return {
    tenantId,
    list: (input = {}) => read(ATTENTION_OPERATION_IDS.list, input, decodeListPage),
    threads: (input = {}) => read(ATTENTION_OPERATION_IDS.threads, input, decodeThreadsPage),
    summary: (input = {}) => read(ATTENTION_OPERATION_IDS.summary, input, decodeSummary),
    get: (itemId) => read(ATTENTION_OPERATION_IDS.get, { itemId }, entryOf),
    open: (itemId) => read(ATTENTION_OPERATION_IDS.open, { itemId }, entryOf),
    ack: (itemId, input) =>
      read(
        ATTENTION_OPERATION_IDS.ack,
        { itemId, expectedRevision: input.expectedRevision, ...(input.shownVersion === undefined ? {} : { shownVersion: input.shownVersion }) },
        entryOf,
      ),
    cancel: (itemId) =>
      read(ATTENTION_OPERATION_IDS.cancel, { itemId }, (data, route) => {
        if (typeof data.itemId !== "string" || !isState(data.state) || !isCount(data.revision)) throw new MalformedAnswer("not a cancel answer", route);
        return { itemId: data.itemId, state: data.state, revision: data.revision };
      }),
    directory: (input = {}) => read(ATTENTION_OPERATION_IDS.directory, input, decodeDirectoryPage),
    async request(input) {
      const ticket = input.ticket ?? mintAttentionTicket(now());
      if (!isAttentionTicket(ticket)) throw new TypeError("a ticket is a UUIDv7");
      const body = { ...input, ticket };
      const route = `${client.prefix}/attention/${ATTENTION_OPERATION_IDS.request}`;
      let unclear: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await pause(retryDelayMs, client.signal);
        try {
          const data = await call(ATTENTION_OPERATION_IDS.request, body, options.via);
          return { ...decodeReceipt(data, route), ticket };
        } catch (error) {
          // Once an attempt may have landed, no later answer settles the send: a retry refused
          // before the host reads its ticket (a session ended, a quota spent, a removed member)
          // says nothing about the first delivery, so the ticket must survive for a resend.
          if (unclear !== undefined && !sendMayHaveLanded(error)) throw new HostedAttentionOutcomeUnknown(ticket, error);
          // Nothing left: the credential was refused before sending, or the caller aborted.
          if (error instanceof HostedCarrierError && error.code === "denied") throw error;
          if (!sendMayHaveLanded(error)) throw error;
          unclear = error;
          if (client.signal.aborted) break;
        }
      }
      throw new HostedAttentionOutcomeUnknown(ticket, unclear);
    },
  };
}

/** An answer that leaves a send's outcome unknown: no answer, or a refusal the host marks retryable. */
function sendMayHaveLanded(error: unknown): boolean {
  if (error instanceof HostedCarrierError) return error.code === "unavailable";
  if (error instanceof HostedAttentionRefusal) return error.retryable || error.code === "internal_error";
  if (error instanceof RemoteError && !(error instanceof MalformedAnswer) && !(error instanceof HostedRouteNotServed)) return error.status >= 500;
  return false;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms === 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const STATUS_RETRYABLE: ReadonlySet<AttentionRefusalCode> = new Set(["backend_unavailable", "deadline_exceeded"]);

/** Every answer but a success, as the typed error it is. Host words never travel. */
function refusalOf(operationId: AttentionOperationId, route: string, status: number, body: Record<string, unknown> | undefined): Error {
  // A gateway from before the attention routes: the family's unknown-route answer.
  if (status === 404 && body !== undefined && Object.keys(body).length === 1 && body.error === "not_found") return new HostedRouteNotServed(route);
  // The catalog's refusal.
  if (body?.ok === false && isRecord(body.error) && isRefusalCode(body.error.code)) {
    const error = body.error;
    const code = error.code as AttentionRefusalCode;
    const retryable = typeof error.retryable === "boolean" ? error.retryable : STATUS_RETRYABLE.has(code);
    const serverTime = code === "ticket_expired" && typeof error.serverTime === "number" && Number.isSafeInteger(error.serverTime) ? error.serverTime : undefined;
    return new HostedAttentionRefusal(operationId, code, status, retryable, serverTime);
  }
  // The workspace header's one refusal, the same for every cause.
  if (status === 403 && body?.ok === false && body.code === "workspace_not_available") {
    return new HostedAttentionRefusal(operationId, "workspace_not_available", status, false);
  }
  // The family's own refusals (unauthenticated, an admission that is off or unavailable).
  const familyCode = isRecord(body?.error) ? body.error.code : undefined;
  if (typeof familyCode === "string" && REFUSAL_CODE.test(familyCode)) return new RemoteError(`hosted ${route} answered ${status} ${familyCode}`, familyCode, status);
  if (status === 401) return new RemoteError(`hosted ${route} answered 401`, "unauthenticated", 401);
  if (status >= 500) return new RemoteError(`hosted ${route} answered ${status}`, "RUNTIME", status);
  return new MalformedAnswer(`not an attention answer (${status})`, route);
}

const isRefusalCode = (value: unknown): value is AttentionRefusalCode => typeof value === "string" && (ATTENTION_REFUSAL_CODES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------------------------
// Decoding: the fields a caller relies on are checked; the rest of each record is passed through.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isState = (value: unknown): value is InboxItemState => typeof value === "string" && (INBOX_ITEM_STATES as readonly string[]).includes(value);
const isNullableCount = (value: unknown) => value === null || isCount(value);

function decodeEntry(value: unknown, route: string): InboxEntry {
  if (
    !isRecord(value) ||
    typeof value.itemId !== "string" ||
    !isCount(value.seq) ||
    typeof value.threadId !== "string" ||
    !isCount(value.revision) ||
    typeof value.kind !== "string" ||
    !isState(value.state) ||
    !isRecord(value.recipient) ||
    typeof value.recipient.principalId !== "string" ||
    !isRecord(value.producer) ||
    !isRecord(value.producerDisplay) ||
    !(value.target === null || isRecord(value.target)) ||
    !(value.note === null || typeof value.note === "string") ||
    !(value.meta === null || isRecord(value.meta)) ||
    !isCount(value.createdAt) ||
    !isCount(value.expiresAt) ||
    !isNullableCount(value.readAt) ||
    !isNullableCount(value.acknowledgedAt)
  ) {
    throw new MalformedAnswer("not an inbox entry", route);
  }
  return value as unknown as InboxEntry;
}

function entryOf(data: Record<string, unknown>, route: string): InboxEntry {
  return decodeEntry(data.entry, route);
}

function decodeListPage(data: Record<string, unknown>, route: string): InboxListPage {
  if (!Array.isArray(data.entries) || !isNullableCount(data.nextAfterSeq)) throw new MalformedAnswer("not an inbox page", route);
  return { entries: data.entries.map((entry) => decodeEntry(entry, route)), nextAfterSeq: data.nextAfterSeq as number | null };
}

function decodeThreadsPage(data: Record<string, unknown>, route: string): InboxThreadsPage {
  if (!Array.isArray(data.threads) || !(data.nextBefore === null || typeof data.nextBefore === "string")) throw new MalformedAnswer("not a threads page", route);
  const threads = data.threads.map((thread) => {
    if (
      !isRecord(thread) ||
      typeof thread.threadId !== "string" ||
      !isRecord(thread.counterpart) ||
      typeof thread.counterpart.principalId !== "string" ||
      !isCount(thread.lastItemAt) ||
      !isCount(thread.openToYou) ||
      !isCount(thread.unreadToYou) ||
      !isCount(thread.openFromYou) ||
      !(thread.last === null || (isRecord(thread.last) && typeof thread.last.itemId === "string" && isState(thread.last.state)))
    ) {
      throw new MalformedAnswer("not a thread", route);
    }
    return thread as unknown as InboxThread;
  });
  return { threads, nextBefore: data.nextBefore as string | null };
}

function decodeSummary(data: Record<string, unknown>, route: string): InboxSummary {
  const count = (value: unknown): InboxCount => {
    if (!isRecord(value) || !isCount(value.count) || typeof value.capped !== "boolean") throw new MalformedAnswer("not an inbox summary", route);
    return { count: value.count, capped: value.capped };
  };
  if (!isCount(data.newestSeq)) throw new MalformedAnswer("not an inbox summary", route);
  return { waitingThreads: count(data.waitingThreads), unreadUpdates: count(data.unreadUpdates), newestSeq: data.newestSeq };
}

function decodeDirectoryPage(data: Record<string, unknown>, route: string): DirectoryPage {
  if (!Array.isArray(data.members) || !(data.nextAfter === null || (typeof data.nextAfter === "string" && data.nextAfter !== ""))) {
    throw new MalformedAnswer("not a directory page", route);
  }
  const members = data.members.map((member): DirectoryMember => {
    if (
      !isRecord(member) ||
      typeof member.principalId !== "string" ||
      member.principalId === "" ||
      !(member.displayName === null || typeof member.displayName === "string") ||
      !(member.email === undefined || member.email === null || typeof member.email === "string") ||
      typeof member.self !== "boolean"
    ) {
      throw new MalformedAnswer("not a directory member", route);
    }
    return {
      principalId: member.principalId,
      displayName: member.displayName,
      ...(member.email === undefined ? {} : { email: member.email }),
      self: member.self,
    };
  });
  return { members, nextAfter: data.nextAfter as string | null };
}

function decodeReceipt(data: Record<string, unknown>, route: string): Omit<AttentionReceipt, "ticket"> {
  const delivery = data.delivery;
  if (
    typeof data.itemId !== "string" ||
    typeof data.threadId !== "string" ||
    !isCount(data.itemRevision) ||
    typeof data.replayed !== "boolean" ||
    !isRecord(delivery) ||
    delivery.inApp !== "visible" ||
    (delivery.email !== "pending" && delivery.email !== "off")
  ) {
    throw new MalformedAnswer("not an attention receipt", route);
  }
  return {
    itemId: data.itemId,
    threadId: data.threadId,
    itemRevision: data.itemRevision,
    replayed: data.replayed,
    delivery: { inApp: "visible", email: delivery.email },
  };
}
