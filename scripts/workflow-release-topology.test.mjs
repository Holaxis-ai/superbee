import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(build, /^ {4}permissions:\n {6}contents: read$/m, "build holds only contents: read");
  assert.doesNotMatch(build, /id-token|environment:|secrets\./, "build must not mint OIDC tokens or see environment secrets");
  assert.match(build, /npm ci --ignore-scripts/, "dependency lifecycle scripts stay off in the release build");
  assert.match(build, /compare\/main\.\.\.\$GITHUB_SHA[\s\S]*case "\$REL" in identical\|behind\) ;; \*\)/, "the tag must point at a commit already on main");
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

test("finalize holds no npm credential, verifies provider state, and creates the release once", () => {
  const { finalize: job } = jobs(finalize);
  assert.ok(job, "release-finalize.yml declares the finalize job");
  assert.match(job, /^ {4}permissions:\n {6}contents: write$/m, "finalize needs only contents: write");
  assert.doesNotMatch(job, /id-token|registry-url|NODE_AUTH_TOKEN/, "finalize must not be able to authenticate to npm");
  assert.match(job, /npm view "superbee@\$V" version/, "finalize proves the registry serves the version");
  assert.match(job, /npm view "superbee@\$V" version readmeFilename readme engines os --json/, "finalize reads the exact npm page metadata");
  assert.match(job, /registry\.readme, readme/, "finalize proves npm renders the installed README bytes");
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

test("an ordinary npm publish from the package directory trips before it can publish", () => {
  // Ergonomics only: npm's "require 2FA and disallow tokens" setting is the real boundary, and
  // --ignore-scripts bypasses this hook. It exists so a maintainer cannot publish by reflex.
  const pkg = JSON.parse(readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8"));
  assert.match(pkg.scripts.prepublishOnly ?? "", /process\.exit\(1\)/, "prepublishOnly must refuse");
  assert.doesNotMatch(pkg.scripts.prepublishOnly, /\.\.\/|scripts\//, "the tripwire must not depend on files outside the package");
});
