// Pure authority for the operator-receipt ordering gate: receipt payload shape and canonical
// signing bytes, receipt/stamp asset naming, tier policy (prerelease vs stable), and the ordering
// evaluation that replays the release-state machine over signed operator evidence. No I/O — the
// ssh-keygen signature check and GitHub fetches live in scripts/release-verify-ordering.mjs.
//
// Tier policy (ratified on tasks/p5a-pre-live-hardening): for PRERELEASE candidates a missing
// operator receipt is tolerated but the publish is permanently stamped; for STABLE candidates both
// receipts are required. Present-but-invalid evidence is ALWAYS red, in every tier and mode.
import { reconcile, ReleaseStateError } from "./release-state.mjs";

export const RECEIPT_SCHEMA = "aslite.operator-receipt.v1";
export const STAMP_SCHEMA = "aslite.receipt-status.v1";
export const SIGN_NAMESPACE = "aslite-release-receipt";
export const RECEIPT_DECISIONS = ["inspected", "approved"];

const SEMVER = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // GitHub login shape
const LIVE_STAGE_ID_SOURCE = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
export const LIVE_STAGE_ID = new RegExp(`^${LIVE_STAGE_ID_SOURCE}$`, "i");
const AUX_ASSET = new RegExp(`^receipt-(inspected|approved|status)-(${LIVE_STAGE_ID_SOURCE})\\.json$`, "i");
const SSH_SIG = /^-----BEGIN SSH SIGNATURE-----\n[\s\S]+\n-----END SSH SIGNATURE-----\n?$/;

export const RECEIPT_STATUS_BLOCK_START = "<!-- aslite-receipt-status:start -->";
export const RECEIPT_STATUS_BLOCK_END = "<!-- aslite-receipt-status:end -->";

function fail(message) {
  throw new Error(`operator receipt verification failed: ${message}`);
}

function field(name, value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

function isoTime(name, value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

/** prerelease candidates publish to `next`; stable candidates move `latest`. */
export function releaseTier(version) {
  const parsed = SEMVER.exec(field("version", version, SEMVER));
  return parsed[1] === undefined ? "stable" : "prerelease";
}

export function policyTagFor(version) {
  return releaseTier(version) === "prerelease" ? "next" : "latest";
}

export function receiptAssetName(decision, stageId) {
  if (!RECEIPT_DECISIONS.includes(decision)) fail(`unknown receipt decision ${JSON.stringify(decision)}`);
  return `receipt-${decision}-${field("stage id", stageId, LIVE_STAGE_ID)}.json`;
}

export function stampAssetName(stageId) {
  return `receipt-status-${field("stage id", stageId, LIVE_STAGE_ID)}.json`;
}

/**
 * The one auxiliary filename parser. Pre-stage has no current id and grants only residual status;
 * finalize requires the chain-verified live stage id and separates current evidence from siblings.
 */
export function parseAuxiliaryReleaseAssetName(name, { mode, currentStageId } = {}) {
  if (mode === "pre-stage") {
    if (currentStageId !== undefined) fail("pre-stage auxiliary classification must not receive a current stage id");
  } else if (mode === "finalize") {
    field("current stage id", currentStageId, LIVE_STAGE_ID);
  } else {
    fail(`unknown auxiliary classification mode ${JSON.stringify(mode)}`);
  }
  if (typeof name !== "string") return null;
  const match = AUX_ASSET.exec(name);
  if (!match) return null;
  const [, decision, stageId] = match;
  if (mode === "pre-stage") {
    return { name, decision, stage_id: stageId, category: "residual" };
  }
  const current = stageId === currentStageId;
  return {
    name,
    decision,
    stage_id: stageId,
    category: current ? (decision === "status" ? "current_status" : "current_receipt") : "sibling",
  };
}

/**
 * Validate + normalize a receipt payload into fixed key order. The returned object's JSON
 * serialization is the canonical byte stream that gets signed and verified.
 */
export function canonicalReceiptPayload(fields) {
  const decision = fields?.decision;
  if (!RECEIPT_DECISIONS.includes(decision)) fail(`unknown receipt decision ${JSON.stringify(decision)}`);
  const payload = {
    schema: RECEIPT_SCHEMA,
    decision,
    stage_id: field("stage_id", fields.stage_id, LIVE_STAGE_ID),
    version: field("version", fields.version, SEMVER),
    tarball_sha256: field("tarball_sha256", fields.tarball_sha256, SHA256),
    draft_release_id: field("draft_release_id", fields.draft_release_id, TOKEN),
    actor: field("actor", fields.actor, ACTOR),
    emitted_at: isoTime("emitted_at", fields.emitted_at),
  };
  if (fields.schema !== undefined && fields.schema !== RECEIPT_SCHEMA) {
    fail(`unknown receipt schema ${JSON.stringify(fields.schema)}`);
  }
  if (decision === "inspected") {
    payload.observed_sha256 = field("observed_sha256", fields.observed_sha256, SHA256);
  } else if (fields.observed_sha256 !== undefined) {
    fail("approved receipt must not carry observed_sha256");
  }
  return payload;
}

/** The exact bytes signed with `ssh-keygen -Y sign -n aslite-release-receipt`. */
export function canonicalPayloadBytes(payload) {
  return `${JSON.stringify(canonicalReceiptPayload(payload), null, 2)}\n`;
}

/** Parse a receipt file's text into { payload, signature }, validating both shapes. */
export function parseReceiptFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`receipt file is not valid JSON: ${error.message}`);
  }
  const payload = canonicalReceiptPayload(parsed?.payload ?? {});
  const signature = parsed?.signature;
  if (typeof signature !== "string" || !SSH_SIG.test(signature)) fail("receipt signature is not an SSH signature block");
  return { payload, signature };
}

