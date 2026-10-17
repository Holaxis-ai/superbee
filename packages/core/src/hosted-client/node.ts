/**
 * `@superbee/core/hosted-client/node`: the hosted client's Node-only half, a supported public API
 * under core's normal versioning. It downloads a hosted bundle's portable export
 * (`<prefix>/export`) and verifies it with `@superbee/core/portable-export`, whose digests and
 * file placement need Node, so it is kept off the browser-safe `@superbee/core/hosted-client`.
 *
 * The result is a verified export or a typed failure, never files: a stopped, tampered or
 * oversized export is refused before anything is returned, and placing the verified entries is
 * the caller's (`materializeExport`, or its own staging).
 */
import {
  ExportArchiveError,
  ExportPageChain,
  MAX_EXPORT_BYTES,
  verifyExport,
  type VerifiedExport,
} from "../portable-export.js";
import { RemoteError } from "../remote-error.js";
import type { HostedClient } from "./client.js";
import { HostedRouteNotServed } from "./errors.js";

export { ExportArchiveError, MAX_EXPORT_BYTES, type VerifiedExport } from "../portable-export.js";

/**
 * The host's export window: an export (or one page of a paged one) is answered within 60 s. A
 * client that downloads exports should be created with at least this `deadlineMs`; the default
 * 15 s read deadline would cut a large bundle.
 */
export const EXPORT_WINDOW_MS = 60_000;

/** How many times a paged export starts again from its first page when the bundle moves under it. */
const PAGED_EXPORT_ATTEMPTS = 3;
/** The pause before each restart, so a burst of writes can settle (with jitter). */
const PAGED_EXPORT_RESTART_MS: readonly number[] = [500, 1500];
/** The pause before asking for a page again after a busy host or a page it stopped part way. */
const PAGE_RETRY_MS = 1000;

/**
 * Why a download was refused, apart from the host's refusals and the verifier's:
 * `stopped` — the answer's body failed part way (the network, or the carrier's idle deadline), so
 * the same request may succeed; `too_large` — the answer ran past what an export carries
 * ({@link MAX_EXPORT_BYTES} in all); `source_changed` — the bundle kept changing between the pages
 * of a paged export, every attempt.
 */
export type HostedExportProblem = "stopped" | "too_large" | "source_changed";

