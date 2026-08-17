// What can we actually release next?
//
// Three LAYERS, deliberately separate, because collapsing them is what produced the class of error
// this command exists to prevent:
//
//   1. SHAPE      nextVersionCandidates(from) -- which version numbers are well-formed successors.
//                 Pure numbering scheme. Knows nothing about this repository, the registry, or burns.
//   2. CONSUMED   screenForConsumption(...)   -- which of those numbers are already spent for real:
//                 published to the registry, or holding an immutable v* tag. Also reports which
//                 reviewed tuple plans to use a number, which is information, not a blocker.
//   3. BURNS      screenForBurns(...)         -- a LAST-MILE safety net, applied after the fact.
//
// Burns are deliberately NOT part of layers 1 or 2. A burn is bookkeeping about a number that was
// consumed without publication; it is not part of the numbering scheme, and treating it as such is
// how the audit ended up with `checkVersionScheme` taking a burn ledger as an argument. Once layers
// 1 and 2 are right, a forward-looking query should rarely collide with a burn at all -- so when
// layer 3 fires, that is worth noticing rather than routing around.
//
// The SHAPE layer imports `saneSuccessors` and never restates it. That matters: the rule used to be
// encoded twice (there, and in `checkVersionScheme`'s patch-digit test), the two drifted, and the
// drift produced "no legal next stable exists" while each half looked locally reasonable. A second
// implementation of the rule is the bug, not the fix.
//
//   node scripts/release-next-versions.mjs             # from the newest published version
//   node scripts/release-next-versions.mjs --from 0.1.1-pre.2
//   node scripts/release-next-versions.mjs --offline --json
//
// SCOPE: this answers for `superbee` and nothing else -- the package the release manifest's
// successor-stable tuple declares. It deliberately takes no --package flag. The repository also
// carries a `bridge` tuple publishing @holaxis/aslite, whose version history is separate and is not
// superbee's to reason about; that target is expected to move to the team that owns it. Every line of
// output names the package it describes so this is never mistaken for the bridge's answer.
//
// Exit 0 whenever the question was answered, including "nothing is usable" -- this is a lens, not a
// gate. Exit 2 on usage error, 20 if the registry was needed and unreachable (matching the audit's
// network-vs-violation split, so a flaky network never reads as a policy answer).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isMainModule } from "./is-main-module.mjs";
import { PACKAGE, readBurnedDeclaration, saneSuccessors } from "./release-audit-tags.mjs";
import {
  EXIT_NETWORK,
  EXIT_PASS,
  EXIT_USAGE,
  NetworkUnavailableError,
  fetchRegistryState,
  registryUrlFor,
} from "./release-publication-policy.mjs";
import { loadReleaseTargets } from "./release-targets.mjs";
import { compareStrictSemver, isStrictSemver } from "./strict-semver.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------- layer 1: SHAPE

/**
 * The well-formed successors of `from`, per the numbering scheme and nothing else. No registry, no
 * repository, no ledger. Deliberately a thin alias over the single definition of the rule.
 */
export function nextVersionCandidates(from) {
  return saneSuccessors(from);
}

// ------------------------------------------------------------ layer 2: CONSUMED

/**
 * Tags that exist, from the AUTHORITATIVE source. A spent tag is the hardest blocker, because v*
 * refs are immutable -- so getting this wrong is the worst failure this command can have.
 *
 * Local `git tag --list` is NOT authoritative: a stale clone that has never fetched will happily
 * report a remotely-existing immutable tag as absent, and the candidate then reads as USABLE. So the
 * remote is asked first via `ls-remote` (read-only, no ref updates), and local tags are unioned in
 * because a tag created locally but not yet pushed still consumes the number for our purposes.
 *
 * When the remote cannot be reached the result is INDETERMINATE (null), never the local set dressed
 * up as complete. Callers must treat null as "not verified", not as "nothing spent".
 */
