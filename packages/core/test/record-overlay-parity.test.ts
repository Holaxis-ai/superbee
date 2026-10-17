/**
 * Byte parity with the reference record-bridge: `fixtures/record-overlay/parity.json` is the
 * transcript the reference implementation produced through `parity-scenarios.mjs`; this binding of
 * `@superbee/core/record-overlay` must produce the same plans, receipts, written documents (by
 * version token, the content address of the serialized bytes), digests, decisions and guard
 * outcomes. The reference's site rules are replaced by the test doubles in `record-overlay-helpers.ts`,
 * which agree with them on every scenario input.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mutateDocument } from "../src/document-mutation.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { loadKinds } from "../src/kinds-load.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { overlayCanonicalJson } from "../src/record-overlay/canonical.js";
import { sha256, shortHash } from "../src/record-overlay/digest.js";
import {
  applyRecordOverlay,
  decideChange,
  findingDigest,
  ownershipGuard,
  planFindings,
  planRecordOverlay,
  readOverlayPolicy,
  type OverlayHooks,
} from "../src/record-overlay/index.js";
import { runParity } from "./fixtures/record-overlay/parity-scenarios.mjs";
import { statedEndElseThreeHours, updatedAtStamp } from "./record-overlay-helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const engine = {
  readPolicy: readOverlayPolicy,
  plan: (p: Parameters<typeof planRecordOverlay>[0] & { correlate?: OverlayHooks["correlate"] }) => planRecordOverlay({
    ops: p.ops, content: p.content, policy: p.policy, changes: p.changes, observedAt: p.observedAt, records: p.records,
    observation: p.observation, sameBundle: p.sameBundle,
    hooks: { interval: statedEndElseThreeHours, ...(p.correlate ? { correlate: p.correlate } : {}) },
  }),
  apply: (plan: Parameters<typeof applyRecordOverlay>[0], c: Parameters<typeof applyRecordOverlay>[1]) =>
    applyRecordOverlay(plan, { ...c, hooks: { deriveFields: updatedAtStamp(c.content.registry) } }),
  planFindings,
  decideChange,
  ownershipGuard,
  canonicalJson: overlayCanonicalJson,
  sha256,
  shortHash,
  findingDigest,
};

type Transcript = {
  fixed_now: string;
  canon: unknown;
  sha256: string[];
  short_hash: string[];
  finding_digest: string[];
  decisions: unknown[];
  guards: unknown[];
  scenarios: Array<{ name: string; seeded: unknown; plan: unknown; receipt: unknown; writes: unknown[]; deletes: unknown[] }>;
  findings: { seeded: unknown; steps: unknown; receipt: unknown; writes: unknown[]; deletes: unknown[] };
};

let golden: Transcript;
let actual: Transcript;

before(async () => {
  golden = JSON.parse(await readFile(path.join(here, "fixtures/record-overlay/parity.json"), "utf8")) as Transcript;
  actual = await runParity({ core: { MemoryBackend, mutateDocument, loadKinds, stringifyDoc }, engine }) as Transcript;
});

test("record-overlay parity: the golden covers every scenario the runner defines", () => {
  assert.equal(actual.fixed_now, golden.fixed_now);
  assert.deepEqual(actual.scenarios.map((s) => s.name), golden.scenarios.map((s) => s.name));
  assert.ok(golden.scenarios.length >= 20);
});

test("record-overlay parity: canonical JSON, sha256, shortHash and findingDigest are byte-identical", () => {
  assert.deepEqual(actual.canon, golden.canon);
  assert.deepEqual(actual.sha256, golden.sha256);
  assert.deepEqual(actual.short_hash, golden.short_hash);
  assert.deepEqual(actual.finding_digest, golden.finding_digest);
});

test("record-overlay parity: decideChange decisions, absent against null included", () => {
  assert.deepEqual(actual.decisions, golden.decisions);
});

test("record-overlay parity: ownership guard outcomes, absent to null included", () => {
  assert.deepEqual(actual.guards, golden.guards);
});

test("record-overlay parity: every scenario plans, applies and writes the same bytes", async (t) => {
  for (const [index, expected] of golden.scenarios.entries()) {
    await t.test(expected.name, () => {
      const got = actual.scenarios[index]!;
      assert.deepEqual(got.seeded, expected.seeded, "seeded versions");
      assert.deepEqual(got.plan, expected.plan, "plan");
      assert.deepEqual(got.receipt, expected.receipt, "receipt");
      assert.deepEqual(got.writes, expected.writes, "written bytes");
      assert.deepEqual(got.deletes, [], "no deletes");
    });
  }
});

test("record-overlay parity: findings plan, dedupe, collapse, re-raise after expiry, and write the same bytes", () => {
  assert.deepEqual(actual.findings, golden.findings);
  assert.deepEqual(actual.findings.deletes, []);
});
