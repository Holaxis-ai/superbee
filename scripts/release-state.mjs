// Pure staged-release state reconciler — no I/O, no clock, no network. It is the single authority
// for which transition is legal, which immutable identifiers each state must carry, and whether a
// proposed receipt CONTRADICTS the identifiers already fixed earlier in the transaction.
//
// SCOPE: this graph IS wired as the runtime ordering gate — release-finalize.yml's
// ordering-verified job (and the finalize job's pre-publish re-check) replays it over signed
// operator inspection/approval receipts via scripts/release-verify-ordering.mjs, alongside the
// byte-identity chain (verify-finalizer) and the registry publication proof (which already forces
// a 2FA stage approval of the exact bytes before live finalize can succeed). Receipts add what
// those cannot prove: that inspection happened, by which operator, before approval and dispatch.
// Enforcement is tiered (see release-ordering.mjs): stable candidates require both receipts;
// prerelease tolerates absence with a permanent public stamp; present-but-invalid evidence is
// always red. scripts/release-reconcile.mjs stays the operator CLI over the same reconcile().
// Nothing here rebuilds or repacks.
//
// Normative source: .agentstate-lite/designs/version-update-protocols.md §5 (states/owners table
// and transient tag/failure rules). The `rolled_back` state is derived from §5's transient-tag
// rules (which describe deprecate + tag-restore on post-approval failure) rather than the
// states/owners table, which stops at `final`; this is flagged in the P5A builder report.

/** @typedef {"prepared"|"draft_prepared"|"staged"|"inspected"|"rejected"|"approved_public"|"registry_verified"|"promoted"|"final"|"rolled_back"} ReleaseState */

// The immutable-identifier keys a state's receipt must carry. A later state may re-assert an
// earlier key ONLY with the identical value (cross-check below); it may never mint a new value for
// a key already fixed.
const STATE_RECEIPT_FIELDS = {
  prepared: ["target", "version", "tag", "source_commit", "run_id", "artifact_id", "artifact_digest", "tarball_sha256", "integrity"],
  draft_prepared: ["draft_release_id", "asset_ids", "asset_digest"],
  staged: ["stage_id", "stage_tag"],
  inspected: ["actor", "inspected_at", "observed_sha256"],
  rejected: ["actor", "rejected_at", "reason"],
  approved_public: ["actor", "approved_at", "public_version", "public_tag"],
  registry_verified: ["packument_integrity", "signature", "provenance", "install_smoke_ok"],
  promoted: ["actor", "promoted_at", "before_tags", "after_tags", "promoted_version"],
  final: ["release_id", "release_tag", "assets", "attestation"],
  rolled_back: ["actor", "rolled_back_at", "restored_next", "deprecated_version", "recovery_command"],
};

// The public receipt vocabulary stays `actor` for every operator-owned transition. Only the
// accumulated ledger namespaces that identity so different legal steps may have different owners
// without weakening same-state replay checks.
const STATE_ACTOR_KEYS = {
  inspected: "inspected_by",
  rejected: "rejected_by",
  approved_public: "approved_by",
  promoted: "promoted_by",
  rolled_back: "rolled_back_by",
};

// Legal forward transitions. Each state's receipt is validated against STATE_RECEIPT_FIELDS; the
// ledger accumulates every fixed identifier so cross-state contradictions fail closed.
const TRANSITIONS = {
  null: ["prepared"],
  prepared: ["draft_prepared"],
  draft_prepared: ["staged"],
  staged: ["inspected"],
  // Inspection decides the fork: a matching checksum may approve; any inspection may reject.
  inspected: ["approved_public", "rejected"],
  approved_public: ["registry_verified", "rolled_back"],
  registry_verified: ["promoted", "rolled_back"],
  promoted: ["final", "rolled_back"],
  // Terminal states accept no further transition.
  final: [],
  rejected: [],
  rolled_back: [],
};

export const RELEASE_STATES = Object.keys(STATE_RECEIPT_FIELDS);

export class ReleaseStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseStateError";
    this.code = code;
  }
}

function stableEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => stableEqual(a[k], b[k]));
}

function requireFields(state, receipt) {
  const required = STATE_RECEIPT_FIELDS[state];
  if (!required) throw new ReleaseStateError("unknown_state", `unknown release state: ${state}`);
  for (const key of required) {
    if (receipt[key] === undefined || receipt[key] === null) {
      throw new ReleaseStateError("missing_receipt", `state ${state} requires receipt.${key}`);
    }
  }
}

/**
 * Merge a receipt into the ledger's identifier map. A key already present must match exactly, else
 * the proposed receipt contradicts a fixed immutable identifier and we fail closed. Returns
 * { identifiers, changed } — `changed:false` means every key re-asserted an identical value.
 */
function mergeIdentifiers(state, existing, receipt) {
  const identifiers = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(receipt)) {
    const ledgerKey = key === "actor" ? STATE_ACTOR_KEYS[state] : key;
    if (!ledgerKey) {
      throw new ReleaseStateError("unknown_state", `state ${state} has no actor identity mapping`);
    }
    if (ledgerKey in identifiers) {
      if (!stableEqual(identifiers[ledgerKey], value)) {
        throw new ReleaseStateError(
          "identifier_mismatch",
          `receipt.${key} = ${JSON.stringify(value)} contradicts fixed ${ledgerKey} ${JSON.stringify(identifiers[ledgerKey])}`,
        );
      }
      continue;
    }
    identifiers[ledgerKey] = value;
    changed = true;
  }
  return { identifiers, changed };
}

