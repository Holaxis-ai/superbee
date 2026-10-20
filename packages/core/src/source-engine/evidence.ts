/** Caller-associated applicability of original input bytes; independent of document freshness. */
export interface SnapshotEvidenceIdentity { id: string; sha256: string }
export interface SnapshotEvidence {
  v: 1;
  association: "caller_asserted";
  inputs: SnapshotEvidenceIdentity[];
  settings_digest?: string;
  required_identities?: SnapshotEvidenceIdentity[];
}
export interface SnapshotEvidenceObservation {
  inputs: Readonly<Record<string, string | null | undefined>>;
  required_identities?: Readonly<Record<string, string | null | undefined>>;
  settings_digest?: string | null;
}
export interface SnapshotFreshnessRow {
  dimension: "input" | "required_identity" | "settings";
  id: string;
  status: "equal" | "mismatch" | "unknown";
}
export interface SnapshotFreshness {
  status: "current" | "stale" | "unverifiable";
  association: "caller_asserted" | null;
  basis: "declared_original_inputs";
  reason: "all_required_equal" | "known_mismatch" | "missing_dimension" | "no_input_basis";
  rows: SnapshotFreshnessRow[];
}
export const SNAPSHOT_SHA256 = /^sha256:[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const closed = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).every(k => keys.includes(k));

export class SnapshotEvidenceRefusal extends Error {
  readonly code = "SNAPSHOT_EVIDENCE_INVALID";
  constructor() { super("snapshot evidence is not a closed v1 caller-associated descriptor"); this.name = "SnapshotEvidenceRefusal"; }
}
/** Closed, bounded portable evidence. Logical IDs select no file or executable. */
export function parseSnapshotEvidence(value: unknown): SnapshotEvidence {
  const refuse = (): never => { throw new SnapshotEvidenceRefusal(); };
  if (!object(value) || !closed(value, ["v", "association", "inputs", "settings_digest", "required_identities"])
    || value.v !== 1 || value.association !== "caller_asserted") return refuse();
  const identities = (raw: unknown): SnapshotEvidenceIdentity[] => {
    if (!Array.isArray(raw) || raw.length > 10_000) return refuse();
    const seen = new Set<string>();
    return raw.map(row => {
      if (!object(row) || !closed(row, ["id", "sha256"]) || typeof row.id !== "string" || !LABEL.test(row.id)
        || typeof row.sha256 !== "string" || !SNAPSHOT_SHA256.test(row.sha256) || seen.has(row.id)) return refuse();
      seen.add(row.id);
      return { id: row.id, sha256: row.sha256 };
    });
  };
  const inputs = identities(value.inputs);
  if (value.settings_digest !== undefined && (typeof value.settings_digest !== "string" || !SNAPSHOT_SHA256.test(value.settings_digest))) return refuse();
  return { v: 1, association: "caller_asserted", inputs,
    ...(value.settings_digest !== undefined ? { settings_digest: value.settings_digest as string } : {}),
    ...(value.required_identities !== undefined ? { required_identities: identities(value.required_identities) } : {}) };
}

/** Known mismatches take precedence over unknown dimensions, including an empty input basis. */
export function assessSnapshotFreshness(expected: SnapshotEvidence | undefined, observed: SnapshotEvidenceObservation): SnapshotFreshness {
  const evidence = expected === undefined ? undefined : parseSnapshotEvidence(expected);
  const rows: SnapshotFreshnessRow[] = [];
  const row = (dimension: SnapshotFreshnessRow["dimension"], id: string, wanted: string, actual: unknown): void => {
    rows.push({ dimension, id, status: typeof actual !== "string" || !SNAPSHOT_SHA256.test(actual) ? "unknown" : actual === wanted ? "equal" : "mismatch" });
  };
  for (const input of evidence?.inputs ?? []) row("input", input.id, input.sha256, Object.hasOwn(observed.inputs, input.id) ? observed.inputs[input.id] : undefined);
  for (const identity of evidence?.required_identities ?? []) row("required_identity", identity.id, identity.sha256,
    observed.required_identities && Object.hasOwn(observed.required_identities, identity.id) ? observed.required_identities[identity.id] : undefined);
  if (evidence?.settings_digest !== undefined) row("settings", "original_settings", evidence.settings_digest, observed.settings_digest);
  const mismatch = rows.some(r => r.status === "mismatch");
  const basis = (evidence?.inputs.length ?? 0) > 0;
  const unknown = rows.some(r => r.status === "unknown");
  return { status: mismatch ? "stale" : !basis || unknown ? "unverifiable" : "current",
    association: evidence?.association ?? null, basis: "declared_original_inputs",
    reason: mismatch ? "known_mismatch" : !basis ? "no_input_basis" : unknown ? "missing_dimension" : "all_required_equal", rows };
}