function bindReceipt(kind, payload, chain) {
  if (payload.decision !== kind) fail(`${kind} receipt carries decision ${payload.decision}`);
  for (const key of ["stage_id", "version", "tarball_sha256", "draft_release_id"]) {
    if (payload[key] !== chain[key]) {
      fail(`${kind} receipt ${key} ${JSON.stringify(payload[key])} does not name this candidate (${JSON.stringify(chain[key])})`);
    }
  }
}

function timestampMillis(name, value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(`invalid timestamp on ${name}`);
  return parsed;
}

function orderedNoLaterThan(name, earlier, later, message) {
  const a = timestampMillis(name, earlier);
  const b = timestampMillis(name, later);
  if (a > b) fail(message);
}

function orderedStrictlyBefore(name, earlier, later, message) {
  const a = timestampMillis(name, earlier);
  const b = timestampMillis(name, later);
  if (a >= b) fail(message);
}

function numericAssetId(name, value) {
  const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) fail(`invalid ${name}: ${JSON.stringify(value)}`);
  return normalized;
}

/** Normalize the exact GitHub identity used in proofs and final inventory comparisons. */
export function exactAssetTriple(asset, label = "asset") {
  return {
    id: numericAssetId(`${label} id`, asset?.id),
    name: field(`${label} name`, asset?.name, TOKEN),
    digest: field(`${label} digest`, asset?.digest, SHA256),
  };
}

