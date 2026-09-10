import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FilesystemBackend } from "../src/backend.js";
import { query, queryHeads } from "../src/engine.js";

class CountedBackend extends FilesystemBackend {
  rootReads = 0;
  override async readReserved(...args: Parameters<FilesystemBackend["readReserved"]>) {
    if (args[0] === "" && args[1] === "index.md") this.rootReads++;
    return super.readReserved(...args);
  }
}
const marker = (edition: string) => `---\nokf_version: '${edition}'\n---\n`;
async function fixture(run: (root: string, backend: CountedBackend) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-batch-edition-"));
  try {
    await writeFile(path.join(root, "index.md"), marker("0.2"));
    for (const id of ["a", "b"]) await writeFile(path.join(root, `${id}.md`), "---\ntype: Note\ntimestamp: 2026-01-02\n---\nbody\n");
    await run(root, new CountedBackend(root));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("healthy batch/query/head scans read root metadata once with identical raw document versions", async () => {
  await fixture(async (_root, backend) => {
    const singles = [await backend.read("a"), await backend.read("b")];
    backend.rootReads = 0;
    assert.deepEqual(await backend.readMany(["a", "b"]), singles);
    assert.equal(backend.rootReads, 1);
    backend.rootReads = 0;
    assert.deepEqual(await query(backend), singles.map(row => row.doc));
    assert.equal(backend.rootReads, 1);
    backend.rootReads = 0;
    const heads = await queryHeads(backend);
    assert.equal(heads.length, 2);
    assert.deepEqual(heads.map(row => row.frontmatter.timestamp), ["2026-01-02", "2026-01-02"]);
    assert.equal(backend.rootReads, 1);
  });
});

test("empty/unsafe batches and missing first documents do not read root metadata", async () => {
  await fixture(async (_root, backend) => {
    assert.deepEqual(await backend.readMany([]), []);
    await assert.rejects(backend.readMany(["a", "../bad"]));
    await assert.rejects(backend.readMany(["missing"]), { code: "ENOENT" });
    assert.equal(backend.rootReads, 0);
  });
});

test("batch-local metadata includes missing/malformed roots but never caches across calls", async () => {
  await fixture(async (root, backend) => {
    for (const [content, expected] of [
      [marker("0.2"), "2026-01-02"],
      [marker("0.1"), "2026-01-02T00:00:00.000Z"],
      ["---\nokf_version: [\n---\n", "2026-01-02T00:00:00.000Z"],
      [undefined, "2026-01-02T00:00:00.000Z"],
      [marker("0.2"), "2026-01-02"],
    ] as const) {
      if (content === undefined) await rm(path.join(root, "index.md"));
      else await writeFile(path.join(root, "index.md"), content);
      backend.rootReads = 0;
      assert.deepEqual((await backend.readMany(["a", "b"])).map(row => row.doc.frontmatter.timestamp), [expected, expected]);
      assert.equal(backend.rootReads, 1);
    }
  });
});

test("subclass read overrides retain their readMany dispatch", async () => {
  await fixture(async (root) => {
    class CustomRead extends CountedBackend {
      calls: string[] = [];
      override async read(id: string) {
        this.calls.push(id);
        const result = await super.read(id);
        result.doc.frontmatter.custom = "override";
        return result;
      }
    }
    const backend = new CustomRead(root);
    assert.deepEqual((await backend.readMany(["a", "b"])).map(row => row.doc.frontmatter.custom), ["override", "override"]);
    assert.deepEqual(backend.calls, ["a", "b"]);
  });
});

test("concurrent batches own separate lazy edition snapshots", async () => {
  await fixture(async (root) => {
    let signalEntered!: () => void;
    let signalRelease!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const release = new Promise<void>(resolve => { signalRelease = resolve; });
    class PausedRoot extends CountedBackend {
      override async readReserved(...args: Parameters<FilesystemBackend["readReserved"]>) {
        const result = await super.readReserved(...args);
        if (this.rootReads === 1) { signalEntered(); await release; }
        return result;
      }
    }
    const backend = new PausedRoot(root);
    const first = backend.readMany(["a", "b"]);
    await entered;
    try {
      await writeFile(path.join(root, "index.md"), marker("0.1"));
      const second = await backend.readMany(["a", "b"]);
      assert.deepEqual(second.map(row => row.doc.frontmatter.timestamp), ["2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    } finally { signalRelease(); }
    assert.deepEqual((await first).map(row => row.doc.frontmatter.timestamp), ["2026-01-02", "2026-01-02"]);
    assert.equal(backend.rootReads, 2);
  });
});

test("batch root I/O failures propagate after document observation", async () => {
  await fixture(async (root) => {
    const failure = Object.assign(new Error("root denied"), { code: "EACCES" });
    class DeniedRoot extends FilesystemBackend {
      calls = 0;
      override async readReserved(): Promise<never> { this.calls++; throw failure; }
    }
    const backend = new DeniedRoot(root);
    await assert.rejects(backend.readMany(["missing"]), { code: "ENOENT" });
    assert.equal(backend.calls, 0);
    await assert.rejects(backend.readMany(["a", "b"]), error => error === failure);
    assert.equal(backend.calls, 1);
  });
});
