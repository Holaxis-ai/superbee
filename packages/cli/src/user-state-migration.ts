// Explicit, one-shot migration from Superbee's historical operational-state root into its one
// canonical root. This module is imported only by `setup`; ordinary state readers stay single-root.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseCatalog } from "./catalog.js";
import { CATALOG_FILE_NAME } from "./catalog.js";
import { staticBuildIdentity } from "./build-identity.js";
import { assertMigratableCredentials, CRED_FILE_NAME } from "./credentials.js";
import { CliError } from "./errors.js";
import {
  canonicalUserStateDir,
  ensureStateRootGitignore,
  homeRelativeDisplay,
  inspectCanonicalUserStateRoot,
  inspectCanonicalUserStateRootDetail,
  LEGACY_BRIDGE_PACKAGE_NAME,
  legacyUserStateDir,
  readPrivateStateFile,
  supersededUserStateDirs,
  USER_STATE_HARDEN_COMMAND,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
  USER_STATE_QUARANTINE_COMMAND,
} from "./user-state.js";
import { assertMigratableViewAuthorization } from "./ui/view-authorizations.js";

const VIEW_AUTHORIZATION_DIR_NAME = "view-authorizations";
const MIGRATION_JOURNAL_FILE_NAME = ".migration.json";
const MIGRATION_JOURNAL_SCHEMA = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_RECORDS = 512;

export type UserStateMigrationInspection =
  | { state: "ready"; reason: string; records: number }
  | { state: "fresh"; reason: string; records: 0 }
  | { state: "migratable"; reason: string; records: number }
  /** Recognized as ours, usable, and carrying repairable permission drift. Never quarantined. */
  | { state: "repairable"; reason: string; records: 0; command: string }
  /**
   * Unusable. The command is CAUSE-SPECIFIC: the canonical root and a migration source have
   * different exit nodes, and neither may be handed the other's.
   */
  | { state: "blocked"; reason: string; records: number; command: string };

export interface UserStateMigrationReceipt {
  schema_version: 1;
  status: "migrated" | "already_current" | "nothing_to_migrate";
  changed: boolean;
  records: {
    catalog: "migrated" | "unchanged" | "absent";
    credentials: "migrated" | "unchanged" | "absent";
    view_authorizations: number;
    sync_state: "rederived";
    ephemeral_state: "rederived";
  };
  legacy_preserved: true;
  next: { command: "superbee setup" };
}

interface MigrationRecord {
  relative: string;
  bytes: string;
  sha256: string;
}

interface MigrationJournal {
  product: "superbee";
  schema_version: 1;
  records: Array<{ relative: string; sha256: string }>;
}

