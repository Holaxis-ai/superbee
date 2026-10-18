// Records what portal-webmcp's `superbee_search_documents` answers for a fixed corpus and a table of
// queries, as the parity fixture `test/fixtures/search-parity.json`. The test `search-parity.test.ts`
// runs the same table through `@superbee/core/search` over its memory source and compares.
//
//   node packages/core/test/fixture-generators/search-parity-fixture.mjs <dir>
//
// <dir> holds node_modules with @superbee/portal-webmcp (the version to match, 0.3.1) and its peer
// @superbee/portal, for example a scratch directory after
// `npm install --ignore-scripts @superbee/portal-webmcp@0.3.1 @superbee/portal@0.2.10`. Nothing is
// installed into this repository. The corpus goes through Portal's own client-v2 validator, the tool
// answers give ids, match evidence, excerpts and the query, and Portal's ranking (its dist/search.js,
// over the same read model) gives the scores the tool does not show.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: search-parity-fixture.mjs <dir with node_modules/@superbee/portal-webmcp>");
  process.exit(2);
}
const modules = join(resolve(dir), "node_modules", "@superbee");
const webmcpPackage = JSON.parse(readFileSync(join(modules, "portal-webmcp", "package.json"), "utf8"));
const portalPackage = JSON.parse(readFileSync(join(modules, "portal", "package.json"), "utf8"));
const load = (file) => import(pathToFileURL(file).href);
const webmcp = await load(join(modules, "portal-webmcp", "dist", "index.js"));
const portalSearch = await load(join(modules, "portal-webmcp", "dist", "search.js"));
const { PORTAL_WEBMCP_LIMITS_V1 } = await load(join(modules, "portal-webmcp", "dist", "v1.js"));
const { loadValidatedPortalPublicationV2 } = await load(join(modules, "portal", "dist", "client-v2.js"));

const DECOMPOSED_E = "é";
const ACUTE_E = "é";
// The corpus: Portal's own search fixtures (search.test.mjs) in one bundle, plus field-accessor and
// occurrence-cap cases. Ids must be unique; each Portal case keeps its documents.
const DOCUMENTS = [
  // Scoring: title equality > title prefix > id equality > body.
  { id: "notes/exact", frontmatter: { title: "Alpha Beta" }, body: "nothing here\n" },
  { id: "notes/prefix", frontmatter: { title: "Alpha Beta Gamma" }, body: "nothing here\n" },
  { id: "alpha/beta", frontmatter: { title: "Unrelated Words" }, body: "alpha beta\n" },
  { id: "notes/body", frontmatter: { title: "Words" }, body: "alpha beta alpha beta\n" },
  // Ties break on id in code-unit order.
  { id: "ties/zzz", frontmatter: { title: "Same" }, body: "same\n" },
  { id: "ties/aaa", frontmatter: { title: "Same" }, body: "same\n" },
  { id: "ties/Mmm", frontmatter: { title: "Same" }, body: "same\n" },
  // NFKC then lowercase, a ligature, a decomposed body.
  { id: "unicode/cafe", frontmatter: { title: `Caf${ACUTE_E}` }, body: "ﬁnal\n" },
  { id: "unicode/decomposed", frontmatter: {}, body: `caf${DECOMPOSED_E} tail\n` },
  {
    id: "unicode/samples",
    frontmatter: { title: "Untitled" },
    body: "½ ℀ ㎃ ＡＢ ① Å Å Ⅸ µ İ ⁵ Ǆ 中文 text naïve\n",
  },
  // Automatic fallback on an ordinary technical question.
  {
    id: "architecture/bundle-engine",
    frontmatter: { title: "Bundle Engine", description: "How documents are stored." },
    body: "Documents become immutable records in the publication.\n",
  },
  { id: "guides/documents", frontmatter: { title: "Documents" }, body: "A short guide.\n" },
  { id: "notes/other", frontmatter: { title: "Other" }, body: "No shared vocabulary.\n" },
  // Per-term field evidence.
  {
    id: "notes/alpha",
    frontmatter: { title: "Alpha", type: "Note", tags: ["blue"], description: "Alpha summary" },
    body: "Alpha appears in the body.\n",
  },
  // Any-term matching ranks coverage first.
  { id: "any/a", frontmatter: { title: "Alpha" }, body: "nothing\n" },
  { id: "any/b", frontmatter: { title: "Other" }, body: "alpha beta\n" },
  // Exact type and tag filters.
  { id: "filters/a", frontmatter: { type: "Note", title: "One", tags: ["red"] }, body: "shared\n" },
  { id: "filters/b", frontmatter: { type: "Design", title: "Two", tags: ["blue"] }, body: "shared\n" },
  // Excerpts: a long lead, the first body match, a description when the body has none.
  { id: "excerpts/lead", frontmatter: {}, body: `${"lorem ".repeat(80)}\n\n   needle   tail tail tail\n` },
  { id: "excerpts/order", frontmatter: {}, body: "beta rules here. gamma follows later.\n" },
  { id: "excerpts/described", frontmatter: { description: "  A described note.  " }, body: "" },
  // Id segment and tag scores are independent of description and type.
  { id: "alpha/one", frontmatter: { title: "Unrelated", description: "Nothing." }, body: "nothing here\n" },
  { id: "notes/two", frontmatter: { title: "Unrelated", description: "Nothing." }, body: "alpha here\n" },
  { id: "notes/c", frontmatter: { type: "Note", title: "Unrelated", tags: ["blue"] }, body: "nothing here\n" },
  { id: "notes/d", frontmatter: { type: "Note", title: "Unrelated" }, body: "blue here\n" },
  // Field accessors: non-string title, type and tags contribute nothing.
  { id: "fields/odd", frontmatter: { title: 42, type: ["Note"], tags: ["green", 7, null] }, body: "odd fields\n" },
  // The body occurrence cap (20) and the conversational-only query.
  { id: "counts/many", frontmatter: { title: "Repeat" }, body: `${"echo ".repeat(30)}\n` },
  { id: "counts/few", frontmatter: { title: "Few" }, body: `${"echo ".repeat(3)} the and of\n` },
];

