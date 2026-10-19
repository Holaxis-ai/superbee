/** Recorded fixtures delegate execution and reconciliation to the public core harness. */
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { assertSafeConceptId, type OkfDocument } from "@superbee/core";
import { getSourceProfile } from "@superbee/core/source-profiles";
import type { SourceProfile } from "@superbee/core/source-engine";
import { checkScenario, missingScenarios, REQUIRED_SCENARIOS, runSourceScenario, type SourceFixture, type SourceScenario } from "@superbee/core/source-harness";
import { authorLocation, readAuthorFolder, type AuthorDiagnostic } from "./files.js";
import { loadAuthorRecipe } from "./validate.js";
import { sourceRunExpectation, type SourceRunExpectation } from "./expectation.js";
export { sourceRunExpectation } from "./expectation.js";
export type { SourceRunExpectation } from "./expectation.js";
import { assertPathOutsidePrivateState } from "../private-state-bundle-boundary.js";

export const SOURCE_TEST_LIMITS = Object.freeze({ scenarios: 64, runs: 16, exchanges: 512 });

export interface SourceAuthorScenario extends SourceScenario { expect: SourceRunExpectation[] }
export interface SourceAuthorFixture {
  version: 1; connector: string; source: string; feed: string;
  documents: OkfDocument[]; spec?: unknown; scenarios: SourceAuthorScenario[];
}
export interface SourceAuthorTestReport {
  ok: boolean; execution: "recorded" | "explicit-local-profile";
  profile: { id: string; version: number; kind: string } | null;
  required: readonly string[]; missing: string[];
  scenarios: Array<{ name: string; ok: boolean; problems: string[]; runs: number }>;
  diagnostics: AuthorDiagnostic[];
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysExactly = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

function parseFixture(value: unknown): SourceAuthorFixture | undefined {
  if (!record(value) || !keysExactly(value, ["version", "connector", "source", "feed", "documents", "scenarios"], ["spec"]) || value.version !== 1) return undefined;
  if (![value.connector, value.source, value.feed].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256)) return undefined;
  if (!Array.isArray(value.documents) || value.documents.length > 256 || !Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > SOURCE_TEST_LIMITS.scenarios) return undefined;
  const ids = new Set<string>();
  for (const doc of value.documents) {
    if (!record(doc) || !keysExactly(doc, ["id", "frontmatter", "body"]) || typeof doc.id !== "string" || !record(doc.frontmatter) || typeof doc.body !== "string" || ids.has(doc.id)) return undefined;
    try { assertSafeConceptId(doc.id); } catch { return undefined; }
    ids.add(doc.id);
  }
  const names = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!record(scenario) || !keysExactly(scenario, ["name", "runs", "expect"], ["spec"]) || typeof scenario.name !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(scenario.name) || names.has(scenario.name)) return undefined;
    names.add(scenario.name);
    if (!Array.isArray(scenario.runs) || !scenario.runs.length || scenario.runs.length > SOURCE_TEST_LIMITS.runs || !Array.isArray(scenario.expect) || scenario.expect.length !== scenario.runs.length) return undefined;
    for (const run of scenario.runs) {
      if (!record(run) || !keysExactly(run, ["exchanges"], ["mode", "at", "edits", "budget"]) || !Array.isArray(run.exchanges) || run.exchanges.length > SOURCE_TEST_LIMITS.exchanges) return undefined;
      if (run.mode !== undefined && run.mode !== "complete" && run.mode !== "incremental") return undefined;
      if (run.at !== undefined && (typeof run.at !== "string" || !Number.isFinite(Date.parse(run.at)))) return undefined;
      if (run.edits !== undefined && !Array.isArray(run.edits)) return undefined;
      if (run.budget !== undefined && !record(run.budget)) return undefined;
      for (const exchange of run.exchanges) {
        if (!record(exchange) || !keysExactly(exchange, ["request", "response"]) || !record(exchange.request) || !record(exchange.response)) return undefined;
      }
    }
    for (const expected of scenario.expect) {
      if (!record(expected) || !keysExactly(expected, ["receipt", "cursor", "requests", "changes", "findings"]) || !record(expected.receipt) || !keysExactly(expected.receipt, ["outcome", "reason", "pages", "held", "pending", "pass", "changes"])) return undefined;
      if (!Array.isArray(expected.requests) || !Array.isArray(expected.changes) || !Array.isArray(expected.findings)) return undefined;
    }
  }
  return value as unknown as SourceAuthorFixture;
}

