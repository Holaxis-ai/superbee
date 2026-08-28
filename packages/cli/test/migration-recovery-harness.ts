import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const MIGRATION_TOPOLOGIES = ["plain", "personal", "in-tree", "board"] as const;
export type MigrationTopology = (typeof MIGRATION_TOPOLOGIES)[number];

export const MIGRATION_INTERRUPTIONS = [
  "before-journal",
  "after-journal-before-move",
  "after-move-before-receipt",
] as const;
export type MigrationInterruption = (typeof MIGRATION_INTERRUPTIONS)[number];

export interface MigrationFixture {
  topology: MigrationTopology;
  root: string;
  home: string;
  project: string;
  source: string;
  destination: string;
  stateRoot: string;
  bindingPath?: string;
  canonicalBindingPath?: string;
  catalogPath?: string;
  sidecarBytes: SidecarState;
  canonicalSidecarBytes: SidecarState;
  unrelatedPath: string;
  bundleSnapshot: TreeSnapshot;
  unrelatedBytes: Buffer;
  cleanup(): Promise<void>;
}

export interface MigrationPlanToken {
  sourceVersion: string;
}

export interface MigrationReceiptToken {
  id: string;
}

export interface MigrationRecoveryDriver {
  readonly fixture: MigrationFixture;
  readonly journalPath: string;
  readonly receiptPath: string;
  plan(): Promise<MigrationPlanToken>;
  apply(plan: MigrationPlanToken, interruptAt?: MigrationInterruption): Promise<MigrationReceiptToken>;
  resume(): Promise<MigrationReceiptToken>;
  rollback(receipt: MigrationReceiptToken): Promise<void>;
}

export type MigrationRecoveryDriverFactory = (
  fixture: MigrationFixture,
) => MigrationRecoveryDriver | Promise<MigrationRecoveryDriver>;

export interface MigrationRecoveryContractCase {
  name: string;
  run(createDriver: MigrationRecoveryDriverFactory): Promise<void>;
}

export type TreeSnapshot = Readonly<Record<string, string>>;
export type SidecarState = Readonly<Record<string, string | null>>;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "migration-harness",
      GIT_AUTHOR_EMAIL: "migration-harness@example.invalid",
      GIT_COMMITTER_NAME: "migration-harness",
      GIT_COMMITTER_EMAIL: "migration-harness@example.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeBundle(root: string, label: string): Promise<void> {
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "blobs"), { recursive: true });
  await writeFile(path.join(root, "index.md"), "---\nokf_version: 0.1\n---\n\n# Bundle\n", "utf8");
  await writeFile(
    path.join(root, "docs", "one.md"),
    `---\ntype: Note\ntitle: ${label}\ntimestamp: 2026-08-12T12:00:00.000Z\n---\n\nBinary-safe body.\n`,
    "utf8",
  );
  await writeFile(path.join(root, "blobs", "payload.bin"), Buffer.from([0x00, 0x01, 0xfe, 0xff]));
}

async function initializeProject(project: string): Promise<void> {
  await mkdir(project, { recursive: true });
  git(project, ["init", "-q"]);
  git(project, ["checkout", "-q", "-b", "main"]);
  await writeFile(path.join(project, "README.md"), "# Fixture project\n", "utf8");
}

async function createInTreeFixture(project: string, source: string): Promise<void> {
  await initializeProject(project);
  await writeBundle(source, "in-tree");
  git(project, ["add", "README.md", ".agentstate-lite"]);
  git(project, ["commit", "-q", "-m", "seed in-tree bundle"]);
}

async function createBoardFixture(project: string, source: string): Promise<void> {
  await initializeProject(project);
  await writeFile(path.join(project, ".gitignore"), ".agentstate-lite/\n.superbee/\n", "utf8");
  git(project, ["add", "README.md", ".gitignore"]);
  git(project, ["commit", "-q", "-m", "seed project"]);
  git(project, ["worktree", "add", "-q", "--detach", source]);
  git(source, ["checkout", "-q", "--orphan", "board"]);
  git(source, ["rm", "-q", "-rf", "."]);
  await writeBundle(source, "board");
  git(source, ["add", "index.md", "docs", "blobs"]);
  git(source, ["commit", "-q", "-m", "seed board bundle"]);
}

