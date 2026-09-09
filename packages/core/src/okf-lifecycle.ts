/** OKF v0.2 document lifecycle vocabulary, shared by authoring and Kind diagnostics. */
export const OKF_LIFECYCLE_STATUSES: readonly string[] = Object.freeze(["draft", "stable", "deprecated"]);

export function isOkfLifecycleStatus(value: unknown): value is string {
  return typeof value === "string" && OKF_LIFECYCLE_STATUSES.includes(value);
}
