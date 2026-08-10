// Pure authority for journaled operator-receipt emission/replacement recovery. This module owns
// the canonical slot identity, exact prior-asset authorization, durable no-replace journal/lock,
// revision-checked phase changes, and the mutation state machine. GitHub, credential, signing,
// and receipt-verification effects are injected by release-inspect.mjs.
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

export const SLOT_SCHEMA = "aslite.receipt-recovery-slot.v1";
export const JOURNAL_SCHEMA = "aslite.receipt-recovery-journal.v1";
export const OWNER_SCHEMA = "aslite.receipt-recovery-owner.v1";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const STAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const RECEIPT_NAME = /^receipt-(inspected|approved)-[a-f0-9-]+\.json$/i;
const ASSET_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const PHASES = new Set(["prepared", "delete_ready", "old_absent", "upload_ready", "upload_requested", "converged"]);

function fail(message) {
  throw new Error(`receipt recovery failed: ${message}`);
}

function exactString(name, value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`invalid ${name}`);
  return value;
}

function positiveId(name, value) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`invalid ${name}`);
  return parsed;
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeSlot(input) {
  if (input?.schema !== undefined && input.schema !== SLOT_SCHEMA) fail(`invalid slot schema: ${JSON.stringify(input.schema)}`);
  const decision = input?.decision;
  if (decision !== "inspected" && decision !== "approved") fail(`invalid decision: ${JSON.stringify(decision)}`);
  const slot = {
    schema: SLOT_SCHEMA,
    github_host: exactString("GitHub host", input?.github_host, /^github\.com$/),
    repo: exactString("repository", input?.repo, REPO),
    draft_release_id: String(positiveId("draft release id", input?.draft_release_id)),
    tag: exactString("tag", input?.tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/),
    stage_id: exactString("stage id", input?.stage_id, STAGE_ID),
    version: exactString("version", input?.version, SEMVER),
    tarball_sha256: exactString("tarball SHA-256", input?.tarball_sha256, SHA256),
    decision,
    receipt_name: exactString("receipt name", input?.receipt_name, RECEIPT_NAME),
  };
  if (slot.tag !== `v${slot.version}`) fail(`tag ${slot.tag} does not match version ${slot.version}`);
  if (slot.receipt_name !== `receipt-${decision}-${slot.stage_id}.json`) fail("receipt name does not match decision/stage id");
  return slot;
}

export function canonicalSlotKey(input) {
  return createHash("sha256").update(canonicalJson(normalizeSlot(input))).digest("hex");
}

export function normalizeAssetTriple(input, label = "asset") {
  return {
    id: positiveId(`${label} id`, input?.id ?? input?.asset_id),
    name: exactString(`${label} name`, input?.name, ASSET_NAME),
    digest: exactString(`${label} digest`, input?.digest, SHA256),
  };
}

function sameTriple(left, right) {
  return left.id === right.id && left.name === right.name && left.digest === right.digest;
}

function normalizeReplacement(input, receiptName) {
  if (input === null || input === undefined) return null;
  const triple = normalizeAssetTriple(input, "replacement asset");
  if (triple.name !== receiptName) fail(`replacement name ${triple.name} does not name this receipt slot`);
  return triple;
}

function journalPaths(recoveryDir, key) {
  return {
    journal: path.join(recoveryDir, `${key}.json`),
    owner: path.join(recoveryDir, `${key}.lock`),
  };
}

async function statRegular(file, mode, label) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} is not a regular file: ${file}`);
  if ((info.mode & 0o777) !== mode) fail(`${label} mode must be ${mode.toString(8)}: ${file}`);
  return info;
}

export async function ensureRecoveryDirectory(recoveryDir) {
  if (typeof recoveryDir !== "string" || recoveryDir.length === 0 || !path.isAbsolute(recoveryDir)) {
    fail("recovery directory must be an absolute path");
  }
  try {
    const existing = await lstat(recoveryDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) fail(`recovery path is not a real directory: ${recoveryDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  }
  await chmod(recoveryDir, 0o700);
  const info = await lstat(recoveryDir);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    fail(`recovery directory must be a non-symlink mode-0700 directory: ${recoveryDir}`);
  }
}

