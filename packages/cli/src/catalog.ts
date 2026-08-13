import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveLocalBundleTarget } from "./bundle.js";
import { credentialsDir, writeFileAtomic0600 } from "./credentials.js";
import { CliError } from "./errors.js";
import { cliInvocation } from "./invocation.js";

export const CATALOG_FILE_NAME = "catalog.json";
export const CATALOG_LOCK_FILE_NAME = "catalog.lock";
export const CATALOG_SCHEMA_VERSION = 1;

const DIR_MODE = 0o700;
const LOCK_MODE = 0o600;
const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_LOCK_POLL_MS = 25;
const STALE_LOCK_MIN_AGE_MS = 30_000;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const ID_PATTERN = /^bnd_[0-9a-f]{32}$/;

export interface CatalogEntry {
  id: string;
  label: string;
  locator: { kind: "local-path"; path: string };
}

export interface CatalogFile {
  schema_version: 1;
  entries: CatalogEntry[];
}

export interface CatalogEntryView extends CatalogEntry {
  available: boolean;
}

export interface CatalogOptions {
  home?: string;
  now?: () => number;
  pid?: number;
  sleep?: (ms: number) => Promise<void>;
  processExists?: (pid: number) => boolean;
  createId?: () => string;
  lockWaitMs?: number;
  lockPollMs?: number;
}

interface LockMetadata {
  pid: number;
  created_at_ms: number;
  token: string;
}

interface MutationResult<T> {
  value: T;
  changed: boolean;
  next?: CatalogFile;
}

function catalogDir(home: string): string {
  return credentialsDir(home);
}

export function catalogPath(home: string = homedir()): string {
  return path.join(catalogDir(home), CATALOG_FILE_NAME);
}

