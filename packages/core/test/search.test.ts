// @superbee/core/search: the engine's contract over the memory source (paging, cursors, the page budget,
// facets, request bounds, refusals, corpus bounds and cancellation) and the SearchSource seam (the engine
// reads only evidence, applies the filters itself and asks text only for the page it returns).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  memorySearchSource,
  searchDocuments,
  SearchAbortError,
  SearchInputError,
  SearchLimitError,
  SEARCH_LIMITS,
  SEARCH_MAX_OUTPUT_BYTES,
  validateSearchRequest,
  type SearchDocumentV1,
  type SearchEvidenceBatchV1,
  type SearchRequestV1,
  type SearchSource,
} from "../src/search/index.js";

const parity = JSON.parse(readFileSync(new URL("./fixtures/search-parity.json", import.meta.url), "utf8")) as {
  readonly documents: SearchDocumentV1[];
  readonly cases: { request: SearchRequestV1 }[];
};

/** Planted in inputs; no refusal may repeat it. */
const MARKER = "zz-planted-marker";
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
const doc = (id: string, frontmatter: Record<string, unknown>, body: string): SearchDocumentV1 => ({
  id,
  version: `v:${id}`,
  frontmatter,
  body,
});

async function refusal(promise: Promise<unknown>): Promise<SearchInputError> {
  const error = await promise.then(
    () => assert.fail("expected a refusal"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof SearchInputError, String(error));
  return error;
}

test("pages walk the whole ranking; a cursor is refused for another corpus, scope, query, match or filters", async () => {
  const documents = Array.from({ length: 23 }, (_, n) =>
    doc(
      `notes/n${String(n).padStart(2, "0")}`,
      { type: n % 2 ? "Odd" : "Even", tags: [`t${n % 3}`], title: `Lock ${n}` },
      `lock ${"gate ".repeat(n % 5)}`,
    ),
  );
  const source = memorySearchSource(documents, { key: "snapshot-1" });
  const search = (request: SearchRequestV1, scope = "canal") => searchDocuments(source, request, { scope });
  const whole = await search({ query: "lock", limit: 50 });
  assert.equal(whole.total, 23);
  assert.equal(whole.nextCursor, undefined);
  const walked: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await search({ query: "lock", limit: 10, ...(cursor ? { cursor } : {}) });
    walked.push(...page.hits.map((hit) => hit.id));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(
    walked,
    whole.hits.map((hit) => hit.id),
  );

  const next = (await search({ query: "lock", type: "Odd", limit: 3 })).nextCursor!;
  assert.ok(next);
  // The same query, match and filters continue, at any page size; casing and duplicates normalize away.
  for (const same of [
    { query: "lock", type: "Odd", cursor: next },
    { query: "LOCK lock", type: "Odd", cursor: next, limit: 7 },
  ])
    assert.ok((await search(same)).hits.length > 0, JSON.stringify(same));
  const refused: SearchRequestV1[] = [
    { query: "gate", type: "Odd", cursor: next },
    { query: "lock", type: "Odd", match: "any", cursor: next },
    { query: "lock", type: "Even", cursor: next },
    { query: "lock", cursor: next },
    { query: "lock", type: "Odd", tag: "t1", cursor: next },
    // Forged and corrupted cursors.
    { query: "lock", type: "Odd", cursor: `${next}x` },
    { query: "lock", type: "Odd", cursor: Buffer.from('{"b":"00","p":3,"v":1}').toString("base64url") },
    { query: "lock", type: "Odd", cursor: MARKER },
  ];
  for (const request of refused) {
    const error = await refusal(search(request));
    assert.equal(error.reason, "cursor", JSON.stringify(request));
    assert.doesNotMatch(error.message, new RegExp(`${MARKER}|${next}`));
  }
  // A position past the hits, bound correctly, is refused rather than answered empty.
  const binding = JSON.parse(Buffer.from(next, "base64url").toString()).b;
  const past = Buffer.from(JSON.stringify({ b: binding, p: 999, v: 1 })).toString("base64url");
  assert.equal((await refusal(search({ query: "lock", type: "Odd", cursor: past }))).reason, "cursor");
  // Another scope, or the same documents under another corpus key, is another corpus.
  assert.equal((await refusal(search({ query: "lock", type: "Odd", cursor: next }, "other"))).reason, "cursor");
  const republished = memorySearchSource(documents, { key: "snapshot-2" });
  await refusal(searchDocuments(republished, { query: "lock", type: "Odd", cursor: next }, { scope: "canal" }));
  assert.equal((await searchDocuments(republished, { query: "lock", type: "Odd", limit: 3 }, { scope: "canal" })).total, 11);
});

test("a page of long hits that would pass the answer budget ends early with a cursor at the cut", async () => {
  const words = Array.from({ length: 16 }, (_, n) => `word${n}`);
  const prose = 'The towpath "runs" east\tpast the lock and the old mill. '.repeat(12);
  const documents = Array.from({ length: 60 }, (_, n) =>
    doc(
      `notes/n${String(n).padStart(2, "0")}`,
      { type: "Note", title: `Lock keeper's note ${n}`, tags: ["canal", "history"] },
      `${words.join(" ")} ${prose}`,
    ),
  );
  const source = memorySearchSource(documents, { key: "k" });
  const query = words.join(" ");
  const maxResultBytes = SEARCH_MAX_OUTPUT_BYTES - 256;
  const walked: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const answer = await searchDocuments(source, { query, limit: 50, ...(cursor ? { cursor } : {}) }, {}, undefined, {
      maxResultBytes,
    });
    assert.ok(utf8(JSON.stringify(answer)) <= maxResultBytes);
    walked.push(...answer.hits.map((hit) => hit.id));
    cursor = answer.nextCursor;
    pages += 1;
  } while (cursor);
  assert.ok(pages >= 2, `answered in ${pages} page`);
  assert.deepEqual(
    walked,
    documents.map((document) => document.id),
  );
});

