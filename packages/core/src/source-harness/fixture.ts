/**
 * The fixture harness: replay a profile's scripted provider answers through the engine, map and
 * write each committed page through record-overlay over a MemoryBackend bundle, and check each
 * required scenario's outcome rule. The rules are profile-independent, so one list holds every
 * profile, generic or extension, to the same behaviour.
 */
import { bindSourceFeed, credentialHosts, type BoundFeed, type Connector } from "../connectors.js";
import { mutateDocument } from "../document-mutation.js";
import { loadKinds } from "../kinds-load.js";
import { MemoryBackend } from "../memory-backend.js";
import { buildSourceIndex } from "../record-overlay/source-index.js";
import { createSourceOverlayAdapter, type SourceOverlaySnapshot } from "../source-engine/overlay.js";
import type { OverlayBundle, OverlayReceipt, RecordChange } from "../record-overlay/types.js";
import { MemoryMachineState, type SourceState } from "../source-engine/machine-state.js";
import { observeSource } from "../source-engine/observe.js";
import { fetchIdentity, type FetchIdentity } from "../source-engine/robots.js";
import type { ObserveSourceOptions, SourceBudget, SourceProfile, SourceRunReceipt } from "../source-engine/types.js";
import type { ConceptId, Frontmatter, OkfDocument } from "../types.js";
import { ExchangePeer, peerTransport, type PeerRequest, type ScriptedExchange, type TransportCredential } from "./peer.js";

/** Every profile's fixture includes these; a name may add a variant after a dot (`cursor.resume.page-number`). */
export const REQUIRED_SCENARIOS = Object.freeze([
  "errors.auth",
  "errors.rate-limit",
  "errors.server",
  "errors.malformed",
  "page.incomplete",
  "cursor.resume",
  "cursor.hostile",
  "complete.disappear",
  "fields.owned-conflict",
  "fields.unmapped",
  "fields.null",
  "identity.missing",
  "hosts.redirect",
  "hosts.undeclared",
] as const);
export type RequiredScenario = (typeof REQUIRED_SCENARIOS)[number];

/** The required scenario a name counts toward, or undefined. */
export function scenarioBase(name: string): RequiredScenario | undefined {
  return REQUIRED_SCENARIOS.find((base) => name === base || name.startsWith(`${base}.`));
}

/** Required scenarios no name covers. */
export function missingScenarios(names: Iterable<string>): RequiredScenario[] {
  const covered = new Set<string>();
  for (const name of names) {
    const base = scenarioBase(name);
    if (base) covered.add(base);
  }
  return REQUIRED_SCENARIOS.filter((base) => !covered.has(base));
}

export interface SourceFixture {
  connector: Connector;
  profile: SourceProfile<any, any>;
  spec: unknown;
  /**
   * The bundle's starting documents: Conventions for the target Kind, `Signal` and `Source Feed`,
   * the Source Feed, and any overlay documents.
   */
  documents: readonly OkfDocument[];
  feed: ConceptId;
  identity?: FetchIdentity;
  credential?: TransportCredential;
  /** Explicit fixture-only host assertion; never inferred from a declaration or used for live consent. */
  readPolicyApproval?: ObserveSourceOptions["readPolicyApproval"];
}

export interface SourceRunScript {
  mode?: "incremental" | "complete";
  /** The run's observation time; runs default to one hour apart. */
  at?: string;
  exchanges: readonly ScriptedExchange[];
  /** Editor edits applied before the run. */
  edits?: ReadonlyArray<{ id: ConceptId; set: Record<string, unknown> }>;
  budget?: Partial<SourceBudget>;
}

export interface SourceScenario {
  name: string;
  /** Replaces the fixture's spec for this scenario. */
  spec?: unknown;
  runs: readonly SourceRunScript[];
}

