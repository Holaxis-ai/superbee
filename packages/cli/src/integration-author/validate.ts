/** Public recipe/Connector validators, projected for an outside author without installing. */
import { buildKindRegistry, parseMarkdown, type OkfDocument } from "@superbee/core";
import { checkConnectorAgainstKinds, connectorPinDigest, credentialHosts, parseConnectorDoc, type Connector, type ConnectorSource } from "@superbee/core/connectors";
import { parseRecipeFiles, type LoadedRecipe } from "@superbee/core/recipes";
import { getSourceProfile } from "@superbee/core/source-profiles";
import { authorLocation, readAuthorFolder, type AuthorDiagnostic, type AuthorFile } from "./files.js";

export interface AuthorSourceSummary {
  name: string; profile: string; kind: "generic" | "extension" | "unavailable";
  hosts: readonly string[]; method: string | null; path: string | null; ownedFields: string[];
}
export interface AuthorConnectorSummary {
  id: string; pin: string; auth: string; provider: string | null; sources: AuthorSourceSummary[];
}
export interface RecipeValidationReport {
  ok: boolean; recipe: { id: string; version: string } | null;
  diagnostics: AuthorDiagnostic[]; connectors: AuthorConnectorSummary[]; readme?: string;
}
export type AuthorRecipeLoad = { ok: true; recipe: LoadedRecipe; files: AuthorFile[] } | { ok: false; diagnostics: AuthorDiagnostic[] };

function safeDiagnostic(code: string, file: string, pointer: string, message: string): AuthorDiagnostic {
  return { code, file: authorLocation(file), path: authorLocation(pointer), message: authorLocation(message) };
}

/** No module imports, installation, bundle discovery, remote requests or credential reads. */
export async function loadAuthorRecipe(folder: string): Promise<AuthorRecipeLoad> {
  const acquired = await readAuthorFolder(folder, { requiredFile: "recipe.md" });
  if (!acquired.ok) return acquired;
  const diagnostics: AuthorDiagnostic[] = [];
  const docs: OkfDocument[] = [];
  for (const file of acquired.files) {
    if (!file.path.endsWith(".md")) continue;
    try { docs.push({ id: file.path.slice(0, -3), ...parseMarkdown(file.bytes) }); }
    catch { diagnostics.push(safeDiagnostic("AUTHOR_MARKDOWN_INVALID", file.path, "", "Invalid Markdown frontmatter; repair this file before validation.")); }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const kinds = buildKindRegistry(docs.filter((doc) => doc.id.startsWith("conventions/")), [], { okfVersion: "0.2" });
  for (const warning of kinds.warnings) diagnostics.push(safeDiagnostic(warning.code, warning.field ?? "conventions/", "", warning.message));
  // The recipe parser returns one acquisition error; collect all Connector pointers first.
  for (const doc of docs.filter((doc) => doc.id.startsWith("connectors/"))) {
    const parsed = parseConnectorDoc(doc, { kinds });
    const errors = parsed.ok ? checkConnectorAgainstKinds(parsed.connector, kinds) : parsed.errors;
    for (const error of errors) diagnostics.push(safeDiagnostic(error.code, `${doc.id}.md`, error.path, error.message));
  }
  let loaded: ReturnType<typeof parseRecipeFiles>;
  try { loaded = parseRecipeFiles(acquired.files, "local author package", { okfVersion: "0.2" }); }
  catch { diagnostics.push(safeDiagnostic("RECIPE_MALFORMED", "recipe.md", "", "The recipe could not be parsed; repair its declarations.")); return { ok: false, diagnostics }; }
  if (!loaded.ok) {
    if (!diagnostics.length || loaded.error.code !== "RECIPE_CONNECTOR_INVALID") diagnostics.push(safeDiagnostic(loaded.error.code, "recipe.md", loaded.error.connector?.path ?? "", loaded.error.message));
    return { ok: false, diagnostics };
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, recipe: loaded.recipe, files: acquired.files };
}

function sourceSummary(connector: Connector, source: ConnectorSource): AuthorSourceSummary {
  const profile = getSourceProfile(source.profile);
  const request = (source as ConnectorSource & { request?: { host?: string; method?: string; path?: string } }).request;
  return {
    name: source.name, profile: source.profile, kind: profile?.kind ?? "unavailable",
    hosts: request?.host ? [request.host] : [...credentialHosts(connector.auth), ...connector.domains],
    method: request?.method ?? (request ? "GET" : null), path: request?.path ?? null,
    ownedFields: Object.keys(source.fields).sort(),
  };
}

export async function validateRecipeForAuthor(folder: string, options: { readme?: boolean } = {}): Promise<RecipeValidationReport> {
  const loaded = await loadAuthorRecipe(folder);
  if (!loaded.ok) return { ok: false, recipe: null, diagnostics: loaded.diagnostics, connectors: [] };
  const diagnostics: AuthorDiagnostic[] = [];
  const connectors: AuthorConnectorSummary[] = [];
  for (const item of loaded.recipe.connectors ?? []) {
    const { connector } = item;
    const file = `${connector.id}.md`;
    connector.sources.forEach((source, index) => {
      const profile = getSourceProfile(source.profile);
      if (!profile) {
        diagnostics.push(safeDiagnostic("PROFILE_NOT_AVAILABLE", file, `/record_sources/${index}/profile`, `Profile '${source.profile}' is not shipped in this release. Validation never loads executable extension modules.`));
        return;
      }
      const checked = profile.validateSpec(source);
      if (!checked.ok) for (const error of checked.errors) diagnostics.push(safeDiagnostic("PROFILE_SPEC_INVALID", file, `/record_sources/${index}${error.path}`, error.message));
    });
    connectors.push({ id: connector.id, pin: connectorPinDigest(connector), auth: connector.auth.kind,
      provider: connector.auth.provider ?? (connector.auth.kind === "github-app" ? "github" : null), sources: connector.sources.map((source) => sourceSummary(connector, source)) });
  }
  const report: RecipeValidationReport = { ok: diagnostics.length === 0, recipe: { id: loaded.recipe.id, version: loaded.recipe.version }, diagnostics, connectors };
  if (options.readme) report.readme = integrationReadmeTemplate(report);
  return report;
}

/** Author-owned support decisions remain blanks, never invented certification or admission. */
export function integrationReadmeTemplate(report: RecipeValidationReport): string {
  return ["# Integration author checklist", "", "Publisher / maintainer: <fill in>", "License / support scope: <fill in>",
    "Compatible Superbee / recipe versions: <fill in>", "Fixture evidence and required scenarios: <link results>",
    "Credential custody: supplied separately by the operator; never included in this package.",
    ...report.connectors.flatMap((connector) => ["", `## ${connector.id}`, `Declaration pin: ${connector.pin}`, `Authentication: ${connector.auth}${connector.provider ? ` (${connector.provider})` : ""}`,
      "Required permissions / allowed resources per bundle: <fill in>", ...connector.sources.map((source) => `- ${source.name}: ${source.profile} (${source.kind}); ${source.method ?? "profile-defined"} ${source.path ?? "profile-defined"}; hosts ${source.hosts.join(", ")}; owned fields ${source.ownedFields.join(", ")}`)]),
    "", "Managed admission status: not established by validation or fixture tests.", "Installation grants no credentials, binding, network access or scheduled execution.", ""].join("\n");
}
