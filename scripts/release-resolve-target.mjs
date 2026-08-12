import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RELEASE_TARGETS_PATH,
  assertTagForVersion,
  loadReleaseTargets,
  resolveAllowedTuple,
  resolveAllowedTupleByTag,
} from "./release-targets.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function arg(argv, flag, required = true) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if ((!value || value.startsWith("--")) && required) throw new Error(`missing ${flag}`);
  return value;
}

export function parseResolveTargetArgs(argv) {
  return {
    target: arg(argv, "--target", false),
    tag: arg(argv, "--tag"),
    manifest: arg(argv, "--manifest", false) ?? DEFAULT_RELEASE_TARGETS_PATH,
    githubOutput: arg(argv, "--github-output", false),
    json: argv.includes("--json"),
  };
}

export async function resolveTargetFacts({ target: targetId, tag, manifest: manifestPath = DEFAULT_RELEASE_TARGETS_PATH }) {
  const manifest = await loadReleaseTargets(manifestPath);
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  assertTagForVersion(tag, version);
  const tuple = targetId === undefined
    ? resolveAllowedTupleByTag(manifest, { tag })
    : resolveAllowedTuple(manifest, { target: targetId, version, tag });
  const target = manifest.targets[tuple.target];
  return {
    target: target.id,
    package: target.package.name,
    version: tuple.version,
    tag: tuple.tag,
    policy_tag: tuple.version.includes("-") ? "next" : "latest",
  };
}

function outputLine(key, value) {
  return `${key}=${value}`;
}

export function renderGithubOutput(facts) {
  return [
    outputLine("target", facts.target),
    outputLine("package", facts.package),
    outputLine("version", facts.version),
    outputLine("tag", facts.tag),
    outputLine("policy_tag", facts.policy_tag),
  ].join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = parseResolveTargetArgs(process.argv.slice(2));
  resolveTargetFacts(args)
    .then(async (facts) => {
      if (args.githubOutput) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(args.githubOutput, renderGithubOutput(facts));
      }
      if (args.json || !args.githubOutput) console.log(JSON.stringify(facts));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    });
}
