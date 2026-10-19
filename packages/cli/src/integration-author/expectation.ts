import type { ScenarioResult } from "@superbee/core/source-harness";

/** Each run's explicit expected public contract. All keys are mandatory, including empty arrays. */
export interface SourceRunExpectation {
  receipt: { outcome: unknown; reason: unknown; pages: unknown; held: unknown; pending: unknown; pass: unknown; changes: unknown };
  cursor: unknown; requests: unknown; changes: unknown; findings: unknown;
}
/** Stable projection: clocks and internal state are not the expected provider contract. */
export function sourceRunExpectation(run: ScenarioResult["runs"][number]): SourceRunExpectation {
  const { receipt } = run;
  return JSON.parse(JSON.stringify({ receipt: { outcome: receipt.outcome, reason: receipt.reason ?? null, pages: receipt.pages,
    held: receipt.held, pending: receipt.pending, pass: receipt.pass, changes: receipt.changes },
    cursor: receipt.cursor, requests: run.received, changes: run.changes, findings: receipt.findings })) as SourceRunExpectation;
}
