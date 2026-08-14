// Generic, offline release-review packet authority. Provider state enters only as retained bytes
// plus the deliberately small normalized ref assertions checked below.
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { currentSourceFacts } from "../packages/cli/scripts/build-bundle.mjs";
import { fileSha256 } from "./verify-npm-package.mjs";
import { RELEASE_CANDIDATE_SCHEMA, assertAllowedTuple, loadReleaseTargets, tarballFilename } from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(scriptPath), "..");
export const REVIEW_PACKET_SCHEMA = "superbee.release-packet.v1";
export const REVIEW_PACKET_INPUTS_SCHEMA = "superbee.review-packet-inputs.v1";
export const REF_ASSERTIONS_SCHEMA = "superbee.ref-assertions.v1";
export const TRANSFER_ALLOWLIST_SCHEMA = "superbee.transfer-allowlist.v1";
export const PACKET_OWNER = ".superbee-release-packet-owned-v1";
const OWNER_CONTENT = "superbee release review packet output v1\n";
const PACKET_FILE = "release-packet.json";
const DIGEST_FILE = "release-packet.sha256";
const CANDIDATE_IDS = ["bridge", "successor", "rehearsal-reject", "rehearsal-approve"];
const EVIDENCE = [
  ["planning-heads", "planning-heads.json"],
  ["registry-snapshot", "registry-snapshot.json"],
  ["refs-baseline", "refs-baseline.json"],
  ["refs-recheck", "refs-recheck.json"],
  ["settings-baseline", "settings-baseline.json"],
  ["settings-recheck", "settings-recheck.json"],
  ["transfer-bundle", "transfer-bundle"],
  ["transfer-allowlist", "transfer-allowlist.json"],
  ["cutover-script", "cutover-script"],
];
const EVIDENCE_SCHEMAS = Object.freeze({
  "planning-heads": "superbee.planning-heads.v1",
  "registry-snapshot": "opaque",
  "refs-baseline": REF_ASSERTIONS_SCHEMA,
  "refs-recheck": REF_ASSERTIONS_SCHEMA,
  "settings-baseline": "opaque",
  "settings-recheck": "opaque",
  "transfer-bundle": "opaque",
  "transfer-allowlist": TRANSFER_ALLOWLIST_SCHEMA,
  "cutover-script": "opaque",
});
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._/-]+$/;

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function packetError(message) {
  throw new Error(`release packet verification failed: ${message}`);
}

function requireObject(label, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) packetError(`${label} must be an object`);
  return value;
}

function requireString(label, value, pattern) {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) packetError(`invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

function uniqueSorted(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) packetError(`${label} must be a string array`);
  const sorted = [...values].sort();
  if (sorted.some((value, index) => value !== values[index]) || new Set(values).size !== values.length) {
    packetError(`${label} must be sorted and unique`);
  }
  return values;
}

function literalPath(label, value) {
  requireString(label, value, RELATIVE_PATH);
  if (path.posix.normalize(value) !== value || value.includes("//")) packetError(`invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

async function readJson(file, label = file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    packetError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function regularFile(file, label = file) {
  let info;
  try {
    info = await lstat(file);
  } catch {
    packetError(`${label} is missing`);
  }
  if (!info.isFile() || info.isSymbolicLink()) packetError(`${label} must be a regular non-symlink file`);
  return info;
}

function resolveInput(root, relative, label = relative) {
  literalPath(label, relative);
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) packetError(`${label} escapes repository root`);
  return resolved;
}

function localStaticImports(source, relative) {
  if (/\bimport\s*\(/.test(source)) packetError(`${relative} contains a dynamic import`);
  const imports = [];
  const pattern = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) imports.push(specifier);
  }
  return imports;
}

function resolveEsmImport(from, specifier) {
  if (!specifier.endsWith(".mjs") && !specifier.endsWith(".js") && !specifier.endsWith(".cjs")) {
    packetError(`${from} has a local import without a Node ESM file extension: ${specifier}`);
  }
  const result = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return literalPath(`${from} import`, result);
}

