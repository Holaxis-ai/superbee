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
  inspectCanonicalUserStateRoot,
  LEGACY_BRIDGE_PACKAGE_NAME,
  legacyUserStateDir,
  readPrivateStateFile,
  supersededUserStateDirs,
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
  | { state: "blocked"; reason: string; records: number };

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

async function preflightSourceRoot(root: string): Promise<MigrationRecord[]> {
  try {
    const status = await lstat(root);
    if (status.isSymbolicLink() || !status.isDirectory()) return [];
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw error;
  }
  const records = await preflightDurableRecords(root);
  if (records.length > 0) await assertPrivateDirectory(root);
  return records;
}

async function preflightLegacy(home: string): Promise<MigrationRecord[]> {
  const merged: MigrationRecord[] = [];
  const claimed = new Set<string>();
  for (const root of migrationSourceRoots(home)) {
    for (const record of await preflightSourceRoot(root)) {
      if (claimed.has(record.relative)) continue;
      claimed.add(record.relative);
      merged.push(record);
    }
  }
  return merged;
}

export async function inspectUserStateMigration(home: string = homedir()): Promise<UserStateMigrationInspection> {
  if (staticBuildIdentity().package.name === LEGACY_BRIDGE_PACKAGE_NAME) {
    return { state: "ready", reason: "the separately published Aslite bridge retains its legacy state root", records: 0 };
  }
  const canonical = await inspectCanonicalUserStateRoot(home);
  if (canonical === "ready") return { state: "ready", reason: "the canonical Superbee user-state root is ready", records: 0 };
  if (canonical === "conflict") return { state: "blocked", reason: "the canonical Superbee user-state root is unrecognized", records: 0 };
  try {
    const records = await preflightLegacy(home);
    return records.length === 0
      ? { state: "fresh", reason: "no legacy operational state requires migration", records: 0 }
      : { state: "migratable", reason: "validated legacy operational state is ready to migrate", records: records.length };
  } catch {
    return { state: "blocked", reason: "legacy operational state is not safe to migrate automatically", records: 0 };
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
  const temporary = join(directory, `.migration-${randomBytes(12).toString("hex")}.tmp`);
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

  const records = await preflightLegacy(home).catch(() => {
    throw new CliError("CONFLICT", "legacy operational state is not safe to migrate automatically", { help: "superbee setup" });
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
