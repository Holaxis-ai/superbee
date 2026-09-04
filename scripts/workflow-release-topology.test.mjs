import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The release workflows are deliberately small; these invariants are the reasons they are safe.
// Everything else about releasing is a GitHub or npm feature, not repository code.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(path.join(root, ".github", "workflows", name), "utf8");
const release = read("release.yml");
const finalize = read("release-finalize.yml");

function jobs(text) {
  const lines = text.split("\n");
  const at = lines.indexOf("jobs:");
  assert.notEqual(at, -1, "workflow must declare jobs");
  const out = {};
  let current = null;
  for (const line of lines.slice(at + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) { current = header[1]; out[current] = []; continue; }
    if (current) out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([name, body]) => [name, body.join("\n")]));
}

test("release workflows hold no ambient permissions and pin every action by commit SHA", () => {
  for (const [name, text] of [["release.yml", release], ["release-finalize.yml", finalize]]) {
    assert.match(text, /^permissions: \{\}$/m, `${name} must start from zero permissions`);
    assert.match(text, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m, `${name} must serialize releases`);
    assert.doesNotMatch(text, /continue-on-error/, `${name} cannot mask a failing step`);
    for (const use of text.matchAll(/^\s+- uses: (.+)$/gm)) {
      assert.match(use[1], /@[0-9a-f]{40} # v\d/, `${name} action ${use[1]} must be pinned to a full SHA with its version comment`);
    }
    assert.doesNotMatch(text, /\bnpm (publish|dist-tag)\b|\bnpx\b[^\n]*\bnpm\b/, `${name} must never publish or move a dist-tag directly`);
  }
});

test("payload code runs only in the credential-free build job; staging runs no payload code", () => {
  const { build, stage } = jobs(release);
  assert.ok(build && stage, "release.yml declares build and stage jobs");
  assert.match(build, /^ {4}permissions:\n {6}contents: read\n {6}checks: read$/m, "build holds only contents: read plus checks: read for the CI verdict");
  assert.doesNotMatch(build, /id-token|environment:|secrets\./, "build must not mint OIDC tokens or see environment secrets");
  assert.match(build, /npm ci --ignore-scripts/, "dependency lifecycle scripts stay off in the release build");
  assert.match(build, /case "\$V" in\n\s+\*-\*\) SOURCE_REF=main ;;\n\s+\*\) SOURCE_REF="release\/\$V" ;;/, "prereleases must use main and stable versions their named release branch");
  assert.match(build, /compare\/\$SOURCE_REF\.\.\.\$GITHUB_SHA[\s\S]*case "\$REL" in identical\|behind\) ;; \*\)/, "the tag must point at an allowed source ref");
  assert.match(build, /No other branch can feed staging\./, "only main or the exact stable release branch may feed staging");
  assert.doesNotMatch(build, /npm view[^\n]*\|\| true/, "registry reads must fail closed, never fall through");
  assert.match(build, /npm run build:npm-package -w superbee/, "the release build runs through npm (npm_execpath)");
  assert.match(build, /npm run --silent pack:npm-package -- --pack-destination out/, "the release pack embeds exact npm-page metadata before creating the retained tarball");
  assert.match(build, /npm run verify:npm-package:tarball -- "out\//, "the packed tarball is proved before upload");
  assert.match(stage, /^ {4}environment: release$/m, "stage runs in the environment the npm trusted publisher is bound to");
  assert.match(stage, /id-token: write/, "stage exchanges OIDC with npm");
  assert.doesNotMatch(stage, /actions\/checkout|npm ci|npm run build/, "stage must not check out or execute repository code");
  assert.match(stage, /registry-url: "https:\/\/registry.npmjs.org"/, "registry-url is load-bearing for the OIDC exchange");
  assert.match(stage, /npm stage publish "\.\/out\/\$TGZ" --tag "\$DIST_TAG" --provenance --json/, "stage the literal tarball with its final tag");
});

