/**
 * A3 — invocation-correct hints (AXI §7/§10).
 *
 * A3.guard: a source-scan guard that locks the audit finding — every emitted `help:` field
 * (an error's fixing command, or a success `help[]` entry) must be built from `cliInvocation()`/
 * `deps.invocation()`, never a bare hardcoded bin name. Cheap (string scan, no runtime).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "../src");

const BARE_BIN = /\b(agentstate-lite|aslite)\b/;
const PHANTOM_DIST = /dist\/agentstate-lite\.mjs/;

/** Every `help:` field written as a template literal (optionally inside a `[...]` array). */
const HELP_TEMPLATE = /help:\s*\[?\s*`([^`]*)`/g;

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Strip `${...}` interpolations out of a template-literal body, leaving only the LITERAL text. */
function literalPortions(templateBody: string): string {
  return templateBody.replace(/\$\{[^}]*\}/g, "");
}

test("A3.guard: no emitted help: field hardcodes a bare bin name or a phantom dist path", async () => {
  const files = await listTsFiles(SRC_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    for (const match of src.matchAll(HELP_TEMPLATE)) {
      const literal = literalPortions(match[1] ?? "");
      if (BARE_BIN.test(literal) || PHANTOM_DIST.test(literal)) {
        offenders.push(`${path.relative(SRC_DIR, file)}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `found hardcoded bin literal(s) in an emitted help: field:\n${offenders.join("\n")}`);
});
