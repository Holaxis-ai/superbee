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
import { promisify } from "node:util";
import { isMainModule } from "./is-main-module.mjs";
import * as ops from "./release-operations.mjs";

const execFileAsync = promisify(execFile);

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

/**
 * Resolve an op name + flags to the ordered list of { argv, command } for that op. Pure — the
 * emitter validates every interpolated value, so an injection-shaped input throws HERE, before any
 * argv exists. `argv` is what --execute spawns (no shell); `command` is the copy-pasteable display.
 *
 * `--target` is REQUIRED for every op that names a package. It used to fall back to the bridge, so
 * `--op rollback --failed-version <superbee version>` without a target emitted dist-tag and
 * deprecate commands against @holaxis/aslite - a live registry mutation on the wrong package.
 * Reject/approve name no package and take no target. Immutable-release requires a target because
 * its tag and publication policy are resolved from that target's manifest tuple.
 */
export function operationsFor(op, argv) {
  switch (op) {
    case "reject":
      return [ops.rejectOperation({ stageId: arg(argv, "--stage-id", true) })];
    case "approve":
      return [ops.approveOperation({ stageId: arg(argv, "--stage-id", true) })];
    case "secondary-tag":
      return [ops.secondaryTagOperation({ version: arg(argv, "--version", true), tag: arg(argv, "--tag", true), target: arg(argv, "--target", true) })];
    case "remove-secondary-tag":
      return [ops.removeSecondaryTagOperation({ tag: arg(argv, "--tag", true), target: arg(argv, "--target", true) })];
    case "rollback": {
      const target = arg(argv, "--target", true);
      const r = ops.rollbackOperation({
        failedVersion: arg(argv, "--failed-version", true),
        priorVersion: arg(argv, "--prior-version", true),
        track: arg(argv, "--track") ?? "next",
        target,
        // Defaults to the failed package's own target: an explicit value, never a silent redirect.
        recoveryTarget: arg(argv, "--recovery-target") ?? target,
      });
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    case "registry-verify": {
      const r = ops.registryVerifyOperations({ version: arg(argv, "--version", true), target: arg(argv, "--target", true) });
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    case "promote":
      return [ops.promoteOperation({ version: arg(argv, "--version", true), tag: arg(argv, "--tag", true), target: arg(argv, "--target", true) })];
    case "immutable-release": {
      for (const forbidden of ["--tag", "--github-latest", "--github-prerelease", "--prerelease", "--make-latest"]) {
        if (argv.includes(forbidden)) throw new Error(`immutable-release does not accept ${forbidden}`);
      }
      const r = ops.immutableReleaseOperations({
        releaseId: arg(argv, "--release-id", true),
        sourceCommit: arg(argv, "--source-commit", true),
        target: arg(argv, "--target", true),
        version: arg(argv, "--version", true),
      });
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const op = arg(argv, "--op", true);
    const doExecute = argv.includes("--execute");
    const operations = operationsFor(op, argv);
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
