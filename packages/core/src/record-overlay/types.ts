/** Types of `@superbee/core/record-overlay`. Step and result rows keep the record-bridge keys. */
import type { DocumentMutationCandidate } from "../document-mutation.js";
import type { KindConvention, KindRegistry } from "../kinds.js";
import type { Bundle, ConceptId, Frontmatter, OkfDocument, Version } from "../types.js";
import type { RefusalCode } from "./errors.js";
import type { SourceIndex } from "./source-index.js";

/** One bundle as the overlay reads and writes it. */
export interface OverlayBundle {
  bundle: Bundle;
  registry: KindRegistry;
  okfVersion: "0.1" | "0.2";
}

/** The generic Source Feed policy: which fields a feed owns and what each change kind may do. */
export interface OverlayPolicy {
  feed: ConceptId;
  /** The provider identity (`url`), as `sources[].resource` names it. */
  provider: string;
  /** The Kind of the overlay documents. Absent for a record-only or presentation-only feed. */
  target_kind?: string;
  owned_fields: string[];
  auto_apply: string[];
  needs_review: string[];
  missing_threshold?: number;
  completeness?: "complete" | "partial";
  /** The feed's wall-time zone, validated by whoever owns the interval hook. */
  time_zone?: string;
  exclude?: RegExp | null;
  exclude_ids?: ReadonlySet<string> | null;
}

/** Field checks for the reader: the target Kind's declared fields, or a presentation kind's fields. */
export type PolicyContext =
  | { targetKind?: KindConvention; presentationFields?: never }
  | { presentationFields: readonly string[]; targetKind?: never };

/** One change the caller's diff observed for one external record. */
export interface RecordChange {
  external_id: string;
  change_kind: string;
  changed_fields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  content_digest: string;
  occurs_at?: string;
  missing_count?: number;
  first_missing_at?: string;
  collapse_with?: string[];
  signal_priority?: string;
}

export interface Tell {
  code: string;
  match: string;
  [property: string]: unknown;
}

/** A publication text gate: the text as it may be written, and whether it may be written at all. */
export type TextGate = (
  text: string,
  context: { field: string; kind: string | undefined },
) => { text: string; ok: boolean; tells: Tell[]; changed?: boolean };

/** `[startMs, endMs)` of a record's last known occurrence, or null when its dates are unknown. */
export type IntervalHook = (
  fields: Record<string, unknown>,
  timeZone: string | undefined,
) => readonly [number, number] | null;

export type DisappearedPhase = "ended" | "before-start" | "ongoing" | null;

export interface CorrelateHook {
  kind: string;
  match: (
    fields: Record<string, unknown>,
    frontmatter: Frontmatter,
    externalId: string,
  ) => null | undefined | { reason: string; priority?: string };
}

/** Runs on every fresh candidate through `mutateDocument`, after the core-owned guards. */
export type AssertCandidate = (
  existing: OkfDocument | undefined,
  candidate: DocumentMutationCandidate,
) => void | Promise<void>;

export interface OverlayHooks {
  textGate?: TextGate;
  interval?: IntervalHook;
  correlate?: CorrelateHook;
  /** Scalar properties for the `sources` entry of an applied record; none means no upsert. */
  sourceProperties?: (change: RecordChange) => Record<string, string | number | boolean> | undefined;
  /** Site rules, run after the core-owned guards on the same fresh read. */
  assertCandidate?: (
    existing: OkfDocument | undefined,
    candidate: DocumentMutationCandidate,
    context: { step: OverlayStep["op"]; bundle: "content" | "ops" },
  ) => void | Promise<void>;
  /** Fields derived in the same write as the owned fields (for example `updated_at`). */
  deriveFields?: {
    fields: readonly string[];
    derive: (existing: OkfDocument, next: DocumentMutationCandidate) => Record<string, unknown>;
  };
}

export interface ChangeDecision {
  apply: Record<string, { from: unknown; to: unknown }>;
  conflicts: Array<{ field: string; doc_value: unknown; feed_before: unknown; feed_after: unknown }>;
  editorFields: string[];
  wording: Array<{ field: string; text: string; tells: Tell[] }>;
  signal: null | { priority: string; reasons: string[] };
}

