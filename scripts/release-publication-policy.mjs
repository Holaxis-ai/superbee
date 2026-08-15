// The publication-policy authority: release/targets.json is the ONE place a human writes where a
// version lands on npm, and everything that reasons about dist-tags derives from it here.
//
// A declared tuple states the COMPLETE dist-tag destiny of its version: `npm_tag` is where the stage
// publishes it, `npm_promote_tag` is where finalize moves it, and those are the only dist-tags that
// version may ever carry. Two consumers share this one derivation so publication policy and audit
// policy cannot drift apart:
//
//   - scripts/release-audit-tags.mjs computes its expected at-rest/transaction tag state from it;
//   - this module's CLI is the finalizer's PRE-MUTATION precondition
//     (.github/workflows/release-finalize.yml, target-authorized job).
//
// WHY A PRECONDITION AND NOT A STEP. Every npm registry WRITE in this design is an out-of-band 2FA
// operator action emitted by the stage receipt: `npm stage approve` puts the version on its npm_tag,
// `npm dist-tag add` moves it to its npm_promote_tag. The finalize workflow holds no npm credential
// and performs neither — npm 11.15.0 exchanges the GitHub OIDC token inside `npm publish` only
// (lib/utils/oidc.js has exactly one call site, lib/commands/publish.js), so trusted publishing
// cannot authenticate a dist-tag write, and a long-lived npm token in CI would be a security
// downgrade to fix an ordering bug. So the workflow PROVES the operator's half landed, before it has
// mutated anything.
//
// TWO DIRECTIONS, ENFORCED DIFFERENTLY ON PURPOSE:
//   - FORBIDDEN (a version holding a dist-tag the manifest never gives it) is enforced in EVERY mode
//     and never retried — an unauthorized promotion is a stable live-registry fact.
//   - REQUIRED (every declared dist-tag already pointing at the version) is enforced in live mode and
//     reported in dry-run, where the version may legitimately not be published yet.
//
// NETWORK vs VIOLATION is structural, carried by the exit code, never by message text:
//   0  -> the registry holds the declared state
//   1  -> policy violation: the registry contradicts release/targets.json
//   2  -> usage error
//   20 -> registry unreachable/unhealthy: the precondition could NOT be evaluated
// A precondition that could not be evaluated has not been met, so the workflow treats 20 as fatal —
// but it is a DIFFERENT fatal from 1, and the operator is told which. Because this runs seconds after
// an operator's `npm dist-tag add`, a bounded retry absorbs registry read-after-write lag before
// concluding "not promoted"; it never retries a forbidden state, and it still fails closed.

import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { isMainModule } from "./is-main-module.mjs";
import { promoteOperation } from "./release-operations.mjs";
import { defaultReleaseManifest, loadReleaseTargets, resolveAllowedTupleByTarget } from "./release-targets.mjs";

export const REGISTRY_BASE_URL = "https://registry.npmjs.org";
export const EXIT_PASS = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_USAGE = 2;
export const EXIT_NETWORK = 20;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_ATTEMPTS = 6;
const DEFAULT_DELAY_MS = 2000;

/** Packument URL for a package name; a scoped name's `/` is the escaped `%2f` the registry wants. */
export function registryUrlFor(packageName) {
  return `${REGISTRY_BASE_URL}/${packageName.replace("/", "%2f")}`;
}

/** Registry unreachable or unhealthy — policy cannot be evaluated. Never a policy violation. */
export class NetworkUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkUnavailableError";
  }
}

function violation(code, message) {
  return { code, message };
}

// ---------------------------------------------------------------------------------------------
// Registry observation
// ---------------------------------------------------------------------------------------------

/** HTTP status -> structural class: 200 data, 404 violation-class, anything else network-class. */
export function classifyRegistryStatus(status) {
  if (status === 200) return "ok";
  if (status === 404) return "missing";
  return "unavailable";
}

/**
 * Validate a 200 packument body (or a captured replay of it). A malformed-but-200 body is a
 * registry-health condition — NetworkUnavailableError, never a crash or a policy violation.
 * Accepts `versions` as the packument's manifest map or a captured `npm view` string array.
 */
export function parsePackument(body) {
  const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const versionsOk =
    isRecord(body?.versions) ||
    (Array.isArray(body?.versions) && body.versions.every((v) => typeof v === "string"));
  if (!isRecord(body) || !isRecord(body["dist-tags"]) || !versionsOk || !isRecord(body.time)) {
    throw new NetworkUnavailableError("registry returned 200 with a malformed packument body");
  }
  const { created, modified, ...versionTimes } = body.time;
  return {
    missing: false,
    distTags: body["dist-tags"],
    versions: Array.isArray(body.versions) ? body.versions : Object.keys(body.versions),
    time: versionTimes,
  };
}

