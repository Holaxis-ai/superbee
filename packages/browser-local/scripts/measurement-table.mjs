#!/usr/bin/env node
/**
 * Render a measurement report (see ../measurements/README.md) as Markdown: the conditions block,
 * then one row per cell with the cell summary's medians. Usage:
 *   node packages/browser-local/scripts/measurement-table.mjs <report.json>
 */

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: measurement-table.mjs <report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, "utf8"));
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
lines.push(`- git SHA: ${env.gitSha}`);
lines.push(`- Node ${env.node}, Chromium ${env.chromium}, Playwright ${env.playwright}`);
lines.push(`- ${env.os.platform} ${env.os.release} ${env.os.arch}, ${env.os.cpuModel}, ${env.os.cores} cores, ${gib(env.os.memoryBytes)}`);
lines.push(`- plan: sizes ${plan.sizes.join(", ")}; latencies ${plan.latencies.join(", ")} ms; repetitions per size ${plan.repetitions.join(", ")}; modes ${plan.modes.join(", ")}`);
lines.push("- every time is the median across repetitions of the repetition's own median (or wall time); request counts exclude CORS preflights, which are listed separately");
lines.push("");
lines.push("## Cold open, warm read, warm query, local commit");
lines.push("");
lines.push("| size | latency ms | mode | cold open ms | cold op | cold req | preflights | read med ms | read p95 ms | read req | query type med ms | query type p95 ms | query tag med ms | query tag p95 ms | query req | commit med ms | commit p95 ms | commit req |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const cell of report.cells) {
  const s = cell.summary;
  const op = cell.repetitions[0]?.coldOpen.operation ?? "";
  lines.push(
    `| ${cell.size} | ${cell.latencyMs} | ${cell.mode} | ${ms(s.coldOpenMs)} | ${op} | ${count(s.coldOpenRequests)} | ${count(s.coldOpenPreflights)} | ${ms(s.warmReadMedianMs)} | ${ms(s.warmReadP95Ms)} | ${count(s.warmReadRequests)} | ${ms(s.warmQueryByTypeMedianMs)} | ${ms(s.warmQueryByTypeP95Ms)} | ${ms(s.warmQueryByTagMedianMs)} | ${ms(s.warmQueryByTagP95Ms)} | ${count(s.warmQueryRequests)} | ${ms(s.localCommitMedianMs)} | ${ms(s.localCommitP95Ms)} | ${count(s.localCommitRequests)} |`,
  );
}
lines.push("");
lines.push("## Reconciliation, footprint, responsiveness");
lines.push("");
lines.push("| size | latency ms | mode | reconcile ms | push ms | pull ms | reconcile req | footprint delta | indexedDB bytes | body bytes | presentation mount ms | commit click to badge ms | long tasks cold open | long tasks reads |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const cell of report.cells) {
  const s = cell.summary;
  const body = cell.repetitions[0]?.footprint.bodyBytes ?? null;
  lines.push(
    `| ${cell.size} | ${cell.latencyMs} | ${cell.mode} | ${ms(s.reconciliationMs)} | ${ms(s.reconciliationPushMs)} | ${ms(s.reconciliationPullMs)} | ${count(s.reconciliationRequests)} | ${kib(s.footprintDeltaBytes)} | ${kib(s.footprintIndexedDbBytes)} | ${kib(body)} | ${ms(s.presentationMountMs)} | ${ms(s.responsivenessCommitClickMs)} | ${count(s.longTasksDuringColdOpen)} | ${count(s.longTasksDuringReads)} |`,
  );
}
lines.push("");
lines.push("Cold open operations differ by mode: browser-local is a full bootstrap into IndexedDB, request-driven is capabilities plus list plus the first 20 reads. See ../measurements/README.md.");
process.stdout.write(`${lines.join("\n")}\n`);
