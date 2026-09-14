import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MIGRATION_INTERRUPTIONS,
  MIGRATION_TOPOLOGIES,
  createMigrationFixture,
  migrationRecoveryContractCases,
  pathExists,
  snapshotTree,
  snapshotVersion,
  type MigrationFixture,
  type MigrationInterruption,
  type MigrationPlanToken,
  type MigrationReceiptToken,
  type MigrationRecoveryDriver,
} from "./migration-recovery-harness.js";

const JOURNAL_VERSION = 1;

interface Journal {
  version: number;
  id: string;
  stage: "prepared" | "moved";
  topology: MigrationFixture["topology"];
  source: string;
  destination: string;
  sourceVersion: string;
  sidecarsBefore: Readonly<Record<string, string | null>>;
  sidecarsAfter: Readonly<Record<string, string | null>>;
}

interface Receipt extends Omit<Journal, "stage"> {
  stage: "complete";
}

class InjectedInterruption extends Error {
  readonly checkpoint: MigrationInterruption;

  constructor(checkpoint: MigrationInterruption) {
    super(`injected interruption at ${checkpoint}`);
    this.checkpoint = checkpoint;
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

class ReferenceMigrationDriver implements MigrationRecoveryDriver {
  readonly fixture: MigrationFixture;
  readonly journalPath: string;
  readonly receiptPath: string;

  constructor(fixture: MigrationFixture) {
    this.fixture = fixture;
    this.journalPath = path.join(fixture.stateRoot, "active.json");
    this.receiptPath = path.join(fixture.stateRoot, "receipt.json");
  }

  async plan(): Promise<MigrationPlanToken> {
    return { sourceVersion: snapshotVersion(await snapshotTree(this.fixture.source)) };
  }

  async apply(plan: MigrationPlanToken, interruptAt?: MigrationInterruption): Promise<MigrationReceiptToken> {
    if (interruptAt === "before-journal") throw new InjectedInterruption(interruptAt);
    if (await pathExists(this.fixture.destination)) throw new Error("destination occupied");
    const currentVersion = snapshotVersion(await snapshotTree(this.fixture.source));
    if (currentVersion !== plan.sourceVersion) throw new Error("source changed after planning");

    const journal: Journal = {
      version: JOURNAL_VERSION,
      id: randomUUID(),
      stage: "prepared",
      topology: this.fixture.topology,
      source: this.fixture.source,
      destination: this.fixture.destination,
      sourceVersion: plan.sourceVersion,
      sidecarsBefore: this.fixture.sidecarBytes,
      sidecarsAfter: this.fixture.canonicalSidecarBytes,
    };
    await this.writeJson(this.journalPath, journal);
    if (interruptAt === "after-journal-before-move") throw new InjectedInterruption(interruptAt);

    await this.move(journal.source, journal.destination);
    if (interruptAt === "after-move-before-receipt") throw new InjectedInterruption(interruptAt);
    journal.stage = "moved";
    await this.writeJson(this.journalPath, journal);
    await this.writeSidecars(journal.sidecarsAfter);
    return this.complete(journal);
  }

  async resume(): Promise<MigrationReceiptToken> {
    const journal = await this.readJournal();
    if (journal.stage === "prepared") {
      const sourceExists = await pathExists(journal.source);
      const destinationExists = await pathExists(journal.destination);
      if (sourceExists && !destinationExists) {
        if (snapshotVersion(await snapshotTree(journal.source)) !== journal.sourceVersion) {
          throw new Error("source changed after journal");
        }
        await this.move(journal.source, journal.destination);
      } else if (!sourceExists && destinationExists) {
        if (snapshotVersion(await snapshotTree(journal.destination)) !== journal.sourceVersion) {
          throw new Error("destination changed after interrupted move");
        }
      } else {
        throw new Error("prepared journal does not match filesystem state");
      }
      journal.stage = "moved";
      await this.writeJson(this.journalPath, journal);
    }
    if ((await pathExists(journal.source)) || !(await pathExists(journal.destination))) {
      throw new Error("moved journal does not match filesystem state");
    }
    if (snapshotVersion(await snapshotTree(journal.destination)) !== journal.sourceVersion) {
      throw new Error("destination changed before receipt");
    }
    await this.writeSidecars(journal.sidecarsAfter);
    return this.complete(journal);
  }

  async rollback(token: MigrationReceiptToken): Promise<void> {
    const receipt = JSON.parse(await readFile(this.receiptPath, "utf8")) as Receipt;
    if (receipt.id !== token.id || receipt.version !== JOURNAL_VERSION) throw new Error("invalid receipt");
    if (await pathExists(receipt.source)) throw new Error("rollback destination occupied");
    if (!(await pathExists(receipt.destination))) throw new Error("migrated bundle missing");
    if (snapshotVersion(await snapshotTree(receipt.destination)) !== receipt.sourceVersion) {
      throw new Error("migrated bundle changed after receipt");
    }
    for (const [target, expected] of Object.entries(receipt.sidecarsAfter)) {
      if (expected === null) {
        if (await pathExists(target)) throw new Error("sidecar changed after receipt");
      } else if ((await readFile(target)).toString("base64") !== expected) {
        throw new Error("sidecar changed after receipt");
      }
    }
    await this.move(receipt.destination, receipt.source);
    await this.writeSidecars(receipt.sidecarsBefore);
  }

  private async readJournal(): Promise<Journal> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.journalPath, "utf8"));
    } catch {
      throw new Error("corrupt migration journal");
    }
    if (!value || typeof value !== "object") throw new Error("corrupt migration journal");
    const candidate = value as Partial<Journal>;
    if (typeof candidate.version !== "number") throw new Error("corrupt migration journal");
    if (candidate.version > JOURNAL_VERSION) throw new Error("unsupported newer migration journal");
    if (
      candidate.version !== JOURNAL_VERSION ||
      typeof candidate.id !== "string" ||
      (candidate.stage !== "prepared" && candidate.stage !== "moved") ||
      !MIGRATION_TOPOLOGIES.includes(candidate.topology as MigrationFixture["topology"]) ||
      typeof candidate.source !== "string" ||
      typeof candidate.destination !== "string" ||
      typeof candidate.sourceVersion !== "string" ||
      !candidate.sidecarsBefore ||
      typeof candidate.sidecarsBefore !== "object" ||
      !candidate.sidecarsAfter ||
      typeof candidate.sidecarsAfter !== "object"
    ) {
      throw new Error("corrupt migration journal");
    }
    return candidate as Journal;
  }

  private async complete(journal: Journal): Promise<MigrationReceiptToken> {
    const receipt: Receipt = { ...journal, stage: "complete" };
    await this.writeJson(this.receiptPath, receipt);
    await rm(this.journalPath);
    return { id: receipt.id };
  }

  private async move(source: string, destination: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    if (this.fixture.topology === "board") git(this.fixture.project, ["worktree", "move", source, destination]);
    else await rename(source, destination);
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  private async writeSidecars(sidecars: Readonly<Record<string, string | null>>): Promise<void> {
    for (const [target, bytes] of Object.entries(sidecars)) {
      if (bytes === null) await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(bytes, "base64"));
      }
    }
  }
}

