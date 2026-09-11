/**
 * The Node side of the measurement harness: a plan (sizes, simulated latencies, repetitions,
 * modes), one cell per combination run in a fresh Chromium context over a freshly seeded served
 * authority, the page-measured wall times from `measure-driver.ts`, request counts observed at
 * the served fixture's bridge, per-repetition summaries (median and p95 over the raw samples)
 * and per-cell summaries (the median across repetitions of each repetition's summary; the
 * footprint is the min and max across every sample instead), and the hardware, build, and
 * conditions the report was produced under. The raw samples stay in the report beside the
 * summaries.
 *
 * The two modes' cold opens are different operations by construction: browser-local hydrates
 * the whole bundle into IndexedDB once (`bootstrap`, from one streamed snapshot), request-driven reads the authority's
 * capabilities, lists the bundle, and reads the first screen's documents. Each is the honest
 * first-screen cost of its mode, because it is what that mode must do before its presentation
 * can show a list and one document from its own source of truth. The report records both and
 * names the operation beside each number rather than presenting them as one metric.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem, arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "@playwright/test";

import type { QueryFilter } from "@superbee/core";
import type { ExecutionMode } from "@superbee/core/platform";

import { startDriverServer, type DriverServer } from "./harness.ts";
import type { ClickReply, MeasureDriver, MeasureError, MountReply, OpenReply, PageReply, QueriesReply, ReconcileReply, SamplesReply, StorageReply } from "./measure-driver.ts";
import { createRemoteFixture } from "./remote-fixture.ts";
import { serveRemoteFixture, type ServedFixture } from "./remote-http.ts";
import {
  bodyBytes,
  generateSyntheticBundle,
  seedGeneratedBundle,
  seededRandom,
  SYNTHETIC_KINDS,
  SYNTHETIC_SIZES,
  SYNTHETIC_TAGS,
  syntheticDocumentRefs,
} from "./synthetic-bundle.ts";

export const MEASURE_SCHEMA = "superbee.browser-local-measurement.v1";
export const CONDITIONS = "developer laptop, other load not controlled";
export const DEFAULT_OUT = "packages/browser-local/measurements/latest.json";
export const LATENCIES: readonly number[] = [0, 50, 200];
export const MODES: readonly ExecutionMode[] = ["request-driven", "browser-local"];

const READS = 50;
const QUERIES_PER_KIND = 10;
const COMMITS = 20;
const PICK_SEED = 7;

export interface MeasurePlan {
  sizes: number[];
  latencies: number[];
  /** Repetitions per size, aligned with `sizes`. */
  repetitions: number[];
  modes: ExecutionMode[];
}

export const DEFAULT_PLAN: MeasurePlan = {
  sizes: [...SYNTHETIC_SIZES],
  latencies: [...LATENCIES],
  repetitions: SYNTHETIC_SIZES.map(() => 3),
  modes: [...MODES],
};

/** The plan from the environment: `SUPERBEE_MEASURE_SIZES`, `_LATENCIES`, `_REPETITIONS` (one value or one per size). */
export function planFromEnv(env: NodeJS.ProcessEnv = process.env): MeasurePlan {
  const list = (value: string | undefined, fallback: number[]): number[] => {
    if (!value) return fallback;
    const parsed = value.split(",").map((item) => Number(item.trim()));
    if (parsed.some((item) => !Number.isInteger(item) || item < 0)) throw new Error(`measure: not a list of integers: ${value}`);
    return parsed;
  };
  const sizes = list(env.SUPERBEE_MEASURE_SIZES, DEFAULT_PLAN.sizes);
  const latencies = list(env.SUPERBEE_MEASURE_LATENCIES, DEFAULT_PLAN.latencies);
  const reps = list(env.SUPERBEE_MEASURE_REPETITIONS, [3]);
  const repetitions = reps.length === 1 ? sizes.map(() => reps[0]!) : reps;
  if (repetitions.length !== sizes.length) throw new Error("measure: SUPERBEE_MEASURE_REPETITIONS must have one value or one per size");
  return { sizes, latencies, repetitions, modes: [...MODES] };
}

// ── statistics ─────────────────────────────────────────────────────────────────────────────

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Nearest-rank p95 over the samples. */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

// ── the report ─────────────────────────────────────────────────────────────────────────────

