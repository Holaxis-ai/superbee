/**
 * The working copy's read side over a hosted bundle: a `StorageBackend` that also carries
 * `heads`, `snapshot` and `wireCapabilities`, so the shared bootstrap and pull verbs take their
 * wire path against it. It answers only what those verbs call and refuses the rest before any
 * request leaves; every mutation is refused, because edits leave through the write transport.
 *
 * Refusals follow {@link READ_ANSWER_ROWS}: an authority refusal is a `RemoteError` with the
 * host's status and code, which the shared runtime classifies; a `503` says nothing about the
 * bundle, so it is the carrier's `unavailable` and the runtime reports itself offline. A read
 * the host answers `document_not_found` is an ENOENT-shaped rejection, as every backend answers
 * absence.
 *
 * The capabilities answer (flags, bound, root, retention window) is read once and held. Every
 * heads answer states the root's version; one that differs from the held answer's root drops
 * it, so the root and the edition it declares are as new as the listing. Any authority refusal
 * drops it too.
 */

import { RemoteError } from "../remote-error.js";
import { parseHeadsAnswer, readSnapshotStream, type HeadsResult, type RemoteSnapshot } from "../remote-parsers.js";
import type { HeadsOptions, WireCapabilities } from "../remote-backend.js";
import type { ConceptId, ReadResult, ReservedFilename, ReservedReadResult, StorageBackend } from "../types.js";
import { isContentVersion } from "../version-transport.js";
import { HostedCarrierError, type HostedAnswer, type HostedCarrier } from "./carrier.js";

/** What the capabilities route states about one bundle, beyond the wire booleans. */
export interface HostedCapabilities {
  readonly heads: boolean;
  readonly snapshot: boolean;
  readonly operations: boolean;
  /** The inventory bound and the per-document byte bound the host serves a working copy within. */
  readonly bound: Readonly<{ documents: number; bytes: number }>;
  /** The bundle root's reserved `index.md` as exact bytes with its version, or `null` without one. */
  readonly root: Readonly<{ content: string; version: string }> | null;
  /** How long the host keeps a request identity, in milliseconds (stated, or the thirty-day default). */
  readonly operationsRetentionMs: number;
}

/** The retention window assumed for a host that states none: thirty days. */
export const DEFAULT_OPERATIONS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long before the window ends an absent outcome stops being trusted: the host expires rows
 * by its own clock and the client measures an intent's age by its own, so the last hour of the
 * window is treated as already expired.
 */
export const OPERATIONS_RETENTION_SKEW_MS = 60 * 60 * 1000;

/** The header every heads answer carries: the root's content version, or {@link ROOT_VERSION_ABSENT}. */
export const ROOT_VERSION_HEADER = "X-Superbee-Root-Version";
export const ROOT_VERSION_ABSENT = "none";

/** The root version a heads answer states: a version, `null` for the absent marker, `undefined` when malformed. */
export function decodeRootVersion(value: string | null): string | null | undefined {
  if (value === ROOT_VERSION_ABSENT) return null;
  return isContentVersion(value) ? value : undefined;
}

export const HOSTED_READ_BOUNDS = Object.freeze({
  /** A capabilities answer carries the root's exact bytes, bounded like one document read. */
  capabilitiesBytes: 4 * 1024 * 1024,
  /** A heads listing at the inventory bound is a few hundred KiB; four MiB is a safe superset. */
  headsBytes: 4 * 1024 * 1024,
  /** One document read's answer, and one snapshot line. */
  documentBytes: 1024 * 1024 + 64 * 1024,
  /** Document reads in flight at once, whatever concurrency a caller's batches ask for. */
  readConcurrency: 8,
});

/** The routes one client family reads; the browser's are the defaults. */
export interface HostedReadRoutes {
  capabilities: string;
  heads: string;
  snapshot: string;
  read: string;
}

