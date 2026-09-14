// Pure ownership and compatibility contract for installed Agent Skill receipts.
//
// Ownership is intentionally narrower than JSON parseability: only the two package spellings
// emitted historically, the exact installer marker, and the exact managed file shape establish
// mutation authority. Manifest-v2 validity is evaluated separately so a corrupt receipt remains
// owned-and-repairable without turning foreign folders into managed ones.
import type { ArtifactChannel } from "./build-identity.js";

export const SKILL_MANIFEST_SCHEMA = "aslite.skill-manifest.v2" as const;
export const SKILL_INSTALLER = "superbee skill install" as const;
export const LEGACY_SKILL_INSTALLERS = ["aslite skill install"] as const;
export const OWNED_SKILL_INSTALLERS = [SKILL_INSTALLER, ...LEGACY_SKILL_INSTALLERS] as const;
export const OWNED_SKILL_PACKAGES = ["superbee", "aslite", "@holaxis/aslite"] as const;

export interface SkillSourceIdentity {
  release_version: string;
  source_commit: string | null;
  artifact_channel: ArtifactChannel;
  artifact_sha256: string | null;
}
interface OwnedSkillManifestBase {
  package: (typeof OWNED_SKILL_PACKAGES)[number];
  version: string;
  installed_by: (typeof OWNED_SKILL_INSTALLERS)[number];
  files: string[];
  receipt_valid: boolean;
}

export interface LegacySkillManifest extends OwnedSkillManifestBase {
  kind: "legacy";
  compatibility_contract: null;
}

export interface SkillManifestV2 extends OwnedSkillManifestBase {
  kind: "v2";
  schema: typeof SKILL_MANIFEST_SCHEMA;
  compatibility_contract: number | null;
  source_identity: SkillSourceIdentity | null;
  file_sha256: Record<string, string> | null;
}

export type OwnedSkillManifest = LegacySkillManifest | SkillManifestV2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every manifested path must remain inside the target on both POSIX and Windows. */
export function isSafeManifestEntry(entry: unknown): entry is string {
  if (typeof entry !== "string" || entry.length === 0) return false;
  if (entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")) return false;
  return entry.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isManagedSkillEntry(value: unknown): value is string {
  if (!isSafeManifestEntry(value)) return false;
  if (value === "SKILL.md") return true;
  if (!value.startsWith("references/")) return false;
  return value.split("/").length >= 2;
}

function parseOwnedFiles(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isManagedSkillEntry)) return null;
  const files = [...value];
  if (!files.includes("SKILL.md")) return null;
  const sorted = [...files].sort();
  if (new Set(files).size !== files.length || files.some((file, index) => file !== sorted[index])) {
    return null;
  }
  return files;
}

function isPositiveContract(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function parseSourceIdentity(value: unknown): SkillSourceIdentity | null {
  if (!isRecord(value)) return null;
  const commit = value.source_commit;
  const artifactSha = value.artifact_sha256;
  const channel = value.artifact_channel;
  if (typeof value.release_version !== "string" || value.release_version.length === 0) return null;
  if (!(commit === null || (typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit)))) return null;
  if (!(["npm-package", "local-dev", "unknown"] as unknown[]).includes(channel)) {
    return null;
  }
  if (!(artifactSha === null || isSha256(artifactSha))) return null;
  return {
    release_version: value.release_version,
    source_commit: commit,
    artifact_channel: channel as ArtifactChannel,
    artifact_sha256: artifactSha,
  };
}

function parseDigestMap(value: unknown, files: readonly string[]): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== files.length || keys.some((key, index) => key !== files[index])) return null;
  if (!keys.every((key) => isSha256(value[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key] as string]));
}

