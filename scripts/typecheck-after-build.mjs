import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TSC_WORKSPACES } from "./build.mjs";
import { isMainModule } from "./is-main-module.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Only an identical default-project check is discharged by the preceding build. New workspaces
// and checks with additional commands automatically retain their complete typecheck script.
export function remainingTypechecks(packages, compiled = TSC_WORKSPACES) {
  return packages.filter(({ directory, scripts }) => scripts?.typecheck
    && !(compiled.includes(directory) && scripts.typecheck === "tsc --noEmit"
      && ["tsc", "npm run check:generated && tsc"].includes(scripts.build)));
}

export function typecheckAfterBuild() {
  const packages = readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => ({
      directory: name,
      ...JSON.parse(readFileSync(path.join(root, "packages", name, "package.json"), "utf8")),
    }));
  const remaining = remainingTypechecks(packages);
  if (!remaining.length) return;
  if (!process.env.npm_execpath) throw new Error("Run through npm run typecheck:after-build");
  execFileSync(process.execPath, [process.env.npm_execpath, "run", "typecheck", "--ignore-scripts",
    ...remaining.flatMap(({ name }) => ["--workspace", name])], { cwd: root, stdio: "inherit" });
}

if (isMainModule(import.meta.url)) typecheckAfterBuild();
