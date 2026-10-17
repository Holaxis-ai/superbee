/**
 * Per-request timing over the carrier seam: how long each hosted request took on the client, and
 * the host's own accounting of it. A hosted Superbee answers its timed routes with a standard
 * `Server-Timing` header naming the phases it spent (`session`, `authority`, `membership`,
 * `content` and `total`, each phase with its call count as `desc="n=<count>"`). Reading it here,
 * at the seam every client shares, lets the CLI, a standalone app or a benchmark measure the same
 * way without parsing the header itself.
 *
 * Observation only: nothing here changes a request, its answer or its failure, and an observer
 * that throws, or an async one that rejects, is ignored.
 */
import { HostedCarrierError, type HostedCarrier } from "./carrier.js";

/** One `Server-Timing` metric as the host sent it. */
export interface ServerTimingMetric {
  readonly name: string;
  /** The `dur` parameter in milliseconds, when it is a plain non-negative decimal. */
  readonly durationMs?: number;
  /** The `desc` parameter, unquoted. */
  readonly description?: string;
  /** The call count a hosted Superbee states as `desc="n=<count>"`. */
  readonly count?: number;
}

/** The longest `Server-Timing` value read; a longer one yields no metrics. */
export const SERVER_TIMING_MAX_LENGTH = 4096;
/** The most metrics read from one value; later ones are dropped. */
export const SERVER_TIMING_MAX_METRICS = 32;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DURATION = /^\d{1,15}(?:\.\d{1,6})?$/;
const COUNT = /^n=(0|[1-9]\d{0,8})$/;

/**
 * Split `text` at each `separator` outside a quoted string. Returns null when a quoted string is
 * left open, so a value cut short never yields a metric built from half a parameter.
 */
function splitOutsideQuotes(text: string, separator: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) return null;
  parts.push(text.slice(start));
  return parts;
}

/** HTTP optional whitespace (space and horizontal tab) removed from both ends, in one linear pass. */
function trimOws(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === " " || text[start] === "\t")) start++;
  while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(start, end);
}

/** Whether `c` may stand in a quoted string, plain or escaped: tab, space, visible ASCII or obs-text. */
function quotable(c: string): boolean {
  const code = c.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code !== 0x7f && code <= 0xff);
}

/** A parameter value: a token, or a quoted string with its escapes removed. Null when it is neither. */
function paramValue(raw: string): string | null {
  if (TOKEN.test(raw)) return raw;
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    let c = raw[i]!;
    if (c === "\\") {
      i++;
      if (i >= raw.length - 1) return null;
      c = raw[i]!;
    } else if (c === '"') {
      return null;
    }
    if (!quotable(c)) return null;
    out += c;
  }
  return out;
}

/**
 * The metrics of a `Server-Timing` value (W3C Server Timing: comma-separated metrics, each a name
 * with optional `dur` and `desc` parameters). Lenient as browsers are: a malformed metric is
 * skipped, a malformed or repeated parameter is ignored (the first occurrence wins), unknown
 * parameters are ignored. A quoted string left open makes every separator after it ambiguous, so
 * such a value yields no metrics. Bounded: a value longer than {@link SERVER_TIMING_MAX_LENGTH}
 * yields no metrics, and at most {@link SERVER_TIMING_MAX_METRICS} are returned.
 */
export function parseServerTiming(value: string | null | undefined): ServerTimingMetric[] {
  if (typeof value !== "string" || value.length > SERVER_TIMING_MAX_LENGTH) return [];
  const entries = splitOutsideQuotes(value, ",");
  if (entries === null) return [];
  const metrics: ServerTimingMetric[] = [];
  for (const entry of entries) {
    if (metrics.length === SERVER_TIMING_MAX_METRICS) break;
    const parts = splitOutsideQuotes(entry, ";");
    if (parts === null) continue;
    const name = trimOws(parts[0]!);
    if (!TOKEN.test(name)) continue;
    let durationMs: number | undefined;
    let description: string | undefined;
    const seen = new Set<string>();
    for (const part of parts.slice(1)) {
      const equals = part.indexOf("=");
      if (equals < 0) continue;
      const key = trimOws(part.slice(0, equals)).toLowerCase();
      if (!TOKEN.test(key) || seen.has(key)) continue;
      seen.add(key);
      const parsed = paramValue(trimOws(part.slice(equals + 1)));
      if (parsed === null) continue;
      if (key === "dur" && DURATION.test(parsed)) durationMs = Number(parsed);
      else if (key === "desc") description = parsed;
    }
    const count = description === undefined ? undefined : COUNT.exec(description)?.[1];
    metrics.push({
      name,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(count !== undefined ? { count: Number(count) } : {}),
    });
  }
  return metrics;
}