export async function staticPacketClosure({ root = repoRoot, entries = ["scripts/release-packet.mjs", "scripts/release-candidate.mjs", "scripts/release-verify-chain.mjs"] } = {}) {
  const found = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const relative = literalPath("entrypoint", pending.pop());
    if (found.has(relative)) continue;
    const file = resolveInput(root, relative);
    await regularFile(file, relative);
    found.add(relative);
    const text = await readFile(file, "utf8");
    for (const specifier of localStaticImports(text, relative)) {
      const imported = resolveEsmImport(relative, specifier);
      const importedFile = resolveInput(root, imported, `${relative} import`);
      try {
        await regularFile(importedFile, `${relative} import ${specifier}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("release packet verification failed:")) throw error;
        packetError(`${relative} has unresolved local import ${specifier}`);
      }
      pending.push(imported);
    }
  }
  return [...found].sort();
}

export async function validatePacketInputManifest({ root = repoRoot, manifestPath = path.join(repoRoot, "release", "review-packet-inputs.json") } = {}) {
  const manifest = requireObject("packet input manifest", await readJson(manifestPath, "packet input manifest"));
  if (manifest.schema !== REVIEW_PACKET_INPUTS_SCHEMA) packetError(`packet input manifest schema is not ${REVIEW_PACKET_INPUTS_SCHEMA}`);
  const paths = uniqueSorted(manifest.paths, "packet input manifest paths");
  for (const relative of paths) {
    resolveInput(root, literalPath("packet input manifest path", relative));
  }
  const closure = await staticPacketClosure({ root });
  const explicit = [
    "release/review-packet-inputs.json", "release/targets.json", "release/burned-versions.json", "release/phase.json",
    ".github/workflows/release-staged.yml", ".github/workflows/release-finalize.yml", ".github/release-allowed-signers",
    "package.json", "package-lock.json", "packages/cli/package.json", "packages/cli/SKILL.md",
  ];
  const expected = [...new Set([...closure, ...explicit])].sort();
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    const missing = expected.filter((item) => !paths.includes(item));
    const extra = paths.filter((item) => !expected.includes(item));
    packetError(`packet input manifest closure differs (missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"})`);
  }
  return { paths, closure, explicit };
}

async function sourceFacts(commit, publicAncestor, observed = currentSourceFacts()) {
  requireString("commit", commit, COMMIT);
  requireString("public ancestor", publicAncestor, COMMIT);
  if (observed.commit !== commit || observed.dirty !== false) packetError("create requires clean checked-out HEAD equal to --commit");
  const tree = (await execFileAsync("git", ["rev-parse", `${commit}^{tree}`], { cwd: repoRoot })).stdout.trim();
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", publicAncestor, commit], { cwd: repoRoot });
  } catch {
    packetError(`public ancestor ${publicAncestor} is not an ancestor of ${commit}`);
  }
  return { commit, tree, public_ancestor: publicAncestor, public_is_ancestor: true, dirty: false };
}

export async function preparePacketOutputDir(requested) {
  const out = path.resolve(requested);
  const root = path.parse(out).root;
  if (out === root || out === repoRoot || repoRoot.startsWith(`${out}${path.sep}`) || out.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`unsafe --out target: ${out}`);
  }
  let entries = [];
  try {
    const info = await lstat(out);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`--out must be a real directory, not a symlink or file: ${out}`);
    entries = await readdir(out);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (entries.length > 0) {
    if (!entries.includes(PACKET_OWNER)) throw new Error(`refusing to clean non-empty --out directory not owned by release-packet: ${out}`);
    if ((await readFile(path.join(out, PACKET_OWNER), "utf8")) !== OWNER_CONTENT) {
      throw new Error(`refusing to clean --out directory with an invalid ownership marker: ${out}`);
    }
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, PACKET_OWNER), OWNER_CONTENT);
  return out;
}

async function copyFile(from, to) {
  await regularFile(from, from);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { force: false, errorOnExist: true, dereference: false });
}

