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
  inspectCanonicalUserStateRoot,
  LEGACY_BRIDGE_PACKAGE_NAME,
  legacyUserStateDir,
  readPrivateStateFile,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
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

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface MigrationAuthority {
  parent: { path: string; identity: DirectoryIdentity };
  root: { path: string; identity: DirectoryIdentity };
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

async function captureDirectoryIdentity(directory: string, requirePrivate: boolean): Promise<DirectoryIdentity> {
  const status = await lstat(directory);
  const currentUid = process.getuid?.();
  if (
    status.isSymbolicLink()
    || !status.isDirectory()
    || (requirePrivate && (status.mode & 0o077) !== 0)
    || (requirePrivate && currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error("migration directory authority is unsafe");
  }
  return { dev: status.dev, ino: status.ino };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
  requirePrivate: boolean,
): Promise<void> {
  const actual = await captureDirectoryIdentity(directory, requirePrivate);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("migration directory authority changed");
  }
}

async function assertMigrationAuthority(authority: MigrationAuthority): Promise<void> {
  await assertDirectoryIdentity(authority.parent.path, authority.parent.identity, false);
  await assertDirectoryIdentity(authority.root.path, authority.root.identity, true);
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

async function preflightLegacy(home: string): Promise<MigrationRecord[]> {
  const root = legacyUserStateDir(home);
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

async function ensureMigrationParent(home: string): Promise<{ path: string; identity: DirectoryIdentity }> {
  const parent = dirname(canonicalUserStateDir(home));
  try {
    await mkdir(parent, { mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  return { path: parent, identity: await captureDirectoryIdentity(parent, false) };
}

async function writeNoReplace(authority: MigrationAuthority, relative: string, bytes: string): Promise<void> {
  await assertMigrationAuthority(authority);
  const root = authority.root.path;
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
  await assertMigrationAuthority(authority);
  const directoryIdentity = await captureDirectoryIdentity(directory, true);
  const temporary = join(
    directory,
    `.migration-${digest(bytes)}-${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertMigrationAuthority(authority);
    await assertDirectoryIdentity(directory, directoryIdentity, true);
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  await assertMigrationAuthority(authority);
  await assertDirectoryIdentity(directory, directoryIdentity, true);
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

const MIGRATION_TEMP_NAME = /^\.migration-([a-f0-9]{64})-[a-f0-9]{24}\.tmp$/;

async function isOwnedInterruptedTemp(file: string, expected: string): Promise<boolean> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags);
  try {
    const status = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !status.isFile()
      || (status.mode & 0o077) !== 0
      || (currentUid !== undefined && status.uid !== currentUid)
      || status.size > Buffer.byteLength(expected)
    ) {
      return false;
    }
    const actual = await handle.readFile();
    return Buffer.from(expected).subarray(0, actual.byteLength).equals(actual);
  } finally {
    await handle.close();
  }
}

async function cleanupOwnedTempsInDirectory(
  authority: MigrationAuthority,
  directory: string,
  expectedPayloads: readonly string[],
): Promise<void> {
  await assertMigrationAuthority(authority);
  const directoryIdentity = await captureDirectoryIdentity(directory, true);
  const byDigest = new Map(expectedPayloads.map((bytes) => [digest(bytes), bytes]));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const match = MIGRATION_TEMP_NAME.exec(entry.name);
    if (!match) continue;
    const expected = byDigest.get(match[1]!);
    if (!expected || !entry.isFile() || entry.isSymbolicLink()) continue;
    const file = join(directory, entry.name);
    if (!(await isOwnedInterruptedTemp(file, expected))) continue;
    await assertMigrationAuthority(authority);
    await assertDirectoryIdentity(directory, directoryIdentity, true);
    await unlink(file);
  }
  await assertMigrationAuthority(authority);
  await assertDirectoryIdentity(directory, directoryIdentity, true);
}

async function cleanupOwnedInterruptedTemps(
  authority: MigrationAuthority,
  records: MigrationRecord[],
): Promise<void> {
  const rootPayloads = [
    journalBytes(records),
    USER_STATE_MARKER_BYTES,
    ...records.filter((record) => !record.relative.includes("/")).map((record) => record.bytes),
  ];
  await cleanupOwnedTempsInDirectory(authority, authority.root.path, rootPayloads);
  const authorizationPayloads = records
    .filter((record) => record.relative.startsWith(`${VIEW_AUTHORIZATION_DIR_NAME}/`))
    .map((record) => record.bytes);
  if (authorizationPayloads.length === 0) return;
  const directory = join(authority.root.path, VIEW_AUTHORIZATION_DIR_NAME);
  try {
    await cleanupOwnedTempsInDirectory(authority, directory, authorizationPayloads);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

async function destinationMatches(authority: MigrationAuthority, record: MigrationRecord): Promise<boolean> {
  await assertMigrationAuthority(authority);
  const root = authority.root.path;
  try {
    await assertPrivateRegularFile(join(root, record.relative));
    const matches = digest(
      await readPrivateStateFile(join(root, record.relative), Buffer.byteLength(record.bytes)),
    ) === record.sha256;
    await assertMigrationAuthority(authority);
    return matches;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertExactStagingTopology(authority: MigrationAuthority, records: MigrationRecord[]): Promise<void> {
  await assertMigrationAuthority(authority);
  const root = authority.root.path;
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
  await assertMigrationAuthority(authority);
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
  let authority: MigrationAuthority;
  if (canonical === "conflict") {
    let raw: string;
    try {
      const parent = await ensureMigrationParent(home);
      const rootIdentity = await captureDirectoryIdentity(root, true);
      authority = { parent, root: { path: root, identity: rootIdentity } };
      await assertMigrationAuthority(authority);
      raw = await readPrivateStateFile(join(root, MIGRATION_JOURNAL_FILE_NAME), MAX_CATALOG_BYTES);
      await assertMigrationAuthority(authority);
    } catch {
      throw new CliError("CONFLICT", "canonical Superbee user state already exists but is not recognized", { help: "superbee setup" });
    }
    const journal = parseJournal(raw);
    if (!journal || raw !== journalBytes(records)) {
      throw new CliError("CONFLICT", "an incomplete or foreign canonical user-state root requires inspection", { help: "superbee setup" });
    }
  } else {
    const parent = await ensureMigrationParent(home);
    try {
      await hooks.beforeCanonicalClaim?.();
      await assertDirectoryIdentity(parent.path, parent.identity, false);
      await mkdir(root, { mode: DIR_MODE });
      authority = {
        parent,
        root: { path: root, identity: await captureDirectoryIdentity(root, true) },
      };
      await assertMigrationAuthority(authority);
    } catch (error) {
      throw new CliError("CONFLICT", "canonical Superbee user state appeared during migration", { help: "superbee setup" });
    }
    await writeNoReplace(authority, MIGRATION_JOURNAL_FILE_NAME, journalBytes(records));
  }

  await cleanupOwnedInterruptedTemps(authority, records).catch(() => {
    throw new CliError("CONFLICT", "canonical Superbee user state changed during migration", { help: "superbee setup" });
  });
  for (const record of records) {
    if (await destinationMatches(authority, record)) continue;
    try {
      await hooks.beforeRecordPublish?.(record.relative);
      await writeNoReplace(authority, record.relative, record.bytes);
    } catch {
      throw new CliError("CONFLICT", "canonical Superbee user state changed during migration", { help: "superbee setup" });
    }
  }
  try {
    await hooks.beforeMarkerPublish?.();
    await assertMigrationAuthority(authority);
    await cleanupOwnedInterruptedTemps(authority, records);
    await assertExactStagingTopology(authority, records);
    await assertSourceUnchanged(home, records);
    await assertMigrationAuthority(authority);
    await writeNoReplace(authority, USER_STATE_MARKER_FILE_NAME, USER_STATE_MARKER_BYTES);
  } catch {
    throw new CliError("CONFLICT", "user state changed during migration; legacy state remains preserved", { help: "superbee setup migrate-state" });
  }
  await assertMigrationAuthority(authority);
  await unlink(join(root, MIGRATION_JOURNAL_FILE_NAME)).catch(() => {});
  await assertMigrationAuthority(authority);
  await chmod(root, DIR_MODE);
  await assertMigrationAuthority(authority);
  return receipt("migrated", true, records);
}
