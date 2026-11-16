import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const ACTOR = /^(?:human|process):[^\s]+$|^[^\s/]+\/[^\s/]+$/;
const REVIEW_EVIDENCE = /^reviews\/[^\s@]+@sha256:[0-9a-f]{64}$/;
const FORWARD_DISPOSITIONS = new Set(["pending", "promote_default", "retain_probe", "retire_probe"]);
const COMPATIBILITY_FLOOR = "22.14.0";
const FORWARD_PROBE = 26;
const ROLE_TOPOLOGIES = Object.freeze({
  pending: Object.freeze({
    defaultMajor: 24,
    supportedMajors: Object.freeze([22, 24, 26]),
    runtimeNodes: Object.freeze([22, 26]),
  }),
  retain_probe: Object.freeze({
    defaultMajor: 24,
    supportedMajors: Object.freeze([22, 24, 26]),
    runtimeNodes: Object.freeze([22, 26]),
  }),
  promote_default: Object.freeze({
    defaultMajor: 26,
    supportedMajors: Object.freeze([22, 24, 26]),
    runtimeNodes: Object.freeze([22, 26]),
  }),
  retire_probe: Object.freeze({
    defaultMajor: 24,
    supportedMajors: Object.freeze([22, 24]),
    runtimeNodes: Object.freeze([22]),
  }),
});

function assertDate(value, field) {
  assert.equal(typeof value, "string", `${field} must be a YYYY-MM-DD string`);
  assert.match(value, DATE, `${field} must be a YYYY-MM-DD string`);
  const parsed = Date.parse(`${value}T00:00:00Z`);
  assert.ok(Number.isFinite(parsed), `${field} must be a real date`);
  assert.equal(new Date(parsed).toISOString().slice(0, 10), value, `${field} must be a real date`);
}

export function validateNodeRuntimePolicy(policy) {
  assert.equal(typeof policy, "object", "node_policy must be an object");
  assert.ok(policy !== null && !Array.isArray(policy), "node_policy must be an object");

  const floor = EXACT_VERSION.exec(policy.compatibility_floor);
  const runtime = EXACT_VERSION.exec(policy.default_runtime);
  assert.ok(floor, "compatibility_floor must be an exact Node version");
  assert.ok(runtime, "default_runtime must be an exact Node version");
  const floorMajor = Number(floor[1]);
  const defaultMajor = Number(runtime[1]);
  assert.equal(policy.compatibility_floor, COMPATIBILITY_FLOOR, `compatibility_floor must remain ${COMPATIBILITY_FLOOR}`);
  assert.equal(policy.forward_probe, FORWARD_PROBE, `forward_probe must remain Node ${FORWARD_PROBE}`);
  assert.ok(Array.isArray(policy.supported_majors), "supported_majors must be an array");
  assert.equal(new Set(policy.supported_majors).size, policy.supported_majors.length);
  assert.ok(policy.supported_majors.every((major) => Number.isInteger(major) && major % 2 === 0));
  assert.deepEqual(policy.supported_majors, [...policy.supported_majors].sort((a, b) => a - b), "supported_majors must be sorted");
  assert.ok(policy.supported_majors.includes(floorMajor), "supported_majors must include the compatibility floor");
  assert.ok(policy.supported_majors.includes(defaultMajor), "supported_majors must include the default runtime");
  const expectedEngineRange = policy.supported_majors
    .map((major) => major === floorMajor ? `^${policy.compatibility_floor}` : `^${major}.0.0`)
    .join(" || ");
  assert.equal(policy.engine_range, expectedEngineRange, "engine_range must exactly project supported_majors");
  assert.equal(policy.build_target, `node${floorMajor}`);

  const review = policy.forward_review;
  assert.equal(typeof review, "object", "forward_review must be an object");
  assert.ok(review !== null && !Array.isArray(review), "forward_review must be an object");
  assert.ok(FORWARD_DISPOSITIONS.has(review.disposition), "forward_review disposition is unsupported");
  if (review.disposition === "pending") {
    assert.equal(review.decided_at, null, "pending forward review cannot set a decision date");
    assert.equal(review.decided_by, null, "pending forward review cannot fabricate a decision actor");
    assert.equal(review.evidence, null, "pending forward review cannot fabricate evidence");
  } else {
    assertDate(review.decided_at, "forward_review.decided_at");
    assert.match(review.decided_by, ACTOR, "decided forward review must name an OKF actor");
    assert.equal(typeof review.evidence, "string", "decided forward review must cite structured Review evidence");
    assert.match(review.evidence, REVIEW_EVIDENCE, "decided forward review must cite structured Review evidence");
  }
  return policy;
}

export function validateNodeRuntimeManifest(manifest) {
  assert.equal(typeof manifest, "object", "CI lane manifest must be an object");
  assert.ok(manifest !== null && !Array.isArray(manifest), "CI lane manifest must be an object");
  const policy = validateNodeRuntimePolicy(manifest.node_policy);
  const floorMajor = Number(policy.compatibility_floor.split(".")[0]);
  const defaultMajor = Number(policy.default_runtime.split(".")[0]);
  const probe = policy.forward_probe;
  assert.ok(Array.isArray(manifest.runtime_nodes), "runtime_nodes must be an array");
  assert.equal(new Set(manifest.runtime_nodes).size, manifest.runtime_nodes.length, "runtime_nodes must be unique");
  assert.deepEqual(manifest.runtime_nodes, [...manifest.runtime_nodes].sort((a, b) => a - b), "runtime_nodes must be sorted");
  assert.ok(manifest.runtime_nodes.every((major) => policy.supported_majors.includes(major)), "runtime_nodes must be supported majors");
  assert.ok(manifest.runtime_nodes.includes(floorMajor), "runtime_nodes must exercise the compatibility floor");
  assert.equal(manifest.singleton_node, policy.default_runtime, "singleton_node must equal the default runtime selector");

  const disposition = policy.forward_review.disposition;
  const topology = ROLE_TOPOLOGIES[disposition];
  const defaultMessage = disposition === "promote_default"
    ? `promote_default must make Node ${probe} the default runtime`
    : `${disposition} must use Node ${topology.defaultMajor} as the default major`;
  const supportedMessage = disposition === "retire_probe"
    ? `retire_probe must remove Node ${probe} from supported majors and use [${topology.supportedMajors}]`
    : `${disposition} supported_majors must equal [${topology.supportedMajors}]`;
  assert.equal(defaultMajor, topology.defaultMajor, defaultMessage);
  assert.deepEqual(policy.supported_majors, topology.supportedMajors, supportedMessage);
  assert.deepEqual(
    manifest.runtime_nodes,
    topology.runtimeNodes,
    `${disposition} runtime_nodes must equal [${topology.runtimeNodes}]`,
  );
  return policy;
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
  validateNodeRuntimeManifest(manifest);
  console.log(`Node runtime policy agrees for default runtime ${manifest.node_policy.default_runtime}.`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