export interface ScenarioRun {
  receipt: SourceRunReceipt;
  /** Every change a commit carried, replays of pending changes included. */
  changes: RecordChange[];
  /** One record-overlay receipt per committed page. */
  overlay: OverlayReceipt[];
  /** The run's findings, written. */
  findings: OverlayReceipt;
  /** Requests that reached the provider. */
  received: PeerRequest[];
  unscripted: string[];
  unused: ScriptedExchange[];
  stateBefore: SourceState | null;
  state: SourceState | null;
  /** Every document's frontmatter after the run. */
  documents: Record<string, Frontmatter>;
}

export interface ScenarioResult {
  name: string;
  base: RequiredScenario | undefined;
  /** The declared hosts the scenario's spec may reach. */
  hosts: string[];
  threshold: number;
  edits: Array<{ run: number; id: ConceptId; set: Record<string, unknown> }>;
  runs: ScenarioRun[];
}

const FIXTURE_IDENTITY = fetchIdentity("SuperbeeSourceFixture/1 (+https://superbee.example.org/source-fixture)") as FetchIdentity;
const SOURCE_ACTOR = "process:source-fixture";
const EDITOR = "human:fixture-editor";
const START = Date.parse("2026-01-01T00:00:00.000Z");

function declaredHosts(fixture: SourceFixture, spec: unknown, bound: BoundFeed): string[] {
  if (bound.source.request?.read_policy !== undefined) return [bound.source.request.host];
  try {
    const checked = fixture.profile.validateSpec(spec);
    if (!checked.ok) return [];
    const reach = new Set([...credentialHosts(fixture.connector.auth), ...fixture.connector.domains]);
    return [...new Set(fixture.profile.hostsFor(checked.spec, bound))].filter((host) => reach.has(host)).sort();
  } catch {
    return [];
  }
}

/** Run one scenario's runs in order over one fresh bundle and one machine state. */
export async function runSourceScenario(fixture: SourceFixture, scenario: SourceScenario): Promise<ScenarioResult> {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Source fixture\n");
  const bundle = { root: "memory://source-fixture", backend };
  for (const doc of fixture.documents) await backend.write(doc.id, { id: doc.id, frontmatter: structuredClone(doc.frontmatter), body: doc.body });
  const registry = await loadKinds(bundle);
  const overlay: OverlayBundle = { bundle, registry, okfVersion: "0.2" };
  const bound = bindSourceFeed(fixture.connector, (await backend.read(fixture.feed)).doc, registry, { okfVersion: "0.2" });
  const state = new MemoryMachineState();
  let accepted: SourceOverlaySnapshot = { v: 1, entries: [] };
  const spec = scenario.spec !== undefined ? scenario.spec : fixture.spec;
  const slug = `${fixture.feed.split("/").pop()!.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-source`;
  const result: ScenarioResult = {
    name: scenario.name, base: scenarioBase(scenario.name), hosts: declaredHosts(fixture, spec, bound),
    threshold: bound.policy.missing_threshold ?? 2, edits: [], runs: [],
  };
  for (const [index, script] of scenario.runs.entries()) {
    for (const edit of script.edits ?? []) {
      result.edits.push({ run: index, id: edit.id, set: { ...edit.set } });
      await mutateDocument({
        bundle, id: edit.id, mode: "patch", registry, strict: false, actor: EDITOR,
        buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter, ...edit.set } as Frontmatter, body: existing!.body }),
      });
    }
    const controller = new AbortController();
    const peer = new ExchangePeer(script.exchanges, { onHang: () => controller.abort() });
    const at = script.at ?? new Date(START + index * 3_600_000).toISOString();
    const stateBefore = (await state.read(fixture.feed))?.state ?? null;
    const changes: RecordChange[] = [];
    const overlayReceipts: OverlayReceipt[] = [];
    const adapter = createSourceOverlayAdapter({ content: overlay, policy: bound.policy, actor: SOURCE_ACTOR,
      overlays: await buildSourceIndex(bundle), accepted, slug });
    if (stateBefore) {
      await adapter.reconcile(stateBefore, at);
      accepted = adapter.stagedSnapshot()!;
      adapter.consume();
    }
    const jointState = {
      read: state.read.bind(state),
      async write(key: string, value: SourceState, expected: string | null) {
        try {
          const version = await state.write(key, value, expected);
          accepted = adapter.stagedSnapshot() ?? adapter.snapshot();
          adapter.consume();
          return version;
        } catch (error) { adapter.discard(); throw error; }
      },
    };
    const receipt = await observeSource({
      connector: fixture.connector, bound, profile: fixture.profile, spec, state: jointState, identity: fixture.identity ?? FIXTURE_IDENTITY,
      transport: peerTransport(peer, fixture.credential ? { credential: fixture.credential } : {}),
      readPolicyApproval: fixture.readPolicyApproval,
      mode: script.mode ?? "incremental", signal: controller.signal, now: () => new Date(at),
      ...(script.budget ? { budget: script.budget } : {}),
      commit: async (page) => {
        const applied = await adapter.commit(page);
        changes.push(...page.changes);
        overlayReceipts.push(applied.receipt);
        return applied;
      },
    });
    const findings = await adapter.applyFindings(receipt.findings, at);
    const documents: Record<string, Frontmatter> = {};
    for (const id of await backend.list()) documents[id] = (await backend.read(id)).doc.frontmatter;
    result.runs.push({
      receipt, changes, overlay: overlayReceipts, findings, received: [...peer.received], unscripted: [...peer.unscripted], unused: peer.unused(),
      stateBefore, state: (await state.read(fixture.feed))?.state ?? null, documents,
    });
  }
  return result;
}