async function collectCandidate(slot, sourceDir, outDir, source) {
  const input = path.resolve(sourceDir);
  const info = await lstat(input).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) packetError(`candidate ${slot} must be a real directory`);
  const names = await readdir(input);
  const tarballs = names.filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) packetError(`candidate ${slot} must contain exactly one tarball`);
  const candidateFile = path.join(input, "candidate.json");
  const candidate = requireObject(`candidate ${slot}`, await readJson(candidateFile, `candidate ${slot}`));
  if (candidate.schema !== RELEASE_CANDIDATE_SCHEMA) packetError(`candidate ${slot} schema is not ${RELEASE_CANDIDATE_SCHEMA}`);
  if (candidate.target !== slot) packetError(`candidate ${slot} target mismatch`);
  if (candidate.source?.commit !== source.commit || candidate.source?.dirty !== false) packetError(`candidate ${slot} source mismatch`);
  const targets = await loadReleaseTargets();
  const target = targets.targets[slot];
  if (!target) packetError(`candidate ${slot} is not a known release target`);
  if (candidate.package?.name !== target.package.name || candidate.version !== candidate.tarball?.version) packetError(`candidate ${slot} package/version mismatch`);
  assertAllowedTuple(targets, { target: slot, packageName: candidate.package.name, version: candidate.version, tag: candidate.tag });
  if (candidate.tarball?.filename !== tarballs[0] || candidate.tarball.filename !== tarballFilename(target, candidate.version)) {
    packetError(`candidate ${slot} tarball filename mismatch`);
  }
  const tarball = path.join(input, tarballs[0]);
  if (await fileSha256(tarball) !== candidate.tarball.sha256) packetError(`candidate ${slot} tarball digest mismatch`);
  const relativeBase = `candidates/${slot}`;
  await copyFile(candidateFile, path.join(outDir, relativeBase, "candidate.json"));
  await copyFile(tarball, path.join(outDir, relativeBase, tarballs[0]));
  return {
    slot,
    target: slot,
    package: candidate.package.name,
    version: candidate.version,
    tag: candidate.tag,
    manifest: `${relativeBase}/candidate.json`,
    tarball: `${relativeBase}/${tarballs[0]}`,
  };
}

function refSet(label, value) {
  const refs = uniqueSorted(value, label);
  for (const ref of refs) requireString(label, ref, /^refs\/(heads|tags|notes)\/.+/);
  return refs;
}

export function validateRefAssertionsEnvelope(value, { publicAncestor, privateCommit, allowlist = false } = {}) {
  const envelope = requireObject("ref assertion envelope", value);
  const expectedSchema = allowlist ? TRANSFER_ALLOWLIST_SCHEMA : REF_ASSERTIONS_SCHEMA;
  if (envelope.schema !== expectedSchema) packetError(`ref assertion schema is not ${expectedSchema}`);
  if (envelope.public_main !== publicAncestor || envelope.public_ancestor_P !== publicAncestor || envelope.private_R !== privateCommit) {
    packetError("ref assertion P/R/public-main mismatch");
  }
  if (envelope.held_board_ref !== "refs/heads/board") packetError("held board ref must be refs/heads/board");
  const allowed = refSet("allowed refs", envelope.allowed_refs);
  if (allowed.includes(envelope.held_board_ref)) packetError("held board ref must not be transferable");
  const categories = uniqueSorted(envelope.required_categories, "required categories");
  if (JSON.stringify(categories) !== JSON.stringify(["main", "notes", "tags"])) packetError("required categories must be main, notes, and tags");
  const hasRequiredCategories = (refs) => (
    refs.includes("refs/heads/main") && refs.some((ref) => ref.startsWith("refs/tags/")) && refs.some((ref) => ref.startsWith("refs/notes/"))
  );
  if (!hasRequiredCategories(allowed)) packetError("allowed refs must cover main, tags, and notes");
  if (!allowlist) {
    const observed = refSet("observed refs", envelope.observed_refs);
    if (observed.includes(envelope.held_board_ref)) packetError("held board ref must not appear in observed transferable refs");
    if (JSON.stringify(observed) !== JSON.stringify(allowed)) packetError("observed refs must exactly equal allowed transferable refs");
  }
  return envelope;
}