export interface Traffic {
  /** Requests the bridge saw other than CORS preflights. */
  requests: number;
  /** CORS preflights (OPTIONS), answered by the bridge without the simulated latency. */
  preflights: number;
}

/** Where in the repetition a `navigator.storage.estimate()` sample was taken. */
export type FootprintSamplePoint = "afterBootstrap" | "afterMount" | "end";

export interface FootprintSample {
  at: FootprintSamplePoint;
  /** `estimate().usage` minus the fresh context's usage before the cold open; `null` when the browser reports no estimate. */
  deltaBytes: number | null;
  /** Chromium's `usageDetails.indexedDB` at this point, when reported. */
  indexedDbBytes: number | null;
}

export interface RepetitionRecord {
  repetition: number;
  page: PageReply;
  coldOpen: {
    operation: string;
    ms: number;
    documents: number;
    longTasks: number | null;
    firstScreenAfterBootstrapMs: number | null;
  } & Traffic;
  /** Mounting the proof presentation and its first refresh (one query plus the selection's read), with its own traffic. */
  presentationMount: { ms: number } & Traffic;
  warmRead: { samplesMs: number[]; medianMs: number; p95Ms: number; longTasks: number | null } & Traffic;
  warmQuery: {
    byType: { samplesMs: number[]; rows: number[]; medianMs: number; p95Ms: number };
    byTag: { samplesMs: number[]; rows: number[]; medianMs: number; p95Ms: number };
  } & Traffic;
  localCommit: { operation: string; samplesMs: number[]; medianMs: number; p95Ms: number } & Traffic;
  reconciliation: ({ applicable: true; ms: number; pushMs: number; pullMs: number; delivered: number; refreshed: number } & Traffic) | { applicable: false; reason: string };
  footprint:
    | {
        applicable: true;
        /** The fresh context's usage before the cold open, the base every sample's delta is taken from. */
        beforeBytes: number | null;
        /** Three samples: after the cold open, after the presentation mount, and at the end of the repetition. */
        samples: FootprintSample[];
        minDeltaBytes: number | null;
        maxDeltaBytes: number | null;
        minIndexedDbBytes: number | null;
        maxIndexedDbBytes: number | null;
        quotaBytes: number | null;
        bodyBytes: number;
      }
    | { applicable: false; reason: string; bodyBytes: number };
  responsiveness: { commitClickToBadgeMs: number; badge: string; longTasksDuringColdOpen: number | null; longTasksDuringReads: number | null };
}

/**
 * The per-cell summary: the median across repetitions of each repetition's own summary value,
 * except the footprint, which is the min and max across every sample of every repetition. A
 * storage estimate over an in-memory IndexedDB is bimodal (write-ahead log versus compacted
 * state), so a median of three would be a coin flip; the range is the honest statement.
 */
export interface CellSummary {
  coldOpenMs: number;
  coldOpenRequests: number;
  coldOpenPreflights: number;
  coldOpenLongTasks: number | null;
  presentationMountMs: number;
  presentationMountRequests: number;
  presentationMountPreflights: number;
  warmReadMedianMs: number;
  warmReadP95Ms: number;
  warmReadRequests: number;
  warmQueryByTypeMedianMs: number;
  warmQueryByTypeP95Ms: number;
  warmQueryByTagMedianMs: number;
  warmQueryByTagP95Ms: number;
  warmQueryRequests: number;
  localCommitMedianMs: number;
  localCommitP95Ms: number;
  localCommitRequests: number;
  reconciliationMs: number | null;
  reconciliationPushMs: number | null;
  reconciliationPullMs: number | null;
  reconciliationRequests: number | null;
  footprintMinBytes: number | null;
  footprintMaxBytes: number | null;
  footprintIndexedDbMinBytes: number | null;
  footprintIndexedDbMaxBytes: number | null;
  responsivenessCommitClickMs: number;
  longTasksDuringColdOpen: number | null;
  longTasksDuringReads: number | null;
}

export interface CellRecord {
  size: number;
  latencyMs: number;
  mode: ExecutionMode;
  /** True when every repetition's page was cross-origin isolated, so `performance.now()` resolved to 5 us rather than 100 us. */
  crossOriginIsolated: boolean;
  repetitions: RepetitionRecord[];
  summary: CellSummary;
}

