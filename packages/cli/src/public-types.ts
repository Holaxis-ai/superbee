export type ArtifactChannel = "npm-package" | "local-dev" | "unknown";
export type LaunchMode = "path" | "direct" | "npx-inferred" | "source" | "unknown";
export type LaunchConfidence = "certain" | "inferred" | "unknown";


export interface CompatibilityContracts {
  skill: number | null;
  hook: number | null;
  mcp: number | null;
}

export interface StaticBuildIdentity {
  schema: "superbee.build-identity.v1";
  package: { name: string; version: string };
  source: { commit: string | null; dirty: boolean | null };
  artifact: { channel: ArtifactChannel };
  compatibility_contracts: CompatibilityContracts;
}

export interface BuildIdentityEnvelope {
  identity: {
    schema: "superbee.build-identity.v1";
    package: { name: string; version: string };
    source: { commit: string | null; dirty: boolean | null };
    artifact: { channel: ArtifactChannel; sha256: string | null };
    runtime: {
      executable_path: string | null;
      invocation: string;
      launch_mode: LaunchMode;
      launch_confidence: LaunchConfidence;
    };
    compatibility_contracts: CompatibilityContracts;
  };
  drift: { adjacent_package_version: string | null; version_mismatch: boolean };
}

export interface SourcePackageIdentity { readonly name: string; readonly version: string }
