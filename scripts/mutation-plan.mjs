import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function mutationPlan(target = "both", override = "") {
  let packages;
  switch (target) {
    case "":
    case "both": packages = ["core", "cli", "board-git"]; break;
    case "core": packages = ["core"]; break;
    case "cli": packages = ["cli"]; break;
    case "board-git": packages = ["board-git"]; break;
    default: throw new Error("Unknown mutation target");
  }
  const include = [];
  for (const name of packages) {
    const cwd = path.join(root, "packages", name);
    const owner = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (name !== "cli" || override) {
      const id = override ? `${name}-override-${createHash("sha256").update(override).digest("hex").slice(0, 16)}` : name;
      include.push({ package: name, workspace: owner.name, id, mutate: override });
      continue;
    }
    const config = JSON.parse(readFileSync(path.join(cwd, "stryker.config.json"), "utf8"));
    const patterns = config.mutate.filter((pattern) => !pattern.startsWith("!"));
    const exclude = config.mutate.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
    const files = [...new Set(globSync(patterns, { cwd, exclude }))].sort();
    if (!files.length) throw new Error("CLI mutation scope is empty");
    for (const [index, file] of files.entries()) {
      include.push({ package: name, workspace: owner.name, id: `${name}-${index + 1}`, mutate: file });
    }
  }
  return { include };
}

if (isMainModule(import.meta.url)) {
  const matrix = JSON.stringify(mutationPlan(process.env.TARGET, process.env.MUTATE));
  process.stdout.write(matrix + "\n");
}
