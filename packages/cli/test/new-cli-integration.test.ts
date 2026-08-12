import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { CONVENTION_TYPE, initBundle, readDoc, writeDoc, type Bundle } from "@superbee/core";

const cliBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/agentstate-lite.mjs");
const T = "2026-07-01T00:00:00.000Z";

test("built CLI new persists prototype-looking options as exact own properties and rejects omissions", async () => {
  assert.ok(existsSync(cliBin), "root npm run build must create the built CLI before this proof runs");
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-new-built-"));
  try {
    const bundle: Bundle = { root: dir };
    await initBundle(dir);
    const cases = [
      { field: "__proto__", args: ["--__proto__", "proto-value"], expected: "proto-value", values: ["proto-value"] },
      { field: "constructor", args: ["--constructor=ctor-value"], expected: "ctor-value", values: ["ctor-value"] },
      { field: "toString", args: ["--toString", "first", "--toString", "second"], expected: ["first", "second"] },
    ];
    for (const entry of cases) {
      const kindName = `Built ${entry.field}`;
      const suffix = entry.field.replaceAll("_", "dash");
      await writeDoc(bundle, {
        id: `conventions/built-${suffix}`,
        frontmatter: {
          type: CONVENTION_TYPE,
          governs: kindName,
          fields: { required: [entry.field], values: entry.values ? Object.fromEntries([[entry.field, entry.values]]) : {} },
          timestamp: T,
        },
        body: "",
      });

      const presentId = `present-${suffix}`;
      const result = spawnSync("node", [cliBin, "new", kindName, presentId, ...entry.args, "--dir", dir, "--json"], { encoding: "utf8" });
      assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
      const saved = await readDoc(bundle, presentId);
      assert.equal(Object.prototype.hasOwnProperty.call(saved.frontmatter, entry.field), true);
      assert.deepEqual((saved.frontmatter as Record<string, unknown>)[entry.field], entry.expected);
      assert.equal(Object.getPrototypeOf(saved.frontmatter), Object.prototype);

      const missingId = `missing-${suffix}`;
      const missing = spawnSync("node", [cliBin, "new", kindName, missingId, "--dir", dir, "--json"], { encoding: "utf8" });
      assert.equal(missing.status, 2, `stdout=${missing.stdout} stderr=${missing.stderr}`);
      assert.match(missing.stdout, new RegExp(entry.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await assert.rejects(() => readDoc(bundle, missingId));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