const json = (value: unknown): string => JSON.stringify(value ?? null);
const outcomeFindings = (run: ScenarioRun) => run.receipt.findings.filter((finding) => finding.key.startsWith("source:"));
const hasCode = (run: ScenarioRun, ...codes: string[]) => run.receipt.diagnostics.some((d) => codes.includes(d.code));
const writesNothing = (run: ScenarioRun): boolean => run.receipt.pages === 0 && run.changes.length === 0;
const cursorKept = (run: ScenarioRun): boolean => json(run.state?.cursor) === json(run.stateBefore?.cursor);
const hostOf = (url: string): string | undefined => {
  try { return new URL(url).hostname; } catch { return undefined; }
};
const reachedHost = (run: ScenarioRun, url: string): boolean => run.received.some((request) => hostOf(request.url) === hostOf(url));

/** At least one run satisfies `predicate`, or the scenario fails with `missing`. */
function some(result: ScenarioResult, missing: string, predicate: (run: ScenarioRun, index: number) => boolean): string[] {
  return result.runs.some(predicate) ? [] : [missing];
}

const CHECKS: Record<RequiredScenario, (result: ScenarioResult) => string[]> = {
  "errors.auth": (r) => some(r, "no run ends credential_refused with nothing written, no retry, the cursor kept and one finding",
    (run) => run.receipt.outcome === "credential_refused" && !run.receipt.retry && writesNothing(run) && cursorKept(run) && outcomeFindings(run).length === 1),

  "errors.rate-limit": (r) => some(r, "no run commits a page and then ends deferred on 429 with a Retry-After, the cursor at its last committed page",
    (run) => run.receipt.outcome === "deferred" && run.receipt.status === 429 && run.receipt.pages >= 1 && run.receipt.retry_after !== undefined
      && run.state?.open === true && json(run.state.cursor) === json(run.receipt.cursor)),

  "errors.server": (r) => some(r, "no run ends provider_unavailable on a 5xx with nothing written and one finding",
    (run) => run.receipt.outcome === "provider_unavailable" && (run.receipt.status ?? 0) >= 500 && writesNothing(run) && outcomeFindings(run).length === 1),

  "errors.malformed": (r) => [
    ...some(r, "no run ends unsupported_content with nothing written and one finding",
      (run) => run.receipt.outcome === "unsupported_content" && writesNothing(run) && outcomeFindings(run).length === 1),
    ...some(r, "no run ends too_large with nothing written and one finding",
      (run) => run.receipt.outcome === "too_large" && writesNothing(run) && outcomeFindings(run).length === 1),
  ],

  "page.incomplete": (r) => some(r, "no run commits a page, stops before the pass ends and stores the cursor of its last committed page as a partial observation",
    (run) => run.receipt.pages >= 1 && !run.receipt.pass.ended && !run.receipt.pass.complete && run.receipt.outcome !== "observed"
      && run.state?.open === true && json(run.state.cursor) === json(run.receipt.cursor) && run.receipt.changes.disappeared === 0),

  "cursor.resume": (r) => {
    const resumed = r.runs.map((run, index) => ({ run, index })).filter(({ run, index }) => index > 0 && run.receipt.pass.resumed && r.runs[index - 1]!.state?.open === true);
    if (!resumed.length) return ["no run resumes a pass an earlier run left open"];
    const problems: string[] = [];
    for (const { run, index } of resumed) {
      if (run.receipt.pass.complete) problems.push(`run ${index + 1} resumed a pass and counted it complete`);
      const known = run.stateBefore?.records ?? {};
      for (const change of run.changes) {
        if (change.change_kind === "new" && Object.hasOwn(known, change.external_id) && !known[change.external_id]!.gone) problems.push(`run ${index + 1} reported ${change.external_id} as new after resuming`);
        if (change.change_kind === "changed" && known[change.external_id]?.digest === change.content_digest) problems.push(`run ${index + 1} reported an overlap record ${change.external_id} as changed`);
      }
    }
    return problems;
  },

  "cursor.hostile": (r) => some(r, "no run refuses a provider-steered request (a host, redirect, address, scheme or url refusal) after a committed page",
    (run) => run.receipt.pages >= 1 && run.receipt.outcome === "refused"
      && run.receipt.requests.some((row) => row.purpose === "page" && row.refused !== undefined && /^(host|redirect|address|scheme|url)_/.test(row.refused))),

  "complete.disappear": (r) => {
    const problems: string[] = [];
    let disappeared = 0;
    let completeSeen = false;
    let partialBetween = false;
    r.runs.forEach((run, index) => {
      const before = run.stateBefore?.records ?? {};
      const after = run.state?.records ?? {};
      for (const [id, entry] of Object.entries(after)) {
        const grew = entry.missing - (before[id]?.missing ?? 0);
        if (!run.receipt.pass.complete && grew > 0) problems.push(`run ${index + 1} is not complete and counted ${id} missing`);
        if (grew > 1) problems.push(`run ${index + 1} counted ${id} missing more than once`);
      }
      for (const change of run.changes.filter((c) => c.change_kind === "disappeared")) {
        disappeared += 1;
        if (!run.receipt.pass.complete) problems.push(`run ${index + 1} reported ${change.external_id} disappeared without a complete observation`);
        if (change.missing_count !== r.threshold) problems.push(`${change.external_id} disappeared after ${change.missing_count} complete observations, not ${r.threshold}`);
      }
      if (run.receipt.pass.complete) completeSeen = true;
      else if (completeSeen && run.receipt.pages >= 1) partialBetween = true;
    });
    if (!disappeared) problems.push("no record disappeared");
    if (!partialBetween) problems.push("no partial or resumed pass ran between complete observations");
    return problems;
  },

  "fields.owned-conflict": (r) => some(r, "no run refuses an owned field the editor changed, keeps the editor's value and raises a Signal",
    (run, index) => run.overlay.some((receipt) => receipt.refusals.some((refusal) => refusal.code === "OVERLAY_DOC_CONFLICT" && refusal.target !== undefined && refusal.field !== undefined
      && r.edits.some((edit) => edit.run <= index && edit.id === refusal.target && Object.hasOwn(edit.set, refusal.field!) && json(run.documents[refusal.target!]?.[refusal.field!]) === json(edit.set[refusal.field!])))
      && receipt.results.some((step) => (step.op === "create-signal" || step.op === "collapse-signal") && step.outcome === "applied"))),

  "fields.unmapped": (r) => some(r, "no run keeps or refuses a value outside the values table with a mapping finding and no write of that field",
    (run) => run.receipt.diagnostics.some((d) => (d.code === "VALUE_UNMAPPED" || d.code === "RECORD_REFUSED")
      && run.receipt.findings.some((f) => f.key.startsWith("mapping:") && (f.facts as { code?: string } | undefined)?.code === d.code)
      && !run.changes.some((c) => c.external_id === d.external_id && c.changed_fields.includes(d.field)))),

  "fields.null": (r) => [
    ...some(r, "no committed change removes an optional field the provider sent empty",
      (run) => run.changes.some((c) => c.before !== null && c.after !== null && Object.keys(c.before).some((field) => !Object.hasOwn(c.after!, field) && c.changed_fields.includes(field)))),
    ...some(r, "no run keeps a required field the provider sent empty (VALUE_MISSING)", (run) => hasCode(run, "VALUE_MISSING")),
  ],

  "identity.missing": (r) => some(r, "no run skips a record without an identity and raises a finding",
    (run) => hasCode(run, "IDENTITY_MISSING") && run.receipt.findings.some((f) => f.key.endsWith(":IDENTITY_MISSING"))),

  "hosts.redirect": (r) => some(r, "no run refuses a redirect to another host before requesting it",
    (run) => run.receipt.outcome === "refused" && (run.receipt.reason === "host_refused" || run.receipt.reason === "redirect_refused")
      && run.receipt.requests.some((row) => row.refused === run.receipt.reason && !reachedHost(run, row.url))),

  "hosts.undeclared": (r) => some(r, "no run refuses an undeclared host or method with no request to it",
    (run) => run.receipt.outcome === "refused" && (
      (run.receipt.reason === "hosts_undeclared" && run.received.length === 0)
      || (run.receipt.reason === "host_refused" && run.receipt.requests.some((row) => row.refused === "host_refused" && !reachedHost(run, row.url)))
      || (run.receipt.reason === "method_refused" && run.receipt.requests.some((row) => row.refused === "method_refused" && !run.received.some((request) => request.method === row.method && request.url === row.url))))),
};