async function validateRecoveryDirectoryForDryRun(recoveryDir) {
  if (typeof recoveryDir !== "string" || recoveryDir.length === 0 || !path.isAbsolute(recoveryDir)) {
    fail("recovery directory must be an absolute path");
  }
  try {
    const info = await lstat(recoveryDir);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
      fail(`dry-run recovery path must be absent or a non-symlink mode-0700 directory: ${recoveryDir}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Publish bytes to an absent canonical path without any replacement-capable primitive. */
export async function publishNoReplace(file, bytes) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await link(temporary, file);
    await syncDirectory(directory);
    await unlink(temporary);
    return true;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") return false;
    if (["EPERM", "EOPNOTSUPP", "ENOTSUP", "EXDEV"].includes(error?.code)) {
      fail(`filesystem cannot no-replace publish ${path.basename(file)} (${error.code})`);
    }
    throw error;
  }
}

async function readJsonRecord(file, label) {
  await statRegular(file, 0o600, label);
  const text = await readFile(file, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`${label} is malformed JSON: ${error.message}`);
  }
  return { value, text, digest: sha256Bytes(text) };
}

function normalizeOwner(value) {
  if (value?.schema !== OWNER_SCHEMA || value?.version !== 1) fail("owner record has unknown schema/version");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["hostname", "pid", "schema", "started_at", "token", "version"])) {
    fail("owner record fields are incomplete or unknown");
  }
  if (typeof value.hostname !== "string" || value.hostname.length === 0) fail("owner record has invalid hostname");
  positiveId("owner PID", value.pid);
  if (typeof value.started_at !== "string" || Number.isNaN(Date.parse(value.started_at))) fail("owner record has invalid start time");
  if (typeof value.token !== "string" || !/^[a-f0-9-]{36}$/i.test(value.token)) fail("owner record has invalid token");
  return value;
}

function pidState(pid) {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "ambiguous";
  }
}

async function assertExactOwner(ownerPath, owner) {
  const current = normalizeOwner((await readJsonRecord(ownerPath, "owner record")).value);
  if (
    current.token !== owner.token || current.pid !== owner.pid || current.hostname !== owner.hostname
    || current.started_at !== owner.started_at
  ) fail("execution owner changed");
}

export async function acquireSlotOwner(ownerPath, testHooks = {}) {
  const owner = {
    schema: OWNER_SCHEMA,
    version: 1,
    hostname: hostname(),
    pid: process.pid,
    started_at: new Date().toISOString(),
    token: randomUUID(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await publishNoReplace(ownerPath, canonicalJson(owner))) return owner;
    const occupied = normalizeOwner((await readJsonRecord(ownerPath, "owner record")).value);
    if (occupied.hostname !== owner.hostname) fail(`receipt slot is owned on another host (${occupied.hostname})`);
    const state = pidState(occupied.pid);
    if (state !== "dead") fail(`receipt slot owner PID ${occupied.pid} is ${state}`);
    const aside = `${ownerPath}.stale.${occupied.token}`;
    const reclaimPath = `${ownerPath}.reclaim`;
    if (!await publishNoReplace(reclaimPath, canonicalJson(owner))) continue;
    try {
      const before = (await readJsonRecord(ownerPath, "owner record")).text;
      if (before !== canonicalJson(occupied)) fail("stale owner changed during reclamation");
      if (testHooks.beforeStaleOwnerRename) await testHooks.beforeStaleOwnerRename({ ownerPath, occupied, owner });
      const after = (await readJsonRecord(ownerPath, "owner record")).text;
      if (after !== canonicalJson(occupied)) fail("stale owner changed during reclamation");
      await rename(ownerPath, aside);
      await syncDirectory(path.dirname(ownerPath));
      if (await publishNoReplace(ownerPath, canonicalJson(owner))) {
        await unlink(aside);
        await syncDirectory(path.dirname(ownerPath));
        return owner;
      }
      // A contender won. Preserve the exact stale aside for diagnosis; never erase a journal.
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    } finally {
      await rm(reclaimPath, { force: true }).catch(() => {});
    }
  }
  fail("could not acquire receipt slot owner");
}

async function releaseSlotOwner(ownerPath, owner) {
  await assertExactOwner(ownerPath, owner);
  await unlink(ownerPath);
  await syncDirectory(path.dirname(ownerPath));
}

function normalizeJournal(value, expectedSlot, expectedKey) {
  if (value?.schema !== JOURNAL_SCHEMA || value?.version !== 1) fail("journal has unknown schema/version");
  const journalKeys = ["owner_token", "phase", "prior", "proposed", "remote", "revision", "schema", "slot", "slot_key", "updated_at", "version"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(journalKeys)) fail("journal fields are incomplete or unknown");
  if (value.slot_key !== expectedKey) fail("journal slot key does not match its canonical path");
  if (typeof value.owner_token !== "string" || !/^[a-f0-9-]{36}$/i.test(value.owner_token)) fail("journal has invalid owner token");
  if (typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at))) fail("journal has invalid update time");
  const slot = normalizeSlot(value.slot);
  if (canonicalSlotKey(slot) !== expectedKey || canonicalJson(slot) !== canonicalJson(expectedSlot)) fail("journal names a different receipt slot");
  let prior;
  if (value.prior?.kind === "absent" && Object.keys(value.prior).length === 1) prior = { kind: "absent" };
  else if (
    value.prior?.kind === "existing"
    && JSON.stringify(Object.keys(value.prior).sort()) === JSON.stringify(["asset", "kind"])
    && JSON.stringify(Object.keys(value.prior.asset ?? {}).sort()) === JSON.stringify(["digest", "id", "name"])
  ) prior = { kind: "existing", asset: normalizeAssetTriple(value.prior.asset, "journal prior asset") };
  else fail("journal has invalid prior-slot discriminator");
  if (JSON.stringify(Object.keys(value.proposed ?? {}).sort()) !== JSON.stringify(["actor", "bytes_base64", "digest"])) {
    fail("journal proposed fields are incomplete or unknown");
  }
  const proposed = {
    bytes_base64: value.proposed?.bytes_base64,
    digest: exactString("journal proposed digest", value.proposed?.digest, SHA256),
    actor: exactString("journal actor", value.proposed?.actor, ACTOR),
  };
  if (typeof proposed.bytes_base64 !== "string") fail("journal has no proposed bytes");
  const bytes = Buffer.from(proposed.bytes_base64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== proposed.bytes_base64) fail("journal proposed bytes are not canonical base64");
  if (sha256Bytes(bytes) !== proposed.digest) fail("journal proposed digest does not match bytes");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) fail("journal has invalid revision");
  if (!PHASES.has(value.phase)) fail(`journal has unknown phase ${JSON.stringify(value.phase)}`);
  if (value.remote === null || typeof value.remote !== "object" || Array.isArray(value.remote)) fail("journal remote evidence is invalid");
  return { ...value, slot, prior, proposed, proposedBytes: bytes };
}

async function loadJournal(journalPath, slot, key) {
  try {
    const record = await readJsonRecord(journalPath, "recovery journal");
    return { ...record, journal: normalizeJournal(record.value, slot, key) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function publishJournal(journalPath, journal, slot, key) {
  const published = await publishNoReplace(journalPath, canonicalJson(journal));
  const loaded = await loadJournal(journalPath, slot, key);
  if (!loaded) fail("journal disappeared after publication");
  return { published, loaded };
}

async function rewriteJournal({ journalPath, loaded, ownerPath, owner, slot, key, phase, remote = {} }) {
  await assertExactOwner(ownerPath, owner);
  const current = await loadJournal(journalPath, slot, key);
  if (!current || current.journal.revision !== loaded.journal.revision || current.digest !== loaded.digest) {
    fail("journal revision/digest changed before phase update");
  }
  const next = {
    ...current.journal,
    proposedBytes: undefined,
    revision: current.journal.revision + 1,
    phase,
    remote,
    owner_token: owner.token,
    updated_at: new Date().toISOString(),
  };
  const temporary = `${journalPath}.${owner.token}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(canonicalJson(next));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await assertExactOwner(ownerPath, owner);
  const still = await loadJournal(journalPath, slot, key);
  if (!still || still.digest !== loaded.digest || still.journal.revision !== loaded.journal.revision) {
    await rm(temporary, { force: true });
    fail("journal changed during phase update");
  }
  await rename(temporary, journalPath);
  await syncDirectory(path.dirname(journalPath));
  const committed = await loadJournal(journalPath, slot, key);
  if (!committed || committed.journal.revision !== next.revision || committed.journal.phase !== phase) fail("journal phase update did not commit exactly");
  return committed;
}

async function cleanupJournal({ journalPath, loaded, ownerPath, owner, slot, key }) {
  await assertExactOwner(ownerPath, owner);
  const current = await loadJournal(journalPath, slot, key);
  if (!current || current.digest !== loaded.digest || current.journal.revision !== loaded.journal.revision || current.journal.phase !== "converged") {
    fail("refusing to clean a different or unconverged journal revision");
  }
  await unlink(journalPath);
  await syncDirectory(path.dirname(journalPath));
}

function slotAssets(observation, expectedName) {
  if (!observation?.release || !Array.isArray(observation.slotAssets)) fail("observation is incomplete");
  const assets = observation.slotAssets.filter((asset) => asset?.name === expectedName).map((asset) => normalizeAssetTriple(asset));
  if (assets.length > 1) fail(`duplicate assets occupy receipt slot ${expectedName}`);
  return { assets, raw: observation.slotAssets.filter((asset) => asset?.name === expectedName) };
}

function requireAdapters(adapters) {
  for (const name of ["observe", "createProposal", "verifyProposal", "verifyAsset", "tokenForActor", "proveActor", "deleteAsset", "uploadAsset"]) {
    if (typeof adapters?.[name] !== "function") fail(`missing ${name} adapter`);
  }
}

/**
 * Execute or resume one exact receipt-slot transaction. Every observation adapter call must
 * independently re-prove the repository/release/tag/candidate anchor and return a complete
 * same-name slot inventory; this authority never authorizes mutation from a stale observation.
 */
export async function executeRecoveryTransaction({ slot: inputSlot, replacement: inputReplacement = null, recoveryDir, dryRun = false, adapters }) {
  requireAdapters(adapters);
  const slot = normalizeSlot(inputSlot);
  const replacement = normalizeReplacement(inputReplacement, slot.receipt_name);
  const key = canonicalSlotKey(slot);
  const paths = journalPaths(recoveryDir, key);
  let owner = null;
  let loaded = null;
  let resumed = false;

  if (!dryRun) {
    await ensureRecoveryDirectory(recoveryDir);
    owner = await acquireSlotOwner(paths.owner);
  } else {
    await validateRecoveryDirectoryForDryRun(recoveryDir);
  }

  try {
    loaded = await loadJournal(paths.journal, slot, key);
    resumed = Boolean(loaded);
    let observation = await adapters.observe(slot);
    let occupied = slotAssets(observation, slot.receipt_name);

    if (!loaded) {
      let prior;
      if (occupied.assets.length === 0) {
        if (replacement) fail("replacement was requested but the exact receipt slot is absent");
        prior = { kind: "absent" };
      } else {
        const current = occupied.assets[0];
        const raw = occupied.raw[0];
        if (!replacement) {
          await adapters.verifyAsset(raw, { digest: current.digest, slot });
          return { status: "already_present", mutated: false, asset: current, slot_key: key };
        }
        if (!sameTriple(current, replacement)) fail("existing receipt does not match the explicit replacement identity");
        await adapters.verifyAsset(raw, { digest: current.digest, slot });
        prior = { kind: "existing", asset: current };
      }

      const proposal = await adapters.createProposal(slot);
      const proposedBytes = Buffer.isBuffer(proposal?.bytes) ? proposal.bytes : Buffer.from(proposal?.bytes ?? "");
      const actor = exactString("proposed actor", proposal?.actor, ACTOR);
      if (proposedBytes.length === 0) fail("proposed receipt is empty");
      await adapters.verifyProposal({ ...proposal, bytes: proposedBytes, actor, slot });
      const journal = {
        schema: JOURNAL_SCHEMA,
        version: 1,
        slot_key: key,
        slot,
        prior,
        proposed: { bytes_base64: proposedBytes.toString("base64"), digest: sha256Bytes(proposedBytes), actor },
        revision: 1,
        phase: "prepared",
        remote: {},
        owner_token: dryRun ? null : owner.token,
        updated_at: new Date().toISOString(),
      };
      if (dryRun) {
        return {
          status: prior.kind === "absent" ? "uploaded" : "replaced",
          mutated: false,
          dry_run: true,
          proposed_digest: journal.proposed.digest,
          slot_key: key,
        };
      }
      const publication = await publishJournal(paths.journal, journal, slot, key);
      loaded = publication.loaded;
      if (!publication.published) fail("a different journal won publication while this invocation held ownership");
    } else {
      if (loaded.journal.prior.kind === "absent") {
        if (replacement) fail("replacement authority conflicts with the winning absent journal");
      } else if (!replacement || !sameTriple(loaded.journal.prior.asset, replacement)) {
        fail("invocation does not exactly match the winning replacement journal");
      }
      await adapters.verifyProposal({
        bytes: loaded.journal.proposedBytes,
        actor: loaded.journal.proposed.actor,
        slot,
      });
      if (dryRun) {
        observation = await adapters.observe(slot);
        occupied = slotAssets(observation, slot.receipt_name);
        if (occupied.assets.length === 1 && occupied.assets[0].digest === loaded.journal.proposed.digest) {
          await adapters.verifyAsset(occupied.raw[0], {
            digest: loaded.journal.proposed.digest,
            bytes: loaded.journal.proposedBytes,
            actor: loaded.journal.proposed.actor,
            slot,
          });
          return { status: "resumed", mutated: false, dry_run: true, asset: occupied.assets[0], slot_key: key };
        }
        if (occupied.assets.length === 1) {
          if (loaded.journal.prior.kind !== "existing" || !sameTriple(occupied.assets[0], loaded.journal.prior.asset)) {
            fail("receipt slot contains a competing asset; preserving it");
          }
          await adapters.verifyAsset(occupied.raw[0], { digest: loaded.journal.prior.asset.digest, slot });
        }
        return {
          status: loaded.journal.prior.kind === "existing" ? "replaced" : "uploaded",
          mutated: false,
          dry_run: true,
          proposed_digest: loaded.journal.proposed.digest,
          slot_key: key,
        };
      }
    }

    const journal = () => loaded.journal;
    const proposedExpected = {
      digest: journal().proposed.digest,
      bytes: journal().proposedBytes,
      actor: journal().proposed.actor,
      slot,
    };

    observation = await adapters.observe(slot);
    occupied = slotAssets(observation, slot.receipt_name);
    if (occupied.assets.length === 1 && occupied.assets[0].digest === journal().proposed.digest) {
      await adapters.verifyAsset(occupied.raw[0], proposedExpected);
      loaded = await rewriteJournal({
        journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key, phase: "converged",
        remote: { asset: occupied.assets[0] },
      });
      await cleanupJournal({ journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key });
      return { status: "resumed", mutated: false, asset: occupied.assets[0], slot_key: key };
    }

    let token;
    if (occupied.assets.length === 1) {
      if (journal().prior.kind !== "existing" || !sameTriple(occupied.assets[0], journal().prior.asset)) {
        fail("receipt slot contains a competing asset; preserving it");
      }
      await adapters.verifyAsset(occupied.raw[0], { digest: journal().prior.asset.digest, slot });
      token = await adapters.tokenForActor(journal().proposed.actor);
      await adapters.proveActor(token, journal().proposed.actor);
      loaded = await rewriteJournal({
        journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key, phase: "delete_ready",
        remote: { prior: journal().prior.asset },
      });
      observation = await adapters.observe(slot);
      occupied = slotAssets(observation, slot.receipt_name);
      if (
        occupied.assets.length !== 1
        || !sameTriple(occupied.assets[0], journal().prior.asset)
      ) fail("exact prior receipt changed after credential proof; DELETE is unreachable");
      await adapters.verifyAsset(occupied.raw[0], { digest: journal().prior.asset.digest, slot });
      await assertExactOwner(paths.owner, owner);
      try {
        await adapters.deleteAsset(journal().prior.asset.id, token);
      } catch (error) {
        const afterUnknownDelete = await adapters.observe(slot);
        const afterOccupied = slotAssets(afterUnknownDelete, slot.receipt_name);
        if (afterOccupied.assets.length !== 0) throw error;
      }
      observation = await adapters.observe(slot);
      occupied = slotAssets(observation, slot.receipt_name);
      if (occupied.assets.length !== 0) fail("receipt slot did not become empty after exact deletion");
      loaded = await rewriteJournal({
        journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key, phase: "old_absent",
        remote: { prior_absent: true },
      });
    } else if (journal().prior.kind === "existing") {
      // DELETE acknowledgement loss, a 404 after a concurrent exact delete, or crash recovery.
      loaded = await rewriteJournal({
        journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key, phase: "old_absent",
        remote: { prior_absent: true },
      });
    }

    observation = await adapters.observe(slot);
    occupied = slotAssets(observation, slot.receipt_name);
    if (occupied.assets.length !== 0) fail("receipt slot changed before upload; preserving the competing asset");
    if (!token) token = await adapters.tokenForActor(journal().proposed.actor);
    await adapters.proveActor(token, journal().proposed.actor);
    loaded = await rewriteJournal({
      journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key, phase: "upload_ready",
      remote: { slot_absent: true },
    });
    loaded = await rewriteJournal({
      journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key, phase: "upload_requested",
      remote: { slot_absent: true },
    });
    observation = await adapters.observe(slot);
    occupied = slotAssets(observation, slot.receipt_name);
    if (occupied.assets.length !== 0) fail("receipt slot changed after credential proof; upload is unreachable");
    await assertExactOwner(paths.owner, owner);
    await adapters.uploadAsset({
      release: observation.release,
      releaseId: positiveId("draft release id", slot.draft_release_id),
      name: slot.receipt_name,
      bytes: journal().proposedBytes,
      digest: journal().proposed.digest,
      actor: journal().proposed.actor,
      token,
    });

    observation = await adapters.observe(slot);
    occupied = slotAssets(observation, slot.receipt_name);
    if (occupied.assets.length !== 1 || occupied.assets[0].digest !== journal().proposed.digest) {
      fail("uploaded receipt did not converge to the journaled digest");
    }
    await adapters.verifyAsset(occupied.raw[0], proposedExpected);
    loaded = await rewriteJournal({
      journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key, phase: "converged",
      remote: { asset: occupied.assets[0] },
    });
    const finalAsset = occupied.assets[0];
    await cleanupJournal({ journalPath: paths.journal, loaded, ownerPath: paths.owner, owner, slot, key });
    return {
      status: resumed ? "resumed" : journal().prior.kind === "existing" ? "replaced" : "uploaded",
      mutated: true,
      asset: finalAsset,
      slot_key: key,
    };
  } finally {
    if (owner) await releaseSlotOwner(paths.owner, owner);
  }
}

export async function runRecoveryBatch(rows, executeRow) {
  if (!Array.isArray(rows) || rows.length === 0) fail("batch must contain at least one row");
  if (typeof executeRow !== "function") fail("batch row executor is required");
  const results = [];
  let stopped = false;
  const identity = (row) => ({
    ...(row?.stage_id !== undefined ? { stage_id: row.stage_id } : {}),
    ...(row?.version !== undefined ? { version: row.version } : {}),
    ...(row?.draft_release_id !== undefined ? { draft_release_id: String(row.draft_release_id) } : {}),
    ...(row?.decision !== undefined ? { decision: row.decision } : {}),
  });
  for (let index = 0; index < rows.length; index += 1) {
    if (stopped) {
      results.push({ index, ...identity(rows[index]), status: "not_attempted" });
      continue;
    }
    try {
      const result = await executeRow(rows[index], index);
      results.push({ index, ...identity(rows[index]), ...result });
    } catch (error) {
      results.push({
        index,
        ...identity(rows[index]),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      stopped = true;
    }
  }
  const summary = {};
  for (const result of results) summary[result.status] = (summary[result.status] ?? 0) + 1;
  return { rows: results, summary };
}