export async function existingTags({ cwd = repoRoot, remote = "origin", timeoutMs = 10_000 } = {}) {
  const local = new Set();
  try {
    const { stdout } = await execFileAsync("git", ["tag", "--list", "v*"], { cwd });
    for (const line of stdout.split("\n")) {
      const tag = line.trim();
      if (tag) local.add(tag);
    }
  } catch {
    return null; // not a git repo, or git unavailable
  }

  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", "--tags", "--refs", remote, "v*"], { cwd, timeout: timeoutMs });
    const remoteTags = new Set(local);
    for (const line of stdout.split("\n")) {
      const ref = line.split("\t")[1]?.trim();
      if (ref?.startsWith("refs/tags/")) remoteTags.add(ref.slice("refs/tags/".length));
    }
    return remoteTags;
  } catch {
    return null; // remote unreachable/unauthenticated: indeterminate, NOT "only what is local"
  }
}

/**
 * Annotate candidates with what has genuinely consumed them: publication, or a spent v* tag.
 *
 * On tags and the two packages: release tags are `v<version>` with NO package discriminator, and
 * both packages release from this one repository, so the tag namespace is SHARED even though the
 * published histories are independent. A tag reported spent here may have been spent by the other
 * package -- and it is still genuinely unusable, because the tag can only mean one thing. That is a
 * property of the tag contract, not a bug in this screen, and it is the reason the two packages must
 * partition one number space rather than each owning a private one.
 */
export function screenForConsumption(candidates, { published = [], tags = null, tuples = {} } = {}) {
  const publishedSet = new Set(published);
  const claimedBy = new Map();
  for (const [id, tuple] of Object.entries(tuples)) {
    if (tuple?.version) claimedBy.set(tuple.version, { id, package: tuple.package });
  }

  return candidates.map((version) => {
    const tag = `v${version}`;
    const blockers = [];
    if (publishedSet.has(version)) blockers.push(`already published as ${PACKAGE}@${version}`);
    // `tags === null` means tag existence could NOT be established (no git, or the remote was
    // unreachable). That must never render as usable: a stale clone reporting a remotely-existing
    // immutable tag as free is precisely the false green that makes a trusted tool dangerous.
    const tagState = tags === null ? "unverified" : tags.has(tag) ? "spent" : "free";
    if (tagState === "spent") blockers.push(`tag ${tag} already exists and v* tags are immutable`);
    if (tagState === "unverified") blockers.push(`tag ${tag} existence UNVERIFIED (no authoritative tag evidence) — verify before using`);
    const claim = claimedBy.get(version);
    return {
      version,
      tag,
      usable: blockers.length === 0,
      blockers,
      tag_state: tagState,
      claimed_by: claim?.id ?? null,
      claimed_for_package: claim?.package ?? null,
    };
  });
}

// --------------------------------------------------------------- layer 3: BURNS

/**
 * The last-mile burn screen, applied to already-classified rows.
 *
 * Separate on purpose. A burn records a number consumed WITHOUT publication, which is bookkeeping
 * about this repository's history rather than part of the numbering scheme. Keeping it out of layers
 * 1 and 2 means the scheme stays describable without reference to any ledger, and a burn collision
 * shows up as a distinct, noticeable event.
 *
 * NOTE the ledger is not package-attributed today (release/burned-versions.json entries carry a
 * version and a reason, no package), so a burn recorded for one package screens the other package's
 * numbers too. `burnedPackageUnknown` is reported so callers can surface that rather than imply a
 * precision the data does not have.
 */
export function screenForBurns(rows, burned = []) {
  const burnedSet = new Set(burned);
  return rows.map((row) => {
    if (!burnedSet.has(row.version)) return { ...row, burned: false };
    const blockers = [...row.blockers, "declared burned in release/burned-versions.json"];
    return { ...row, burned: true, burnedPackageUnknown: true, usable: false, blockers };
  });
}

/** The three layers in order. Kept as one call for callers that just want the answer. */
export function classifySuccessors({ from, published = [], burned = [], tags = null, tuples = {} }) {
  return screenForBurns(screenForConsumption(nextVersionCandidates(from), { published, tags, tuples }), burned);
}

// ------------------------------------------------------------------------- CLI

const VALUE_FLAGS = new Set(["--from"]);
const BOOLEAN_FLAGS = new Set(["--json", "--offline"]);

function arg(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

/**
 * Reject anything not explicitly supported, rather than ignoring it.
 *
 * Silently ignoring an unknown flag answers a DIFFERENT question than the one asked and reports
 * success doing it -- `--package @holaxis/aslite` would have quietly returned superbee's answer, and
 * `--from not-a-version` exited 0 with an empty table that reads as "nothing is available".
 */
export function assertSupportedArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (BOOLEAN_FLAGS.has(token)) continue;
    if (VALUE_FLAGS.has(token)) {
      i += 1; // its value is consumed here; `arg` validates presence
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(
        `unsupported flag ${token} (supported: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")})`,
      );
    }
    throw new Error(`unexpected positional argument ${JSON.stringify(token)}`);
  }
}

