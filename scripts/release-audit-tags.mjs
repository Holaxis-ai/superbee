// Registry-observing release-policy audit (`npm run release:audit-tags`). Fetches the live
// packument for @holaxis/aslite (dist-tags + versions + publish times) and FAILS when the
// registry contradicts the ratified release policy:
//
//   a. dist-tag state for the phase declared in release/phase.json, with the expected tags
//      computed by scripts/release-state.mjs `resolveTags` — the one policy authority;
//   b. version scheme: pre-stable publishes are `A.B.0-pre.N` with N contiguous from 1 and
//      publish times monotone in N (decisions/version-update-contract §1);
//   c. source-vs-registry drift: packages/cli/package.json must be the newest published
//      version (pre-release-prep) or one sane increment ahead (staged-prep).
//
// NETWORK vs VIOLATION is structural, not textual: unreachable/unhealthy registry throws
// NetworkUnavailableError -> exit 20 (CI turns that into a loud neutral skip); a policy
// violation exits 1; usage errors exit 2. Deliberately NOT part of the offline `npm run check`
// chain — ordinary gates run with the network off.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";
import { resolveTags } from "./release-state.mjs";
import { isStrictSemver } from "./strict-semver.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PACKAGE = "@holaxis/aslite";
export const REGISTRY_URL = "https://registry.npmjs.org/@holaxis%2faslite";
export const EXIT_PASS = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_USAGE = 2;
export const EXIT_NETWORK = 20;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export const PHASES = ["at_rest", "staged", "approved", "promoted", "failed"];

/** Registry unreachable or unhealthy — the audit cannot evaluate policy. Never a red. */
export class NetworkUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkUnavailableError";
  }
}

const PRERELEASE_SCHEME = /^(\d+)\.(\d+)\.(\d+)-pre\.([1-9]\d*)$/;
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(version) {
  if (!isStrictSemver(version)) return null;
  const m = SEMVER.exec(version);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`not semver: ${!pa ? a : b}`);
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1; // release > prerelease
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1; // shorter set of identifiers sorts first
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      if (Number(ia) !== Number(ib)) return Number(ia) < Number(ib) ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric identifiers sort before alphanumeric
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

function violation(code, message) {
  return { code, message };
}

/**
 * Validate the committed phase declaration (release/phase.json). `raw` is the parsed JSON object,
 * or null for an absent file (= at_rest). Throws Error on an invalid declaration — invalid
 * committed policy input is violation-class, not network-class.
 */
export function parsePhaseDeclaration(raw) {
  if (raw === null || raw === undefined) return { phase: "at_rest", kind: null, version: null };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("phase declaration must be a JSON object");
  const phase = raw.phase;
  if (!PHASES.includes(phase)) {
    throw new Error(`phase must be one of ${PHASES.join("|")}, got ${JSON.stringify(phase)}`);
  }
  if (phase === "at_rest") return { phase, kind: null, version: null };
  const kind = raw.kind;
  if (kind !== "prerelease" && kind !== "stable") {
    throw new Error(`phase ${phase} requires kind prerelease|stable, got ${JSON.stringify(kind)}`);
  }
  const version = raw.version;
  if (typeof version !== "string" || !parseSemver(version)) {
    throw new Error(`phase ${phase} requires a strict-SemVer candidate version, got ${JSON.stringify(version)}`);
  }
  return { phase, kind, version };
}

/**
 * A transaction declaration must name the SOURCE candidate: the contract's release-preparation
 * PR puts the candidate version into packages/cli, so during staged/approved/promoted the two
 * must agree, and `kind` must agree with the candidate's form. `failed` is exempt from the
 * source-equality rule only — source may legitimately advance to the replacement while the
 * declaration still identifies the failed candidate.
 */
export function checkDeclarationConsistency(declaration, sourceVersion) {
  const violations = [];
  if (declaration.phase === "at_rest") return violations;
  const formKind = declaration.version.includes("-") ? "prerelease" : "stable";
  if (declaration.kind !== formKind) {
    violations.push(
      violation(
        "declaration_kind_mismatch",
        `declared kind ${declaration.kind} disagrees with candidate ${declaration.version}, which has ${formKind} form`,
      ),
    );
  }
  if (declaration.phase !== "failed" && declaration.version !== sourceVersion) {
    violations.push(
      violation(
        "declaration_source_mismatch",
        `declared candidate ${declaration.version} != packages/cli version ${sourceVersion}; during a ${declaration.phase} transaction the release-preparation source must carry the candidate version`,
      ),
    );
  }
  return violations;
}

