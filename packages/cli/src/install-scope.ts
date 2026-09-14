export type InstallScope = "project" | "user";

/** Normalize the retired `global` spelling onto the per-user install target. */
export function normalizeInstallScope(value: string | undefined): InstallScope | undefined {
  if (value === undefined || value === "project") return "project";
  if (value === "user" || value === "global") return "user";
  return undefined;
}
