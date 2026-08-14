const STRICT_SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const MAX_STRICT_SEMVER_LENGTH = 256;

export function isStrictSemver(value) {
  return parseStrictSemver(value) !== undefined;
}

export function parseStrictSemver(value) {
  if (typeof value !== "string" || value.length > MAX_STRICT_SEMVER_LENGTH) return undefined;
  const match = STRICT_SEMVER.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"))) return undefined;
  return { major: match[1], minor: match[2], patch: match[3], prerelease };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareStrictSemver(left, right) {
  const a = parseStrictSemver(left);
  const b = parseStrictSemver(right);
  if (!a || !b) return undefined;
  for (const key of ["major", "minor", "patch"]) {
    const compared = compareNumericIdentifiers(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const leftPart = a.prerelease[i];
    const rightPart = b.prerelease[i];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function assertStrictSemver(value, label = "version") {
  if (!isStrictSemver(value)) throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}
