/**
 * OKF v0.2 verification through the mutation service: appending a `verified` event is NOT a
 * meaningful content change (SPEC 5.2: `verified` is independent of `generated.at`), so the
 * generation clock and producer are preserved, the revision is still attributed to the verifier,
 * and an identical re-append converges to a no-op — identically across every storage adapter.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRouter } from "@superbee/server";

import { readDocVersioned } from "../src/bundle.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { appendVerificationEvent, trustTier, verificationEvents } from "../src/verification.js";
import type { KindRegistry } from "../src/kinds.js";
import type { Bundle } from "../src/types.js";

const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };
const INDEX = "---\nokf_version: '0.2'\n---\n# v0.2 verify contract\n";
const CREATED_AT = "2026-07-28T12:34:56.000Z";
const VERIFIED_AT = "2026-07-29T09:15:00.000Z";
const LATER = "2026-08-01T00:00:00.000Z";

interface Harness {
  name: string;
  bundle: Bundle;
  cleanup: () => Promise<void>;
}

async function harnesses(): Promise<Harness[]> {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-okf-v02-verify-"));
  await writeFile(path.join(root, "index.md"), INDEX, "utf8");
  const memoryBackend = new MemoryBackend();
  await memoryBackend.writeReserved("", "index.md", INDEX);
  const serverBackend = new MemoryBackend();
  await serverBackend.writeReserved("", "index.md", INDEX);
  const router = createRouter({ root: "mem://okf-v02-verify-server", backend: serverBackend });
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "okf-v02-verify", fetchImpl: router });
  return [
    { name: "filesystem", bundle: { root }, cleanup: () => rm(root, { recursive: true, force: true }) },
    { name: "memory", bundle: { root: "mem://okf-v02-verify", backend: memoryBackend }, cleanup: async () => {} },
    { name: "reference-server", bundle: { root: "wire://okf-v02-verify", backend: remote }, cleanup: async () => {} },
  ];
}

test("v0.2 verify: appends the event, keeps generated.by/at and the body, attributes the revision, and re-appending identically is a no-op", async () => {
  const adapters = await harnesses();
  try {
    for (const harness of adapters) {
      const label = harness.name;
      const created = await mutateDocument({
        bundle: harness.bundle,
        id: "concepts/revenue",
        mode: "create-only",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "finance_agent/1.0",
        persistActor: true,
        now: () => CREATED_AT,
        buildCandidate: () => ({ frontmatter: { type: "Metric", title: "MRR" }, body: "# MRR\n" }),
      });
      assert.deepEqual(created.doc.frontmatter.generated, { by: "finance_agent/1.0", at: CREATED_AT }, label);
      assert.equal(trustTier(created.doc.frontmatter), "unverified", label);

      const verify = () =>
        mutateDocument({
          bundle: harness.bundle,
          id: "concepts/revenue",
          mode: "patch",
          onAbsent: "fail",
          registry: EMPTY_REGISTRY,
          strict: false,
          actor: "human:reviewer",
          persistActor: true,
          now: () => LATER,
          buildCandidate: (existing) => ({
            frontmatter: appendVerificationEvent(existing!.frontmatter, { by: "human:reviewer", at: VERIFIED_AT }),
            body: existing!.body,
          }),
        });

      const verified = await verify();
      assert.equal(verified.changed, true, label);
      const fm = verified.doc.frontmatter;
      assert.deepEqual(fm.verified, [{ by: "human:reviewer", at: VERIFIED_AT }], label);
      assert.deepEqual(fm.generated, { by: "finance_agent/1.0", at: CREATED_AT }, `${label}: generated is not a verifier's to change`);
      assert.equal(fm.superbee_updated_by, "human:reviewer", `${label}: the revision is still attributed`);
      assert.equal(verified.doc.body, "# MRR\n", label);
      assert.equal(trustTier(fm), "human-reviewed", label);

      // Byte-identical second append (same by, same at) — nothing new to record.
      const again = await verify();
      assert.equal(again.changed, false, `${label}: identical event is a no-op`);
      assert.equal(again.version, verified.version, label);
      const stored = await readDocVersioned(harness.bundle, "concepts/revenue");
      assert.deepEqual(stored.doc.frontmatter, fm, `${label}: stored bytes unchanged by the no-op`);

      // A machine confirmation on top keeps the human tier and grows the list.
      const machine = await mutateDocument({
        bundle: harness.bundle,
        id: "concepts/revenue",
        mode: "patch",
        onAbsent: "fail",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "process:finance-nightly",
        persistActor: true,
        now: () => LATER,
        buildCandidate: (existing) => ({
          frontmatter: appendVerificationEvent(existing!.frontmatter, { by: "process:finance-nightly", at: LATER }),
          body: existing!.body,
        }),
      });
      assert.equal(verificationEvents(machine.doc.frontmatter).length, 2, label);
      assert.equal(trustTier(machine.doc.frontmatter), "human-reviewed", label);
      assert.deepEqual(machine.doc.frontmatter.generated, { by: "finance_agent/1.0", at: CREATED_AT }, label);
    }
  } finally {
    for (const harness of adapters) await harness.cleanup();
  }
});

test("v0.2 verify: a producer's bare verified mapping is read as one event and becomes a two-element list on append", async () => {
  const adapters = await harnesses();
  try {
    for (const harness of adapters) {
      const label = harness.name;
      // The producer is the create's resolved actor: on main, candidate frontmatter cannot
      // self-declare `generated.by` (an unattributed create records process:superbee).
      await mutateDocument({
        bundle: harness.bundle,
        id: "concepts/bare",
        mode: "create-only",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "finance_agent/1.0",
        now: () => CREATED_AT,
        buildCandidate: () => ({
          frontmatter: {
            type: "Metric",
            generated: { by: "finance_agent/1.0", at: CREATED_AT },
            verified: { by: "process:nightly", at: VERIFIED_AT, method: "checksum" },
          },
          body: "Body.",
        }),
      });
      const before = await readDocVersioned(harness.bundle, "concepts/bare");
      assert.deepEqual(before.doc.frontmatter.generated, { by: "finance_agent/1.0", at: CREATED_AT }, label);
      assert.equal(trustTier(before.doc.frontmatter), "machine-confirmed", label);
      assert.deepEqual(verificationEvents(before.doc.frontmatter), [{ by: "process:nightly", at: VERIFIED_AT, method: "checksum" }], label);

      const result = await mutateDocument({
        bundle: harness.bundle,
        id: "concepts/bare",
        mode: "patch",
        onAbsent: "fail",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "human:reviewer",
        persistActor: true,
        now: () => LATER,
        buildCandidate: (existing) => ({
          frontmatter: appendVerificationEvent(existing!.frontmatter, { by: "human:reviewer", at: LATER }),
          body: existing!.body,
        }),
      });
      assert.deepEqual(
        result.doc.frontmatter.verified,
        [{ by: "process:nightly", at: VERIFIED_AT, method: "checksum" }, { by: "human:reviewer", at: LATER }],
        `${label}: extras preserved, bare mapping normalized`,
      );
      assert.deepEqual(result.doc.frontmatter.generated, { by: "finance_agent/1.0", at: CREATED_AT }, label);
      assert.equal(trustTier(result.doc.frontmatter), "human-reviewed", label);
    }
  } finally {
    for (const harness of adapters) await harness.cleanup();
  }
});
