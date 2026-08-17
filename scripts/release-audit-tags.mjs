// The scheduled release-policy audit (`npm run release:audit-tags`). It watches whichever package the
// manifest's successor-stable tuple declares -- see `auditedPackage` below -- so it follows the rename
// instead of staying pinned to the coordinate being retired. Fetches the
// live packument (dist-tags + versions + publish times) and FAILS when the registry contradicts the
// ratified release policy:
//
//   a. dist-tag state for the phase declared in release/phase.json. Two authorities compose here and
//      neither restates the other: scripts/release-state.mjs `resolveTags` owns the PHASE MACHINE,
//      and release/targets.json owns which dist-tags a version may ever carry — derived by
//      `distTagDestiny` in scripts/release-publication-policy.mjs, the module this one reads policy
//      from. The manifest decides eligibility, resolveTags decides the transient window.
//   b. version scheme: pre-stable publishes are `A.B.0-pre.N` with N contiguous from 1 and
//      publish times monotone in N (decisions/version-update-contract §1);
//   c. source-vs-registry drift: packages/cli/package.json must be the newest published
//      version (pre-release-prep) or one sane increment ahead (staged-prep).
//
// NETWORK vs VIOLATION is structural, not textual: an unreachable/unhealthy registry throws
// NetworkUnavailableError -> exit 20 (CI turns that into a loud neutral skip, because this audit is a
// lint); a policy violation exits 1; usage errors exit 2. Deliberately NOT part of the offline
// `npm run check` chain — ordinary gates run with the network off.
//
// The finalizer's pre-mutation precondition over the same policy derivation is a different entry
// point with a different failure contract: scripts/release-publication-policy.mjs verify.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";
import {
  EXIT_NETWORK,
  EXIT_PASS,
  EXIT_USAGE,
  EXIT_VIOLATION,
  NetworkUnavailableError,
  classifyRegistryStatus,
  defaultDistTagDestiny,
  describeDestiny,
  eligibleFor,
  fetchRegistryState,
  mayHoldDistTag,
  parsePackument,
  registryUrlFor,
} from "./release-publication-policy.mjs";
import { resolveTags } from "./release-state.mjs";
import { defaultReleaseManifest } from "./release-targets.mjs";
import { isStrictSemver } from "./strict-semver.mjs";

