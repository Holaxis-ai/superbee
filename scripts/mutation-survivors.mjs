// Extract the SURVIVOR list from a Stryker mutation report — the named gaps the suite failed
// to catch (plans/test-suite-confidence item 2: "a number, not a feeling", plus the rows to
// file as tasks).
//
// Input: path(s) to Stryker's mutation.json (mutation-testing-report-schema). Default: both
// packages' reports if present (packages/core, packages/cli — written by `npm run
// mutation:core` / `mutation:cli`).
//
// Output (stdout): one line per surviving or uncovered mutant —
//   <package>/<file>:<line>:<column>  <mutator>  `<original>` -> `<replacement>`  [<status>]
// followed by a per-package summary (score, killed/survived/no-coverage counts). Exit 0 always:
// this is a REPORTING tool, not a gate — mutation runs are on-demand/scheduled, never a merge
// blocker (the plan's explicit call: compute-heavy, not per-PR).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_REPORTS = [
  path.join(repoRoot, "packages", "core", "reports", "mutation", "mutation.json"),
  path.join(repoRoot, "packages", "cli", "reports", "mutation", "mutation.json"),
];

export function survivorsFromReport(report, label) {
  const rows = [];
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let timedOut = 0;
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const source = data.source ?? "";
    for (const mutant of data.mutants ?? []) {
      if (mutant.status === "Killed") killed += 1;
      else if (mutant.status === "Timeout") timedOut += 1;
      else if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
        if (mutant.status === "Survived") survived += 1;
        else noCoverage += 1;
        const { start } = mutant.location;
        const original = sliceLocation(source, mutant.location);
        rows.push({
          file: `${label}/${file}`,
          line: start.line,
          column: start.column,
          mutator: mutant.mutatorName,
          original,
          replacement: mutant.replacement ?? "",
          status: mutant.status,
        });
      }
    }
  }
  rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const detected = killed + timedOut;
  const covered = detected + survived;
  const total = covered + noCoverage;
  const score = total === 0 ? null : (100 * detected) / total;
  return { rows, summary: { label, total, detected, survived, noCoverage, score } };
}

function sliceLocation(source, location) {
  if (!source) return "";
  const lines = source.split("\n");
  const { start, end } = location;
  if (start.line === end.line) {
    return (lines[start.line - 1] ?? "").slice(start.column - 1, end.column - 1);
  }
  const first = (lines[start.line - 1] ?? "").slice(start.column - 1);
  return `${first} …`;
}

function formatRow(row) {
  const original = truncate(row.original.replaceAll("\n", "\\n"), 60);
  const replacement = truncate(row.replacement.replaceAll("\n", "\\n"), 40);
  const marker = row.status === "NoCoverage" ? "  [no coverage]" : "";
  return `${row.file}:${row.line}:${row.column}  ${row.mutator}  \`${original}\` -> \`${replacement}\`${marker}`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function main(argv) {
  const reportPaths = argv.length > 0 ? argv : DEFAULT_REPORTS.filter((p) => existsSync(p));
  if (reportPaths.length === 0) {
    console.log("no mutation reports found — run `npm run mutation:core` / `npm run mutation:cli` first");
    return;
  }
  const summaries = [];
  for (const reportPath of reportPaths) {
    const label = path.relative(repoRoot, reportPath).split(path.sep).slice(0, 2).join("/");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const { rows, summary } = survivorsFromReport(report, label);
    for (const row of rows) console.log(formatRow(row));
    summaries.push(summary);
  }
  for (const s of summaries) {
    const score = s.score === null ? "n/a (no mutants)" : `${s.score.toFixed(2)}%`;
    console.log(
      `# ${s.label}: score ${score} — ${s.detected}/${s.total} detected, ${s.survived} survived, ${s.noCoverage} no-coverage`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
