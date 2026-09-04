import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const release = read(".github/workflows/release-libraries.yml");
const finalize = read(".github/workflows/release-libraries-finalize.yml");
const cliRelease = read(".github/workflows/release.yml");
const verifier = read("scripts/verify-runtime-libraries.mjs");

function jobs(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1);
  const found = {};
  let current;
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      current = match[1];
      found[current] = [];
    } else if (current) {
      found[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(found).map(([name, linesForJob]) => [name, linesForJob.join("\n")]));
}

function runBody(text, stepName) {
  const start = text.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `${stepName} must exist`);
  const run = text.indexOf("run: |", start);
  assert.notEqual(run, -1, `${stepName} must have a run block`);
  const body = [];
  for (const line of text.slice(text.indexOf("\n", run) + 1).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runSourceGuard({ currentVersion, priorTag, mainMatches = true, depth = "full" }) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "runtime-library-source-guard-"));
  const source = path.join(fixture, "source");
  const remote = path.join(fixture, "remote.git");
  const checkout = path.join(fixture, "checkout");
  mkdirSync(source);
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  git(source, ["config", "user.email", "proof@example.test"]);
  git(source, ["config", "user.name", "proof"]);
  writeFileSync(path.join(source, "prior"), "prior\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "prior"]);
  const priorSha = git(source, ["rev-parse", "HEAD"]);
  if (priorTag) git(source, ["tag", priorTag]);
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  mkdirSync(path.join(source, "packages", "core"), { recursive: true });
  mkdirSync(path.join(source, "packages", "server"), { recursive: true });
  writeFileSync(path.join(source, "scripts", "strict-semver.mjs"), read("scripts/strict-semver.mjs"));
  const manifest = `${JSON.stringify({ version: currentVersion }, null, 2)}\n`;
  writeFileSync(path.join(source, "packages", "core", "package.json"), manifest);
  writeFileSync(path.join(source, "packages", "server", "package.json"), manifest);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "current"]);
  const currentSha = git(source, ["rev-parse", "HEAD"]);
  git(source, ["tag", `libraries/v${currentVersion}`]);
  git(fixture, ["clone", "--quiet", "--bare", source, remote]);
  const cloneArgs = ["clone", "--quiet"];
  if (depth === "shallow") cloneArgs.push("--depth=1", "--branch", `libraries/v${currentVersion}`);
  cloneArgs.push(pathToFileURL(remote).href, checkout);
  git(fixture, cloneArgs);
  const step = path.join(checkout, "source-step.sh");
  const output = path.join(checkout, "output");
  writeFileSync(step, runBody(release, "Resolve the synchronized version from the libraries tag"));
  const wrapper = [
    'gh() { printf "%s\\n" "$MAIN_SHA"; }',
    'source "$SOURCE_STEP"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", wrapper], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "example/repository",
      GITHUB_SHA: currentSha,
      GITHUB_REF_NAME: `libraries/v${currentVersion}`,
      GITHUB_OUTPUT: output,
      MAIN_SHA: mainMatches ? currentSha : priorSha,
      SOURCE_STEP: step,
    },
  });
  rmSync(fixture, { recursive: true, force: true });
  return result;
}

