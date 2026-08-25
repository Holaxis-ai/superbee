/**
 * L2 native platform proofs for the filesystem adapter on the real filesystem. Expectations
 * depend on the detected host class (see `host-class.ts`); nothing here skips, and a lane that
 * declares its host class fails closed when the filesystem disagrees.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { link, lstat, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { FilesystemBackend } from "../src/backend.js";
import { ConcurrentReplacementError, FilesystemIdentityAliasError, InvalidInputError } from "../src/errors.js";
import {
  FilesystemSymlinkEntryError,
  identityKey,
  mutateExact,
  nodeFilesystemIdentityPort,
  observeExact,
  type FilesystemIdentityPort,
  type PortHandle,
} from "../src/filesystem-identity.js";
import { FilesystemMutationLockError, filesystemIdentityLockPath, filesystemMutationLockRoot } from "../src/filesystem-lock.js";
import { VersionConflict } from "../src/versioning.js";
import { classifyHostAliasing, detectHostAliasing, detectHostClass, type HostClass } from "./host-class.js";

const TIMESTAMP = "2026-07-01T00:00:00.000Z";
const doc = (id: string, body: string) => ({ id, frontmatter: { type: "NativeFixture", timestamp: TIMESTAMP }, body });
const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

let hostClassPromise: Promise<HostClass> | undefined;
const hostClass = (): Promise<HostClass> => (hostClassPromise ??= detectHostClass());
const backend = (root: string): FilesystemBackend => new FilesystemBackend(root);

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `superbee-identity-native-${prefix}-`));
}

/**
 * Whether this filesystem supports hard links. The rows below assert a different expected value
 * per answer rather than skipping, so a host that loses hard-link support is reported, not hidden.
 */
async function hardLinkSupport(dir: string): Promise<boolean> {
  const source = path.join(dir, ".hard-link-probe");
  await writeFile(source, "probe");
  try {
    await link(source, path.join(dir, ".hard-link-probe-2"));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV") return false;
    throw err;
  } finally {
    await rm(source, { force: true });
    await rm(path.join(dir, ".hard-link-probe-2"), { force: true });
  }
}

type PortMember = keyof FilesystemIdentityPort;

/**
 * The production port with call counting and one-shot after-hooks. Every member delegates to
 * `nodeFilesystemIdentityPort`, so the syscalls and every classification the protocol sees stay
 * the production ones; the wrapper only records the call order and lets a row act as a non-core
 * actor at a chosen instant. It is a test-side observer of the real binding, not a seam: nothing
 * in `src` knows it exists.
 */
interface ObservedPort {
  readonly port: FilesystemIdentityPort;
  readonly trace: string[];
  calls(member: PortMember): number;
  after(member: PortMember, nth: number, hook: (args: unknown[], result: unknown) => Promise<void>): void;
}

function observedPort(): ObservedPort {
  const counts = new Map<string, number>();
  const trace: string[] = [];
  const hooks = new Map<string, (args: unknown[], result: unknown) => Promise<void>>();
  const production = nodeFilesystemIdentityPort as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const port = Object.fromEntries(
    Object.keys(production).map((member) => [
      member,
      async (...args: unknown[]): Promise<unknown> => {
        const nth = (counts.get(member) ?? 0) + 1;
        counts.set(member, nth);
        const result = await production[member]!.apply(production, args);
        // `link` carries the host's own verdict, which is the point of the AC-4 native row.
        trace.push(member === "link" ? `link:${String(result)}` : member);
        await hooks.get(`${member}:${nth}`)?.(args, result);
        return result;
      },
    ]),
  ) as unknown as FilesystemIdentityPort;
  return {
    port,
    trace,
    calls: (member) => counts.get(member) ?? 0,
    after: (member, nth, hook) => void hooks.set(`${member}:${nth}`, hook),
  };
}

const readText = async (handle: PortHandle): Promise<string> => (await nodeFilesystemIdentityPort.readAll(handle)).toString();

