// documents.search.v1 parity: the engine over its memory source against portal-webmcp 0.3.1's recorded
// answers for one corpus (fixtures/search-parity.json, recorded by fixture-generators/search-parity-fixture.mjs and
// moved byte for byte from superbee-hosted's agent-operations, where the engine lived before core).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { memorySearchSource, searchDocuments, SEARCH_ALGORITHM, type SearchDocumentV1 } from "../src/search/index.js";

interface ParityCase {
  readonly request: { query: string; match?: "all" | "any"; type?: string; tag?: string };
  readonly expected: {
    readonly hits: { id: string; score: number; matchedTerms: unknown; excerpt: string }[];
    readonly total: number;
    readonly query: Record<string, unknown>;
    readonly guidance?: string;
  };
}

const fixtureBytes = readFileSync(new URL("./fixtures/search-parity.json", import.meta.url));
const parity = JSON.parse(fixtureBytes.toString("utf8")) as {
  readonly algorithm: string;
  readonly indexDigest: string;
  readonly documents: SearchDocumentV1[];
  readonly cases: ParityCase[];
};

test("the parity fixture is the recorded portal-webmcp 0.3.1 golden, byte for byte", () => {
  // The SHA-256 of superbee-hosted's packages/agent-operations/test/fixtures/search-parity.json (git blob abd77abd).
  assert.equal(
    createHash("sha256").update(fixtureBytes).digest("hex"),
    "2aac8eb568fc345e3df915b5a20fa7325bc02afd3a532d08c5f92724e5386fa9",
  );
  assert.equal(parity.algorithm, SEARCH_ALGORITHM);
  assert.equal(parity.documents.length, 28);
  assert.equal(parity.cases.length, 30);
});

test("the memory source indexes, ranks, scores and excerpts the parity corpus exactly as portal-webmcp 0.3.1", async () => {
  const source = memorySearchSource(parity.documents, { key: "parity" });
  const byId = new Map(parity.documents.map((document) => [document.id, document]));
  const seen = new Set<string>();
  // The lazy identity is Portal's, byte for byte: it hashes every body occurrence's byte range.
  assert.equal(source.indexDigest, parity.indexDigest);
  for (const { request, expected } of parity.cases) {
    const answer = await searchDocuments(source, { ...request, limit: 50 });
    const label = JSON.stringify(request);
    const recorded = {
      hits: answer.hits.map(({ id, score, matchedTerms, excerpt }) => ({ id, score, matchedTerms, excerpt })),
      total: answer.total,
      query: answer.query,
      ...(answer.guidance === undefined ? {} : { guidance: answer.guidance }),
    };
    assert.deepEqual(recorded, expected, label);
    // Byte identity, member order included.
    assert.equal(JSON.stringify(recorded), JSON.stringify(expected), label);
    assert.equal(answer.corpus.documents, parity.documents.length, label);
    // The members the golden does not store are pure functions of the fixture document's frontmatter.
    for (const hit of answer.hits) {
      const document = byId.get(hit.id)!;
      const { title, type, tags } = document.frontmatter;
      assert.deepEqual(
        { version: hit.version, title: hit.title, type: hit.type, tags: hit.tags },
        {
          version: document.version,
          title: typeof title === "string" ? title : undefined,
          type: typeof type === "string" ? type : undefined,
          tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string") : [],
        },
        `${label} ${hit.id}`,
      );
      assert.equal("title" in hit, typeof title === "string", `${label} ${hit.id} title member`);
      assert.equal("type" in hit, typeof type === "string", `${label} ${hit.id} type member`);
      for (const [member, present] of [
        ["title", hit.title !== undefined],
        ["type", hit.type !== undefined],
        ["tags", hit.tags.length > 0],
      ] as const)
        seen.add(`${member}:${present}`);
    }
  }
  // The table reaches hits with and without each of those members.
  assert.deepEqual([...seen].sort(), ["tags:false", "tags:true", "title:false", "title:true", "type:false", "type:true"]);
});