test("core and server form one restricted exact-version release set", () => {
  const core = JSON.parse(read("packages/core/package.json"));
  const server = JSON.parse(read("packages/server/package.json"));
  assert.match(core.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(server.version, core.version);
  assert.equal(server.dependencies["@superbee/core"], core.version);
  for (const manifest of [core, server]) {
    assert.equal(manifest.private, undefined);
    assert.deepEqual(manifest.publishConfig, {
      access: "restricted",
      registry: "https://registry.npmjs.org/",
    });
    assert.match(manifest.scripts.prepublishOnly, /process\.exit\(1\)/);
    assert.doesNotMatch(manifest.scripts.prepublishOnly, /\.\.\/|scripts\//);
  }
});

test("runtime library workflows pin actions and share an isolated release identity", () => {
  for (const [name, workflow] of [["release", release], ["finalize", finalize]]) {
    assert.match(workflow, /^permissions: \{\}$/m, `${name} begins with no ambient permissions`);
    assert.match(workflow, /^concurrency:\n {2}group: runtime-libraries-release\n {2}cancel-in-progress: false$/m);
    assert.doesNotMatch(workflow, /continue-on-error/);
    for (const action of workflow.matchAll(/^\s+- uses: (.+)$/gm)) {
      assert.match(action[1], /@[0-9a-f]{40} # v\d/);
    }
  }
  assert.match(release, /tags: \["libraries\/v\*"\]/);
  assert.doesNotMatch(release, /gh release (?:create|upload)|release assets?/i);
  assert.doesNotMatch(finalize, /gh release|npm stage|npm publish|id-token: write|contents: write/);
  assert.equal((finalize.match(/secrets\.NPM_RUNTIME_LIBRARIES_READ_TOKEN/g) ?? []).length, 2);
  assert.doesNotMatch(release, /secrets\.|NODE_AUTH_TOKEN/, "payload build and OIDC staging need no long-lived npm credential");
  const entrypoint = read("CLAUDE.md");
  const contributing = read("CONTRIBUTING.md");
  assert.match(entrypoint, /release-libraries\.yml/);
  assert.match(entrypoint, /libraries\/v<version>/);
  assert.match(contributing, /verify:runtime-libraries` consumes the fixed `out\/superbee-core\.tgz`/);
  assert.match(contributing, /NPM_RUNTIME_LIBRARIES_READ_TOKEN/);
});

test("payload code builds once before a literal two-tarball verification", () => {
  const { build, attest, stage_core: core, stage_server: server } = jobs(release);
  assert.ok(build && attest && core && server);
  assert.match(build, /^ {4}permissions:\n {6}contents: read\n {6}checks: read$/m);
  assert.match(build, /actions\/checkout@[0-9a-f]{40} # v7\.0\.1\n {8}with:\n {10}fetch-depth: 0/);
  assert.doesNotMatch(build, /id-token: write|environment: release|secrets\./);
  assert.equal((build.match(/npm run build -w @superbee\/core -w @superbee\/server/g) ?? []).length, 1);
  assert.equal((build.match(/npm pack -w @superbee\/core/g) ?? []).length, 1);
  assert.equal((build.match(/npm pack -w @superbee\/server/g) ?? []).length, 1);
  assert.match(build, /mv -- "out\/\$CORE_PACKED" out\/superbee-core\.tgz/);
  assert.match(build, /mv -- "out\/\$SERVER_PACKED" out\/superbee-server\.tgz/);
  assert.match(build, /npm run verify:runtime-libraries/);
  assert.doesNotMatch(attest + core + server, /actions\/checkout|npm ci|npm run build|npm pack -w/);
  assert.equal((attest.match(/actions\/attest-build-provenance/g) ?? []).length, 2);
});

test("release source and first-version boundaries fail closed", () => {
  const { build, attest, stage_core: core, stage_server: server } = jobs(release);
  assert.match(build, /git\/ref\/heads\/main/);
  assert.match(build, /test "\$GITHUB_SHA" = "\$MAIN_SHA"/);
  assert.match(build, /git fetch --force --no-tags origin '\+refs\/tags\/libraries\/v\*:refs\/tags\/libraries\/v\*'/);
  assert.match(build, /git tag --merged "\$GITHUB_SHA" --list 'libraries\/v\*'/);
  assert.match(build, /compareStrictSemver\(current, prior\)/);
  assert.match(build, /check-runs\?check_name=CI%20required%20lanes&filter=latest&per_page=100/);
  assert.match(build, /select\(\.app\.slug == "github-actions"\)/);
  assert.match(build, /test "\$VERDICT" = "success" \|\| \{[^\n]*exit 1; \}/);
  assert.equal(
    runBody(release, "Require the CI verdict already recorded on this exact commit"),
    runBody(cliRelease, "Require the CI verdict already recorded on this exact commit"),
    "the runtime-library release inherits the empirically tested CLI verdict gate verbatim",
  );
  assert.match(build, /if \[ "\$V" = "0\.1\.0" \]; then BOOTSTRAP=true/);
  assert.match(core, /if: needs\.build\.outputs\.bootstrap != 'true'/);
  assert.match(server, /needs\.build\.outputs\.bootstrap != 'true'/);
  assert.match(attest, /npm publish \\\"\.\/\$CORE_TGZ\\\" --access restricted --tag \\\"\$DIST_TAG\\\" --ignore-scripts/);
  assert.match(attest, /npm publish \\\"\.\/\$SERVER_TGZ\\\" --access restricted --tag \\\"\$DIST_TAG\\\" --ignore-scripts/);
});

test("the exact source guard allows only current-main channel advancement", () => {
  const advance = runSourceGuard({ currentVersion: "0.1.1", priorTag: "libraries/v0.1.0" });
  assert.equal(advance.status, 0, advance.stderr + advance.stdout);

  const oldMain = runSourceGuard({ currentVersion: "0.1.1", priorTag: "libraries/v0.1.0", mainMatches: false });
  assert.notEqual(oldMain.status, 0);
  assert.match(oldMain.stderr + oldMain.stdout, /must be tagged from current main/);

  const latestRegression = runSourceGuard({ currentVersion: "0.1.0", priorTag: "libraries/v0.1.1" });
  assert.notEqual(latestRegression.status, 0);
  assert.match(latestRegression.stderr + latestRegression.stdout, /would not advance latest/);

  const nextRegression = runSourceGuard({ currentVersion: "0.2.0-pre.1", priorTag: "libraries/v0.2.0-pre.2" });
  assert.notEqual(nextRegression.status, 0);
  assert.match(nextRegression.stderr + nextRegression.stdout, /would not advance next/);

  const otherChannel = runSourceGuard({ currentVersion: "0.2.0-pre.1", priorTag: "libraries/v9.0.0" });
  assert.equal(otherChannel.status, 0, otherChannel.stderr + otherChannel.stdout);

  const buildMetadataHyphen = runSourceGuard({ currentVersion: "0.2.0+build-hyphen", priorTag: "libraries/v0.1.9" });
  assert.equal(buildMetadataHyphen.status, 0, buildMetadataHyphen.stderr + buildMetadataHyphen.stdout);

  const malformed = runSourceGuard({ currentVersion: "0.1.1", priorTag: "libraries/vnot-semver" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr + malformed.stdout, /protected release tag .* invalid version/);
});

test("full ancestry is load-bearing because a depth-1 tag-only fetch hides the prior release", () => {
  // This recreates actions/checkout's default depth=1 at the current release tag. The workflow's
  // own tag-ref fetch obtains the prior tag object, but the shallow boundary still prevents Git
  // from recognizing that prior commit as merged. That old topology therefore accepts a regression.
  const shallow = runSourceGuard({
    currentVersion: "0.1.0",
    priorTag: "libraries/v0.1.1",
    depth: "shallow",
  });
  assert.equal(shallow.status, 0, `depth-1 mutant unexpectedly saw the hidden prior tag: ${shallow.stderr}`);

  // `fetch-depth: 0` restores the current-main ancestry before the exact same committed step runs,
  // so the reachable prior release is visible and the regression is refused.
  const restored = runSourceGuard({ currentVersion: "0.1.0", priorTag: "libraries/v0.1.1" });
  assert.notEqual(restored.status, 0);
  assert.match(restored.stderr + restored.stdout, /would not advance latest/);
});

test("the bootstrap instructions override an ambient npm tag", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runtime-library-bootstrap-"));
  const step = path.join(dir, "bootstrap-step.sh");
  const summary = path.join(dir, "summary");
  writeFileSync(step, runBody(release, "Print the one-time bootstrap gate"));
  const result = spawnSync("bash", [step], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      V: "0.1.0",
      CORE_TGZ: "superbee-core-0.1.0.tgz",
      SERVER_TGZ: "superbee-server-0.1.0.tgz",
      CORE_SHA: "core-sha",
      SERVER_SHA: "server-sha",
      DIST_TAG: "latest",
      GITHUB_STEP_SUMMARY: summary,
      npm_config_tag: "ambient-danger",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(summary, "utf8");
  assert.equal((text.match(/--tag "latest"/g) ?? []).length, 2);
  assert.doesNotMatch(text, /ambient-danger/);
  rmSync(dir, { recursive: true, force: true });
});

test("later releases stage core and server separately behind the existing environment", () => {
  const { stage_core: core, stage_server: server } = jobs(release);
  for (const job of [core, server]) {
    assert.match(job, /^ {4}environment: release$/m);
    assert.match(job, /id-token: write/);
    assert.match(job, /npm stage publish "\.\/out\/\$TGZ" --tag "\$DIST_TAG" --provenance --json/);
    assert.doesNotMatch(job, /npm publish|npm dist-tag/);
  }
  assert.match(core, /sha256sum "out\/\$\{\{ needs\.build\.outputs\.core_tgz \}\}"[\s\S]*needs\.build\.outputs\.core_sha256/);
  assert.match(server, /sha256sum "out\/\$\{\{ needs\.build\.outputs\.server_tgz \}\}"[\s\S]*needs\.build\.outputs\.server_sha256/);
  assert.match(server, /needs: \[build, attest, stage_core\]/);
  assert.match(server, /npm stage approve \$CORE_STAGE/);
  assert.match(server, /npm stage approve \$SERVER_STAGE/);
});

test("the finalizer proves both registry tarballs against the dedicated source tag", () => {
  const { finalize: job } = jobs(finalize);
  assert.ok(job);
  assert.match(job, /^ {4}permissions:\n {6}contents: read$/m);
  assert.match(job, /registry-url: "https:\/\/registry\.npmjs\.org"/);
  assert.match(job, /npm pack "@superbee\/core@\$V"/);
  assert.match(job, /npm pack "@superbee\/server@\$V"/);
  assert.equal((job.match(/gh attestation verify/g) ?? []).length, 2);
  assert.equal((job.match(/--source-ref "refs\/tags\/libraries\/v\$V"/g) ?? []).length, 2);
  assert.match(job, /server\.dependencies\["@superbee\/core"\], version/);
});

test("the literal verifier consumes fixed tarballs and never creates replacements", () => {
  assert.match(verifier, /path\.resolve\("out", "superbee-core\.tgz"\)/);
  assert.match(verifier, /path\.resolve\("out", "superbee-server\.tgz"\)/);
  assert.doesNotMatch(verifier, /process\.argv/);
  assert.doesNotMatch(verifier, /\["pack"|npm pack|npm run build/);
  assert.match(verifier, /platform: "browser"/);
  assert.match(verifier, /serverManifest\.dependencies\?\.\["@superbee\/core"\]/);
});