// Re-exported, not re-implemented: these are this CLI's documented contract surface (exit 20 vs 1),
// and release-publication-policy.mjs is their single owner.
export {
  EXIT_NETWORK,
  EXIT_PASS,
  EXIT_USAGE,
  EXIT_VIOLATION,
  NetworkUnavailableError,
  classifyRegistryStatus,
  fetchRegistryState,
  parsePackument,
  registryUrlFor,
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The package this standing audit watches, derived from the manifest rather than written here.
 *
 * It was hardcoded to the retiring name, which meant that the moment the rename completed the
 * audit would keep watching an abandoned package and never observe the live one — the exact drift
 * it exists to catch. Reading it from the successor-stable tuple makes it follow the rename with
 * no edit. `--package` overrides it for the transition window, when the old name is still live
 * and worth a second look.
 */
export function auditedPackage(manifest = defaultReleaseManifest()) {
  const tuple = manifest.allowed_tuples["successor-stable"];
  if (!tuple?.package) throw new Error("release audit cannot resolve the successor-stable package from the release manifest");
  return tuple.package;
}

export const PACKAGE = auditedPackage();
export const REGISTRY_URL = registryUrlFor(PACKAGE);
export const PHASES = ["at_rest", "staged", "approved", "promoted", "failed"];

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

/**
 * Contract §1 numbering: pre-stable publishes are A.B.0-pre.N, N contiguous from 1, times monotone.
 *
 * `schemeExceptions` are published numbers grandfathered by release/scheme-exceptions.json. An
 * exception is skipped ENTIRELY — it raises no scheme violation and takes no place in its line's
 * contiguity — because publication is irreversible: once an off-scheme number is on the registry,
 * the audit either fails forever or the specific number is excepted. A declared exception the
 * registry has not published is itself a violation, so the list cannot pre-authorize a shape.
 */
export function checkVersionScheme(versions, time, burnedVersions = [], schemeExceptions = []) {
  const violations = [];
  const excepted = new Set(schemeExceptions);
  const published = new Set(versions);
  for (const version of schemeExceptions) {
    if (!published.has(version)) {
      violations.push(
        violation(
          "stale_scheme_exception",
          `scheme-exceptions declaration lists ${version} but the registry has NOT published it; an exception describes a published fact, so remove it from release/scheme-exceptions.json rather than pre-authorizing the shape`,
        ),
      );
    }
  }
  const lines = new Map(); // "A.B" -> [{ n, version }]
  for (const version of versions) {
    if (excepted.has(version)) continue; // grandfathered: no scheme check, no contiguity slot
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
 * Expected dist-tag state for the declared phase. Two authorities compose here, each owning exactly
 * one thing: the PUBLICATION MANIFEST owns which dist-tags a version may ever carry (`destiny`), and
 * `resolveTags` owns the transient window a transaction passes through. The priors handed to the
 * phase machine are therefore the newest published version ELIGIBLE for each tag, not simply the
 * newest published version — that is what lets a candidate published to `next` only leave `latest`
 * where it is without the audit reading it as drift.
 */
/**
 * True only for a coordinate whose entire published history is one version that reserves the name:
 * exactly one version, `latest` on it, no `next`, no other tag, and the manifest does not declare
 * that version as a release tuple. Every clause is load-bearing — relaxing any of them would let a
 * genuinely broken registry state read as "not started yet".
 */
export function isNameReservingPlaceholder({ versions, observedTags, destiny }) {
  if (versions.length !== 1) return false;
  const only = versions[0];
  const tags = Object.keys(observedTags ?? {});
  if (tags.length !== 1 || tags[0] !== "latest") return false;
  if (observedTags.latest !== only) return false;
  return destiny?.has?.(only) !== true; // a declared tuple version is a release, not a placeholder
}

export function expectedTagState({ declaration, versions, observedTags, destiny = defaultDistTagDestiny(PACKAGE) }) {
  const notes = [];
  const violations = [];
  const stable = versions.filter((v) => parseSemver(v)?.prerelease.length === 0);
  const stableReached = stable.length > 0;

  if (declaration.phase === "at_rest") {
    if (versions.length === 0) {
      violations.push(violation("package_unpublished", `${PACKAGE} has no published versions`));
      return { expected: null, notes, violations };
    }
    // A coordinate that has never been released through this machinery cannot satisfy a policy
    // written for one mid-lifecycle. The successor currently holds a single placeholder version
    // reserving the name, with `latest` on it and no `next` — the state the cutover plan expects
    // to find before any production change. Legal, and deliberately narrow: it stops applying the
    // moment a second version exists, or `next` appears, or the manifest declares the published
    // version, so the check re-arms by itself at the first real release.
    if (isNameReservingPlaceholder({ versions, observedTags, destiny })) {
      notes.push(
        `${PACKAGE} holds only the name-reserving placeholder ${versions[0]} with no next tag; no release transaction has occurred on this coordinate`,
      );
      return { expected: null, notes, violations };
    }
    if (!stableReached) {
      // Pre-stable at rest: latest == next == newest published prerelease (contract §1) — except
      // that a version the manifest publishes to `next` only can never take `latest`, so each tag
      // rests on the newest version eligible for it.
      const restLatest = newestOf(eligibleFor(destiny, versions, "latest"));
      const restNext = newestOf(eligibleFor(destiny, versions, "next"));
      if (!restLatest) {
        violations.push(violation("no_latest_eligible_version", `no published version of ${PACKAGE} is eligible to hold dist-tag latest under the publication manifest`));
        return { expected: null, notes, violations };
      }
      if (restLatest !== restNext) {
        notes.push(`latest rests on ${restLatest}: the publication manifest declares ${restNext} as ${describeDestiny(destiny, restNext)}`);
      }
      return { expected: resolveTags({ kind: "prerelease", phase: "at_rest", priorLatest: restLatest, priorNext: restNext }), notes, violations };
    }
    // Post-stable at rest: latest is the newest latest-eligible stable; next only for a genuine
    // newer preview the manifest actually publishes to next.
    const newestStable = newestOf(eligibleFor(destiny, stable, "latest"));
    if (!newestStable) {
      violations.push(violation("no_latest_eligible_version", `no published stable version of ${PACKAGE} is eligible to hold dist-tag latest under the publication manifest`));
      return { expected: null, notes, violations };
    }
    const observedNext = observedTags?.next;
    const genuinePreview =
      observedNext &&
      versions.includes(observedNext) &&
      mayHoldDistTag(destiny, observedNext, "next") &&
      compareSemver(observedNext, newestStable) > 0
        ? observedNext
        : undefined;
    if (genuinePreview) notes.push(`next=${genuinePreview} accepted as a genuine published preview newer than latest`);
    return {
      expected: resolveTags({ kind: "stable", phase: "promoted", version: newestStable, priorNext: genuinePreview }),
      notes,
      violations,
    };
  }

  // Transaction phases: priors = newest published EXCLUDING the candidate, per tag.
  // Assumes npm staged-but-unapproved versions do NOT appear in the public packument; if npm
  // stage semantics differ, the candidate reads as published earlier and the tolerated staged
  // window simply lengthens — no other logic depends on the assumption.
  const { phase, kind, version } = declaration;
  const priorVersions = versions.filter((v) => v !== version);
  const priorLatest = newestOf(eligibleFor(destiny, priorVersions, "latest"));
  const priorNext = newestOf(eligibleFor(destiny, priorVersions, "next"));
  if (!priorLatest || !priorNext) {
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
    notes.push(`candidate ${version} not yet published; expecting tags to still hold the prior known-good latest=${priorLatest} next=${priorNext}`);
    expected = resolveTags({ kind, phase: "at_rest", priorLatest, priorNext });
  } else {
    expected = resolveTags({ kind, phase, version, priorLatest, priorNext });
  }
  // A declared phase that would place the candidate on a dist-tag the manifest never gives it is a
  // contradiction between two committed files, not a tolerable transition. Red it, and hold the
  // expectation at the prior so the remaining comparison still says something useful.
  for (const tag of ["latest", "next"]) {
    if (expected[tag] !== version || mayHoldDistTag(destiny, version, tag)) continue;
    violations.push(
      violation(
        "phase_contradicts_publication_policy",
        `phase ${phase} expects dist-tag ${tag} to hold ${version}, but the publication manifest declares ${version} as ${describeDestiny(destiny, version)}`,
      ),
    );
    expected = { ...expected, [tag]: tag === "latest" ? priorLatest : priorNext };
  }
  if (expected.deprecate) {
    notes.push(`policy expects ${expected.deprecate} to be deprecated (deprecation state is not observed by this audit)`);
  }
  // Transition tolerance: the tag flips (promotion, rollback restore) cannot land atomically with
  // the reviewed phase-file commit, so any phase of the DECLARED transaction is accepted; red only
  // when the observed tags match NO transaction state (kind + candidate + priors fixed). A state
  // the publication manifest forbids is NOT tolerated — tolerance covers timing, never policy.
  const accepted = [];
  for (const p of [phase, "staged", "approved", "promoted", "failed"]) {
    const t = resolveTags({ kind, phase: p, version, priorLatest, priorNext });
    if (!candidatePublished && (t.latest === version || t.next === version)) continue;
    if (["latest", "next"].some((tag) => t[tag] === version && !mayHoldDistTag(destiny, version, tag))) continue;
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

/**
 * Validate the committed scheme-exceptions declaration (release/scheme-exceptions.json). `raw` is
 * the parsed JSON object, or null for an absent file (= nothing excepted). An exception is a
 * PUBLISHED prerelease number whose shape the contract does not allow, grandfathered explicitly
 * with a reason because publication cannot be undone. This is the mirror image of the burn ledger
 * and shares its failure discipline: an unreadable declaration must fail the audit, never silently
 * widen it. The published-vs-unpublished check belongs to checkVersionScheme, which sees the
 * registry; this validator only enforces the declaration's own shape.
 */
export function readSchemeExceptionsDeclaration(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("scheme-exceptions declaration must be a JSON object");
  if (!Array.isArray(raw.exceptions)) throw new Error("scheme-exceptions declaration requires an exceptions: [] array");
  const seen = new Set();
  for (const entry of raw.exceptions) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("each scheme-exception entry must be an object");
    const parsed = parseSemver(entry.version);
    if (!parsed) throw new Error(`scheme-exception entry version ${JSON.stringify(entry.version)} is not SemVer`);
    if (parsed.prerelease.length === 0) throw new Error(`scheme-exception entry ${entry.version} is a STABLE version; the prerelease scheme constrains prereleases only`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") throw new Error(`scheme-exception entry ${entry.version} requires a non-empty reason`);
    if (seen.has(entry.version)) throw new Error(`scheme-exception entry ${entry.version} is declared twice`);
    seen.add(entry.version);
  }
  return raw.exceptions.map((entry) => entry.version);
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
export function auditRegistryState({ declaration, sourceVersion, registry, burnedVersions = [], schemeExceptions = [], destiny = defaultDistTagDestiny(PACKAGE) }) {
  const { distTags, versions, time } = registry;
  const violations = [];
  const notes = [];

  violations.push(...checkVersionScheme(versions, time, burnedVersions, schemeExceptions));
  violations.push(...checkDeclarationConsistency(declaration, sourceVersion));

  const tagState = expectedTagState({ declaration, versions, observedTags: distTags, destiny });
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
  const schemeExceptionsFile = arg(argv, "--scheme-exceptions-file") ?? path.join(repoRoot, "release", "scheme-exceptions.json");
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
  let schemeExceptions;
  try {
    let exceptionsRaw = null;
    try {
      exceptionsRaw = JSON.parse(await readFile(schemeExceptionsFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    schemeExceptions = readSchemeExceptionsDeclaration(exceptionsRaw);
  } catch (error) {
    console.error(`release-audit: VIOLATION[scheme_exceptions_declaration]: ${error.message}`);
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

  const result = auditRegistryState({ declaration, sourceVersion: cliManifest.version, registry, burnedVersions, schemeExceptions });
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