export class HostedExportError extends Error {
  override readonly name = "HostedExportError";
  readonly problem: HostedExportProblem;
  readonly bundleId: string;
  /** With `too_large`: the bound the answer ran past, in bytes. */
  readonly maximum?: number;
  constructor(problem: HostedExportProblem, bundleId: string, message: string, options: { cause?: unknown; maximum?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.problem = problem;
    this.bundleId = bundleId;
    if (options.maximum !== undefined) this.maximum = options.maximum;
  }
}

/** True when `error` is a {@link HostedExportError}, with `problem` when one is named. */
export function isHostedExportError(error: unknown, problem?: HostedExportProblem): error is HostedExportError {
  return error instanceof HostedExportError && (problem === undefined || error.problem === problem);
}

export interface DownloadExportOptions {
  /** Aborting it stops the download; it is thrown as the signal's reason. The client's own signal applies too. */
  readonly signal?: AbortSignal;
}

/** What a download needs of a client: its carrier, its sync prefix and its signal. A `within` client qualifies the bundle. */
export type HostedExportClient = Pick<HostedClient, "carrier" | "prefix" | "signal">;

/**
 * The verified portable export of `bundleId` at its latest confirmed revision: every document,
 * reserved file and blob, byte for byte, read whole and checked against the host's digest
 * manifests before it is returned.
 *
 * A host that pages the export answers it a page at a time; each page is verified as it arrives,
 * checked against the pages before it, and the pages are joined (`ExportPageChain`). A host from
 * before paging refuses the paged request as `invalid_input`, and the whole bundle is then read as
 * one archive. A bundle that changes between pages (`concurrent_change`) is read again from its
 * first page, up to three attempts. A page the host was too busy for (`backend_unavailable`, its
 * one export slot) or stopped part way is asked for once more.
 *
 * Failures are typed:
 * - `HostedCarrierError` — transport (the request may not have been answered);
 * - `HostedRouteNotServed` — a host from before the export route;
 * - `RemoteError` — the host's refusal, with its code and status (`bundle_not_found`,
 *   `result_too_large`, `validation_failed`, `unauthenticated` and so on);
 * - `ExportArchiveError` — the verifier refused the archive (`incomplete` when the host stopped it);
 * - {@link HostedExportError} — the answer stopped part way, ran past {@link MAX_EXPORT_BYTES}, or
 *   the bundle kept changing;
 * - the signal's reason, once `options.signal` or the client's signal aborts.
 */
export async function downloadExport(client: HostedExportClient, bundleId: string, options: DownloadExportOptions = {}): Promise<VerifiedExport> {
  if (typeof bundleId !== "string" || bundleId === "") throw new TypeError("an export names its bundle");
  const signal = options.signal ? AbortSignal.any([client.signal, options.signal]) : client.signal;
  const download: Download = { client, bundleId, signal, route: `${client.prefix}/export` };
  signal.throwIfAborted();
  for (let attempt = 1; ; attempt += 1) {
    const chain = new ExportPageChain();
    let bytes = 0;
    let cursor: string | undefined;
    let moved = false;
    for (;;) {
      let page: VerifiedExport | undefined;
      for (let tries = 1; page === undefined; tries += 1) {
        const answer = await exportAnswer(download, { bundleId, paged: true, ...(cursor !== undefined ? { cursor } : {}) });
        // Only the very first request can meet a host from before paging.
        if (answer.refused === "invalid_input" && cursor === undefined && attempt === 1) return await wholeExport(download);
        if (answer.refused === "concurrent_change") {
          moved = true;
          break;
        }
        try {
          if (answer.refused !== undefined) throw refusal(download, answer);
          page = verifyExport(await readArchive(download, answer.ok, MAX_EXPORT_BYTES - bytes), bundleId, { paged: true });
        } catch (error) {
          signal.throwIfAborted();
          const again =
            isHostedExportError(error, "stopped") ||
            (error instanceof ExportArchiveError && error.problem === "incomplete") ||
            (answer.refused === "backend_unavailable" && answer.status >= 500);
          if (!again || tries >= 2) throw error;
          await pause(PAGE_RETRY_MS, signal);
        }
      }
      if (moved) break;
      bytes += page!.bytes;
      cursor = chain.add(page!);
      if (cursor === undefined) return chain.joined();
    }
    if (attempt >= PAGED_EXPORT_ATTEMPTS) {
      throw new HostedExportError("source_changed", bundleId, `'${bundleId}' kept changing while it was exported (${attempt} attempts)`);
    }
    const base = PAGED_EXPORT_RESTART_MS[attempt - 1]!;
    await pause(Math.round(base / 2 + (Math.random() * base) / 2), signal);
  }
}

interface Download {
  readonly client: HostedExportClient;
  readonly bundleId: string;
  readonly signal: AbortSignal;
  readonly route: string;
}

type ExportAnswer =
  | { readonly ok: ReadableStream<Uint8Array>; readonly refused?: undefined; readonly status?: undefined; readonly body?: undefined }
  | { readonly ok?: undefined; readonly refused: string; readonly status: number; readonly body: unknown };

/** One export request's answer: the archive's body, or the refusal code the host answered. */
async function exportAnswer({ client, signal, route }: Download, input: Record<string, unknown>): Promise<ExportAnswer> {
  signal.throwIfAborted();
  let answer;
  try {
    answer = await client.carrier.stream(route, input, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
  if (!answer.ok) return { refused: refusalCode(answer.body) ?? "RUNTIME", status: answer.status, body: answer.body };
  return { ok: answer.body };
}

/** The whole bundle as one archive (a host from before paged export). */
async function wholeExport(download: Download): Promise<VerifiedExport> {
  const answer = await exportAnswer(download, { bundleId: download.bundleId });
  if (answer.refused !== undefined) throw refusal(download, answer);
  return verifyExport(await readArchive(download, answer.ok, MAX_EXPORT_BYTES), download.bundleId);
}

function refusalCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === "string") return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The typed error a refused export is: the family's unknown-route answer, or the host's refusal. */
function refusal({ route }: Download, answer: { readonly refused: string; readonly status: number; readonly body: unknown }): RemoteError {
  if (answer.status === 404 && isUnknownRoute(answer.body)) return new HostedRouteNotServed(route);
  return new RemoteError(`hosted export answered ${answer.status}`, answer.refused, answer.status);
}

/** The sync family's answer to a route it does not have: `404 {"error":"not_found"}`, nothing else. */
function isUnknownRoute(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && (body as { error?: unknown }).error === "not_found";
}

/** One archive's body, read whole and bounded by `budget` (what the export may still hold). */
async function readArchive({ bundleId, signal }: Download, body: ReadableStream<Uint8Array>, budget: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      let part: Awaited<ReturnType<typeof reader.read>>;
      try {
        part = await reader.read();
      } catch (cause) {
        signal.throwIfAborted();
        throw new HostedExportError("stopped", bundleId, `the export of '${bundleId}' stopped part way`, { cause });
      }
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > budget) {
        throw new HostedExportError("too_large", bundleId, `the export of '${bundleId}' is larger than ${MAX_EXPORT_BYTES} bytes`, { maximum: MAX_EXPORT_BYTES });
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

/** A pause the signal cuts short (its reason thrown), leaving no timer behind either way. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
