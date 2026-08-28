import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const proof = readFileSync(new URL("./windows-installed-package-proof.mjs", import.meta.url));
process.stdout.write(`${createHash("sha256").update(proof).digest("hex")}\n`);