export async function createMigrationFixture(topology: MigrationTopology): Promise<MigrationFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `superbee-migration-${topology}-`)));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const stateRoot = path.join(home, ".agentstate", "migrations", "superbee");
  const unrelatedPath = path.join(root, "unrelated.bin");
  const unrelatedBytes = Buffer.from([0x75, 0x6e, 0x72, 0x65, 0x6c, 0x00, 0xff]);
  await mkdir(home, { recursive: true });
  await writeFile(unrelatedPath, unrelatedBytes);

  let source: string;
  let destination: string;
  let bindingPath: string | undefined;
  let canonicalBindingPath: string | undefined;
  let catalogPath: string | undefined;

  if (topology === "personal") {
    await mkdir(project, { recursive: true });
    source = path.join(home, ".agentstate-lite", "work");
    destination = path.join(home, ".superbee", "work");
    await writeBundle(source, topology);
    bindingPath = path.join(project, ".agentstate.json");
    canonicalBindingPath = path.join(project, ".superbee.json");
    await writeFile(bindingPath, `${JSON.stringify({ bundle: source }, null, 2)}\n`, "utf8");
    catalogPath = path.join(home, ".agentstate", "catalog.json");
    await mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFile(
      catalogPath,
      `${JSON.stringify({ version: 1, entries: [{ label: "work", locator: { kind: "local-path", path: source } }] }, null, 2)}\n`,
      "utf8",
    );
  } else {
    source = path.join(project, ".agentstate-lite");
    destination = path.join(project, ".superbee");
    if (topology === "in-tree") await createInTreeFixture(project, source);
    else if (topology === "board") await createBoardFixture(project, source);
    else {
      await mkdir(project, { recursive: true });
      await writeBundle(source, topology);
    }
  }

  const sidecarBytes: Record<string, string | null> = {};
  const canonicalSidecarBytes: Record<string, string | null> = {};
  for (const target of [bindingPath, catalogPath]) {
    if (target) sidecarBytes[target] = (await readFile(target)).toString("base64");
  }
  if (canonicalBindingPath) sidecarBytes[canonicalBindingPath] = null;
  if (bindingPath && canonicalBindingPath) {
    canonicalSidecarBytes[bindingPath] = null;
    canonicalSidecarBytes[canonicalBindingPath] = Buffer.from(
      `${JSON.stringify({ bundle: destination }, null, 2)}\n`,
    ).toString("base64");
  }
  if (catalogPath) {
    canonicalSidecarBytes[catalogPath] = Buffer.from(
      `${JSON.stringify({ version: 1, entries: [{ label: "work", locator: { kind: "local-path", path: destination } }] }, null, 2)}\n`,
    ).toString("base64");
  }

  return {
    topology,
    root,
    home,
    project,
    source,
    destination,
    stateRoot,
    bindingPath,
    canonicalBindingPath,
    catalogPath,
    sidecarBytes,
    canonicalSidecarBytes,
    unrelatedPath,
    bundleSnapshot: await snapshotTree(source),
    unrelatedBytes,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function walkTree(root: string, relativeDir: string, rows: Record<string, string>): Promise<void> {
  const dir = path.join(root, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
    if (relativePath === ".git") continue;
    const absolutePath = path.join(root, relativePath);
    const stat = await lstat(absolutePath);
    if (stat.isDirectory()) {
      await walkTree(root, relativePath, rows);
    } else if (stat.isSymbolicLink()) {
      rows[relativePath] = `symlink:${await readlink(absolutePath)}`;
    } else if (stat.isFile()) {
      rows[relativePath] = `file:${stat.mode & 0o777}:${(await readFile(absolutePath)).toString("base64")}`;
    } else {
      rows[relativePath] = `other:${stat.mode & 0o777}`;
    }
  }
}

export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const rows: Record<string, string> = {};
  await walkTree(root, "", rows);
  return rows;
}

