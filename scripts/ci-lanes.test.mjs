import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateRequiredResults, REQUIRED_JOBS } from "./ci-aggregate.mjs";
import { validateNodeRuntimeManifest, validateNodeRuntimePolicy } from "./node-runtime-policy.mjs";
import { requiredTrustedReleasePrefix } from "./workflow-step-test-helper.mjs";
const clockModule = new URL("../packages/core/dist/meaningful-change-time.js", import.meta.url);
let meaningfulChangeTimeValue;
try {
  ({ meaningfulChangeTimeValue } = await import(clockModule.href));
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && error.url === clockModule.href) {
    throw new Error("Built core clock helper is missing. Run npm run build before npm run test:scripts.", { cause: error });
  }
  throw error;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const cliPkg = JSON.parse(readFileSync(path.join(root, "packages", "superbee", "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
const contributing = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");
const rootReadme = readFileSync(path.join(root, "README.md"), "utf8");
const npmReadme = readFileSync(path.join(root, "packages", "superbee", "README.md"), "utf8");
const cliLibraryPkg = JSON.parse(readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const okfBundleSource = readFileSync(path.join(root, "packages", "core", "src", "bundle.ts"), "utf8");
const linkSource = readFileSync(path.join(root, "packages", "core", "src", "links.ts"), "utf8");
const sampleOkfReference = readFileSync(
  path.join(root, "examples", "sample-bundle", "references", "okf-spec.md"),
  "utf8",
);
const wrapperSources = Object.fromEntries(
  Object.values(manifest.lanes)
    .filter((lane) => lane.wrapper)
    .map((lane) => [lane.wrapper, readFileSync(path.join(root, lane.wrapper), "utf8")]),
);
const REVIEW_EVIDENCE = `reviews/node-26-promotion@sha256:${"a".repeat(64)}`;
const RELEASE_PREFLIGHT_NAME = "Check Node runtime policy before installation";
const RELEASE_PREFLIGHT_RUN = "node scripts/node-runtime-policy.mjs";
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const RELEASE_CHECKOUT_INPUTS = {
  ".github/workflows/release.yml": {},
  ".github/workflows/release-libraries.yml": { "fetch-depth": 0 },
  ".github/workflows/release-cli-library.yml": { "fetch-depth": 0, "persist-credentials": false },
};

function requiredLaneNames(candidate) {
  return Object.entries(candidate.lanes)
    .filter(([, lane]) => lane.required !== false)
    .map(([name]) => name);
}

function count(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function assertReleasePreflightOrder(text, relative) {
  const { steps, preflightPosition } = requiredTrustedReleasePrefix(text, {
    label: relative,
    checkoutInputs: RELEASE_CHECKOUT_INPUTS[relative],
    checkoutAction: CHECKOUT_ACTION,
    setupNodeAction: SETUP_NODE_ACTION,
    nodeVersion: "24.21.0",
    preflightName: RELEASE_PREFLIGHT_NAME,
    preflightRun: RELEASE_PREFLIGHT_RUN,
    runsOn: "ubuntu-latest",
  });
  const protectedWork = [
    /npm ci\b/,
    /npm install\b/,
    /npm view\b/,
    /npm run build(?:\s|:|-|$)/,
    /npm pack\b/,
    /npm publish\b/,
    /npm stage\b/,
  ];
  const firstProtectedAt = steps.findIndex(
    (step) => typeof step?.run === "string" && protectedWork.some((pattern) => pattern.test(step.run)),
  );
  assert.ok(
    firstProtectedAt >= 0 && preflightPosition < firstProtectedAt,
    `${relative} must run the Node policy preflight before dependency, build, registry, pack, or publish work`,
  );
}

function validateNodePolicyAgreement({
  candidate = manifest,
  cliManifest = cliLibraryPkg,
  executableManifest = cliPkg,
  lock = packageLock,
  files = {},
  now = new Date(),
} = {}) {
  const policy = validateNodeRuntimeManifest(candidate, { now });
  const read = (relative) => files[relative] ?? readFileSync(path.join(root, relative), "utf8");
  assert.equal(pkg.scripts["check:node-policy"], "node scripts/node-runtime-policy.mjs");
  for (const [name, packageManifest] of [["@superbee/cli", cliManifest], ["superbee", executableManifest]]) {
    assert.equal(packageManifest.engines?.node, policy.engine_range, `${name} engine policy drifted`);
  }
  assert.equal(lock.packages["packages/cli"].engines.node, policy.engine_range);
  assert.equal(lock.packages["packages/superbee"].engines.node, policy.engine_range);
  for (const [, workspace] of Object.entries(lock.packages).filter(([location, entry]) => location.startsWith("packages/") && entry?.devDependencies?.["@types/node"])) {
    assert.match(workspace.devDependencies["@types/node"], /^\^22\./, "@types/node must remain on the compatibility-floor major");
  }

  assert.equal(count(read("packages/cli/build.mjs"), new RegExp(`target:\\s*["']${policy.build_target}["']`, "g")), 2);
  assert.equal(count(read("packages/superbee/scripts/build-bundle.mjs"), new RegExp(`target:\\s*["']${policy.build_target}["']`, "g")), 3);
  assert.equal(read(".node-version").trim(), policy.default_runtime);
  assert.deepEqual(candidate.runtime_nodes, [Number(policy.compatibility_floor.split(".")[0]), policy.forward_probe]);
  assert.equal(candidate.singleton_node, policy.default_runtime);
  assert.deepEqual(candidate.lanes.runtime.nodes, candidate.runtime_nodes);
  assert.deepEqual(candidate.lanes[`smoke-node-${policy.compatibility_floor.split(".")[0]}`].nodes, [policy.compatibility_floor]);

  const ci = read(".github/workflows/ci-tests.yml");
  assert.match(ci, new RegExp(`node-version: \\[${candidate.runtime_nodes.join(", ")}\\]`));
  assert.equal(count(ci, new RegExp(`node-version: ${policy.default_runtime.replaceAll(".", "\\.")}`, "g")), 8);
  assert.equal(count(ci, new RegExp(`node-version: ${policy.compatibility_floor.replaceAll(".", "\\.")}`, "g")), 1);
  assert.equal(count(read(".github/workflows/mutation-tests.yml"), new RegExp(`node-version: ${policy.default_runtime.replaceAll(".", "\\.")}`, "g")), 1);

  const releaseWorkflows = {
    ".github/workflows/release.yml": 2,
    ".github/workflows/release-finalize.yml": 1,
    ".github/workflows/release-cli-library.yml": 2,
    ".github/workflows/release-cli-library-finalize.yml": 1,
    ".github/workflows/release-libraries.yml": 3,
    ".github/workflows/release-libraries-finalize.yml": 1,
  };
  for (const [relative, expected] of Object.entries(releaseWorkflows)) {
    assert.equal(count(read(relative), new RegExp(`node-version: ${policy.default_runtime.replaceAll(".", "\\.")}`, "g")), expected, `${relative} release runtime drifted`);
  }
  for (const relative of [
    ".github/workflows/release.yml",
    ".github/workflows/release-cli-library.yml",
    ".github/workflows/release-libraries.yml",
  ]) {
    assertReleasePreflightOrder(read(relative), relative);
  }

  const supported = /supported\s+Node\.js 22, 24, or 26 release(?:s)?/;
  for (const [name, text] of [["README.md", rootReadme], ["packages/superbee/README.md", npmReadme], ["CONTRIBUTING.md", contributing]]) {
    assert.match(text, supported, `${name} must name the finite supported Node lines`);
    assert.match(text, /22\.14\.0/, `${name} must name the exact minimum patch`);
    assert.doesNotMatch(text, /Node\.js 22 or newer/, `${name} must not advertise an unbounded Node range`);
  }
}

test("the Node runtime policy agrees across every first-party projection", () => {
  validateNodePolicyAgreement();
});

test("Node runtime lifecycle boundaries fail closed", () => {
  const pending = structuredClone(manifest);
  assert.doesNotThrow(() => validateNodeRuntimeManifest(pending, { now: new Date("2026-10-24T23:59:59Z") }));
  assert.throws(
    () => validateNodeRuntimeManifest(pending, { now: new Date("2026-10-25T00:00:00Z") }),
    /release pin expired/,
  );

  const futurePinReview = structuredClone(manifest.node_policy);
  futurePinReview.release_pin_reviewed_at = "2099-01-01";
  assert.throws(
    () => validateNodeRuntimePolicy(futurePinReview, { now: new Date("2026-09-24T00:00:00Z") }),
    /release pin review cannot be in the future/,
  );
  const longPinWindow = structuredClone(manifest.node_policy);
  longPinWindow.release_pin_refresh_by = "2026-10-25";
  assert.throws(
    () => validateNodeRuntimePolicy(longPinWindow, { now: new Date("2026-09-24T00:00:00Z") }),
    /within 30 days/,
  );
  longPinWindow.release_pin_refresh_by = "2099-12-31";
  assert.throws(
    () => validateNodeRuntimePolicy(longPinWindow, { now: new Date("2026-09-24T00:00:00Z") }),
    /within 30 days/,
  );

  const movableBoundaries = structuredClone(manifest.node_policy);
  movableBoundaries.forward_review.review_after = "2099-12-31";
  assert.throws(
    () => validateNodeRuntimePolicy(movableBoundaries, { now: new Date("2026-09-24T00:00:00Z") }),
    /fixed at 2026-10-28/,
  );
  movableBoundaries.forward_review.review_after = "2026-10-28";
  movableBoundaries.floor_retirement.retire_by = "2099-12-31";
  assert.throws(
    () => validateNodeRuntimePolicy(movableBoundaries, { now: new Date("2026-09-24T00:00:00Z") }),
    /fixed at 2027-04-30/,
  );

  const forwardDue = structuredClone(manifest);
  forwardDue.node_policy.release_pin_reviewed_at = "2026-10-28";
  forwardDue.node_policy.release_pin_refresh_by = "2026-11-27";
  assert.throws(
    () => validateNodeRuntimeManifest(forwardDue, { now: new Date("2026-10-28T00:00:00Z") }),
    /forward review is due/,
  );

  const retain = structuredClone(forwardDue);
  retain.node_policy.forward_review = {
    review_after: "2026-10-28",
    disposition: "retain_probe",
    decided_at: "2026-10-28",
    decided_by: "human:maintainer",
    evidence: REVIEW_EVIDENCE,
    revisit_by: "2027-04-26",
  };
  assert.doesNotThrow(() => validateNodeRuntimeManifest(retain, { now: new Date("2026-10-28T00:00:00Z") }));
  retain.node_policy.forward_review.revisit_by = "2027-04-27";
  assert.throws(
    () => validateNodeRuntimeManifest(retain, { now: new Date("2026-10-28T00:00:00Z") }),
    /within 180 days/,
  );

  const repeatedRetain = structuredClone(retain.node_policy);
  repeatedRetain.release_pin_reviewed_at = "2027-04-26";
  repeatedRetain.release_pin_refresh_by = "2027-05-26";
  repeatedRetain.forward_review.decided_at = "2027-04-26";
  repeatedRetain.forward_review.revisit_by = "2027-10-23";
  assert.throws(
    () => validateNodeRuntimePolicy(repeatedRetain, { now: new Date("2027-04-26T00:00:00Z") }),
    /one-cycle cap of 2027-04-26/,
  );

  const pendingWithDecision = structuredClone(manifest.node_policy);
  pendingWithDecision.forward_review.decided_at = "2026-10-28";
  assert.throws(
    () => validateNodeRuntimePolicy(pendingWithDecision, { now: new Date("2026-09-24T00:00:00Z") }),
    /pending forward review cannot set a decision date/,
  );

  const decided = structuredClone(retain.node_policy);
  decided.forward_review.decided_at = "2026-10-27";
  assert.throws(
    () => validateNodeRuntimePolicy(decided, { now: new Date("2026-10-28T00:00:00Z") }),
    /cannot predate the review boundary/,
  );
  decided.forward_review.decided_at = "2026-10-29";
  assert.throws(
    () => validateNodeRuntimePolicy(decided, { now: new Date("2026-10-28T00:00:00Z") }),
    /cannot be in the future/,
  );

  const weakEvidence = structuredClone(retain.node_policy);
  weakEvidence.forward_review.evidence = "reviews/node-26-promotion";
  assert.throws(
    () => validateNodeRuntimePolicy(weakEvidence, { now: new Date("2026-10-28T00:00:00Z") }),
    /structured Review evidence/,
  );

  const inertPromote = structuredClone(forwardDue);
  inertPromote.node_policy.forward_review = {
    ...retain.node_policy.forward_review,
    disposition: "promote_default",
    revisit_by: null,
  };
  assert.throws(
    () => validateNodeRuntimeManifest(inertPromote, { now: new Date("2026-10-28T00:00:00Z") }),
    /promote_default must make Node 26 the default runtime/,
  );
  const promoted = structuredClone(inertPromote);
  promoted.node_policy.default_runtime = "26.0.0";
  promoted.singleton_node = "26.0.0";
  assert.doesNotThrow(() => validateNodeRuntimeManifest(promoted, { now: new Date("2026-10-28T00:00:00Z") }));

  const inertRetire = structuredClone(forwardDue);
  inertRetire.node_policy.forward_review = {
    ...retain.node_policy.forward_review,
    disposition: "retire_probe",
    revisit_by: null,
  };
  assert.throws(
    () => validateNodeRuntimeManifest(inertRetire, { now: new Date("2026-10-28T00:00:00Z") }),
    /retire_probe must remove Node 26 from supported majors/,
  );
  const retired = structuredClone(inertRetire);
  retired.node_policy.supported_majors = [22, 24];
  retired.node_policy.engine_range = "^22.14.0 || ^24.0.0";
  retired.runtime_nodes = [22];
  assert.doesNotThrow(() => validateNodeRuntimeManifest(retired, { now: new Date("2026-10-28T00:00:00Z") }));

  const missingPendingProbe = structuredClone(manifest);
  missingPendingProbe.runtime_nodes = [22];
  assert.throws(
    () => validateNodeRuntimeManifest(missingPendingProbe, { now: new Date("2026-09-24T00:00:00Z") }),
    /pending runtime_nodes must equal \[22,26\]/,
  );

  const demotedPending = structuredClone(manifest);
  demotedPending.node_policy.default_runtime = "22.14.0";
  demotedPending.node_policy.supported_majors = [22, 26];
  demotedPending.node_policy.engine_range = "^22.14.0 || ^26.0.0";
  demotedPending.singleton_node = "22.14.0";
  assert.throws(
    () => validateNodeRuntimeManifest(demotedPending, { now: new Date("2026-09-24T00:00:00Z") }),
    /pending must use Node 24 as the default major/,
  );

  const leapfroggedPending = structuredClone(manifest);
  leapfroggedPending.node_policy.default_runtime = "28.0.0";
  leapfroggedPending.node_policy.supported_majors = [22, 26, 28];
  leapfroggedPending.node_policy.engine_range = "^22.14.0 || ^26.0.0 || ^28.0.0";
  leapfroggedPending.singleton_node = "28.0.0";
  assert.throws(
    () => validateNodeRuntimeManifest(leapfroggedPending, { now: new Date("2026-09-24T00:00:00Z") }),
    /pending must use Node 24 as the default major/,
  );

  const expandedPending = structuredClone(manifest);
  expandedPending.node_policy.supported_majors = [22, 24, 26, 28];
  expandedPending.node_policy.engine_range = "^22.14.0 || ^24.0.0 || ^26.0.0 || ^28.0.0";
  assert.throws(
    () => validateNodeRuntimeManifest(expandedPending, { now: new Date("2026-09-24T00:00:00Z") }),
    /pending supported_majors must equal \[22,24,26\]/,
  );

  const unexpectedPendingRuntime = structuredClone(manifest);
  unexpectedPendingRuntime.runtime_nodes = [22, 24, 26];
  assert.throws(
    () => validateNodeRuntimeManifest(unexpectedPendingRuntime, { now: new Date("2026-09-24T00:00:00Z") }),
    /pending runtime_nodes must equal \[22,26\]/,
  );

  const refreshedNode24 = structuredClone(manifest);
  refreshedNode24.node_policy.default_runtime = "24.22.0";
  refreshedNode24.singleton_node = "24.22.0";
  assert.doesNotThrow(
    () => validateNodeRuntimeManifest(refreshedNode24, { now: new Date("2026-09-24T00:00:00Z") }),
  );

  const floorDue = structuredClone(retired);
  floorDue.node_policy.release_pin_reviewed_at = "2027-04-30";
  floorDue.node_policy.release_pin_refresh_by = "2027-05-30";
  assert.throws(
    () => validateNodeRuntimeManifest(floorDue, { now: new Date("2027-04-30T00:00:00Z") }),
    /support retires/,
  );
});

test("release build jobs have one closed checkout, runtime, and policy trust prefix", () => {
  const preflight = `      - name: ${RELEASE_PREFLIGHT_NAME}\n        run: ${RELEASE_PREFLIGHT_RUN}`;
  const shim = `      - name: Prepend fake Node and npm shims
        run: |
          mkdir -p /tmp/fake-bin
          for executable in node npm; do
            printf '#!/bin/sh\\nexit 0\\n' > "/tmp/fake-bin/$executable"
            chmod +x "/tmp/fake-bin/$executable"
          done
          echo "/tmp/fake-bin" >> "$GITHUB_PATH"`;

  for (const relative of Object.keys(RELEASE_CHECKOUT_INPUTS)) {
    const workflow = readFileSync(path.join(root, relative), "utf8");
    const mutations = new Map([
      ["fake shim before checkout", workflow.replace("    steps:\n", `    steps:\n${shim}\n`)],
      ["fake shim between runtime setup and policy", workflow.replace(preflight, `${shim}\n${preflight}`)],
      ["workflow env", workflow.replace("permissions: {}", "permissions: {}\n\nenv:\n  PATH: /tmp/fake-bin")],
      ["workflow defaults", workflow.replace("permissions: {}", "permissions: {}\n\ndefaults:\n  run:\n    shell: bash")],
      ["job env", workflow.replace("  build:\n", "  build:\n    env:\n      PATH: /tmp/fake-bin\n")],
      ["job defaults", workflow.replace("  build:\n", "  build:\n    defaults:\n      run:\n        working-directory: /tmp\n")],
      ["job container", workflow.replace("  build:\n", "  build:\n    container: node:24\n")],
      ["job services", workflow.replace("  build:\n", "  build:\n    services:\n      fake:\n        image: node:24\n")],
      ["job continue-on-error", workflow.replace("  build:\n", "  build:\n    continue-on-error: true\n")],
      ["changed runs-on", workflow.replace("    runs-on: ubuntu-latest", "    runs-on: macos-latest")],
      ["changed checkout action", workflow.replace(CHECKOUT_ACTION, "actions/checkout@main")],
      ["checkout condition", workflow.replace(`      - uses: ${CHECKOUT_ACTION}`, `      - uses: ${CHECKOUT_ACTION}\n        if: true`)],
      ["changed setup-node action", workflow.replace(SETUP_NODE_ACTION, "actions/setup-node@main")],
      ["changed setup-node version", workflow.replace("          node-version: 24.21.0", "          node-version: 24.20.0")],
      ["changed setup-node inputs", workflow.replace("          cache: npm", "          cache: yarn")],
      ["unknown setup-node input", workflow.replace("          cache: npm", "          cache: npm\n          registry-url: https://registry.npmjs.org")],
      ["setup-node condition", workflow.replace(`      - uses: ${SETUP_NODE_ACTION}`, `      - uses: ${SETUP_NODE_ACTION}\n        if: true`)],
      ["commented preflight", workflow.replace(preflight, preflight.split("\n").map((line) => `${line.slice(0, 6)}# ${line.slice(6)}`).join("\n"))],
      ["late preflight", workflow.replace(`${preflight}\n      - run: npm ci --ignore-scripts`, `      - run: npm ci --ignore-scripts\n${preflight}`)],
    ]);
    for (const [field, addition] of [
      ["if", "        if: false"],
      ["continue-on-error", "        continue-on-error: true"],
      ["working-directory", "        working-directory: /tmp"],
      ["env", "        env:\n          NODE_OPTIONS: --require /dev/null"],
      ["shell", "        shell: bash {0}"],
      ["unknown", "        timeout-minutes: 1"],
    ]) {
      mutations.set(
        `preflight ${field}`,
        workflow.replace(`        run: ${RELEASE_PREFLIGHT_RUN}`, `        run: ${RELEASE_PREFLIGHT_RUN}\n${addition}`),
      );
    }
    for (const [name, mutated] of mutations) {
      assert.notEqual(mutated, workflow, `${relative} ${name} mutation must apply`);
      assert.throws(
        () => validateNodePolicyAgreement({ files: { [relative]: mutated } }),
        undefined,
        `${relative} must reject ${name}`,
      );
    }
  }
});

test("release trust validation follows resolved YAML mappings", () => {
  const preflight = `      - name: ${RELEASE_PREFLIGHT_NAME}\n        run: ${RELEASE_PREFLIGHT_RUN}`;
  const selectiveNodeOptions = `--import=data:text/javascript,if(process.argv%5B1%5D%3F.endsWith(%22node-runtime-policy.mjs%22))process.exit(0)`;
  for (const relative of Object.keys(RELEASE_CHECKOUT_INPUTS)) {
    const workflow = readFileSync(path.join(root, relative), "utf8");
    const mutations = new Map([
      ["quoted workflow env", workflow.replace("permissions: {}", `permissions: {}\n\n"env":\n  NODE_OPTIONS: '${selectiveNodeOptions}'`)],
      ["quoted workflow defaults", workflow.replace("permissions: {}", "permissions: {}\n\n\"defaults\":\n  run:\n    shell: bash")],
      ["quoted job env", workflow.replace("  build:\n", `  build:\n    "env":\n      NODE_OPTIONS: '${selectiveNodeOptions}'\n`)],
      ["quoted job defaults", workflow.replace("  build:\n", "  build:\n    \"defaults\":\n      run:\n        shell: bash\n")],
      ["quoted job container", workflow.replace("  build:\n", "  build:\n    \"container\": node:24\n")],
      ["quoted job services", workflow.replace("  build:\n", "  build:\n    \"services\":\n      fake:\n        image: node:24\n")],
      ["quoted job continue-on-error", workflow.replace("  build:\n", "  build:\n    \"continue-on-error\": true\n")],
      ["quoted step env", workflow.replace(`        run: ${RELEASE_PREFLIGHT_RUN}`, `        run: ${RELEASE_PREFLIGHT_RUN}\n        \"env\":\n          NODE_OPTIONS: '${selectiveNodeOptions}'`)],
      ["workflow merge alias", workflow.replace(
        "permissions: {}",
        `permissions: {}\n\nx-workflow-modifiers: &workflow-modifiers\n  env:\n    NODE_OPTIONS: '${selectiveNodeOptions}'\n<<: *workflow-modifiers`,
      )],
      ["job merge alias", workflow
        .replace("permissions: {}", "permissions: {}\n\nx-job-modifiers: &job-modifiers\n  defaults:\n    run:\n      shell: bash")
        .replace("  build:\n", "  build:\n    <<: *job-modifiers\n")],
      ["step merge alias", workflow
        .replace("permissions: {}", `permissions: {}\n\nx-step-modifiers: &step-modifiers\n  env:\n    NODE_OPTIONS: '${selectiveNodeOptions}'`)
        .replace(`        run: ${RELEASE_PREFLIGHT_RUN}`, `        run: ${RELEASE_PREFLIGHT_RUN}\n        <<: *step-modifiers`)],
      ["duplicate mapping key", workflow.replace("permissions: {}", "permissions: {}\npermissions: {}")],
      ["YAML parser failure", workflow.replace("permissions: {}", "permissions: [")],
    ]);
    for (const [name, mutated] of mutations) {
      assert.notEqual(mutated, workflow, `${relative} ${name} mutation must apply`);
      assert.throws(
        () => validateNodePolicyAgreement({ files: { [relative]: mutated } }),
        undefined,
        `${relative} must reject ${name}`,
      );
    }

    const quotedButEquivalent = workflow.replace(
      preflight,
      `      - "name": ${RELEASE_PREFLIGHT_NAME}\n        "run": ${RELEASE_PREFLIGHT_RUN}`,
    );
    assert.notEqual(quotedButEquivalent, workflow, `${relative} quoted step-key mutation must apply`);
    assert.doesNotThrow(
      () => validateNodePolicyAgreement({ files: { [relative]: quotedButEquivalent } }),
      `${relative} must accept semantically identical quoted prefix keys`,
    );
  }
});

test("the reviewed NODE_OPTIONS bypass is selective and must remain forbidden", () => {
  const args = [path.join(root, "scripts", "node-runtime-policy.mjs"), "--date", "2026-10-25"];
  const expired = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  assert.notEqual(expired.status, 0, "the expired-date policy baseline must fail");
  assert.match(expired.stderr, /release pin expired/);

  const source = 'if(process.argv[1]?.endsWith("node-runtime-policy.mjs"))process.exit(0)';
  const env = { ...process.env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(source)}` };
  const bypassed = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
  assert.equal(bypassed.status, 0, "the forbidden modifier can selectively neutralize the policy process");
  const unrelated = spawnSync(process.execPath, ["-e", "process.exit(0)"], { cwd: root, env, encoding: "utf8" });
  assert.equal(unrelated.status, 0, "the selective modifier leaves later Node work available");
});

test("the Node policy agreement fails red when a projection drifts", () => {
  const cliManifest = structuredClone(cliLibraryPkg);
  cliManifest.engines.node = ">=22";
  assert.throws(() => validateNodePolicyAgreement({ cliManifest }), /@superbee\/cli engine policy drifted/);
});

function projectionRows(text, name) {
  const start = `<!-- contributing-${name}:start -->`;
  const end = `<!-- contributing-${name}:end -->`;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  assert.ok(startAt >= 0, `missing ${name} projection start`);
  assert.ok(endAt > startAt, `missing ${name} projection end`);
  return text
    .slice(startAt + start.length, endAt)
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim().replaceAll("`", "")));
}

function validateContributorAuthority(
  text,
  candidateManifest = manifest,
  packageJson = pkg,
  sources = { okfBundleSource, linkSource, sampleOkfReference },
) {
  for (const heading of ["## OKF compatibility", "## Findings and commitments", "## Assurance evolution"]) {
    assert.match(text, new RegExp(`^${heading}$`, "m"), `missing exact contributor anchor ${heading}`);
  }
  for (const pointer of [
    "scripts/ci-lanes.json",
    ".github/workflows/ci-tests.yml",
    "conventions/task",
    "conventions/review",
  ]) {
    assert.ok(text.includes(pointer), `missing contributor pointer ${pointer}`);
  }

  const laneRows = Object.keys(candidateManifest.lanes).map((name) => {
    const lane = candidateManifest.lanes[name];
    assert.ok(lane, `required contributor lane ${name} is missing`);
    if (lane.script) {
      assert.ok(packageJson.scripts[lane.script], `contributor lane ${name} references missing package script`);
    }
    const command = lane.script ? `npm run ${lane.script}` : lane.trigger ? `${lane.trigger} only` : "workflow only";
    return [name, command, name, lane.nodes.join(", ")];
  });
  assert.deepEqual(
    projectionRows(text, "ci-lanes"),
    laneRows,
    "the contributor lane projection must match the executable manifest and package scripts",
  );

  assert.deepEqual(projectionRows(text, "okf-matrix"), [
    ["0.1", "--okf-version 0.1", "retain 0.1", "top-level timestamp", "this section plus core edition tests"],
    [
      "0.2",
      "default",
      "retain 0.2",
      "generated.at when present, with legacy timestamp fallback for reads",
      "this section plus core edition tests",
    ],
  ]);
  assert.match(sources.okfBundleSource, /SUPPORTED_OKF_AUTHORING_VERSIONS = \["0\.1", "0\.2"\]/);
  assert.match(sources.okfBundleSource, /DEFAULT_OKF_AUTHORING_VERSION = "0\.2"/);
  for (const [generated, expected] of [
    [{ at: "standard" }, "standard"],
    [{ at: null }, null],
    [{ at: undefined }, "legacy"],
    [{}, "legacy"],
    [null, "legacy"],
    [[], "legacy"],
  ]) {
    assert.equal(meaningfulChangeTimeValue({ generated, timestamp: "legacy" }), expected);
  }
  assert.match(sources.linkSource, /return `\$\{rel\}\.md`;/);
  assert.match(sources.sampleOkfReference, /description: A version-scoped OKF v0\.1 interop reference/);
  assert.match(sources.sampleOkfReference, /This reference is scoped to OKF v0\.1 interop/);

  for (const policy of [
    /A specification statement is not a work commitment/,
    /every release-relevant `VIOLATED` or `UNKNOWN` statement must link to/,
    /Missing, stale, unavailable, or unqueryable evidence is not an\s+approval/,
    /five most recent completed units of the same change type and assurance stage within[\s\S]*previous 180 days/,
    /Fewer than three comparable Review records is insufficient evidence/,
    /persist the exact selection at[\s\S]*with a report of verdicts/,
    /Review that report as a `subject_kind: process` Review/,
    /leaves the current assurance stage unchanged/,
  ]) {
    assert.match(text, policy, `missing contributor workflow policy ${policy}`);
  }
}

function validateLaneManifest(candidate, packageJson = pkg, sources = wrapperSources) {
  assert.equal(candidate.schema, "superbee.ci-lanes.v1");
  assert.equal(candidate.path_skipping, false, "the first implementation cannot skip by path");
  assert.deepEqual(candidate.components.map((row) => row.command), packageJson.scripts.check.split(" && "));
  assert.deepEqual(
    [...candidate.required_jobs].sort(),
    requiredLaneNames(candidate).sort(),
    "required_jobs must equal the automatically run lane set",
  );

  const ids = candidate.components.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "component ids must be unique");
  const components = new Map(candidate.components.map((row) => [row.id, row]));
  const claimed = new Map(ids.map((id) => [id, []]));
  for (const [laneName, lane] of Object.entries(candidate.lanes)) {
    assert.equal(typeof lane.display_name, "string", `${laneName} must pin its workflow display name`);
    assert.ok(lane.display_name.length > 0, `${laneName} display name cannot be blank`);
    if (lane.required === false) {
      assert.equal(lane.workflow_only, true, `${laneName} must be workflow-only when not required`);
      assert.equal(lane.trigger, "workflow_dispatch", `${laneName} must declare an explicit manual trigger`);
      assert.equal(typeof lane.workflow, "string", `${laneName} must name its manual workflow`);
    }
    for (const id of lane.components) {
      assert.ok(claimed.has(id), `${laneName} claims unknown component ${id}`);
      claimed.get(id).push(laneName);
    }
    if (!lane.script) continue;
    const command = packageJson.scripts[lane.script];
    assert.ok(command, `${laneName} references missing package script ${lane.script}`);
    if (lane.wrapper) {
      assert.ok(command.includes(lane.wrapper), `${laneName} package script does not invoke wrapper ${lane.wrapper}`);
      const source = sources[lane.wrapper];
      assert.equal(typeof source, "string", `${laneName} wrapper source ${lane.wrapper} is unavailable`);
      for (const id of lane.components) {
        const literal = lane.wrapper_component_literals?.[id];
        assert.ok(literal, `${laneName} does not declare a wrapper literal for ${id}`);
        assert.ok(source.includes(literal), `${laneName} wrapper does not reach ${id} through literal ${literal}`);
      }
      continue;
    }
    for (const id of [...lane.components, ...(lane.prerequisites ?? [])]) {
      const component = components.get(id);
      assert.ok(component, `${laneName} references unknown executable component ${id}`);
      assert.ok(
        command.includes(component.command),
        `${laneName} script ${lane.script} does not execute ${id}: ${component.command}`,
      );
    }
  }
  for (const component of candidate.components) {
    assert.deepEqual(claimed.get(component.id), [component.owner], `${component.id} must have one intentional owner`);
  }
}

test("the lane manifest owns every complete local-check component exactly once", () => {
  validateLaneManifest(manifest);
  assert.deepEqual(REQUIRED_JOBS, manifest.required_jobs);
});

test("the contributor authority agrees with CI topology and both OKF editions", () => {
  validateContributorAuthority(contributing);
});

test("contributor projections fail red on lane, edition, pointer, and assurance drift", () => {
  const renamedLane = structuredClone(manifest);
  renamedLane.lanes.runtime.script = "ci:runtime-renamed";
  assert.throws(
    () => validateContributorAuthority(contributing, renamedLane),
    /missing package script/,
  );

  assert.throws(
    () => validateContributorAuthority(contributing.replace("npm run ci:runtime", "npm run test")),
    /contributor lane projection/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace("retain 0.2", "upgrade to 0.2")),
    /strictly deep-equal/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace(".github/workflows/ci-tests.yml", "CI")),
    /missing contributor pointer/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace("persist the exact selection at", "inspect a sample at")),
    /missing contributor workflow policy/,
  );
  assert.throws(
    () => validateContributorAuthority(contributing.replace("leaves the current assurance stage unchanged", "permits an exception")),
    /missing contributor workflow policy/,
  );
});

test("lane ownership is pinned to executing scripts", () => {
  const scriptMutations = [
    ["ci:distribution", "npm run verify:npm-package", /skill-drift-proof/],
    ["ci:scripts", "npm run build", /script-tests/],
    ["ci:browser", "npm run build && npm run test:browser -w @superbee\/mcp-app", /ui-end-to-end/],
  ];
  for (const [script, replacement, error] of scriptMutations) {
    const changedPackage = structuredClone(pkg);
    changedPackage.scripts[script] = replacement;
    assert.throws(() => validateLaneManifest(manifest, changedPackage), error, script);
  }

  const incomplete = structuredClone(manifest);
  incomplete.required_jobs.pop();
  assert.throws(() => validateLaneManifest(incomplete), /required_jobs must equal the automatically run lane set/);
});

test("runtime-sensitive suites are identical on Node 22 and 26 and platform lanes pin their runtimes", () => {
  assert.deepEqual(manifest.runtime_nodes, [22, 26]);
  assert.deepEqual(manifest.lanes.runtime.nodes, manifest.runtime_nodes);
  assert.equal(
    pkg.scripts[manifest.lanes.runtime.script],
    "npm run build && npm run typecheck:after-build && npm test --workspaces --if-present --ignore-scripts",
  );
  assert.equal(cliPkg.scripts.pretest, "node build.mjs local-dev", "ordinary npm test must keep its build prerequisite");
  assert.doesNotMatch(cliPkg.scripts.test, /build\.mjs/, "the CI runtime lane must be able to skip the pretest rebuild");
  for (const [name, lane] of Object.entries(manifest.lanes)) {
    if (name === "runtime" || name === "smoke-node-22") continue;
    assert.deepEqual(lane.nodes, [manifest.singleton_node], `${name} must not amplify across runtime versions`);
  }
  assert.deepEqual(cliPkg.os, ["darwin", "linux"], "the maintained executable admits only its supported hosts");
});

test("the aliasing-host lane pins a fail-closed host expectation on both host classes", () => {
  assert.equal(manifest.host_expectation_variable, "SUPERBEE_TEST_EXPECT_ALIASING_HOST");
  const lane = manifest.lanes["aliasing-host"];
  assert.equal(lane.script, "ci:aliasing-host", "the lane runs the scoped host-class target");
  assert.deepEqual(lane.components, [], "scoped coverage is proven by aliasing-host-coverage, not owned components");
  assert.equal(lane.runs_on, "macos-latest");
  assert.equal(lane.expect_aliasing_host, "1");
  assert.equal(manifest.lanes.runtime.expect_aliasing_host, "0");
  for (const name of ["runtime", "aliasing-host"]) {
    assert.match(manifest.lanes[name].host_guard, /PROBE-NAME/, `${name} must probe the host class before testing`);
  }
  assert.ok(manifest.required_jobs.includes("aliasing-host"), "the aliasing-host lane must be required");
});

test("the fail-closed result contract accepts success only", () => {
  const green = Object.fromEntries(REQUIRED_JOBS.map((name) => [name, { result: "success", outputs: {} }]));
  assert.deepEqual(evaluateRequiredResults(green), { ok: true, errors: [] });
  for (const rejected of ["failure", "cancelled", "timed_out", "neutral", "skipped", undefined]) {
    const results = structuredClone(green);
    results[REQUIRED_JOBS[0]] = rejected === undefined ? {} : { result: rejected };
    assert.equal(evaluateRequiredResults(results).ok, false, `${String(rejected)} must fail closed`);
  }
  const missing = structuredClone(green);
  delete missing[REQUIRED_JOBS[0]];
  assert.equal(evaluateRequiredResults(missing).ok, false, "a removed dependency must fail closed");
  const renamed = structuredClone(green);
  renamed[`${REQUIRED_JOBS[0]}-renamed`] = renamed[REQUIRED_JOBS[0]];
  delete renamed[REQUIRED_JOBS[0]];
  assert.equal(evaluateRequiredResults(renamed).ok, false, "a renamed dependency must fail closed");
});


test("a missing core build gives local scripts callers an actionable message", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-script-build-"));
  try {
    await mkdir(path.join(scratch, "scripts"));
    await symlink(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir");
    for (const name of [
      "ci-lanes.test.mjs",
      "ci-aggregate.mjs",
      "ci-lanes.json",
      "is-main-module.mjs",
      "node-runtime-policy.mjs",
      "workflow-step-test-helper.mjs",
    ]) {
      await copyFile(path.join(root, "scripts", name), path.join(scratch, "scripts", name));
    }
    const result = spawnSync(process.execPath, [path.join(scratch, "scripts", "ci-lanes.test.mjs")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Run npm run build before npm run test:scripts/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