export const BROWSER_READ_ROUTES: HostedReadRoutes = Object.freeze({
  capabilities: "/reader/capabilities",
  heads: "/reader/heads",
  snapshot: "/reader/snapshot",
  read: "/reader/read",
});

export const SYNC_READ_ROUTES: HostedReadRoutes = Object.freeze({
  capabilities: "/sync/v1/capabilities",
  heads: "/sync/v1/heads",
  snapshot: "/sync/v1/snapshot",
  read: "/sync/v1/read",
});

export class HostedReadAdapterError extends Error {
  override readonly name = "HostedReadAdapterError";
  readonly code: "read_only" | "unsupported";
  constructor(code: "read_only" | "unsupported") {
    super(code);
    this.code = code;
  }
}

export interface HostedReadAdapterOptions {
  carrier: HostedCarrier;
  bundleId: string;
  routes?: HostedReadRoutes;
  /** Pinned on every document read, when the family binds reads (the browser's recovery target). */
  binding?: string;
}

export interface HostedReadAdapter extends StorageBackend {
  heads(options?: HeadsOptions): Promise<HeadsResult | null>;
  snapshot(): Promise<RemoteSnapshot>;
  wireCapabilities(): Promise<WireCapabilities>;
  hostedCapabilities(): Promise<HostedCapabilities>;
  operationsRetentionMs(): Promise<number>;
  /** Aborts every request in flight as a carrier failure and refuses every later one. */
  abort(): void;
  readonly signal: AbortSignal;
}

const malformed = (message: string) => new RemoteError(message, "RUNTIME", 502);

function notFound(id: ConceptId): Error & { code: string } {
  const error = new Error(`no concept document '${id}'`) as Error & { code: string };
  error.code = "ENOENT";
  return error;
}

function errorCode(body: unknown): string | undefined {
  const error = (body as { error?: { code?: unknown } } | undefined)?.error;
  return typeof error?.code === "string" ? error.code : undefined;
}

/** A read route's refusal as the runtime must see it (the `refusal` rows of {@link READ_ANSWER_ROWS}). */
export function readRefusal(answer: { status: number; body: unknown }): RemoteError | HostedCarrierError {
  const { status } = answer;
  if (status === 503) return new HostedCarrierError("unavailable");
  const code = errorCode(answer.body) ?? (status === 401 || status === 403 ? "AUTH_REQUIRED" : status >= 500 ? "RUNTIME" : "USAGE");
  return new RemoteError(`hosted read route answered ${status} ${code}`, code, status);
}

/** A carrier failure before a read left is the authority's `401`; anything else stays the carrier's. */
function carrierFailure(error: unknown): never {
  if (error instanceof HostedCarrierError && error.code === "denied") throw new RemoteError("no credential for the host", "AUTH_REQUIRED", 401, error);
  throw error;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The capabilities route's answer, admitted or refused as one; fields the route may gain are ignored. */
export function decodeHostedCapabilities(value: unknown): HostedCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw malformed("capabilities answer is not a JSON object");
  const body = value as Record<string, unknown>;
  const flag = (key: "heads" | "snapshot" | "operations"): boolean => {
    if (typeof body[key] !== "boolean") throw malformed(`capabilities answer lacks a boolean ${key}`);
    return body[key];
  };
  const bound = body.bound as { documents?: unknown; bytes?: unknown } | undefined;
  if (typeof bound !== "object" || bound === null || !positiveInteger(bound.documents) || !positiveInteger(bound.bytes))
    throw malformed("capabilities answer lacks the working copy bound");
  let root: HostedCapabilities["root"] = null;
  if (body.root !== null) {
    const raw = body.root as { content?: unknown; version?: unknown } | undefined;
    if (typeof raw !== "object" || raw === null || typeof raw.content !== "string" || !isContentVersion(raw.version))
      throw malformed("capabilities answer carries a malformed root");
    root = Object.freeze({ content: raw.content, version: raw.version });
  }
  const retention = body.operationsRetentionMs;
  // A window inside the skew margin leaves no interval in which absence is evidence.
  if (retention !== undefined && (!positiveInteger(retention) || retention <= OPERATIONS_RETENTION_SKEW_MS))
    throw malformed("capabilities answer carries a malformed retention window");
  return Object.freeze({
    heads: flag("heads"),
    snapshot: flag("snapshot"),
    operations: flag("operations"),
    bound: Object.freeze({ documents: bound.documents, bytes: bound.bytes }),
    root,
    operationsRetentionMs: retention ?? DEFAULT_OPERATIONS_RETENTION_MS,
  });
}

