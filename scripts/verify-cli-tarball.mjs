import { access, constants } from "node:fs/promises";
import path from "node:path";

import { proveCliTarball } from "./cli-library-proof.mjs";

const [tarball, ...extra] = process.argv.slice(2);
if (!tarball || extra.length > 0) {
  throw new Error("usage: node scripts/verify-cli-tarball.mjs <retained-tarball>");
}
const SAFE_ROOT = path.resolve(process.cwd());
const resolved = path.resolve(SAFE_ROOT, tarball);
const relative = path.relative(SAFE_ROOT, resolved);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("tarball path must be within the current working directory");
}
await access(resolved, constants.R_OK);
const result = await proveCliTarball(resolved);
process.stdout.write(`${JSON.stringify({ verified: "@superbee/cli", ...result }, null, 2)}\n`);
