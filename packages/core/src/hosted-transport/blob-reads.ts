/** Ordinary opaque-file reads over the supplied hosted carrier. Metadata is published only
 * after a whole consistent listing; bytes only after their length, digest and exact MIME pin
 * are verified. This adapter neither changes the document reader nor supplies credentials. */
import { assertSafeBlobKey, compareStorageKeys } from "../paths.js";
import { resolveContentType } from "../content-type.js";
import { sha256HexOfBytes, sha256HexOfUtf8 } from "../sha256.js";
import { isContentVersion } from "../version-transport.js";
import { malformed, onRoute, RemoteError } from "../remote-error.js";
import { HostedAnswerTooLarge, HostedCarrierError, type HostedCarrier } from "./carrier.js";
import { HostedReadAdapterError, readRefusal, type HostedCapabilities } from "./read-adapter.js";
import { HEADS_PAGE_ATTEMPTS, isPageRestart, pageRestartDelay, pause } from "./paged-reads.js";

export interface HostedBlobHead {
  readonly key: string;
  readonly version: string;
  readonly contentType: string;
}
export interface HostedBlobHeads {
  readonly bundleId: string;
  readonly revision: number;
  readonly digest: string;
  readonly heads: readonly HostedBlobHead[];
}
export interface HostedBlobRead extends HostedBlobHead {
  readonly bytes: Uint8Array;
}
export interface HostedBlobReadAdapterOptions {
  readonly carrier: HostedCarrier;
  readonly bundleId: string;
  readonly prefix?: string;
  /** The caller owns this adapter's lifetime, as it owns its carrier and capability cache. */
  readonly signal: AbortSignal;
  readonly capabilities: () => Promise<HostedCapabilities>;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface HostedBlobReadAdapter {
  heads(): Promise<HostedBlobHeads>;
  read(pin: HostedBlobHead): Promise<HostedBlobRead>;
}

export const HOSTED_BLOB_READ_BOUNDS = Object.freeze({
  bytes: 16 * 1024 * 1024,
  heads: 10000,
  headsPerPage: 1000,
  // Even maximally escaped legal keys and MIME values in a full page fit within this bound.
  headsPageBytes: 4 * 1024 * 1024,
  cursorChars: 1024,
});

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function head(value: unknown): HostedBlobHead {
  if (!record(value) || !only(value, ["key", "version", "contentType"]) || typeof value.key !== "string" || !isContentVersion(value.version) ||
      typeof value.contentType !== "string" || value.contentType.length === 0 || value.contentType.length > 1024 ||
      !/^[\x20-\x7e]+$/.test(value.contentType) || value.contentType !== value.contentType.trim() ||
      resolveContentType(value.key, value.contentType) !== value.contentType) throw malformed("malformed blob head");
  try { assertSafeBlobKey(value.key); } catch { throw malformed("unsafe blob key"); }
  const encoded = new TextEncoder().encode(value.key);
  if (encoded.length > 512 || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== value.key) throw malformed("unrepresentable blob key");
  return Object.freeze({ key: value.key, version: value.version, contentType: value.contentType });
}
function tooLarge(maximum: number): HostedCarrierError {
  return new HostedCarrierError("unavailable", { cause: new HostedAnswerTooLarge(maximum) });
}

export function createHostedBlobReadAdapter(options: HostedBlobReadAdapterOptions): HostedBlobReadAdapter {
  const { carrier, bundleId, signal, capabilities } = options;
  const prefix = options.prefix ?? "/sync/v1";
  const headsRoute = `${prefix}/blob-heads`, readRoute = `${prefix}/blob-read`;
  const assertOpen = () => { if (signal.aborted) throw new HostedCarrierError("unavailable"); };
  /** Race even caller-supplied ports: abort must not depend on their cooperation. */
  function active<T>(work: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    assertOpen();
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new HostedCarrierError("unavailable"));
      signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => { assertOpen(); return work(); }).then(value => {
        if (signal.aborted) { discard?.(value); aborted(); } else resolve(value);
      }, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }
  async function admitted(): Promise<number> {
    const caps = await active(capabilities);
    assertOpen();
    if (caps.blobReads !== "allowed" || !Number.isSafeInteger(caps.blobReadBytes) || !(caps.blobReadBytes! > 0)) throw new HostedReadAdapterError("unsupported");
    return Math.min(caps.blobReadBytes!, HOSTED_BLOB_READ_BOUNDS.bytes);
  }
  function carrierFailure(error: unknown): never {
    if (error instanceof HostedCarrierError && error.code === "denied") throw new RemoteError("no credential for the host", "AUTH_REQUIRED", 401, error);
    throw error;
  }
  async function listing(): Promise<HostedBlobHeads> {
    const heads: HostedBlobHead[] = [], cursors = new Set<string>();
    let cursor: string | undefined, revision: number | undefined, digest: string | undefined, total: number | undefined;
    for (;;) {
      const answer = await active(() => carrier.json(headsRoute, { bundleId, ...(cursor === undefined ? {} : { cursor }) }, signal, { maximum: HOSTED_BLOB_READ_BOUNDS.headsPageBytes })).catch(carrierFailure);
      assertOpen();
      if (answer.status !== 200) throw readRefusal(answer);
      const page = answer.body;
      if (!record(page) || !only(page, ["schemaVersion", "bundleId", "revision", "digest", "total", "heads", "next"]) ||
          page.schemaVersion !== 1 || page.bundleId !== bundleId || !whole(page.revision) || !isContentVersion(page.digest) ||
          !whole(page.total) || page.total > HOSTED_BLOB_READ_BOUNDS.heads || !Array.isArray(page.heads) || page.heads.length > HOSTED_BLOB_READ_BOUNDS.headsPerPage ||
          !(page.next === null || typeof page.next === "string" && page.next.length > 0 && page.next.length <= HOSTED_BLOB_READ_BOUNDS.cursorChars)) throw malformed("malformed blob heads page");
      if (revision !== undefined && (revision !== page.revision || digest !== page.digest || total !== page.total)) throw malformed("mixed blob heads pages");
      revision = page.revision; digest = page.digest; total = page.total;
      for (const raw of page.heads) {
        const entry = head(raw), previous = heads.at(-1);
        if (previous && compareStorageKeys(previous.key, entry.key) >= 0) throw malformed("blob heads are not strictly ordered");
        heads.push(entry);
      }
      if (heads.length > total || page.heads.length === 0 && (total !== 0 || cursor !== undefined || page.next !== null)) throw malformed("blob heads page made no progress");
      if (page.next === null) {
        if (heads.length !== total || digest !== `sha256:${sha256HexOfUtf8(JSON.stringify([revision, heads.map(entry => [entry.key, entry.version, entry.contentType])]))}`) throw malformed("blob heads count or digest mismatch");
        return Object.freeze({ bundleId, revision, digest, heads: Object.freeze(heads) });
      }
      if (heads.length >= total || cursors.has(page.next)) throw malformed("blob heads cursor made no progress");
      cursors.add(page.next); cursor = page.next;
    }
  }
  return {
    async heads() {
      await admitted();
      return onRoute(headsRoute, async () => {
        for (let attempt = 1; ; attempt += 1) {
          try { return await listing(); } catch (error) {
            if (attempt >= HEADS_PAGE_ATTEMPTS || !isPageRestart(error)) throw error;
            await active(() => (options.sleep ?? pause)(pageRestartDelay(attempt), signal));
          }
        }
      });
    },
    async read(pin) {
      // Copy before any await so caller mutation cannot change the request or its expectations.
      const expected = head(pin);
      const maximum = await admitted();
      return onRoute(readRoute, async () => {
        // An uncooperative port may answer after abort. It still must not leave an open body.
        const answer = await active(() => carrier.stream(readRoute, { bundleId, ...expected }, signal), answer => {
          if (answer.ok) void answer.body.cancel().catch(() => {});
        }).catch(carrierFailure);
        if (!answer.ok) throw readRefusal(answer);
        const reader = answer.body.getReader();
        let complete = false;
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          assertOpen();
          const lengthText = answer.headers.get("content-length");
          if (answer.status !== 200 || answer.headers.get("content-type") !== "application/octet-stream" ||
              answer.headers.get("x-superbee-blob-version") !== expected.version || answer.headers.get("x-superbee-content-type") !== expected.contentType ||
              lengthText === null || !/^(0|[1-9][0-9]*)$/.test(lengthText) || !whole(Number(lengthText))) throw malformed("blob read headers do not match the pin");
          const length = Number(lengthText);
          if (length > maximum) throw tooLarge(maximum);
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (;;) {
            const chunk = await active(() => reader.read());
            assertOpen();
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array)) throw malformed("blob read yielded non-byte content");
            if (chunk.value.byteLength > maximum - offset) throw tooLarge(maximum);
            if (chunk.value.byteLength > length - offset) throw malformed("blob read exceeded its stated length");
            bytes.set(chunk.value, offset); offset += chunk.value.byteLength;
          }
          if (offset !== length || `sha256:${sha256HexOfBytes(bytes)}` !== expected.version) throw malformed("blob read length or digest mismatch");
          complete = true;
          return Object.freeze({ ...expected, bytes });
        } finally {
          signal.removeEventListener("abort", cancel);
          if (!complete) cancel();
          reader.releaseLock();
        }
      });
    },
  };
}
