/** Rebuild the recorded REST author example from the source engine's synthetic scenario corpus.
 * Run after the root build. Review changed expectations; never run this from the test command.
 */
import "../packages/cli/test/ts-loader.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseMarkdown } from "@superbee/core";
import { parseConnectorDoc } from "@superbee/core/connectors";
import { restJsonProfile } from "@superbee/core/source-profiles";
import { runSourceScenario, checkScenario } from "@superbee/core/source-harness";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ticketFixture, SCENARIOS, ITEMS } = await import("../packages/core/test/fixtures/source-engine/tickets.ts");
const { sourceRunExpectation } = await import("../packages/cli/src/integration-author/expectation.ts");
const folder = path.join(root, "examples/integrations/rest-json-authoring");
const raw = parseMarkdown(await readFile(path.join(folder, "recipe/connectors/tickets.md"), "utf8"));
const parsed = parseConnectorDoc({ id: "connectors/tickets", ...raw });
if (!parsed.ok) throw new Error("Example Connector no longer parses.");
const source = parsed.connector.sources[0];
const base = ticketFixture();
const profileFixture = { ...base, connector: parsed.connector, profile: restJsonProfile, spec: source };
const scenarios = [];
for (const previous of SCENARIOS) {
  // Numeric paging needs a second declared Connector, not a spec that widens this cursor source.
  // Its owning profile tests cover that strategy; this package proves every required base case.
  if (previous.name === "cursor.resume.page-number") continue;
  // The generic profile deliberately has one declared paging strategy, not the test double's
  // combined token/next_url grammar. Each hostile URL has its own explicit strategy.
  let scenario = structuredClone(previous);
  if (scenario.name === "cursor.hostile") {
    scenario = { name: scenario.name, spec: { ...source, request: { ...source.request, query: {}, paging: { kind: "cursor", next_path: "next_url" } } }, runs: [{ exchanges: [{ request: { url: ITEMS }, response: { status: 200, body: JSON.stringify({ items: [{ id: "t1", title: "First", status: "OPEN", priority: "low" }], next_url: "https://unlisted.example.net/items" }) } }] }] };
  } else if (scenario.name === "hosts.undeclared") {
    scenario.spec = { ...source, request: { ...source.request, host: "elsewhere.example.net" } };
  } else if (scenario.name === "hosts.undeclared.post") {
    scenario.spec = { ...source, request: { ...source.request, method: "POST" } };
  }
  const result = await runSourceScenario(profileFixture, scenario);
  const problems = checkScenario(result);
  if (problems.length) throw new Error(`Core scenario ${scenario.name} no longer meets its invariant: ${problems.join("; ")}`);
  if (result.runs.some((run) => run.unused.length || run.unscripted.length)) throw new Error(`Example ${scenario.name} did not consume its recorded exchanges exactly.`);
  scenarios.push({ ...scenario, expect: result.runs.map(sourceRunExpectation) });
}
const fixture = { version: 1, connector: parsed.connector.id, source: source.name, feed: base.feed,
  documents: base.documents.filter((doc) => doc.id !== "conventions/ticket"), scenarios };
await writeFile(path.join(folder, "fixture/fixture.json"), JSON.stringify(fixture, null, 2) + "\n");
console.log(`Recorded ${scenarios.length} synthetic scenarios; review the fixture diff before accepting.`);