test("facets count type and tags over every hit, most frequent first, at most 50 values", async () => {
  const documents = Array.from({ length: 60 }, (_, n) =>
    doc(
      `places/p${String(n).padStart(2, "0")}`,
      {
        type: n < 40 ? "Place" : "Event",
        // tag-00 on every hit, tag-01 on half, then one tag of its own each: 62 distinct tags.
        tags: ["tag-00", ...(n % 2 ? ["tag-01"] : []), `own-${String(n).padStart(2, "0")}`, "tag-00"],
      },
      n < 55 ? "towpath" : "elsewhere",
    ),
  );
  const source = memorySearchSource(documents, { key: "k" });
  const answer = await searchDocuments(source, { query: "towpath", limit: 1, facets: ["tags", "type"] });
  assert.equal(answer.total, 55);
  assert.deepEqual(answer.facets?.type, [
    { value: "Place", count: 40 },
    { value: "Event", count: 15 },
  ]);
  const tags = answer.facets!.tags!;
  assert.equal(tags.length, 50);
  // A repeated tag counts once per document; ties order by value in code-unit order.
  assert.deepEqual(tags.slice(0, 3), [
    { value: "tag-00", count: 55 },
    { value: "tag-01", count: 27 },
    { value: "own-00", count: 1 },
  ]);
  assert.equal(tags.at(-1)!.value, "own-47");
  // Facets follow the filters, and are absent unless asked for.
  const events = await searchDocuments(source, { query: "towpath", type: "Event", facets: ["type"] });
  assert.deepEqual(events.facets, { type: [{ value: "Event", count: 15 }] });
  assert.equal((await searchDocuments(source, { query: "towpath" })).facets, undefined);
  assert.equal((await searchDocuments(source, { query: "towpath", facets: [] })).facets, undefined);
  for (const facets of [["type", "type"], ["kind"]])
    assert.equal(
      (await refusal(searchDocuments(source, { query: "towpath", facets: facets as never }))).reason,
      "facets",
    );
});

test("queries are held to 16 terms and 1 KiB, and excerpts to 512 bytes", async () => {
  const body = `${"Überwachung des Schleusentors ".repeat(40)}schleuse ${"Überwachung ".repeat(80)}`;
  const source = memorySearchSource(
    [
      doc("notes/lock", { title: "Lock", description: "Ä".repeat(600) }, body),
      doc("notes/bare", { title: "Bare", description: "Ö".repeat(600) }, ""),
    ],
    { key: "k" },
  );
  const search = (request: SearchRequestV1) => searchDocuments(source, request);
  const terms = (count: number) => Array.from({ length: count }, (_, n) => `t${n}`).join(" ");
  assert.equal((await search({ query: terms(16) })).total, 0);
  assert.equal((await search({ query: `${terms(16)} t0 T1` })).total, 0, "duplicates collapse before the cap");
  assert.equal((await refusal(search({ query: terms(17) }))).reason, "too-many-query-terms");
  const kib = `lock ${"x".repeat(1019)}`;
  assert.equal(utf8(kib), 1024);
  await search({ query: kib });
  assert.equal((await refusal(search({ query: `${kib}y` }))).reason, "query");
  assert.equal((await refusal(search({ query: `lock ${"é".repeat(510)}` }))).reason, "query", "bytes, not characters");
  assert.equal((await refusal(search({ query: "!!! ???" }))).reason, "empty-query");
  for (const query of ["schleuse", "überwachung", "bare"]) {
    const answer = await search({ query });
    assert.ok(answer.hits.length > 0, query);
    for (const hit of answer.hits) assert.ok(utf8(hit.excerpt) <= SEARCH_LIMITS.excerptBytes, `${query}: ${utf8(hit.excerpt)} bytes`);
    assert.ok(answer.hits.every((hit) => hit.excerpt.length > 0));
  }
  assert.match((await search({ query: "schleuse" })).hits[0]!.excerpt, /schleuse/u);
});