/** Contract §1 numbering: pre-stable publishes are A.B.0-pre.N, N contiguous from 1, times monotone. */
export function checkVersionScheme(versions, time, burnedVersions = []) {
  const violations = [];
  const lines = new Map(); // "A.B" -> [{ n, version }]
  for (const version of versions) {
    const parsed = parseSemver(version);
    if (!parsed) {
      violations.push(violation("invalid_semver", `published version ${version} is not SemVer`));
      continue;
    }
    if (parsed.prerelease.length === 0) continue; // post-stable ordinary SemVer
    const m = PRERELEASE_SCHEME.exec(version);
    if (!m || Number(m[3]) !== 0) {
      violations.push(
        violation("off_scheme_version", `published prerelease ${version} is off-scheme (contract allows only A.B.0-pre.N)`),
      );
      continue;
    }
    const line = `${m[1]}.${m[2]}`;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push({ n: Number(m[4]), version });
  }
  // A declared burned number fills its contiguity hole: the number was consumed (immutable tag,
  // never published), so the published sequence legitimately skips it. Undeclared holes still red.
  const burnedByLine = new Map();
  for (const version of burnedVersions) {
    const m = PRERELEASE_SCHEME.exec(version);
    if (m && Number(m[3]) === 0) {
      const line = `${m[1]}.${m[2]}`;
      if (!burnedByLine.has(line)) burnedByLine.set(line, new Set());
      burnedByLine.get(line).add(Number(m[4]));
    }
  }
  for (const [line, entries] of lines) {
    entries.sort((a, b) => a.n - b.n);
    const ns = entries.map((e) => e.n);
    const burnedNs = burnedByLine.get(line) ?? new Set();
    const filled = [...new Set([...ns, ...burnedNs])].sort((a, b) => a - b);
    const expected = Array.from({ length: filled.length }, (_, i) => i + 1);
    if (filled.join(",") !== expected.join(",")) {
      violations.push(
        violation("pre_n_gap", `prerelease line ${line}.0-pre.N is not contiguous from 1: published N = [${ns.join(", ")}]${burnedNs.size > 0 ? ` with declared burns [${[...burnedNs].sort((a, b) => a - b).join(", ")}]` : ""}`),
      );
    }
    for (let i = 1; i < entries.length; i += 1) {
      const prev = time?.[entries[i - 1].version];
      const curr = time?.[entries[i].version];
      if (!prev || !curr) {
        violations.push(violation("missing_publish_time", `registry time entry missing for ${entries[i - (prev ? 0 : 1)].version}`));
        continue;
      }
      if (Date.parse(curr) <= Date.parse(prev)) {
        violations.push(
          violation("pre_n_order", `${entries[i].version} (${curr}) was not published after ${entries[i - 1].version} (${prev})`),
        );
      }
    }
  }
  return violations;
}

function newestOf(versions) {
  return versions.length === 0 ? null : versions.slice().sort(compareSemver)[versions.length - 1];
}

/**
 * Expected dist-tag state for the declared phase, computed via `resolveTags`. The audit derives
 * the priors (the at-rest known-good: newest published, excluding an in-flight candidate) and the
 * policy state machine maps (kind, phase, candidate, priors) -> expected tags.
 */
