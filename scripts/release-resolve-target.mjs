import { appendFile } from "node:fs/promises";

import { isMainModule } from "./is-main-module.mjs";

import {
  DEFAULT_RELEASE_TARGETS_PATH,
  assertTagForVersion,
  loadReleaseTargets,
  resolveAllowedTuple,
  resolveAllowedTupleByTarget,
  resolveAllowedTupleByTag,
} from "./release-targets.mjs";

function arg(argv, flag, required = true) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if ((!value || value.startsWith("--")) && required) throw new Error(`missing ${flag}`);
  return value;
}

export function parseResolveTargetArgs(argv) {
  return {
    target: arg(argv, "--target", false),
    tag: arg(argv, "--tag", false),
    manifest: arg(argv, "--manifest", false) ?? DEFAULT_RELEASE_TARGETS_PATH,
    githubOutput: arg(argv, "--github-output", false),
    json: argv.includes("--json"),
  };
}

export async function resolveTargetFacts({ target: targetId, tag, manifest: manifestPath = DEFAULT_RELEASE_TARGETS_PATH }) {
  const manifest = await loadReleaseTargets(manifestPath);
  if (!tag && !targetId) throw new Error("missing --tag or --target");
  const tuple = tag === undefined
    ? resolveAllowedTupleByTarget(manifest, { target: targetId })
    : targetId === undefined
      ? resolveAllowedTupleByTag(manifest, { tag })
      : (() => {
          const version = tag.slice(1);
          assertTagForVersion(tag, version);
          return resolveAllowedTuple(manifest, { target: targetId, version, tag });
        })();
  const target = manifest.targets[tuple.target];
  return {
    target: target.id,
    package: target.package.name,
    version: tuple.version,
    tag: tuple.tag,
    policy_tag: tuple.publication.npm_tag,
    npm_promote_tag: tuple.publication.npm_promote_tag,
    github_latest: tuple.publication.github_latest,
    workflow_contract: target.workflow_contract,
  };
}

/**
 * The published $GITHUB_OUTPUT contract. Workflow steps branch on emptiness (`if [ -n "$X" ]`),
 * so only the fields the release grammar allows to be null may ever render empty; every other
 * key must carry a value and a dropped or renamed key must fail the step rather than read as
 * "policy says no".
 */
export const GITHUB_OUTPUT_FIELDS = Object.freeze({
  target: "required",
  package: "required",
  version: "required",
  tag: "required",
  policy_tag: "nullable",
  npm_promote_tag: "nullable",
  github_latest: "required",
  workflow_contract: "required",
});

function outputLine(key, value, kind) {
  if (value === undefined) throw new Error(`github output ${key} is missing from the resolved target facts`);
  if (value === null) {
    if (kind !== "nullable") throw new Error(`github output ${key} must not be null`);
    return `${key}=`;
  }
  if (typeof value === "object" || typeof value === "function") throw new Error(`github output ${key} must be a primitive value`);
  const rendered = String(value);
  if (rendered === "") throw new Error(`github output ${key} must not be empty`);
  if (/[\n\r]/.test(rendered)) throw new Error(`github output ${key} must be a single line`);
  return `${key}=${rendered}`;
}

export function renderGithubOutput(facts) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw new Error("github output requires resolved target facts");
  const declared = Object.keys(facts).sort();
  const contract = Object.keys(GITHUB_OUTPUT_FIELDS).sort();
  if (JSON.stringify(declared) !== JSON.stringify(contract)) {
    const missing = contract.filter((key) => !declared.includes(key));
    const unknown = declared.filter((key) => !contract.includes(key));
    throw new Error(`github output keys differ from the resolved target contract (missing: ${missing.join(",") || "none"}; unknown: ${unknown.join(",") || "none"})`);
  }
  return Object.entries(GITHUB_OUTPUT_FIELDS)
    .map(([key, kind]) => outputLine(key, facts[key], kind))
    .join("\n") + "\n";
}

if (isMainModule(import.meta.url)) {
  const args = parseResolveTargetArgs(process.argv.slice(2));
  resolveTargetFacts(args)
    .then(async (facts) => {
      if (args.githubOutput) {
        await appendFile(args.githubOutput, renderGithubOutput(facts));
      }
      if (args.json || !args.githubOutput) console.log(JSON.stringify(facts));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    });
}
