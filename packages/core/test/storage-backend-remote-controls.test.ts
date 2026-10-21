import test from "node:test";
import assert from "node:assert/strict";

import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";
import type { OkfDocument, WriteOptions } from "../src/types.js";
import { assertAtomicCasContract, assertSerializedBodyContract } from "./storage-backend-contract.js";
import { remoteFixture, remotePeerFixture } from "./storage-backend-remote-fixture.js";

/** Wire-valid responses with a body shape that violates the storage seam's read contract.
 * The current reference router normalizes writes before storage, so changing write alone
 * would not exercise the client against a noncanonical server response.
 */
class NoncanonicalBodyServer extends ServerMemoryBackend {
  readonly observation: "read" | "readMany";
  constructor(observation: "read" | "readMany") {
    super();
    this.observation = observation;
  }

  override async read(id: string) {
    const result = await super.read(id);
    return this.observation === "read"
      ? { ...result, doc: { ...result.doc, body: result.doc.body.replace(/\n$/, "") } }
      : result;
  }

  override async readMany(ids: string[]) {
    const results = await super.readMany(ids);
    return this.observation === "readMany"
      ? results.map(result => ({ ...result, doc: { ...result.doc, body: result.doc.body.replace(/\n$/, "") } }))
      : results;
  }
}

/** A server-store defect: accepts guarded writes unconditionally, while preserving other options. */
class UnconditionalServer extends ServerMemoryBackend {
  override async write(id: string, doc: OkfDocument, options: WriteOptions = {}) {
    const { expectedVersion: _ignored, ...unguarded } = options;
    return super.write(id, doc, unguarded);
  }
}

test("remote body contract passes with the conforming server store", async () => {
  const fixture = remoteFixture();
  try { await assertSerializedBodyContract(fixture.backend); }
  finally { await fixture.cleanup(); }
});

for (const observation of ["read", "readMany"] as const) {
  test(`remote body contract detects noncanonical server ${observation} at the body assertion`, async () => {
    const fixture = remoteFixture(new NoncanonicalBodyServer(observation));
    try {
      await assert.rejects(() => assertSerializedBodyContract(fixture.backend), (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.operator, "strictEqual");
        assert.equal(error.actual, "no trailing newline");
        assert.equal(error.expected, "no trailing newline\n");
        assert.match(error.message, new RegExp(`${observation} must expose the serialized body`));
        return true;
      });
    } finally { await fixture.cleanup(); }
  });
}

test("remote peer CAS contract passes with the conforming server store", async () => {
  await assertAtomicCasContract(() => remotePeerFixture());
});

test("remote peer CAS contract detects a server accepting every stale write", async () => {
  await assert.rejects(() => assertAtomicCasContract(() => remotePeerFixture(new UnconditionalServer())), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.equal(error.operator, "strictEqual");
    assert.equal(error.actual, 8);
    assert.equal(error.expected, 1);
    assert.match(error.message, /CAS must admit exactly one concurrent writer/);
    return true;
  });
});

class ForeignIdentityServer extends ServerMemoryBackend {
  override async read(id: string) {
    const result = await super.read(id);
    return { ...result, doc: { ...result.doc, id: "foreign/identity" } };
  }
}

test("remote adapter owns read identities even when the server returns foreign ids", async () => {
  const fixture = remoteFixture(new ForeignIdentityServer());
  try {
    const ids = ["concepts/first", "concepts/second"];
    for (const id of ids) await fixture.backend.write(id, { id, frontmatter: { type: "Note" }, body: `${id}\n` });
    assert.equal((await fixture.backend.read(ids[0]!)).doc.id, ids[0]);
    const many = await fixture.backend.readMany([...ids].reverse());
    assert.deepEqual(many.map(result => result.doc.id), [...ids].reverse());
    assert.deepEqual(many.map(result => result.doc.body), [...ids].reverse().map(id => `${id}\n`));
  } finally { await fixture.cleanup(); }
});

class RecordingBodyServer extends ServerMemoryBackend {
  readonly submissions: string[] = [];
  override async write(id: string, doc: OkfDocument, options: WriteOptions = {}) {
    this.submissions.push(doc.body);
    return super.write(id, doc, options);
  }
}

test("reference router normalizes submitted bodies before the server store", async () => {
  const server = new RecordingBodyServer();
  const fixture = remoteFixture(server);
  try {
    await fixture.backend.write("concepts/body", { id: "concepts/body", frontmatter: { type: "Note" }, body: "no trailing newline" });
    assert.deepEqual(server.submissions, ["no trailing newline\n"]);
  } finally { await fixture.cleanup(); }
});
