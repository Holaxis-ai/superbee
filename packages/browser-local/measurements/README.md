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
default; the cell summary is the median across repetitions of each repetition's own summary,
and every raw sample stays in the JSON.

| Metric | Browser-local | Request-driven |
| --- | --- | --- |
| Cold open | `bootstrap`: root index, list, `readMany` batches of 25, one journaled IndexedDB write per document, from an empty working copy. | Wire capabilities, the list, and the first 20 documents read one by one. |
| Warm read | 50 reads of seeded-random ids through the runtime's `read`, from IndexedDB. Median and p95. | The same 50 reads, each one request to the authority. |
| Warm query | 10 queries by type and 10 by tag through `query`: an IndexedDB head scan plus one snapshot read per matching document. | The same 20 queries, each paging the authority's filtered list 50 rows at a time. |
| Local commit | 20 commits through `commit` with no premise: the document write and its intent in one IndexedDB transaction. | The same 20 commits: a read then a PUT at the authority. |
| Reconciliation | Push of the 20 pending intents under the push role, then pull of every head. Wall time and request count. | Not applicable: nothing is pending. |
| Footprint | `navigator.storage.estimate()` before mount and after bootstrap in the same fresh context, and Chromium's `usageDetails.indexedDB` when reported. | Not applicable: no working copy. |
| Responsiveness | With the proof presentation mounted: select a document, click Commit, and time until the selected document's badge is re-rendered. Long tasks (`PerformanceObserver` `longtask`) are counted during the cold open and during the warm reads. | The same, over the request-driven runtime. |

The two cold opens are different operations by construction and the report names them beside
each number. Bootstrap hydrates the whole bundle once so every later read is local; the
request-driven first screen fetches only what one screen shows and pays the authority again for
every later verb. Each is the honest first-screen cost of its mode.

Request counts are observed at the served fixture's HTTP bridge. CORS preflights (OPTIONS) are
counted separately: the fixture disables preflight caching, so every non-simple request
preflights, and the bridge answers preflights without the simulated latency.

## How to run

```sh
npm run build
npm run measure:browser -w @superbee/browser-local
node packages/browser-local/scripts/measurement-table.mjs packages/browser-local/measurements/latest.json
```

Environment knobs: `SUPERBEE_MEASURE_OUT` (report path), `SUPERBEE_MEASURE_SIZES`,
`SUPERBEE_MEASURE_LATENCIES` (comma-separated lists), and `SUPERBEE_MEASURE_REPETITIONS` (one
value, or one per size). The plan actually run is recorded in the report.

`test:browser` runs only `measure-smoke.browser.spec.ts`: one repetition of the smallest cell in
each mode, asserting that every metric is present and finite. The full plan never runs in CI.

## What the numbers do and do not say

- The report records the git SHA, Node, Chromium and Playwright versions, OS, CPU model, core
  count and memory, a timestamp, and `conditions: "developer laptop, not isolated"`. Nothing in
  the run controls or observes other load on the machine; compare cells within one report before
  comparing across reports.
- Simulated latency is a fixed delay at the fixture. It proves how each mode's behaviour and
  request overhead scale with round-trip cost. It says nothing about the latency of any deployed
  server, and a smaller number under simulated latency is not a claim about a deployed one.
- Power-loss durability is a separate storage guarantee. These numbers come from a process that
  was never interrupted; nothing here is evidence that IndexedDB survives a power loss, and the
  process-restart tests elsewhere in this package are not evidence of that either.
- The request-driven baseline is the reference router over an in-process memory backend on
  127.0.0.1. Its absolute times are a floor for a hosted authority, not an estimate of one.
