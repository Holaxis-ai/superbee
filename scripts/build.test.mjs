import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWorkspace, TSC_WORKSPACES, assertBuildLifecycle } from "./build.mjs";
import { uiBuildInvocations, UI_DIST_PREREQUISITE_WORKSPACES } from "../packages/cli/scripts/embed-ui-assets.mjs";
import { prepareDistributionTypes, DISTRIBUTION_TYPE_WORKSPACES } from "../packages/superbee/build.mjs";

function stages(failAt) {
  const events = [];
  const assets = [];
  const sources = [];
  const record = (name, value) => {
    events.push([name, value]);
    if (name === failAt) throw new Error(`failed ${name}`);
  };
  return {
    events, assets, sources,
    operations: {
      validate: () => record("validate"),
      sourceFacts: () => { const source = { commit: null, dirty: true }; sources.push(source); return source; },
      compile: async workspace => record(`compile:${workspace}`),
      prepare: async ({ compiledWorkspaces }) => {
        record("prepare", compiledWorkspaces);
        const inputs = { inputs: [`fresh-ui-${assets.length}`, `fresh-mcp-${assets.length}`] };
        assets.push(inputs);
        return inputs;
      },
      runtime: async options => record("runtime", options),
      distribution: async (channel, options) => { assert.equal(channel, "local-dev"); record("distribution", options); },
    },
  };
}

test("root builds each workspace once and shares fresh assets and provenance only within the invocation", async () => {
  const fixture = stages();
  await buildWorkspace(fixture.operations);
  await buildWorkspace(fixture.operations);
  const expected = ["validate", ...TSC_WORKSPACES.flatMap(workspace => workspace === "mcp-app"
    ? ["prepare", `compile:${workspace}`] : [`compile:${workspace}`]), "runtime", "distribution"];
  assert.deepEqual(fixture.events.map(([event]) => event), [...expected, ...expected]);
  for (let invocation = 0; invocation < 2; invocation++) {
    const events = fixture.events.slice(invocation * expected.length, (invocation + 1) * expected.length);
    assert.deepEqual(events.find(([name]) => name === "prepare")[1], TSC_WORKSPACES.slice(0, TSC_WORKSPACES.indexOf("mcp-app")));
    const runtime = events.find(([name]) => name === "runtime")[1];
    const distribution = events.find(([name]) => name === "distribution")[1];
    assert.equal(runtime.preparedInputs, fixture.assets[invocation]);
    assert.equal(distribution.preparedInputs, runtime.preparedInputs);
    assert.equal(runtime.source, fixture.sources[invocation]);
    assert.equal(distribution.source, runtime.source);
    assert.deepEqual(distribution.compiledWorkspaces, TSC_WORKSPACES);
  }
  assert.notEqual(fixture.assets[0], fixture.assets[1]);
});

test("root aborts on every failed stage without consuming or recording its output", async () => {
  for (const stage of ["validate", ...TSC_WORKSPACES.map(name => `compile:${name}`), "prepare", "runtime", "distribution"]) {
    const fixture = stages(stage);
    await assert.rejects(buildWorkspace(fixture.operations), new RegExp(`failed ${stage}`));
    assert.equal(fixture.events.at(-1)[0], stage);
  }
});

test("standalone UI builds always prepare dependencies and rebuild UI; root reuses only supplied completed dependencies", () => {
  const standalone = ["@superbee/core", "@superbee/view-runtime", "@superbee/ui"];
  for (let invocation = 0; invocation < 2; invocation++) {
    assert.deepEqual(uiBuildInvocations(), standalone.map(name => ["run", "build", `--workspace=${name}`]));
    assert.deepEqual(uiBuildInvocations(TSC_WORKSPACES), [["run", "build", "--workspace=@superbee/ui", "--ignore-scripts"]]);
  }
  assert.deepEqual(uiBuildInvocations(["core"]).map(args => args[2]), ["@superbee/view-runtime", "@superbee/markdown-renderer", "@superbee/ui"].map(name => `--workspace=${name}`));
});

test("standalone declaration preparation is fresh, ordered, and fails before dependent work; root reuses completed projects", async () => {
  const calls = [];
  const compile = async workspace => calls.push(workspace);
  await prepareDistributionTypes(undefined, compile);
  await prepareDistributionTypes(TSC_WORKSPACES, compile);
  await prepareDistributionTypes(undefined, compile);
  assert.deepEqual(calls, [...DISTRIBUTION_TYPE_WORKSPACES, ...DISTRIBUTION_TYPE_WORKSPACES]);
  const failed = [];
  await assert.rejects(prepareDistributionTypes([], async workspace => {
    failed.push(workspace);
    if (workspace === "view-runtime") throw new Error("tsc failed");
  }), /tsc failed/);
  assert.deepEqual(failed, ["core", "markdown-renderer", "view-runtime"]);
});

test("replaced lifecycle hooks have an explicit parity contract that rejects new work", () => {
  for (const workspace of [...TSC_WORKSPACES, "ui", "cli", "superbee"]) {
    const { scripts } = JSON.parse(readFileSync(new URL(`../packages/${workspace}/package.json`, import.meta.url), "utf8"));
    assert.doesNotThrow(() => assertBuildLifecycle(workspace, scripts));
    assert.throws(() => assertBuildLifecycle(workspace, { ...scripts, prebuild: "node extra-check.mjs" }), /lifecycle changed/);
    assert.throws(() => assertBuildLifecycle(workspace, { ...scripts, postbuild: "node extra-check.mjs" }), /lifecycle changed/);
    if (["mcp-app", "cli", "superbee"].includes(workspace)) {
      assert.throws(() => assertBuildLifecycle(workspace, { ...scripts, build: scripts.build + " && node extra-check.mjs" }), /lifecycle changed/);
    }
  }
});