async function collectEvidence(id, sourceFile, outDir, source) {
  const found = EVIDENCE.find(([name]) => name === id);
  if (!found) packetError(`unknown evidence category ${id}`);
  await regularFile(sourceFile, `evidence ${id}`);
  const [, destination] = found;
  const relative = `evidence/${destination}`;
  await copyFile(sourceFile, path.join(outDir, relative));
  const row = { category: id, schema: "opaque", path: relative, sha256: await fileSha256(sourceFile), bytes: (await lstat(sourceFile)).size };
  if (id === "refs-baseline" || id === "refs-recheck" || id === "transfer-allowlist") {
    const parsed = await readJson(sourceFile, `evidence ${id}`);
    validateRefAssertionsEnvelope(parsed, { publicAncestor: source.public_ancestor, privateCommit: source.commit, allowlist: id === "transfer-allowlist" });
    row.schema = parsed.schema;
  } else if (id === "planning-heads") {
    const parsed = requireObject("planning heads", await readJson(sourceFile, "planning heads"));
    if (parsed.schema !== "superbee.planning-heads.v1") packetError("planning heads schema is not superbee.planning-heads.v1");
    for (const name of ["plan", "contract", "successor_coordinate_decision"]) requireString(`planning heads ${name}`, parsed[name], SHA256);
    row.schema = parsed.schema;
  }
  return row;
}