/** Fail a stream whose line runs past `maximum` bytes without its newline, before it is buffered whole. */
function boundedLines(body: ReadableStream<Uint8Array>, maximum: number): ReadableStream<Uint8Array> {
  let sinceNewline = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let start = 0;
        for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
          if (sinceNewline + index - start > maximum) {
            controller.error(malformed(`snapshot line exceeds ${maximum} bytes`));
            return;
          }
          sinceNewline = 0;
          start = index + 1;
        }
        sinceNewline += chunk.byteLength - start;
        if (sinceNewline > maximum) {
          controller.error(malformed(`snapshot line exceeds ${maximum} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

const TRANSIENT_READ_CODES = new Set(["backend_unavailable", "cancelled", "deadline_exceeded", "internal_error", "synchronization_pending"]);

/** A `documents.read.v1` success: the document's authored frontmatter and body at its version. */
function decodeDocumentRead(id: ConceptId, bundleId: string, body: unknown): ReadResult {
  const envelope = body as { ok?: unknown; operationId?: unknown; data?: { bundleId?: unknown; documentId?: unknown; version?: unknown; document?: { frontmatter?: unknown; body?: unknown } } } | undefined;
  const data = envelope?.data;
  const document = data?.document;
  if (envelope?.operationId !== "documents.read.v1" || envelope.ok !== true || !data || data.documentId !== id || data.bundleId !== bundleId ||
      !isContentVersion(data.version) || !document || typeof document.frontmatter !== "object" || document.frontmatter === null ||
      Array.isArray(document.frontmatter) || typeof document.body !== "string")
    throw malformed("document read answered a malformed envelope");
  return { doc: { id, frontmatter: document.frontmatter as ReadResult["doc"]["frontmatter"], body: document.body }, version: data.version };
}

export function createHostedReadAdapter(options: HostedReadAdapterOptions): HostedReadAdapter {
  const { carrier, bundleId } = options;
  const routes = options.routes ?? BROWSER_READ_ROUTES;
  const controller = new AbortController();
  let held: HostedCapabilities | undefined;
  let reading: Promise<HostedCapabilities> | undefined;
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  const forget = () => {
    held = undefined;
    reading = undefined;
  };
  const assertOpen = () => {
    if (controller.signal.aborted) throw new HostedCarrierError("unavailable");
  };
  const refused = (answer: HostedAnswer | { status: number; body: unknown }): never => {
    const error = readRefusal(answer);
    if (error instanceof RemoteError) forget();
    throw error;
  };
  async function acquire() {
    if (inFlight < HOSTED_READ_BOUNDS.readConcurrency) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else inFlight -= 1;
  }
  function capabilities(): Promise<HostedCapabilities> {
    if (held) return Promise.resolve(held);
    if (reading) return reading;
    assertOpen();
    const pending: Promise<HostedCapabilities> = carrier
      .json(routes.capabilities, { bundleId }, controller.signal, { maximum: HOSTED_READ_BOUNDS.capabilitiesBytes })
      .catch(carrierFailure)
      .then((answer) => {
        if (answer.status !== 200) refused(answer);
        return decodeHostedCapabilities(answer.body);
      });
    reading = pending;
    // A failed read is not held: the next call asks again. A read superseded by a `forget` is not held either.
    pending.then(
      (decoded) => {
        if (reading === pending) held = decoded;
      },
      () => {
        if (reading === pending) reading = undefined;
      },
    );
    return pending;
  }
  async function read(id: ConceptId): Promise<ReadResult> {
    assertOpen();
    await acquire();
    try {
      assertOpen();
      const answer = await carrier
        .json(routes.read, { bundleId, documentId: id }, controller.signal, { maximum: HOSTED_READ_BOUNDS.documentBytes, ...(options.binding ? { binding: options.binding } : {}) })
        .catch(carrierFailure);
      if (answer.status !== 200) refused(answer);
      const envelope = answer.body as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
      if (envelope?.ok === false) {
        const code = typeof envelope.error?.code === "string" ? envelope.error.code : "RUNTIME";
        const message = typeof envelope.error?.message === "string" ? envelope.error.message : code;
        if (code === "document_not_found") throw notFound(id);
        if (code === "bundle_not_found" || code === "insufficient_scope") {
          forget();
          throw new RemoteError(message, code, 401);
        }
        if (TRANSIENT_READ_CODES.has(code)) throw new HostedCarrierError("unavailable");
        throw new RemoteError(message, code, 422);
      }
      return decodeDocumentRead(id, bundleId, answer.body);
    } finally {
      release();
    }
  }
  const refuse = (code: HostedReadAdapterError["code"]) => async (): Promise<never> => {
    throw new HostedReadAdapterError(code);
  };
  return {
    signal: controller.signal,
    read,
    readMany: (ids) => Promise.all(ids.map(read)),
    async readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null> {
      if (dir !== "" || name !== "index.md") return null;
      const { root } = await capabilities();
      return root ? { content: root.content, version: root.version } : null;
    },
    hostedCapabilities: capabilities,
    operationsRetentionMs: async () => (await capabilities()).operationsRetentionMs,
    async wireCapabilities() {
      const { heads, snapshot, operations } = await capabilities();
      return { heads, snapshot, operations, history: true, enforced_cas: true, projections: true, backlinks: false, blobs: false };
    },
    async heads(headsOptions = {}) {
      assertOpen();
      const input = { bundleId, ...(headsOptions.ifNoneMatch === undefined ? {} : { ifNoneMatch: headsOptions.ifNoneMatch }) };
      const answer = await carrier.json(routes.heads, input, controller.signal, { maximum: HOSTED_READ_BOUNDS.headsBytes }).catch(carrierFailure);
      if (answer.status !== 200 && answer.status !== 304) refused(answer);
      const rootVersion = decodeRootVersion(answer.headers.get(ROOT_VERSION_HEADER));
      if (rootVersion === undefined) throw malformed("heads answered without the root version");
      if (held && (held.root?.version ?? null) !== rootVersion) forget();
      if (answer.status === 304) {
        if (headsOptions.ifNoneMatch === undefined) throw malformed("heads answered 304 to a request that sent no digest");
        return null;
      }
      return parseHeadsAnswer(answer.body);
    },
    async snapshot() {
      assertOpen();
      const answer = await carrier.stream(routes.snapshot, { bundleId }, controller.signal).catch(carrierFailure);
      if (!answer.ok) refused(answer);
      return readSnapshotStream(boundedLines((answer as { body: ReadableStream<Uint8Array> }).body, HOSTED_READ_BOUNDS.documentBytes), { status: answer.status });
    },
    abort() {
      controller.abort();
      forget();
      for (const wake of waiting.splice(0)) wake();
    },
    // The shared verbs never take these paths against this authority: selection requires heads
    // and snapshot, so the list path cannot run.
    list: refuse("unsupported"),
    exists: refuse("unsupported"),
    versions: refuse("unsupported"),
    readBlob: refuse("unsupported"),
    existsBlob: refuse("unsupported"),
    listBlobs: refuse("unsupported"),
    write: refuse("read_only"),
    writeReserved: refuse("read_only"),
    delete: refuse("read_only"),
    writeBlob: refuse("read_only"),
    deleteBlob: refuse("read_only"),
  };
}