export function expectedTagState({ declaration, versions, observedTags }) {
  const notes = [];
  const violations = [];
  const stable = versions.filter((v) => parseSemver(v)?.prerelease.length === 0);
  const stableReached = stable.length > 0;

  if (declaration.phase === "at_rest") {
    if (versions.length === 0) {
      violations.push(violation("package_unpublished", `${PACKAGE} has no published versions`));
      return { expected: null, notes, violations };
    }
    if (!stableReached) {
      // Pre-stable at rest: latest == next == newest published prerelease (contract §1).
      const rest = newestOf(versions);
      return { expected: resolveTags({ kind: "prerelease", phase: "at_rest", priorLatest: rest, priorNext: rest }), notes, violations };
    }
    // Post-stable at rest: latest is the newest stable; next only for a genuine newer preview.
    const newestStable = newestOf(stable);
    const observedNext = observedTags?.next;
    const genuinePreview =
      observedNext && versions.includes(observedNext) && compareSemver(observedNext, newestStable) > 0
        ? observedNext
        : undefined;
    if (genuinePreview) notes.push(`next=${genuinePreview} accepted as a genuine published preview newer than latest`);
    return {
      expected: resolveTags({ kind: "stable", phase: "promoted", version: newestStable, priorNext: genuinePreview }),
      notes,
      violations,
    };
  }

  // Transaction phases: priors = newest published excluding the candidate.
  // Assumes npm staged-but-unapproved versions do NOT appear in the public packument; if npm
  // stage semantics differ, the candidate reads as published earlier and the tolerated staged
  // window simply lengthens — no other logic depends on the assumption.
  const { phase, kind, version } = declaration;
  const prior = newestOf(versions.filter((v) => v !== version));
  if (!prior) {
    violations.push(violation("no_prior_release", `phase ${phase} declared but no published prior release exists to hold latest`));
    return { expected: null, notes, violations };
  }
  const candidatePublished = versions.includes(version);
  if (phase === "promoted" && !candidatePublished) {
    violations.push(violation("candidate_unpublished", `phase promoted declares ${version} but it is not published`));
    return { expected: null, notes, violations };
  }
  let expected;
  if ((phase === "staged" || phase === "approved") && !candidatePublished) {
    // npm cannot point a dist-tag at an unpublished version: expect the at-rest prior state.
    notes.push(`candidate ${version} not yet published; expecting tags to still hold the prior known-good ${prior}`);
    expected = resolveTags({ kind, phase: "at_rest", priorLatest: prior, priorNext: prior });
  } else {
    expected = resolveTags({ kind, phase, version, priorLatest: prior, priorNext: prior });
  }
  if (expected.deprecate) {
    notes.push(`policy expects ${expected.deprecate} to be deprecated (deprecation state is not observed by this audit)`);
  }
  // Transition tolerance: the tag flips (promotion, rollback restore) cannot land atomically with
  // the reviewed phase-file commit, so any phase of the DECLARED transaction is accepted; red only
  // when the observed tags match NO transaction state (kind + candidate + priors fixed).
  const accepted = [];
  for (const p of [phase, "staged", "approved", "promoted", "failed"]) {
    const t = resolveTags({ kind, phase: p, version, priorLatest: prior, priorNext: prior });
    if (!candidatePublished && (t.latest === version || t.next === version)) continue;
    if (!accepted.some((a) => a.tags.latest === t.latest && a.tags.next === t.next)) {
      accepted.push({ phase: p, tags: { latest: t.latest, next: t.next } });
    }
  }
  return { expected, accepted, notes, violations };
}

/** Sane successors of the newest published version (source may be prepping the next release). */
export function saneSuccessors(newest) {
  const pre = PRERELEASE_SCHEME.exec(newest);
  if (pre) {
    const [, major, minor, , n] = pre;
    return [
      `${major}.${minor}.0-pre.${Number(n) + 1}`,
      `${major}.${Number(minor) + 1}.0-pre.1`,
      `${major}.${minor}.0`,
    ];
  }
  const parsed = parseSemver(newest);
  if (!parsed || parsed.prerelease.length > 0) return [];
  const { major, minor, patch } = parsed;
  return [
    `${major}.${minor}.${patch + 1}`,
    `${major}.${minor + 1}.0`,
    `${major + 1}.0.0`,
    `${major}.${minor + 1}.0-pre.1`,
    `${major + 1}.0.0-pre.1`,
  ];
}

/**
 * Validate the committed burned-versions declaration (release/burned-versions.json). `raw` is the
 * parsed JSON object, or null for an absent file (= nothing burned). A burned version is a number
 * consumed without publication — its immutable v* tag exists at a commit that can never be
 * released — declared explicitly with a reason so skipping it is a reviewable act, not an
 * inference. Throws Error on an invalid declaration: an unreadable declaration must fail the
 * audit, never silently widen it.
 */
