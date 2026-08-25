/**
 * Filesystem host-class detection shared by the native identity proofs. A host is "aliasing"
 * when a differently spelled name resolves to an existing entry while the entry keeps its
 * written spelling (case-insensitive APFS, NTFS, ext4 casefold); "normalizing" when the store
 * rewrites names on write (legacy HFS+); otherwise "exact".
 *
 * Case aliasing and normalization aliasing are detected separately because a host can have one
 * without the other: a case-SENSITIVE APFS volume still resolves an NFD spelling to an NFC entry.
 * A row that writes one kind of pair must branch on that kind; branching on the aggregate class
 * makes correct product behavior look like a failure on any host that aliases only one kind.
 *
 * `SUPERBEE_TEST_EXPECT_ALIASING_HOST=1|0` pins what a CI lane claims its host is: the detected
 * class must agree or the proof fails closed. Read by test files only, never by runtime source.
 */
import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type HostClass = "aliasing" | "exact" | "normalizing";

/** The kinds of spelling pair a contract row can write. Keys match the row labels. */
export interface HostAliasing {
  /** Aggregate class: "aliasing" when the host aliases ANY probed pair kind. */
  hostClass: HostClass;
  /** A differently cased spelling reaches the entry that was written. */
  case: boolean;
  /** A differently normalized (NFC/NFD) spelling reaches the entry that was written. */
  normalization: boolean;
}

const NFC_PROBE = "café-probe".normalize("NFC");
const NFD_PROBE = NFC_PROBE.normalize("NFD");

/** What one probe round observed, before any classification. */
export interface HostProbeOutcome {
  /** The NFC probe name came back from `readdir` exactly as it was written. */
  keptWrittenSpelling: boolean;
  /** A differently CASED spelling of a written entry resolved. */
  caseReaches: boolean;
  /** A differently NORMALIZED (NFD) spelling of a written entry resolved. */
  normalizationReaches: boolean;
}

/**
 * The whole host-class decision, as a pure function of what was probed, so the per-kind
 * verdicts are provable without owning a volume of every class. The two kinds are carried
 * independently by construction: neither is derived from the other, and the aggregate is a
 * disjunction over them, never a substitute for them.
 */
export function classifyHostAliasing(outcome: HostProbeOutcome): HostAliasing {
  const kinds = { case: outcome.caseReaches, normalization: outcome.normalizationReaches };
  // A store that did not keep the written NFC spelling rewrote it, so both kinds were measured
  // against a name the store chose; the aggregate is "normalizing" whatever they say.
  if (!outcome.keptWrittenSpelling) return { hostClass: "normalizing", ...kinds };
  return { hostClass: kinds.case || kinds.normalization ? "aliasing" : "exact", ...kinds };
}

/**
 * Does THIS host equate these two spellings? The row passes the spellings it actually writes and
 * the predicate reduces them under exactly the equivalences the host was measured to have, so a
 * row can never be scored against a kind of aliasing its own pair does not exercise: the wrong-kind
 * mistake is not expressible. Prefer this over reading `case` / `normalization` by hand, and never
 * branch a row on `hostClass` — the aggregate is true whenever EITHER kind aliases.
 *
 * Model: case-insensitivity is full Unicode case folding (what APFS, NTFS, and ext4 casefold do),
 * and normalization-insensitivity is NFC/NFD equivalence. A host whose case-insensitivity is
 * narrower than full folding would equate fewer pairs than this predicts; none of the supported
 * hosts is such a host, and `detectHostAliasingIn` measures the two dimensions rather than
 * assuming them.
 */
export function hostAliasesPair(host: HostAliasing, first: string, second: string): boolean {
  const reduce = (name: string): string => {
    const normalized = host.normalization ? name.normalize("NFC") : name;
    return host.case ? normalized.toLowerCase().toUpperCase().toLowerCase() : normalized;
  };
  return first !== second && reduce(first) === reduce(second);
}

/** `lstat` reduced to reachability; anything other than ENOENT is a host fault, not a verdict. */
async function reaches(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function detectHostAliasingIn(dir: string): Promise<HostAliasing> {
  await writeFile(path.join(dir, "probe-name"), "probe");
  await writeFile(path.join(dir, NFC_PROBE), "probe");
  const listed = await readdir(dir);
  return classifyHostAliasing({
    keptWrittenSpelling: listed.includes(NFC_PROBE),
    caseReaches: await reaches(path.join(dir, "PROBE-NAME")),
    normalizationReaches: await reaches(path.join(dir, NFD_PROBE)),
  });
}

export async function detectHostClassIn(dir: string): Promise<HostClass> {
  return (await detectHostAliasingIn(dir)).hostClass;
}

/** Detect in a fresh temp directory, then hold the lane's expectation to account. */
export async function detectHostAliasing(): Promise<HostAliasing> {
  const dir = await mkdtemp(path.join(tmpdir(), "superbee-host-class-"));
  try {
    const detected = await detectHostAliasingIn(dir);
    assertHostClassExpectation(detected.hostClass);
    return detected;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function detectHostClass(): Promise<HostClass> {
  return (await detectHostAliasing()).hostClass;
}

export function assertHostClassExpectation(detected: HostClass): void {
  const expectation = process.env.SUPERBEE_TEST_EXPECT_ALIASING_HOST;
  if (expectation === undefined || expectation === "") return;
  assert.ok(expectation === "1" || expectation === "0", `SUPERBEE_TEST_EXPECT_ALIASING_HOST must be 1 or 0, got '${expectation}'`);
  const expected: HostClass = expectation === "1" ? "aliasing" : "exact";
  assert.equal(detected, expected, `this lane expects a ${expected} host but the filesystem is ${detected}`);
}