test("migration harness fixtures cover plain, personal/catalog-bound, in-tree, and dedicated-board bundles", async (t) => {
  for (const topology of MIGRATION_TOPOLOGIES) {
    await t.test(topology, async () => {
      const fixture = await createMigrationFixture(topology);
      try {
        assert.equal(await pathExists(fixture.source), true);
        assert.equal(await pathExists(fixture.destination), false);
        assert.deepEqual(await snapshotTree(fixture.source), fixture.bundleSnapshot);
        assert.deepEqual(await readFile(fixture.unrelatedPath), fixture.unrelatedBytes);
        if (topology === "personal") {
          assert.ok(fixture.bindingPath);
          assert.ok(fixture.canonicalBindingPath);
          assert.ok(fixture.catalogPath);
          assert.match(await readFile(fixture.bindingPath, "utf8"), /\.agentstate-lite/);
          assert.equal(await pathExists(fixture.canonicalBindingPath), false);
          assert.match(await readFile(fixture.catalogPath, "utf8"), /\.agentstate-lite/);
        } else if (topology === "in-tree") {
          assert.equal(execFileSync("git", ["ls-files", ".agentstate-lite"], { cwd: fixture.project, encoding: "utf8" }).trim().length > 0, true);
        } else if (topology === "board") {
          assert.match(await readFile(path.join(fixture.source, ".git"), "utf8"), /^gitdir:/);
          assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: fixture.source, encoding: "utf8" }).trim(), "board");
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

for (const contractCase of migrationRecoveryContractCases()) {
  test(`reference recovery model: ${contractCase.name}`, () =>
    contractCase.run((fixture) => new ReferenceMigrationDriver(fixture)));
}

test("the harness names every required interruption checkpoint", () => {
  assert.deepEqual(MIGRATION_INTERRUPTIONS, [
    "before-journal",
    "after-journal-before-move",
    "after-move-before-receipt",
  ]);
});