async function explicitProfile(file: string): Promise<SourceProfile | undefined> {
  // This is the sole executable input. A recipe or fixture never chooses a module to import.
  // It is trusted local code, not a sandbox; no ambient authority is granted by its declaration.
  try {
    assertPathOutsidePrivateState(file);
    if (!/\.(?:mjs|js)$/.test(file)) return undefined;
    const resolved = await fs.realpath(path.resolve(file));
    if (!(await fs.stat(resolved)).isFile()) return undefined;
    const module: unknown = await import(pathToFileURL(resolved).href);
    const selected = record(module) ? module.default ?? module.profile : undefined;
    if (!record(selected) || typeof selected.id !== "string" || !Number.isSafeInteger(selected.version) || (selected.version as number) < 1 || !["generic", "extension"].includes(String(selected.kind))
      || typeof selected.validateSpec !== "function" || typeof selected.hostsFor !== "function" || typeof selected.observe !== "function") return undefined;
    return selected as unknown as SourceProfile;
  } catch { return undefined; }
}

export async function testSourceForAuthor(recipeFolder: string, fixtureFolder: string, options: { profile?: string } = {}): Promise<SourceAuthorTestReport> {
  const report: SourceAuthorTestReport = { ok: false, execution: options.profile ? "explicit-local-profile" : "recorded", profile: null,
    required: REQUIRED_SCENARIOS, missing: [...REQUIRED_SCENARIOS], scenarios: [], diagnostics: [] };
  const fail = (code: string, file: string, message: string): SourceAuthorTestReport => {
    report.diagnostics.push({ code, file: authorLocation(file), path: "", message }); return report;
  };
  const loaded = await loadAuthorRecipe(recipeFolder);
  if (!loaded.ok) { report.diagnostics = loaded.diagnostics; return report; }
  // Recorded attack strings (for example a userinfo redirect) are data under test. The report
  // never echoes provider bytes, actual/expected values, or raw harness/profile error messages.
  try { assertPathOutsidePrivateState(fixtureFolder); }
  catch { return fail("AUTHOR_UNSAFE_PATH", "--fixture", "Recorded fixtures must be outside private credential state."); }
  const acquired = await readAuthorFolder(fixtureFolder, { scanSecrets: false, requiredFile: "fixture.json" });
  if (!acquired.ok) { report.diagnostics = acquired.diagnostics; return report; }
  const text = acquired.files.find((file) => file.path === "fixture.json")?.bytes;
  if (text === undefined) return fail("SOURCE_FIXTURE_MISSING", "fixture.json", "A fixture directory must contain fixture.json.");
  let fixture: SourceAuthorFixture | undefined;
  try { fixture = parseFixture(JSON.parse(text)); } catch { /* No parser exception or input values on stdout. */ }
  if (!fixture) return fail("SOURCE_FIXTURE_INVALID", "fixture.json", "Invalid version-1 fixture shape or bounds; each run needs receipt, cursor, requests, changes and findings expectations.");
  const selected = (loaded.recipe.connectors ?? []).find((item) => item.connector.id === fixture!.connector);
  const source = selected?.connector.sources.find((item) => item.name === fixture!.source);
  if (!selected || !source) return fail("SOURCE_FIXTURE_TARGET_INVALID", "fixture.json", "The fixture must name a Connector and source carried by this recipe.");
  const profile = options.profile ? await explicitProfile(options.profile) : getSourceProfile(source.profile);
  if (!profile || profile.id !== source.profile) return fail("PROFILE_NOT_AVAILABLE", options.profile ? "--profile" : `${selected.connector.id}.md`, "No matching shipped profile or valid explicitly selected local profile is available.");
  report.profile = { id: profile.id, version: profile.version, kind: profile.kind };
  const documents = [...loaded.recipe.docs, ...fixture.documents];
  if (new Set(documents.map((doc) => doc.id)).size !== documents.length) return fail("SOURCE_FIXTURE_DUPLICATE_DOCUMENT", "fixture.json", "Fixture documents cannot shadow recipe definitions or each other.");
  const subject: SourceFixture = { connector: selected.connector, profile, spec: fixture.spec ?? source, documents, feed: fixture.feed };
  report.missing = missingScenarios(fixture.scenarios.map((scenario) => scenario.name));
  for (const scenario of fixture.scenarios) {
    const problems: string[] = [];
    try {
      const result = await runSourceScenario(subject, scenario);
      // Core owns invariant checks. Never emit its strings: a provider-controlled URL may be in one.
      const invariantProblems = checkScenario(result);
      if (invariantProblems.length) problems.push(`${invariantProblems.length} core scenario invariant(s) failed.`);
      result.runs.forEach((run, index) => {
        const actual = sourceRunExpectation(run);
        const expected = scenario.expect[index]!;
        for (const key of ["receipt", "cursor", "requests", "changes", "findings"] as const) {
          if (!isDeepStrictEqual(actual[key], expected[key])) problems.push(`Run ${index + 1}: expected ${key} differs.`);
        }
        if (run.unused.length) problems.push(`Run ${index + 1}: ${run.unused.length} recorded exchange(s) were unused.`);
      });
    } catch { problems.push("Fixture execution failed; inspect the selected profile and recorded scenario locally."); }
    report.scenarios.push({ name: scenario.name, ok: problems.length === 0, problems, runs: scenario.runs.length });
  }
  report.ok = report.missing.length === 0 && report.scenarios.every((scenario) => scenario.ok);
  return report;
}
