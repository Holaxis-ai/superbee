const STRICT_SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isStrictSemver(value) {
  if (typeof value !== "string") return false;
  const match = STRICT_SEMVER.exec(value);
  if (!match) return false;
  const prerelease = match[4]?.split(".") ?? [];
  return !prerelease.some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"));
}

export function assertStrictSemver(value, label = "version") {
  if (!isStrictSemver(value)) throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}
