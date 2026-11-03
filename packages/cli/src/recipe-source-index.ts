// The CLI acquisition adapter for a published recipe index. Core owns the index format, the byte
// and source pins, and UTF-8 decoding; this module only supplies raw bytes, from a local path or an
// HTTPS URL, under per-read caps, one deadline and one byte budget for the whole acquisition.
// Nothing here is persisted: the index is named per command.
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseRecipeIndex,
  type RecipeIndex,
  type RecipeIndexReader,
} from "@superbee/core/recipe-sources";
import { CliError } from "./errors.js";
import { readExternalFileBytesNoFollowWithin } from "./external-file.js";
import { cliInvocation } from "./invocation.js";

export interface RecipeIndexLimits {
  /** Cap on the index document itself. */
  indexBytes: number;
  /** Cap on each listed file. */
  fileBytes: number;
  /** Budget across the index and every file one command reads. */
  totalBytes: number;
  /** Cap on each HTTPS request. */
  requestMs: number;
  /** One deadline across every read one command makes. */
  deadlineMs: number;
}

export const RECIPE_INDEX_LIMITS: Readonly<RecipeIndexLimits> = Object.freeze({
  indexBytes: 1024 * 1024,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  requestMs: 15_000,
  deadlineMs: 60_000,
});

export type FetchLike = (input: string, init: { redirect: "error"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  body: ReadableStream<Uint8Array> | null;
}>;

/**
 * A failed read. `publisher` failures (a missing file, an HTTP 4xx, an escape, a budget overrun) do
 * not change on retry; `transient` ones (timeouts, network errors, 5xx) may.
 */
export class IndexReadFailure extends Error {
  readonly kind: "publisher" | "transient";
  constructor(kind: "publisher" | "transient", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface RecipeIndexAcquisition {
  index: RecipeIndex;
  /** The index location as given, for receipts. */
  location: string;
  read: RecipeIndexReader;
  /** A private-state boundary refusal raised by a file read, which must surface unchanged. */
  boundaryRefusal(): CliError | undefined;
  /** The most recent read failure, so the caller can classify `RECIPE_INDEX_READ_FAILED`. */
  lastFailure(): IndexReadFailure | undefined;
}

export interface RecipeIndexDeps {
  fetch?: FetchLike;
  home?: string;
  limits?: Partial<RecipeIndexLimits>;
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function indexUsage(message: string, reason: string): CliError {
  return new CliError("USAGE", message, { details: { reason }, help: `${cliInvocation()} recipe add --help` });
}

/** A URL is anything with a scheme other than a one-letter Windows drive; only https is accepted. */
function indexUrl(raw: string): URL | null {
  const scheme = SCHEME.exec(raw)?.[1];
  if (!scheme || (scheme.length === 1 && /^[A-Za-z]:[\\/]/.test(raw))) return null;
  if (scheme.toLowerCase() !== "https") {
    throw indexUsage(`--index accepts a local path or an https: URL; '${scheme}:' is refused`, "RECIPE_INDEX_SCHEME_REFUSED");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw indexUsage("the --index value is not a valid URL", "RECIPE_INDEX_SCHEME_REFUSED");
  }
  // Refused before any request, and never echoed: the value may be a secret.
  if (url.username !== "" || url.password !== "") {
    throw indexUsage("an --index URL must not carry a username or password", "RECIPE_INDEX_SCHEME_REFUSED");
  }
  return url;
}

/** One deadline and one byte budget shared by every read of one acquisition. */
class ReadBudget {
  private remaining: number;
  private readonly deadline: number;
  private readonly limits: RecipeIndexLimits;
  constructor(limits: RecipeIndexLimits) {
    this.limits = limits;
    this.remaining = limits.totalBytes;
    this.deadline = Date.now() + limits.deadlineMs;
  }
  timeLeft(): number {
    const left = this.deadline - Date.now();
    if (left <= 0) throw new IndexReadFailure("transient", `the ${this.limits.deadlineMs} ms deadline for reading the index passed`);
    return left;
  }
  /** The cap for one read: its own cap, or what is left of the budget when that is smaller. */
  cap(own: number): { max: number; budgetBound: boolean } {
    return this.remaining < own ? { max: this.remaining, budgetBound: true } : { max: own, budgetBound: false };
  }
  oversize(own: number, budgetBound: boolean): IndexReadFailure {
    return new IndexReadFailure("publisher", budgetBound
      ? `the index and its files exceed the ${this.limits.totalBytes} byte total`
      : `exceeds ${own} bytes`);
  }
  spend(bytes: number): void {
    this.remaining -= bytes;
  }
}

/** Fetches one https resource as raw bytes, refusing redirects, non-200 answers and oversize bodies. */
export async function fetchHttpsBytes(url: URL, fetchImpl: FetchLike, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  if (url.protocol !== "https:") throw new IndexReadFailure("publisher", "refused a non-https URL");
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url.href, { redirect: "error", signal, headers: { accept: "application/json, text/markdown, text/plain" } });
  } catch (error) {
    throw new IndexReadFailure("transient", signal.aborted ? `timed out after ${timeoutMs} ms` : `request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status !== 200) {
    throw new IndexReadFailure(response.status >= 500 ? "transient" : "publisher", `answered HTTP ${response.status}`);
  }
  if (!response.body) throw new IndexReadFailure("publisher", "answered with no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new IndexReadFailure("publisher", `exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof IndexReadFailure) throw error;
    throw new IndexReadFailure("transient", signal.aborted ? `timed out after ${timeoutMs} ms` : "the response body failed");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reads and parses the index named by `--index`, and returns a reader scoped to its location. */
export async function acquireRecipeIndex(raw: string, deps: RecipeIndexDeps = {}): Promise<RecipeIndexAcquisition> {
  const limits: RecipeIndexLimits = { ...RECIPE_INDEX_LIMITS, ...deps.limits };
  const budget = new ReadBudget(limits);
  const url = indexUrl(raw);
  let boundary: CliError | undefined;
  let failure: IndexReadFailure | undefined;
  let fetchOne: (own: number, target: URL | string) => Promise<Uint8Array>;

  if (url) {
    const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    fetchOne = async (own, target) => {
      const location = target as URL;
      // Index paths are plain relative segments, so this holds; checked anyway at the byte boundary.
      if (location.origin !== url.origin || location.protocol !== "https:") throw new IndexReadFailure("publisher", "leaves the index origin");
      const { max, budgetBound } = budget.cap(own);
      try {
        const bytes = await fetchHttpsBytes(location, fetchImpl, max, Math.min(limits.requestMs, budget.timeLeft()));
        budget.spend(bytes.byteLength);
        return bytes;
      } catch (error) {
        if (error instanceof IndexReadFailure && /^exceeds /.test(error.message)) throw budget.oversize(own, budgetBound);
        throw error;
      }
    };
  } else {
    const indexDir = path.dirname(path.resolve(raw));
    let rootReal: string | undefined;
    fetchOne = async (own, target) => {
      budget.timeLeft();
      const file = target as string;
      let real: string;
      try {
        real = await realpath(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new IndexReadFailure("publisher", code === "ENOENT" || code === "ENOTDIR" ? "no such file" : code ?? "unreadable");
      }
      if (file !== path.resolve(raw)) {
        // Every byte is pinned, but containment is still decided on the real path: an index must not
        // be able to point the reader at local files outside its own directory, matching bytes or not.
        rootReal ??= await realpath(indexDir);
        if (!real.startsWith(rootReal + path.sep)) throw new IndexReadFailure("publisher", "resolves outside the index directory");
      }
      const { max, budgetBound } = budget.cap(own);
      const read = await readExternalFileBytesNoFollowWithin(real, max, deps.home);
      if (read.state === "missing") throw new IndexReadFailure("publisher", "no such file");
      if (read.state === "unsafe") throw new IndexReadFailure("publisher", "is not a regular file");
      if (read.state === "too_large") throw budget.oversize(own, budgetBound);
      budget.spend(read.bytes.byteLength);
      return new Uint8Array(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
    };
  }

  let indexBytes: Uint8Array;
  try {
    indexBytes = await fetchOne(limits.indexBytes, url ?? path.resolve(raw));
  } catch (error) {
    if (error instanceof CliError) throw error;
    const read = error instanceof IndexReadFailure ? error : new IndexReadFailure("transient", String(error));
    const where = url ? url.href : `'${raw}'`;
    throw new CliError(read.kind === "transient" ? "TRANSIENT" : "USAGE", `could not read the recipe index ${where}: ${read.message}`, {
      details: { reason: "RECIPE_INDEX_READ_FAILED" },
      help: `${cliInvocation()} recipe add --help`,
    });
  }
  const parsed = parseRecipeIndex(indexBytes);
  if (!parsed.ok) throw indexUsage(`recipe index ${url ? url.href : `'${raw}'`}: ${parsed.error.message}`, parsed.error.code);

  const read: RecipeIndexReader = async (relative) => {
    const target = url ? new URL(relative, url) : path.join(path.dirname(path.resolve(raw)), ...relative.split("/"));
    try {
      return await fetchOne(limits.fileBytes, target);
    } catch (error) {
      if (error instanceof CliError) boundary = error;
      else failure = error instanceof IndexReadFailure ? error : new IndexReadFailure("transient", String(error));
      throw error;
    }
  };
  return {
    index: parsed.index,
    location: url ? url.href : raw,
    read,
    boundaryRefusal: () => boundary,
    lastFailure: () => failure,
  };
}
