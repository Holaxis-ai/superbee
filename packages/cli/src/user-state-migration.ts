import { currentPrivateStateHost, distributionBinName, currentDistribution, currentHost } from "./runtime-context.js";
// Explicit, one-shot migration from Superbee's historical operational-state root into its one
// canonical root. This module is imported only by `setup`; ordinary state readers stay single-root.
import { createHash } from "node:crypto";
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
import { basename, dirname, join } from "node:path";

import { parseCatalog } from "./catalog.js";
import { CATALOG_FILE_NAME } from "./catalog.js";
import { assertMigratableCredentials, CRED_FILE_NAME } from "./credentials.js";
import { CliError } from "./errors.js";
import {
  canonicalUserStateDir,
  ensureStateRootGitignore,
  homeRelativeDisplay,
  hasExactUserStateMarker,
  inspectCanonicalUserStateRoot,
  inspectCanonicalUserStateRootDetail,
  legacyUserStateDir,
  readPrivateStateFile,
  resolveUserStatePolicy,
  userStateEnvironment,
  supersededUserStateDirs,
  type UserStateInput,
  userStatePathDisplay,
  USER_STATE_HARDEN_COMMAND,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
  USER_STATE_MIGRATION_JOURNAL_FILE_NAME,
  USER_STATE_QUARANTINE_COMMAND,
} from "./user-state.js";
import { SYNC_EXPORTS_DIR_NAME } from "@superbee/board-git";
import { SYNC_STATE_DIR_NAME } from "./cursor.js";
import { assertMigratableViewAuthorization } from "./ui/view-authorizations.js";

const VIEW_AUTHORIZATION_DIR_NAME = "view-authorizations";
const MIGRATION_JOURNAL_FILE_NAME = USER_STATE_MIGRATION_JOURNAL_FILE_NAME;
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
    sync_state: "left_in_legacy_root" | "absent";
    ephemeral_state: "left_in_legacy_root" | "absent";
  };
  legacy_preserved: true;
  /**
   * Where the legacy state stays, and how many sync conflict copies (the losing versions of
   * conflicted board documents) sit under it. Migration copies none of them.
   */
  left_behind: {
    roots: string[];
    /** A lower bound unless `scan` is "complete". */
    conflict_copies: number;
    conflict_copies_at: string[];
    scan: "complete" | "partial";
    /** Why a scan is partial: truncation, unreadable data, or a symlink that was not followed. */
    notes: string[];
  };
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
  /** Test seam after the marker is published and immediately before the journal is unlinked. */
  afterMarkerPublish?: () => void | Promise<void>;
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