export function readBurnedDeclaration(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("burned-versions declaration must be a JSON object");
  if (!Array.isArray(raw.burned)) throw new Error("burned-versions declaration requires a burned: [] array");
  const seen = new Set();
  for (const entry of raw.burned) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("each burned entry must be an object");
    const parsed = parseSemver(entry.version);
    if (!parsed) throw new Error(`burned entry version ${JSON.stringify(entry.version)} is not SemVer`);
    if (parsed.prerelease.length === 0) throw new Error(`burned entry ${entry.version} is a STABLE version; only never-published prerelease numbers may be burned`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") throw new Error(`burned entry ${entry.version} requires a non-empty reason`);
    if (seen.has(entry.version)) throw new Error(`burned entry ${entry.version} is declared twice`);
    seen.add(entry.version);
  }
  return raw.burned.map((entry) => entry.version);
}

export function checkSourceDrift(sourceVersion, versions, burnedVersions = []) {
  if (!parseSemver(sourceVersion)) {
    return { violations: [violation("invalid_source_version", `packages/cli version ${JSON.stringify(sourceVersion)} is not SemVer`)] };
  }
  const published = new Set(versions);
  const burnedPublished = burnedVersions.filter((v) => published.has(v));
  if (burnedPublished.length > 0) {
    return {
      violations: [
        violation(
          "burned_version_published",
          `burned-versions declaration lists ${burnedPublished.join(", ")} but the registry HAS published ${burnedPublished.length === 1 ? "it" : "them"}; a published number is consumed by publication, not burning — remove ${burnedPublished.length === 1 ? "it" : "them"} from release/burned-versions.json`,
        ),
      ],
    };
  }
  const newest = newestOf(versions);
  if (!newest) return { violations: [], state: "no-published-baseline" };
  if (sourceVersion === newest) return { violations: [], state: "in-sync" };
  // A burned number is consumed: successor chains may step over it, but only through explicitly
  // declared burns — an undeclared skip still fails. Walk each burned link at most once.
  const burned = new Set(burnedVersions);
  const successors = new Set(saneSuccessors(newest));
  let frontier = [...successors].filter((v) => burned.has(v));
  while (frontier.length > 0) {
    const next = [];
    for (const burnedStep of frontier) {
      for (const candidate of saneSuccessors(burnedStep)) {
        if (successors.has(candidate)) continue;
        successors.add(candidate);
        if (burned.has(candidate)) next.push(candidate);
      }
    }
    frontier = next;
  }
  if (successors.has(sourceVersion)) return { violations: [], state: "staged-prep" };
  if (compareSemver(sourceVersion, newest) < 0) {
    return {
      violations: [
        violation(
          "source_behind_registry",
          `packages/cli version ${sourceVersion} is BEHIND newest published ${newest}; sync source to the registry (pull/rebase the release-preparation state) before releasing`,
        ),
      ],
    };
  }
  return {
    violations: [
      violation(
        "source_version_jump",
        `packages/cli version ${sourceVersion} is not a sane successor of newest published ${newest}; expected ${newest} (pre-release-prep) or one of [${[...successors].join(", ")}] (staged-prep)`,
      ),
    ],
  };
}

/**
 * The pure audit over one registry snapshot. Returns { violations, notes, facts }; empty
 * violations means the registry, phase declaration, and source agree with policy.
 */
