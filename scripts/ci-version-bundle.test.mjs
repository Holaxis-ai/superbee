import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSemver,
  bumpPatch,
  higherVersion,
  extractVersion,
  replaceVersion,
  run,
  regenerateArtifacts,
  REAL_PATHS,
} from "./ci-version-bundle.mjs";
import { buildCliBundle, currentSourceFacts } from "../packages/cli/scripts/build-bundle.mjs";
import { bundleContentEqual } from "../packages/cli/scripts/bundle-identity-comparison.mjs";
import { prepareCliBundleInputs } from "../packages/cli/scripts/prepare-bundle-inputs.mjs";
import { UI_DIST_PREREQUISITE_WORKSPACES } from "../packages/cli/scripts/embed-ui-assets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the CI workflow enters regeneration through the npm-owned script", async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const workflow = await readFile(join(repoRoot, ".github/workflows/ci-version-bundle.yml"), "utf8");

  assert.equal(manifest.scripts["ci:version-bundle"], "node scripts/ci-version-bundle.mjs");
  assert.equal(workflow.match(/npm run ci:version-bundle/g)?.length, 1);
  assert.doesNotMatch(workflow, /^\s*node scripts\/ci-version-bundle\.mjs\s*$/m);
  assert.doesNotMatch(workflow, /github\.actor/, "convergence, not actor identity, prevents loops");
  assert.equal(workflow.match(/ci-version-bundle-pr\.mjs inspect/g)?.length, 1);
  assert.equal(workflow.match(/ci-version-bundle-pr\.mjs apply/g)?.length, 1);
});

test("the CI workflow keeps write authority conditional and apply-only", async () => {
  const workflow = await readFile(join(repoRoot, ".github/workflows/ci-version-bundle.yml"), "utf8");

  assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(workflow, /owner: \$\{\{ github\.repository_owner \}\}/);
  assert.match(workflow, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.doesNotMatch(workflow, /skip-token-revoke/);

  const tokenStep = workflow.match(/- name: Mint[\s\S]*?(?=\n      - name: Apply)/)?.[0] ?? "";
  assert.match(tokenStep, /if: steps\.inspect\.outputs\.needs_mutation == 'true'/);
  const applyStep = workflow.match(/- name: Apply[\s\S]*$/)?.[0] ?? "";
  assert.match(applyStep, /VERSION_BUNDLE_APP_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("- name: Apply")), /VERSION_BUNDLE_APP_TOKEN/);
});