export interface Environment {
  gitSha: string;
  /** True when `git status --porcelain` was not empty: the tree measured was not exactly `gitSha`. */
  gitDirty: boolean;
  node: string;
  chromium: string;
  playwright: string;
  os: { platform: string; release: string; arch: string; cpuModel: string; cores: number; memoryBytes: number };
  conditions: string;
  timestamp: string;
}

export interface MeasurementReport {
  schema: string;
  environment: Environment;
  plan: MeasurePlan;
  operations: Record<string, string>;
  cells: CellRecord[];
}

export const OPERATIONS: Record<string, string> = {
  coldOpen:
    "browser-local: bootstrap (root index, wire capabilities, one streamed snapshot written in batches of 25 as it arrives, one journaled IndexedDB write per document) from an empty working copy; request-driven: wire capabilities, list pages of 50 rows, and the first 20 documents read one by one. Different operations: each is what its mode must do before showing a list and one document from its own source of truth. The presentation mount is timed and counted separately.",
  presentationMount: "mounting the proof presentation over the open runtime and its first refresh: one query for the list, the selection's read, and the status line. Its requests are recorded apart from the cold open's.",
  warmRead: `${READS} reads of ids drawn with a seeded generator, without replacement when the bundle has at least ${READS} documents, through the runtime's read verb; browser-local answers from IndexedDB, request-driven from the authority.`,
  warmQuery: `${QUERIES_PER_KIND} queries by type and ${QUERIES_PER_KIND} by tag through the runtime's query verb; browser-local scans IndexedDB heads and reads each matching snapshot, request-driven pages the authority's filtered list 50 rows at a time.`,
  localCommit: `${COMMITS} commits through the runtime's commit verb with no premise (read then write); browser-local journals an intent in the document's transaction, request-driven reads and PUTs at the authority.`,
  reconciliation: `browser-local: push of the ${COMMITS} pending intents under the push role, then pull by one conditional heads request (the ${COMMITS} acknowledged documents already match their heads, so a 200 is diffed and nothing is read); request-driven has nothing to reconcile.`,
  footprint:
    "navigator.storage.estimate() in the same fresh context before the cold open and at three points after it (after bootstrap, after the presentation mount, at the end of the repetition); each sample is the delta from the fresh context, and the cell reports the min and max across every sample. Playwright contexts keep IndexedDB in memory, so this is a logical size (each document is stored twice, as its record and its shared base content), not an on-disk footprint. indexedDbBytes is Chromium's usageDetails.indexedDB when reported. Request-driven holds no working copy.",
  clock: "every time is performance.now() in the page. The measurement driver's page is served with cross-origin-opener-policy: same-origin and cross-origin-embedder-policy: require-corp so it is cross-origin isolated and the clock resolves to 5 us; without isolation Chromium coarsens it to 100 us, which is where a fast IndexedDB read sits. Each cell records whether its pages were isolated.",
  responsiveness: "with the presentation mounted: select a document, click Commit, and time until the selected document's badge is re-rendered; long tasks are PerformanceObserver longtask entries during the cold open and during the warm reads.",
  requests: "requests are counted at the served fixture's bridge; preflights are CORS OPTIONS requests the bridge answers without the simulated latency (the fixture sets access-control-max-age: 0, so every non-simple request preflights).",
};

export function environment(browser: Browser): Environment {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let gitSha = "unknown";
  let gitDirty = false;
  try {
    gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
    gitDirty = execFileSync("git", ["status", "--porcelain"], { cwd: here, encoding: "utf8" }).trim().length > 0;
  } catch {
    gitSha = "unknown";
  }
  let playwright = "unknown";
  try {
    playwright = (createRequire(import.meta.url)("@playwright/test/package.json") as { version: string }).version;
  } catch {
    playwright = "unknown";
  }
  const cpu = cpus();
  return {
    gitSha,
    gitDirty,
    node: process.version,
    chromium: browser.version(),
    playwright,
    os: { platform: platform(), release: release(), arch: arch(), cpuModel: cpu[0]?.model ?? "unknown", cores: cpu.length, memoryBytes: totalmem() },
    conditions: CONDITIONS,
    timestamp: new Date().toISOString(),
  };
}

// ── picks ──────────────────────────────────────────────────────────────────────────────────

