import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configureSourceIdentity, createPosixCliRuntime, staticBuildIdentity } from "@superbee/cli";
import { BUILT_COMMAND, captureCommand, type CommandRow } from "./command-batch.js";

// Match the public distribution descriptor; executable parity tests guard this test-owned wiring.
const root = new URL("../../../superbee/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
configureSourceIdentity({ name: manifest.name, version: manifest.version });
const runtime = createPosixCliRuntime({
  identity: staticBuildIdentity(), executablePath: BUILT_COMMAND, assetRoot: fileURLToPath(root),
  install: { packageName: "superbee", entryRelativePath: "dist/superbee.mjs", bins: ["superbee"] },
  predecessorLayouts: [{ packageName: "@holaxis/aslite", entryRelativePath: "dist/superbee.mjs", bins: ["aslite", "agentstate-lite"] }],
  ownedSkillPackages: ["superbee", "aslite", "@holaxis/aslite"], updatesEnabled: true,
});
const input: Buffer[] = [];
for await (const chunk of process.stdin) input.push(Buffer.from(chunk));
const rows: CommandRow[] = JSON.parse(Buffer.concat(input).toString("utf8"));
const results = [];
for (const row of rows) {
  results.push({ id: row.id, ...await captureCommand(() => runtime.run([...row.argv])) });
}
// A dedicated descriptor keeps CLI bytes out of the result protocol, including accidental writes.
writeFileSync(3, JSON.stringify(results));