async function assertPrivateDirectory(directory: string, input: UserStateInput): Promise<void> {
  const status = await lstat(directory);
  const policy = resolveUserStatePolicy(input);
  const currentUid = currentPrivateStateHost().enforcePrivateMode ? currentPrivateStateHost().currentUid() : undefined;
  if (
    status.isSymbolicLink()
    || !status.isDirectory()
    || (currentPrivateStateHost().enforcePrivateMode && (status.mode & 0o077) !== 0)
    || (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error("legacy private state directory is unsafe");
  }
}

async function assertPrivateRegularFile(file: string, input: UserStateInput): Promise<void> {
  const status = await lstat(file);
  const policy = resolveUserStatePolicy(input);
  const currentUid = currentPrivateStateHost().enforcePrivateMode ? currentPrivateStateHost().currentUid() : undefined;
  if (
    status.isSymbolicLink()
    || !status.isFile()
    || (currentPrivateStateHost().enforcePrivateMode && (status.mode & 0o077) !== 0)
    || (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error("private state file is unsafe");
  }
}

async function optionalRecord(root: string, relative: string, maxBytes: number, validate: (raw: string) => void, input: UserStateInput): Promise<MigrationRecord | null> {
  const file = join(root, relative);
  try {
    const bytes = await readPrivateStateFile(file, maxBytes, undefined, input);
    validate(bytes);
    return { relative, bytes, sha256: digest(bytes) };
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

async function preflightDurableRecords(root: string, input: UserStateInput): Promise<MigrationRecord[]> {
  const records: MigrationRecord[] = [];
  const catalog = await optionalRecord(root, CATALOG_FILE_NAME, MAX_CATALOG_BYTES, (raw) => {
    parseCatalog(raw, "legacy catalog");
  }, input);
  if (catalog) {
    records.push(catalog);
  }
  const credentials = await optionalRecord(root, CRED_FILE_NAME, MAX_CREDENTIAL_BYTES, assertMigratableCredentials, input);
  if (credentials) {
    records.push(credentials);
  }

  const authorizationDir = join(root, VIEW_AUTHORIZATION_DIR_NAME);
  let entries;
  try {
    await assertPrivateDirectory(authorizationDir, input);
    entries = await readdir(authorizationDir, { withFileTypes: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return records;
    throw error;
  }
  if (entries.length > MAX_AUTHORIZATION_RECORDS) throw new Error("legacy View authorization store exceeds its record limit");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("legacy View authorization store contains a non-regular entry");
    const relative = `${VIEW_AUTHORIZATION_DIR_NAME}/${entry.name}`;
    const record = await optionalRecord(root, relative, MAX_AUTHORIZATION_BYTES, (raw) => assertMigratableViewAuthorization(entry.name, raw), input);
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
export function migrationSourceRoots(input:UserStateInput):string[] {return currentPrivateStateHost().migrationSources(userStateEnvironment(input)).map(source=>source.root);}

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
function sourceInspectionCommand(display:string,_input:UserStateInput,detailed:boolean):string {
   return currentPrivateStateHost().sourceInspectionCommand(display,detailed,`${distributionBinName()} setup`);
}

async function preflightSourceRoot(
  root: string,
  display: string,
  input: UserStateInput,
  requiresMarker: boolean,
): Promise<MigrationRecord[]> {
  let status;
  try {
    status = await lstat(root);
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw new UnsafeMigrationSource(display, "cannot be inspected", sourceInspectionCommand(display, input, false));
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new UnsafeMigrationSource(display, "exists but is not a real directory", sourceInspectionCommand(display, input, false));
  }
  try {
    const records = await preflightDurableRecords(root, input);
    if (requiresMarker && records.length > 0 && !(await hasExactUserStateMarker(root, input))) {
      throw new Error("historical Superbee source has no exact ownership marker");
    }
    if (records.length > 0) await assertPrivateDirectory(root, input);
    return records;
  } catch (error) {
    if (error instanceof UnsafeMigrationSource) throw error;
    throw new UnsafeMigrationSource(
      display,
      "holds operational state that is not safe to migrate automatically",
      sourceInspectionCommand(display, input, true),
    );
  }
}

async function preflightLegacy(input: UserStateInput): Promise<MigrationRecord[]> {
  const policy = resolveUserStatePolicy(input);
  const merged: MigrationRecord[] = [];
  const claimed = new Set<string>();
  for (const {root,display,requiresMarker} of currentPrivateStateHost().migrationSources(userStateEnvironment(input))) {
    for (const record of await preflightSourceRoot(root, display, input, requiresMarker)) {
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

async function interruptedMigrationRecords(input: UserStateInput): Promise<MigrationRecord[] | null> {
  try {
    const records = await preflightLegacy(input);
    await assertOwnedInterruptedStaging(canonicalUserStateDir(input), records, input);
    return records;
  } catch {
    return null;
  }
}

export async function inspectUserStateMigration(input: UserStateInput = homedir()): Promise<UserStateMigrationInspection> {
  const policy = resolveUserStatePolicy(input);
  if (policy.state === "blocked") {
    return {
      state: "blocked",
      reason: policy.reason ?? "the selected host private-state location is unavailable",
      records: 0,
      command: "superbee setup",
    };
  }
  const canonical = await inspectCanonicalUserStateRootDetail(input);
  if (canonical.state === "ready") {
    // Recognized and usable. Loose permissions are drift this product repairs on its next write,
    // so the exit node is the repair — never the quarantine a foreign root gets.
    return canonical.hardening === "loose"
      ? {
          state: "repairable",
          reason: "the canonical Superbee user-state root is recognized but its permissions are group- or world-accessible",
          records: 0,
          command: `${distributionBinName()} setup harden-state`,
        }
      : { state: "ready", reason: "the canonical Superbee user-state root is ready", records: 0 };
  }
  if (canonical.state === "conflict") {
    // A root left by an interrupted migration is this product's own staging, and rerunning
    // migrate-state resumes it. Only a root that fails the same journal proof the migration
    // applies is genuinely unrecognized.
    const interrupted = await interruptedMigrationRecords(input);
    if (interrupted !== null) {
      return {
        state: "migratable",
        reason: "an interrupted state migration can be resumed; legacy state is intact",
        records: interrupted.length,
      };
    }
    return {
      state: "blocked",
      reason: "the canonical Superbee user-state root is unrecognized",
      records: 0,
      command: `${distributionBinName()} setup quarantine-state`,
    };
  }
  try {
    const records = await preflightLegacy(input);
    return records.length === 0
      ? { state: "fresh", reason: "no legacy operational state requires migration", records: 0 }
      : { state: "migratable", reason: "validated legacy operational state is ready to migrate", records: records.length };
  } catch (error) {
    return { state: "blocked", records: 0, ...blockedSource(error) };
  }
}

async function ensureMigrationParent(input: UserStateInput): Promise<void> {
  const parent = dirname(canonicalUserStateDir(input));
  try {
    await mkdir(parent, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  // POSIX lands directly under $HOME; Windows lands under its absolute user-local known folder.
  // Only the canonical leaf must be a real, non-symlink directory.
  if (!(await stat(parent)).isDirectory()) throw new Error("canonical state parent is unsafe");
}

/**
 * A staging temporary's name is a pure function of the destination it stages, so the set of
 * temporaries this migration can ever create is fixed by the record set — which the journal
 * records durably BEFORE any record temporary exists. Ownership of a temporary is therefore
 * derivable, never inferred from a name pattern.
 */
function migrationTemporaryPath(root: string, relative: string): string {
  const digest = createHash("sha256").update(relative).digest("hex").slice(0, 24);
  return join(root, dirname(relative), `.migration-${digest}.tmp`);
}

/**
 * `writeNoReplace` unlinks its own temporary in a `finally`, but a kill between the create and that
 * unlink — SIGKILL, Ctrl-C, sleep, OOM — leaves one behind, and `assertExactStagingTopology` then
 * rejects the root on every later run. No marker has been published at that point, so the leftover
 * bricks private state product-wide rather than merely stalling migration.
 *
 * Cleanup authority binds to RECORDED OWNERSHIP: the caller has already proven this root is this
 * migration's own staging — a journal that parses and names exactly this record set, or a root this
 * process exclusively created — and only the temporaries that record set (plus the marker) can
 * reach are unlinked, each at its one derived path. A pattern-matching file at any other name is
 * not ours to touch: it stays, and the exactness assertion refuses the root. The residual is stated
 * plainly: a regular file someone else placed at one of OUR derived paths is indistinguishable from
 * our own interrupted temporary and is unlinked — provenance is derived, not verified; the root is
 * 0700 and same-uid, and a temporary's bytes are transient by definition. Best-effort by design:
 * a survivor trips that assertion rather than being quietly published over.
 */
async function sweepOwnedStagingTemporaries(root: string, records: MigrationRecord[]): Promise<void> {
  const owned = [MIGRATION_JOURNAL_FILE_NAME, ...records.map((record) => record.relative), USER_STATE_MARKER_FILE_NAME];
  for (const relative of owned) {
    const temporary = migrationTemporaryPath(root, relative);
    const status = await lstat(temporary).catch(() => null);
    if (!status?.isFile()) continue;
    await unlink(temporary).catch(() => {});
  }
}

async function writeNoReplace(root: string, relative: string, bytes: string, input: UserStateInput): Promise<void> {
  const policy = resolveUserStatePolicy(input);
  const destination = join(root, relative);
  const directory = dirname(destination);
  if (directory !== root) {
    try {
      await mkdir(directory, { mode: DIR_MODE });
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    await assertPrivateDirectory(directory, input);
  }
  const temporary = migrationTemporaryPath(root, relative);
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(bytes);
    if (currentPrivateStateHost().enforcePrivateMode) await handle.chmod(FILE_MODE);
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

/**
 * A kill between marker publication and the journal unlink leaves a marker-proven, complete root
 * that still carries its journal and has not yet published its `.gitignore`. Readers ignore the
 * journal (`preflightDurableRecords` reads known names only), so the root is usable; the next run
 * removes the journal here and the ready path re-ensures the `.gitignore`. Only a file that parses
 * as this module's own journal is touched — anything else at that name is left for inspection.
 */
async function removeStaleJournal(root: string, input: UserStateInput): Promise<void> {
  const path = join(root, MIGRATION_JOURNAL_FILE_NAME);
  const raw = await readPrivateStateFile(path, MAX_CATALOG_BYTES, undefined, input).catch(() => null);
  if (raw === null || parseJournal(raw) === null) return;
  await unlink(path).catch(() => {});
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

async function destinationMatches(root: string, record: MigrationRecord, input: UserStateInput): Promise<boolean> {
  try {
    await assertPrivateRegularFile(join(root, record.relative), input);
    return digest(await readPrivateStateFile(join(root, record.relative), Buffer.byteLength(record.bytes), undefined, input)) === record.sha256;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * `partial` is the read-only proof's allowance for an interrupted root: a record destination may
 * not exist yet, and the one derived temporary path per owned name may exist as a regular file,
 * because the migration sweeps exactly those before it writes. The mutating path asserts after
 * the sweep and after every record is published, with no allowance.
 */
async function assertExactStagingTopology(
  root: string,
  records: MigrationRecord[],
  input: UserStateInput,
  partial = false,
): Promise<void> {
  await assertPrivateDirectory(root, input);
  const rootTemporaries = new Set<string>();
  const authorizationTemporaries = new Set<string>();
  if (partial) {
    for (const relative of [MIGRATION_JOURNAL_FILE_NAME, ...records.map((record) => record.relative), USER_STATE_MARKER_FILE_NAME]) {
      (relative.includes("/") ? authorizationTemporaries : rootTemporaries).add(basename(migrationTemporaryPath(root, relative)));
    }
  }
  const rootAllowed = new Set<string>([MIGRATION_JOURNAL_FILE_NAME, ...rootTemporaries]);
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
  for (const entry of rootEntries) {
    if (rootTemporaries.has(entry.name) && (!entry.isFile() || entry.isSymbolicLink())) {
      throw new Error("canonical migration root has a non-regular staging temporary");
    }
  }
  const present = (name: string): boolean => rootEntries.some((entry) => entry.name === name);
  await assertPrivateRegularFile(join(root, MIGRATION_JOURNAL_FILE_NAME), input);
  for (const record of records.filter((candidate) => !candidate.relative.includes("/"))) {
    if (partial && !present(record.relative)) continue;
    await assertPrivateRegularFile(join(root, record.relative), input);
  }
  if (authorizationNames.size > 0 && !(partial && !present(VIEW_AUTHORIZATION_DIR_NAME))) {
    const directory = join(root, VIEW_AUTHORIZATION_DIR_NAME);
    await assertPrivateDirectory(directory, input);
    const all = await readdir(directory, { withFileTypes: true });
    const entries = all.filter((entry) => !authorizationTemporaries.has(entry.name));
    if (
      all.some((entry) => authorizationTemporaries.has(entry.name) && (!entry.isFile() || entry.isSymbolicLink()))
      || (!partial && entries.length !== authorizationNames.size)
      || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !authorizationNames.has(entry.name))
    ) {
      throw new Error("canonical View authorization staging contains an unexpected entry");
    }
    for (const entry of entries) await assertPrivateRegularFile(join(directory, entry.name), input);
  }
}

/**
 * The one read-only proof that a non-recognized canonical root is this migration's own interrupted
 * staging: a private root, a journal naming exactly the current legacy record set, every present
 * destination byte-identical to its record, and no entry beyond the exact topology (owned
 * temporaries tolerated). Inspect and migrate both apply it, so `setup` never offers a command
 * `migrate-state` will refuse.
 */
async function assertOwnedInterruptedStaging(root: string, records: MigrationRecord[], input: UserStateInput): Promise<void> {
  if (records.length === 0) throw new Error("no legacy records to resume");
  await assertPrivateDirectory(root, input);
  const raw = await readPrivateStateFile(join(root, MIGRATION_JOURNAL_FILE_NAME), MAX_CATALOG_BYTES, undefined, input);
  if (!parseJournal(raw) || raw !== journalBytes(records)) throw new Error("migration journal does not match");
  await assertExactStagingTopology(root, records, input, true);
  for (const record of records) {
    if (!(await lstat(join(root, record.relative)).catch(() => null))) continue;
    if (!(await destinationMatches(root, record, input))) throw new Error("staged record differs from its source");
  }
}

async function assertSourceUnchanged(input: UserStateInput, expected: MigrationRecord[]): Promise<void> {
  const current = await preflightLegacy(input);
  if (journalBytes(current) !== journalBytes(expected)) throw new Error("legacy operational state changed during migration");
}

const MAX_CONFLICT_COPY_FILES = 10_000;
const MAX_CONFLICT_COPY_DIRECTORIES = 2_000;
const MAX_LEFT_BEHIND_NOTES = 20;

interface ConflictScan {
  files: number;
  directories: number;
  limited: boolean;
  notes: string[];
}

/** Counts regular files only. Symlinks are never followed; truncation and unreadable data are named. */
async function countConflictFiles(directory: string, label: string, scan: ConflictScan): Promise<void> {
  if (scan.limited) return;
  if (scan.directories >= MAX_CONFLICT_COPY_DIRECTORIES) {
    scan.limited = true;
    scan.notes.push(`${label} not scanned: directory limit of ${MAX_CONFLICT_COPY_DIRECTORIES} reached`);
    return;
  }
  scan.directories += 1;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errno(error) !== "ENOENT") scan.notes.push(`${label} could not be read (${errno(error) ?? "error"}); copies under it are not counted`);
    return;
  }
  for (const entry of entries) {
    if (scan.limited) return;
    if (entry.isDirectory()) {
      await countConflictFiles(join(directory, entry.name), `${label}/${entry.name}`, scan);
    } else if (entry.isFile()) {
      if (scan.files >= MAX_CONFLICT_COPY_FILES) {
        scan.limited = true;
        scan.notes.push(`${label} not fully counted: file limit of ${MAX_CONFLICT_COPY_FILES} reached`);
        return;
      }
      scan.files += 1;
    } else if (entry.isSymbolicLink()) {
      scan.notes.push(`${label}/${entry.name} is a symlink and was not followed`);
    }
  }
}

/** The legacy roots that still exist, and the conflict copies under them that migration leaves in place. */
async function leftBehind(input: UserStateInput): Promise<UserStateMigrationReceipt["left_behind"]> {
  const roots: string[] = [];
  const copiesAt: string[] = [];
  const notes: string[] = [];
  let copies = 0;
  for (const { root, display } of currentPrivateStateHost().migrationSources(userStateEnvironment(input))) {
    let status;
    try {
      status = await lstat(root);
    } catch (error) {
      if (errno(error) !== "ENOENT") {
        roots.push(display);
        notes.push(`${display} could not be inspected (${errno(error) ?? "error"})`);
      }
      continue;
    }
    roots.push(display);
    if (!status.isDirectory()) {
      notes.push(`${display} is ${status.isSymbolicLink() ? "a symlink" : "not a directory"} and was not scanned`);
      continue;
    }
    // Each root has its own budget so one large root cannot hide another.
    const scan: ConflictScan = { files: 0, directories: 0, limited: false, notes };
    let label = display;
    let directory = root;
    let blocked = false;
    for (const name of [SYNC_STATE_DIR_NAME, SYNC_EXPORTS_DIR_NAME]) {
      directory = join(directory, name);
      label = `${label}/${name}`;
      const step = await lstat(directory).catch(() => null);
      if (!step) { blocked = true; break; }
      if (!step.isDirectory()) {
        notes.push(`${label} is ${step.isSymbolicLink() ? "a symlink and was not followed" : "not a directory"}`);
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    await countConflictFiles(directory, label, scan);
    if (scan.files > 0) {
      copies += scan.files;
      copiesAt.push(label);
    }
  }
  const omitted = notes.length - MAX_LEFT_BEHIND_NOTES;
  const shown = omitted > 0 ? [...notes.slice(0, MAX_LEFT_BEHIND_NOTES), `${omitted} more notes omitted`] : notes;
  return { roots, conflict_copies: copies, conflict_copies_at: copiesAt, scan: notes.length === 0 ? "complete" : "partial", notes: shown };
}

async function receipt(
  status: UserStateMigrationReceipt["status"],
  changed: boolean,
  records: MigrationRecord[],
  input: UserStateInput,
): Promise<UserStateMigrationReceipt> {
  const present: "unchanged" | "migrated" = status === "already_current" ? "unchanged" : "migrated";
  const behind = await leftBehind(input);
  const legacyState = behind.roots.length > 0 ? "left_in_legacy_root" : "absent";
  return {
    schema_version: 1,
    status,
    changed,
    records: {
      catalog: records.some((record) => record.relative === CATALOG_FILE_NAME) ? present : "absent",
      credentials: records.some((record) => record.relative === CRED_FILE_NAME) ? present : "absent",
      view_authorizations: records.filter((record) => record.relative.startsWith(`${VIEW_AUTHORIZATION_DIR_NAME}/`)).length,
      sync_state: legacyState,
      ephemeral_state: legacyState,
    },
    legacy_preserved: true,
    left_behind: behind,
    next: { command: "superbee setup" },
  };
}

export async function migrateUserState(
  input: UserStateInput = homedir(),
  hooks: UserStateMigrationHooks = {},
): Promise<UserStateMigrationReceipt> {
  const policy = resolveUserStatePolicy(input);
  if (policy.state === "blocked") {
    throw new CliError("CONFLICT", policy.reason ?? "the selected host private-state location is unavailable", { help: `${distributionBinName()} setup` });
  }
  const canonical = await inspectCanonicalUserStateRoot(input);
  const root = canonicalUserStateDir(input);
  if (canonical === "ready") {
    const current = await preflightDurableRecords(root, input).catch(() => {
      throw new CliError("CONFLICT", "canonical Superbee user state contains an invalid durable record", { help: `${distributionBinName()} setup` });
    });
    await removeStaleJournal(root, input);
    await ensureStateRootGitignore(root, input);
    return receipt("already_current", false, current, input);
  }

  const records = await preflightLegacy(input).catch((error: unknown) => {
    const blocked = blockedSource(error);
    throw new CliError("CONFLICT", blocked.reason, { help: blocked.command });
  });
  if (records.length === 0 && canonical === "absent") return receipt("nothing_to_migrate", false, [], input);
  if (canonical === "conflict") {
    try {
      await assertOwnedInterruptedStaging(root, records, input);
    } catch {
      throw new CliError("CONFLICT", "canonical Superbee user state already exists but is not this migration's own staging", {
        help: `${distributionBinName()} setup quarantine-state`,
      });
    }
  } else {
    await ensureMigrationParent(input);
    try {
      await hooks.beforeCanonicalClaim?.();
      await mkdir(root, { mode: DIR_MODE });
    } catch (error) {
      throw new CliError("CONFLICT", "canonical Superbee user state appeared during migration", { help: `${distributionBinName()} setup` });
    }
    await writeNoReplace(root, MIGRATION_JOURNAL_FILE_NAME, journalBytes(records), input);
  }
  // Ownership is durable from here: the journal validated as this migration's own staging, or this
  // process exclusively created the root and wrote it. That proof — not the file name — is what
  // authorizes clearing an interrupted predecessor's leftovers.
  await sweepOwnedStagingTemporaries(root, records);

  for (const record of records) {
    if (await destinationMatches(root, record, input)) continue;
    try {
      await hooks.beforeRecordPublish?.(record.relative);
      await writeNoReplace(root, record.relative, record.bytes, input);
    } catch {
      throw new CliError("CONFLICT", "canonical Superbee user state changed during migration", { help: `${distributionBinName()} setup` });
    }
  }
  try {
    await hooks.beforeMarkerPublish?.();
    await assertExactStagingTopology(root, records, input);
    await assertSourceUnchanged(input, records);
    await writeNoReplace(root, USER_STATE_MARKER_FILE_NAME, USER_STATE_MARKER_BYTES, input);
  } catch {
    // A real exit node, never a bare rerun of the command that just failed: the half-built
    // canonical root is what blocks the retry, and legacy state is preserved either way.
    throw new CliError(
      "CONFLICT",
      "user state changed during migration; legacy state remains preserved",
      { help: `${distributionBinName()} setup quarantine-state` },
    );
  }
  await hooks.afterMarkerPublish?.();
  await unlink(join(root, MIGRATION_JOURNAL_FILE_NAME)).catch(() => {});
  if (currentPrivateStateHost().enforcePrivateMode) await chmod(root, DIR_MODE);
  // The exact-topology assertions above are over, so the promised `*` .gitignore can finally be
  // published: a migrated root must be as unstageable as one created by `ensureUserStateRoot`.
  await ensureStateRootGitignore(root, input);
  return receipt("migrated", true, records, input);
}
