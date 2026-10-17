/** One identified blob delivery or outcome lookup through the caller's carrier. This wire
 * adapter preserves typed evidence; it never resends, reads a current head, or interprets an
 * absent outcome as permission to deliver again. Client journaling and recovery live elsewhere. */
import { assertSafeBlobKey } from "../paths.js";
import { isHostedBundleId } from "../dependencies.js";
import { resolveContentType } from "../content-type.js";
import { isContentVersion } from "../version-transport.js";
import { sha256HexOfBytes } from "../sha256.js";
import {
  isAgentLabelVia, isAcceptedDeletionCount, HostedCarrierError,
  type HostedCarrier, type HostedRequestOptions,
} from "./carrier.js";
import {
  classifyBlobWriteAnswer, decodeBlobOutcomeAnswer, HostedOutcomeError, updateRow,
  type BlobWriteExpected, type BlobWriteResult, type BlobOutcomeAnswer, type UpdateAnswerRow,
} from "./answer-rows.js";
import { HostedReadAdapterError, type HostedCapabilities } from "./read-adapter.js";

export interface HostedBlobWriteIdentity {
  readonly requestId: string;
  readonly binding: string;
  readonly via?: string;
  /** A person's confirmation of the deletion count; admission only, sent on delete, never lookup. */
  readonly acceptDeletes?: number;
}
export interface BlobSendAnswer {
  /** Null when the carrier failed or the call was aborted without usable answer evidence. */
  readonly status: number | null;
  readonly row: UpdateAnswerRow;
  readonly result?: BlobWriteResult;
  /** An exact request-id marker accompanying valid terminal evidence that its row admits.
   * False does not override the row: successful/recorded rows retain their original meaning. */
  readonly settled: boolean;
}
export interface HostedBlobWriteAdapterOptions {
  readonly carrier: HostedCarrier;
  /** Bare portable bundle id. A supplied scoped carrier owns workspace qualification. */
  readonly bundleId: string;
  readonly prefix?: string;
  readonly signal: AbortSignal;
  readonly capabilities: () => Promise<HostedCapabilities>;
}
export interface HostedBlobWriteAdapter {
  send(intent: BlobWriteExpected, identity: HostedBlobWriteIdentity, bytes?: Uint8Array): Promise<BlobSendAnswer>;
  /** Returns explicit absence, never null or resend permission. Failed evidence rejects. */
  lookup(intent: BlobWriteExpected, identity: HostedBlobWriteIdentity): Promise<BlobOutcomeAnswer>;
}
const MAXIMUM_BLOB_BYTES = 16 * 1024 * 1024;
const ANSWER_BYTES = 64 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const mime = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value) && value === value.trim() && resolveContentType("blob", value) === value;
function snapshot(intent: BlobWriteExpected, identity: HostedBlobWriteIdentity): { intent: BlobWriteExpected; identity: HostedBlobWriteIdentity; keyHeader: string } {
  if (!record(intent) || !record(identity)) throw new TypeError("blob intent and identity must be objects");
  const copied = { ...intent }, id = { ...identity };
  const deletion = copied.operationId === "blobs.delete.v1";
  if (!["blobs.create.v1", "blobs.replace.v1", "blobs.delete.v1"].includes(copied.operationId) ||
      !only(copied, deletion ? ["operationId", "key", "expectedVersion", "expectedContentType"] : ["operationId", "key", "expectedVersion", "expectedContentType", "version", "contentType"])) throw new TypeError("unsupported blob intent");
  try { assertSafeBlobKey(copied.key); } catch { throw new TypeError("unsafe blob key"); }
  const keyBytes = new TextEncoder().encode(copied.key);
  if (keyBytes.length > 512 || new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(keyBytes) !== copied.key) throw new TypeError("unrepresentable blob key");
  if (copied.operationId === "blobs.create.v1" ? copied.expectedVersion !== null || copied.expectedContentType !== null : !isContentVersion(copied.expectedVersion) || !mime(copied.expectedContentType)) throw new TypeError("blob preconditions are required");
  if (copied.operationId !== "blobs.delete.v1" && (!isContentVersion(copied.version) || !mime(copied.contentType))) throw new TypeError("blob replacement pins are required");
  if (!only(id, ["requestId", "binding", "via", "acceptDeletes"]) || typeof id.requestId !== "string" || !UUID_V4.test(id.requestId) || !isContentVersion(id.binding) ||
      id.via !== undefined && !isAgentLabelVia(id.via) || id.acceptDeletes !== undefined && (!deletion || !isAcceptedDeletionCount(id.acceptDeletes))) throw new TypeError("invalid blob write identity");
  let binaryKey = "";
  for (const byte of keyBytes) binaryKey += String.fromCharCode(byte);
  return { intent: Object.freeze(copied), identity: Object.freeze(id), keyHeader: btoa(binaryKey).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") };
}
function immutable<T extends BlobWriteResult>(result: T): T {
  Object.freeze(result.ok ? result.data : result.error);
  return Object.freeze(result);
}

export function createHostedBlobWriteAdapter(options: HostedBlobWriteAdapterOptions): HostedBlobWriteAdapter {
  const { carrier, bundleId, signal, capabilities } = options;
  const prefix = options.prefix ?? "/sync/v1";
  if (typeof bundleId !== "string" || !isHostedBundleId(bundleId)) throw new TypeError("a bare hosted bundle id is required");
  const assertOpen = () => { if (signal.aborted) throw new HostedCarrierError("unavailable"); };
  function active<T>(work: () => Promise<T>): Promise<T> {
    assertOpen();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new HostedCarrierError("unavailable"));
      signal.addEventListener("abort", abort, {once: true});
      Promise.resolve().then(() => {assertOpen(); return work();}).then(value => {
        if (signal.aborted) abort(); else resolve(value);
      }, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async function admitted(): Promise<number> {
    const caps = await active(capabilities);
    assertOpen();
    if (caps.blobWrites !== "allowed" || !Number.isSafeInteger(caps.blobWriteBytes) || !(caps.blobWriteBytes! > 0)) throw new HostedReadAdapterError("unsupported");
    return Math.min(caps.blobWriteBytes!, MAXIMUM_BLOB_BYTES);
  }
  const headers = (id: HostedBlobWriteIdentity, deletion = false): HostedRequestOptions => ({maximum: ANSWER_BYTES, writeRequest: id.requestId, binding: id.binding, ...(id.via === undefined ? {} : {via: id.via}), ...(deletion && id.acceptDeletes !== undefined ? {acceptDeletes: id.acceptDeletes} : {})});
  return {
    async send(rawIntent, rawIdentity, rawBytes) {
      const {intent, identity, keyHeader} = snapshot(rawIntent, rawIdentity);
      const deletion = intent.operationId === "blobs.delete.v1";
      if (deletion ? rawBytes !== undefined : !(rawBytes instanceof Uint8Array)) throw new TypeError("only blob create/replace carry bytes");
      if (rawBytes && rawBytes.byteLength > MAXIMUM_BLOB_BYTES) throw new TypeError("blob bytes exceed the write bound");
      const bytes = rawBytes === undefined ? undefined : new Uint8Array(rawBytes);
      if (bytes && (bytes.byteLength > MAXIMUM_BLOB_BYTES || intent.operationId === "blobs.delete.v1" || `sha256:${sha256HexOfBytes(bytes)}` !== intent.version)) throw new TypeError("blob bytes do not match the retained digest or bound");
      const maximum = await admitted();
      if (bytes && bytes.byteLength > maximum) throw new TypeError("blob bytes exceed the advertised write bound");
      if (!deletion && !carrier.bytes) throw new HostedReadAdapterError("unsupported");
      try {
        const answer = await active(() => {
          if (intent.operationId === "blobs.delete.v1") return carrier.json(`${prefix}/blob-delete`, {bundleId, ...intent}, signal, headers(identity, true));
          return carrier.bytes!(`${prefix}/${intent.operationId === "blobs.create.v1" ? "blob-create" : "blob-replace"}`, bytes!, signal, {
            ...headers(identity), headers: {
              "X-Superbee-Bundle": bundleId, "X-Superbee-Blob-Key": keyHeader,
              "X-Superbee-Blob-Version": intent.version, "X-Superbee-Content-Type": intent.contentType,
              ...(intent.operationId === "blobs.create.v1" ? {} : {"X-Superbee-Expected-Version": intent.expectedVersion, "X-Superbee-Expected-Content-Type": intent.expectedContentType}),
            },
          });
        });
        const {row, result} = classifyBlobWriteAnswer(answer, intent);
        const settled = answer.headers.get("X-Superbee-Write-Settled") === identity.requestId && result !== undefined &&
          (row.recorded === "yes" || row.recorded === "settled-only") && (result.ok || result.error.writeState === "not_applied");
        return Object.freeze({status: answer.status, row, ...(result === undefined ? {} : {result: immutable(result)}), settled});
      } catch {
        return Object.freeze({status: null, row: updateRow("carrier"), settled: false});
      }
    },
    async lookup(rawIntent, rawIdentity) {
      const {intent, identity} = snapshot(rawIntent, rawIdentity);
      await admitted();
      let answer;
      try { answer = await active(() => carrier.json(`${prefix}/outcome`, {bundleId, ...intent}, signal, headers(identity))); }
      catch { throw new HostedOutcomeError("unavailable"); }
      if (answer.status !== 200) throw new HostedOutcomeError("refused", answer.status);
      const decoded = decodeBlobOutcomeAnswer(answer.body, {...intent, requestId: identity.requestId, binding: identity.binding});
      if (decoded.status !== "absent") immutable(decoded.result);
      return Object.freeze(decoded);
    },
  };
}
