/**
 * The Node side of the listing measurement: the unfiltered listing (`query` with no filter),
 * one filtered query, and the status (whose unconfirmed count walks every document) through the
 * browser-local runtime over a working copy of one size whose bodies are drawn from one range,
 * in a fresh Chromium context per repetition. Each verb is timed in the page, its IndexedDB
 * transactions are counted at the page's factory, and the heap is sampled while it runs
 * (`measure-driver.ts`), so the report says what a listing at the working-copy bound costs in
 * time, transactions and memory. The default plan is the bound: 1,000 documents of 20 to 50 KB.
 * Runs under `npm run measure:listing`; the smoke row in `test:browser` runs the smallest cell
 * once.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser } from "@playwright/test";

import type { QueryFilter } from "@superbee/core";

import type { DriverServer } from "./harness.ts";
import { environment, median, p95, startMeasureDriver, type Environment } from "./measure.ts";
import type { CostOperation, CostReply, CostSample, MeasureDriver, MeasureError, OpenReply, PageReply } from "./measure-driver.ts";
import { createRemoteFixture } from "./remote-fixture.ts";
import { serveRemoteFixture } from "./remote-http.ts";
import { bodyBytes, generateSyntheticBundle, seedGeneratedBundle, SYNTHETIC_KINDS, type SyntheticBodyRange } from "./synthetic-bundle.ts";

export const LISTING_SCHEMA = "superbee.browser-local-listing-measurement.v1";
export const DEFAULT_LISTING_OUT = "packages/browser-local/measurements/listing.json";
/** The realistic document size the bound is measured at. */
export const LISTING_BODY_RANGE: SyntheticBodyRange = { minBytes: 20 * 1024, maxBytes: 50 * 1024 };
/** The filtered query beside the listing: one of the three kinds, a third of the documents. */
export const LISTING_TYPE_FILTER: QueryFilter = { type: SYNTHETIC_KINDS[0]!.type };

export interface ListingPlan {
  size: number;
  /** Body bytes per document, uniform within the range; omitted, the generator's mixed sizes. */
  bodyRange?: SyntheticBodyRange;
  /** Rounds of each verb per repetition. */
  rounds: number;
  repetitions: number;
}

export const DEFAULT_LISTING_PLAN: ListingPlan = { size: 1000, bodyRange: LISTING_BODY_RANGE, rounds: 5, repetitions: 3 };

/** The plan from the environment: `SUPERBEE_MEASURE_LISTING_SIZE`, `_BODY_MIN`, `_BODY_MAX`, `_ROUNDS`, `_REPETITIONS`. */
export function listingPlanFromEnv(env: NodeJS.ProcessEnv = process.env): ListingPlan {
  const integer = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`measure-listing: not a non-negative integer: ${value}`);
    return parsed;
  };
  return {
    size: integer(env.SUPERBEE_MEASURE_LISTING_SIZE, DEFAULT_LISTING_PLAN.size),
    bodyRange: {
      minBytes: integer(env.SUPERBEE_MEASURE_LISTING_BODY_MIN, LISTING_BODY_RANGE.minBytes),
      maxBytes: integer(env.SUPERBEE_MEASURE_LISTING_BODY_MAX, LISTING_BODY_RANGE.maxBytes),
    },
    rounds: integer(env.SUPERBEE_MEASURE_LISTING_ROUNDS, DEFAULT_LISTING_PLAN.rounds),
    repetitions: integer(env.SUPERBEE_MEASURE_LISTING_REPETITIONS, DEFAULT_LISTING_PLAN.repetitions),
  };
}

// ── the report ─────────────────────────────────────────────────────────────────────────────

export interface CostSummary {
  medianMs: number;
  p95Ms: number;
  /** The median transaction count over the rounds. */
  transactions: number | null;
  /** Rows returned (or the unconfirmed count), the same in every round. */
  rows: number;
  heapPeakMedianBytes: number | null;
  heapAfterMedianBytes: number | null;
}

export interface CostRecord {
  samples: CostSample[];
  summary: CostSummary;
}

/** One round of a verb under a collecting sampler: the heap it held at its peak, not its time. */
export interface HeldRecord {
  sample: CostSample;
  /** `heapPeakDeltaBytes` of the collecting sample, or `null` where the heap is not reported or `gc()` was not exposed. */
  heldPeakBytes: number | null;
}

