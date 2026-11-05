import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, loadKinds, parseMarkdown, prepareDocumentMutationCandidate, readDoc, stringifyDoc, MemoryBackend, type WriteOptions, type Frontmatter } from "@superbee/core";
import { serve } from "@superbee/server";
import { promote } from "../src/commands/promote.js";
import { pull } from "../src/commands/pull.js";

async function run(argv: string[]): Promise<Record<string, unknown>> {
  let output = "";
  await promote([...argv, "--json"], { stdout: s => { output += s; } });
  return JSON.parse(output);
}

// Actor environment is process-wide; these table rows run sequentially and restore all inputs.
const actorRows = [
  { name: "explicit overrides environment", explicit: " process:explicit ", env: "process:environment", expected: "process:explicit" },
  { name: "canonical environment", env: " process:environment ", expected: "process:environment" },
  { name: "legacy environment", legacy: "process:legacy", expected: "process:legacy" },
  { name: "default", expected: undefined },
] as const;

test("promote attribution agrees with shared policy across edition, actor, create, update and no-op rows", async t => {
  const saved = { canonical: process.env.SUPERBEE_ACTOR, legacy: process.env.AGENTSTATE_LITE_ACTOR };
  try {
    for (const remote of [false, true]) for (const edition of ["0.1", "0.2"] as const) for (const row of actorRows) await t.test(`${remote ? "wire" : "local"} ${edition}: ${row.name}`, async () => {
      delete process.env.SUPERBEE_ACTOR; delete process.env.AGENTSTATE_LITE_ACTOR;
      if ("env" in row) process.env.SUPERBEE_ACTOR = row.env;
      if ("legacy" in row) process.env.AGENTSTATE_LITE_ACTOR = row.legacy;
      const dir = await mkdtemp(path.join(tmpdir(), "promote-attribution-"));
      let close: (() => Promise<void>) | undefined;
      try {
        const bundle = await initBundle(path.join(dir, "bundle"), { okfVersion: edition });
        const server = remote ? await serve({ bundle, port: 0 }) : undefined;
        close = server ? () => server.close() : undefined;
        const target = server ? ["--remote", `http://${server.host}:${server.port}`] : ["--dir", bundle.root];
        const registry = await loadKinds(bundle);
        const file = path.join(dir, "source.md");
        const frontmatter: Frontmatter = { type: "Spec", title: 'A "quoted": title', x_unknown: { nested: ["kept", 7] },
          ...(edition === "0.2" ? { generated: { by: "process:source", at: "2020-01-01T00:00:00Z", extension: "retained" }, verified: [{ by: "human:reviewer", at: "2020-01-02T00:00:00Z" }] } : { timestamp: "2020-01-01T00:00:00Z" }) };
        await writeFile(file, stringifyDoc(frontmatter, "# Initial\n"));
        const args = [file, "--doc-key", "spec.md", ...target, ...("explicit" in row ? ["--actor", row.explicit] : [])];
        let previous: Awaited<ReturnType<typeof readDoc>> | undefined;
        let version: string | undefined;
        for (const phase of ["create", "update", "no-op"] as const) {
          if (phase !== "create") {
            await pull(["--doc-key", "spec.md", "--out", file, ...target], { stdout: () => {} });
            if (phase === "update") await writeFile(file, (await readFile(file, "utf8")).replace("# Initial", "# Edited"));
          }
          const raw = parseMarkdown(await readFile(file, "utf8"), file, { okfVersion: edition });
          const receipt = await run([...args, ...(version === undefined ? [] : ["--expected-version", version])]);
          const stored = await readDoc(bundle, "spec");
          const prepared = prepareDocumentMutationCandidate(previous, raw, { id: "spec", registry, strict: false, okfVersion: edition,
            mode: phase === "create" ? "create-only" : "replace-document", actor: row.expected,
            now: () => String((stored.frontmatter.generated as { at?: string } | undefined)?.at ?? stored.frontmatter.timestamp) });
          assert.deepEqual(stored.frontmatter, prepared.candidate.frontmatter, `${phase}: metadata agrees with shared preparation`);
          assert.equal(stored.body.trim(), prepared.candidate.body.trim());
          assert.equal(stored.frontmatter.title, frontmatter.title);
          assert.deepEqual(stored.frontmatter.x_unknown, frontmatter.x_unknown);
          if (edition === "0.2") {
            assert.equal((stored.frontmatter.generated as { by: string }).by, row.expected ?? "process:superbee");
            assert.equal(stored.frontmatter.superbee_updated_by, row.expected);
            assert.deepEqual(stored.frontmatter.verified, frontmatter.verified);
            assert.equal((stored.frontmatter.generated as { extension: string }).extension, "retained");
          }
          if (phase === "no-op") { assert.equal(receipt.version, version); assert.deepEqual(stored, previous); assert.equal(prepared.changed, false); }
          previous = stored; version = receipt.version as string;
        }
      } finally { await close?.(); await rm(dir, { recursive: true, force: true }); }
    });
  } finally {
    if (saved.canonical === undefined) delete process.env.SUPERBEE_ACTOR; else process.env.SUPERBEE_ACTOR = saved.canonical;
    if (saved.legacy === undefined) delete process.env.AGENTSTATE_LITE_ACTOR; else process.env.AGENTSTATE_LITE_ACTOR = saved.legacy;
  }
});

