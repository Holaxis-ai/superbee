# Browser-local measurements

This directory receives the report of `npm run measure:browser -w @superbee/browser-local`, the
measurement half of acceptance item 6 of the design `designs/local-first-hosts-and-working-state`.
The report (`latest.json` by default, or the path in `SUPERBEE_MEASURE_OUT`) is not committed.
Only this README is.

The run measures the browser-local prototype on IndexedDB against the request-driven baseline,
both built through the platform contract (`@superbee/core/platform`) over the same served
synthetic bundle, in a fresh Chromium context per cell. IndexedDB is the only store measured;
the OPFS and SQLite candidates are deferred.

## What is measured

Each cell is one bundle size (100, 1000, 5000 documents from the deterministic generator in
`test/fixtures/synthetic-bundle.ts`), one simulated latency (0, 50, 200 ms added to every
request at the served fixture), and one execution mode. Each cell is repeated three times by
default; the cell summary is the median across repetitions of each repetition's own summary
(the footprint is the exception, reported as a min and max), and every raw sample stays in the
JSON.

| Metric | Browser-local | Request-driven |
| --- | --- | --- |
| Cold open | `bootstrap`: root index, wire capabilities, one streamed snapshot written in batches of 25 as it arrives, one journaled IndexedDB write per document, from an empty working copy. Three requests at every size. | Wire capabilities, the list in pages of 50 rows, and the first 20 documents read one by one: 24, 42, and 122 requests at the three sizes (the bundle carries three convention documents beyond its size). |
| Presentation mount | Mounting the proof presentation over the open runtime and its first refresh (one `query` for the list, the selection's `read`, the status line), timed and counted apart from the cold open. | The same; its query and read are requests to the authority, listed as the mount's own traffic. |
| Warm read | 50 reads of seeded ids drawn without replacement (every bundle size has at least 50 documents) through the runtime's `read`, from IndexedDB. Median and p95. | The same 50 reads, each one request to the authority. |
| Warm query | 10 queries by type and 10 by tag through `query`: the working copy's heads listing, one readonly transaction over every record with its journal and shared base, parsing only leading frontmatter, filtered in the page. | The same 20 queries; the filter is pushed to the router, which returns thin frontmatter rows for the matches only, 50 per page. |
| Local commit | 20 commits through `commit` with no premise: the document write and its intent in one IndexedDB transaction. | The same 20 commits: a read then a PUT at the authority. |
| Reconciliation | Push of the 20 pending intents under the push role, then pull by one conditional heads request: the 20 acknowledged documents already match their heads, so the 200 is diffed against the working copy and no document is read. Wall time and request count. | Not applicable: nothing is pending. |
| Footprint | `navigator.storage.estimate()` in the same fresh context before the cold open and at three points after it (after bootstrap, after the presentation mount, at the end of the repetition), each as a delta from the fresh context, plus Chromium's `usageDetails.indexedDB` when reported. The cell reports the min and max across every sample. | Not applicable: no working copy. |
| Responsiveness | With the proof presentation mounted: select a document, click Commit, and time until the selected document's badge is re-rendered. Long tasks (`PerformanceObserver` `longtask`) are counted during the cold open and during the warm reads. | The same, over the request-driven runtime. |

The two cold opens are different operations by construction and the report names them beside
each number. Bootstrap hydrates the whole bundle once so every later read is local; the
request-driven first screen fetches only what one screen shows and pays the authority again for
every later verb. Each is the honest first-screen cost of its mode.

Request counts are observed at the served fixture's HTTP bridge. CORS preflights (OPTIONS) are
counted separately: the fixture disables preflight caching, so every non-simple request
preflights, and the bridge answers preflights without the simulated latency.

Every time is `performance.now()` in the page. The measurement driver's page is served with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and
the fixture's responses carry `Cross-Origin-Resource-Policy: cross-origin`, so the page is
cross-origin isolated and Chromium resolves the clock to 5 us. Without isolation the clock is
coarsened to 100 us, which is where a fast IndexedDB read sits. Each cell records whether its
pages were isolated (`crossOriginIsolated`), the table's conditions block prints it, and the
smoke row asserts it. Only the measurement driver carries the policy; the proof driver and the
other browser specs are unchanged.

## How to run

```sh
npm run build
npm run measure:browser -w @superbee/browser-local
node packages/browser-local/scripts/measurement-table.mjs < packages/browser-local/measurements/latest.json
```

Environment knobs: `SUPERBEE_MEASURE_OUT` (report path), `SUPERBEE_MEASURE_SIZES`,
`SUPERBEE_MEASURE_LATENCIES` (comma-separated lists), and `SUPERBEE_MEASURE_REPETITIONS` (one
value, or one per size). The plan actually run is recorded in the report.

`test:browser` runs only `measure-smoke.browser.spec.ts`: one repetition of the smallest cell in
each mode, and one round of the listing measurement below at the same size, asserting that every
metric is present and finite. Neither full plan runs in CI.

## The listing and the status count

`npm run measure:listing -w @superbee/browser-local` runs `test/measure-listing.browser.spec.ts`:
the runtime's `query` with no filter, `query` by one type, and `syncStatus`, whose unconfirmed
count considers every document, over a browser-local working copy of 1,000 documents with bodies
of 20 to 50 KB (the working-copy bound at a realistic document size), in a fresh Chromium context
per repetition, five rounds of each verb and three repetitions by default. Each verb is timed in
the page; its IndexedDB transactions are counted by a wrapper around the page's `indexedDB`;
`performance.memory.usedJSHeapSize` is sampled every millisecond while it runs, from a collected
baseline, and each of the listing and the status runs once more under a sampler that collects on
every tick, so that peak is the heap the verb held rather than garbage not yet collected (those
rounds measure memory only). The measurement config launches Chromium with `gc()` exposed and
precise memory readings. The report goes to `listing.json` here (or `SUPERBEE_MEASURE_LISTING_OUT`)
and renders through the same table script. Knobs: `SUPERBEE_MEASURE_LISTING_SIZE`, `_BODY_MIN`,
`_BODY_MAX`, `_ROUNDS`, `_REPETITIONS`.

### Recorded results at the bound

Both trees: 1,003 documents (1,000 plus the three conventions) with 36.2 MB of body text, five
rounds, three repetitions, Chromium 149, Node 26, Apple M4 Max, developer laptop with other load
not controlled. Every time is the median across repetitions of the repetition's own median;
transactions are the median count; heap held is the peak under the collecting sampler.

| tree | verb | median ms | transactions | heap held at peak |
| --- | --- | --- | --- | --- |
| before, `76128d80` (one snapshot per document) | query, no filter | 467 | 3,013 | 35.2 MiB |
| | query by type | 190 | 1,006 | not sampled |
| | syncStatus | 427 | 3,018 | 0.1 MiB |
| after, `6620b9c2` (one heads listing) | query, no filter | 110 | 3 | 0.1 MiB |
| | query by type | 108 | 3 | not sampled |
| | syncStatus | 108 | 11 | 0.1 MiB |

What the two trees do: before, a query scanned the store once with every record materialized
(the 35.2 MiB held) and then opened one snapshot transaction per row, and the count opened one
per document; after, a query is the admission's two reads (the mode row and the journal) plus
one listing transaction, and the status adds the journal status's own reads. The listing walks
the documents by cursor and keeps one record at a time: a `getAll` over the same store, measured
once on the after tree, listed in 75 ms but held 34.8 MiB, the whole store at once, so the
cursor buys flat memory for about 35 ms at this size. In body mode the listing also checks each
row's body evidence exactly as a single read does (the descriptors and the capacity assertion);
over the in-memory adapter at this size that check is about 115 ms of CPU per listing, against
5 ms for the plain-mode listing, and it comes on top of the store cost above.

## What the numbers do and do not say

- The report records the git SHA (and `gitDirty` when `git status --porcelain` was not empty;
  the table prints `<sha>-dirty`), Node, Chromium and Playwright versions, OS, CPU model, core
  count and memory, a timestamp, and `conditions: "developer laptop, other load not controlled"`.
  Nothing in the run controls or observes other load on the machine; compare cells within one
  report before comparing across reports.
- The footprint is a logical size, not an on-disk one. Playwright contexts keep IndexedDB in
  Chromium's in-memory LevelDB, and the estimate is Chromium's accounting of that state, which
  is bimodal: about twice the body bytes while the write-ahead log still holds the writes, and
  close to the body bytes (about 1.06 times at 1,000 documents) once the state is compacted and
  Snappy-compressed. A median of three samples would be a coin flip between the two, which is
  why the report gives the min and max across every sample instead. The working copy stores
  each document twice, as its record and as its shared base content, so the uncompressed
  logical content is about 2.1 times the body bytes. On-disk footprint is not measured.
- Browser-local and request-driven queries are different amounts of work. A browser-local query
  lists every document of the working copy from one transaction (leading frontmatter, journal
  and shared base, never a body) and filters in the page; request-driven pushes the filter to
  the router and parses thin frontmatter rows for the matches only.
- Simulated latency is a fixed delay at the fixture. It proves how each mode's behaviour and
  request overhead scale with round-trip cost. It says nothing about the latency of any deployed
  server, and a smaller number under simulated latency is not a claim about a deployed one.
- Power-loss durability is a separate storage guarantee. These numbers come from a process that
  was never interrupted; nothing here is evidence that IndexedDB survives a power loss, and the
  process-restart tests elsewhere in this package are not evidence of that either.
- The request-driven baseline is the reference router over an in-process memory backend on
  127.0.0.1. Its absolute times are a floor for a hosted authority, not an estimate of one.