export async function fetchRegistryState({ url, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      // A precondition read that follows an operator's dist-tag write must not be served a stale
      // CDN copy; revalidation is cheap and the bounded retry below covers what it does not.
      headers: { accept: "application/json", "cache-control": "no-cache" },
    });
  } catch (error) {
    throw new NetworkUnavailableError(`registry request failed: ${error?.message ?? error}`);
  }
  const klass = classifyRegistryStatus(response.status);
  if (klass === "unavailable") throw new NetworkUnavailableError(`registry responded ${response.status}`);
  if (klass === "missing") return { missing: true };
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new NetworkUnavailableError(`registry response read failed: ${error?.message ?? error}`);
  }
  if (text.length > MAX_BODY_BYTES) throw new NetworkUnavailableError("registry response exceeded the size bound");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new NetworkUnavailableError("registry response was not JSON");
  }
  return parsePackument(body);
}

// ---------------------------------------------------------------------------------------------
// Publication policy derived from release/targets.json
// ---------------------------------------------------------------------------------------------

/**
 * DIST-TAG DESTINY — the single derivation that keeps publication policy and audit policy from
 * drifting. Returns `Map<version, Set<tag>>` covering only the declared tuples of `packageName`.
 * A published version with no declared tuple predates the manifest and is unconstrained by it (see
 * `mayHoldDistTag`), which is why adding this derivation cannot retroactively red the history.
 */
export function distTagDestiny(manifest, packageName) {
  const destiny = new Map();
  for (const tuple of Object.values(manifest?.allowed_tuples ?? {})) {
    if (tuple.package !== packageName) continue;
    const declared = destiny.get(tuple.version) ?? new Set();
    for (const tag of [tuple.publication?.npm_tag, tuple.publication?.npm_promote_tag]) {
      if (typeof tag === "string") declared.add(tag);
    }
    destiny.set(tuple.version, declared);
  }
  return destiny;
}

const destinyCache = new Map();

/**
 * Destiny for the committed manifest. Reading the manifest is the DEFAULT rather than an opt-in so
 * a caller that forgets to pass one still evaluates against real policy; an unreadable or invalid
 * manifest throws here and every CLI turns that into a non-zero exit (fail closed, never "no
 * constraint").
 */
export function defaultDistTagDestiny(packageName) {
  if (!destinyCache.has(packageName)) destinyCache.set(packageName, distTagDestiny(defaultReleaseManifest(), packageName));
  return destinyCache.get(packageName);
}

/** May `version` carry `tag`? Versions the manifest does not declare are unconstrained by it. */
export function mayHoldDistTag(destiny, version, tag) {
  const declared = destiny.get(version);
  return declared === undefined || declared.has(tag);
}

export function describeDestiny(destiny, version) {
  const declared = destiny.get(version);
  if (declared === undefined) return "undeclared (predates the publication manifest)";
  return declared.size === 0 ? "no dist-tag at all" : [...declared].sort().join("+");
}

/** The published versions the manifest permits to hold `tag`, in the order given. */
export function eligibleFor(destiny, versions, tag) {
  return versions.filter((version) => mayHoldDistTag(destiny, version, tag));
}

/**
 * FORBIDDEN state: a version sitting on a dist-tag it is never published or promoted to. Enforced in
 * every mode and never retried — an unauthorized promotion is not a timing condition.
 */
export function checkUnauthorizedDistTags({ destiny, version, distTags }) {
  const violations = [];
  for (const [tag, holder] of Object.entries(distTags ?? {})) {
    if (holder !== version || mayHoldDistTag(destiny, version, tag)) continue;
    violations.push(
      violation(
        "unauthorized_dist_tag",
        `dist-tag ${tag} points at ${version}, which the publication manifest declares as ${describeDestiny(destiny, version)}`,
      ),
    );
  }
  return violations;
}

/**
 * REQUIRED state: every dist-tag a declared version is destined for must already point at it. Both
 * halves are 2FA operator actions — `npm_tag` lands when the operator approves the stage,
 * `npm_promote_tag` when the operator runs `npm dist-tag add` — so this is the finalizer's proof that
 * the human half of the release completed. Violations carry the unmet `tag` so the caller can print
 * the right remediation.
 */
