// The CLI acquisition adapter for a published recipe index. Core owns the index format and the
// digest verification; this module only supplies bytes, from a local path or an HTTPS URL, under
// size and time bounds. Nothing here is persisted: the index is named per command.
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseRecipeIndex,
  type RecipeIndex,
  type RecipeIndexReader,
} from "@superbee/core/recipe-sources";
import { CliError } from "./errors.js";
import { readExternalTextFileWithin } from "./external-file.js";
import { cliInvocation } from "./invocation.js";

export const RECIPE_INDEX_MAX_BYTES = 1024 * 1024;
export const RECIPE_FILE_MAX_BYTES = 1024 * 1024;
export const RECIPE_FETCH_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init: { redirect: "error"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  body: ReadableStream<Uint8Array> | null;
}>;

export interface RecipeIndexAcquisition {
  index: RecipeIndex;
  /** The index location as given, for receipts. */
  location: string;
  read: RecipeIndexReader;
  /** A private-state boundary refusal raised by a file read, which must surface unchanged. */
  boundaryRefusal(): CliError | undefined;
}

export interface RecipeIndexDeps {
  fetch?: FetchLike;
  home?: string;
  timeoutMs?: number;
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
  try {
    return new URL(raw);
  } catch {
    throw indexUsage("the --index value is not a valid URL", "RECIPE_INDEX_SCHEME_REFUSED");
  }
}

/** Fetches one https resource as strict UTF-8, refusing redirects, non-200 answers and oversize bodies. */
export async function fetchHttpsText(url: URL, fetchImpl: FetchLike, maxBytes: number, timeoutMs: number): Promise<string> {
  if (url.protocol !== "https:") throw new Error(`refused non-https URL ${url.href}`);
  let response: Awaited<ReturnType<FetchLike>>;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetchImpl(url.href, { redirect: "error", signal, headers: { accept: "application/json, text/markdown, text/plain" } });
  } catch (error) {
    throw new Error(signal.aborted ? `timed out after ${timeoutMs} ms` : `request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status !== 200) throw new Error(`answered HTTP ${response.status}`);
  if (!response.body) throw new Error("answered with no body");
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
        throw new Error(`exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) throw new Error(`timed out after ${timeoutMs} ms`);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("is not valid UTF-8");
  }
}

/** Reads and parses the index named by `--index`, and returns a reader scoped to its location. */
export async function acquireRecipeIndex(raw: string, deps: RecipeIndexDeps = {}): Promise<RecipeIndexAcquisition> {
  const timeoutMs = deps.timeoutMs ?? RECIPE_FETCH_TIMEOUT_MS;
  const url = indexUrl(raw);
  let text: string;
  let read: RecipeIndexReader;
  let boundary: CliError | undefined;
  if (url) {
    const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    try {
      text = await fetchHttpsText(url, fetchImpl, RECIPE_INDEX_MAX_BYTES, timeoutMs);
    } catch (error) {
      throw new CliError("TRANSIENT", `could not fetch the recipe index ${url.href}: ${(error as Error).message}`, {
        details: { reason: "RECIPE_INDEX_READ_FAILED" },
        help: `${cliInvocation()} recipe add --help`,
      });
    }
    read = async (relative) => {
      const target = new URL(relative, url);
      // Index paths are plain relative segments, so this holds; checked anyway at the byte boundary.
      if (target.origin !== url.origin || target.protocol !== "https:") throw new Error(`'${relative}' leaves the index origin`);
      return fetchHttpsText(target, fetchImpl, RECIPE_FILE_MAX_BYTES, timeoutMs);
    };
  } else {
    const file = path.resolve(raw);
    let loaded: string | null;
    try {
      loaded = await readExternalTextFileWithin(file, RECIPE_INDEX_MAX_BYTES, deps.home);
    } catch (error) {
      if (error instanceof CliError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw indexUsage(`could not read the recipe index '${raw}'${code ? ` (${code})` : ""}`, "RECIPE_INDEX_READ_FAILED");
    }
    if (loaded === null) throw indexUsage(`the recipe index '${raw}' exceeds ${RECIPE_INDEX_MAX_BYTES} bytes`, "RECIPE_INDEX_READ_FAILED");
    text = loaded;
    const dir = path.dirname(file);
    let rootReal: string | undefined;
    read = async (relative) => {
      let bytes: string | null;
      try {
        // Every byte is pinned, but containment is still decided on the real path: an index must not
        // be able to point the reader at local files outside its own directory, matching bytes or not.
        rootReal ??= await realpath(dir);
        const real = await realpath(path.join(dir, ...relative.split("/")));
        if (!real.startsWith(rootReal + path.sep)) throw new Error("resolves outside the index directory");
        bytes = await readExternalTextFileWithin(real, RECIPE_FILE_MAX_BYTES, deps.home);
      } catch (error) {
        if (error instanceof CliError) {
          boundary = error;
          throw error;
        }
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(code === "ENOENT" ? "no such file" : code ?? (error instanceof Error ? error.message : "unreadable"));
      }
      if (bytes === null) throw new Error(`exceeds ${RECIPE_FILE_MAX_BYTES} bytes`);
      return bytes;
    };
  }
  const parsed = parseRecipeIndex(text);
  if (!parsed.ok) throw indexUsage(`recipe index '${raw}': ${parsed.error.message}`, parsed.error.code);
  return { index: parsed.index, location: url ? url.href : raw, read, boundaryRefusal: () => boundary };
}
