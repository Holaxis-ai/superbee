import { cp, mkdir, readFile, readdir, chmod } from "node:fs/promises";
import path from "node:path";

import { canonicalJsonString } from "./canonical-json.mjs";
import { createReleaseCandidate, releaseCandidateFixtureIdentity } from "./release-candidate.mjs";
import { fileSha256, verifyRetainedTarball } from "./verify-npm-package.mjs";

async function candidateFiles(outDir) {
  const names = await readdir(outDir);
  const tarballs = names.filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1 || !names.includes("candidate.json")) {
    throw new Error(`cached candidate must contain one tarball and candidate.json: ${outDir}`);
  }
  return { manifest: "candidate.json", tarball: tarballs[0] };
}

async function snapshot(outDir) {
  const files = await candidateFiles(outDir);
  return {
    files,
    manifest_sha256: await fileSha256(path.join(outDir, files.manifest)),
    tarball_sha256: await fileSha256(path.join(outDir, files.tarball)),
  };
}

function assertSnapshot(actual, expected, key) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`cached release candidate ${key} changed after construction`);
  }
}

/**
 * Process-local, serialized fixture reuse. Cached retained bytes are never returned to a test:
 * each consumer gets a writable private copy, and the read-only cache hashes are checked before
 * and after materialization. Dist remains shared, so callers must keep the surrounding test file
 * serialized; this helper intentionally does not claim parallel-build isolation.
 */
export function createReleaseCandidateFixtureCache({
  cacheRoot,
  identityFor = releaseCandidateFixtureIdentity,
  buildCandidate = createReleaseCandidate,
} = {}) {
  if (!cacheRoot) throw new Error("release candidate fixture cache requires cacheRoot");
  const entries = new Map();
  let builds = 0;

  async function build(options, described) {
    const out = path.join(cacheRoot, described.key.slice("sha256:".length));
    const result = await buildCandidate({ ...options, out, verify: false });
    const hashes = await snapshot(result.outDir);
    await chmod(path.join(result.outDir, hashes.files.manifest), 0o444);
    await chmod(path.join(result.outDir, hashes.files.tarball), 0o444);
    builds += 1;
    return { key: described.key, identity: described.identity, outDir: result.outDir, hashes };
  }

  async function entry(options) {
    const described = await identityFor(options);
    let pending = entries.get(described.key);
    if (!pending) {
      pending = build(options, described);
      entries.set(described.key, pending);
    }
    const cached = await pending;
    assertSnapshot(await snapshot(cached.outDir), cached.hashes, cached.key);
    return cached;
  }

  return {
    async materialize(options, destination) {
      const cached = await entry(options);
      await mkdir(destination, { recursive: true });
      const manifestPath = path.join(destination, cached.hashes.files.manifest);
      const tarballPath = path.join(destination, cached.hashes.files.tarball);
      await cp(path.join(cached.outDir, cached.hashes.files.manifest), manifestPath, { force: false, errorOnExist: true });
      await cp(path.join(cached.outDir, cached.hashes.files.tarball), tarballPath, { force: false, errorOnExist: true });
      await chmod(manifestPath, 0o644);
      await chmod(tarballPath, 0o644);
      assertSnapshot(await snapshot(cached.outDir), cached.hashes, cached.key);
      return {
        key: cached.key,
        identity: structuredClone(cached.identity),
        candidate: JSON.parse(await readFile(manifestPath, "utf8")),
        manifestPath,
        tarballPath,
        outDir: destination,
      };
    },
    async assertUnchanged(options) {
      const cached = await entry(options);
      assertSnapshot(await snapshot(cached.outDir), cached.hashes, cached.key);
      return structuredClone(cached.hashes);
    },
    stats() {
      return { builds, keys: entries.size };
    },
  };
}

/**
 * Reuse a successful retained-tarball proof only for byte-identical tarball, candidate manifest,
 * and release policy inputs. The exact tarball bytes contain the built package/update policy; the
 * exact manifest binds tuple, source SHA, artifact hash, package/version/channel, and agreement.
 */
export function createRetainedVerifierCache({ verifier = verifyRetainedTarball } = {}) {
  const entries = new Map();
  let verifications = 0;

  async function inputIdentity({ tarball, manifest, targetsPath }) {
    if (!manifest || !targetsPath) throw new Error("cached retained verification requires manifest and targetsPath");
    const identity = {
      tarball_sha256: await fileSha256(tarball),
      candidate_manifest_sha256: await fileSha256(manifest),
      targets_path: path.resolve(targetsPath),
      release_targets_sha256: await fileSha256(targetsPath),
    };
    return { key: canonicalJsonString(identity, "retained verifier cache identity"), identity };
  }

  return {
    async verify(options) {
      const before = await inputIdentity(options);
      let pending = entries.get(before.key);
      if (!pending) {
        pending = (async () => {
          const receipt = await verifier(options);
          verifications += 1;
          return structuredClone(receipt);
        })();
        entries.set(before.key, pending);
      }
      const receipt = await pending;
      const after = await inputIdentity(options);
      if (after.key !== before.key) throw new Error("retained verifier inputs changed during cached proof");
      return structuredClone(receipt);
    },
    stats() {
      return { verifications, keys: entries.size };
    },
  };
}