export function checkDeclaredDistTags({ destiny, version, distTags }) {
  const declared = destiny.get(version);
  if (declared === undefined) return []; // undeclared version: the manifest requires nothing of it
  const violations = [];
  for (const tag of [...declared].sort()) {
    const observed = distTags?.[tag];
    if (observed === version) continue;
    violations.push({
      ...violation(
        "declared_dist_tag_unmet",
        `publication policy puts ${version} on dist-tag ${tag}, but the registry has ${tag}=${observed ?? "(unset)"}`,
      ),
      tag,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------------------------
// `verify` — the finalizer's pre-mutation precondition
// ---------------------------------------------------------------------------------------------

function arg(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

function requiredArg(argv, flag) {
  const value = arg(argv, flag);
  if (value === undefined) throw new Error(`missing ${flag}`);
  return value;
}

function positiveInteger(value, flag, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

/** The one remediation renderer: each unmet dist-tag has exactly one owner, and it is never the workflow. */
function remediationFor({ item, promoteTag, version, target }) {
  return item.tag === promoteTag
    ? `run the operator promotion (+2FA), then re-dispatch: ${promoteOperation({ version, tag: item.tag, target }).command}`
    : `dist-tag ${item.tag} is set by the staged publish — approve the stage (npm stage approve <stage-id>, +2FA) before finalizing`;
}

export async function verify(argv) {
  let target;
  let version;
  let mode;
  let attempts;
  let delayMs;
  try {
    target = requiredArg(argv, "--target");
    version = requiredArg(argv, "--version");
    mode = arg(argv, "--mode") ?? "dry-run";
    if (mode !== "live" && mode !== "dry-run") throw new Error(`--mode must be live|dry-run, got ${JSON.stringify(mode)}`);
    attempts = positiveInteger(arg(argv, "--attempts"), "--attempts", DEFAULT_ATTEMPTS);
    delayMs = positiveInteger(arg(argv, "--delay-ms"), "--delay-ms", DEFAULT_DELAY_MS);
  } catch (error) {
    console.error(`release-publication-policy: USAGE: ${error.message}`);
    return EXIT_USAGE;
  }
  const registryJson = arg(argv, "--registry-json"); // replay hatch: verify a captured payload
  const registryUrl = arg(argv, "--registry-url"); // test hatch for the network path
  const manifestFile = arg(argv, "--targets-file");

  const manifest = manifestFile ? await loadReleaseTargets(manifestFile) : await loadReleaseTargets();
  const tuple = resolveAllowedTupleByTarget(manifest, { target });
  if (tuple.version !== version) {
    console.error(
      `release-publication-policy: VIOLATION[target_version_mismatch]: target ${target} is allowlisted at ${tuple.version}, not ${version}`,
    );
    return EXIT_VIOLATION;
  }
  const destiny = distTagDestiny(manifest, tuple.package);
  const promoteTag = tuple.publication.npm_promote_tag;
  const url = registryUrl ?? registryUrlFor(tuple.package);
  console.log(`release-publication-policy: verify ${tuple.package}@${version} target=${target} mode=${mode}`);

  // Bounded retry over the ONE condition that is legitimately transient: the registry not yet
  // reflecting an operator dist-tag write made moments ago. A forbidden state is never retried, and
  // exhausting the attempts still fails closed.
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= attempts;
    let registry;
    try {
      registry = registryJson
        ? parsePackument(JSON.parse(await readFile(registryJson, "utf8")))
        : await fetchRegistryState({ url });
    } catch (error) {
      if (!(error instanceof NetworkUnavailableError) || last) throw error;
      console.log(`release-publication-policy: registry unavailable (${error.message}); attempt ${attempt}/${attempts}, retrying`);
      await delay(delayMs);
      continue;
    }

    if (registry.missing) {
      if (mode === "live") {
        console.error(`release-publication-policy: VIOLATION[package_missing]: registry has no packument for ${tuple.package}`);
        return EXIT_VIOLATION;
      }
      console.log(`release-publication-policy: [dry-run] ${tuple.package} is not published yet; nothing can hold a dist-tag`);
      return EXIT_PASS;
    }

    const distTags = registry.distTags;
    const forbidden = checkUnauthorizedDistTags({ destiny, version, distTags });
    const outstanding = checkDeclaredDistTags({ destiny, version, distTags });

    if (forbidden.length === 0 && outstanding.length > 0 && mode === "live" && !last) {
      console.log(
        `release-publication-policy: declared dist-tags not visible yet (${outstanding.map((item) => item.tag).join(", ")}); attempt ${attempt}/${attempts}, retrying in case the registry read lags the operator write`,
      );
      await delay(delayMs);
      continue;
    }

    console.log(
      `release-publication-policy: facts ${JSON.stringify({
        package: tuple.package,
        version,
        promote_tag: promoteTag,
        declared: describeDestiny(destiny, version),
        dist_tags: distTags,
        attempts_used: attempt,
      })}`,
    );

    const violations = [...forbidden];
    if (mode === "live") {
      violations.push(...outstanding);
    } else {
      for (const item of outstanding) console.log(`release-publication-policy: [dry-run] live finalize would require: ${item.message}`);
    }
    if (violations.length > 0) {
      for (const item of violations) console.error(`release-publication-policy: VIOLATION[${item.code}]: ${item.message}`);
      for (const item of outstanding) console.error(`release-publication-policy: ${remediationFor({ item, promoteTag, version, target })}`);
      return EXIT_VIOLATION;
    }
    console.log(`release-publication-policy: PASS — the registry holds the publication policy declared for ${tuple.package}@${version}`);
    return EXIT_PASS;
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== "verify") {
    console.error("usage: release-publication-policy.mjs verify --target <id> --version <v> [--mode live|dry-run]");
    return EXIT_USAGE;
  }
  return verify(argv.slice(1));
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof NetworkUnavailableError) {
        console.error(
          `release-publication-policy: NETWORK: ${error.message} — the precondition could NOT be evaluated (exit ${EXIT_NETWORK})`,
        );
        process.exitCode = EXIT_NETWORK;
        return;
      }
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = EXIT_USAGE;
    });
}
