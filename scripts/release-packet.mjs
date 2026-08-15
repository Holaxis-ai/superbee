// Generic, offline release-review packet authority. Provider state enters only as retained bytes
// plus the deliberately small normalized ref assertions checked below.
import { execFile } from "node:child_process";
import { canonicalizeJsonValue } from "./canonical-json.mjs";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

import { isMainModule } from "./is-main-module.mjs";
import { fileSha256, verifyRetainedTarball } from "./verify-npm-package.mjs";
import { RELEASE_CANDIDATE_SCHEMA, assertAllowedTuple, loadReleaseTargets, tarballFilename } from "./release-targets.mjs";
import { deriveWorkflowExecution } from "./release-workflow-topology.mjs";
import { RELEASE_SETTINGS_SCHEMA, assertSettingsRecheckFollows, validateReleaseSettingsCapture } from "./release-settings-capture.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(scriptPath), "..");
export const REVIEW_PACKET_SCHEMA = "superbee.release-packet.v3";
export const REVIEW_PACKET_INPUTS_SCHEMA = "superbee.review-packet-inputs.v1";
// v2 carries a ref -> commit map instead of bare ref names: a transfer bundle is only meaningful
// evidence when its heads are bound to specific commits.
export const REF_ASSERTIONS_SCHEMA = "superbee.ref-assertions.v2";
export const TRANSFER_ALLOWLIST_SCHEMA = "superbee.transfer-allowlist.v2";
export const HELD_BOARD_REF = "refs/heads/board";
const PACKET_FILE = "release-packet.json";
const DIGEST_FILE = "release-packet.sha256";
// The generator pins itself: no workflow runs `release:packet`, and the packet records this file's
// own digest. Every other entrypoint is derived from the workflows by release-workflow-topology.
const SOURCE_ENTRYPOINTS = ["scripts/release-packet.mjs"];
// Files the packet pins because a reviewer needs them, independent of any import edge.
const EXPLICIT_PACKET_INPUTS = [
  "release/review-packet-inputs.json", "release/targets.json", "release/burned-versions.json",
  ".github/release-allowed-signers", "package.json", "package-lock.json", "packages/cli/SKILL.md",
];
const EXTERNAL_IMPORTS = new Set(["es-module-lexer", "esbuild", "pako"]); // Directly declared and lockfile-pinned build dependencies.
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
  "settings-baseline": RELEASE_SETTINGS_SCHEMA,
  "settings-recheck": RELEASE_SETTINGS_SCHEMA,
  "transfer-bundle": "git-bundle",
  "transfer-allowlist": TRANSFER_ALLOWLIST_SCHEMA,
  "cutover-script": "opaque",
});
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._/-]+$/;
const REF = /^refs\/(?:heads|tags|notes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// Refs the repository merely holds are only enumerated and compared, never transferred, so they are
// admitted on a wider (still control-character-free) alphabet than the transferable set.
const LOOSE_REF = /^refs\/[!-~]+$/;
const GITIGNORE = ".gitignore";

await init;

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

function exactKeys(value, label, keys) {
  const actual = Object.keys(requireObject(label, value)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    packetError(`${label} keys differ (expected: ${expected.join(",")}; actual: ${actual.join(",")})`);
  }
  return value;
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

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    packetError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sameJsonValue(left, right) {
  return JSON.stringify(canonicalizeJsonValue(left)) === JSON.stringify(canonicalizeJsonValue(right));
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
  if (relative.endsWith(".js") && (/\brequire\s*\(/.test(source) || /\bmodule\.exports\b|\bexports\./.test(source))) {
    packetError(`${relative} has unsupported CommonJS require edge`);
  }
  let imports;
  try {
    [imports] = parse(source);
  } catch (error) {
    packetError(`${relative} is not parseable ESM: ${error instanceof Error ? error.message : String(error)}`);
  }
  const staticImports = [];
  for (const imported of imports) {
    if (imported.d === -2) continue; // import.meta is not a module edge.
    if (imported.d >= 0) packetError(`${relative} contains a dynamic import`);
    if (imported.a >= 0) packetError(`${relative} has an import attribute`);
    if (typeof imported.n !== "string") packetError(`${relative} has an unsupported import declaration`);
    staticImports.push(imported.n);
  }
  return staticImports;
}

function resolveEsmImport(from, specifier) {
  if (!specifier.endsWith(".mjs") && !specifier.endsWith(".js")) {
    packetError(`${from} has a local import without a Node ESM file extension: ${specifier}`);
  }
  const result = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return literalPath(`${from} import`, result);
}

export async function staticPacketClosure({ root = repoRoot, entries = SOURCE_ENTRYPOINTS } = {}) {
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
      if (specifier === "node:module") {
        packetError(`${relative} has unsupported CommonJS interop import node:module`);
      }
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        if (!EXTERNAL_IMPORTS.has(specifier)) packetError(`${relative} has unsupported non-relative import ${specifier}`);
        continue;
      }
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

async function gitStdout(root, args, label, options = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, ...options });
    return stdout;
  } catch (error) {
    packetError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Every path in the Git index, as the authority for "this file is reviewed source". */
async function trackedPathSet(root) {
  const stdout = await gitStdout(root, ["ls-files", "-z"], "cannot read git index", { encoding: "buffer" });
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const paths = new Set();
  let start = 0;
  for (let end = bytes.indexOf(0, start); end !== -1; end = bytes.indexOf(0, start)) {
    paths.add(bytes.subarray(start, end).toString("utf8"));
    start = end + 1;
  }
  if (start !== bytes.length) packetError("git index output is not NUL terminated");
  return paths;
}

async function isIgnoredPath(root, relative) {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", relative], { cwd: root });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    packetError(`cannot classify ${relative} against the checkout's ignore rules: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Derive the release execution surface from the workflows, then bind it to the committed manifest.
 * The manifest is the reviewed declaration; this recomputes it from the checkout on every create
 * and verify, so a workflow edit that reaches new code fails the packet until the code is pinned.
 */
export async function validatePacketInputManifest({ root = repoRoot, manifestPath = path.join(repoRoot, "release", "review-packet-inputs.json") } = {}) {
  const manifest = requireObject("packet input manifest", await readJson(manifestPath, "packet input manifest"));
  if (manifest.schema !== REVIEW_PACKET_INPUTS_SCHEMA) packetError(`packet input manifest schema is not ${REVIEW_PACKET_INPUTS_SCHEMA}`);
  const paths = uniqueSorted(manifest.paths, "packet input manifest paths");
  for (const relative of paths) {
    resolveInput(root, literalPath("packet input manifest path", relative));
  }
  const targets = await loadPacketTargets(root);
  const trackedPaths = await trackedPathSet(root);
  const execution = await deriveWorkflowExecution({
    root,
    publishedPackageNames: [...new Set(Object.values(targets.allowed_tuples).map((tuple) => tuple.package))],
    trackedPaths,
    isIgnored: (relative) => isIgnoredPath(root, relative),
    fail: packetError,
  });
  const workflowEntries = [...new Set([...SOURCE_ENTRYPOINTS, ...execution.entrypoints])].sort();
  const closure = await staticPacketClosure({ root, entries: workflowEntries });
  // Ignore rules are authority twice over: they decide which checkout residue a packet build may
  // carry, and which workflow-executed paths count as build output rather than pinned source.
  const ignoreRuleFiles = [...trackedPaths].filter((relative) => path.posix.basename(relative) === GITIGNORE);
  const explicit = [...EXPLICIT_PACKET_INPUTS, ...ignoreRuleFiles, ...execution.workflowFiles, ...execution.scriptAuthorityFiles];
  const expected = [...new Set([...closure, ...explicit])].sort();
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    const missing = expected.filter((item) => !paths.includes(item));
    const extra = paths.filter((item) => !expected.includes(item));
    packetError(`packet input manifest closure differs (missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"})`);
  }
  return { paths, closure, explicit, workflowEntries, execution };
}

async function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function assertExecutionRoot(root, label) {
  const [requested, executing] = await Promise.all([canonicalPath(root), canonicalPath(repoRoot)]);
  if (requested !== executing) {
    packetError(`${label} must execute from the same checkout as --root; run ${path.join(requested, "scripts", "release-packet.mjs")}`);
  }
}

async function sourceFacts(commit, publicAncestor, observed, root = repoRoot) {
  requireString("commit", commit, COMMIT);
  requireString("public ancestor", publicAncestor, COMMIT);
  const facts = observed ?? await observedCheckout(root);
  if (!observed) await assertDetachedCheckout(root);
  if (facts.commit !== commit || facts.dirty !== false) packetError("create requires clean checked-out HEAD equal to --commit");
  const tree = (await execFileAsync("git", ["rev-parse", `${commit}^{tree}`], { cwd: root })).stdout.trim();
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", publicAncestor, commit], { cwd: root });
  } catch {
    packetError(`public ancestor ${publicAncestor} is not an ancestor of ${commit}`);
  }
  return { commit, tree, public_ancestor: publicAncestor, public_is_ancestor: true, dirty: false };
}

export async function preparePacketOutputDir(requested, root = repoRoot) {
  const out = path.resolve(requested);
  const filesystemRoot = path.parse(out).root;
  if (out === filesystemRoot || out === root || root.startsWith(`${out}${path.sep}`) || out.startsWith(`${root}${path.sep}`)) {
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
    throw new Error(`refusing to replace non-empty --out directory: ${out}`);
  }
  return out;
}

async function stagePacketOutput(out) {
  await mkdir(path.dirname(out), { recursive: true });
  return mkdtemp(path.join(path.dirname(out), `.${path.basename(out)}.packet-`));
}

async function installPacketOutput(staged, out) {
  // POSIX rename replaces only an empty target directory. If another writer fills it after the
  // preflight, the rename fails and preserves that writer's output.
  await rename(staged, out);
}

async function copyFile(from, to) {
  await regularFile(from, from);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { force: false, errorOnExist: true, dereference: false });
}