test("refusals carry a fixed reason and text, never the input", async () => {
  const source = memorySearchSource([doc("notes/a", { title: "A" }, "alpha")], { key: "k" });
  const cases: [unknown, string][] = [
    [{ query: MARKER, match: "some" }, "match"],
    [{ query: "alpha", limit: 51 }, "limit"],
    [{ query: "alpha", limit: 0 }, "limit"],
    [{ query: "alpha", limit: 1.5 }, "limit"],
    [{ query: "alpha", type: "" }, "filter"],
    [{ query: "alpha", tag: `${MARKER}${"x".repeat(300)}` }, "filter"],
    [{ query: `${MARKER} ${Array.from({ length: 17 }, (_, n) => `w${n}`).join(" ")}` }, "too-many-query-terms"],
    [{}, "query"],
    [null, "query"],
  ];
  for (const [input, reason] of cases) {
    const error = await refusal(searchDocuments(source, input as SearchRequestV1));
    assert.equal(error.reason, reason, JSON.stringify(input));
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, new RegExp(MARKER));
  }
});

test("validateSearchRequest holds a request to the contract's members and bounds and returns a copy", () => {
  const facets = ["type"] as const;
  const request = { query: "alpha", match: "any", type: "Note", tag: "blue", limit: 5, cursor: "abc", facets };
  const checked = validateSearchRequest(request);
  assert.deepEqual(checked, { ...request, facets: ["type"] });
  assert.notEqual(checked.facets, facets);
  assert.deepEqual(validateSearchRequest({ query: "alpha" }), { query: "alpha" });
  const cases: [unknown, string][] = [
    [null, "request"],
    ["alpha", "request"],
    [["alpha"], "request"],
    [{ query: "alpha", bundleId: "canal" }, "request"],
    [{ query: "alpha", [MARKER]: true }, "request"],
    [JSON.parse('{"query":"alpha","__proto__":{"limit":1}}'), "request"],
    [{ query: "alpha", cursor: "" }, "cursor"],
    [{ query: "alpha", cursor: "x".repeat(SEARCH_LIMITS.maxCursorBytes + 1) }, "cursor"],
    [{ query: "alpha", match: "some" }, "match"],
    [{ query: "" }, "empty-query"],
  ];
  for (const [input, reason] of cases) {
    assert.throws(
      () => validateSearchRequest(input),
      (error: unknown) => error instanceof SearchInputError && error.reason === reason && !error.message.includes(MARKER),
      JSON.stringify(input),
    );
  }
});

test("a corpus over an index limit or a host bound is refused whole, with the binding limit named", () => {
  const documents = [
    doc("notes/a", { type: "N", title: "Alpha" }, "alpha ".repeat(40)),
    doc("notes/b", { type: "N", title: "Beta" }, "beta"),
  ];
  // id + type + title + body bytes: 7 + 1 + 5 + 240 and 7 + 1 + 4 + 4.
  memorySearchSource(documents, { key: "k", maxSourceBytes: 269 });
  const over = (options: Parameters<typeof memorySearchSource>[1]) => () => memorySearchSource(documents, options);
  assert.throws(over({ key: "k", maxSourceBytes: 268 }), (error: unknown) => {
    assert.ok(error instanceof SearchLimitError);
    assert.deepEqual([error.limit, error.max, error.actual], ["maxSourceBytes", 268, 269]);
    return true;
  });
  assert.throws(over({ key: "k", maxDocuments: 1 }), { name: "SearchLimitError", limit: "maxDocuments" });
  memorySearchSource(documents, { key: "k", maxDocuments: 2 });
  // A host bound above the engine's ceiling is the ceiling.
  const many = Array.from({ length: SEARCH_LIMITS.maxIndexDocuments + 1 }, (_, n) => doc(`d/${n}`, {}, ""));
  assert.throws(() => memorySearchSource(many, { key: "k", maxDocuments: 10 ** 6 }), {
    name: "SearchLimitError",
    limit: "maxIndexDocuments",
  });
  for (const options of [{ key: "" }, { key: "k", maxSourceBytes: 0 }, { key: "k", maxDocuments: 1.5 }])
    assert.throws(over(options as never), TypeError, JSON.stringify(options));
});