export function snapshotVersion(snapshot: TreeSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertBundleAt(fixture: MigrationFixture, target: string): Promise<void> {
  assert.deepEqual(await snapshotTree(target), fixture.bundleSnapshot);
  assert.deepEqual(await readFile(fixture.unrelatedPath), fixture.unrelatedBytes);
}

async function assertOriginalSidecars(fixture: MigrationFixture): Promise<void> {
  for (const [target, bytes] of Object.entries(fixture.sidecarBytes)) {
    if (bytes === null) assert.equal(await pathExists(target), false);
    else assert.equal((await readFile(target)).toString("base64"), bytes);
  }
}

async function assertCanonicalSidecars(fixture: MigrationFixture): Promise<void> {
  for (const [target, bytes] of Object.entries(fixture.canonicalSidecarBytes)) {
    if (bytes === null) assert.equal(await pathExists(target), false);
    else assert.equal((await readFile(target)).toString("base64"), bytes);
  }
}

async function withFixture(
  topology: MigrationTopology,
  createDriver: MigrationRecoveryDriverFactory,
  run: (fixture: MigrationFixture, driver: MigrationRecoveryDriver) => Promise<void>,
): Promise<void> {
  const fixture = await createMigrationFixture(topology);
  try {
    await run(fixture, await createDriver(fixture));
  } finally {
    await fixture.cleanup();
  }
}

/**
 * Black-box agreement cases for SB-03's real migrator. The production adapter may call code
 * directly or drive a child CLI; it only has to expose deterministic kill points and its
 * journal/receipt locations. Keeping the assertions here prevents the implementation unit from
 * quietly weakening or rebuilding the pre-implementation contract.
 */
export function migrationRecoveryContractCases(): readonly MigrationRecoveryContractCase[] {
  const cases: MigrationRecoveryContractCase[] = [
    {
      name: "interruption before journal leaves no migration authority or moved bytes",
      run: (createDriver) =>
        withFixture("plain", createDriver, async (fixture, driver) => {
          const plan = await driver.plan();
          await assert.rejects(() => driver.apply(plan, "before-journal"));
          assert.equal(await pathExists(driver.journalPath), false);
          assert.equal(await pathExists(driver.receiptPath), false);
          assert.equal(await pathExists(fixture.destination), false);
          await assertBundleAt(fixture, fixture.source);
          await assertOriginalSidecars(fixture);
        }),
    },
  ];

  for (const topology of MIGRATION_TOPOLOGIES) {
    cases.push({
      name: `${topology}: interruption after journal resumes without losing bytes`,
      run: (createDriver) =>
        withFixture(topology, createDriver, async (fixture, driver) => {
          const plan = await driver.plan();
          await assert.rejects(() => driver.apply(plan, "after-journal-before-move"));
          assert.equal(await pathExists(driver.journalPath), true);
          assert.equal(await pathExists(fixture.source), true);
          assert.equal(await pathExists(fixture.destination), false);
          await assertOriginalSidecars(fixture);
          const receipt = await driver.resume();
          assert.ok(receipt.id);
          assert.equal(await pathExists(driver.journalPath), false);
          if (process.platform !== "win32") {
            assert.equal((await stat(driver.receiptPath)).mode & 0o777, 0o600);
          }
          await assertBundleAt(fixture, fixture.destination);
          await assertCanonicalSidecars(fixture);
        }),
    });
    cases.push({
      name: `${topology}: interruption after move resumes, then receipt rollback restores exact bytes`,
      run: (createDriver) =>
        withFixture(topology, createDriver, async (fixture, driver) => {
          const plan = await driver.plan();
          await assert.rejects(() => driver.apply(plan, "after-move-before-receipt"));
          assert.equal(await pathExists(fixture.source), false);
          assert.equal(await pathExists(fixture.destination), true);
          await assertBundleAt(fixture, fixture.destination);
          const receipt = await driver.resume();
          await assertCanonicalSidecars(fixture);
          await driver.rollback(receipt);
          assert.equal(await pathExists(fixture.destination), false);
          await assertBundleAt(fixture, fixture.source);
          await assertOriginalSidecars(fixture);
        }),
    });
  }

  for (const journalCase of [
    { name: "corrupt", bytes: "not-json\n" },
    { name: "newer", bytes: `${JSON.stringify({ version: Number.MAX_SAFE_INTEGER })}\n` },
  ] as const) {
    cases.push({
      name: `${journalCase.name} journal refuses recovery without changing bundle or unrelated bytes`,
      run: (createDriver) =>
        withFixture("plain", createDriver, async (fixture, driver) => {
          const plan = await driver.plan();
          await assert.rejects(() => driver.apply(plan, "after-journal-before-move"));
          await writeFile(driver.journalPath, journalCase.bytes, { mode: 0o600 });
          await assert.rejects(() => driver.resume());
          assert.equal(await pathExists(fixture.destination), false);
          await assertBundleAt(fixture, fixture.source);
          await assertOriginalSidecars(fixture);
        }),
    });
  }

  cases.push(
    {
      name: "source/version drift after planning refuses before journal or move",
      run: (createDriver) =>
        withFixture("plain", createDriver, async (fixture, driver) => {
          const plan = await driver.plan();
          await writeFile(path.join(fixture.source, "docs", "one.md"), "changed after planning\n", "utf8");
          await assert.rejects(() => driver.apply(plan));
          assert.equal(await pathExists(driver.journalPath), false);
          assert.equal(await pathExists(fixture.destination), false);
          assert.deepEqual(await readFile(fixture.unrelatedPath), fixture.unrelatedBytes);
          await assertOriginalSidecars(fixture);
        }),
    },
    {
      name: "an occupied rollback destination refuses without overwriting either tree",
      run: (createDriver) =>
        withFixture("plain", createDriver, async (fixture, driver) => {
          const receipt = await driver.apply(await driver.plan());
          await mkdir(fixture.source, { recursive: true });
          const occupant = path.join(fixture.source, "foreign.txt");
          await writeFile(occupant, "foreign occupant\n", "utf8");
          await assert.rejects(() => driver.rollback(receipt));
          assert.equal(await readFile(occupant, "utf8"), "foreign occupant\n");
          await assertBundleAt(fixture, fixture.destination);
        }),
    },
    {
      name: "post-receipt sidecar drift refuses rollback without moving the bundle",
      run: (createDriver) =>
        withFixture("personal", createDriver, async (fixture, driver) => {
          const receipt = await driver.apply(await driver.plan());
          assert.ok(fixture.canonicalBindingPath);
          await writeFile(fixture.canonicalBindingPath, '{"bundle":"changed-after-receipt"}\n', "utf8");
          await assert.rejects(() => driver.rollback(receipt));
          assert.equal(await pathExists(fixture.source), false);
          await assertBundleAt(fixture, fixture.destination);
          assert.equal(
            await readFile(fixture.canonicalBindingPath, "utf8"),
            '{"bundle":"changed-after-receipt"}\n',
          );
        }),
    },
  );
  return cases;
}
