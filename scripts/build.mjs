import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";
import { buildCliRuntime } from "../packages/cli/build.mjs";
import { buildCli } from "../packages/superbee/build.mjs";
import { prepareCliBundleInputs } from "../packages/cli/scripts/prepare-bundle-inputs.mjs";
import { npmInvocation } from "../packages/cli/scripts/embed-ui-assets.mjs";
import { currentSourceFacts } from "../packages/cli/scripts/source-facts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TSC_WORKSPACES = Object.freeze([
  "core", "browser-local", "board-git", "server", "view-runtime", "ui-server",
  "markdown-renderer", "mcp-app", "publication", "bundle-descriptor",
]);

// Lifecycle hooks replaced by this dependency graph must not silently acquire new work.
export function assertBuildLifecycle(workspace, scripts) {
  const delegatedBuilds = {
    "mcp-app": "node scripts/build-view.mjs && tsc",
    cli: "node build.mjs",
    superbee: "node build.mjs local-dev",
  };
  const prebuild = workspace === "mcp-app"
    ? "npm run build -w @superbee/markdown-renderer -w @superbee/view-runtime"
    : workspace === "ui" ? "npm run build -w @superbee/markdown-renderer" : undefined;
  if (scripts.prebuild !== prebuild || scripts.postbuild !== undefined ||
      (Object.hasOwn(delegatedBuilds, workspace) && scripts.build !== delegatedBuilds[workspace])) {
    throw new Error(`Build lifecycle changed for ${workspace}; update the root build dependency graph`);
  }
}

function validateLifecycles() {
  for (const workspace of [...TSC_WORKSPACES, "ui", "cli", "superbee"]) {
    const { scripts } = JSON.parse(readFileSync(resolve(root, "packages", workspace, "package.json"), "utf8"));
    assertBuildLifecycle(workspace, scripts);
  }
}

function compileWorkspace(workspace) {
  const invocation = workspace === "mcp-app"
    ? { command: process.execPath, args: [resolve(root, "node_modules/typescript/bin/tsc"), "--project", resolve(root, "packages/mcp-app/tsconfig.json")] }
    : npmInvocation(["run", "build", `--workspace=@superbee/${workspace}`, "--ignore-scripts"]);
  execFileSync(invocation.command, invocation.args, { cwd: root, stdio: "inherit" });
}

/** One invocation owns all completed work; nothing is inferred from existing dist files. */
export async function buildWorkspace({
  validate = validateLifecycles,
  sourceFacts = currentSourceFacts,
  compile = compileWorkspace,
  prepare = prepareCliBundleInputs,
  runtime = buildCliRuntime,
  distribution = buildCli,
} = {}) {
  validate();
  const source = sourceFacts();
  const compiledWorkspaces = [];
  let preparedInputs;
  for (const workspace of TSC_WORKSPACES) {
    // The MCP TypeScript project consumes generated modules, and the UI needs the preceding dists.
    if (workspace === "mcp-app") preparedInputs = await prepare({ compiledWorkspaces: [...compiledWorkspaces] });
    await compile(workspace);
    compiledWorkspaces.push(workspace);
  }
  await runtime({ preparedInputs, source });
  await distribution("local-dev", { preparedInputs, source, compiledWorkspaces });
}

if (isMainModule(import.meta.url)) {
  buildWorkspace().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