export interface Picks {
  readIds: string[];
  queries: { byType: QueryFilter[]; byTag: QueryFilter[] };
  commits: Array<{ id: string; body: string }>;
  clickId: string;
}

/**
 * The ids and filters every cell of one size exercises, drawn once with a fixed seed. Read ids
 * are drawn without replacement when the bundle has at least `READS` documents, so every warm
 * read is a distinct document; a smaller bundle draws with replacement.
 */
export function picksFor(size: number): Picks {
  const random = seededRandom(PICK_SEED + size);
  const refs = syntheticDocumentRefs(size);
  const draw = () => refs[Math.floor(random() * refs.length)]!.id;
  const readIds: string[] = [];
  if (refs.length >= READS) {
    const pool = refs.map((ref) => ref.id);
    for (let index = 0; index < READS; index += 1) readIds.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  } else {
    for (let index = 0; index < READS; index += 1) readIds.push(draw());
  }
  const byType: QueryFilter[] = [];
  for (let index = 0; index < QUERIES_PER_KIND; index += 1) byType.push({ type: SYNTHETIC_KINDS[index % SYNTHETIC_KINDS.length]!.type });
  const byTag: QueryFilter[] = [];
  for (let index = 0; index < QUERIES_PER_KIND; index += 1) byTag.push({ tags: [SYNTHETIC_TAGS[Math.floor(random() * SYNTHETIC_TAGS.length)]!] });
  const commitIds = new Set<string>();
  while (commitIds.size < COMMITS) commitIds.add(draw());
  const commits = [...commitIds].map((id, index) => ({ id, body: `measured edit ${index + 1} of ${COMMITS}\n` }));
  let clickId = draw();
  while (commitIds.has(clickId)) clickId = draw();
  return { readIds, queries: { byType, byTag }, commits, clickId };
}

// ── page calls ─────────────────────────────────────────────────────────────────────────────

type MeasureMethod = keyof MeasureDriver;
type MeasureReply<M extends MeasureMethod> = Awaited<ReturnType<MeasureDriver[M]>>;

function measureCall<M extends MeasureMethod>(page: Page, method: M, ...args: Parameters<MeasureDriver[M]>): Promise<MeasureReply<M>> {
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

/** Requests the bridge saw since the last take, split into preflights and the rest. */
function trafficCounter(served: ServedFixture): () => Traffic {
  let offset = 0;
  return () => {
    const slice = served.requests.slice(offset);
    offset = served.requests.length;
    let preflights = 0;
    for (const row of slice) if (row.method === "OPTIONS") preflights += 1;
    return { requests: slice.length - preflights, preflights };
  };
}

async function waitForMeasureDriver(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.superbeeMeasure === "object");
}

// ── one cell, one repetition ───────────────────────────────────────────────────────────────

export interface CellContext {
  browser: Browser;
  driver: DriverServer;
  size: number;
  latencyMs: number;
  mode: ExecutionMode;
  repetition: number;
  log?: (line: string) => void;
}