function newestOf(versions) {
  return versions.length === 0 ? null : versions.slice().sort(compareStrictSemver)[versions.length - 1];
}

export async function main(argv = process.argv.slice(2)) {
  let from;
  let asJson;
  let offline;
  try {
    assertSupportedArgs(argv);
    from = arg(argv, "--from");
    if (from !== undefined && !isStrictSemver(from)) {
      // Without this, saneSuccessors returns [] for a malformed version and the command prints an
      // empty table and exits 0 — indistinguishable from a real "nothing is available" answer.
      throw new Error(`--from ${JSON.stringify(from)} is not a strict SemVer version`);
    }
    asJson = argv.includes("--json");
    offline = argv.includes("--offline");
  } catch (error) {
    console.error(`release-next-versions: ${error.message}`);
    return EXIT_USAGE;
  }

  const manifest = await loadReleaseTargets();

  // Read the burn ledger from its own file. The loaded manifest does NOT carry burned versions --
  // it only uses them to validate tuples -- and reaching for a `manifest.burned_versions` that does
  // not exist silently reported every burned number as USABLE, which is the exact false green this
  // command exists to prevent. An unreadable ledger is therefore fatal, never an empty default.
  let burned;
  try {
    burned = readBurnedDeclaration(JSON.parse(await readFile(path.join(repoRoot, "release", "burned-versions.json"), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      burned = [];
    } else {
      console.error(`release-next-versions: cannot read release/burned-versions.json: ${error.message}`);
      return EXIT_USAGE;
    }
  }

  let published = [];
  if (!offline) {
    try {
      const registry = await fetchRegistryState({ url: registryUrlFor(PACKAGE) });
      published = registry.missing ? [] : registry.versions;
    } catch (error) {
      if (error instanceof NetworkUnavailableError) {
        console.error(`release-next-versions: NETWORK: ${error.message} — rerun with --offline to use local state only`);
        return EXIT_NETWORK;
      }
      throw error;
    }
  }

  const origin = from ?? newestOf(published);
  if (!origin) {
    console.error(
      `release-next-versions: no starting version for ${PACKAGE} — nothing published (or --offline was passed), so pass --from <version>`,
    );
    return EXIT_USAGE;
  }

  const tags = await existingTags();
  const rows = classifySuccessors({ from: origin, published, burned, tags, tuples: manifest.allowed_tuples });

  if (asJson) {
    console.log(JSON.stringify({ package: PACKAGE, from: origin, offline, candidates: rows }, null, 2));
    return EXIT_PASS;
  }

  console.log(`package ${PACKAGE}`);
  console.log(`from    ${origin}${from ? " (explicit)" : " (newest published)"}${offline ? "  [offline: registry not consulted]" : ""}`);
  if (tags === null) console.log("note    repository tags unreadable — tag_state is unknown, so a listed number may still be spent");
  console.log("");
  const width = Math.max(...rows.map((r) => r.version.length), 7);
  for (const row of rows) {
    const claim = row.claimed_by
      ? `  <- claimed by tuple ${row.claimed_by}${row.claimed_for_package !== PACKAGE ? ` (for ${row.claimed_for_package} — a different package)` : ""}`
      : "";
    console.log(`  ${row.version.padEnd(width)}  ${row.usable ? "USABLE " : "BLOCKED"}${row.blockers.length > 0 ? `  ${row.blockers.join("; ")}` : ""}${claim}`);
  }
  if (rows.some((r) => r.burned)) {
    console.log("");
    console.log("note    a burn blocked a candidate. The ledger is not package-attributed, so that burn");
    console.log("        may belong to the other package released from this repository.");
  }
  const usable = rows.filter((r) => r.usable);
  console.log("");
  console.log(
    usable.length > 0
      ? `${usable.length} usable: ${usable.map((r) => r.version).join(", ")}`
      : "NOTHING usable from here — every candidate is published, burned, or holds a spent tag",
  );
  return EXIT_PASS;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