function sortedTriples(assets, label) {
  return [...assets]
    .map((asset) => exactAssetTriple(asset, label))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

function sameTriple(a, b) {
  return a.id === b.id && a.name === b.name && a.digest === b.digest;
}

function stageReceiptEvents(stageReceipt) {
  if (stageReceipt?.schema !== "aslite.stage-receipt.v2" || stageReceipt?.state !== "staged") {
    fail("stage receipt schema/state is not staged v2");
  }
  const prepared = stageReceipt.prepared ?? {};
  const draft = stageReceipt.draft ?? {};
  const stage = stageReceipt.stage ?? {};
  const tarballAsset = (draft.assets ?? []).find((asset) => asset?.name === prepared.tarball?.filename);
  return [
    {
      to: "prepared",
      receipt: {
        version: prepared.version,
        tag: prepared.tag,
        source_commit: prepared.source_commit,
        run_id: prepared.run_id,
        artifact_id: prepared.artifact?.id,
        artifact_digest: prepared.artifact?.digest,
        tarball_sha256: prepared.tarball?.sha256,
        integrity: prepared.tarball?.integrity,
      },
    },
    {
      to: "draft_prepared",
      receipt: {
        draft_release_id: draft.release_id,
        asset_ids: (draft.assets ?? []).map((asset) => asset?.id),
        asset_digest: tarballAsset?.digest,
      },
    },
    { to: "staged", receipt: { stage_id: stage.id, stage_tag: stage.tag } },
  ];
}

/**
 * The finalize ordering gate. `chain` is verify-finalizer's proof (already cross-checked against
 * dispatch inputs, candidate bytes, and artifact metadata); `stageReceipt` is the retained
 * stage-receipt.json; `inspected`/`approved` are `{ payload, uploaderLogin, uploadedAt } | null`
 * with signatures ALREADY verified by the adapter; `runCreatedAt` is THIS finalize run's
 * GitHub-attested creation time. Throws on any present-but-invalid evidence (every tier, every
 * mode). Missing evidence: tolerated in dry-run (reported); tolerated live only for prerelease
 * candidates, and then only with a stamp; red for stable.
 */
export function evaluateOrdering({ mode, chain, stageReceipt, inspected, approved, runCreatedAt, allowedActors }) {
  if (mode !== "dry-run" && mode !== "live") fail(`unknown mode ${JSON.stringify(mode)}`);
  if (!Array.isArray(allowedActors) || allowedActors.length === 0) fail("allowed-signers principal list is empty");
  const tier = releaseTier(chain.version);
  isoTime("finalize run created_at", runCreatedAt);

  const receiptAssets = [];
  for (const [kind, receipt] of [["inspected", inspected], ["approved", approved]]) {
    if (!receipt) continue;
    bindReceipt(kind, receipt.payload, chain);
    const asset = exactAssetTriple(receipt.asset, `${kind} receipt asset`);
    if (asset.name !== receiptAssetName(kind, chain.stage_id)) {
      fail(`${kind} receipt proof names unexpected asset ${JSON.stringify(asset.name)}`);
    }
    receiptAssets.push(asset);
    if (!allowedActors.includes(receipt.payload.actor)) {
      fail(`${kind} receipt actor ${receipt.payload.actor} is not an allowed operator`);
    }
    if (receipt.uploaderLogin !== receipt.payload.actor) {
      fail(`${kind} receipt uploaded by ${JSON.stringify(receipt.uploaderLogin)} but signed as ${receipt.payload.actor}`);
    }
    orderedNoLaterThan(
      `${kind} receipt`,
      receipt.uploadedAt,
      runCreatedAt,
      `${kind} receipt was uploaded after this finalize run was dispatched — re-dispatch to consume it`,
    );
  }
  if (inspected && approved) {
    orderedStrictlyBefore(
      "receipt pair",
      inspected.uploadedAt,
      approved.uploadedAt,
      "inspection receipt upload must be strictly earlier than approval receipt upload",
    );
  }

  const missing = [
    ...(inspected ? [] : ["inspected"]),
    ...(approved ? [] : ["approved"]),
  ];
  if (missing.length > 0 && mode === "live" && tier === "stable") {
    fail(`stable candidate is missing required operator receipts: ${missing.join(", ")}`);
  }

  // Replay the state machine over the evidence that exists. The ledger can only legally reach
  // approved_public THROUGH inspected, so an approved-only prerelease stops at `staged` and the
  // approval evidence stands on its own signature + the registry publication proof.
  let ledger = { state: null, identifiers: {} };
  const events = stageReceiptEvents(stageReceipt);
  if (inspected) {
    events.push({
      to: "inspected",
      receipt: {
        actor: inspected.payload.actor,
        inspected_at: inspected.payload.emitted_at,
        observed_sha256: inspected.payload.observed_sha256,
        stage_id: inspected.payload.stage_id,
        version: inspected.payload.version,
        tarball_sha256: inspected.payload.tarball_sha256,
      },
    });
    if (approved) {
      events.push({
        to: "approved_public",
        receipt: {
          actor: approved.payload.actor,
          approved_at: approved.payload.emitted_at,
          public_version: approved.payload.version,
          public_tag: policyTagFor(approved.payload.version),
          stage_id: approved.payload.stage_id,
          tarball_sha256: approved.payload.tarball_sha256,
        },
      });
    }
  }
  for (const event of events) {
    ledger = reconcile(ledger, event).ledger;
  }

  return {
    schema: "aslite.ordering-proof.v1",
    mode,
    tier,
    state: ledger.state,
    stage_id: chain.stage_id,
    version: chain.version,
    tarball_sha256: chain.tarball_sha256,
    draft_release_id: chain.draft_release_id,
    verified: RECEIPT_DECISIONS.filter((kind) => !missing.includes(kind)),
    missing,
    actors: {
      inspected: inspected?.payload.actor ?? null,
      approved: approved?.payload.actor ?? null,
    },
    receipt_assets: sortedTriples(receiptAssets, "receipt proof asset"),
    stamp_required: missing.length > 0 && tier === "prerelease",
  };
}

/** The permanent, workflow-emitted public record that a candidate published without full receipts. */
export function buildReceiptStatusStamp({ result, finalizeRunId, emittedAt }) {
  if (!result?.stamp_required) fail("stamp requested but the ordering result does not require one");
  return {
    schema: STAMP_SCHEMA,
    stage_id: result.stage_id,
    version: result.version,
    tarball_sha256: result.tarball_sha256,
    draft_release_id: result.draft_release_id,
    tier: result.tier,
    missing: result.missing,
    note: `published without ${result.missing.map((kind) => `${kind} receipt`).join(" or ")}`,
    emitted_by: "release-finalize workflow",
    finalize_run_id: field("finalize run id", finalizeRunId, TOKEN),
    emitted_at: isoTime("emitted_at", emittedAt),
  };
}

/** The human-visible release-body annotation matching the stamp asset. */
export function stampAnnotation(stamp) {
  return `> **Receipt status:** ${stamp.note} (${stamp.tier} tier; stamped by the finalize workflow, run ${stamp.finalize_run_id}). Machine-readable record: \`${stampAssetName(stamp.stage_id)}\`.`;
}

function receiptStatusBlock(body) {
  if (typeof body !== "string") fail(`release body must be a string, got ${JSON.stringify(body)}`);
  const starts = body.split(RECEIPT_STATUS_BLOCK_START).length - 1;
  const ends = body.split(RECEIPT_STATUS_BLOCK_END).length - 1;
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) fail("release body has duplicate or unbalanced receipt-status markers");
  const start = body.indexOf(RECEIPT_STATUS_BLOCK_START);
  const end = body.indexOf(RECEIPT_STATUS_BLOCK_END);
  if (end < start) fail("release body has reversed receipt-status markers");
  return { start, end: end + RECEIPT_STATUS_BLOCK_END.length, text: body.slice(start, end + RECEIPT_STATUS_BLOCK_END.length) };
}