test("the CI bridge has no direct-main or privileged mutation fallback", async () => {
  const workflow = await readFile(join(repoRoot, ".github/workflows/ci-version-bundle.yml"), "utf8");
  const bridge = await readFile(join(repoRoot, "scripts/ci-version-bundle-pr.mjs"), "utf8");
  const executable = `${workflow}\n${bridge}`;

  assert.doesNotMatch(executable, /git push[^\n]*(?:HEAD:main|refs\/heads\/main)/);
  assert.doesNotMatch(executable, /refs\/tags\/|--delete|--admin|gh pr (?:review|merge)|auto-merge/);
  assert.doesNotMatch(bridge, /repos\/[^"'`]+\/(?:releases|merges|reviews|rulesets|environments)/);
  assert.doesNotMatch(bridge, /export (?:async )?function (?:mutate|requestMutation)/);
});

test("every CLI bundle producer uses the shared generated-input preparation", async () => {
  const producers = [
    "packages/cli/build.mjs",
    "packages/cli/scripts/build-plugin-bundle.mjs",
    "packages/cli/scripts/check-skill-bundle.mjs",
  ];
  for (const path of producers) {
    const source = await readFile(join(repoRoot, path), "utf8");
    assert.match(source, /import \{ prepareCliBundleInputs \} from /, path);
    assert.match(source, /await prepareCliBundleInputs\(\)/, path);
    assert.doesNotMatch(source, /\bembedUiAssets\(\)/, path);
    assert.doesNotMatch(source, /\bbuildMcpViewHtml\(\)/, path);
  }
});

// The CI bot regenerates from a FRESH checkout (`npm ci`, no sibling dist/ anywhere), and npm does
// not build a workspace's deps on a single-workspace build. Every @agentstate-lite workspace whose
// dist/ the packages/ui production build resolves must therefore be built by the bundle path
// itself — either by ui's own `prebuild` or by embed-ui-assets' prerequisite list — or the bot
// fails on every push to main with an unresolvable import (the view-runtime/action-bridge
// regression of 2026-08).
test("the ui build path covers every sibling dist a fresh checkout is missing", async () => {
  const uiManifest = JSON.parse(await readFile(join(repoRoot, "packages/ui/package.json"), "utf8"));
  const prebuild = uiManifest.scripts?.prebuild ?? "";
  const workspaceDeps = Object.keys(uiManifest.dependencies ?? {}).filter((name) =>
    name.startsWith("@agentstate-lite/"),
  );
  assert.ok(workspaceDeps.length > 0, "expected packages/ui to declare workspace dependencies");
  for (const dep of workspaceDeps) {
    assert.ok(
      UI_DIST_PREREQUISITE_WORKSPACES.includes(dep) || prebuild.includes(dep),
      `${dep} is a packages/ui workspace dependency but nothing builds its dist/ before the ui ` +
        "vite build — add it to UI_DIST_PREREQUISITE_WORKSPACES (or ui's prebuild) or a " +
        "fresh-checkout plugin-bundle regeneration (the CI version-bundle bot) fails to resolve it",
    );
  }

  // The two entries the current tree is known to need, in dependency order: the vite build
  // resolves core's `./kinds` slice directly, and view-runtime's own tsc consumes core's dist
  // types, so core must be built before view-runtime.
  assert.equal(UI_DIST_PREREQUISITE_WORKSPACES[0], "@agentstate-lite/core");
  assert.ok(UI_DIST_PREREQUISITE_WORKSPACES.includes("@agentstate-lite/view-runtime"));
});

// ---------------------------------------------------------------------------------------------
// Pure semver helpers.
// ---------------------------------------------------------------------------------------------

describe("parseSemver / bumpPatch / higherVersion", () => {
  test("bumpPatch increments only the patch component", () => {
    assert.equal(bumpPatch("1.0.24"), "1.0.25");
    assert.equal(bumpPatch("2.9.9"), "2.9.10");
    assert.equal(bumpPatch("0.0.0"), "0.0.1");
  });

  test("parseSemver rejects anything that isn't plain major.minor.patch", () => {
    for (const bad of ["1.0", "1.0.0-beta", "v1.0.0", "1.0.0.1", "latest", ""]) {
      assert.throws(() => parseSemver(bad), /not a plain major\.minor\.patch/);
    }
  });

  test("higherVersion picks the semantically greater version, not the lexically greater string", () => {
    assert.equal(higherVersion("1.0.9", "1.0.10"), "1.0.10"); // lexical would wrongly pick "1.0.9"
    assert.equal(higherVersion("1.2.0", "1.10.0"), "1.10.0");
    assert.equal(higherVersion("2.0.0", "1.9.9"), "2.0.0");
    assert.equal(higherVersion("1.0.24", "1.0.24"), "1.0.24"); // equal -> either (returns `a`)
  });
});

// ---------------------------------------------------------------------------------------------
// Manifest text surgery — must be a surgical single-field replace, not a reformat.
// ---------------------------------------------------------------------------------------------

describe("extractVersion / replaceVersion", () => {
  const marketplaceFixture = [
    "{",
    '  "name": "agentstate-lite",',
    '  "owner": { "name": "Holaxis" },',
    '  "plugins": [',
    "    {",
    '      "name": "agentstate-lite",',
    '      "description": "A markdown knowledge bundle.",',
    '      "version": "1.2.3",',
    '      "source": "./plugins/agentstate-lite",',
    '      "author": { "name": "Holaxis" }',
    "    }",
    "  ]",
    "}",
    "",
  ].join("\n");

  test("extractVersion finds the sole version field", () => {
    assert.equal(extractVersion(marketplaceFixture, "fixture"), "1.2.3");
  });

  test("extractVersion throws when there isn't exactly one match", () => {
    assert.throws(() => extractVersion('{"no-version-here": true}', "fixture"), /found 0/);
    const twoVersions = '{"version": "1.0.0"}\n{"version": "2.0.0"}';
    assert.throws(() => extractVersion(twoVersions, "fixture"), /found 2/);
  });

  test("replaceVersion changes ONLY the version value — byte-identical everywhere else", () => {
    const updated = replaceVersion(marketplaceFixture, "1.2.4", "fixture");
    assert.equal(extractVersion(updated, "fixture"), "1.2.4");
    // Every other line, including the compact inline `"author": { "name": "Holaxis" }`, is untouched.
    const expected = marketplaceFixture.replace('"version": "1.2.3"', '"version": "1.2.4"');
    assert.equal(updated, expected);
  });
});

// ---------------------------------------------------------------------------------------------
// Orchestration — fixture temp dir + a fake `regenerate`, fully isolated from the real repo.
// ---------------------------------------------------------------------------------------------

async function makeFixtureBundle({ marketplaceVersion = "1.2.3", pluginVersion = marketplaceVersion } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-version-bundle-test-"));
  const paths = {
    marketplace: join(dir, "marketplace.json"),
    pluginJson: join(dir, "plugin.json"),
    skillMd: join(dir, "SKILL.md"),
    bundleMjs: join(dir, "agentstate-lite.mjs"),
    // Deliberately left ABSENT here (most fixture tests below never touch it, exercising the
    // pre-existing skillMd/bundleMjs diff paths unchanged); the "references/ snapshot" describe
    // block below creates it itself where the point IS to exercise this path.
    referencesDir: join(dir, "references"),
  };
  await writeFile(
    paths.marketplace,
    `{\n  "name": "agentstate-lite",\n  "plugins": [\n    { "name": "agentstate-lite", "version": "${marketplaceVersion}" }\n  ]\n}\n`,
  );
  await writeFile(paths.pluginJson, `{\n  "name": "agentstate-lite",\n  "version": "${pluginVersion}"\n}\n`);
  await writeFile(paths.skillMd, "# SKILL v1\n");
  await writeFile(paths.bundleMjs, "console.log('bundle v1');\n");
  return { dir, paths };
}

function bakedBundle({
  commit = "0123456789012345678901234567890123456789",
  dirty = false,
  code = "console.log('bundle v1');",
} = {}) {
  return `var define_ASLITE_BUILD_IDENTITY_default = { schema: "aslite.build-identity.v1", package: { name: "@holaxis/aslite", version: "0.1.0-pre.2" }, source: { commit: "${commit}", dirty: ${dirty} }, artifact: { channel: "marketplace-legacy" }, compatibility_contracts: { skill: 1, hook: 1, mcp: 1 } };\n${code}\n`;
}

describe("run() orchestration (fixtures, fake regenerate)", () => {
  test("source-only artifact drift is restored and cannot bump or leave a bot commit", async () => {
    const { dir, paths } = await makeFixtureBundle();
    const committed = bakedBundle();
    try {
      await writeFile(paths.bundleMjs, committed);
      const sourceOnlyRegen = async (p) => {
        await writeFile(
          p.bundleMjs,
          bakedBundle({ commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", dirty: true }),
        );
      };
      const result = await run({ regenerate: sourceOnlyRegen, paths });
      assert.deepEqual(result, { changed: false });
      assert.equal(await readFile(paths.bundleMjs, "utf8"), committed, "provenance-only output must be restored");
      assert.equal(extractVersion(await readFile(paths.marketplace, "utf8"), "m"), "1.2.3");
      assert.equal(extractVersion(await readFile(paths.pluginJson, "utf8"), "p"), "1.2.3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("real executable-content drift remains visible and bumps exactly once", async () => {
    const { dir, paths } = await makeFixtureBundle();
    try {
      await writeFile(paths.bundleMjs, bakedBundle());
      const contentRegen = async (p) => writeFile(p.bundleMjs, bakedBundle({ code: "console.log('bundle v2');" }));
      const result = await run({ regenerate: contentRegen, paths });
      assert.equal(result.changed, true);
      assert.equal(result.bundleChanged, true);
      assert.equal(result.newVersion, "1.2.4");
      assert.match(await readFile(paths.bundleMjs, "utf8"), /bundle v2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the transaction forwards one exact source snapshot to its generator", async () => {
    const { dir, paths } = await makeFixtureBundle();
    const source = { commit: "0123456789012345678901234567890123456789", dirty: true };
    let received;
    try {
      const identityRegen = async (p, context) => {
        received = context.source;
        await writeFile(p.skillMd, "# SKILL v1\n");
        await writeFile(p.bundleMjs, "console.log('bundle v1');\n");
      };
      const result = await run({ regenerate: identityRegen, paths, source });
      assert.deepEqual(result, { changed: false });
      assert.equal(received, source, "the orchestrator must propagate the immutable snapshot itself");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("artifact-current no-op: regen produces byte-identical content -> no bump, manifests untouched", async () => {
    const { dir, paths } = await makeFixtureBundle();
    try {
      const identityRegen = async (p) => {
        // "Rebuild" that reproduces exactly what's already committed — the steady state.
        await writeFile(p.skillMd, "# SKILL v1\n");
        await writeFile(p.bundleMjs, "console.log('bundle v1');\n");
      };
      const result = await run({ regenerate: identityRegen, paths });
      assert.deepEqual(result, { changed: false });
      assert.equal(extractVersion(await readFile(paths.marketplace, "utf8"), "m"), "1.2.3");
      assert.equal(extractVersion(await readFile(paths.pluginJson, "utf8"), "p"), "1.2.3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bump-both-manifests atomicity: a content change bumps BOTH manifests to the identical new version", async () => {
    const { dir, paths } = await makeFixtureBundle({ marketplaceVersion: "1.2.3" });
    try {
      const changingRegen = async (p) => {
        await writeFile(p.skillMd, "# SKILL v2 (regenerated)\n"); // differs from fixture's v1
        await writeFile(p.bundleMjs, "console.log('bundle v1');\n"); // unchanged
      };
      const result = await run({ regenerate: changingRegen, paths });
      assert.equal(result.changed, true);
      assert.equal(result.skillMdChanged, true);
      assert.equal(result.bundleChanged, false);
      assert.equal(result.baseVersion, "1.2.3");
      assert.equal(result.newVersion, "1.2.4");

      const marketplaceVersion = extractVersion(await readFile(paths.marketplace, "utf8"), "m");
      const pluginVersion = extractVersion(await readFile(paths.pluginJson, "utf8"), "p");
      assert.equal(marketplaceVersion, "1.2.4");
      assert.equal(pluginVersion, "1.2.4");
      assert.equal(marketplaceVersion, pluginVersion); // never allowed to diverge after one run
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("manifest drift self-heals: bumps from the HIGHER of two mismatched manifest versions", async () => {
    const { dir, paths } = await makeFixtureBundle({ marketplaceVersion: "1.2.3", pluginVersion: "1.2.5" });
    try {
      const changingRegen = async (p) => writeFile(p.skillMd, "# changed\n");
      const result = await run({ regenerate: changingRegen, paths });
      assert.equal(result.baseVersion, "1.2.5"); // the higher of the two, not marketplace's
      assert.equal(result.newVersion, "1.2.6");
      assert.equal(extractVersion(await readFile(paths.marketplace, "utf8"), "m"), "1.2.6");
      assert.equal(extractVersion(await readFile(paths.pluginJson, "utf8"), "p"), "1.2.6");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("convergence: a second run against the bot's own prior output is a clean no-op", async () => {
    const { dir, paths } = await makeFixtureBundle({ marketplaceVersion: "1.2.3" });
    try {
      // Run 1: simulates a real source change landing on main.
      const firstRegen = async (p) => writeFile(p.skillMd, "# SKILL v2 (regenerated)\n");
      const first = await run({ regenerate: firstRegen, paths });
      assert.equal(first.changed, true);
      assert.equal(first.newVersion, "1.2.4");

      // Run 2: simulates the bot's OWN commit re-triggering the workflow. A deterministic rebuild
      // reproduces exactly what run 1 just generated within the SAME fixed checkout. This proves
      // deterministic retry convergence; the separate workflow actor guard prevents the bot's own
      // NEW commit SHA from recursively regenerating another identity.
      const secondRegen = async (p) => writeFile(p.skillMd, "# SKILL v2 (regenerated)\n");
      const second = await run({ regenerate: secondRegen, paths });
      assert.deepEqual(second, { changed: false });
      assert.equal(extractVersion(await readFile(paths.marketplace, "utf8"), "m"), "1.2.4");
      assert.equal(extractVersion(await readFile(paths.pluginJson, "utf8"), "p"), "1.2.4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// references/ snapshot — LOAD-BEARING widening: without this, a references-only change (a new
// skill-projected resource entry, an edited source file it points at) would never register in
// `changed`, so the version would never bump and the plugin's version-keyed cache would keep
// serving stale — or entirely absent — references/ content forever. These three cases are exactly
// what the distribution-completeness build spec calls out: changed, converged, and absent->present.
// ---------------------------------------------------------------------------------------------

describe("references/ snapshot (the load-bearing widening)", () => {
  test("a references-only change bumps the version — SKILL.md and bundle both stay byte-identical", async () => {
    const { dir, paths } = await makeFixtureBundle();
    try {
      await mkdir(paths.referencesDir, { recursive: true });
      await writeFile(join(paths.referencesDir, "contract.md"), "v1\n");

      const regen = async (p) => {
        await writeFile(p.skillMd, "# SKILL v1\n"); // unchanged
        await writeFile(p.bundleMjs, "console.log('bundle v1');\n"); // unchanged
        await writeFile(join(p.referencesDir, "contract.md"), "v2 — content changed\n");
      };
      const result = await run({ regenerate: regen, paths });
      assert.equal(result.changed, true);
      assert.equal(result.skillMdChanged, false);
      assert.equal(result.bundleChanged, false);
      assert.equal(result.referencesChanged, true);
      assert.equal(result.newVersion, "1.2.4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("references/ reproduced byte-for-byte (converged) alongside unchanged SKILL.md/bundle stays a no-op", async () => {
    const { dir, paths } = await makeFixtureBundle();
    try {
      await mkdir(paths.referencesDir, { recursive: true });
      await writeFile(join(paths.referencesDir, "contract.md"), "steady state\n");

      const identityRegen = async (p) => {
        await writeFile(p.skillMd, "# SKILL v1\n");
        await writeFile(p.bundleMjs, "console.log('bundle v1');\n");
        await writeFile(join(p.referencesDir, "contract.md"), "steady state\n"); // reproduces exactly
      };
      const result = await run({ regenerate: identityRegen, paths });
      assert.deepEqual(result, { changed: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("references/ appearing for the first time (absent -> present) counts as a change, not a no-op", async () => {
    const { dir, paths } = await makeFixtureBundle();
    try {
      // paths.referencesDir does not exist yet — as if the manifest just gained its first entry.
      const regenCreatesReferences = async (p) => {
        await writeFile(p.skillMd, "# SKILL v1\n"); // unchanged
        await writeFile(p.bundleMjs, "console.log('bundle v1');\n"); // unchanged
        await mkdir(p.referencesDir, { recursive: true });
        await writeFile(join(p.referencesDir, "contract.md"), "brand new\n");
      };
      const result = await run({ regenerate: regenCreatesReferences, paths });
      assert.equal(result.changed, true);
      assert.equal(result.skillMdChanged, false);
      assert.equal(result.bundleChanged, false);
      assert.equal(result.referencesChanged, true);
      assert.equal(result.newVersion, "1.2.4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Real repo integration — proves the production wiring, not just the orchestration logic.
// Any real mutation this makes to the committed repo files is restored in `finally`, so the test
// suite never leaves the working tree dirty regardless of pass/fail or of the repo's state at
// test time (e.g. a developer mid-edit on CLI source).
// ---------------------------------------------------------------------------------------------

describe("real build (repo-tied)", () => {
  test("two identically flavored real builds of the same source are byte-identical", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-version-bundle-real-"));
    try {
      await prepareCliBundleInputs();
      const out1 = join(dir, "build1.mjs");
      const out2 = join(dir, "build2.mjs");
      const out3 = join(dir, "build3-different-source.mjs");
      const source = { commit: "0123456789012345678901234567890123456789", dirty: true };
      await buildCliBundle(out1, { artifactChannel: "marketplace-legacy", source });
      await buildCliBundle(out2, { artifactChannel: "marketplace-legacy", source });
      await buildCliBundle(out3, {
        artifactChannel: "marketplace-legacy",
        source: { commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", dirty: false },
      });
      const bytes1 = await readFile(out1);
      const bytes2 = await readFile(out2);
      const bytes3 = await readFile(out3);
      assert.ok(bytes1.equals(bytes2), "two consecutive real builds must be byte-identical");
      assert.equal(bytes1.equals(bytes3), false, "runtime artifacts retain different source provenance");
      assert.equal(bundleContentEqual(bytes1, bytes3), true, "drift comparison ignores only source provenance");

      assert.ok(
        bytes1.toString("latin1").includes("marketplace-legacy"),
        "the explicit marketplace build flavor must be baked into the bundle",
      );
      const envelope = JSON.parse(execFileSync(process.execPath, [out1, "version", "--json"], { encoding: "utf8" }));
      assert.deepEqual(envelope.identity.source, source, "known dirty evidence must remain honest");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run() against the REAL repo paths converges to a no-op when the tree is already current", async () => {
    // Snapshot so this test can never leave the real committed files mutated, whatever the
    // ambient repo state is at test time. `referencesDir` is a DIRECTORY (unlike every other
    // REAL_PATHS entry, which is a single file) — back it up with a recursive copy, not readFile.
    const fileKeys = Object.keys(REAL_PATHS).filter((key) => key !== "referencesDir");
    const backup = {};
    for (const key of fileKeys) {
      backup[key] = await readFile(REAL_PATHS[key]);
    }
    const referencesExisted = await stat(REAL_PATHS.referencesDir).then(
      () => true,
      () => false,
    );
    const referencesBackupDir = await mkdtemp(join(tmpdir(), "ci-version-bundle-references-backup-"));
    if (referencesExisted) await cp(REAL_PATHS.referencesDir, referencesBackupDir, { recursive: true });
    try {
      // Capture the build input before regeneration writes any of its own tracked outputs. The
      // second pass proves deterministic regeneration of that SAME checkout state; recomputing
      // dirty after the first pass would measure the generator's outputs as if they were new
      // source inputs and create a false feedback loop.
      const source = currentSourceFacts();

      // First run brings the committed artifacts up to date with a fresh regeneration. It may
      // legitimately report changed:true (a developer mid-edit on CLI source, or a branch whose
      // committed bundle predates a compressor/tooling change the bot hasn't regenerated for yet).
      const first = await run({ source }); // real regenerate, real paths — fixed source evidence
      assert.equal(typeof first.changed, "boolean");
      const firstMarketplaceVersion = extractVersion(await readFile(REAL_PATHS.marketplace, "utf8"), "m");
      const firstPluginVersion = extractVersion(await readFile(REAL_PATHS.pluginJson, "utf8"), "p");
      assert.equal(firstMarketplaceVersion, firstPluginVersion);

      // Against the now-current tree the bot MUST converge: a second regeneration produces the
      // same bytes and reports changed:false, leaving the manifests untouched. This is the
      // loop-safety property the CI workflow's correctness rests on, and — with the embed
      // pipeline's compressor pinned to an exact library version (pako) instead of node:zlib —
      // it now holds across machines and Node versions, not just on the machine that built last.
      const second = await run({ source });
      assert.equal(second.changed, false, "regenerating an already-current tree must be a no-op");
      assert.equal(extractVersion(await readFile(REAL_PATHS.marketplace, "utf8"), "m"), firstMarketplaceVersion);
      assert.equal(extractVersion(await readFile(REAL_PATHS.pluginJson, "utf8"), "p"), firstPluginVersion);
    } finally {
      for (const key of fileKeys) {
        await writeFile(REAL_PATHS[key], backup[key]);
      }
      await rm(REAL_PATHS.referencesDir, { recursive: true, force: true });
      if (referencesExisted) {
        await mkdir(REAL_PATHS.referencesDir, { recursive: true });
        await cp(referencesBackupDir, REAL_PATHS.referencesDir, { recursive: true });
      }
      await rm(referencesBackupDir, { recursive: true, force: true });
    }
  });
});
