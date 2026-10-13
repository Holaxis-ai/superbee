import { exportSnapshot, verifySnapshotProvenance } from "./src/snapshot.mjs";

const args = process.argv.slice(2), options = {};
let check = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--check") { check = true; continue; }
  const name = { "--source": "source", "--target": "target", "--commit": "commit", "--expected": "expected" }[args[index]];
  if (!name || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("usage: export.mjs --source <checkout> --target <snapshot> --commit <sha> [--expected <previous-sha> | --check]");
  options[name] = args[++index];
}
try {
  if (!options.source || !options.target || (!check && !options.commit)) throw new Error("missing snapshot inputs");
  console.log(JSON.stringify(await (check ? verifySnapshotProvenance(options) : exportSnapshot(options))));
} catch {
  console.error(JSON.stringify({ status: "blocked", reason: "Snapshot source/target agreement failed. Use a clean exact canonical producer checkout and an absent or intact expected snapshot; no credentials or configuration are changed." }));
  process.exitCode = 1;
}
