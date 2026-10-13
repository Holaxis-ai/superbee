import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

export function commonWorkspaces(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  // Fail closed if workspace discovery changes instead of silently dropping a new location.
  if (JSON.stringify(manifest.workspaces) !== JSON.stringify(["packages/*"])) throw new Error("Update runtime workspace discovery for the declared workspace patterns");
  const packages = readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => JSON.parse(readFileSync(path.join(root, "packages", entry.name, "package.json"), "utf8")));
  if (packages.filter(pkg => pkg.name === "@superbee/cli" && pkg.scripts?.test).length !== 1) throw new Error("Expected exactly one CLI test workspace");
  const names = packages.filter(pkg => pkg.name !== "@superbee/cli" && pkg.scripts?.test).map(pkg => pkg.name).sort();
  if (!names.length || names.some(name => typeof name !== "string" || !name) || new Set(names).size !== names.length) throw new Error("Expected nonempty unique common test workspaces");
  return names;
}

export function runCommon(root, npmPath = process.env.npm_execpath) {
  if (!npmPath) throw new Error("Run through npm run test:runtime-common");
  const names = commonWorkspaces(root);
  console.log(`Common runtime tests: ${names.join(", ")}`);
  const result = spawnSync(process.execPath, [npmPath, "test", "--ignore-scripts", ...names.flatMap(name => ["--workspace", name])], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Common runtime tests terminated by ${result.signal}`);
  return result.status ?? 1;
}
if (isMainModule(import.meta.url)) process.exitCode = runCommon(fileURLToPath(new URL("../", import.meta.url)));