// Semantic cross-checks that are not mere key-identity: the SHA the operator observed on the staged
// artifact must equal the SHA fixed at `prepared`, and the draft's attached asset digest must too.
// These are the checks that make a swapped/rebuilt artifact impossible to carry forward.
function crossCheck(state, identifiers) {
  const expectedSha = identifiers.tarball_sha256;
  if (state === "draft_prepared" && identifiers.asset_digest !== expectedSha) {
    throw new ReleaseStateError(
      "artifact_mismatch",
      `draft asset digest ${identifiers.asset_digest} != prepared tarball ${expectedSha}`,
    );
  }
  if (state === "inspected" && identifiers.observed_sha256 !== expectedSha) {
    // A mismatched inspection is not a legal path to approval — it must reject.
    throw new ReleaseStateError(
      "inspection_mismatch",
      `observed ${identifiers.observed_sha256} != prepared tarball ${expectedSha}; inspection must reject, not approve`,
    );
  }
}

/**
 * The one reconciliation step. `ledger` is `{ state, identifiers }` (state `null` starts a fresh
 * transaction); `event` is `{ to, receipt }`. Returns `{ ledger, changed }`.
 *
 * - Illegal transition -> ReleaseStateError("illegal_transition").
 * - Missing required receipt field -> ReleaseStateError("missing_receipt").
 * - A receipt that contradicts a fixed identifier -> ReleaseStateError("identifier_mismatch").
 * - A semantic artifact/inspection mismatch -> ReleaseStateError with the specific code.
 * - Idempotent replay: re-applying the transition that PRODUCED the current state, with identical
 *   receipt values, is a no-op (`changed:false`) so a rerun from immutable IDs converges.
 */
export function reconcile(ledger, event) {
  const from = ledger?.state ?? null;
  const identifiers = ledger?.identifiers ?? {};
  const to = event?.to;
  const receipt = event?.receipt ?? {};
  if (!to || !(to in STATE_RECEIPT_FIELDS)) {
    throw new ReleaseStateError("unknown_state", `unknown target state: ${to}`);
  }
  requireFields(to, receipt);

  // Idempotent replay of the transition that produced the current state.
  if (to === from) {
    const merged = mergeIdentifiers(to, identifiers, receipt); // throws on any contradiction
    return { ledger: { state: to, identifiers: merged.identifiers }, changed: false };
  }

  const legal = TRANSITIONS[from ?? "null"] ?? [];
  if (!legal.includes(to)) {
    throw new ReleaseStateError(
      "illegal_transition",
      `cannot move ${from ?? "null"} -> ${to} (legal: ${legal.join(", ") || "none"})`,
    );
  }
  const merged = mergeIdentifiers(to, identifiers, receipt);
  crossCheck(to, merged.identifiers);
  return { ledger: { state: to, identifiers: merged.identifiers }, changed: true };
}

/** Replay an ordered event list from a fresh transaction. Throws on the first illegal/mismatched step. */
export function replay(events) {
  let ledger = { state: null, identifiers: {} };
  for (const event of events) {
    ledger = reconcile(ledger, event).ledger;
  }
  return ledger;
}

/**
 * Pure prerelease/stable tag resolution (§5 transient tag/failure rules). Returns the dist-tag
 * state at a named phase. `latest == next == supported prerelease` at rest; a prerelease
 * transaction floats `next` to the candidate while `latest` stays the prior known-good; the first
 * stable moves `latest`; any post-approval failure restores the prior tags and deprecates the
 * failed version.
 */
export function resolveTags({ kind, phase, version, priorLatest, priorNext }) {
  if (kind !== "prerelease" && kind !== "stable") {
    throw new ReleaseStateError("bad_tag_kind", `kind must be prerelease|stable, got ${kind}`);
  }
  if (kind === "prerelease") {
    switch (phase) {
      case "at_rest":
        return { latest: priorLatest, next: priorNext };
      case "staged":
      case "approved":
        // The default stays known-good; next is the explicit, not-passively-advertised preview.
        return { latest: priorLatest, next: version };
      case "promoted":
        // Before first stable, preview remains the default. Once stable exists, preview advances
        // only next; latest remains the independently approved stable coordinate.
        return priorLatest.includes("-") ? { latest: version, next: version } : { latest: priorLatest, next: version };
      case "failed":
        return { latest: priorLatest, next: priorNext, deprecate: version };
      default:
        throw new ReleaseStateError("bad_phase", `unknown prerelease phase ${phase}`);
    }
  }
  // stable
  switch (phase) {
    case "at_rest":
      return { latest: priorLatest, next: priorNext };
    case "staged":
      return { latest: priorLatest, next: priorNext };
    case "approved":
      // First stable: approval under latest can move the default before registry smoke.
      return { latest: version, next: priorNext };
    case "promoted":
      // Success removes a stale next unless a genuine preview exists (caller supplies it as priorNext
      // only when it is a real, newer preview; otherwise it collapses to the stable version).
      return { latest: version, next: priorNext && priorNext !== version ? priorNext : version };
    case "failed":
      return { latest: priorLatest, next: priorNext, deprecate: version };
    default:
      throw new ReleaseStateError("bad_phase", `unknown stable phase ${phase}`);
  }
}
