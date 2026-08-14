// CLI wrapper over the pure operations emitter (scripts/release-operations.mjs). Without --execute
// it PRINTS the exact display commands (dry-run); with --execute it runs each operation via
// execFile over an ARGV ARRAY — NO SHELL. Because there is no `sh -c`, an operation value cannot
// inject a command even if it contained shell metacharacters; and the emitter itself validates
// every value (version = strict SemVer, ids/tags = safe charset) and throws before an argv is ever
// built, so a non-conforming value exits non-zero here. It never builds or packs.
//
// Usage: node scripts/release-run-operations.mjs --op <name> [op args] [--execute]
//   ops: reject|approve|secondary-tag|remove-secondary-tag|rollback|registry-verify|promote|immutable-release
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as ops from "./release-operations.mjs";
import { assertCoordinatePolicyAuthority, parseCoordinatePolicy } from "./release-audit-tags.mjs";
import { assertWorkflowContract, defaultReleaseManifest } from "./release-targets.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(scriptPath));

function arg(argv, flag, required = false) {
  const at = argv.indexOf(flag);
  if (at === -1) {
    if (required) throw new Error(`missing ${flag}`);
    return undefined;
  }
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

function assertOnlyFlags(argv, allowed) {
  const accepted = new Set(["--op", "--execute", ...allowed]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!accepted.has(flag)) throw new Error(`unexpected operation argument ${JSON.stringify(flag)}`);
    if (seen.has(flag)) throw new Error(`duplicate operation flag ${flag}`);
    seen.add(flag);
    if (flag === "--execute") continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
  }
}

function targetAuthority(argv) {
  const manifest = defaultReleaseManifest();
  const targetId = arg(argv, "--target", true);
  const target = assertWorkflowContract(manifest.targets[targetId]);
  const tuple = manifest.allowed_tuples[targetId];
  if (!tuple || tuple.target !== target.id || tuple.package !== target.package.name) {
    throw new Error(`release target ${targetId} has no exact reviewed tuple`);
  }
  const version = arg(argv, "--version", true);
  if (version !== tuple.version) throw new Error(`--version ${version} differs from reviewed ${targetId} version ${tuple.version}`);
  return { manifest, target, tuple };
}

function readPolicy(filename, coordinate) {
  const raw = JSON.parse(readFileSync(path.join(repoRoot, "release", filename), "utf8"));
  return parseCoordinatePolicy(raw, { coordinate });
}

function rollbackAuthority(argv) {
  const manifest = defaultReleaseManifest();
  const targetId = arg(argv, "--target", true);
  const target = assertWorkflowContract(manifest.targets[targetId]);
  const tuple = manifest.allowed_tuples[targetId];
  if (!tuple) throw new Error(`release target ${targetId} has no exact reviewed tuple`);
  const fromState = arg(argv, "--from-state", true);
  const bridge = readPolicy("bridge-phase.json", "bridge");
  const superbee = readPolicy("superbee-cutover.json", "superbee");
  assertCoordinatePolicyAuthority(bridge, manifest);
  assertCoordinatePolicyAuthority(superbee, manifest);

  if (target.id === "bridge") {
    const plans = {
      bridge_staged: { restoreTags: { next: bridge.baseline.next }, removeTags: [] },
      bridge_settled: { restoreTags: { latest: bridge.baseline.latest, next: bridge.baseline.next }, removeTags: [] },
    };
    const plan = plans[fromState];
    if (!plan) throw new Error(`bridge rollback does not allow --from-state ${JSON.stringify(fromState)}`);
    return { ...plan, failedVersion: tuple.version, target: target.id, recoveryTarget: "bridge", recoveryVersion: bridge.baseline.latest };
  }
  if (target.id === "successor-stable") {
    const plans = {
      stable_staged: { restoreTags: {}, removeTags: ["next"] },
      stable_promoted: { restoreTags: { latest: superbee.placeholder.latest }, removeTags: ["next"] },
    };
    const plan = plans[fromState];
    if (!plan) throw new Error(`stable rollback does not allow --from-state ${JSON.stringify(fromState)}`);
    return { ...plan, failedVersion: tuple.version, target: target.id, recoveryTarget: "bridge", recoveryVersion: bridge.bridge.version };
  }
  if (target.id === "successor-preview") {
    if (fromState !== "preview_staged_or_settled") throw new Error(`preview rollback does not allow --from-state ${JSON.stringify(fromState)}`);
    return {
      restoreTags: { next: superbee.stable.version }, removeTags: [], failedVersion: tuple.version,
      target: target.id, recoveryTarget: "successor-stable", recoveryVersion: superbee.stable.version,
    };
  }
  throw new Error(`release target ${target.id} has no rollback authority`);
}