/** Which carrier method sent the request. */
export type HostedRequestKind = "json" | "bytes" | "stream";

/** One request's timing, reported once it is answered or has failed. */
export interface HostedRequestTiming {
  /** The route as the carrier was asked for it, such as `/sync/v1/replace`. */
  readonly route: string;
  readonly kind: HostedRequestKind;
  /** The answer's HTTP status; null when the request failed without one. */
  readonly status: number | null;
  /**
   * Why the request has no answer: the carrier's `denied` (nothing was sent) or `unavailable` (it
   * may have left), or `error` for anything else the carrier threw. Null when it was answered.
   */
  readonly failure: "denied" | "unavailable" | "error" | null;
  /**
   * Milliseconds from asking the carrier until it returned. For `json` and `bytes` that includes
   * the whole bounded body. For a `stream` it ends at the headers of a `2xx`, before the body is
   * read, and after the bounded refusal body otherwise.
   */
  readonly wallMs: number;
  /** The host's accounting from the answer's `Server-Timing` header; empty when it sent none. */
  readonly server: readonly ServerTimingMetric[];
}

/**
 * Receives each request's timing. Called synchronously as the request settles, so keep it cheap.
 * Its result is ignored: a throw changes nothing, and neither does a returned promise (an async
 * observer) that rejects.
 */
export type HostedRequestObserver = (timing: HostedRequestTiming) => void;

/**
 * `carrier`, reporting each request's {@link HostedRequestTiming} to `observe`. Requests, answers
 * and failures pass through unchanged. Every observation step (the clock, reading the answer,
 * the observer and any promise it returns) is guarded: a step that fails drops that report and
 * nothing else. `now` is a monotonic millisecond clock (default `performance.now`).
 */
export function observedCarrier(carrier: HostedCarrier, observe: HostedRequestObserver, now: () => number = () => performance.now()): HostedCarrier {
  /** Build one report and hand it over; nothing that fails here reaches the request. */
  const report = (build: () => HostedRequestTiming) => {
    try {
      const result: unknown = observe(build());
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") Promise.resolve(result).catch(() => {});
    } catch {
      // Observation never changes the request it describes.
    }
  };
  const read = (): number | undefined => {
    try {
      const time = now();
      return Number.isFinite(time) ? time : undefined;
    } catch {
      return undefined;
    }
  };
  const since = (started: number | undefined): number => {
    const ended = read();
    if (started === undefined || ended === undefined) throw new Error("no clock reading");
    return Math.max(0, ended - started);
  };

  async function timed<T extends { status: number; headers: Headers }>(route: string, kind: HostedRequestKind, send: () => Promise<T>): Promise<T> {
    const started = read();
    let answer: T;
    try {
      answer = await send();
    } catch (error) {
      report(() => ({ route, kind, status: null, failure: error instanceof HostedCarrierError ? error.code : "error", wallMs: since(started), server: [] }));
      throw error;
    }
    report(() => {
      const wallMs = since(started);
      let server: ServerTimingMetric[] = [];
      try {
        server = parseServerTiming(answer.headers.get("server-timing"));
      } catch {
        // Headers that cannot be read lose only the host's accounting.
      }
      return { route, kind, status: answer.status, failure: null, wallMs, server };
    });
    return answer;
  }

  const bytes = carrier.bytes?.bind(carrier);
  return {
    json: (route, input, signal, options) => timed(route, "json", () => carrier.json(route, input, signal, options)),
    stream: (route, input, signal) => timed(route, "stream", () => carrier.stream(route, input, signal)),
    ...(bytes ? { bytes: (route: string, body: Uint8Array, signal: AbortSignal, options: Parameters<NonNullable<HostedCarrier["bytes"]>>[3]) => timed(route, "bytes", () => bytes(route, body, signal, options)) } : {}),
  };
}
