import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const hostedDeploymentPackages = new Set(["@agentstate-lite/worker", "miniflare", "workerd", "wrangler"]);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function isHostedDeploymentPackage(packageName) {
  return packageName.startsWith("@cloudflare/") || hostedDeploymentPackages.has(packageName);
}

function packageNamesFromLockfile(lockfile) {
  const packageNames = new Set();

  for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
    if (typeof metadata.name === "string") packageNames.add(metadata.name);

    const nodeModulesIndex = packagePath.lastIndexOf("node_modules/");
    if (nodeModulesIndex !== -1) packageNames.add(packagePath.slice(nodeModulesIndex + "node_modules/".length));

    for (const field of dependencyFields) {
      for (const packageName of Object.keys(metadata[field] ?? {})) packageNames.add(packageName);
    }
  }

  return packageNames;
}

function findHostedDeploymentPackages(lockfile) {
  return [...packageNamesFromLockfile(lockfile)].filter(isHostedDeploymentPackage).sort();
}

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

test("OSS distribution excludes the frozen hosted implementation and control-plane clients", async () => {
  const retiredPaths = [
    "packages/worker",
    "packages/core/src/auth-wire.ts",
    "packages/cli/src/auth-client.ts",
    "packages/cli/src/commands/invite.ts",
    "packages/cli/src/commands/join.ts",
    "packages/cli/src/commands/key.ts",
    "packages/cli/src/commands/login.ts",
    "packages/cli/src/commands/member.ts",
    "packages/cli/src/commands/whoami.ts",
  ];

  const present = [];
  for (const relativePath of retiredPaths) {
    if (await exists(relativePath)) present.push(relativePath);
  }
  assert.deepEqual(present, [], "hosted-only source belongs in the frozen private reference, not OSS");
});

test("lockfile scanner recognizes hosted deployment dependencies", () => {
  const lockfile = {
    packages: {
      "": { devDependencies: { "@cloudflare/unenv-preset": "1.0.0", wrangler: "1.0.0" } },
      "node_modules/@cloudflare/kv-asset-handler": {},
      "node_modules/example/node_modules/miniflare": {},
      "node_modules/workerd": {},
      "packages/worker": { name: "@agentstate-lite/worker" },
    },
  };

  assert.deepEqual(findHostedDeploymentPackages(lockfile), [
    "@agentstate-lite/worker",
    "@cloudflare/kv-asset-handler",
    "@cloudflare/unenv-preset",
    "miniflare",
    "workerd",
    "wrangler",
  ]);
});

test("OSS build and lockfile carry no hosted deployment dependency", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const buildConfiguration = JSON.stringify({ scripts: rootPackage.scripts, workspaces: rootPackage.workspaces });

  for (const forbidden of [
    "@agentstate-lite/worker",
    "packages/worker",
    "@cloudflare/",
    "miniflare",
    "workerd",
    "wrangler",
  ])
    assert.equal(buildConfiguration.includes(forbidden), false, `public build graph must not contain '${forbidden}'`);

  assert.deepEqual(
    findHostedDeploymentPackages(lockfile),
    [],
    "public lockfile must not contain hosted deployment packages",
  );
});

// This source-only gate owns generic wire package placement. Runtime registration is proved by
// the CLI command-spec relational tests rather than by pinning a dispatch implementation spelling.
test("generic wire source authorities remain public after hosted extraction", async () => {
  const [remoteBackend, router, serveCommand] = await Promise.all([
    readFile(path.join(root, "packages/core/src/remote-backend.ts"), "utf8"),
    readFile(path.join(root, "packages/server/src/router.ts"), "utf8"),
    readFile(path.join(root, "packages/cli/src/commands/serve.ts"), "utf8"),
  ]);

  assert.match(remoteBackend, /export class RemoteBackend/);
  assert.match(router, /export function createRouterForBackend/);
  assert.match(serveCommand, /export\s+(?:async\s+)?function\s+serve\s*\(/);
  assert.match(serveCommand, /from\s+["']@agentstate-lite\/server["']/);
});