test("promote blob forwards actor/CAS through wire storage and leaves byte identity unchanged", async t => {
  const saved = { canonical: process.env.SUPERBEE_ACTOR, legacy: process.env.AGENTSTATE_LITE_ACTOR };
  try {
    for (const edition of ["0.1", "0.2"] as const) for (const row of actorRows) await t.test(`${edition}: ${row.name}`, async () => {
      delete process.env.SUPERBEE_ACTOR; delete process.env.AGENTSTATE_LITE_ACTOR;
      if ("env" in row) process.env.SUPERBEE_ACTOR = row.env;
      if ("legacy" in row) process.env.AGENTSTATE_LITE_ACTOR = row.legacy;
      const backend = new MemoryBackend(), seen: WriteOptions[] = [];
      await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n# Test\n`);
      const original = backend.writeBlob.bind(backend);
      backend.writeBlob = async (key, bytes, mime, options = {}) => { seen.push(options); return original(key, bytes, mime, options); };
      const server = await serve({ bundle: { root: "mem://promote-actor", backend }, port: 0 });
      const dir = await mkdtemp(path.join(tmpdir(), "promote-blob-actor-"));
      try {
        const file = path.join(dir, "blob.bin"); await writeFile(file, "first");
        const args = [file, "--doc-key", "blob.bin", "--remote", `http://${server.host}:${server.port}`, ...("explicit" in row ? ["--actor", row.explicit] : [])];
        const created = await run(args);
        assert.equal(seen.at(-1)?.expectedVersion, null);
        assert.equal(seen.at(-1)?.actor, row.expected ?? "unknown");
        await writeFile(file, "second");
        const updated = await run([...args, "--expected-version", created.version as string]);
        assert.equal(seen.at(-1)?.expectedVersion, created.version);
        assert.equal(seen.at(-1)?.actor, row.expected ?? "unknown");
        const unchanged = await run([...args, "--expected-version", updated.version as string]);
        assert.equal(unchanged.version, updated.version);
        assert.deepEqual(Buffer.from((await backend.readBlob("blob.bin"))!.bytes), Buffer.from("second"));
      } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
    });
  } finally {
    if (saved.canonical === undefined) delete process.env.SUPERBEE_ACTOR; else process.env.SUPERBEE_ACTOR = saved.canonical;
    if (saved.legacy === undefined) delete process.env.AGENTSTATE_LITE_ACTOR; else process.env.AGENTSTATE_LITE_ACTOR = saved.legacy;
  }
});

test("promote uses shared actor validation before document or blob writes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "promote-actor-refusal-"));
  try {
    const bundle = await initBundle(path.join(dir, "bundle"));
    const file = path.join(dir, "input"); await writeFile(file, "---\ntype: Spec\n---\n# Input\n");
    for (const key of ["spec.md", "blob.bin"]) for (const actor of ["", " ", "bare-name"]) {
      await assert.rejects(run([file, "--doc-key", key, "--dir", bundle.root, "--actor", actor]), /empty value|not an OKF actor/);
      assert.ok(bundle.backend);
      assert.equal(await bundle.backend.existsBlob("blob.bin"), false);
      await assert.rejects(readDoc(bundle, "spec"));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