export function catalogLockPath(home: string = homedir()): string {
  return path.join(catalogDir(home), CATALOG_LOCK_FILE_NAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function invalidCatalog(file: string, detail: string): CliError {
  return new CliError("USAGE", `invalid workspace catalog ${file}: ${detail}`, {
    help: `repair or move ${file}, then retry`,
  });
}

export function assertCatalogLabel(label: string): void {
  if (!LABEL_PATTERN.test(label) || label.startsWith("bnd_")) {
    throw new CliError(
      "USAGE",
      `invalid workspace label "${label}"; use 1-64 lowercase letters, numbers, dot, dash, or underscore, beginning and ending with a letter or number (the bnd_ prefix is reserved)`,
      { help: `${cliInvocation()} catalog add <label> [--dir <path>]` },
    );
  }
}

function validateEntry(value: unknown, file: string, index: number): CatalogEntry {
  if (!isObject(value) || !hasExactKeys(value, ["id", "label", "locator"])) {
    throw invalidCatalog(file, `entries[${index}] must contain exactly id, label, and locator`);
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw invalidCatalog(file, `entries[${index}].id must match ${ID_PATTERN.source}`);
  }
  if (typeof value.label !== "string" || !LABEL_PATTERN.test(value.label) || value.label.startsWith("bnd_")) {
    throw invalidCatalog(file, `entries[${index}].label is not a valid workspace label`);
  }
  if (!isObject(value.locator) || !hasExactKeys(value.locator, ["kind", "path"])) {
    throw invalidCatalog(file, `entries[${index}].locator must contain exactly kind and path`);
  }
  if (value.locator.kind !== "local-path") {
    throw invalidCatalog(file, `entries[${index}].locator.kind must be "local-path"`);
  }
  if (
    typeof value.locator.path !== "string" ||
    !path.isAbsolute(value.locator.path) ||
    path.normalize(value.locator.path) !== value.locator.path
  ) {
    throw invalidCatalog(file, `entries[${index}].locator.path must be a normalized absolute path`);
  }
  return {
    id: value.id,
    label: value.label,
    locator: { kind: "local-path", path: value.locator.path },
  };
}

export function parseCatalog(raw: string, file: string): CatalogFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw invalidCatalog(file, `invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(parsed)) throw invalidCatalog(file, "top level must be an object");
  if (parsed.schema_version !== CATALOG_SCHEMA_VERSION) {
    if (typeof parsed.schema_version === "number" && parsed.schema_version > CATALOG_SCHEMA_VERSION) {
      throw new CliError(
        "NOT_IMPLEMENTED",
        `workspace catalog ${file} uses newer schema version ${parsed.schema_version}; this CLI supports version ${CATALOG_SCHEMA_VERSION}`,
        { help: "upgrade Superbee before modifying this catalog" },
      );
    }
    throw invalidCatalog(file, `schema_version must be ${CATALOG_SCHEMA_VERSION}`);
  }
  if (!hasExactKeys(parsed, ["entries", "schema_version"]) || !Array.isArray(parsed.entries)) {
    throw invalidCatalog(file, "top level must contain exactly schema_version and entries[]");
  }

  const entries = parsed.entries.map((entry, index) => validateEntry(entry, file, index));
  const ids = new Set<string>();
  const labels = new Set<string>();
  const paths = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw invalidCatalog(file, `duplicate id "${entry.id}"`);
    if (labels.has(entry.label)) throw invalidCatalog(file, `duplicate label "${entry.label}"`);
    if (paths.has(entry.locator.path)) throw invalidCatalog(file, `duplicate path "${entry.locator.path}"`);
    ids.add(entry.id);
    labels.add(entry.label);
    paths.add(entry.locator.path);
  }
  return { schema_version: CATALOG_SCHEMA_VERSION, entries };
}

export async function loadCatalog(home: string = homedir(), signal?: AbortSignal): Promise<CatalogFile> {
  const file = catalogPath(home);
  let raw: string;
  try {
    if (!(await stat(file)).isFile()) {
      throw new CliError("RUNTIME", `workspace catalog ${file} is not a regular file`);
    }
    raw = await readFile(file, { encoding: "utf8", signal });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: CATALOG_SCHEMA_VERSION, entries: [] };
    }
    if (err instanceof CliError) throw err;
    throw new CliError("RUNTIME", `could not read workspace catalog ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseCatalog(raw, file);
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockMetadata(raw: string): LockMetadata | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isObject(value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.created_at_ms !== "number" ||
      !Number.isFinite(value.created_at_ms) ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      return null;
    }
    return { pid: value.pid, created_at_ms: value.created_at_ms, token: value.token };
  } catch {
    return null;
  }
}

async function acquireCatalogLock(options: CatalogOptions): Promise<() => Promise<void>> {
  const home = options.home ?? homedir();
  const dir = catalogDir(home);
  const lockPath = catalogLockPath(home);
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const processExists = options.processExists ?? defaultProcessExists;
  const waitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const token = randomUUID();
  const started = now();

  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);

  while (true) {
    try {
      const handle = await open(lockPath, "wx", LOCK_MODE);
      try {
        await handle.writeFile(JSON.stringify({ pid, created_at_ms: now(), token }) + "\n");
        await handle.chmod(LOCK_MODE);
        await handle.sync();
      } catch (err) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw err;
      }
      await handle.close();
      return async () => {
        try {
          const current = readLockMetadata(await readFile(lockPath, "utf8"));
          if (current?.token === token) await unlink(lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let owner: LockMetadata | null = null;
    let malformedAgeMs: number | null = null;
    try {
      owner = readLockMetadata(await readFile(lockPath, "utf8"));
      if (!owner) malformedAgeMs = now() - (await stat(lockPath)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
    }
    if (owner && now() - owner.created_at_ms >= STALE_LOCK_MIN_AGE_MS && !processExists(owner.pid)) {
      throw new CliError("TRANSIENT", `stale workspace catalog lock at ${lockPath} belongs to absent PID ${owner.pid}`, {
        details: { retryable: true, stale: true, lock_path: lockPath, owner_pid: owner.pid },
        help: `remove ${lockPath} after confirming PID ${owner.pid} is absent, then retry`,
      });
    }
    if (malformedAgeMs !== null && malformedAgeMs >= STALE_LOCK_MIN_AGE_MS) {
      throw new CliError("TRANSIENT", `stale malformed workspace catalog lock at ${lockPath}`, {
        details: { retryable: true, stale: true, malformed: true, lock_path: lockPath },
        help: `inspect and remove ${lockPath}, then retry`,
      });
    }
    if (now() - started >= waitMs) {
      throw new CliError("TRANSIENT", `workspace catalog is busy (lock: ${lockPath})`, {
        details: { retryable: true, lock_path: lockPath, owner_pid: owner?.pid },
        help: `${cliInvocation()} catalog <command> ...`,
      });
    }
    await sleep(pollMs);
  }
}

async function mutateCatalog<T>(
  decide: (current: CatalogFile) => Promise<MutationResult<T>>,
  options: CatalogOptions,
): Promise<{ value: T; changed: boolean }> {
  const home = options.home ?? homedir();
  const release = await acquireCatalogLock({ ...options, home });
  try {
    const current = await loadCatalog(home);
    const result = await decide(current);
    if (result.changed) {
      if (!result.next) throw new Error("catalog mutation marked changed without a next state");
      const next: CatalogFile = {
        schema_version: CATALOG_SCHEMA_VERSION,
        entries: [...result.next.entries].sort((a, b) => a.label.localeCompare(b.label)),
      };
      await writeFileAtomic0600(catalogDir(home), CATALOG_FILE_NAME, JSON.stringify(next, null, 2) + "\n");
    }
    return { value: result.value, changed: result.changed };
  } finally {
    await release();
  }
}

function generatedId(options: CatalogOptions, existing: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = options.createId?.() ?? `bnd_${randomUUID().replaceAll("-", "")}`;
    if (!ID_PATTERN.test(id)) throw new Error(`catalog id generator returned invalid id: ${id}`);
    if (!existing.has(id)) return id;
  }
  throw new Error("catalog id generator exhausted collision retries");
}

export async function addCatalogEntry(
  label: string,
  canonicalPath: string,
  options: CatalogOptions = {},
): Promise<{ entry: CatalogEntry; changed: boolean }> {
  assertCatalogLabel(label);
  if (!path.isAbsolute(canonicalPath)) throw new CliError("USAGE", "workspace catalog paths must be absolute");

  const result = await mutateCatalog(async (current) => {
    const target = await resolveLocalBundleTarget(canonicalPath);
    if (target.canonicalRoot !== canonicalPath) {
      throw new CliError("NOT_FOUND", `workspace path is no longer canonical: ${canonicalPath}`, {
        help: `${cliInvocation()} bundle locate --dir ${canonicalPath}`,
      });
    }
    const byLabel = current.entries.find((entry) => entry.label === label);
    const byPath = current.entries.find((entry) => entry.locator.path === canonicalPath);
    if (byLabel && byPath && byLabel.id === byPath.id) {
      return { value: byLabel, changed: false };
    }
    if (byLabel) {
      throw new CliError("ALREADY_EXISTS", `workspace label "${label}" already points to ${byLabel.locator.path}`, {
        details: { id: byLabel.id, label, path: byLabel.locator.path },
        help: `${cliInvocation()} catalog resolve ${label}`,
      });
    }
    if (byPath) {
      throw new CliError("ALREADY_EXISTS", `workspace path ${canonicalPath} is already labeled "${byPath.label}"`, {
        details: { id: byPath.id, label: byPath.label, path: canonicalPath },
        help: `${cliInvocation()} catalog resolve ${byPath.label}`,
      });
    }
    const entry: CatalogEntry = {
      id: generatedId(options, new Set(current.entries.map((item) => item.id))),
      label,
      locator: { kind: "local-path", path: canonicalPath },
    };
    return {
      value: entry,
      changed: true,
      next: { schema_version: CATALOG_SCHEMA_VERSION, entries: [...current.entries, entry] },
    };
  }, options);
  return { entry: result.value, changed: result.changed };
}

async function entryAvailable(entry: CatalogEntry): Promise<boolean> {
  try {
    const target = await resolveLocalBundleTarget(entry.locator.path);
    return target.canonicalRoot === entry.locator.path;
  } catch {
    return false;
  }
}

export async function listCatalogEntries(home: string = homedir()): Promise<CatalogEntryView[]> {
  const catalog = await loadCatalog(home);
  return Promise.all(
    [...catalog.entries]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(async (entry) => ({ ...entry, available: await entryAvailable(entry) })),
  );
}

function classifySelector(selector: string): "id" | "label" {
  if (selector.startsWith("bnd_")) {
    if (!ID_PATTERN.test(selector)) {
      throw new CliError("USAGE", `invalid workspace catalog id "${selector}"`);
    }
    return "id";
  }
  assertCatalogLabel(selector);
  return "label";
}

export async function resolveCatalogEntry(
  selector: string,
  home: string = homedir(),
): Promise<CatalogEntryView> {
  const catalog = await loadCatalog(home);
  const kind = classifySelector(selector);
  const entry = catalog.entries.find((item) => item[kind] === selector);
  if (!entry) {
    throw new CliError("NOT_FOUND", `workspace "${selector}" is not registered`, {
      help: `${cliInvocation()} catalog list`,
    });
  }
  if (!(await entryAvailable(entry))) {
    throw new CliError("NOT_FOUND", `workspace "${entry.label}" is unavailable at ${entry.locator.path}`, {
      details: { id: entry.id, label: entry.label, path: entry.locator.path },
      help: `restore the bundle at ${entry.locator.path}, then retry`,
    });
  }
  return { ...entry, available: true };
}