function renderedReceiptStatusBlock(annotation) {
  if (typeof annotation !== "string" || !annotation || annotation.includes(RECEIPT_STATUS_BLOCK_START) || annotation.includes(RECEIPT_STATUS_BLOCK_END)) {
    fail("invalid receipt-status annotation");
  }
  return `${RECEIPT_STATUS_BLOCK_START}\n${annotation}\n${RECEIPT_STATUS_BLOCK_END}`;
}

/** Replace/remove the one workflow-owned body block while preserving all bytes outside it. */
export function normalizeReceiptStatusBody(body, annotation) {
  const existing = receiptStatusBlock(body);
  if (annotation === null) {
    return existing ? `${body.slice(0, existing.start)}${body.slice(existing.end)}` : body;
  }
  const replacement = renderedReceiptStatusBlock(annotation);
  if (existing) return `${body.slice(0, existing.start)}${replacement}${body.slice(existing.end)}`;
  if (!body) return `${replacement}\n`;
  return `${body}${body.endsWith("\n") ? "\n" : "\n\n"}${replacement}\n`;
}

/** Verify the re-queried draft has exactly the expected owned block shape. */
export function verifyReceiptStatusBody(body, annotation) {
  const existing = receiptStatusBlock(body);
  if (annotation === null) {
    if (existing) fail("release body retains an unexpected receipt-status block");
    return true;
  }
  const expected = renderedReceiptStatusBlock(annotation);
  if (!existing || existing.text !== expected) fail("release body receipt-status block does not match the current ordering result");
  return true;
}