// ── AC-7 absent-root observation ──────────────────────────────────────────────

test("AC-7: every observation of an absent root reports absence and leaves the root absent", async () => {
  const parent = await tempRoot("absent-root");
  const root = path.join(parent, "bundle");
  try {
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.read("missing/nested"), isEnoent);
    await assert.rejects(() => backend.readMany(["missing/nested"]), isEnoent);
    assert.equal(await backend.exists("missing/nested"), false);
    assert.deepEqual(await backend.versions("missing/nested"), []);
    assert.deepEqual(await backend.list(), []);
    assert.equal(await backend.readReserved("", "index.md"), null);
    assert.equal(await backend.readReserved("docs", "log.md"), null);
    assert.equal(await backend.readBlob("artifacts/missing.bin"), null);
    assert.equal(await backend.existsBlob("artifacts/missing.bin"), false);
    assert.deepEqual(await backend.listBlobs(), []);
    await assert.rejects(() => stat(root), isEnoent);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-7: observations of absent paths inside an existing root create nothing", async () => {
  const root = await tempRoot("absent-paths");
  try {
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.read("missing/nested"), isEnoent);
    assert.equal(await backend.exists("missing/nested"), false);
    assert.deepEqual(await backend.versions("missing/nested"), []);
    assert.equal(await backend.readReserved("missing", "index.md"), null);
    assert.equal(await backend.readBlob("artifacts/missing.bin"), null);
    assert.equal(await backend.existsBlob("artifacts/missing.bin"), false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── AC-8 rejected-mutation non-materialization ────────────────────────────────

test("AC-8: a CAS-rejected write in an empty root creates no directory", async () => {
  const root = await tempRoot("cas-empty");
  try {
    const backend = new FilesystemBackend(root);
    const stale = "sha256:" + "0".repeat(64);
    await assert.rejects(() => backend.write("concepts/nested/doc", doc("concepts/nested/doc", "x"), { expectedVersion: stale }), VersionConflict);
    await assert.rejects(() => backend.writeReserved("docs", "index.md", "# x\n", { expectedVersion: stale }), VersionConflict);
    await assert.rejects(() => backend.writeBlob("artifacts/x.bin", new Uint8Array([1]), undefined, { expectedVersion: stale }), VersionConflict);
    assert.equal(await backend.delete("concepts/nested/doc", { expectedVersion: stale }), false);
    assert.equal(await backend.deleteBlob("artifacts/x.bin", { expectedVersion: stale }), false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC-8: a CAS-rejected write against an absent root leaves the root absent", async () => {
  const parent = await tempRoot("cas-absent-root");
  const root = path.join(parent, "bundle");
  try {
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.write("concepts/doc", doc("concepts/doc", "x"), { expectedVersion: "sha256:" + "1".repeat(64) }), VersionConflict);
    assert.equal(await backend.delete("concepts/doc"), false);
    await assert.rejects(() => stat(root), isEnoent);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-8 (cond): an aliased write leaves listings unchanged at every level", async () => {
  const root = await tempRoot("alias-write");
  try {
    const backend = new FilesystemBackend(root);
    const aliasing = (await hostClass()) !== "exact";
    await backend.write("Docs/a", doc("Docs/a", "a"));
    const attempt = backend.write("docs/b", doc("docs/b", "b"));
    if (!aliasing) {
      await attempt;
      assert.deepEqual((await readdir(root)).sort(), ["Docs", "docs"]);
      assert.deepEqual(await readdir(path.join(root, "docs")), ["b.md"]);
    } else {
      await assert.rejects(() => attempt, FilesystemIdentityAliasError);
      assert.deepEqual(await readdir(root), ["Docs"]);
    }
    // After the operation completes no residue remains at any level, dot entries included: a
    // refused first creation removes its own temp file before reporting the refusal.
    assert.deepEqual(await readdir(path.join(root, "Docs")), ["a.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── host-class model: the two kinds of aliasing are carried independently ───────────
//
// A row that writes a case pair must be scored against CASE aliasing and a row that writes an
// NFC/NFD pair against NORMALIZATION aliasing. Hosts exist that have one and not the other (a
// case-SENSITIVE but normalization-insensitive APFS volume), and no CI host can demonstrate that
// combination, so the decision is proved here as a pure table over every combination of probe
// outcomes. A model that collapsed the two kinds into one verdict goes red on the mixed rows.
test("host class: case and normalization aliasing are decided independently, and the aggregate is their disjunction", () => {
  const rows = [
    { case: false, normalization: false, hostClass: "exact" as const },
    { case: true, normalization: false, hostClass: "aliasing" as const },
    { case: false, normalization: true, hostClass: "aliasing" as const },
    { case: true, normalization: true, hostClass: "aliasing" as const },
  ];
  for (const row of rows) {
    assert.deepEqual(
      classifyHostAliasing({ keptWrittenSpelling: true, caseReaches: row.case, normalizationReaches: row.normalization }),
      { hostClass: row.hostClass, case: row.case, normalization: row.normalization },
      JSON.stringify(row),
    );
    // A store that rewrote the written spelling is "normalizing" whatever the two kinds say, and
    // still reports them: the aggregate never overwrites a measured per-kind fact.
    assert.deepEqual(
      classifyHostAliasing({ keptWrittenSpelling: false, caseReaches: row.case, normalizationReaches: row.normalization }),
      { hostClass: "normalizing", case: row.case, normalization: row.normalization },
      JSON.stringify(row),
    );
  }
});

test("host class: this host's detected aliasing agrees with its own aggregate class", async () => {
  const detected = await detectHostAliasing();
  assert.equal(detected.hostClass, await hostClass());
  if (detected.hostClass === "exact") {
    assert.deepEqual([detected.case, detected.normalization], [false, false], "an exact host aliases neither kind");
  } else {
    assert.ok(detected.case || detected.normalization, "an aliasing host must alias at least one kind");
  }
});

// ── AC-15 directory first-creation race ───────────────────────────────────────

test("AC-15 (cond): concurrent first creation of Docs/a and docs/b yields exactly one spelling on an aliasing host", async () => {
  const aliasing = (await hostClass()) !== "exact";
  for (let round = 0; round < 5; round++) {
    const root = await tempRoot(`race-${round}`);
    try {
      const writers = [
        ["Docs/a", new FilesystemBackend(root)],
        ["docs/b", new FilesystemBackend(root)],
      ] as const;
      const outcomes = await Promise.allSettled(writers.map(([id, backend]) => backend.write(id, doc(id, id))));
      const fulfilled = outcomes.flatMap((outcome, index) => (outcome.status === "fulfilled" ? [writers[index]![0]] : []));
      const refused = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      );
      const rootListing = await readdir(root);
      if (aliasing) {
        assert.equal(fulfilled.length, 1, `round ${round}: outcomes ${JSON.stringify(outcomes.map((o) => o.status))}`);
        assert.equal(refused.length, 1);
        assert.ok(refused[0] instanceof FilesystemIdentityAliasError, String(refused[0]));
        assert.equal(rootListing.length, 1, `one directory spelling, got ${rootListing.join(",")}`);
      } else {
        assert.deepEqual(fulfilled.sort(), ["Docs/a", "docs/b"]);
        assert.deepEqual(rootListing.sort(), ["Docs", "docs"]);
      }
      for (const id of fulfilled) {
        const [dir, name] = id.split("/") as [string, string];
        assert.ok(rootListing.includes(dir), `winner's directory '${dir}' spelled exactly`);
        const listing = await readdir(path.join(root, dir));
        assert.ok(listing.includes(`${name}.md`), `winner's file '${name}.md' spelled exactly`);
        assert.deepEqual(listing.filter((entry) => entry.startsWith(".")), [], "no temp file remains");
      }
      for (const dir of rootListing) {
        assert.deepEqual((await readdir(path.join(root, dir))).filter((entry) => entry.startsWith(".")), []);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// AC-15b, forbidden-outcome form: on every host class, never two `fulfilled` with fewer than two
// files, and every fulfilled writer's file is at its exact requested path with its own body. With
// the fold in place the pair shares one key (excluded by the lock); with the fold reverted the
// loser's link still fails EEXIST, so the forbidden outcomes cannot occur either way.
//
// Rounds per pair: a race row's discrimination is probabilistic, and three was chosen for cost
// rather than for power. Measured at 20 (2026-08-25, macOS/APFS): the row costs ~0.4 s, and
// against the mutation that produces the forbidden outcome here — the fold reverted AND `link`
// forced to report "unsupported", so first creation falls back to `rename` — three rounds and
// twenty both went red on five of five runs. So this raise is margin, not a demonstrated gap: it
// is honest only as a hedge against a regression whose losing interleaving is rarer than any
// mutation reachable on this host, and it does not make the row a pin for anything three rounds
// missed. It stays at twenty because that margin costs under half a second on the lane.
const AC_15B_ROUNDS = 20;

test("AC-15b (cond): concurrent first creation of a full-case-folding pair never fulfils both writers on an aliasing host", async () => {
  const aliasing = (await hostClass()) !== "exact";
  const pairs: Array<[string, string]> = [
    ["concepts/straße", "concepts/STRASSE"],
    ["concepts/ẞ", "concepts/SS"],
    ["concepts/ς", "concepts/σ"],
    ["concepts/ᾈ", "concepts/ἀι"],
  ];
  for (const [first, second] of pairs) {
    for (let round = 0; round < AC_15B_ROUNDS; round++) {
      const root = await tempRoot(`fold-race-${round}`);
      try {
        const writers = [first, second].map((id) => [id, new FilesystemBackend(root)] as const);
        const outcomes = await Promise.allSettled(writers.map(([id, backend]) => backend.write(id, doc(id, id))));
        const fulfilled = outcomes.flatMap((outcome, index) => (outcome.status === "fulfilled" ? [writers[index]![0]] : []));
        const rejected = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
        const files = await readdir(path.join(root, "concepts"));
        const label = `${first} vs ${second}, round ${round}: ${JSON.stringify(outcomes.map((o) => o.status))} files=${files.join(",")}`;
        assert.ok(!(fulfilled.length === 2 && files.length < 2), `forbidden: both fulfilled with one file (${label})`);
        for (const id of fulfilled) {
          const name = `${id.slice("concepts/".length)}.md`;
          assert.ok(files.includes(name), `forbidden: fulfilled '${id}' is not at its exact path (${label})`);
          assert.equal((await backend(root).read(id)).doc.body.trimEnd(), id, `forbidden: fulfilled '${id}' lost its body (${label})`);
        }
        assert.deepEqual(files.filter((name) => name.startsWith(".")), [], `no temp residue (${label})`);
        if (aliasing) {
          assert.equal(fulfilled.length, 1, label);
          assert.ok(
            rejected[0] instanceof FilesystemIdentityAliasError || rejected[0] instanceof ConcurrentReplacementError,
            label,
          );
          assert.deepEqual(files, [`${fulfilled[0]!.slice("concepts/".length)}.md`], label);
        } else {
          assert.deepEqual(fulfilled.sort(), [first, second].sort(), label);
          assert.equal(files.length, 2, label);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

// ── AC-4 first creation through the production link binding ──────────────────

// The port's `link` classification is what makes a first creation fail closed on names the host
// equates but the identity fold does not: `rename` would replace the winner silently. Forcing
// `link` to report "unsupported" leaves every scripted, contract, and L1 row green, so this row
// observes the real binding: on a host with hard links, first creation must publish through
// `link` and the published name must be the temp file's own inode while both names exist.
test("AC-4 (cond): first creation publishes the leaf through the production link binding, never a silent rename fallback", async () => {
  const root = await tempRoot("link-binding");
  try {
    const hardLinks = await hardLinkSupport(root);
    const aliasing = (await hostClass()) !== "exact";
    const observed = observedPort();
    const linkFacts: Array<{ sameInode: boolean; links: number }> = [];
    observed.after("link", 1, async (args, outcome) => {
      if (outcome !== "linked") return;
      const [from, to] = args as [string, string];
      const [source, published] = await Promise.all([lstat(from), lstat(to)]);
      linkFacts.push({ sameInode: source.dev === published.dev && source.ino === published.ino, links: published.nlink });
    });

    await mutateExact(observed.port, root, "concepts/x.md", async (context) => {
      assert.equal(context.state, "absent");
      await context.replace(Buffer.from("first\n"));
    });

    const published = path.join(root, "concepts", "x.md");
    const publishing = observed.trace.filter((call) => call === "rename" || call.startsWith("link:"));
    if (hardLinks) {
      assert.deepEqual(publishing, ["link:linked"], "a first creation that renames would replace an equated name silently");
      assert.deepEqual(linkFacts, [{ sameInode: true, links: 2 }], "the published name is the temp file's own inode");
    } else {
      assert.deepEqual(publishing, ["link:unsupported", "rename"], "the fallback is taken only when the host has no hard links");
      assert.deepEqual(linkFacts, []);
    }
    assert.equal(await readFile(published, "utf8"), "first\n");
    assert.deepEqual(await readdir(path.join(root, "concepts")), ["x.md"], "the temp name is removed");
    assert.equal((await lstat(published)).nlink, 1);

    // The same binding's refusal: `link` never publishes over a name the host already resolves,
    // whatever spelling that name was written under.
    const contender = path.join(root, "concepts", ".contender.tmp");
    await writeFile(contender, "second\n");
    const overExact = await nodeFilesystemIdentityPort.link(contender, published);
    const overAlias = await nodeFilesystemIdentityPort.link(contender, path.join(root, "concepts", "X.md"));
    if (hardLinks) {
      assert.equal(overExact, "exists");
      assert.equal(overAlias, aliasing ? "exists" : "linked");
    } else {
      assert.notEqual(overExact, "linked");
      assert.notEqual(overAlias, "linked");
    }
    assert.equal(await readFile(published, "utf8"), "first\n", "the existing document is never replaced by a link");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("I4: a backend built with a relative root keeps its identity across a later chdir", async () => {
  const parent = await tempRoot("relative-root");
  const cwd = process.cwd();
  try {
    process.chdir(parent);
    const relative = new FilesystemBackend("bundle");
    await relative.write("concepts/a", doc("concepts/a", "a"));
    const elsewhere = path.join(parent, "elsewhere");
    await mkdir(elsewhere);
    process.chdir(elsewhere);
    assert.equal((await relative.read("concepts/a")).doc.body.trimEnd(), "a");
    await relative.write("concepts/b", doc("concepts/b", "b"));
    assert.deepEqual(await readdir(elsewhere), [], "nothing was created relative to the new cwd");
    assert.deepEqual((await readdir(path.join(parent, "bundle", "concepts"))).sort(), ["a.md", "b.md"]);
  } finally {
    process.chdir(cwd);
    await rm(parent, { recursive: true, force: true });
  }
});

// ── AC-12a crash residue, single process ──────────────────────────────────────

// I5 says the diagnosis names the LOGICAL identity. The fold gives one lock key to every
// spelling of that identity, so the holder that crashed and the writer now blocked can hold
// different spellings of it. The stale case records the alias spelling as the holder's target:
// the message must name the blocked spelling AND the holder's, or a human reading it goes
// looking for a file that does not exist under the name they were shown.
test("AC-12a: a stale or malformed identity lock fails the next write closed, naming the identity, with no partial file", async () => {
  const cases = [
    {
      name: "stale",
      owner: { pid: 999_999, hostname: hostname(), created_at_ms: Date.now() - 60_000, token: "dead" },
      stale: true,
      malformed: false,
    },
    { name: "malformed", owner: null, stale: false, malformed: true },
  ] as const;
  for (const fixture of cases) {
    const root = await tempRoot(`residue-${fixture.name}`);
    const key = await identityKey(root, "concepts/x.md");
    // The holder's spelling folds to the same key as the claimant's, so it is the same lock.
    const holderTarget = `${path.resolve(root)}:concepts/X.md`;
    assert.equal(await identityKey(root, "concepts/X.md"), key, "the two spellings must share one key");
    const lockPath = filesystemIdentityLockPath(key, root);
    try {
      await mkdir(filesystemMutationLockRoot(root), { recursive: true, mode: 0o700 });
      await mkdir(lockPath, { recursive: true });
      if (fixture.owner) {
        await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ ...fixture.owner, target: holderTarget }));
      }
      await assert.rejects(
        () => new FilesystemBackend(root).write("concepts/x", doc("concepts/x", "x")),
        (err: unknown) => {
          assert.ok(err instanceof FilesystemMutationLockError);
          assert.equal(err.stale, fixture.stale);
          assert.equal(err.malformed, fixture.malformed);
          assert.equal(err.lockPath, lockPath);
          assert.ok(err.message.includes(`${path.resolve(root)}:concepts/x.md`), err.message);
          if (fixture.owner) {
            assert.ok(err.message.includes(holderTarget), `holder spelling missing from: ${err.message}`);
            assert.equal(err.owner?.target, holderTarget);
          } else {
            assert.ok(!/holder recorded/.test(err.message), `no holder to name, but claimed one: ${err.message}`);
          }
          return true;
        },
      );
      assert.deepEqual(await readdir(root), [], "no partial file in the bundle");
      assert.equal((await stat(lockPath)).isDirectory(), true, "the leftover is never stolen");
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});

// ── AC-17 normalizing-store scope-out ─────────────────────────────────────────

test("AC-17 (cond): a normalizing store is unsupported and fails closed; CI hosts are not normalizing", async () => {
  const detected = await hostClass();
  const root = await tempRoot("normalizing");
  try {
    const backend = new FilesystemBackend(root);
    const nfc = "concepts/café";
    await backend.write(nfc, doc(nfc, "nfc"));
    if (detected === "normalizing") {
      await assert.rejects(() => backend.read(nfc), FilesystemIdentityAliasError);
      await assert.rejects(() => backend.exists(nfc), FilesystemIdentityAliasError);
      await assert.rejects(() => backend.versions(nfc), FilesystemIdentityAliasError);
      assert.deepEqual(await backend.list(), ["concepts/café"]);
    } else {
      assert.notEqual(detected, "normalizing");
      assert.equal((await backend.read(nfc)).doc.body.trimEnd(), "nfc");
      assert.equal(await backend.exists(nfc), true);
      assert.deepEqual(await backend.list(), [nfc]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── AC-18 readers under a hot delete/write loop ───────────────────────────────

const AC18_RUN_MS = 1_000;

interface ReaderTally {
  bytes: number;
  absent: number;
  replaced: number;
  aliased: number;
}

async function readerLoop(
  backend: FilesystemBackend,
  id: string,
  deadline: number,
  allowedBodies: () => Set<string>,
  aliasAllowed: boolean,
): Promise<ReaderTally> {
  const tally: ReaderTally = { bytes: 0, absent: 0, replaced: 0, aliased: 0 };
  while (Date.now() < deadline) {
    try {
      const body = (await backend.read(id)).doc.body.trimEnd();
      assert.ok(allowedBodies().has(body), `read returned bytes never written under '${id}': ${body}`);
      tally.bytes++;
    } catch (err) {
      if (isEnoent(err)) tally.absent++;
      else if (err instanceof ConcurrentReplacementError) tally.replaced++;
      else if (err instanceof FilesystemIdentityAliasError && aliasAllowed) tally.aliased++;
      else throw err;
    }
  }
  return tally;
}

test("AC-18: readers of a document under a delete/write loop see only written bytes, absence, or a bounded-replacement error", async () => {
  const root = await tempRoot("ac18-churn");
  try {
    const backend = new FilesystemBackend(root);
    const deadline = Date.now() + AC18_RUN_MS;
    const written = new Set<string>();
    let iteration = 0;
    const writer = (async () => {
      while (Date.now() < deadline) {
        const body = `iteration-${++iteration}`;
        written.add(body);
        await backend.write("concepts/a", doc("concepts/a", body));
        await backend.delete("concepts/a");
      }
    })();
    const readers = await Promise.all([
      readerLoop(backend, "concepts/a", deadline, () => written, false),
      readerLoop(backend, "concepts/a", deadline, () => written, false),
    ]);
    await writer;
    assert.ok(iteration > 0);
    assert.ok(readers.some((tally) => tally.bytes + tally.absent + tally.replaced > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC-18 (cond): alternating exact and alias spellings never yield an alias-tagged body to readers of the exact id", async () => {
  const aliasing = (await hostClass()) !== "exact";
  const root = await tempRoot("ac18-alternate");
  try {
    const backend = new FilesystemBackend(root);
    const deadline = Date.now() + AC18_RUN_MS;
    const exactBodies = new Set<string>();
    let iteration = 0;
    const writer = (async () => {
      while (Date.now() < deadline) {
        const n = ++iteration;
        exactBodies.add(`a-${n}`);
        await backend.write("concepts/a", doc("concepts/a", `a-${n}`));
        await backend.delete("concepts/a");
        await backend.write("concepts/A", doc("concepts/A", `A-${n}`));
        await backend.delete("concepts/A");
      }
    })();
    const [tally] = await Promise.all([
      readerLoop(backend, "concepts/a", deadline, () => exactBodies, aliasing),
      writer,
    ]);
    assert.ok(iteration > 0);
    if (!aliasing) assert.equal(tally.aliased, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── I6 native: a directory replaced under its own spelling ───────────────────

/**
 * Replace `<root>/concepts` with a different directory under the same spelling, the way a git
 * checkout or a manual `mv` would. `carryLeaf` reproduces the harder shape: the replacement holds
 * the ORIGINAL document as a hard link, so the post-walk's leaf table still sees the handle's own
 * inode and only the directory witness can tell that the walk straddled two directories. Every
 * created path lives inside `parent`, which the row removes on every exit.
 */
async function replaceConcepts(parent: string, root: string, body: string, carryLeaf: boolean): Promise<void> {
  const concepts = path.join(root, "concepts");
  const replacement = path.join(parent, "replacement");
  await mkdir(replacement);
  if (carryLeaf) await link(path.join(concepts, "x.md"), path.join(replacement, "x.md"));
  else await writeFile(path.join(replacement, "x.md"), body);
  await rename(concepts, path.join(parent, "retired"));
  await rename(replacement, concepts);
}

// The scripted I6 rows (`filesystem-identity.test.ts`) pin this decision through a scripted port;
// these two run the same interleavings against the real filesystem through the production port,
// so the aliasing lane observes the guarantee rather than a model of it.
test("I6 (native): a directory replaced under its own spelling after the first verification listing never validates a read against the retired generation", async () => {
  const parent = await tempRoot("i6-verify-swap");
  const root = path.join(parent, "bundle");
  const concepts = path.join(root, "concepts");
  try {
    await mkdir(concepts, { recursive: true });
    await writeFile(path.join(concepts, "x.md"), "ORIGINAL");
    const retired = await stat(concepts);
    const observed = observedPort();
    observed.after("entries", 1, () => replaceConcepts(parent, root, "SWAPPED", false));

    const result = await observeExact(observed.port, root, "concepts/x.md", readText);

    assert.notEqual((await stat(concepts)).ino, retired.ino, "the replacement is a different directory under the same spelling");
    assert.deepEqual(result, { state: "exact", value: "SWAPPED" });
    assert.equal(observed.calls("open"), 1, "no bytes were read through the straddling walk");
    // A restart is another listing walk, so the number of listings counts the guarantee rather
    // than the mechanism: the aborted walk's root listing, then two listings each for the
    // verification and post-verification walks of the attempt that returns. An implementation
    // that never probes the listed directory, or probes it and discards the witness, completes
    // in one walk and lists four times.
    assert.equal(observed.calls("entries"), 5, "the recorded witness is compared, so the swap restarts the observation");
    assert.equal((await backend(root).read("concepts/x")).doc.body.trimEnd(), "SWAPPED");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("I6 (native, cond): a directory replaced between the read and the post-walk restarts even when the leaf inode survives", async () => {
  const parent = await tempRoot("i6-postread-swap");
  const root = path.join(parent, "bundle");
  const concepts = path.join(root, "concepts");
  try {
    const carryLeaf = await hardLinkSupport(parent);
    await mkdir(concepts, { recursive: true });
    await writeFile(path.join(concepts, "x.md"), "BODY");
    const retired = await stat(concepts);
    let reads = 0;
    // The swap runs inside the read callback: after `open` and the bytes, before the post-walk.
    const result = await observeExact(nodeFilesystemIdentityPort, root, "concepts/x.md", async (handle) => {
      const body = await readText(handle);
      if (++reads === 1) await replaceConcepts(parent, root, "BODY", carryLeaf);
      return body;
    });

    assert.notEqual((await stat(concepts)).ino, retired.ino);
    assert.deepEqual(result, { state: "exact", value: "BODY" });
    // Without hard links the replacement carries a copy, so the leaf table restarts it too; the
    // restart is asserted either way and the returned bytes belong to one generation.
    assert.equal(reads, 2, "the post-walk restarted the observation instead of accepting the straddling walk");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ── V3A-4 / R1: symlinked entries fail closed ─────────────────────────────────

// Behavior change recorded for R1 layouts: a symlinked document or directory inside a bundle used
// to be read through; it is now refused on every operation with an input-class error, because
// the walk never follows links and a link's inode cannot witness what opening it would reach.
test("R1: a symlinked document or directory inside a bundle is refused as caller input on every operation", async () => {
  const root = await tempRoot("symlink");
  try {
    const backend = new FilesystemBackend(root);
    await backend.write("concepts/real", doc("concepts/real", "real"));
    await symlink("real.md", path.join(root, "concepts", "linked.md"));
    await symlink("concepts", path.join(root, "linked-dir"));
    const isSymlinkRefusal = (err: unknown): boolean =>
      err instanceof FilesystemSymlinkEntryError && err instanceof InvalidInputError;

    await assert.rejects(() => backend.read("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.exists("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.versions("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.write("concepts/linked", doc("concepts/linked", "x")), isSymlinkRefusal);
    await assert.rejects(() => backend.delete("concepts/linked"), isSymlinkRefusal);
    await assert.rejects(() => backend.read("linked-dir/real"), isSymlinkRefusal);
    await assert.rejects(() => backend.write("linked-dir/other", doc("linked-dir/other", "x")), isSymlinkRefusal);
    assert.equal((await backend.read("concepts/real")).doc.body.trimEnd(), "real");
    assert.deepEqual(await backend.list(), ["concepts/real"], "listings skip links as before");
    assert.deepEqual(await readdir(path.join(root, "concepts")), ["linked.md", "real.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
