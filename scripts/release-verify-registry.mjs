// Post-approval registry proof for one exact version. It downloads the registry tarball, compares
// both npm integrity fields and raw bytes with candidate.json, verifies registry signatures plus
// provenance attestations through a scratch lockfile, then installs into an isolated prefix and
// checks the shipped build identity. It never changes a dist-tag or publishes anything.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { fileSha256, sanitizedNpmEnvironment } from "./verify-npm-package.mjs";
import { DEFAULT_TARGETS, REGISTRY_PROOF_SCHEMA, targetFromPackageName } from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function targetFor(targetId = "bridge") {
  const target = DEFAULT_TARGETS[targetId];
  if (!target) throw new Error(`invalid release target: ${JSON.stringify(targetId)}`);
  return target;
}

function arg(argv, flag, required = true) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if ((!value || value.startsWith("--")) && required) throw new Error(`missing ${flag}`);
  return value;
}

function npmInvocation(args, env, options = {}) {
  const npmCli = env.npm_execpath?.trim();
  const command = npmCli ? process.execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return execFileAsync(command, commandArgs, {
    env,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${error.message}`);
  }
}

export function assertRegistryCandidate({ candidate, packReceipt, packumentDist, tarballSha256, installedIdentity, target = targetFor(candidate?.target ?? targetFromPackageName(candidate?.package?.name ?? candidate?.build_identity?.package?.name) ?? "bridge") }) {
  if (packReceipt.name !== target.package.name) throw new Error(`registry package ${packReceipt.name} != ${target.package.name}`);
  if (packReceipt.version !== candidate.version) {
    throw new Error(`registry version ${packReceipt.version} != candidate ${candidate.version}`);
  }
  for (const field of ["integrity", "shasum"]) {
    if (packReceipt[field] !== candidate.tarball[field]) {
      throw new Error(`registry ${field} ${packReceipt[field]} != candidate ${candidate.tarball[field]}`);
    }
    if (packumentDist?.[field] !== candidate.tarball[field]) {
      throw new Error(`registry packument ${field} ${packumentDist?.[field]} != candidate ${candidate.tarball[field]}`);
    }
  }
  if (!Array.isArray(packumentDist?.signatures) || packumentDist.signatures.length === 0) {
    throw new Error("registry packument has no registry signature");
  }
  if (
    typeof packumentDist?.attestations?.url !== "string" ||
    !packumentDist.attestations.url.startsWith("https://registry.npmjs.org/-/npm/v1/attestations/") ||
    packumentDist?.attestations?.provenance?.predicateType !== "https://slsa.dev/provenance/v1"
  ) {
    throw new Error("registry packument has no npm-hosted SLSA provenance v1 attestation");
  }
  if (tarballSha256 !== candidate.tarball.sha256) {
    throw new Error(`registry tarball SHA-256 ${tarballSha256} != candidate ${candidate.tarball.sha256}`);
  }
  const identity = installedIdentity?.identity;
  if (identity?.package?.name !== target.package.name || identity?.package?.version !== candidate.version) {
    throw new Error("installed registry package identity does not match the candidate coordinate");
  }
  if (identity?.source?.commit !== candidate.source?.commit || identity?.source?.dirty !== false) {
    throw new Error("installed registry package source identity does not match the clean candidate commit");
  }
  if (identity?.artifact?.channel !== "npm-package") {
    throw new Error(`installed registry package channel ${identity?.artifact?.channel} != npm-package`);
  }
  if (identity?.artifact?.sha256 !== candidate.build_identity?.artifact?.sha256) {
    throw new Error("installed registry executable digest does not match candidate build identity");
  }
}

export async function verifyRegistry({ target: targetId = "bridge", version, manifest, out }) {
  const target = targetFor(targetId);
  if (!SEMVER.test(version)) throw new Error(`invalid --version ${version}`);
  const candidate = parseJson(await readFile(manifest, "utf8"), "candidate manifest");
  if (candidate.version !== version) throw new Error(`candidate version ${candidate.version} != requested ${version}`);
  if (candidate.target !== target.id || candidate.package?.name !== target.package.name) {
    throw new Error(`candidate target/package ${candidate.target ?? "<missing>"}/${candidate.package?.name ?? "<missing>"} != ${target.id}/${target.package.name}`);
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-registry-proof-"));
  const packDir = path.join(scratch, "pack");
  const prefix = path.join(scratch, "prefix");
  const npmrc = path.join(scratch, "empty-npmrc");
  const cache = path.join(scratch, "npm-cache");
  try {
    await Promise.all([mkdir(packDir), mkdir(prefix), mkdir(path.join(scratch, "home")), writeFile(npmrc, "")]);
    const env = sanitizedNpmEnvironment(process.env, npmrc, cache);
    const coordinate = `${target.package.name}@${version}`;

    const packed = await npmInvocation(
      ["pack", coordinate, "--json", "--ignore-scripts", "--pack-destination", packDir],
      env,
      { cwd: scratch },
    );
    const receipts = parseJson(packed.stdout, "npm pack");
    if (!Array.isArray(receipts) || receipts.length !== 1) throw new Error("npm pack must return exactly one receipt");
    const packReceipt = receipts[0];
    const tarball = path.join(packDir, packReceipt.filename);
    const tarballSha256 = await fileSha256(tarball);
    const packumentDist = parseJson(
      (await npmInvocation(["view", coordinate, "dist", "--json"], env, { cwd: scratch })).stdout,
      "npm view dist",
    );

    // npm audit signatures verifies INSTALLED packages — a lockfile alone yields "found no
    // dependencies to audit that were installed from a supported registry" (live run 31532497412;
    // reproduced against a real registry install before this fix). So install the exact coordinate
    // for real in scratch (scripts stay disabled) and audit the resulting tree.
    await writeFile(path.join(scratch, "package.json"), `${JSON.stringify({ private: true, dependencies: {} })}\n`);
    await npmInvocation(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", coordinate],
      { ...env, npm_config_prefix: prefix },
      { cwd: scratch },
    );
    const audit = await npmInvocation(
      ["audit", "signatures", "--json", "--include-attestations"],
      env,
      { cwd: scratch },
    );
    parseJson(audit.stdout, "npm audit signatures");

    await npmInvocation(
      ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      env,
    );
    const installedRoot = path.join(prefix, "lib", "node_modules", ...target.package.directory);
    const entrypoint = path.join(installedRoot, target.artifact);
    const commandEnv = {
      ...process.env,
      HOME: path.join(scratch, "home"),
      XDG_CONFIG_HOME: path.join(scratch, "home", ".config"),
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
    };
    const plainVersion = (await execFileAsync(process.execPath, [entrypoint, "--version"], { env: commandEnv })).stdout.trim();
    if (plainVersion !== version) throw new Error(`installed --version ${plainVersion} != ${version}`);
    const installedIdentity = parseJson(
      (await execFileAsync(process.execPath, [entrypoint, "version", "--json"], { env: commandEnv })).stdout,
      "installed version --json",
    );
    await execFileAsync(process.execPath, [entrypoint, "mcp", "--help"], { env: commandEnv });
    assertRegistryCandidate({ candidate, packReceipt, packumentDist, tarballSha256, installedIdentity, target });

    const proof = {
      schema: REGISTRY_PROOF_SCHEMA,
      target: target.id,
      package: target.package.name,
      version,
      packument_integrity: packReceipt.integrity,
      shasum: packReceipt.shasum,
      tarball_sha256: tarballSha256,
      signature: "verified",
      provenance: "verified",
      provenance_url: packumentDist.attestations.url,
      provenance_predicate_type: packumentDist.attestations.provenance.predicateType,
      install_smoke_ok: true,
      source_commit: candidate.source.commit,
    };
    if (out) await writeFile(out, `${JSON.stringify(proof, null, 2)}\n`);
    return proof;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  verifyRegistry({
    target: arg(process.argv.slice(2), "--target", false) ?? "bridge",
    version: arg(process.argv.slice(2), "--version"),
    manifest: arg(process.argv.slice(2), "--manifest"),
    out: arg(process.argv.slice(2), "--out", false),
  })
    .then((proof) => console.log(JSON.stringify(proof)))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    });
}