test("the build consumes the exact-source CI verdict and refuses to build without it", () => {
  // The newest recorded 'CI required lanes' verdict on the exact tagged commit is the
  // release-source validation. The gate consumes it instead of rerunning CI, so the release path
  // never pays for a duplicate full run and can never stage bytes whose source CI failed. These
  // assertions pin the decision mechanics, not just the step's spelling; the fixture test below
  // executes the committed step verbatim.
  const { build } = jobs(release);
  assert.match(
    build,
    /commits\/\$GITHUB_SHA\/check-runs\?check_name=CI%20required%20lanes&filter=latest&per_page=100/,
    "the gate must ask for the canonical required context on the exact tagged commit, unpaginated",
  );
  assert.match(build, /select\(\.app\.slug == "github-actions"\)/, "only repository-workflow check runs may vouch for the source");
  assert.match(build, /sort_by\(\.started_at\) \| last/, "the newest run decides; an older success must never outvote a newer failure");
  assert.match(build, /\$r\.conclusion == "success" then "success"/, "only a success conclusion may allow; cancelled/skipped/neutral are refusals");
  assert.match(build, /refusing to build without the CI verdict"; exit 1; \}/, "an unqueryable verdict must refuse with exit 1, not warn");
  assert.match(build, /fix CI on \$SOURCE_REF before tagging"; exit 1 ;;/, "a non-success conclusion must refuse with exit 1 immediately");
  assert.match(
    build,
    /test "\$VERDICT" = "success" \|\| \{ [^\n]*exit 1; \}/,
    "the post-loop backstop must require success with exit 1 — without it a poll exhaustion falls through to the build",
  );
  assert.match(build, /wait for or dispatch CI on \$SOURCE_REF, then re-push the tag/, "the missing-verdict recovery must name the selected source ref");
  const gate = build.indexOf("check-runs?check_name");
  assert.ok(gate !== -1 && gate < build.indexOf("npm run build:npm-package"), "the verdict gate must precede the package build");
  assert.ok(build.indexOf("compare/$SOURCE_REF...$GITHUB_SHA") < gate, "tag source is established before its verdict is consulted");
  assert.doesNotMatch(release, /workflow_dispatch|ci-tests\.yml/, "release.yml must consume the recorded verdict, never trigger CI itself");
});

// Execute the committed gate step verbatim against synthetic check-run fixtures: `gh` is stubbed
// to apply the step's OWN embedded --jq program to the fixture and `sleep` is neutered, so the
// decision under test is the exact shell+jq the workflow will run, not a re-implementation.
const hasJq = spawnSync("jq", ["--version"]).status === 0;
// Under CI a missing jq must fail loudly (the string assertions alone are provably evadable);
// locally it degrades to a visible skip.
test("the committed verdict gate allows only a newest genuine success", { skip: hasJq || process.env.CI ? false : "jq unavailable on this host" }, () => {
  const start = release.indexOf("- name: Require the CI verdict already recorded on this exact commit");
  assert.notEqual(start, -1, "release.yml declares the verdict gate step");
  const runAt = release.indexOf("run: |", start);
  assert.notEqual(runAt, -1, "the verdict gate step has a run block");
  const body = [];
  for (const line of release.slice(release.indexOf("\n", runAt) + 1).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "release-gate-"));
  const stepPath = path.join(dir, "gate-step.sh");
  writeFileSync(stepPath, body.join("\n"));
  const run = (slug, status, conclusion, started_at) => ({ app: { slug }, status, conclusion, started_at });
  const ga = (status, conclusion, started_at) => run("github-actions", status, conclusion, started_at);
  const fixtures = {
    "success": { allow: true, body: { check_runs: [ga("completed", "success", "2026-08-29T10:00:00Z")] } },
    "old-failure-new-success": { allow: true, body: { check_runs: [ga("completed", "failure", "2026-08-29T09:00:00Z"), ga("completed", "success", "2026-08-29T10:00:00Z")] } },
    "old-success-new-failure": { allow: false, body: { check_runs: [ga("completed", "success", "2026-08-29T09:00:00Z"), ga("completed", "failure", "2026-08-29T10:00:00Z")] } },
    "empty": { allow: false, body: { check_runs: [] } },
    "pending-exhausts-poll": { allow: false, body: { check_runs: [ga("in_progress", null, "2026-08-29T10:00:00Z")] } },
    "failure": { allow: false, body: { check_runs: [ga("completed", "failure", "2026-08-29T10:00:00Z")] } },
    "cancelled": { allow: false, body: { check_runs: [ga("completed", "cancelled", "2026-08-29T10:00:00Z")] } },
    "third-party-success-only": { allow: false, body: { check_runs: [run("name-squatting-app", "completed", "success", "2026-08-29T10:00:00Z")] } },
    "api-unqueryable": { allow: false, body: null },
  };
  const wrapper = [
    "gh() { if [ -z \"${GATE_FIXTURE:-}\" ]; then return 1; fi; jq -r \"${@: -1}\" \"$GATE_FIXTURE\"; }",
    "sleep() { :; }",
    "source \"$GATE_STEP\"",
  ].join("\n");
  for (const [name, { allow, body: fixtureBody }] of Object.entries(fixtures)) {
    const env = { ...process.env, GITHUB_REPOSITORY: "example/repo", GITHUB_SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", GATE_STEP: stepPath };
    if (fixtureBody !== null) {
      const fixturePath = path.join(dir, `${name}.json`);
      writeFileSync(fixturePath, JSON.stringify(fixtureBody));
      env.GATE_FIXTURE = fixturePath;
    }
    const result = spawnSync("bash", ["-c", wrapper], { env, encoding: "utf8" });
    const decision = result.status === 0 ? "allow" : "refuse";
    assert.equal(decision, allow ? "allow" : "refuse", `${name}: gate decided ${decision} (output: ${(result.stderr + result.stdout).trim().split("\n").at(-1)})`);
  }
});

test("finalize holds no npm credential, verifies provider state, and creates the release once", () => {
  const { finalize: job } = jobs(finalize);
  assert.ok(job, "release-finalize.yml declares the finalize job");
  assert.match(job, /^ {4}permissions:\n {6}contents: write$/m, "finalize needs only contents: write");
  assert.doesNotMatch(job, /id-token|registry-url|NODE_AUTH_TOKEN/, "finalize must not be able to authenticate to npm");
  assert.match(job, /npm view "superbee@\$V" version/, "finalize proves the registry serves the version");
  assert.match(job, /npm view "superbee@\$V" version readmeFilename engines os --json/, "finalize reads the exact supported npm metadata");
  assert.doesNotMatch(job, /assert\.(?:equal|deepEqual)\(registry\.readme\s*,/, "staged publishing does not populate registry readme bytes");
  assert.match(job, /manifest\.readme, readme/, "finalize proves the attested tarball carries the installed README bytes");
  assert.match(job, /registry\.engines, manifest\.engines/, "finalize proves npm exposes the installed Node requirement");
  assert.match(job, /registry\.os, manifest\.os/, "finalize proves npm exposes the installed platform metadata");
  assert.match(job, /How do I download Superbee on Windows/, "finalize dogfoods the novice Windows question");
  assert.doesNotMatch(job, /Windows\[\\s\\S\]\{0,240\}/, "stable documentation cannot use a bounded proximity guard");
  const relocatedStaleCommand = `Windows\n${"x".repeat(321)}\nnpm install -g superbee@next\n`;
  const stableNextGuard = /npm install -g superbee@next/;
  assert.match(relocatedStaleCommand, stableNextGuard, "the finalizer's whole-document guard catches the QA relocation mutant");
  assert.match(job, /assert\.doesNotMatch\(readme, \/npm install -g superbee@next\/\)/, "finalizer must apply the whole-document stale-next guard");
  assert.match(job, /gh attestation verify "out\/superbee-\$V\.tgz"[\s\S]*--source-ref "refs\/tags\/v\$V"/, "published bytes are bound to the build attestation and the tag ref");
  assert.match(job, /gh release view "\$TAG"[\s\S]*gh release create "\$TAG"/, "look before create so re-runs are idempotent");
  assert.match(job, /--verify-tag/, "the release must be created against the existing tag");
  assert.match(job, /gh release download "\$TAG"[\s\S]*differs from the bytes npm serves/, "every finalize path verifies the release asset against the npm bytes");
});

test("finalize accepts staged-publish metadata with an empty registry readme", () => {
  const start = finalize.indexOf("- name: Prove the installed README and npm platform metadata");
  assert.notEqual(start, -1, "release-finalize.yml declares the installed metadata proof");
  const heredoc = finalize.indexOf("node --input-type=module <<'NODE'", start);
  assert.notEqual(heredoc, -1, "the metadata proof executes a Node assertion block");
  const scriptStart = finalize.indexOf("\n", heredoc) + 1;
  const scriptEnd = finalize.indexOf("\n          NODE", scriptStart);
  assert.notEqual(scriptEnd, -1, "the metadata proof closes its Node assertion block");
  const script = finalize.slice(scriptStart, scriptEnd).split("\n").map((line) => line.slice(10)).join("\n");

  const dir = mkdtempSync(path.join(os.tmpdir(), "release-finalize-metadata-"));
  const out = path.join(dir, "out");
  mkdirSync(out);
  const readme = [
    "# superbee",
    "",
    "## How do I download Superbee on Windows?",
    "",
    "Node.js 20 or newer on macOS, Linux, or native Windows",
    "",
    "`latest` and `next`",
    "",
    "npm install -g superbee@next",
    "",
    "After installation, ask your AI agent to run `superbee setup`.",
    "",
  ].join("\n");
  const platform = { engines: { node: ">=20" }, os: ["darwin", "linux", "win32"] };
  writeFileSync(path.join(out, "registry-package.json"), JSON.stringify({ version: "0.1.5-pre.1", readmeFilename: "README.md", readme: "", ...platform }));
  writeFileSync(path.join(out, "registry-tags.json"), JSON.stringify({ latest: "0.1.3", next: "0.1.5-pre.1" }));
  writeFileSync(path.join(out, "tarball-package.json"), JSON.stringify({ version: "0.1.5-pre.1", readmeFilename: "README.md", readme, ...platform }));
  writeFileSync(path.join(out, "tarball-readme.md"), readme);

  const result = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: dir,
    env: { ...process.env, V: "0.1.5-pre.1", T: "next" },
    input: script,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `metadata proof rejected supported staged-publish state: ${result.stderr}`);
});

test("an ordinary npm publish from the package directory trips before it can publish", () => {
  // Ergonomics only: npm's "require 2FA and disallow tokens" setting is the real boundary, and
  // --ignore-scripts bypasses this hook. It exists so a maintainer cannot publish by reflex.
  const pkg = JSON.parse(readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8"));
  assert.match(pkg.scripts.prepublishOnly ?? "", /process\.exit\(1\)/, "prepublishOnly must refuse");
  assert.doesNotMatch(pkg.scripts.prepublishOnly, /\.\.\/|scripts\//, "the tripwire must not depend on files outside the package");
});