async function inventory(outDir) {
  const rows = [];
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(outDir, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      const file = path.join(outDir, child);
      if (entry.isSymbolicLink()) packetError(`packet must not contain symlink ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && child !== PACKET_FILE && child !== DIGEST_FILE) rows.push({ path: child, sha256: await fileSha256(file), bytes: (await lstat(file)).size });
      else if (!entry.isFile()) packetError(`packet has unsupported filesystem entry ${child}`);
    }
  }
  await walk();
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

async function sourceInputDigests(root = repoRoot) {
  const { paths } = await validatePacketInputManifest({ root, manifestPath: path.join(root, "release", "review-packet-inputs.json") });
  return Promise.all(paths.map(async (relative) => ({ path: relative, sha256: await fileSha256(resolveInput(root, relative)) }))).then((rows) => rows.sort((a, b) => a.path.localeCompare(b.path)));
}

export async function createReleasePacket({ commit, publicAncestor, out, candidates, evidence, observedSource }) {
  const source = await sourceFacts(commit, publicAncestor, observedSource);
  const outDir = await preparePacketOutputDir(out);
  if (!candidates || Object.keys(candidates).length !== CANDIDATE_IDS.length || CANDIDATE_IDS.some((id) => !candidates[id])) {
    packetError("create requires exactly four named candidate slots");
  }
  if (!evidence || Object.keys(evidence).length !== EVIDENCE.length || EVIDENCE.some(([id]) => !evidence[id])) {
    packetError("create requires every fixed evidence slot exactly once");
  }
  const candidateRows = {};
  for (const id of CANDIDATE_IDS) candidateRows[id] = await collectCandidate(id, candidates[id], outDir, source);
  const evidenceRows = [];
  for (const [id] of EVIDENCE) evidenceRows.push(await collectEvidence(id, evidence[id], outDir, source));
  const targets = await loadReleaseTargets();
  const tuples = Object.fromEntries(CANDIDATE_IDS.map((id) => [id, targets.allowed_tuples[id]]));
  const burns = (await readJson(path.join(repoRoot, "release", "burned-versions.json"), "burn ledger")).burned
    .filter((entry) => entry.version === "0.1.0-pre.10");
  if (burns.length !== 1) packetError("burn ledger must contain exactly one nonpublished pre.10 burn");
  const packet = {
    schema: REVIEW_PACKET_SCHEMA,
    source,
    generator: {
      entrypoint: "scripts/release-packet.mjs",
      entrypoint_sha256: await fileSha256(path.join(repoRoot, "scripts", "release-packet.mjs")),
      input_manifest_sha256: await fileSha256(path.join(repoRoot, "release", "review-packet-inputs.json")),
      source_inputs: await sourceInputDigests(),
    },
    tuples,
    burns,
    candidates: candidateRows,
    external_evidence: evidenceRows,
    inventory: await inventory(outDir),
  };
  await writeFile(path.join(outDir, PACKET_FILE), canonicalJson(packet));
  await writeFile(path.join(outDir, DIGEST_FILE), `${await fileSha256(path.join(outDir, PACKET_FILE))}  ${PACKET_FILE}\n`);
  return { outDir, packet };
}

export async function verifyReleasePacket({ packet: packetFile, root = repoRoot }) {
  const packetPath = path.resolve(packetFile);
  const outDir = path.dirname(packetPath);
  if (path.basename(packetPath) !== PACKET_FILE) packetError(`packet path must end in ${PACKET_FILE}`);
  const text = await readFile(packetPath, "utf8");
  const packet = requireObject("packet", await readJson(packetPath, "packet"));
  if (packet.schema !== REVIEW_PACKET_SCHEMA || canonicalJson(packet) !== text) packetError("packet is not canonical release-packet JSON");
  const digest = await readFile(path.join(outDir, DIGEST_FILE), "utf8");
  if (digest !== `${await fileSha256(packetPath)}  ${PACKET_FILE}\n`) packetError("detached packet digest mismatch");
  const source = requireObject("packet source", packet.source);
  requireString("packet R", source.commit, COMMIT);
  requireString("packet P", source.public_ancestor, COMMIT);
  if (source.public_is_ancestor !== true || source.dirty !== false) packetError("packet source facts are incomplete");
  const observedTree = (await execFileAsync("git", ["rev-parse", `${source.commit}^{tree}`], { cwd: root })).stdout.trim();
  if (source.tree !== observedTree) packetError("packet source tree differs from checkout");
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", source.public_ancestor, source.commit], { cwd: root });
  } catch {
    packetError("packet public ancestor is not an ancestor of packet R");
  }
  const expectedInputs = await sourceInputDigests(root);
  if (JSON.stringify(packet.generator?.source_inputs) !== JSON.stringify(expectedInputs)) packetError("packet source input digests differ from checkout");
  if (packet.generator?.entrypoint_sha256 !== await fileSha256(path.join(root, "scripts", "release-packet.mjs"))) packetError("packet generator digest differs from checkout");
  if (packet.generator?.input_manifest_sha256 !== await fileSha256(path.join(root, "release", "review-packet-inputs.json"))) packetError("packet input manifest digest differs from checkout");
  const actualInventory = await inventory(outDir);
  if (JSON.stringify(packet.inventory) !== JSON.stringify(actualInventory)) packetError("packet inventory differs from retained files");
  const paths = new Set(packet.inventory.map((row) => row.path));
  if (paths.has(PACKET_FILE) || paths.has(DIGEST_FILE)) packetError("packet must not inventory itself or its detached digest");
  if (!packet.candidates || JSON.stringify(Object.keys(packet.candidates).sort()) !== JSON.stringify([...CANDIDATE_IDS].sort())) packetError("packet must contain exactly four candidate slots");
  const targets = await loadReleaseTargets(path.join(root, "release", "targets.json"));
  const expectedTuples = Object.fromEntries(CANDIDATE_IDS.map((id) => [id, targets.allowed_tuples[id]]));
  if (JSON.stringify(packet.tuples) !== JSON.stringify(expectedTuples)) packetError("packet tuple authority differs from release targets");
  for (const id of CANDIDATE_IDS) {
    const row = packet.candidates[id];
    if (row?.manifest !== `candidates/${id}/candidate.json`) packetError(`packet candidate ${id} manifest path mismatch`);
    const candidatePath = path.join(outDir, row?.manifest ?? "");
    const candidate = requireObject(`packet candidate ${id}`, await readJson(candidatePath, `packet candidate ${id}`));
    const tarballPath = path.join(outDir, row?.tarball ?? "");
    await regularFile(tarballPath, `packet candidate ${id} tarball`);
    if (candidate.schema !== RELEASE_CANDIDATE_SCHEMA || candidate.target !== id || candidate.source?.commit !== source.commit || candidate.source?.dirty !== false) packetError(`packet candidate ${id} source/schema mismatch`);
    const target = targets.targets[id];
    if (!target || candidate.package?.name !== target.package.name || candidate.version !== packet.tuples?.[id]?.version || candidate.tag !== packet.tuples?.[id]?.tag) packetError(`packet candidate ${id} tuple mismatch`);
    assertAllowedTuple(targets, { target: id, packageName: candidate.package.name, version: candidate.version, tag: candidate.tag });
    if (row.tarball !== `candidates/${id}/${tarballFilename(target, candidate.version)}`) packetError(`packet candidate ${id} tarball path mismatch`);
    if (candidate.tarball?.filename !== path.basename(tarballPath) || candidate.tarball.sha256 !== await fileSha256(tarballPath)) packetError(`packet candidate ${id} tarball mismatch`);
  }
  if (!Array.isArray(packet.external_evidence) || packet.external_evidence.length !== EVIDENCE.length) packetError("packet evidence slots are incomplete");
  const evidenceById = new Map(packet.external_evidence.map((row) => [row.category, row]));
  if (evidenceById.size !== EVIDENCE.length || EVIDENCE.some(([id]) => !evidenceById.has(id))) packetError("packet evidence categories are not exact");
  for (const [id, destination] of EVIDENCE) {
    const row = evidenceById.get(id);
    if (row.path !== `evidence/${destination}`) packetError(`packet evidence ${id} path mismatch`);
    if (row.schema !== EVIDENCE_SCHEMAS[id]) packetError(`packet evidence ${id} schema mismatch`);
    const file = path.join(outDir, row.path);
    await regularFile(file, `packet evidence ${id}`);
    if (row.sha256 !== await fileSha256(file) || row.bytes !== (await lstat(file)).size) packetError(`packet evidence ${id} digest mismatch`);
    if (id === "refs-baseline" || id === "refs-recheck" || id === "transfer-allowlist") {
      const parsed = await readJson(file, `packet evidence ${id}`);
      validateRefAssertionsEnvelope(parsed, { publicAncestor: source.public_ancestor, privateCommit: source.commit, allowlist: id === "transfer-allowlist" });
      if (row.schema !== parsed.schema) packetError(`packet evidence ${id} schema mismatch`);
    }
  }
  const burns = (await readJson(path.join(root, "release", "burned-versions.json"), "burn ledger")).burned
    .filter((entry) => entry.version === "0.1.0-pre.10");
  if (JSON.stringify(packet.burns) !== JSON.stringify(burns) || burns.length !== 1) packetError("packet pre.10 burn mismatch");
  return packet;
}

function parsePairs(argv, flag, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || !value.includes("=")) throw new Error(`missing ${flag} name=path`);
    const [name, ...parts] = value.split("=");
    if (!allowed.includes(name) || values[name] || parts.length === 0 || !parts.join("=")) throw new Error(`invalid ${flag} ${value}`);
    values[name] = parts.join("=");
    index += 1;
  }
  return values;
}

function option(argv, flag) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${flag}`);
  return value;
}

export function parsePacketArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "create") return {
    command, commit: option(rest, "--commit"), publicAncestor: option(rest, "--public-ancestor"), out: option(rest, "--out"),
    candidates: parsePairs(rest, "--candidate", CANDIDATE_IDS), evidence: parsePairs(rest, "--evidence", EVIDENCE.map(([id]) => id)),
  };
  if (command === "verify") return { command, packet: option(rest, "--packet") };
  throw new Error("usage: release-packet.mjs create|verify ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const args = parsePacketArgs(process.argv.slice(2));
    const result = args.command === "create" ? await createReleasePacket(args) : await verifyReleasePacket(args);
    console.log(args.command === "create" ? `release packet created: ${result.outDir}` : `release packet verified: ${args.packet}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