export interface ListingRepetition {
  repetition: number;
  page: PageReply;
  coldOpen: { ms: number; documents: number };
  /** Total body bytes of the generated bundle. */
  bodyBytes: number;
  listing: CostRecord;
  byType: CostRecord & { filter: QueryFilter };
  status: CostRecord;
  /** The listing and the status once more, each under the collecting sampler. */
  held: { listing: HeldRecord; status: HeldRecord };
}

export interface ListingSummary {
  listing: CostSummary;
  byType: CostSummary;
  status: CostSummary;
  /** The median across repetitions of the heap each verb held at its peak. */
  held: { listingPeakBytes: number | null; statusPeakBytes: number | null };
}

export interface ListingReport {
  schema: string;
  environment: Environment;
  plan: ListingPlan;
  operations: Record<string, string>;
  repetitions: ListingRepetition[];
  /** The median across repetitions of each repetition's own summary. */
  summary: ListingSummary;
}

export const LISTING_OPERATIONS: Record<string, string> = {
  listing: "the runtime's query verb with no filter: every document's id, version, frontmatter and provenance from the working copy.",
  byType: "the runtime's query verb filtered by one type, a third of the documents.",
  status: "the runtime's syncStatus verb, whose unconfirmed count considers every document of the working copy.",
  transactions: "IndexedDB transactions opened by the verb, counted at the page's factory (the working copy is opened through a counting wrapper of the page's indexedDB).",
  heap: "performance.memory.usedJSHeapSize sampled every millisecond while the verb runs; heapPeakDeltaBytes is the highest sample minus a collected baseline taken before the verb, heapAfterDeltaBytes the collected reading after it minus the same baseline. Chromium is launched with --enable-precise-memory-info and gc() exposed; without them the readings are quantized and the baselines uncollected.",
  held: "the listing and the status once more under a sampler that collects on every tick, so the peak is the heap the verb held rather than the garbage not yet collected; the collections slow the verb, so these samples measure memory only.",
  clock: "every time is performance.now() in a cross-origin isolated page (5 us resolution), as in the main measurement.",
  coldOpen: "bootstrap of the whole bundle from one streamed snapshot, then the first screen (one listing and 20 reads), before any round; recorded for context only.",
};

function medianOrNull(values: readonly (number | null)[]): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finite.length === 0 ? null : median(finite);
}

export function summarizeCost(samples: readonly CostSample[]): CostSummary {
  const times = samples.map((sample) => sample.ms);
  return {
    medianMs: median(times),
    p95Ms: p95(times),
    transactions: medianOrNull(samples.map((sample) => sample.transactions)),
    rows: samples[0]?.rows ?? Number.NaN,
    heapPeakMedianBytes: medianOrNull(samples.map((sample) => sample.heapPeakDeltaBytes)),
    heapAfterMedianBytes: medianOrNull(samples.map((sample) => sample.heapAfterDeltaBytes)),
  };
}

function medianSummary(summaries: readonly CostSummary[]): CostSummary {
  return {
    medianMs: median(summaries.map((row) => row.medianMs)),
    p95Ms: median(summaries.map((row) => row.p95Ms)),
    transactions: medianOrNull(summaries.map((row) => row.transactions)),
    rows: summaries[0]?.rows ?? Number.NaN,
    heapPeakMedianBytes: medianOrNull(summaries.map((row) => row.heapPeakMedianBytes)),
    heapAfterMedianBytes: medianOrNull(summaries.map((row) => row.heapAfterMedianBytes)),
  };
}

// ── page calls ─────────────────────────────────────────────────────────────────────────────

type MeasureMethod = keyof MeasureDriver;
type MeasureReply<M extends MeasureMethod> = Awaited<ReturnType<MeasureDriver[M]>>;

function measureCall<M extends MeasureMethod>(page: import("@playwright/test").Page, method: M, ...args: Parameters<MeasureDriver[M]>): Promise<MeasureReply<M>> {
  return page.evaluate(
    ([name, params]) => (window.superbeeMeasure[name as MeasureMethod] as (...inner: unknown[]) => unknown)(...(params as unknown[])),
    [method, args] as const,
  ) as Promise<MeasureReply<M>>;
}

function unwrap<T>(reply: T | MeasureError, label: string): T {
  if (reply && typeof reply === "object" && "error" in reply) {
    const { error } = reply as MeasureError;
    throw new Error(`${label}: ${error.name}: ${error.message}`);
  }
  return reply as T;
}

// ── one repetition and the run ─────────────────────────────────────────────────────────────