/**
 * The problems with one scenario's result: its required outcome rule, plus for every scenario no
 * request to a host outside the declared set and no request the fixture did not script.
 */
export function checkScenario(result: ScenarioResult): string[] {
  const problems: string[] = [];
  const allowed = new Set(result.hosts);
  result.runs.forEach((run, index) => {
    for (const request of run.received) {
      const host = new URL(request.url).hostname;
      if (!allowed.has(host)) problems.push(`run ${index + 1} reached undeclared host ${host}`);
    }
    for (const request of run.unscripted) problems.push(`run ${index + 1} made an unscripted request: ${request}`);
  });
  if (result.base) problems.push(...CHECKS[result.base](result));
  return problems;
}

/** Run every scenario of a fixture, check each, and list the required scenarios it lacks. */
export async function runSourceFixture(fixture: SourceFixture, scenarios: readonly SourceScenario[]): Promise<{ results: ScenarioResult[]; problems: Record<string, string[]>; missing: RequiredScenario[] }> {
  const results: ScenarioResult[] = [];
  const problems: Record<string, string[]> = {};
  for (const scenario of scenarios) {
    const result = await runSourceScenario(fixture, scenario);
    results.push(result);
    const found = checkScenario(result);
    if (found.length) problems[scenario.name] = found;
  }
  return { results, problems, missing: missingScenarios(scenarios.map((s) => s.name)) };
}