export function auditRegistryState({ declaration, sourceVersion, registry, burnedVersions = [] }) {
  const { distTags, versions, time } = registry;
  const violations = [];
  const notes = [];

  violations.push(...checkVersionScheme(versions, time, burnedVersions));
  violations.push(...checkDeclarationConsistency(declaration, sourceVersion));

  const tagState = expectedTagState({ declaration, versions, observedTags: distTags });
  violations.push(...tagState.violations);
  notes.push(...tagState.notes);
  if (tagState.expected) {
    const accepted = tagState.accepted ?? [
      { phase: declaration.phase, tags: { latest: tagState.expected.latest, next: tagState.expected.next } },
    ];
    const match = accepted.find((a) => a.tags.latest === distTags?.latest && a.tags.next === distTags?.next);
    if (match) {
      if (match.tags.latest !== tagState.expected.latest || match.tags.next !== tagState.expected.next) {
        notes.push(
          `observed tags match transaction phase ${match.phase} (tolerated transition window while declared phase is ${declaration.phase})`,
        );
      }
    } else {
      for (const tag of ["latest", "next"]) {
        const expected = tagState.expected[tag];
        const observed = distTags?.[tag];
        if (observed !== expected) {
          violations.push(
            violation(
              `${tag}_off_policy`,
              `dist-tag ${tag} is ${observed ?? "(unset)"} but policy for phase ${declaration.phase} expects ${expected}`,
            ),
          );
        }
      }
    }
  }
  for (const tag of Object.keys(distTags ?? {})) {
    if (tag !== "latest" && tag !== "next") {
      violations.push(violation("unexpected_dist_tag", `dist-tag ${tag}=${distTags[tag]} is outside the latest/next policy`));
    }
  }

  const drift = checkSourceDrift(sourceVersion, versions, burnedVersions);
  violations.push(...drift.violations);

  return {
    violations,
    notes,
    facts: {
      phase: declaration.phase,
      kind: declaration.kind,
      candidate: declaration.version,
      source_version: sourceVersion,
      newest_published: newestOf(versions),
      dist_tags: distTags,
      expected_tags: tagState.expected,
      source_state: drift.state ?? "violating",
    },
  };
}

/** HTTP status -> structural class: 200 data, 404 violation-class, anything else network-class. */
export function classifyRegistryStatus(status) {
  if (status === 200) return "ok";
  if (status === 404) return "missing";
  return "unavailable";
}

export async function fetchRegistryState({ url = REGISTRY_URL, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
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

async function readPhaseDeclaration(phaseFile) {
  let raw;
  try {
    raw = await readFile(phaseFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return parsePhaseDeclaration(null);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${phaseFile} is not valid JSON: ${error.message}`);
  }
  return parsePhaseDeclaration(parsed);
}

function arg(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const phaseFile = arg(argv, "--phase-file") ?? path.join(repoRoot, "release", "phase.json");
  const burnedFile = arg(argv, "--burned-file") ?? path.join(repoRoot, "release", "burned-versions.json");
  const registryJson = arg(argv, "--registry-json"); // replay hatch: audit a captured payload
  const registryUrl = arg(argv, "--registry-url") ?? REGISTRY_URL; // test hatch for the network path

  let declaration;
  try {
    declaration = await readPhaseDeclaration(phaseFile);
  } catch (error) {
    console.error(`release-audit: VIOLATION[phase_declaration]: ${error.message}`);
    return EXIT_VIOLATION;
  }
  let burnedVersions;
  try {
    let burnedRaw = null;
    try {
      burnedRaw = JSON.parse(await readFile(burnedFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    burnedVersions = readBurnedDeclaration(burnedRaw);
  } catch (error) {
    console.error(`release-audit: VIOLATION[burned_declaration]: ${error.message}`);
    return EXIT_VIOLATION;
  }
  const cliManifest = JSON.parse(await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"));

  let registry;
  if (registryJson) {
    registry = parsePackument(JSON.parse(await readFile(registryJson, "utf8")));
  } else {
    registry = await fetchRegistryState({ url: registryUrl });
  }
  if (registry.missing) {
    console.error(`release-audit: VIOLATION[package_missing]: registry has no packument for ${PACKAGE}`);
    return EXIT_VIOLATION;
  }

  const result = auditRegistryState({ declaration, sourceVersion: cliManifest.version, registry, burnedVersions });
  console.log(`release-audit: package ${PACKAGE}`);
  console.log(`release-audit: facts ${JSON.stringify(result.facts)}`);
  for (const note of result.notes) console.log(`release-audit: note: ${note}`);
  if (result.violations.length > 0) {
    for (const v of result.violations) console.error(`release-audit: VIOLATION[${v.code}]: ${v.message}`);
    console.error(`release-audit: FAIL (${result.violations.length} violation${result.violations.length === 1 ? "" : "s"})`);
    return EXIT_VIOLATION;
  }
  console.log("release-audit: PASS — registry dist-tags, version scheme, and source version agree with policy");
  return EXIT_PASS;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof NetworkUnavailableError) {
        console.error(`release-audit: NETWORK: ${error.message} — policy not evaluated (neutral, exit ${EXIT_NETWORK})`);
        process.exitCode = EXIT_NETWORK;
        return;
      }
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = EXIT_USAGE;
    });
}
