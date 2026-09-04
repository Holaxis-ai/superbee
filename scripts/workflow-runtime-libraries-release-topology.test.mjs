import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.match(contributing, /verify:runtime-libraries -- <core\.tgz> <server\.tgz>/);
  assert.match(contributing, /NPM_RUNTIME_LIBRARIES_READ_TOKEN/);
});

test("payload code builds once before a literal two-tarball verification", () => {
  const { build, attest, stage_core: core, stage_server: server } = jobs(release);
  assert.ok(build && attest && core && server);
  assert.match(build, /^ {4}permissions:\n {6}contents: read\n {6}checks: read$/m);
  assert.doesNotMatch(build, /id-token: write|environment: release|secrets\./);
  assert.equal((build.match(/npm run build -w @superbee\/core -w @superbee\/server/g) ?? []).length, 1);
  assert.equal((build.match(/npm pack -w @superbee\/core/g) ?? []).length, 1);
  assert.equal((build.match(/npm pack -w @superbee\/server/g) ?? []).length, 1);
  assert.match(build, /npm run verify:runtime-libraries -- "out\/\$CORE_TGZ" "out\/\$SERVER_TGZ"/);
  assert.doesNotMatch(attest + core + server, /actions\/checkout|npm ci|npm run build|npm pack -w/);
  assert.equal((attest.match(/actions\/attest-build-provenance/g) ?? []).length, 2);
});

test("release source and first-version boundaries fail closed", () => {
  const { build, attest, stage_core: core, stage_server: server } = jobs(release);
  assert.match(build, /compare\/main\.\.\.\$GITHUB_SHA/);
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
  assert.match(attest, /npm publish \\\"\.\/\$CORE_TGZ\\\" --access restricted --ignore-scripts/);
  assert.match(attest, /npm publish \\\"\.\/\$SERVER_TGZ\\\" --access restricted --ignore-scripts/);
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

test("the literal verifier consumes supplied tarballs and never creates replacements", () => {
  assert.match(verifier, /usage: verify-runtime-libraries\.mjs <core\.tgz> <server\.tgz>/);
  assert.doesNotMatch(verifier, /\["pack"|npm pack|npm run build/);
  assert.match(verifier, /platform: "browser"/);
  assert.match(verifier, /serverManifest\.dependencies\?\.\["@superbee\/core"\]/);
});