function proofMap(assets, label) {
  const triples = sortedTriples(Array.isArray(assets) ? assets : [], label);
  const map = new Map();
  for (const asset of triples) {
    if (map.has(asset.name)) fail(`duplicate ${label} name ${asset.name}`);
    map.set(asset.name, asset);
  }
  return { triples, map };
}

function expectedStatusProof(ordering, status) {
  if (!ordering?.stamp_required) {
    if (status !== null) fail("status bytes supplied when the ordering result requires no stamp");
    return null;
  }
  if (!status || status.name !== stampAssetName(ordering.stage_id)) fail("missing generated current status proof");
  return { name: status.name, digest: field("generated status digest", status.digest, SHA256) };
}

/** Build the deterministic, draft-bound ID-only cleanup manifest from verified proof inputs. */
export function buildPublicationPlan({ release, chain, ordering, status, bodyAnnotation }) {
  if (chain?.schema !== "aslite.finalizer-chain-proof.v1") fail("unknown finalizer chain proof schema");
  if (ordering?.schema !== "aslite.ordering-proof.v1") fail("unknown ordering proof schema");
  const draftReleaseId = numericAssetId("draft release id", chain?.draft_release_id);
  if (numericAssetId("observed draft release id", release?.id) !== draftReleaseId || String(ordering?.draft_release_id) !== String(chain?.draft_release_id)) {
    fail("publication plan draft release id does not match verified proofs");
  }
  if (release?.draft !== true) fail("publication plan requires an unpublished draft");
  if (ordering?.stage_id !== chain?.stage_id) fail("ordering and chain stage ids differ");
  field("current stage id", chain.stage_id, LIVE_STAGE_ID);

  const core = proofMap(chain?.core_assets, "core proof asset");
  if (core.triples.length !== 2) fail("chain proof must retain exactly two core asset triples");
  const receipts = proofMap(ordering?.receipt_assets, "receipt proof asset");
  const expectedReceiptNames = new Set(ordering.verified.map((decision) => receiptAssetName(decision, chain.stage_id)));
  if (receipts.triples.length !== expectedReceiptNames.size || receipts.triples.some((asset) => !expectedReceiptNames.has(asset.name))) {
    fail("ordering receipt triples do not match verified decisions");
  }
  const expectedStatus = expectedStatusProof(ordering, status);
  if ((expectedStatus === null) !== (bodyAnnotation === null)) fail("status asset and owned body annotation requirements differ");

  const observedCore = new Set();
  const observedReceipts = new Set();
  const deletes = [];
  const deleteIds = new Set();
  for (const raw of release?.assets ?? []) {
    const asset = exactAssetTriple(raw, "draft asset");
    const coreAsset = core.map.get(asset.name);
    if (coreAsset) {
      if (!sameTriple(asset, coreAsset)) fail(`core asset ${asset.name} changed after chain verification`);
      if (observedCore.has(asset.name)) fail(`duplicate core asset ${asset.name}`);
      observedCore.add(asset.name);
      continue;
    }
    const classified = parseAuxiliaryReleaseAssetName(asset.name, { mode: "finalize", currentStageId: chain.stage_id });
    if (!classified) fail(`unexpected draft asset ${asset.name}`);
    if (classified.category === "current_receipt") {
      const receipt = receipts.map.get(asset.name);
      if (!receipt || !sameTriple(asset, receipt)) fail(`current receipt asset ${asset.name} changed after verification`);
      if (observedReceipts.has(asset.name)) fail(`duplicate current receipt asset ${asset.name}`);
      observedReceipts.add(asset.name);
      continue;
    }
    if (deleteIds.has(asset.id)) fail(`duplicate draft asset id ${asset.id}`);
    deleteIds.add(asset.id);
    deletes.push({ id: asset.id, name: asset.name, category: classified.category });
  }
  for (const name of core.map.keys()) if (!observedCore.has(name)) fail(`draft is missing verified core asset ${name}`);
  for (const name of receipts.map.keys()) if (!observedReceipts.has(name)) fail(`draft is missing verified receipt asset ${name}`);
  deletes.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));

  return {
    schema: "aslite.publication-plan.v1",
    draft_release_id: draftReleaseId,
    stage_id: chain.stage_id,
    tag: chain.tag,
    delete: deletes,
    keep: { core_assets: core.triples, receipt_assets: receipts.triples, status: expectedStatus },
    body_annotation: bodyAnnotation,
  };
}