export async function runRepetition(context: CellContext): Promise<RepetitionRecord> {
  const { browser, driver, size, latencyMs, mode, repetition } = context;
  const docs = generateSyntheticBundle(size);
  const picks = picksFor(size);
  const fixture = await createRemoteFixture();
  await seedGeneratedBundle(fixture.authority, docs);
  fixture.knobs.latencyMs = latencyMs;
  const served = await serveRemoteFixture(fixture);
  const browserContext = await browser.newContext();
  try {
    const page = await browserContext.newPage();
    await page.goto(`${driver.origin}/`, { waitUntil: "networkidle" });
    await waitForMeasureDriver(page);
    const take = trafficCounter(served);
    const name = `measure-${size}-${latencyMs}-${mode}-${repetition}`;

    const pageInfo: PageReply = await measureCall(page, "page");
    const storageBefore: StorageReply = await measureCall(page, "storage");
    const opened: OpenReply = unwrap(await measureCall(page, "open", mode, served.origin, name), "open");
    const coldTraffic = take();
    const storageAfterBootstrap: StorageReply = await measureCall(page, "storage");
    const mounted: MountReply = unwrap(await measureCall(page, "mount"), "mount");
    const mountTraffic = take();
    const storageAfterMount: StorageReply = await measureCall(page, "storage");

    const reads: SamplesReply = unwrap(await measureCall(page, "reads", picks.readIds), "reads");
    const readTraffic = take();

    const byType: QueriesReply = unwrap(await measureCall(page, "queries", picks.queries.byType), "queries by type");
    const byTag: QueriesReply = unwrap(await measureCall(page, "queries", picks.queries.byTag), "queries by tag");
    const queryTraffic = take();

    const commits: SamplesReply = unwrap(await measureCall(page, "commits", picks.commits), "commits");
    const commitTraffic = take();

    let reconciliation: RepetitionRecord["reconciliation"];
    if (mode === "browser-local") {
      const reconciled: ReconcileReply = unwrap(await measureCall(page, "reconcile"), "reconcile");
      reconciliation = { applicable: true, ...reconciled, ...take() };
    } else {
      take();
      reconciliation = { applicable: false, reason: "request-driven commits land at the authority as they are made; there is nothing to reconcile" };
    }

    const click: ClickReply = unwrap(await measureCall(page, "commitClick", picks.clickId, "measured edit through the presentation\n"), "commitClick");
    const storageAtEnd: StorageReply = await measureCall(page, "storage");
    unwrap(await measureCall(page, "unmount"), "unmount");

    const bytes = bodyBytes(docs);
    const sample = (at: FootprintSamplePoint, reply: StorageReply): FootprintSample => ({
      at,
      deltaBytes: storageBefore.usage !== null && reply.usage !== null ? reply.usage - storageBefore.usage : null,
      indexedDbBytes: reply.usageDetails?.indexedDB ?? null,
    });
    const samples = [sample("afterBootstrap", storageAfterBootstrap), sample("afterMount", storageAfterMount), sample("end", storageAtEnd)];
    const footprint: RepetitionRecord["footprint"] =
      mode === "browser-local"
        ? {
            applicable: true,
            beforeBytes: storageBefore.usage,
            samples,
            minDeltaBytes: extremum(samples, (row) => row.deltaBytes, Math.min),
            maxDeltaBytes: extremum(samples, (row) => row.deltaBytes, Math.max),
            minIndexedDbBytes: extremum(samples, (row) => row.indexedDbBytes, Math.min),
            maxIndexedDbBytes: extremum(samples, (row) => row.indexedDbBytes, Math.max),
            quotaBytes: storageAtEnd.quota,
            bodyBytes: bytes,
          }
        : { applicable: false, reason: "request-driven holds no working copy; its in-memory state is the current page's objects only", bodyBytes: bytes };

    const record: RepetitionRecord = {
      repetition,
      page: pageInfo,
      coldOpen: {
        operation: mode === "browser-local" ? "bootstrap" : "capabilities + list + first 20 reads",
        ms: opened.coldOpenMs,
        documents: opened.documents,
        longTasks: opened.longTasksDuringColdOpen,
        firstScreenAfterBootstrapMs: opened.firstScreenAfterBootstrapMs,
        ...coldTraffic,
      },
      presentationMount: { ms: mounted.presentationMountMs, ...mountTraffic },
      warmRead: { samplesMs: reads.samplesMs, medianMs: median(reads.samplesMs), p95Ms: p95(reads.samplesMs), longTasks: reads.longTasks, ...readTraffic },
      warmQuery: {
        byType: { samplesMs: byType.samplesMs, rows: byType.rows, medianMs: median(byType.samplesMs), p95Ms: p95(byType.samplesMs) },
        byTag: { samplesMs: byTag.samplesMs, rows: byTag.rows, medianMs: median(byTag.samplesMs), p95Ms: p95(byTag.samplesMs) },
        ...queryTraffic,
      },
      localCommit: {
        operation: mode === "browser-local" ? "commitLocal (document write plus journaled intent, one transaction)" : "read then PUT at the authority",
        samplesMs: commits.samplesMs,
        medianMs: median(commits.samplesMs),
        p95Ms: p95(commits.samplesMs),
        ...commitTraffic,
      },
      reconciliation,
      footprint,
      responsiveness: { commitClickToBadgeMs: click.ms, badge: click.badge, longTasksDuringColdOpen: opened.longTasksDuringColdOpen, longTasksDuringReads: reads.longTasks },
    };
    context.log?.(
      `[measure] size=${size} latency=${latencyMs} mode=${mode} rep=${repetition}: cold ${record.coldOpen.ms.toFixed(0)} ms/${record.coldOpen.requests} req, mount ${record.presentationMount.ms.toFixed(0)} ms/${record.presentationMount.requests} req, read ${record.warmRead.medianMs.toFixed(2)} ms, query ${record.warmQuery.byType.medianMs.toFixed(1)}/${record.warmQuery.byTag.medianMs.toFixed(1)} ms, commit ${record.localCommit.medianMs.toFixed(1)} ms, reconcile ${reconciliation.applicable ? `${reconciliation.ms.toFixed(0)} ms/${reconciliation.requests} req` : "n/a"}, click ${click.ms.toFixed(0)} ms`,
    );
    return record;
  } finally {
    await browserContext.close();
    await served.close();
  }
}