// Each case: a request (Portal's input names; limit 50 so the whole ranking is recorded).
const CASES = [
  { query: "alpha beta" },
  { query: "alpha beta", match: "all" },
  { query: "alpha beta", match: "any" },
  { query: "alpha alpha beta beta alpha" },
  { query: "same" },
  { query: `CAF${ACUTE_E}` },
  { query: `caf${DECOMPOSED_E}` },
  { query: "final" },
  { query: "How does the bundle engine persist documents?" },
  { query: "How does quux frobnicate?" },
  { query: "alpha nowhere", match: "all" },
  { query: "alpha nowhere" },
  { query: "alpha blue", match: "all" },
  { query: "shared", type: "Note" },
  { query: "shared", tag: "blue" },
  { query: "shared", type: "note" },
  { query: "How does shared work", type: "Note" },
  { query: "needle" },
  { query: "gamma beta" },
  { query: "described" },
  { query: "alpha" },
  { query: "blue" },
  { query: "odd green" },
  { query: "echo" },
  { query: "the and of" },
  { query: "the" },
  { query: "½" },
  { query: "中文" },
  { query: "AB Ⅸ" },
  { query: "text naïve", match: "any" },
];

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
const encoder = new TextEncoder();
const filler = (character) => `sha256:${character.repeat(64)}`;