function assertRetainedVerifierReceipt(label, receipt, tuple) {
  const expectedCoordinate = `${tuple.package}@${tuple.version}`;
  const embeddedPackage = receipt?.identity?.identity?.package;
  if (receipt?.package !== expectedCoordinate || embeddedPackage?.name !== tuple.package || embeddedPackage?.version !== tuple.version) {
    packetError(`${label} retained-tarball proof receipt does not match reviewed tuple ${expectedCoordinate}`);
  }
}

async function collectCandidate(slot, sourceDir, outDir, source, { targets, root, retainedVerifier }) {
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
  const target = targets.targets[slot];
  if (!target) packetError(`candidate ${slot} is not a known release target`);
  if (candidate.package?.name !== target.package.name || candidate.version !== candidate.tarball?.version) packetError(`candidate ${slot} package/version mismatch`);
  const tuple = assertAllowedTuple(targets, { target: slot, packageName: candidate.package.name, version: candidate.version, tag: candidate.tag });
  if (candidate.tarball?.filename !== tarballs[0] || candidate.tarball.filename !== tarballFilename(target, candidate.version)) {
    packetError(`candidate ${slot} tarball filename mismatch`);
  }
  const tarball = path.join(input, tarballs[0]);
  if (await fileSha256(tarball) !== candidate.tarball.sha256) packetError(`candidate ${slot} tarball digest mismatch`);
  try {
    const receipt = await retainedVerifier({
      tarball,
      manifest: candidateFile,
      targetsPath: path.join(root, "release", "targets.json"),
    });
    assertRetainedVerifierReceipt(`candidate ${slot}`, receipt, tuple);
  } catch (error) {
    packetError(`candidate ${slot} retained-tarball proof failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function refName(label, ref) {
  requireString(label, ref, REF);
  if (ref.includes("//") || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".")) {
    packetError(`invalid ${label}: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** A ref -> commit map in canonical (sorted, unique) key order. */
function refMap(label, value) {
  const map = requireObject(label, value);
  const refs = uniqueSorted(Object.keys(map), `${label} names`);
  for (const ref of refs) {
    refName(label, ref);
    requireString(`${label} ${ref} commit`, map[ref], COMMIT);
  }
  return refs;
}

export function validateRefAssertionsEnvelope(value, { publicAncestor, privateCommit, allowlist = false } = {}) {
  const envelope = exactKeys(value, "ref assertion envelope", allowlist
    ? ["schema", "public_main", "public_ancestor_P", "private_R", "held_board_ref", "allowed_refs", "required_categories"]
    : ["schema", "public_main", "public_ancestor_P", "private_R", "held_board_ref", "allowed_refs", "required_categories", "observed_refs"]);
  const expectedSchema = allowlist ? TRANSFER_ALLOWLIST_SCHEMA : REF_ASSERTIONS_SCHEMA;
  if (envelope.schema !== expectedSchema) packetError(`ref assertion schema is not ${expectedSchema}`);
  if (envelope.public_main !== publicAncestor || envelope.public_ancestor_P !== publicAncestor || envelope.private_R !== privateCommit) {
    packetError("ref assertion P/R/public-main mismatch");
  }
  if (envelope.held_board_ref !== HELD_BOARD_REF) packetError(`held board ref must be ${HELD_BOARD_REF}`);
  const allowed = refMap("allowed refs", envelope.allowed_refs);
  if (allowed.includes(envelope.held_board_ref)) packetError("held board ref must not be transferable");
  const categories = uniqueSorted(envelope.required_categories, "required categories");
  if (JSON.stringify(categories) !== JSON.stringify(["main", "notes", "tags"])) packetError("required categories must be main, notes, and tags");
  const hasRequiredCategories = (refs) => (
    refs.includes("refs/heads/main") && refs.some((ref) => ref.startsWith("refs/tags/")) && refs.some((ref) => ref.startsWith("refs/notes/"))
  );
  if (!hasRequiredCategories(allowed)) packetError("allowed refs must cover main, tags, and notes");
  // The transfer moves the reviewed private head into the public repository, and P — proven an
  // ancestor of R in the source checkout — is the fast-forward base. Binding main to R is what
  // stops a bundle that carries the approved ref NAMES over unreviewed content.
  if (envelope.allowed_refs["refs/heads/main"] !== privateCommit) {
    packetError(`transferable refs/heads/main must carry the reviewed commit ${privateCommit}, not ${JSON.stringify(envelope.allowed_refs["refs/heads/main"])}`);
  }
  if (!allowlist) {
    refMap("observed refs", envelope.observed_refs);
    if (Object.hasOwn(envelope.observed_refs, envelope.held_board_ref)) packetError("held board ref must not appear in observed transferable refs");
    if (!sameJsonValue(envelope.observed_refs, envelope.allowed_refs)) packetError("observed refs must exactly equal allowed transferable refs");
  }
  return envelope;
}

function reservedCandidateTagRefs(targets) {
  return [...new Set(Object.values(targets.allowed_tuples).map((tuple) => `refs/tags/${tuple.tag}`))].sort();
}

/**
 * What the packet claims, written from the facts it actually recorded. Verification rebuilds this
 * sentence from the retained evidence and compares, so the human-readable claim cannot drift from
 * the machine-checked one.
 */
function transferClaim({ protected_release_tag_refs: protectedTags, transfer_refs_confirmed_at_create: confirmed, transfer_refs_unobserved_at_create: unobserved }) {
  return [
    `The creating repository held ${confirmed.length} of ${confirmed.length + unobserved.length} allowlisted refs at the asserted commits`,
    `(confirmed: ${confirmed.join(" ") || "none"}; not present in the creating repository: ${unobserved.join(" ") || "none"})`,
    `and held none of the ${protectedTags.length} protected release tags.`,
    "The retained bundle unbundles into a complete connected history whose heads are exactly the allowlisted refs at those commits.",
    "Nothing here proves the state of any remote repository.",
  ].join(" ");
}

function packetLifecycle(targets, envelope, repositoryRefs) {
  const live = new Set(repositoryRefs.map((row) => row.ref));
  const allowed = Object.keys(envelope.allowed_refs);
  const lifecycle = {
    protected_release_tag_refs: reservedCandidateTagRefs(targets),
    creation_repository_refs: repositoryRefs,
    transfer_refs_confirmed_at_create: allowed.filter((ref) => live.has(ref)).sort(),
    transfer_refs_unobserved_at_create: allowed.filter((ref) => !live.has(ref)).sort(),
  };
  return { ...lifecycle, claim: transferClaim(lifecycle) };
}

function repositoryRefRows(label, value) {
  if (!Array.isArray(value)) packetError(`${label} must be an array`);
  const rows = value.map((row) => {
    exactKeys(row, `${label} row`, ["ref", "sha"]);
    requireString(`${label} ref`, row.ref, LOOSE_REF);
    if (row.ref.includes("..")) packetError(`invalid ${label} ref: ${JSON.stringify(row.ref)}`);
    requireString(`${label} ${row.ref} commit`, row.sha, COMMIT);
    return row.ref;
  });
  uniqueSorted(rows, `${label} names`);
  return new Map(value.map((row) => [row.ref, row.sha]));
}

function validatePacketLifecycle(value, targets, envelope) {
  const lifecycle = exactKeys(value, "packet lifecycle", [
    "claim", "creation_repository_refs", "protected_release_tag_refs",
    "transfer_refs_confirmed_at_create", "transfer_refs_unobserved_at_create",
  ]);
  repositoryRefRows("packet lifecycle creation repository refs", lifecycle.creation_repository_refs);
  const expected = packetLifecycle(targets, envelope, lifecycle.creation_repository_refs);
  if (!sameJsonValue(lifecycle, expected)) {
    packetError("packet lifecycle differs from the release targets and the retained transfer evidence");
  }
  return lifecycle;
}

/** The bundle header's own ref -> commit table. Cheap, and trusted for nothing on its own. */
async function transferBundleHeads(bundleFile) {
  await regularFile(bundleFile, "transfer bundle");
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["bundle", "list-heads", bundleFile], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
  } catch (error) {
    packetError(`transfer bundle is not a valid git bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  const heads = {};
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [, sha, ref] = /^([a-f0-9]{40})\s+(\S+)$/.exec(line) ?? [];
    if (!ref) packetError(`transfer bundle list-heads output is malformed: ${JSON.stringify(line)}`);
    refName("transfer bundle ref", ref);
    if (Object.hasOwn(heads, ref)) packetError(`transfer bundle repeats ref ${ref}`);
    heads[ref] = sha;
  }
  return Object.fromEntries(Object.keys(heads).sort().map((ref) => [ref, heads[ref]]));
}

/**
 * Unpack the bundle for real. `git bundle verify` reads only the header — it calls a bundle
 * truncated to its first bytes "okay" — so the pack is validated by fetching it into a scratch
 * repository, which runs index-pack over every byte, and then walking every reachable object. A
 * bundle with prerequisites cannot complete this fetch, which is the intended outcome: transfer
 * evidence has to stand on its own.
 */
async function unbundleTransferPack(bundleFile) {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-transfer-pack-"));
  try {
    try {
      await execFileAsync("git", ["init", "--quiet", "--bare", "--template=", scratch]);
    } catch (error) {
      packetError(`cannot create a scratch repository for the transfer bundle: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await execFileAsync("git", ["-C", scratch, "fetch", "--quiet", "--no-tags", bundleFile, "+refs/*:refs/bundle/*"], { maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      packetError(`transfer bundle pack is incomplete, corrupt, or not self-contained: ${error instanceof Error ? error.message : String(error)}`);
    }
    const listed = await gitStdout(scratch, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/bundle/"], "cannot read the unbundled transfer refs");
    const heads = {};
    for (const line of listed.split("\n").filter(Boolean)) {
      const [, sha, ref] = /^([a-f0-9]{40}) (\S+)$/.exec(line) ?? [];
      if (!ref) packetError(`unbundled ref listing is malformed: ${JSON.stringify(line)}`);
      heads[refName("unbundled transfer ref", `refs/${ref.slice("refs/bundle/".length)}`)] = sha;
    }
    const objects = Object.values(heads);
    if (objects.length === 0) packetError("transfer bundle pack carries no refs");
    try {
      await execFileAsync("git", ["-C", scratch, "rev-list", "--objects", "--quiet", ...objects], { maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      packetError(`transfer bundle history is not fully connected: ${error instanceof Error ? error.message : String(error)}`);
    }
    return Object.fromEntries(Object.keys(heads).sort().map((ref) => [ref, heads[ref]]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Every ref this checkout actually holds. Remote-tracking refs are not transferable and are out of scope. */
async function enumerateRepositoryRefs(root) {
  const listed = await gitStdout(root, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags", "refs/notes"], "cannot enumerate repository refs");
  const rows = [];
  for (const line of listed.split("\n").filter(Boolean)) {
    const [, sha, ref] = /^([a-f0-9]{40}) (\S+)$/.exec(line) ?? [];
    if (!ref) packetError(`git for-each-ref output is malformed: ${JSON.stringify(line)}`);
    requireString("repository ref", ref, LOOSE_REF);
    rows.push({ ref, sha });
  }
  return rows.sort((a, b) => codePointOrder(a.ref, b.ref));
}

function parseSettingsEvidence(bytes, label) {
  return validateReleaseSettingsCapture(requireObject(label, parseJsonBytes(bytes, label)), label, packetError);
}

/**
 * Two real captures of one repository, taken at two instants, agreeing on every pinned setting.
 * The producer owns the schema and the projection; this only compares what it emitted.
 */
function validateSettingsAuthority({ baseline, recheck }) {
  assertSettingsRecheckFollows(baseline, recheck, packetError);
  if (!sameJsonValue(baseline.repository, recheck.repository)) packetError("settings baseline and recheck describe different repositories");
  if (!sameJsonValue(baseline.settings, recheck.settings)) packetError("settings baseline and recheck differ");
}

function describeRefMap(map) {
  return Object.entries(map).map(([ref, sha]) => `${ref}@${sha}`).join(",") || "none";
}

/**
 * Bind the three operator-supplied envelopes, the retained bundle's actual pack, and the refs the
 * creating repository really held to one another.
 *
 * `repositoryRefs` is a live `for-each-ref` enumeration at create time and the enumeration the
 * packet recorded at verify time — the same rules run over both, which is the only honest way to
 * re-run a repository-state check offline.
 */
async function validateTransferAuthority({ baseline, recheck, allowlist, bundleFile, source, targets, repositoryRefs, mode }) {
  for (const [label, value, isAllowlist] of [["refs baseline", baseline, false], ["refs recheck", recheck, false], ["transfer allowlist", allowlist, true]]) {
    try {
      validateRefAssertionsEnvelope(value, { publicAncestor: source.public_ancestor, privateCommit: source.commit, allowlist: isAllowlist });
    } catch (error) {
      packetError(`${label}: ${error instanceof Error ? error.message.replace("release packet verification failed: ", "") : String(error)}`);
    }
  }
  const expected = baseline.allowed_refs;
  if (!sameJsonValue(recheck.allowed_refs, expected) || !sameJsonValue(allowlist.allowed_refs, expected)) {
    packetError("transfer baseline/recheck/allowlist allowed refs differ");
  }
  const listedHeads = await transferBundleHeads(bundleFile);
  const packedHeads = await unbundleTransferPack(bundleFile);
  if (!sameJsonValue(listedHeads, packedHeads)) {
    packetError(`transfer bundle header refs differ from the refs its pack carries (header: ${describeRefMap(listedHeads)}; pack: ${describeRefMap(packedHeads)})`);
  }
  if (!sameJsonValue(packedHeads, expected)) {
    packetError(`transfer bundle heads differ from the reviewed allowlist (allowed: ${describeRefMap(expected)}; actual: ${describeRefMap(packedHeads)})`);
  }
  const where = mode === "create" ? "the creating repository" : "the repository state this packet recorded at creation";
  const held = new Map(repositoryRefs.map((row) => [row.ref, row.sha]));
  // Two different inputs, two different rules: the reviewed allowlist may not carry a tag the
  // release workflow has yet to create, and the repository may not already hold one.
  for (const ref of reservedCandidateTagRefs(targets)) {
    if (Object.hasOwn(expected, ref)) packetError(`protected release tag ${ref} is not transferable: the release workflow creates it after cutover`);
    if (held.has(ref)) packetError(`protected release tag ${ref} already exists in ${where}; this packet cannot claim a pre-cutover transfer`);
  }
  for (const [ref, sha] of Object.entries(expected)) {
    const actual = held.get(ref);
    if (actual !== undefined && actual !== sha) {
      packetError(`transfer evidence asserts ${ref}@${sha} but ${where} holds ${ref}@${actual}`);
    }
  }
  const boardHead = held.get(baseline.held_board_ref);
  if (boardHead !== undefined && Object.values(expected).includes(boardHead)) {
    packetError(`a transferable ref carries the held ${baseline.held_board_ref} head ${boardHead}`);
  }
}

async function collectEvidence(id, sourceFile, outDir, source) {
  const found = EVIDENCE.find(([name]) => name === id);
  if (!found) packetError(`unknown evidence category ${id}`);
  await regularFile(sourceFile, `evidence ${id}`);
  const [, destination] = found;
  const relative = `evidence/${destination}`;
  const bytes = await readFile(sourceFile);
  await mkdir(path.dirname(path.join(outDir, relative)), { recursive: true });
  await writeFile(path.join(outDir, relative), bytes, { flag: "wx" });
  const row = { category: id, schema: "opaque", path: relative, sha256: sha256Bytes(bytes), bytes: bytes.length };
  let parsed;
  if (id === "refs-baseline" || id === "refs-recheck" || id === "transfer-allowlist") {
    parsed = parseJsonBytes(bytes, `evidence ${id}`);
    validateRefAssertionsEnvelope(parsed, { publicAncestor: source.public_ancestor, privateCommit: source.commit, allowlist: id === "transfer-allowlist" });
    row.schema = parsed.schema;
  } else if (id === "planning-heads") {
    parsed = requireObject("planning heads", parseJsonBytes(bytes, "planning heads"));
    if (parsed.schema !== "superbee.planning-heads.v1") packetError("planning heads schema is not superbee.planning-heads.v1");
    for (const name of ["plan", "contract", "successor_coordinate_decision"]) requireString(`planning heads ${name}`, parsed[name], SHA256);
    row.schema = parsed.schema;
  } else if (id === "settings-baseline" || id === "settings-recheck") {
    parsed = parseSettingsEvidence(bytes, `evidence ${id}`);
    row.schema = parsed.schema;
  } else if (id === "transfer-bundle") {
    await transferBundleHeads(path.join(outDir, relative));
    row.schema = "git-bundle";
  }
  return { row, parsed };
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
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function sourceInputDigests(root = repoRoot) {
  const { paths } = await validatePacketInputManifest({ root, manifestPath: path.join(root, "release", "review-packet-inputs.json") });
  return Promise.all(paths.map(async (relative) => ({ path: relative, sha256: await fileSha256(resolveInput(root, relative)) }))).then((rows) => rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

function codePointOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseIndexRecord(record) {
  const tab = record.indexOf(0x09);
  if (tab === -1) packetError("git index record is missing its path separator");
  const header = record.subarray(0, tab).toString("ascii");
  const match = /^(100644|100755) ([0-9a-f]{40}) 0$/.exec(header);
  if (!match) packetError(`unsupported git index mode or stage: ${header}`);
  const pathBytes = record.subarray(tab + 1);
  const relative = pathBytes.toString("utf8");
  if (!Buffer.from(relative, "utf8").equals(pathBytes)) packetError("git index path is not valid UTF-8");
  literalPath("git index path", relative);
  return relative;
}

export async function trackedSourceFiles(root = repoRoot) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "buffer" }));
  } catch (error) {
    packetError(`cannot read git index: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const rows = [];
  let start = 0;
  for (let end = bytes.indexOf(0, start); end !== -1; end = bytes.indexOf(0, start)) {
    const relative = parseIndexRecord(bytes.subarray(start, end));
    const file = resolveInput(root, relative, "git index path");
    const info = await regularFile(file, `tracked source ${relative}`);
    rows.push({ path: relative, sha256: await fileSha256(file), bytes: info.size });
    start = end + 1;
  }
  if (start !== bytes.length) packetError("git index output is not NUL terminated");
  const sorted = [...rows].sort((a, b) => codePointOrder(a.path, b.path));
  if (sorted.length === 0 || new Set(rows.map((row) => row.path)).size !== rows.length) {
    packetError("git index paths must be non-empty and unique");
  }
  return sorted;
}

async function loadPacketTargets(root) {
  return loadReleaseTargets(path.join(root, "release", "targets.json"), {
    burnedFile: path.join(root, "release", "burned-versions.json"),
    cliPackageFile: path.join(root, "packages", "cli", "package.json"),
  });
}

async function loadBurnLedger(root) {
  const ledger = exactKeys(await readJson(path.join(root, "release", "burned-versions.json"), "burn ledger"), "burn ledger", ["schema", "semantics", "burned"]);
  if (!Array.isArray(ledger.burned)) packetError("burn ledger burned must be an array");
  for (const entry of ledger.burned) {
    exactKeys(entry, "burn ledger entry", ["version", "reason"]);
    requireString("burn ledger version", entry.version);
    requireString("burn ledger reason", entry.reason);
  }
  return ledger.burned;
}

function checksumLine(file) {
  return `${file.slice("sha256:".length)}  ${PACKET_FILE}\n`;
}

/**
 * Attribute every ignored path to the rule that ignores it. A path is acceptable only when a
 * TRACKED `.gitignore` declares it: that keeps the allowed-output set derived from reviewed,
 * digest-bound source instead of an enumerated prefix list, while still rejecting content hidden
 * behind `.git/info/exclude`, a global excludes file, or any other unreviewable local rule.
 */
async function attributeIgnoredPaths(root, relatives, trackedPaths) {
  const { error, stdout } = await new Promise((resolve) => {
    const child = execFile("git", ["check-ignore", "-v", "-z", "--stdin"], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
      (failure, out) => resolve({ error: failure, stdout: out }));
    // A git that exits before reading stdin would otherwise raise EPIPE as an unhandled error.
    child.stdin.on("error", () => {});
    child.stdin.end(`${relatives.join("\0")}\0`);
  });
  // Exit 1 means "no input path is ignored" and still carries a well-formed (empty) report.
  if (error && error.code !== 1) {
    packetError(`cannot attribute ignored checkout paths: ${error instanceof Error ? error.message : String(error)}`);
  }
  const attribution = new Map();
  const fields = stdout.split("\0");
  if (fields.pop() !== "" || fields.length % 4 !== 0) packetError("git check-ignore output is malformed");
  for (let index = 0; index < fields.length; index += 4) {
    attribution.set(fields[index + 3], { source: fields[index], line: fields[index + 1], pattern: fields[index + 2] });
  }
  const undeclared = [];
  for (const relative of relatives) {
    const matched = attribution.get(relative);
    if (!matched) { undeclared.push(`${relative} (no ignore rule)`); continue; }
    const source = matched.source;
    if (path.posix.isAbsolute(source) || path.isAbsolute(source) || path.posix.basename(source) !== GITIGNORE || !trackedPaths.has(source)) {
      undeclared.push(`${relative} (${source}:${matched.line})`);
    }
  }
  if (undeclared.length > 0) {
    packetError(`checkout has ignored paths no tracked ${GITIGNORE} declares: ${undeclared.sort().join(", ")}`);
  }
}

export async function observedCheckout(root) {
  let head;
  let status;
  try {
    [head, status] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
      execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], { cwd: root }),
    ]);
  } catch (error) {
    packetError(`cannot inspect verification checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
  const records = status.stdout.split("\0").filter(Boolean);
  const nonIgnored = [];
  const ignored = [];
  for (const record of records) {
    if (record.startsWith("!! ")) ignored.push(record.slice(3));
    else nonIgnored.push(record);
  }
  if (nonIgnored.length > 0) packetError(`checkout has non-ignored changes: ${nonIgnored.sort().join(", ")}`);
  if (ignored.length > 0) await attributeIgnoredPaths(root, ignored, await trackedPathSet(root));
  return { commit: head.stdout.trim(), dirty: false };
}

async function assertDetachedCheckout(root) {
  try {
    await execFileAsync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: root });
  } catch (error) {
    if (error?.code === 1) return;
    packetError(`cannot determine checkout attachment: ${error instanceof Error ? error.message : String(error)}`);
  }
  packetError("packet source checkout must be detached");
}

export async function createReleasePacket({ commit, publicAncestor, out, candidates, evidence, observedSource, root = repoRoot, retainedVerifier = verifyRetainedTarball, onEvidenceCaptured }) {
  await assertExecutionRoot(root, "create");
  const targets = await loadPacketTargets(root);
  const candidateIds = Object.keys(targets.allowed_tuples);
  if (!candidates || Object.keys(candidates).length !== candidateIds.length || candidateIds.some((id) => !candidates[id])) {
    packetError("create requires exactly the named candidate slots from release targets");
  }
  if (!evidence || Object.keys(evidence).length !== EVIDENCE.length || EVIDENCE.some(([id]) => !evidence[id])) {
    packetError("create requires every fixed evidence slot exactly once");
  }
  const source = await sourceFacts(commit, publicAncestor, observedSource, root);
  const outDir = await preparePacketOutputDir(out, root);
  const staged = await stagePacketOutput(outDir);
  try {
    const candidateRows = {};
    for (const id of candidateIds) {
      candidateRows[id] = await collectCandidate(id, candidates[id], staged, source, { targets, root, retainedVerifier });
    }
    const evidenceRows = [];
    const capturedEvidence = {};
    for (const [id] of EVIDENCE) {
      const captured = await collectEvidence(id, evidence[id], staged, source);
      evidenceRows.push(captured.row);
      capturedEvidence[id] = captured.parsed;
      await onEvidenceCaptured?.(id);
    }
    const repositoryRefs = await enumerateRepositoryRefs(root);
    await validateTransferAuthority({
      baseline: capturedEvidence["refs-baseline"],
      recheck: capturedEvidence["refs-recheck"],
      allowlist: capturedEvidence["transfer-allowlist"],
      bundleFile: path.join(staged, "evidence", "transfer-bundle"),
      source, targets, repositoryRefs,
      mode: "create",
    });
    validateSettingsAuthority({
      baseline: capturedEvidence["settings-baseline"],
      recheck: capturedEvidence["settings-recheck"],
    });
    const packet = {
      schema: REVIEW_PACKET_SCHEMA,
      source,
      lifecycle: packetLifecycle(targets, capturedEvidence["refs-baseline"], repositoryRefs),
      generator: {
        entrypoint: "scripts/release-packet.mjs",
        entrypoint_sha256: await fileSha256(path.join(root, "scripts", "release-packet.mjs")),
        input_manifest_sha256: await fileSha256(path.join(root, "release", "review-packet-inputs.json")),
        source_inputs: await sourceInputDigests(root),
      },
      source_files: await trackedSourceFiles(root),
      tuples: Object.fromEntries(candidateIds.map((id) => [id, targets.allowed_tuples[id]])),
      burns: await loadBurnLedger(root),
      candidates: candidateRows,
      external_evidence: evidenceRows,
      inventory: await inventory(staged),
    };
    await writeFile(path.join(staged, PACKET_FILE), canonicalJson(packet));
    await writeFile(path.join(staged, DIGEST_FILE), checksumLine(await fileSha256(path.join(staged, PACKET_FILE))));
    await installPacketOutput(staged, outDir);
    return { outDir, packet };
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyReleasePacket({ packet: packetFile, root = repoRoot, retainedVerifier = verifyRetainedTarball, observedSource }) {
  await assertExecutionRoot(root, "verify");
  const packetPath = path.resolve(packetFile);
  const outDir = path.dirname(packetPath);
  if (path.basename(packetPath) !== PACKET_FILE) packetError(`packet path must end in ${PACKET_FILE}`);
  const text = await readFile(packetPath, "utf8");
  const packet = exactKeys(await readJson(packetPath, "packet"), "packet", ["schema", "source", "lifecycle", "generator", "source_files", "tuples", "burns", "candidates", "external_evidence", "inventory"]);
  if (packet.schema !== REVIEW_PACKET_SCHEMA || canonicalJson(packet) !== text) packetError("packet is not canonical release-packet JSON");
  const digest = await readFile(path.join(outDir, DIGEST_FILE), "utf8");
  if (digest !== checksumLine(await fileSha256(packetPath))) packetError("detached packet digest mismatch");
  const source = exactKeys(packet.source, "packet source", ["commit", "tree", "public_ancestor", "public_is_ancestor", "dirty"]);
  requireString("packet R", source.commit, COMMIT);
  requireString("packet P", source.public_ancestor, COMMIT);
  if (source.public_is_ancestor !== true || source.dirty !== false) packetError("packet source facts are incomplete");
  const checkout = observedSource ?? await observedCheckout(root);
  if (!observedSource) await assertDetachedCheckout(root);
  if (checkout.commit !== source.commit || checkout.dirty !== false) packetError("packet source does not match a clean verification checkout");
  const observedTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  if (source.tree !== observedTree) packetError("packet source tree differs from checkout");
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", source.public_ancestor, source.commit], { cwd: root });
  } catch {
    packetError("packet public ancestor is not an ancestor of packet R");
  }
  const generator = exactKeys(packet.generator, "packet generator", ["entrypoint", "entrypoint_sha256", "input_manifest_sha256", "source_inputs"]);
  if (generator.entrypoint !== "scripts/release-packet.mjs") packetError("packet generator entrypoint mismatch");
  const expectedInputs = await sourceInputDigests(root);
  if (JSON.stringify(packet.generator?.source_inputs) !== JSON.stringify(expectedInputs)) packetError("packet source input digests differ from checkout");
  if (generator.entrypoint_sha256 !== await fileSha256(path.join(root, "scripts", "release-packet.mjs"))) packetError("packet generator digest differs from checkout");
  if (generator.input_manifest_sha256 !== await fileSha256(path.join(root, "release", "review-packet-inputs.json"))) packetError("packet input manifest digest differs from checkout");
  if (!Array.isArray(packet.source_files)) packetError("packet source files must be an array");
  for (const row of packet.source_files) {
    exactKeys(row, "packet source file", ["path", "sha256", "bytes"]);
    literalPath("packet source file path", row.path);
    requireString("packet source file digest", row.sha256, SHA256);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) packetError("packet source file bytes must be a non-negative integer");
  }
  if (JSON.stringify(packet.source_files) !== JSON.stringify(await trackedSourceFiles(root))) packetError("packet source files differ from checkout");
  const actualInventory = await inventory(outDir);
  if (!Array.isArray(packet.inventory)) packetError("packet inventory must be an array");
  for (const row of packet.inventory) {
    exactKeys(row, "packet inventory row", ["path", "sha256", "bytes"]);
    literalPath("packet inventory path", row.path);
    requireString("packet inventory digest", row.sha256, SHA256);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) packetError("packet inventory bytes must be a non-negative integer");
  }
  if (JSON.stringify(packet.inventory) !== JSON.stringify(actualInventory)) packetError("packet inventory differs from retained files");
  const paths = new Set(packet.inventory.map((row) => row.path));
  if (paths.has(PACKET_FILE) || paths.has(DIGEST_FILE)) packetError("packet must not inventory itself or its detached digest");
  const targets = await loadPacketTargets(root);
  const candidateIds = Object.keys(targets.allowed_tuples);
  if (!packet.candidates || JSON.stringify(Object.keys(packet.candidates).sort()) !== JSON.stringify([...candidateIds].sort())) packetError("packet candidate slots differ from release targets");
  const expectedTuples = Object.fromEntries(candidateIds.map((id) => [id, targets.allowed_tuples[id]]));
  if (JSON.stringify(packet.tuples) !== JSON.stringify(expectedTuples)) packetError("packet tuple authority differs from release targets");
  for (const id of candidateIds) {
    const row = packet.candidates[id];
    exactKeys(row, `packet candidate ${id}`, ["slot", "target", "package", "version", "tag", "manifest", "tarball"]);
    if (row.slot !== id || row.target !== id) packetError(`packet candidate ${id} slot mismatch`);
    if (row?.manifest !== `candidates/${id}/candidate.json`) packetError(`packet candidate ${id} manifest path mismatch`);
    const candidatePath = path.join(outDir, row?.manifest ?? "");
    const candidate = requireObject(`packet candidate ${id}`, await readJson(candidatePath, `packet candidate ${id}`));
    const tarballPath = path.join(outDir, row?.tarball ?? "");
    await regularFile(tarballPath, `packet candidate ${id} tarball`);
    if (candidate.schema !== RELEASE_CANDIDATE_SCHEMA || candidate.target !== id || candidate.source?.commit !== source.commit || candidate.source?.dirty !== false) packetError(`packet candidate ${id} source/schema mismatch`);
    const target = targets.targets[id];
    if (!target || candidate.package?.name !== target.package.name || candidate.version !== packet.tuples?.[id]?.version || candidate.tag !== packet.tuples?.[id]?.tag) packetError(`packet candidate ${id} tuple mismatch`);
    if (row.package !== candidate.package.name || row.version !== candidate.version || row.tag !== candidate.tag) packetError(`packet candidate ${id} summary mismatch`);
    const tuple = assertAllowedTuple(targets, { target: id, packageName: candidate.package.name, version: candidate.version, tag: candidate.tag });
    if (row.tarball !== `candidates/${id}/${tarballFilename(target, candidate.version)}`) packetError(`packet candidate ${id} tarball path mismatch`);
    if (candidate.tarball?.filename !== path.basename(tarballPath) || candidate.tarball.sha256 !== await fileSha256(tarballPath)) packetError(`packet candidate ${id} tarball mismatch`);
    try {
      const receipt = await retainedVerifier({ tarball: tarballPath, manifest: candidatePath, targetsPath: path.join(root, "release", "targets.json") });
      assertRetainedVerifierReceipt(`packet candidate ${id}`, receipt, tuple);
    } catch (error) {
      packetError(`packet candidate ${id} retained-tarball proof failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!Array.isArray(packet.external_evidence) || packet.external_evidence.length !== EVIDENCE.length) packetError("packet evidence slots are incomplete");
  const retainedEvidence = {};
  for (const [index, [id, destination]] of EVIDENCE.entries()) {
    const row = exactKeys(packet.external_evidence[index], `packet evidence ${id}`, ["category", "schema", "path", "sha256", "bytes"]);
    if (row.category !== id) packetError("packet evidence categories are not exact");
    if (row.path !== `evidence/${destination}`) packetError(`packet evidence ${id} path mismatch`);
    if (row.schema !== EVIDENCE_SCHEMAS[id]) packetError(`packet evidence ${id} schema mismatch`);
    const file = path.join(outDir, row.path);
    await regularFile(file, `packet evidence ${id}`);
    const bytes = await readFile(file);
    if (row.sha256 !== sha256Bytes(bytes) || row.bytes !== bytes.length) packetError(`packet evidence ${id} digest mismatch`);
    if (id === "refs-baseline" || id === "refs-recheck" || id === "transfer-allowlist") {
      const parsed = parseJsonBytes(bytes, `packet evidence ${id}`);
      validateRefAssertionsEnvelope(parsed, { publicAncestor: source.public_ancestor, privateCommit: source.commit, allowlist: id === "transfer-allowlist" });
      if (row.schema !== parsed.schema) packetError(`packet evidence ${id} schema mismatch`);
      retainedEvidence[id] = parsed;
    } else if (id === "settings-baseline" || id === "settings-recheck") {
      retainedEvidence[id] = parseSettingsEvidence(bytes, `packet evidence ${id}`);
    } else if (id === "transfer-bundle") {
      await transferBundleHeads(file);
    }
  }
  const lifecycle = validatePacketLifecycle(packet.lifecycle, targets, requireObject("packet refs baseline", retainedEvidence["refs-baseline"]));
  await validateTransferAuthority({
    baseline: retainedEvidence["refs-baseline"],
    recheck: retainedEvidence["refs-recheck"],
    allowlist: retainedEvidence["transfer-allowlist"],
    bundleFile: path.join(outDir, "evidence", "transfer-bundle"),
    source, targets,
    repositoryRefs: lifecycle.creation_repository_refs,
    mode: "verify",
  });
  validateSettingsAuthority({
    baseline: retainedEvidence["settings-baseline"],
    recheck: retainedEvidence["settings-recheck"],
  });
  if (JSON.stringify(packet.burns) !== JSON.stringify(await loadBurnLedger(root))) packetError("packet burn ledger mismatch");
  return packet;
}

export function parsePacketArgs(argv) {
  const [command, ...rest] = argv;
  const nextValue = (index, flag) => {
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing ${flag}`);
    return value;
  };
  if (command === "create") {
    const parsed = { command, candidates: {}, evidence: {} };
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index];
      switch (flag) {
        case "--commit":
          parsed.commit = nextValue(index, flag);
          index += 1;
          break;
        case "--public-ancestor":
          parsed.publicAncestor = nextValue(index, flag);
          index += 1;
          break;
        case "--out":
          parsed.out = nextValue(index, flag);
          index += 1;
          break;
        case "--root":
          parsed.root = path.resolve(nextValue(index, flag));
          index += 1;
          break;
        case "--candidate":
        case "--evidence": {
          const value = nextValue(index, flag);
          if (!value.includes("=")) throw new Error(`missing ${flag} name=path`);
          const [name, ...parts] = value.split("=");
          const target = flag === "--candidate" ? parsed.candidates : parsed.evidence;
          const allowed = flag === "--evidence" ? EVIDENCE.map(([id]) => id) : undefined;
          if (!name || parts.length === 0 || !parts.join("=") || target[name] || (allowed && !allowed.includes(name))) {
            throw new Error(`invalid ${flag} ${value}`);
          }
          target[name] = parts.join("=");
          index += 1;
          break;
        }
        default:
          throw new Error(`unknown argument ${JSON.stringify(flag)}`);
      }
    }
    if (!parsed.commit || !parsed.publicAncestor || !parsed.out) throw new Error("usage: npm run release:packet -- create --commit <sha> --public-ancestor <sha> --out <dir> [--candidate name=path]... [--evidence name=path]... [--root <dir>]");
    return parsed;
  }
  if (command === "verify") {
    const parsed = { command };
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index];
      if (flag === "--packet") {
        parsed.packet = nextValue(index, flag);
        index += 1;
        continue;
      }
      if (flag === "--root") {
        parsed.root = path.resolve(nextValue(index, flag));
        index += 1;
        continue;
      }
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
    if (!parsed.packet) throw new Error("missing --packet");
    return parsed;
  }
  throw new Error("usage: npm run release:packet -- create|verify ...");
}

async function runBoundToRoot(args, argv) {
  if (!args.root) return false;
  const [requested, executing] = await Promise.all([canonicalPath(args.root), canonicalPath(repoRoot)]);
  if (requested === executing) return false;
  const targetScript = path.join(args.root, "scripts", "release-packet.mjs");
  await regularFile(targetScript, `--root packet script ${targetScript}`);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [targetScript, ...argv], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error) {
    if (typeof error?.stdout === "string" && error.stdout) process.stdout.write(error.stdout);
    if (typeof error?.stderr === "string" && error.stderr) process.stderr.write(error.stderr);
    process.exitCode = Number.isInteger(error?.code) ? error.code : 1;
  }
  return true;
}

if (isMainModule(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const args = parsePacketArgs(argv);
    if (await runBoundToRoot(args, argv)) process.exitCode ??= 0;
    else if (args.command === "create") {
      const { outDir, packet } = await createReleasePacket(args);
      console.log(`release packet created: ${outDir}`);
      console.log(`proven: ${packet.lifecycle.claim}`);
    } else {
      const packet = await verifyReleasePacket(args);
      console.log(`release packet verified: ${args.packet}`);
      console.log(`proven: ${packet.lifecycle.claim}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