export interface UserStateMigrationHooks {
  /** Test seam immediately before the exclusive canonical-root claim. */
  beforeCanonicalClaim?: () => void | Promise<void>;
  /** Test seam immediately before publishing one migrated record without replacement. */
  beforeRecordPublish?: (relative: string) => void | Promise<void>;
  /** Test seam after all copies and immediately before source revalidation + marker publication. */
  beforeMarkerPublish?: () => void | Promise<void>;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const status = await lstat(directory);
  const currentUid = process.getuid?.();
  if (
    status.isSymbolicLink()
    || !status.isDirectory()
    || (status.mode & 0o077) !== 0
    || (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error("legacy private state directory is unsafe");
  }
}

async function assertPrivateRegularFile(file: string): Promise<void> {
  const status = await lstat(file);
  const currentUid = process.getuid?.();
  if (
    status.isSymbolicLink()
    || !status.isFile()
    || (status.mode & 0o077) !== 0
    || (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error("private state file is unsafe");
  }
}

async function optionalRecord(root: string, relative: string, maxBytes: number, validate: (raw: string) => void): Promise<MigrationRecord | null> {
  const file = join(root, relative);
  try {
    const bytes = await readPrivateStateFile(file, maxBytes);
    validate(bytes);
    return { relative, bytes, sha256: digest(bytes) };
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

async function preflightDurableRecords(root: string): Promise<MigrationRecord[]> {
  const records: MigrationRecord[] = [];
  const catalog = await optionalRecord(root, CATALOG_FILE_NAME, MAX_CATALOG_BYTES, (raw) => {
    parseCatalog(raw, "legacy catalog");
  });
  if (catalog) {
    records.push(catalog);
  }
  const credentials = await optionalRecord(root, CRED_FILE_NAME, MAX_CREDENTIAL_BYTES, assertMigratableCredentials);
  if (credentials) {
    records.push(credentials);
  }

  const authorizationDir = join(root, VIEW_AUTHORIZATION_DIR_NAME);
  let entries;
  try {
    await assertPrivateDirectory(authorizationDir);
    entries = await readdir(authorizationDir, { withFileTypes: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return records;
    throw error;
  }
  if (entries.length > MAX_AUTHORIZATION_RECORDS) throw new Error("legacy View authorization store exceeds its record limit");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("legacy View authorization store contains a non-regular entry");
    const relative = `${VIEW_AUTHORIZATION_DIR_NAME}/${entry.name}`;
    const record = await optionalRecord(root, relative, MAX_AUTHORIZATION_BYTES, (raw) => assertMigratableViewAuthorization(entry.name, raw));
    if (!record) throw new Error("legacy View authorization changed during inspection");
    records.push(record);
  }
  return records;
}

/**
 * Every root migration may draw FROM, highest precedence first. `~/.agentstate` is the released
 * bridge root; `~/.config/superbee` is the superseded canonical root — it never shipped, but a
 * tester who ran a pre-release build has one locally. Ordered, not merged blindly: the first source
 * that supplies a given record wins, so precedence is a property of this list rather than of
 * directory-walk order.
 */
export function migrationSourceRoots(home: string): string[] {
  return [...new Set([legacyUserStateDir(home), ...supersededUserStateDirs(home)])];
}

/**
 * A source root the product cannot decide about. It names the root in `~`-relative form and
 * carries its OWN exit node: a source-side block is not cleared by quarantining the canonical
 * root, and on a fresh machine that root does not even exist.
 */
export class UnsafeMigrationSource extends Error {
  readonly display: string;
  readonly detail: string;
  readonly command: string;

  constructor(display: string, detail: string, command: string) {
    super(`${display} ${detail}`);
    this.name = "UnsafeMigrationSource";
    this.display = display;
    this.detail = detail;
    this.command = command;
  }
}

/**
 * ENOENT is the only absence. Every other outcome — a symlinked root (an ordinary dotfile
 * layout), a regular file, an unreadable ancestor — is DETECTED UNCERTAINTY, and uncertainty fails
 * closed. Returning `[]` here reported a live catalog, credential, and View-approval store as
 * "nothing to migrate".
 */
async function preflightSourceRoot(root: string, display: string): Promise<MigrationRecord[]> {
  let status;
  try {
    status = await lstat(root);
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw new UnsafeMigrationSource(display, "cannot be inspected", `ls -ld ${display}`);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new UnsafeMigrationSource(display, "exists but is not a real directory", `ls -ld ${display}`);
  }
  try {
    const records = await preflightDurableRecords(root);
    if (records.length > 0) await assertPrivateDirectory(root);
    return records;
  } catch (error) {
    if (error instanceof UnsafeMigrationSource) throw error;
    throw new UnsafeMigrationSource(
      display,
      "holds operational state that is not safe to migrate automatically",
      `ls -la ${display}`,
    );
  }
}

async function preflightLegacy(home: string): Promise<MigrationRecord[]> {
  const merged: MigrationRecord[] = [];
  const claimed = new Set<string>();
  for (const root of migrationSourceRoots(home)) {
    for (const record of await preflightSourceRoot(root, homeRelativeDisplay(home, root))) {
      if (claimed.has(record.relative)) continue;
      claimed.add(record.relative);
      merged.push(record);
    }
  }
  return merged;
}

/** One projection of a source-side failure, shared by the inspector and the migration leaf. */
function blockedSource(error: unknown): { reason: string; command: string } {
  return error instanceof UnsafeMigrationSource
    ? { reason: `legacy operational state at ${error.display} ${error.detail}`, command: error.command }
    : { reason: "legacy operational state is not safe to migrate automatically", command: "superbee setup" };
}

export async function inspectUserStateMigration(home: string = homedir()): Promise<UserStateMigrationInspection> {
  if (staticBuildIdentity().package.name === LEGACY_BRIDGE_PACKAGE_NAME) {
    return { state: "ready", reason: "the separately published Aslite bridge retains its legacy state root", records: 0 };
  }
  const canonical = await inspectCanonicalUserStateRootDetail(home);
  if (canonical.state === "ready") {
    // Recognized and usable. Loose permissions are drift this product repairs on its next write,
    // so the exit node is the repair — never the quarantine a foreign root gets.
    return canonical.hardening === "loose"
      ? {
          state: "repairable",
          reason: "the canonical Superbee user-state root is recognized but its permissions are group- or world-accessible",
          records: 0,
          command: USER_STATE_HARDEN_COMMAND,
        }
      : { state: "ready", reason: "the canonical Superbee user-state root is ready", records: 0 };
  }
  if (canonical.state === "conflict") {
    return {
      state: "blocked",
      reason: "the canonical Superbee user-state root is unrecognized",
      records: 0,
      command: `${USER_STATE_QUARANTINE_COMMAND} && superbee setup`,
    };
  }
  try {
    const records = await preflightLegacy(home);
    return records.length === 0
      ? { state: "fresh", reason: "no legacy operational state requires migration", records: 0 }
      : { state: "migratable", reason: "validated legacy operational state is ready to migrate", records: records.length };
  } catch (error) {
    return { state: "blocked", records: 0, ...blockedSource(error) };
  }
}

async function ensureMigrationParent(home: string): Promise<void> {
  const parent = dirname(canonicalUserStateDir(home));
  try {
    await mkdir(parent, { mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  // The canonical root's parent is $HOME itself; a symlinked home directory is the operator's own
  // configuration. Only the ROOT must be a real, non-symlink directory.
  if (!(await stat(parent)).isDirectory()) throw new Error("canonical state parent is unsafe");
}

/**
 * The one shape a staging temporary may take. Kept beside its generator so cleanup below can never
 * drift from what this module actually writes.
 */
const MIGRATION_TEMPORARY_PATTERN = /^\.migration-[0-9a-f]+\.tmp$/;

function migrationTemporaryName(): string {
  return `.migration-${randomBytes(12).toString("hex")}.tmp`;
}

/**
 * `writeNoReplace` unlinks its own temporary in a `finally`, but a kill between the create and that
 * unlink — SIGKILL, Ctrl-C, sleep, OOM — leaves one behind, and `assertExactStagingTopology` then
 * rejects the root on every later run. No marker has been published at that point, so the leftover
 * bricks private state product-wide rather than merely stalling migration.
 *
 * Cleanup authority binds to DURABLE OWNERSHIP, never to a matching name alone: the caller has
 * already proven this root is this migration's own staging — a journal that parses and names
 * exactly this record set, or a root this process exclusively created — and only the directories
 * that record set can reach are swept. Best-effort by design: a survivor still trips the exactness
 * assertion rather than being quietly published over.
 */
async function sweepOwnedStagingTemporaries(root: string, records: MigrationRecord[]): Promise<void> {
  const directories = new Set<string>([root, ...records.map((record) => dirname(join(root, record.relative)))]);
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !MIGRATION_TEMPORARY_PATTERN.test(entry.name)) continue;
      await unlink(join(directory, entry.name)).catch(() => {});
    }
  }
}

async function writeNoReplace(root: string, relative: string, bytes: string): Promise<void> {
  const destination = join(root, relative);
  const directory = dirname(destination);
  if (directory !== root) {
    try {
      await mkdir(directory, { mode: DIR_MODE });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    await assertPrivateDirectory(directory);
  }
  const temporary = join(directory, migrationTemporaryName());
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function journalFor(records: MigrationRecord[]): MigrationJournal {
  return {
    product: "superbee",
    schema_version: MIGRATION_JOURNAL_SCHEMA,
    records: records.map(({ relative, sha256 }) => ({ relative, sha256 })),
  };
}

function journalBytes(records: MigrationRecord[]): string {
  return `${JSON.stringify(journalFor(records))}\n`;
}

function parseJournal(raw: string): MigrationJournal | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !exactKeys(value, ["product", "records", "schema_version"]) || value.product !== "superbee" || value.schema_version !== 1 || !Array.isArray(value.records)) return null;
    const records: Array<{ relative: string; sha256: string }> = [];
    for (const row of value.records) {
      if (!isRecord(row) || !exactKeys(row, ["relative", "sha256"]) || typeof row.relative !== "string" || !/^(?:catalog\.json|okf-config\.json|view-authorizations\/[a-f0-9]{64}\.json)$/.test(row.relative) || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) return null;
      records.push({ relative: row.relative, sha256: row.sha256 });
    }
    const journal = { product: "superbee" as const, schema_version: 1 as const, records };
    return raw === `${JSON.stringify(journal)}\n` ? journal : null;
  } catch {
    return null;
  }
}

async function destinationMatches(root: string, record: MigrationRecord): Promise<boolean> {
  try {
    await assertPrivateRegularFile(join(root, record.relative));
    return digest(await readPrivateStateFile(join(root, record.relative), Buffer.byteLength(record.bytes))) === record.sha256;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertExactStagingTopology(root: string, records: MigrationRecord[]): Promise<void> {
  await assertPrivateDirectory(root);
  const rootAllowed = new Set<string>([MIGRATION_JOURNAL_FILE_NAME]);
  if (records.some((record) => record.relative === CATALOG_FILE_NAME)) rootAllowed.add(CATALOG_FILE_NAME);
  if (records.some((record) => record.relative === CRED_FILE_NAME)) rootAllowed.add(CRED_FILE_NAME);
  const authorizationNames = new Set(
    records
      .filter((record) => record.relative.startsWith(`${VIEW_AUTHORIZATION_DIR_NAME}/`))
      .map((record) => record.relative.slice(VIEW_AUTHORIZATION_DIR_NAME.length + 1)),
  );
  if (authorizationNames.size > 0) rootAllowed.add(VIEW_AUTHORIZATION_DIR_NAME);
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (rootEntries.some((entry) => !rootAllowed.has(entry.name))) {
    throw new Error("canonical migration root contains an unexpected entry");
  }
  await assertPrivateRegularFile(join(root, MIGRATION_JOURNAL_FILE_NAME));
  for (const record of records.filter((candidate) => !candidate.relative.includes("/"))) {
    await assertPrivateRegularFile(join(root, record.relative));
  }
  if (authorizationNames.size > 0) {
    const directory = join(root, VIEW_AUTHORIZATION_DIR_NAME);
    await assertPrivateDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      entries.length !== authorizationNames.size
      || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !authorizationNames.has(entry.name))
    ) {
      throw new Error("canonical View authorization staging contains an unexpected entry");
    }
    for (const name of authorizationNames) await assertPrivateRegularFile(join(directory, name));
  }
}

async function assertSourceUnchanged(home: string, expected: MigrationRecord[]): Promise<void> {
  const current = await preflightLegacy(home);
  if (journalBytes(current) !== journalBytes(expected)) throw new Error("legacy operational state changed during migration");
}

function receipt(status: UserStateMigrationReceipt["status"], changed: boolean, records: MigrationRecord[]): UserStateMigrationReceipt {
  const present: "unchanged" | "migrated" = status === "already_current" ? "unchanged" : "migrated";
  return {
    schema_version: 1,
    status,
    changed,
    records: {
      catalog: records.some((record) => record.relative === CATALOG_FILE_NAME) ? present : "absent",
      credentials: records.some((record) => record.relative === CRED_FILE_NAME) ? present : "absent",
      view_authorizations: records.filter((record) => record.relative.startsWith(`${VIEW_AUTHORIZATION_DIR_NAME}/`)).length,
      sync_state: "rederived",
      ephemeral_state: "rederived",
    },
    legacy_preserved: true,
    next: { command: "superbee setup" },
  };
}

export async function migrateUserState(
  home: string = homedir(),
  hooks: UserStateMigrationHooks = {},
): Promise<UserStateMigrationReceipt> {
  if (staticBuildIdentity().package.name === LEGACY_BRIDGE_PACKAGE_NAME) {
    throw new CliError("NOT_IMPLEMENTED", "state migration is available only from the Superbee package", { help: "npm install -g superbee" });
  }
  const canonical = await inspectCanonicalUserStateRoot(home);
  const root = canonicalUserStateDir(home);
  if (canonical === "ready") {
    const current = await preflightDurableRecords(root).catch(() => {
      throw new CliError("CONFLICT", "canonical Superbee user state contains an invalid durable record", { help: "superbee setup" });
    });
    return receipt("already_current", false, current);
  }

  const records = await preflightLegacy(home).catch((error: unknown) => {
    const blocked = blockedSource(error);
    throw new CliError("CONFLICT", blocked.reason, { help: blocked.command });
  });
  if (records.length === 0 && canonical === "absent") return receipt("nothing_to_migrate", false, []);
  if (canonical === "conflict") {
    let raw: string;
    try {
      await assertPrivateDirectory(root);
      raw = await readPrivateStateFile(join(root, MIGRATION_JOURNAL_FILE_NAME), MAX_CATALOG_BYTES);
    } catch {
      throw new CliError("CONFLICT", "canonical Superbee user state already exists but is not recognized", { help: "superbee setup" });
    }
    const journal = parseJournal(raw);
    if (!journal || raw !== journalBytes(records)) {
      throw new CliError("CONFLICT", "an incomplete or foreign canonical user-state root requires inspection", { help: "superbee setup" });
    }
  } else {
    await ensureMigrationParent(home);
    try {
      await hooks.beforeCanonicalClaim?.();
      await mkdir(root, { mode: DIR_MODE });
    } catch (error) {
      throw new CliError("CONFLICT", "canonical Superbee user state appeared during migration", { help: "superbee setup" });
    }
    await writeNoReplace(root, MIGRATION_JOURNAL_FILE_NAME, journalBytes(records));
  }
  // Ownership is durable from here: the journal validated as this migration's own staging, or this
  // process exclusively created the root and wrote it. That proof — not the file name — is what
  // authorizes clearing an interrupted predecessor's leftovers.
  await sweepOwnedStagingTemporaries(root, records);

  for (const record of records) {
    if (await destinationMatches(root, record)) continue;
    try {
      await hooks.beforeRecordPublish?.(record.relative);
      await writeNoReplace(root, record.relative, record.bytes);
    } catch {
      throw new CliError("CONFLICT", "canonical Superbee user state changed during migration", { help: "superbee setup" });
    }
  }
  try {
    await hooks.beforeMarkerPublish?.();
    await assertExactStagingTopology(root, records);
    await assertSourceUnchanged(home, records);
    await writeNoReplace(root, USER_STATE_MARKER_FILE_NAME, USER_STATE_MARKER_BYTES);
  } catch {
    // A real exit node, never a bare rerun of the command that just failed: the half-built
    // canonical root is what blocks the retry, and legacy state is preserved either way.
    throw new CliError(
      "CONFLICT",
      "user state changed during migration; legacy state remains preserved",
      { help: `${USER_STATE_QUARANTINE_COMMAND} && superbee setup migrate-state` },
    );
  }
  await unlink(join(root, MIGRATION_JOURNAL_FILE_NAME)).catch(() => {});
  await chmod(root, DIR_MODE);
  // The exact-topology assertions above are over, so the promised `*` .gitignore can finally be
  // published: a migrated root must be as unstageable as one created by `ensureUserStateRoot`.
  await ensureStateRootGitignore(root);
  return receipt("migrated", true, records);
}