// A complete Portal v2 publication, loaded through Portal's validator (as Portal's own test fixture).
async function publication() {
  const documents = DOCUMENTS.map((document) => ({
    id: document.id,
    version: sha(`document:${document.id}:${document.body}`),
    frontmatter: document.frontmatter,
    body: document.body,
    renderedHtml: `<p>${document.id}</p>\n`,
    renderedBounded: true,
    rawPath: `/bundle/${document.id}.md`,
  }));
  const index = "# Index\n";
  const reserved = [
    { dir: "", name: "index.md", version: sha(`reserved:/index.md:${index}`), path: "/bundle/index.md" },
  ];
  const snapshotDigest = filler("1");
  const readModel = {
    schema: "https://getsuperbee.com/schemas/portal-read-model/v1",
    snapshotDigest,
    documents,
    relationships: [],
    reserved,
    blobs: [],
    views: [],
  };
  const readModelBytes = encoder.encode(`${canonical(readModel)}\n`);
  const hostingDigest = filler("7");
  const files = [
    { path: "assets/portal-client-v1.js", digest: filler("8"), size: 1, mediaType: "text/javascript; charset=utf-8" },
    {
      path: "data/bundle.json",
      digest: sha(readModelBytes),
      size: readModelBytes.byteLength,
      mediaType: "application/json; charset=utf-8",
    },
    {
      path: "data/hosting-requirements.json",
      digest: hostingDigest,
      size: 1,
      mediaType: "application/json; charset=utf-8",
    },
    { path: "data/object-map.json", digest: filler("9"), size: 1, mediaType: "application/json; charset=utf-8" },
    { path: "data/snapshot.json", digest: filler("a"), size: 1, mediaType: "application/json; charset=utf-8" },
    ...documents.map((document, position) => ({
      path: `bundle/${document.id}.md`,
      digest: document.version,
      size: encoder.encode(DOCUMENTS[position].body).byteLength,
      mediaType: "text/markdown; charset=utf-8",
    })),
    {
      path: "bundle/index.md",
      digest: reserved[0].version,
      size: encoder.encode(index).byteLength,
      mediaType: "text/markdown; charset=utf-8",
    },
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifestBody = {
    schema: "https://getsuperbee.com/schemas/portal-artifact/v2",
    ownership: "superbee-portal",
    schemaVersion: 2,
    snapshotDigest,
    configDigest: filler("b"),
    hostingRequirementsDigest: hostingDigest,
    audience: "public",
    exposure: "complete-publication-bundle",
    okfEdition: "0.2",
    rendererProfile: "inert-v1",
    viewBridgeProtocol: "v0",
    counts: { documents: documents.length, relationships: 0, reserved: 1, blobs: 0, views: 0 },
    views: [],
    files,
    excludedInternalPaths: [".git"],
    warnings: [],
  };
  const manifest = { ...manifestBody, artifactDigest: sha(`${canonical(manifestBody)}\n`) };
  const manifestBytes = encoder.encode(`${canonical(manifest)}\n`);
  const fetch = async (path) =>
    path === "/data/portal-manifest.json"
      ? new Response(manifestBytes)
      : path === "/data/bundle.json"
        ? new Response(readModelBytes)
        : new Response("missing", { status: 404 });
  return { dto: await loadValidatedPortalPublicationV2({ fetch }), documents };
}

const { dto, documents } = await publication();
const tools = webmcp.createPortalWebMcpToolsV1({ publication: dto, origin: "https://parity.example" });
const search = tools.descriptors.find((tool) => tool.name === "superbee_search_documents");
const maxTerms = PORTAL_WEBMCP_LIMITS_V1.maxTermsPerDocument;
const index = portalSearch.buildSearchIndex(documents, undefined, maxTerms);
const cases = [];
for (const request of CASES) {
  const answer = await search.execute({ ...request, limit: 50 }, { signal: new AbortController().signal });
  if (!answer.ok) throw new Error(`Portal refused ${JSON.stringify(request)}: ${answer.error.code}`);
  const { data } = answer;
  // The tool hides scores; Portal's ranking over the same read model gives them, in the same order.
  const query = { phrase: data.query.terms.join(" "), terms: data.query.terms };
  const filters = { ...(request.type ? { type: request.type } : {}), ...(request.tag ? { tag: request.tag } : {}) };
  const ranked = portalSearch.rankDocuments(index, query, filters, data.query.effectiveMatch);
  const ids = data.documents.map((row) => row.id);
  if (JSON.stringify(ranked.map((hit) => hit.document.id)) !== JSON.stringify(ids))
    throw new Error(`Portal's ranking and tool disagree for ${JSON.stringify(request)}`);
  cases.push({
    request,
    expected: {
      hits: data.documents.map((row, position) => ({
        id: row.id,
        score: ranked[position].score,
        matchedTerms: row.match.terms,
        excerpt: row.excerpt,
      })),
      total: data.page.total,
      query: data.query,
      ...(data.guidance === undefined ? {} : { guidance: data.guidance }),
    },
  });
}

const fixture = {
  source: `@superbee/portal-webmcp@${webmcpPackage.version} superbee_search_documents (createPortalWebMcpToolsV1) over @superbee/portal@${portalPackage.version} client-v2`,
  algorithm: "portal-webmcp-search/v1",
  indexDigest: index.indexDigest,
  documents: documents.map(({ id, version, frontmatter, body }) => ({ id, version, frontmatter, body })),
  cases,
};
const out = fileURLToPath(new URL("../fixtures/search-parity.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${cases.length} cases over ${documents.length} documents to ${out}`);
