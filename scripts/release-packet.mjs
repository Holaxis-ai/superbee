// Generic, offline release-review packet authority. Provider state enters only as retained bytes
// plus the deliberately small normalized ref assertions checked below.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

import { isMainModule } from "./is-main-module.mjs";
import { fileSha256, verifyRetainedTarball } from "./verify-npm-package.mjs";
import { RELEASE_CANDIDATE_SCHEMA, assertAllowedTuple, loadReleaseTargets, tarballFilename } from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(scriptPath), "..");
export const REVIEW_PACKET_SCHEMA = "superbee.release-packet.v1";
export const REVIEW_PACKET_INPUTS_SCHEMA = "superbee.review-packet-inputs.v1";
export const REF_ASSERTIONS_SCHEMA = "superbee.ref-assertions.v1";
export const TRANSFER_ALLOWLIST_SCHEMA = "superbee.transfer-allowlist.v1";
const PACKET_FILE = "release-packet.json";
const DIGEST_FILE = "release-packet.sha256";
const SOURCE_ENTRYPOINTS = ["scripts/release-packet.mjs", "scripts/release-candidate.mjs", "scripts/release-verify-chain.mjs"];
const RELEASE_WORKFLOWS = [
  ".github/workflows/release-staged.yml",
  ".github/workflows/release-finalize.yml",
  ".github/workflows/release-audit.yml",
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
  "settings-baseline": "opaque",
  "settings-recheck": "opaque",
  "transfer-bundle": "opaque",
  "transfer-allowlist": TRANSFER_ALLOWLIST_SCHEMA,
  "cutover-script": "opaque",
});
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._/-]+$/;
const REF = /^refs\/(?:heads|tags|notes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const NORMAL_IGNORED_OUTPUT_PREFIXES = Object.freeze([
  "node_modules/",
  "packages/board-git/dist/",
  "packages/cli/dist/",
  "packages/cli/src/generated/",
  "packages/core/dist/",
  "packages/markdown-renderer/dist/",
  "packages/mcp-app/dist/",
  "packages/mcp-app/src/generated/",
  "packages/server/dist/",
  "packages/ui-server/dist/",
  "packages/ui/dist/",
  "packages/ui/node_modules/",
  "packages/view-runtime/dist/",
  "release-candidate/",
]);

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

async function workflowReleaseEntrypoints(root) {
  const direct = new Set();
  const packageScripts = new Set();
  for (const relative of RELEASE_WORKFLOWS) {
    const text = await readFile(resolveInput(root, relative), "utf8");
    for (const match of text.matchAll(/\bnode\s+(scripts\/[A-Za-z0-9_-]+\.mjs)\b/g)) direct.add(match[1]);
    for (const match of text.matchAll(/\bnpm\s+run\s+(release:[A-Za-z0-9:_-]+)\b/g)) packageScripts.add(match[1]);
  }
  if (packageScripts.size > 0) {
    const packageJson = requireObject("root package.json", await readJson(resolveInput(root, "package.json"), "root package.json"));
    const scripts = requireObject("root package scripts", packageJson.scripts);
    for (const name of packageScripts) {
      const command = scripts[name];
      const matched = typeof command === "string" ? /^node\s+(scripts\/[A-Za-z0-9_-]+\.mjs)$/.exec(command) : null;
      if (!matched) packetError(`workflow package script ${name} must be one literal node scripts/*.mjs command`);
      direct.add(matched[1]);
    }
  }
  return [...direct].sort();
}

export async function validatePacketInputManifest({ root = repoRoot, manifestPath = path.join(repoRoot, "release", "review-packet-inputs.json") } = {}) {
  const manifest = requireObject("packet input manifest", await readJson(manifestPath, "packet input manifest"));
  if (manifest.schema !== REVIEW_PACKET_INPUTS_SCHEMA) packetError(`packet input manifest schema is not ${REVIEW_PACKET_INPUTS_SCHEMA}`);
  const paths = uniqueSorted(manifest.paths, "packet input manifest paths");
  for (const relative of paths) {
    resolveInput(root, literalPath("packet input manifest path", relative));
  }
  const workflowEntries = await workflowReleaseEntrypoints(root);
  const closure = await staticPacketClosure({ root, entries: [...SOURCE_ENTRYPOINTS, ...workflowEntries] });
  const explicit = [
    "release/review-packet-inputs.json", "release/targets.json", "release/burned-versions.json",
    ...RELEASE_WORKFLOWS, ".github/release-allowed-signers",
    "package.json", "package-lock.json", "packages/cli/package.json", "packages/cli/SKILL.md",
  ];
  const expected = [...new Set([...closure, ...explicit])].sort();
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    const missing = expected.filter((item) => !paths.includes(item));
    const extra = paths.filter((item) => !expected.includes(item));
    packetError(`packet input manifest closure differs (missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"})`);
  }
  return { paths, closure, explicit, workflowEntries };
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

function refSet(label, value) {
  const refs = uniqueSorted(value, label);
  for (const ref of refs) {
    requireString(label, ref, REF);
    if (ref.includes("//") || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".")) {
      packetError(`invalid ${label}: ${JSON.stringify(ref)}`);
    }
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

function reservedCandidateTagRefs(targets) {
  return new Set(Object.values(targets.allowed_tuples).map((tuple) => `refs/tags/${tuple.tag}`));
}

function validateTransferAuthority({ baseline, recheck, allowlist, source, targets }) {
  for (const [label, value, isAllowlist] of [["refs baseline", baseline, false], ["refs recheck", recheck, false], ["transfer allowlist", allowlist, true]]) {
    validateRefAssertionsEnvelope(value, { publicAncestor: source.public_ancestor, privateCommit: source.commit, allowlist: isAllowlist });
  }
  const expected = baseline.allowed_refs;
  if (JSON.stringify(recheck.allowed_refs) !== JSON.stringify(expected) || JSON.stringify(allowlist.allowed_refs) !== JSON.stringify(expected)) {
    packetError("transfer baseline/recheck/allowlist allowed refs differ");
  }
  for (const ref of reservedCandidateTagRefs(targets)) {
    if (expected.includes(ref)) packetError(`pre-cutover packet cannot be created or verified after candidate tag exists: ${ref}`);
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

export async function observedCheckout(root) {
  let head;
  let status;
  try {
    [head, status] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
      execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], { cwd: root }),
    ]);
  } catch (error) {
    packetError(`cannot inspect verification checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
  const records = status.stdout.split("\n").filter(Boolean);
  const nonIgnored = [];
  const disallowedIgnored = [];
  const invalidAllowedRoots = new Set();
  for (const record of records) {
    if (!record.startsWith("!! ")) { nonIgnored.push(record); continue; }
    const relative = record.slice(3);
    const prefix = NORMAL_IGNORED_OUTPUT_PREFIXES.find((candidate) => relative === candidate || relative.startsWith(candidate));
    if (!prefix) { disallowedIgnored.push(relative); continue; }
    const info = await lstat(path.join(root, prefix)).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) invalidAllowedRoots.add(prefix);
  }
  if (nonIgnored.length > 0) packetError(`checkout has non-ignored changes: ${nonIgnored.sort().join(", ")}`);
  if (disallowedIgnored.length > 0) {
    packetError(`checkout has disallowed ignored paths: ${disallowedIgnored.sort().join(", ")}; allowed generated-output prefixes: ${NORMAL_IGNORED_OUTPUT_PREFIXES.join(", ")}`);
  }
  if (invalidAllowedRoots.size > 0) packetError(`allowed generated-output root is not a real directory: ${[...invalidAllowedRoots].sort().join(", ")}`);
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
    validateTransferAuthority({
      baseline: capturedEvidence["refs-baseline"],
      recheck: capturedEvidence["refs-recheck"],
      allowlist: capturedEvidence["transfer-allowlist"],
      source, targets,
    });
    const packet = {
      schema: REVIEW_PACKET_SCHEMA,
      source,
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
  const packetPath = path.resolve(packetFile);
  const outDir = path.dirname(packetPath);
  if (path.basename(packetPath) !== PACKET_FILE) packetError(`packet path must end in ${PACKET_FILE}`);
  const text = await readFile(packetPath, "utf8");
  const packet = exactKeys(await readJson(packetPath, "packet"), "packet", ["schema", "source", "generator", "source_files", "tuples", "burns", "candidates", "external_evidence", "inventory"]);
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
    }
  }
  validateTransferAuthority({
    baseline: retainedEvidence["refs-baseline"],
    recheck: retainedEvidence["refs-recheck"],
    allowlist: retainedEvidence["transfer-allowlist"],
    source, targets,
  });
  if (JSON.stringify(packet.burns) !== JSON.stringify(await loadBurnLedger(root))) packetError("packet burn ledger mismatch");
  return packet;
}

function parsePairs(argv, flag, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || !value.includes("=")) throw new Error(`missing ${flag} name=path`);
    const [name, ...parts] = value.split("=");
    if ((allowed && !allowed.includes(name)) || values[name] || parts.length === 0 || !parts.join("=")) throw new Error(`invalid ${flag} ${value}`);
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

function optionalOption(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${flag}`);
  return path.resolve(value);
}

export function parsePacketArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "create") return {
    command, commit: option(rest, "--commit"), publicAncestor: option(rest, "--public-ancestor"), out: option(rest, "--out"),
    candidates: parsePairs(rest, "--candidate"), evidence: parsePairs(rest, "--evidence", EVIDENCE.map(([id]) => id)), root: optionalOption(rest, "--root"),
  };
  if (command === "verify") return { command, packet: option(rest, "--packet"), root: optionalOption(rest, "--root") };
  throw new Error("usage: npm run release:packet -- create|verify ...");
}

if (isMainModule(import.meta.url)) {
  try {
    const args = parsePacketArgs(process.argv.slice(2));
    const result = args.command === "create" ? await createReleasePacket(args) : await verifyReleasePacket(args);
    console.log(args.command === "create" ? `release packet created: ${result.outDir}` : `release packet verified: ${args.packet}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