/**
 * Resolve an op name + flags to the ordered list of { argv, command } for that op. Pure — the
 * emitter validates every interpolated value, so an injection-shaped input throws HERE, before any
 * argv exists. `argv` is what --execute spawns (no shell); `command` is the copy-pasteable display.
 */
export function operationsFor(op, argv) {
  switch (op) {
    case "reject": {
      assertOnlyFlags(argv, ["--stage-id"]);
      return [ops.rejectOperation({ stageId: arg(argv, "--stage-id", true) })];
    }
    case "approve": {
      assertOnlyFlags(argv, ["--stage-id"]);
      return [ops.approveOperation({ stageId: arg(argv, "--stage-id", true) })];
    }
    case "secondary-tag": {
      assertOnlyFlags(argv, ["--target", "--version"]);
      const { target, tuple } = targetAuthority(argv);
      if (!tuple.publication.npm_tag) throw new Error(`release target ${target.id} has no npm stage tag`);
      return [ops.secondaryTagOperation({ version: tuple.version, tag: tuple.publication.npm_tag, target: target.id })];
    }
    case "remove-secondary-tag": {
      assertOnlyFlags(argv, ["--target", "--version"]);
      const { target, tuple } = targetAuthority(argv);
      if (!tuple.publication.npm_tag) throw new Error(`release target ${target.id} has no npm stage tag`);
      return [ops.removeSecondaryTagOperation({ tag: tuple.publication.npm_tag, target: target.id })];
    }
    case "rollback": {
      assertOnlyFlags(argv, ["--target", "--from-state"]);
      const r = ops.rollbackOperation(rollbackAuthority(argv));
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    case "registry-verify": {
      assertOnlyFlags(argv, ["--target", "--version"]);
      const { target, tuple } = targetAuthority(argv);
      const r = ops.registryVerifyOperations({ version: tuple.version, target: target.id });
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    case "promote": {
      assertOnlyFlags(argv, ["--target", "--version"]);
      const { target, tuple } = targetAuthority(argv);
      if (!tuple.publication.npm_promote_tag) throw new Error(`release target ${target.id} has no npm promotion`);
      return [ops.promoteOperation({ version: tuple.version, tag: tuple.publication.npm_promote_tag, target: target.id })];
    }
    case "immutable-release": {
      assertOnlyFlags(argv, ["--target", "--version", "--release-id"]);
      const { tuple } = targetAuthority(argv);
      const r = ops.immutableReleaseOperations({
        releaseId: arg(argv, "--release-id", true),
        tag: tuple.tag,
        githubLatest: tuple.publication.github_latest,
      });
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const argv = process.argv.slice(2);
    const op = arg(argv, "--op", true);
    const doExecute = argv.includes("--execute");
    const operations = operationsFor(op, argv);
    if (doExecute && operations.some((operation) => operation.requires_2fa)) {
      throw new Error(`${op} requires a human npm 2FA command and cannot use --execute`);
    }
    for (const { argv: cmd, command } of operations) {
      if (doExecute) {
        console.log(`+ ${command}`);
        // No shell: execFile spawns the binary directly with the exact argv array.
        const { stdout, stderr } = await execFileAsync(cmd[0], cmd.slice(1), { maxBuffer: 20 * 1024 * 1024 });
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      } else {
        console.log(command);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