export interface PlanInput {
  content: OverlayBundle;
  ops: OverlayBundle;
  policy: OverlayPolicy;
  changes: readonly RecordChange[];
  observedAt: string;
  /** Next store records, for titles. */
  records?: Record<string, { fields?: Record<string, unknown> }>;
  observation?: { baseline?: boolean; replay?: boolean; stats?: Record<string, unknown> };
  /** A per-run identity index; without one the plan builds its own for this provider and Kind. */
  overlays?: SourceIndex;
  timeZone?: string;
  /** Ops and content are one bundle, so typed `about` links are possible. */
  sameBundle?: boolean;
  /** Attention and feed Kind names; default `Signal` and `Source Feed`. */
  signals?: { kind?: string; feedKind?: string };
  hooks?: OverlayHooks;
}

export interface Finding {
  key: string;
  title: string;
  summary?: string;
  priority?: string;
  about_doc?: string;
  related?: string[];
  facts?: unknown;
  sources?: Array<{ resource: string; id?: string; title?: string; [property: string]: unknown }>;
  external_id?: string;
  expires_at?: string;
  change_kind?: string;
}

export interface FindingsInput {
  ops: OverlayBundle;
  /** Signal `provider`: a feed URL or a tool name. */
  provider: string;
  /** Source Feed id for the `from feed` link; absent for tool-raised findings. */
  feed?: ConceptId;
  /** Signal id prefix after the attention Kind's path. */
  slug: string;
  findings: readonly Finding[] | null | undefined;
  observedAt: string;
  signals?: { kind?: string; feedKind?: string };
}

export interface ApplyContext {
  content: OverlayBundle;
  ops: OverlayBundle;
  policy: Pick<OverlayPolicy, "owned_fields" | "provider" | "target_kind">;
  actor: string;
  overlays?: SourceIndex;
  /** Attention and feed Kind names, as the plan was made with; default `Signal` and `Source Feed`. */
  signals?: { kind?: string; feedKind?: string };
  hooks?: Pick<OverlayHooks, "assertCandidate" | "deriveFields">;
}

export interface ApplyOwnedFieldsStep {
  op: "apply-owned-fields";
  target: ConceptId;
  expected_version: Version;
  external_id: string;
  change_kind: string;
  fields: Record<string, { from: unknown; to: unknown }>;
  /** Grouped shape: properties upserted on the record's `sources` entry in the same write. */
  sources?: Record<string, string | number | boolean>;
}

export interface CreateSignalStep {
  op: "create-signal";
  target: ConceptId;
  external_id: string;
  content_digest: string;
  finding?: string;
  reasons: string[];
  candidate: { frontmatter: Frontmatter; body: string };
}

export interface CollapseSignalStep {
  op: "collapse-signal";
  target: ConceptId;
  expected_version: Version;
  external_id: string;
  content_digest: string;
  finding?: string;
  progress_field: string;
  observation_line: string;
  set: Record<string, unknown>;
}

export interface SignalDuplicateStep {
  op: "signal-duplicate";
  target: ConceptId;
  external_id: string;
  content_digest: string;
  finding?: string;
}

export interface RecordOnlyStep {
  op: "record-only";
  target?: undefined;
  external_id: string;
  change_kind?: string;
  superseded?: true;
  ended?: true;
  reason?: string;
  last_known_end?: string;
  excluded?: true;
  collapsed_into?: ConceptId;
}

export type OverlayStep =
  | ApplyOwnedFieldsStep
  | CreateSignalStep
  | CollapseSignalStep
  | SignalDuplicateStep
  | RecordOnlyStep;

export interface RefusalRow {
  code: RefusalCode;
  external_id: string;
  target?: ConceptId;
  targets?: ConceptId[];
  field?: string;
  message: string;
}

export interface OverlayPlan {
  feed: ConceptId | null;
  provider: string;
  observed_at: string;
  baseline?: boolean;
  replay?: boolean;
  stats?: Record<string, unknown>;
  steps: OverlayStep[];
  refusals: RefusalRow[];
  diagnostics?: unknown[];
}

export interface StepResult {
  op: OverlayStep["op"];
  target: ConceptId | null;
  external_id: string;
  outcome: "applied" | "unchanged" | "skipped" | "refused";
  version?: Version;
  code?: RefusalCode;
  message?: string;
  details?: Record<string, unknown>;
  reason?: string;
  last_known_end?: string;
}

export interface OverlayReceipt {
  feed: ConceptId | null;
  provider: string;
  observed_at: string;
  results: StepResult[];
  refusals: RefusalRow[];
  diagnostics: unknown[];
}
