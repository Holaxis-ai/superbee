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
  hasExactUserStateMarker,
  inspectCanonicalUserStateRoot,
  inspectCanonicalUserStateRootDetail,
  LEGACY_BRIDGE_PACKAGE_NAME,
  legacyUserStateDir,
  readPrivateStateFile,
  resolveUserStatePolicy,
  supersededUserStateDirs,
  type UserStateInput,
  userStatePathDisplay,
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
  const currentUid = policy.containment === "posix-owner-mode" ? process.getuid?.() : undefined;
  if (
    status.isSymbolicLink()
    || !status.isDirectory()
    || (policy.containment === "posix-owner-mode" && (status.mode & 0o077) !== 0)
    || (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error("legacy private state directory is unsafe");
  }
}

async function assertPrivateRegularFile(file: string, input: UserStateInput): Promise<void> {
  const status = await lstat(file);
  const policy = resolveUserStatePolicy(input);
  const currentUid = policy.containment === "posix-owner-mode" ? process.getuid?.() : undefined;
  if (
    status.isSymbolicLink()
    || !status.isFile()
    || (policy.containment === "posix-owner-mode" && (status.mode & 0o077) !== 0)
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
export function migrationSourceRoots(input: UserStateInput): string[] {
  const policy = resolveUserStatePolicy(input);
  return policy.platform === "win32"
    ? [...new Set([...supersededUserStateDirs(input), legacyUserStateDir(input)])]
    : [...new Set([legacyUserStateDir(input), ...supersededUserStateDirs(input)])];
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
function sourceInspectionCommand(display: string, input: UserStateInput, detailed: boolean): string {
  return resolveUserStatePolicy(input).platform === "win32"
    ? "superbee setup"
    : `ls -l${detailed ? "a" : "d"} ${display}`;
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
  for (const root of migrationSourceRoots(input)) {
    const display = policy.platform === "win32"
      ? userStatePathDisplay(input, root)
      : homeRelativeDisplay(policy.home, root);
    const requiresMarker = policy.platform === "win32" && root !== legacyUserStateDir(input);
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

export async function inspectUserStateMigration(input: UserStateInput = homedir()): Promise<UserStateMigrationInspection> {
  if (staticBuildIdentity().package.name === LEGACY_BRIDGE_PACKAGE_NAME) {
    return { state: "ready", reason: "the separately published Aslite bridge retains its legacy state root", records: 0 };
  }
  const policy = resolveUserStatePolicy(input);
  if (policy.state === "blocked") {
    return {
      state: "blocked",
      reason: policy.reason ?? "the Windows private-state location is unavailable",
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
          command: USER_STATE_HARDEN_COMMAND,
        }
      : { state: "ready", reason: "the canonical Superbee user-state root is ready", records: 0 };
  }
  if (canonical.state === "conflict") {
    return {
      state: "blocked",
      reason: "the canonical Superbee user-state root is unrecognized",
      records: 0,
      command: USER_STATE_QUARANTINE_COMMAND,
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
    if (policy.containment === "posix-owner-mode") await handle.chmod(FILE_MODE);
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

async function assertExactStagingTopology(root: string, records: MigrationRecord[], input: UserStateInput): Promise<void> {
  await assertPrivateDirectory(root, input);
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
  await assertPrivateRegularFile(join(root, MIGRATION_JOURNAL_FILE_NAME), input);
  for (const record of records.filter((candidate) => !candidate.relative.includes("/"))) {
    await assertPrivateRegularFile(join(root, record.relative), input);
  }
  if (authorizationNames.size > 0) {
    const directory = join(root, VIEW_AUTHORIZATION_DIR_NAME);
    await assertPrivateDirectory(directory, input);
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      entries.length !== authorizationNames.size
      || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !authorizationNames.has(entry.name))
    ) {
      throw new Error("canonical View authorization staging contains an unexpected entry");
    }
    for (const name of authorizationNames) await assertPrivateRegularFile(join(directory, name), input);
  }
}

async function assertSourceUnchanged(input: UserStateInput, expected: MigrationRecord[]): Promise<void> {
  const current = await preflightLegacy(input);
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
  input: UserStateInput = homedir(),
  hooks: UserStateMigrationHooks = {},
): Promise<UserStateMigrationReceipt> {
  if (staticBuildIdentity().package.name === LEGACY_BRIDGE_PACKAGE_NAME) {
    throw new CliError("NOT_IMPLEMENTED", "state migration is available only from the Superbee package", { help: "npm install -g superbee" });
  }
  const policy = resolveUserStatePolicy(input);
  if (policy.state === "blocked") {
    throw new CliError("CONFLICT", policy.reason ?? "the Windows private-state location is unavailable", { help: "superbee setup" });
  }
  const canonical = await inspectCanonicalUserStateRoot(input);
  const root = canonicalUserStateDir(input);
  if (canonical === "ready") {
    const current = await preflightDurableRecords(root, input).catch(() => {
      throw new CliError("CONFLICT", "canonical Superbee user state contains an invalid durable record", { help: "superbee setup" });
    });
    await removeStaleJournal(root, input);
    await ensureStateRootGitignore(root, input);
    return receipt("already_current", false, current);
  }

  const records = await preflightLegacy(input).catch((error: unknown) => {
    const blocked = blockedSource(error);
    throw new CliError("CONFLICT", blocked.reason, { help: blocked.command });
  });
  if (records.length === 0 && canonical === "absent") return receipt("nothing_to_migrate", false, []);
  if (canonical === "conflict") {
    let raw: string;
    try {
      await assertPrivateDirectory(root, input);
      raw = await readPrivateStateFile(join(root, MIGRATION_JOURNAL_FILE_NAME), MAX_CATALOG_BYTES, undefined, input);
    } catch {
      throw new CliError("CONFLICT", "canonical Superbee user state already exists but is not recognized", { help: "superbee setup" });
    }
    const journal = parseJournal(raw);
    if (!journal || raw !== journalBytes(records)) {
      throw new CliError("CONFLICT", "an incomplete or foreign canonical user-state root requires inspection", { help: "superbee setup" });
    }
  } else {
    await ensureMigrationParent(input);
    try {
      await hooks.beforeCanonicalClaim?.();
      await mkdir(root, { mode: DIR_MODE });
    } catch (error) {
      throw new CliError("CONFLICT", "canonical Superbee user state appeared during migration", { help: "superbee setup" });
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
      throw new CliError("CONFLICT", "canonical Superbee user state changed during migration", { help: "superbee setup" });
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
      { help: USER_STATE_QUARANTINE_COMMAND },
    );
  }
  await hooks.afterMarkerPublish?.();
  await unlink(join(root, MIGRATION_JOURNAL_FILE_NAME)).catch(() => {});
  if (policy.containment === "posix-owner-mode") await chmod(root, DIR_MODE);
  // The exact-topology assertions above are over, so the promised `*` .gitignore can finally be
  // published: a migrated root must be as unstageable as one created by `ensureUserStateRoot`.
  await ensureStateRootGitignore(root, input);
  return receipt("migrated", true, records);
}