/** Parse the exact historical ownership boundary. `null` means no mutation authority. */
export function parseOwnedSkillManifest(value: unknown): OwnedSkillManifest | null {
  if (!isRecord(value)) return null;
  if (!OWNED_SKILL_PACKAGES.includes(value.package as never)) return null;
  if (typeof value.version !== "string" || value.version.length === 0) return null;
  if (!OWNED_SKILL_INSTALLERS.includes(value.installed_by as never)) return null;
  const files = parseOwnedFiles(value.files);
  if (files === null) return null;
  const base = {
    package: value.package as OwnedSkillManifestBase["package"],
    version: value.version,
    installed_by: value.installed_by as OwnedSkillManifestBase["installed_by"],
    files,
  };

  if (value.schema === undefined) {
    // A partial/hand-edited v2 extension is not an historical legacy receipt.
    if (
      value.compatibility_contract !== undefined ||
      value.source_identity !== undefined ||
      value.file_sha256 !== undefined
    ) {
      return null;
    }
    return { ...base, kind: "legacy", compatibility_contract: null, receipt_valid: true };
  }
  if (value.schema !== SKILL_MANIFEST_SCHEMA) return null;

  const contract = isPositiveContract(value.compatibility_contract)
    ? value.compatibility_contract
    : null;
  const sourceIdentity = parseSourceIdentity(value.source_identity);
  const fileSha256 = parseDigestMap(value.file_sha256, files);
  return {
    ...base,
    kind: "v2",
    schema: SKILL_MANIFEST_SCHEMA,
    compatibility_contract: contract,
    source_identity: sourceIdentity,
    file_sha256: fileSha256,
    receipt_valid: contract !== null && sourceIdentity !== null && fileSha256 !== null,
  };
}

export type SkillState = "absent" | "unmanaged" | "installed" | "stale";
export type SkillCompatibilityState = "absent" | "unmanaged" | "current" | "stale" | "newer_contract";
export type SkillCompatibilityReason =
  | "target_absent"
  | "ownership_unproven"
  | "legacy_receipt"
  | "receipt_invalid"
  | "asset_drift"
  | "installed_contract_older"
  | "installed_contract_newer"
  | null;
export type SkillRemedyAction = "none" | "install" | "refresh_receipt" | "upgrade_cli" | "user_decision";

export interface SkillCompatibility {
  state: SkillCompatibilityState;
  reason: SkillCompatibilityReason;
  installed_contract: number | null;
  running_contract: number | null;
  remedy: { action: SkillRemedyAction; command: string | null };
}

export interface SkillCompatibilityInput {
  target: "absent" | "unmanaged" | "owned";
  manifest: OwnedSkillManifest | null;
  running_contract: number | null;
  assets_match: boolean;
  receipt_digests_match: boolean;
  install_command: string;
}

export interface SkillCompatibilityResult {
  state: SkillState;
  compatibility: SkillCompatibility;
}

function result(
  state: SkillState,
  compatibilityState: SkillCompatibilityState,
  reason: SkillCompatibilityReason,
  installedContract: number | null,
  input: SkillCompatibilityInput,
  action: SkillRemedyAction,
): SkillCompatibilityResult {
  return {
    state,
    compatibility: {
      state: compatibilityState,
      reason,
      installed_contract: installedContract,
      running_contract: input.running_contract,
      remedy: {
        action,
        command: action === "install" || action === "refresh_receipt" ? input.install_command : null,
      },
    },
  };
}

/** Apply the normative state precedence without consulting provenance fields. */
export function classifySkillCompatibility(input: SkillCompatibilityInput): SkillCompatibilityResult {
  if (input.target === "absent") {
    return result("absent", "absent", "target_absent", null, input, "install");
  }
  if (input.target === "unmanaged" || input.manifest === null) {
    return result("unmanaged", "unmanaged", "ownership_unproven", null, input, "user_decision");
  }

  const manifest = input.manifest;
  const installedContract = manifest.compatibility_contract;
  if (
    installedContract !== null &&
    input.running_contract !== null &&
    installedContract > input.running_contract
  ) {
    return result(
      input.assets_match ? "installed" : "stale",
      "newer_contract",
      "installed_contract_newer",
      installedContract,
      input,
      "upgrade_cli",
    );
  }
  if (
    manifest.kind === "v2" &&
    (!manifest.receipt_valid || !input.receipt_digests_match || input.running_contract === null)
  ) {
    return result("stale", "stale", "receipt_invalid", installedContract, input, "install");
  }
  if (
    installedContract !== null &&
    input.running_contract !== null &&
    installedContract < input.running_contract
  ) {
    return result("stale", "stale", "installed_contract_older", installedContract, input, "install");
  }
  if (!input.assets_match) {
    return result("stale", "stale", "asset_drift", installedContract, input, "install");
  }
  if (manifest.kind === "legacy") {
    return result("installed", "current", "legacy_receipt", null, input, "refresh_receipt");
  }
  return result("installed", "current", null, installedContract, input, "none");
}