// ── summaries and the run ──────────────────────────────────────────────────────────────────

function medianOf<T>(rows: readonly T[], value: (row: T) => number | null): number | null {
  const values = rows.map(value).filter((item): item is number => item !== null && Number.isFinite(item));
  return values.length === 0 ? null : median(values);
}

/** `Math.min` or `Math.max` over the finite values, or `null` when there are none. */
function extremum<T>(rows: readonly T[], value: (row: T) => number | null, pick: (...values: number[]) => number): number | null {
  const values = rows.map(value).filter((item): item is number => item !== null && Number.isFinite(item));
  return values.length === 0 ? null : pick(...values);
}

function summarize(reps: readonly RepetitionRecord[]): CellSummary {
  const number = (value: number | null): number => (value === null ? Number.NaN : value);
  const reconciliations = reps.map((rep) => rep.reconciliation).filter((row): row is Extract<RepetitionRecord["reconciliation"], { applicable: true }> => row.applicable);
  const footprintSamples = reps.flatMap((rep) => (rep.footprint.applicable ? rep.footprint.samples : []));
  return {
    coldOpenMs: number(medianOf(reps, (rep) => rep.coldOpen.ms)),
    coldOpenRequests: number(medianOf(reps, (rep) => rep.coldOpen.requests)),
    coldOpenPreflights: number(medianOf(reps, (rep) => rep.coldOpen.preflights)),
    coldOpenLongTasks: medianOf(reps, (rep) => rep.coldOpen.longTasks),
    presentationMountMs: number(medianOf(reps, (rep) => rep.presentationMount.ms)),
    presentationMountRequests: number(medianOf(reps, (rep) => rep.presentationMount.requests)),
    presentationMountPreflights: number(medianOf(reps, (rep) => rep.presentationMount.preflights)),
    warmReadMedianMs: number(medianOf(reps, (rep) => rep.warmRead.medianMs)),
    warmReadP95Ms: number(medianOf(reps, (rep) => rep.warmRead.p95Ms)),
    warmReadRequests: number(medianOf(reps, (rep) => rep.warmRead.requests)),
    warmQueryByTypeMedianMs: number(medianOf(reps, (rep) => rep.warmQuery.byType.medianMs)),
    warmQueryByTypeP95Ms: number(medianOf(reps, (rep) => rep.warmQuery.byType.p95Ms)),
    warmQueryByTagMedianMs: number(medianOf(reps, (rep) => rep.warmQuery.byTag.medianMs)),
    warmQueryByTagP95Ms: number(medianOf(reps, (rep) => rep.warmQuery.byTag.p95Ms)),
    warmQueryRequests: number(medianOf(reps, (rep) => rep.warmQuery.requests)),
    localCommitMedianMs: number(medianOf(reps, (rep) => rep.localCommit.medianMs)),
    localCommitP95Ms: number(medianOf(reps, (rep) => rep.localCommit.p95Ms)),
    localCommitRequests: number(medianOf(reps, (rep) => rep.localCommit.requests)),
    reconciliationMs: medianOf(reconciliations, (row) => row.ms),
    reconciliationPushMs: medianOf(reconciliations, (row) => row.pushMs),
    reconciliationPullMs: medianOf(reconciliations, (row) => row.pullMs),
    reconciliationRequests: medianOf(reconciliations, (row) => row.requests),
    footprintMinBytes: extremum(footprintSamples, (row) => row.deltaBytes, Math.min),
    footprintMaxBytes: extremum(footprintSamples, (row) => row.deltaBytes, Math.max),
    footprintIndexedDbMinBytes: extremum(footprintSamples, (row) => row.indexedDbBytes, Math.min),
    footprintIndexedDbMaxBytes: extremum(footprintSamples, (row) => row.indexedDbBytes, Math.max),
    responsivenessCommitClickMs: number(medianOf(reps, (rep) => rep.responsiveness.commitClickToBadgeMs)),
    longTasksDuringColdOpen: medianOf(reps, (rep) => rep.responsiveness.longTasksDuringColdOpen),
    longTasksDuringReads: medianOf(reps, (rep) => rep.responsiveness.longTasksDuringReads),
  };
}

