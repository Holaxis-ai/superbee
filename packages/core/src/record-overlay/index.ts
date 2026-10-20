/**
 * `@superbee/core/record-overlay`: the generic write half of binding documents to external records.
 *
 * A Source Feed policy names the fields a feed owns. `planRecordOverlay` turns the caller's record
 * changes into steps under the three-value rule (converged, write, or conflict plus a Signal), each
 * carrying the version it was decided against; `applyRecordOverlay` writes them through
 * `mutateDocument` with a core-owned guard per write step on the fresh read. A source writes only
 * its owned fields, never the body, never a document of its target Kind, and never deletes; the
 * only documents it creates are Signals of one claimable attention Kind in the ops bundle.
 *
 * Everything site specific is a hook with a safe default: the text gate, the occurrence interval,
 * correlation, `sources` properties, site candidate rules and derived fields. Storage-neutral: no
 * Node globals or builtins.
 */
export {
  DEFAULT_AUTO_APPLY,
  DEFAULT_NEEDS_REVIEW,
  NEVER_OWNED,
  decideChange,
  gateSafeValue,
  isExcludedRecord,
  readOverlayPolicy,
  readOverlayPolicyForResource,
} from "./policy.js";
export { disappearedPhase, planRecordOverlay, summarizeChange } from "./plan.js";
export { FINDING_CHANGE_KIND, findingDigest, planFindings } from "./findings.js";
export { applyRecordOverlay, composeGuards, ownershipGuard } from "./apply.js";
export { SourceIndex, buildSourceIndex } from "./source-index.js";
export { HOLD_STORE, OverlayRefusal, REFUSAL_CODES, RETRYABLE } from "./errors.js";
export type { RefusalCode } from "./errors.js";
export type {
  ApplyContext,
  ApplyOwnedFieldsStep,
  AssertCandidate,
  ChangeDecision,
  CollapseSignalStep,
  CorrelateHook,
  CreateSignalStep,
  DisappearedPhase,
  Finding,
  FindingsInput,
  IntervalHook,
  OverlayBundle,
  OverlayHooks,
  OverlayPlan,
  OverlayPolicy,
  OverlayReceipt,
  OverlayStep,
  PlanInput,
  PolicyContext,
  RecordChange,
  RecordOnlyStep,
  RefusalRow,
  SignalDuplicateStep,
  StepResult,
  Tell,
  TextGate,
} from "./types.js";
