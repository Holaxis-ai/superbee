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
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as ops from "./release-operations.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);

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

function args(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    values.push(value);
  }
  return values;
}

function tagAssignments(argv, flag) {
  const result = {};
  for (const value of args(argv, flag)) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator !== value.lastIndexOf("=") || separator === value.length - 1) {
      throw new Error(`${flag} must be TAG=VERSION`);
    }
    const tag = value.slice(0, separator);
    if (Object.hasOwn(result, tag)) throw new Error(`duplicate ${flag} for ${tag}`);
    result[tag] = value.slice(separator + 1);
  }
  return result;
}

/**
 * Resolve an op name + flags to the ordered list of { argv, command } for that op. Pure — the
 * emitter validates every interpolated value, so an injection-shaped input throws HERE, before any
 * argv exists. `argv` is what --execute spawns (no shell); `command` is the copy-pasteable display.
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
      const r = ops.rollbackOperation({
        failedVersion: arg(argv, "--failed-version", true),
        restoreTags: tagAssignments(argv, "--restore-tag"),
        removeTags: args(argv, "--remove-tag"),
        target: arg(argv, "--target", true),
        recoveryTarget: arg(argv, "--recovery-target") ?? arg(argv, "--target", true),
        recoveryVersion: arg(argv, "--recovery-version"),
      });
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    case "registry-verify": {
      const r = ops.registryVerifyOperations({ version: arg(argv, "--version", true), target: arg(argv, "--target", true) });
      return r.argvs.map((a, i) => ({ argv: a, command: r.commands[i] }));
    }
    case "promote":
      return [ops.promoteOperation({ version: arg(argv, "--version", true), tag: arg(argv, "--tag") ?? "latest", target: arg(argv, "--target", true) })];
    case "immutable-release": {
      const githubLatest = arg(argv, "--github-latest", true);
      if (githubLatest !== "true" && githubLatest !== "false") {
        throw new Error("--github-latest must be true or false");
      }
      const r = ops.immutableReleaseOperations({
        releaseId: arg(argv, "--release-id", true),
        tag: `v${ops.assertVersion(arg(argv, "--version", true))}`,
        githubLatest: githubLatest === "true",
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