/** Summary keys that must be finite in every cell of every mode. */
export const ALWAYS_FINITE_KEYS: readonly (keyof CellSummary)[] = [
  "coldOpenMs",
  "coldOpenRequests",
  "coldOpenPreflights",
  "presentationMountMs",
  "presentationMountRequests",
  "presentationMountPreflights",
  "warmReadMedianMs",
  "warmReadP95Ms",
  "warmReadRequests",
  "warmQueryByTypeMedianMs",
  "warmQueryByTypeP95Ms",
  "warmQueryByTagMedianMs",
  "warmQueryByTagP95Ms",
  "warmQueryRequests",
  "localCommitMedianMs",
  "localCommitP95Ms",
  "localCommitRequests",
  "responsivenessCommitClickMs",
];

/** Summary keys that must be finite in browser-local cells and null in request-driven cells. */
export const BROWSER_LOCAL_ONLY_KEYS: readonly (keyof CellSummary)[] = [
  "reconciliationMs",
  "reconciliationPushMs",
  "reconciliationPullMs",
  "reconciliationRequests",
  "footprintMinBytes",
  "footprintMaxBytes",
];

/** Summary keys that are finite where Chromium reports the observation and null otherwise. */
export const OPTIONAL_KEYS: readonly (keyof CellSummary)[] = ["coldOpenLongTasks", "longTasksDuringColdOpen", "longTasksDuringReads", "footprintIndexedDbMinBytes", "footprintIndexedDbMaxBytes"];

/**
 * The measurement driver's page asks for cross-origin isolation so `performance.now()` resolves
 * to 5 us. Only this driver carries the policy; the proof driver and its specs are unchanged.
 */
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

export async function startMeasureDriver(): Promise<DriverServer> {
  return startDriverServer({ entry: new URL("./measure-driver.ts", import.meta.url), headers: { ...ISOLATION_HEADERS } });
}

export async function runMeasurement(browser: Browser, plan: MeasurePlan, options: { log?: (line: string) => void } = {}): Promise<MeasurementReport> {
  const driver = await startMeasureDriver();
  const cells: CellRecord[] = [];
  try {
    for (const [sizeIndex, size] of plan.sizes.entries()) {
      const repetitions = plan.repetitions[sizeIndex] ?? 1;
      for (const latencyMs of plan.latencies) {
        for (const mode of plan.modes) {
          const reps: RepetitionRecord[] = [];
          for (let repetition = 1; repetition <= repetitions; repetition += 1) {
            reps.push(await runRepetition({ browser, driver, size, latencyMs, mode, repetition, ...(options.log ? { log: options.log } : {}) }));
          }
          cells.push({ size, latencyMs, mode, crossOriginIsolated: reps.every((rep) => rep.page.crossOriginIsolated), repetitions: reps, summary: summarize(reps) });
        }
      }
    }
  } finally {
    await driver.close();
  }
  return { schema: MEASURE_SCHEMA, environment: environment(browser), plan, operations: OPERATIONS, cells };
}

/** JSON with NaN rendered as null, so the file stays parseable. */
export function writeReport(report: MeasurementReport, outPath: string): string {
  const resolved = path.resolve(outPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, (_key, value) => (typeof value === "number" && !Number.isFinite(value) ? null : value), 2)}\n`);
  return resolved;
}

/** The report path from `SUPERBEE_MEASURE_OUT`, or the default under the repository root. */
export function outPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SUPERBEE_MEASURE_OUT) return path.resolve(env.SUPERBEE_MEASURE_OUT);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..", DEFAULT_OUT);
}
