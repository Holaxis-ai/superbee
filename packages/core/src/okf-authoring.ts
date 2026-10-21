import { InvalidInputError } from "./errors.js";

export const SUPPORTED_OKF_AUTHORING_VERSIONS = ["0.1", "0.2"] as const;
export const DEFAULT_OKF_AUTHORING_VERSION = "0.2";

export function resolveOkfAuthoringVersion(requested?: string): string {
  const version = requested ?? DEFAULT_OKF_AUTHORING_VERSION;
  if (!(SUPPORTED_OKF_AUTHORING_VERSIONS as readonly string[]).includes(version)) {
    throw new InvalidInputError(
      `Unsupported OKF authoring version '${version}'. This build can author ${SUPPORTED_OKF_AUTHORING_VERSIONS.join(" and ")}; ` +
        "bundles declaring other versions can still be read or transported.",
    );
  }
  return version;
}