test("cancellation rejects a build and a search; a host check stops them as it throws", async () => {
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => memorySearchSource(parity.documents, { key: "k", stop: { signal: aborted.signal } }), SearchAbortError);
  const deadline = new Error("deadline");
  assert.throws(
    () =>
      memorySearchSource(parity.documents, {
        key: "k",
        stop: {
          check: () => {
            throw deadline;
          },
        },
      }),
    (error: unknown) => error === deadline,
  );
  const source = memorySearchSource(parity.documents, { key: "k" });
  await assert.rejects(searchDocuments(source, { query: "alpha" }, {}, { signal: aborted.signal }), SearchAbortError);
});

test("the memory source never re-reads a document after its build", async () => {
  let bodyReads = 0;
  const counted = parity.documents.map((document) => ({
    ...document,
    get body() {
      bodyReads += 1;
      return document.body;
    },
  }));
  const source = memorySearchSource(counted, { key: "k" });
  const built = bodyReads;
  for (const { request } of parity.cases) await searchDocuments(source, { ...request, limit: 50 });
  assert.equal(bodyReads, built);
});

/** A source that answers what another source answered, reshaped as a native backend might return it. */
function replay(inner: SearchSource, reshape: (batch: SearchEvidenceBatchV1) => SearchEvidenceBatchV1) {
  const asked: string[][] = [];
  const source: SearchSource = {
    evidence: async (terms, filters, stop) => reshape(await inner.evidence(terms, filters, stop)),
    text: async (hits) => {
      asked.push(hits.map((hit) => hit.id));
      return inner.text(hits);
    },
  };
  return { source, asked };
}

test("the engine reads only evidence: the same evidence in another order and field order ranks byte-identically", async () => {
  const memory = memorySearchSource(parity.documents, { key: "parity" });
  const { source } = replay(memory, (batch) => ({
    ...batch,
    documents: [...batch.documents].reverse().map((evidence) => ({
      ...evidence,
      terms: new Map(
        [...evidence.terms].reverse().map(([term, held]) => [term, { ...held, fields: [...held.fields].reverse() }]),
      ),
    })),
  }));
  for (const { request } of parity.cases) {
    const expected = await searchDocuments(memory, { ...request, limit: 50, facets: ["type", "tags"] }, { scope: "s" });
    const answer = await searchDocuments(source, { ...request, limit: 50, facets: ["type", "tags"] }, { scope: "s" });
    assert.equal(JSON.stringify(answer), JSON.stringify(expected), JSON.stringify(request));
  }
});

test("the engine applies the exact filters itself and asks text only for the page it returns", async () => {
  const memory = memorySearchSource(parity.documents, { key: "parity" });
  const unfiltered = replay(memory, (batch) => batch);
  // A source that ignores the filters cannot widen them.
  unfiltered.source.evidence = async (terms, _filters, stop) => memory.evidence(terms, {}, stop);
  for (const request of [
    { query: "shared", type: "Note" },
    { query: "shared", tag: "blue" },
    { query: "alpha blue", type: "Note", tag: "blue" },
  ]) {
    assert.equal(
      JSON.stringify(await searchDocuments(unfiltered.source, request)),
      JSON.stringify(await searchDocuments(memory, request)),
      JSON.stringify(request),
    );
  }
  const paged = replay(memory, (batch) => batch);
  const first = await searchDocuments(paged.source, { query: "alpha", limit: 3 });
  assert.equal(first.hits.length, 3);
  assert.deepEqual(paged.asked, [first.hits.map((hit) => hit.id)]);
  await searchDocuments(paged.source, { query: "nowhere" });
  assert.equal(paged.asked.length, 1, "no text read when nothing matched");
});

test("a source must answer a corpus key; the engine refuses a malformed batch", async () => {
  const memory = memorySearchSource(parity.documents, { key: "parity" });
  for (const reshape of [
    (batch: SearchEvidenceBatchV1) => ({ ...batch, key: "" }),
    (batch: SearchEvidenceBatchV1) => ({ ...batch, documents: undefined as never }),
  ])
    await assert.rejects(searchDocuments(replay(memory, reshape).source, { query: "alpha" }), TypeError);
  await assert.rejects(searchDocuments({} as SearchSource, { query: "alpha" }), TypeError);
});

test("one document over the per-document term cap refuses the whole corpus", () => {
  const long = doc("notes/long", {}, "w ".repeat(SEARCH_LIMITS.maxTermsPerDocument + 1));
  assert.throws(() => memorySearchSource([...parity.documents, long], { key: "k" }), {
    name: "SearchLimitError",
    limit: "maxTermsPerDocument",
  });
  memorySearchSource([doc("notes/at-cap", {}, "w ".repeat(SEARCH_LIMITS.maxTermsPerDocument))], { key: "k" });
});