/** Prove the exact re-queried inventory and owned body immediately before publication. */
export function verifyFinalPublication({ release, plan }) {
  if (plan?.schema !== "aslite.publication-plan.v1") fail("unknown publication plan schema");
  if (numericAssetId("final draft release id", release?.id) !== plan.draft_release_id) fail("final draft release id differs from cleanup plan");
  if (release?.draft !== true) fail("final release is no longer an unpublished draft");
  const expected = proofMap([...plan.keep.core_assets, ...plan.keep.receipt_assets], "final keep asset");
  const observedNames = new Set();
  let statusAsset = null;
  for (const raw of release?.assets ?? []) {
    const asset = exactAssetTriple(raw, "final draft asset");
    if (observedNames.has(asset.name)) fail(`duplicate final asset ${asset.name}`);
    observedNames.add(asset.name);
    const fixed = expected.map.get(asset.name);
    if (fixed) {
      if (!sameTriple(asset, fixed)) fail(`final asset ${asset.name} differs from verified id/name/digest`);
      continue;
    }
    if (plan.keep.status && asset.name === plan.keep.status.name) {
      if (asset.digest !== plan.keep.status.digest) fail(`final status asset ${asset.name} differs from generated bytes`);
      statusAsset = asset;
      continue;
    }
    fail(`unexpected final asset ${asset.name}`);
  }
  for (const name of expected.map.keys()) if (!observedNames.has(name)) fail(`final inventory is missing ${name}`);
  if (plan.keep.status && !statusAsset) fail(`final inventory is missing generated status ${plan.keep.status.name}`);
  if (!plan.keep.status && statusAsset) fail("final inventory retains an unexpected status asset");
  verifyReceiptStatusBody(typeof release.body === "string" ? release.body : "", plan.body_annotation);
  const assets = sortedTriples(
    [...plan.keep.core_assets, ...plan.keep.receipt_assets, ...(statusAsset ? [statusAsset] : [])],
    "final proof asset",
  );
  return {
    schema: "aslite.final-publication-proof.v1",
    draft_release_id: plan.draft_release_id,
    stage_id: plan.stage_id,
    assets,
    status_asset: statusAsset,
  };
}

/** Operator commands rendered into the stage summary for signed receipt emission. */
export function receiptEmissionCommands({ stageId, version, draftReleaseId }) {
  field("stage id", stageId, LIVE_STAGE_ID);
  field("version", version, SEMVER);
  field("draft release id", draftReleaseId, TOKEN);
  const base = `node scripts/release-inspect.mjs --stage-id ${stageId} --version ${version} --draft-release-id ${draftReleaseId} --key ~/.ssh/id_ed25519`;
  return {
    inspected: base,
    approved: `${base} --decision approved`,
  };
}
