#!/usr/bin/env node
/**
 * Render a measurement report (see ../measurements/README.md) as Markdown: the conditions block,
 * then one row per cell with the cell summary's medians (and the footprint's min and max). The
 * report arrives on standard input,
 * so the script opens no path of its own. Usage:
 *   node packages/browser-local/scripts/measurement-table.mjs < packages/browser-local/measurements/latest.json
 */

import { readFileSync } from "node:fs";

let report;
try {
  report = JSON.parse(readFileSync(0, "utf8"));
} catch (error) {
  console.error(`usage: measurement-table.mjs < report.json (${error instanceof Error ? error.message : String(error)})`);
  process.exit(2);
}
const { environment: env, plan } = report;

const ms = (value) => (value === null || value === undefined || Number.isNaN(value) ? "n/a" : value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2));
const count = (value) => (value === null || value === undefined || Number.isNaN(value) ? "n/a" : String(Math.round(value)));
const kib = (value) => (value === null || value === undefined || Number.isNaN(value) ? "n/a" : `${(value / 1024).toFixed(0)} KiB`);
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(0)} GiB`;

const lines = [];
lines.push("# Browser-local measurements");
lines.push("");
lines.push("Conditions:");
lines.push("");
lines.push(`- conditions: ${env.conditions}`);
lines.push(`- timestamp: ${env.timestamp}`);
lines.push(`- git SHA: ${env.gitSha}${env.gitDirty ? "-dirty" : ""}`);
lines.push(`- Node ${env.node}, Chromium ${env.chromium}, Playwright ${env.playwright}`);
lines.push(`- ${env.os.platform} ${env.os.release} ${env.os.arch}, ${env.os.cpuModel}, ${env.os.cores} cores, ${gib(env.os.memoryBytes)}`);
lines.push(`- plan: sizes ${plan.sizes.join(", ")}; latencies ${plan.latencies.join(", ")} ms; repetitions per size ${plan.repetitions.join(", ")}; modes ${plan.modes.join(", ")}`);
const isolated = report.cells.length > 0 && report.cells.every((cell) => cell.crossOriginIsolated === true);
lines.push(`- clock: performance.now() in a ${isolated ? "cross-origin isolated page (5 us resolution)" : "page that is not cross-origin isolated (100 us floor; reads under 0.2 ms are a bound at the clock floor)"}`);
lines.push("- every time is the median across repetitions of the repetition's own median (or wall time); request counts exclude CORS preflights, which are listed separately");
lines.push("- footprint is the min and max across three navigator.storage.estimate() samples per repetition (after bootstrap, after mount, at the end) over an in-memory IndexedDB: a logical size, not an on-disk one");
lines.push("");
lines.push("## Cold open, warm read, warm query, local commit");
lines.push("");
lines.push("| size | latency ms | mode | cold open ms | cold op | cold req | preflights | mount ms | mount req | read med ms | read p95 ms | read req | query type med ms | query type p95 ms | query tag med ms | query tag p95 ms | query req | commit med ms | commit p95 ms | commit req |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const cell of report.cells) {
  const s = cell.summary;
  const op = cell.repetitions[0]?.coldOpen.operation ?? "";
  lines.push(
    `| ${cell.size} | ${cell.latencyMs} | ${cell.mode} | ${ms(s.coldOpenMs)} | ${op} | ${count(s.coldOpenRequests)} | ${count(s.coldOpenPreflights)} | ${ms(s.presentationMountMs)} | ${count(s.presentationMountRequests)} | ${ms(s.warmReadMedianMs)} | ${ms(s.warmReadP95Ms)} | ${count(s.warmReadRequests)} | ${ms(s.warmQueryByTypeMedianMs)} | ${ms(s.warmQueryByTypeP95Ms)} | ${ms(s.warmQueryByTagMedianMs)} | ${ms(s.warmQueryByTagP95Ms)} | ${count(s.warmQueryRequests)} | ${ms(s.localCommitMedianMs)} | ${ms(s.localCommitP95Ms)} | ${count(s.localCommitRequests)} |`,
  );
}
lines.push("");
lines.push("## Reconciliation, footprint, responsiveness");
lines.push("");
lines.push("| size | latency ms | mode | reconcile ms | push ms | pull ms | reconcile req | footprint min | footprint max | indexedDB min | indexedDB max | body bytes | commit click to badge ms | long tasks cold open | long tasks reads |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const cell of report.cells) {
  const s = cell.summary;
  const body = cell.repetitions[0]?.footprint.bodyBytes ?? null;
  lines.push(
    `| ${cell.size} | ${cell.latencyMs} | ${cell.mode} | ${ms(s.reconciliationMs)} | ${ms(s.reconciliationPushMs)} | ${ms(s.reconciliationPullMs)} | ${count(s.reconciliationRequests)} | ${kib(s.footprintMinBytes)} | ${kib(s.footprintMaxBytes)} | ${kib(s.footprintIndexedDbMinBytes)} | ${kib(s.footprintIndexedDbMaxBytes)} | ${kib(body)} | ${ms(s.responsivenessCommitClickMs)} | ${count(s.longTasksDuringColdOpen)} | ${count(s.longTasksDuringReads)} |`,
  );
}
lines.push("");
lines.push("Cold open operations differ by mode: browser-local is a full bootstrap into IndexedDB, request-driven is capabilities plus list pages plus the first 20 reads; the presentation mount's query and read are counted in the mount columns, not the cold open. See ../measurements/README.md.");
process.stdout.write(`${lines.join("\n")}\n`);