export async function runListingRepetition(browser: Browser, driver: DriverServer, plan: ListingPlan, repetition: number, log?: (line: string) => void): Promise<ListingRepetition> {
  const docs = generateSyntheticBundle(plan.size, 1, plan.bodyRange);
  const fixture = await createRemoteFixture();
  await seedGeneratedBundle(fixture.authority, docs);
  const served = await serveRemoteFixture(fixture);
  const browserContext = await browser.newContext();
  try {
    const page = await browserContext.newPage();
    await page.goto(`${driver.origin}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof window.superbeeMeasure === "object");
    const pageInfo: PageReply = await measureCall(page, "page");
    const opened: OpenReply = unwrap(await measureCall(page, "open", "browser-local", served.origin, `measure-listing-${plan.size}-${repetition}`), "open");
    const cost = async (operation: CostOperation, filter?: QueryFilter): Promise<CostRecord> => {
      const reply: CostReply = unwrap(await measureCall(page, "cost", operation, plan.rounds, filter === undefined ? {} : { filter }), operation);
      return { samples: reply.samples, summary: summarizeCost(reply.samples) };
    };
    const held = async (operation: CostOperation): Promise<HeldRecord> => {
      const reply: CostReply = unwrap(await measureCall(page, "cost", operation, 1, { collectWhileSampling: true }), `${operation} held`);
      const sample = reply.samples[0]!;
      return { sample, heldPeakBytes: sample.collectedWhileSampling ? sample.heapPeakDeltaBytes : null };
    };
    const listing = await cost("listing");
    const byType = { filter: LISTING_TYPE_FILTER, ...(await cost("byType", LISTING_TYPE_FILTER)) };
    const status = await cost("status");
    const heldListing = await held("listing");
    const heldStatus = await held("status");
    unwrap(await measureCall(page, "unmount"), "unmount");
    const record: ListingRepetition = {
      repetition,
      page: pageInfo,
      coldOpen: { ms: opened.coldOpenMs, documents: opened.documents },
      bodyBytes: bodyBytes(docs),
      listing,
      byType,
      status,
      held: { listing: heldListing, status: heldStatus },
    };
    const mib = (bytes: number | null): string => (bytes === null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`);
    const describe = (row: CostRecord): string => `${row.summary.medianMs.toFixed(1)} ms, ${row.summary.transactions ?? "n/a"} tx, peak ${mib(row.summary.heapPeakMedianBytes)}`;
    log?.(`[measure-listing] size=${plan.size} rep=${repetition}: cold ${opened.coldOpenMs.toFixed(0)} ms/${opened.documents} docs, listing ${describe(listing)} (${listing.summary.rows} rows), byType ${describe(byType)} (${byType.summary.rows} rows), status ${describe(status)} (${status.summary.rows} unconfirmed), held listing ${mib(heldListing.heldPeakBytes)} status ${mib(heldStatus.heldPeakBytes)}`);
    return record;
  } finally {
    await browserContext.close();
    await served.close();
  }
}

export async function runListingMeasurement(browser: Browser, plan: ListingPlan, options: { log?: (line: string) => void } = {}): Promise<ListingReport> {
  const driver = await startMeasureDriver();
  const repetitions: ListingRepetition[] = [];
  try {
    for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
      repetitions.push(await runListingRepetition(browser, driver, plan, repetition, options.log));
    }
  } finally {
    await driver.close();
  }
  return {
    schema: LISTING_SCHEMA,
    environment: environment(browser),
    plan,
    operations: LISTING_OPERATIONS,
    repetitions,
    summary: {
      listing: medianSummary(repetitions.map((rep) => rep.listing.summary)),
      byType: medianSummary(repetitions.map((rep) => rep.byType.summary)),
      status: medianSummary(repetitions.map((rep) => rep.status.summary)),
      held: {
        listingPeakBytes: medianOrNull(repetitions.map((rep) => rep.held.listing.heldPeakBytes)),
        statusPeakBytes: medianOrNull(repetitions.map((rep) => rep.held.status.heldPeakBytes)),
      },
    },
  };
}

/** The report path from `SUPERBEE_MEASURE_LISTING_OUT`, or the default under the repository root. */
export function listingOutPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SUPERBEE_MEASURE_LISTING_OUT) return path.resolve(env.SUPERBEE_MEASURE_LISTING_OUT);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..", DEFAULT_LISTING_OUT);
}
