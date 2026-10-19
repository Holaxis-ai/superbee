import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { containsCredentialText } from "@superbee/core/connectors";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runSourceScenario } from "@superbee/core/source-harness";
import { installRecipe } from "@superbee/core/recipe-lifecycle";
import { MemoryBackend } from "@superbee/core/memory-backend";
import { ticketFixture, SCENARIOS, CONNECTOR_MD } from "../../core/test/fixtures/source-engine/tickets.js";
import { readAuthorFolder, AUTHOR_FILE_LIMITS } from "../src/integration-author/files.js";
import { loadAuthorRecipe, validateRecipeForAuthor } from "../src/integration-author/validate.js";
import { sourceRunExpectation, testSourceForAuthor, type SourceAuthorFixture } from "../src/integration-author/source-test.js";
import { source as sourceCommand } from "../src/commands/source.js";
import { recipeValidate } from "../src/commands/recipe-validate.js";
import { CliError } from "../src/errors.js";

const secret = "ghp_" + "SyntheticCredentialForRedactionOnly123456";
const here = path.dirname(fileURLToPath(import.meta.url));
const markdown = (frontmatter: unknown, body = ""): string => `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-integration-author-"));
  const recipe = path.join(root, "recipe");
  const fixture = path.join(root, "recorded");
  await mkdir(path.join(recipe, "conventions"), { recursive: true });
  await mkdir(path.join(recipe, "connectors"));
  await mkdir(fixture);
  const base = ticketFixture();
  await writeFile(path.join(recipe, "recipe.md"), markdown({ type: "Recipe", id: "author-tickets", title: "Author tickets", version: "1", summary: "Synthetic author test.", content_policy: "definitions-only", connectors: ["connectors/tickets.md"] }));
  for (const doc of base.documents.filter((doc) => doc.id.startsWith("conventions/"))) await writeFile(path.join(recipe, `${doc.id}.md`), markdown(doc.frontmatter, doc.body));
  await writeFile(path.join(recipe, "connectors/tickets.md"), CONNECTOR_MD);
  return { root, recipe, fixture, base };
}

test("recipe validation is inert and an unavailable profile is an explicit refusal", async () => {
  const w = await workspace();
  try {
    await writeFile(path.join(w.root, "not-selected.mjs"), `throw new Error('must not import');`);
    const result = await validateRecipeForAuthor(w.recipe, { readme: true });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "PROFILE_NOT_AVAILABLE");
    assert.equal(result.diagnostics[0]?.path, "/record_sources/0/profile");
    assert.match(result.connectors[0]!.pin, /^sha256:/);
    assert.match(result.readme!, /Installation grants no credentials/);
    const loaded = await loadAuthorRecipe(w.recipe);
    assert.equal(loaded.ok, true);
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test("author package scan refuses README and hidden credential containers without disclosure", async () => {
  for (const filename of ["README.md", ".env", ".env.production"]) {
    const w = await workspace();
    try {
      await writeFile(path.join(w.recipe, filename), `example=${secret}\n`);
      const result = await validateRecipeForAuthor(w.recipe);
      assert.equal(result.ok, false);
      assert.equal(result.diagnostics[0]?.code, "CONNECTOR_SECRET_PRESENT");
      assert.equal(result.diagnostics[0]?.file, filename);
      assert.equal(JSON.stringify(result).includes(secret), false);
    } finally { await rm(w.root, { recursive: true, force: true }); }
  }
});

test("author acquisition refuses symlinks and files beyond its byte bound", async () => {
  const w = await workspace();
  try {
    await writeFile(path.join(w.root, "outside.md"), secret);
    if (process.platform !== "win32") {
      await symlink(path.join(w.root, "outside.md"), path.join(w.recipe, "linked.md"));
      const result = await readAuthorFolder(w.recipe);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.diagnostics[0]?.code, "AUTHOR_UNSAFE_PATH");
      await rm(path.join(w.recipe, "linked.md"));
    }
    await writeFile(path.join(w.recipe, "large.txt"), "x".repeat(AUTHOR_FILE_LIMITS.fileBytes + 1));
    const large = await readAuthorFolder(w.recipe);
    assert.equal(large.ok, false);
    if (!large.ok) assert.equal(large.diagnostics[0]?.code, "AUTHOR_FILE_LIMIT");
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test("validation reports every bad Connector mapping with JSON pointers", async () => {
  const w = await workspace();
  try {
    await writeFile(path.join(w.recipe, "connectors/tickets.md"), CONNECTOR_MD.replace("title: title", "never_declared: title").replace("url: html_url", "also_missing: html_url"));
    const report = await validateRecipeForAuthor(w.recipe);
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.length >= 2);
    assert.ok(report.diagnostics.every((item) => item.path.startsWith("/record_sources/0/fields/")));
    assert.equal(report.connectors.length, 0);
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

async function recordedWorkspace() {
  const w = await workspace();
  // Reuse the engine's existing synthetic scenario corpus, not a second observer or mapper.
  // The expected projection verifies this adapter; the core harness owns behavior assertions.
  const scenarios: SourceAuthorFixture["scenarios"] = [];
  for (const scenario of SCENARIOS) {
    const result = await runSourceScenario(w.base, scenario);
    scenarios.push({ ...scenario, expect: result.runs.map(sourceRunExpectation) });
  }
  const fixture: SourceAuthorFixture = { version: 1, connector: w.base.connector.id, source: "tickets", feed: w.base.feed,
    documents: w.base.documents.filter((doc) => !doc.id.startsWith("conventions/")), spec: w.base.spec, scenarios };
  await writeFile(path.join(w.fixture, "fixture.json"), JSON.stringify(fixture));
  const original = await readFile(path.resolve(here, "../../core/test/fixtures/source-engine/json-pages-profile.ts"), "utf8");
  const source = original.replace('"../../../src/source-engine/index.js"', '"@superbee/core/source-engine"') + "\nexport default jsonPagesProfile;\n";
  const profile = path.join(w.root, "profile.mjs");
  // Resolve only the public installed API from this explicit fixture module outside the repo.
  const publicEntry = import.meta.resolve("@superbee/core/source-engine");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace('"@superbee/core/source-engine"', JSON.stringify(publicEntry));
  await writeFile(profile, compiled);
  return { ...w, profile, data: fixture };
}

test("recorded test delegates all required scenarios and compares explicit receipts without live I/O", async () => {
  const w = await recordedWorkspace();
  const fetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("live fetch forbidden"); }) as typeof fetch;
  try {
    const report = await testSourceForAuthor(w.recipe, w.fixture, { profile: w.profile });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.missing, []);
    assert.equal(report.execution, "explicit-local-profile");
    assert.equal(report.scenarios.length, SCENARIOS.length);
    assert.ok(report.scenarios.every((row) => row.ok));
  } finally { globalThis.fetch = fetch; await rm(w.root, { recursive: true, force: true }); }
});

test("recorded source test refuses missing scenarios and changed expected receipts", async () => {
  const w = await recordedWorkspace();
  try {
    w.data.scenarios = w.data.scenarios.filter((scenario) => scenario.name !== "errors.auth");
    await writeFile(path.join(w.fixture, "fixture.json"), JSON.stringify(w.data));
    let report = await testSourceForAuthor(w.recipe, w.fixture, { profile: w.profile });
    assert.equal(report.ok, false);
    assert.deepEqual(report.missing, ["errors.auth"]);
    w.data.scenarios[0]!.expect[0]!.receipt.outcome = "forged-success";
    await writeFile(path.join(w.fixture, "fixture.json"), JSON.stringify(w.data));
    report = await testSourceForAuthor(w.recipe, w.fixture, { profile: w.profile });
    assert.equal(report.ok, false);
    assert.ok(report.scenarios[0]!.problems.includes("Run 1: expected receipt differs."));
    let output = "";
    await assert.rejects(sourceCommand(["test", w.recipe, "--fixture", w.fixture, "--profile", w.profile, "--json"], { stdout: (text) => { output += text; } }),
      (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.handled);
    assert.equal(JSON.parse(output).ok, false);
    assert.ok(JSON.parse(output).scenarios[0].problems.includes("Run 1: expected receipt differs."));
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test("provider/profile failures and unsupported profiles never become successful fixture reports", async () => {
  const w = await recordedWorkspace();
  try {
    const absent = await testSourceForAuthor(w.recipe, w.fixture);
    assert.equal(absent.ok, false);
    assert.equal(absent.diagnostics[0]?.code, "PROFILE_NOT_AVAILABLE");
    const throwing = path.join(w.root, "throwing.mjs");
    await writeFile(throwing, `throw new Error(${JSON.stringify(secret)});`);
    const failure = await testSourceForAuthor(w.recipe, w.fixture, { profile: throwing });
    assert.equal(failure.ok, false);
    assert.equal(failure.diagnostics[0]?.code, "PROFILE_NOT_AVAILABLE");
    assert.equal(JSON.stringify(failure).includes(secret), false);
    delete (w.data.scenarios[0] as unknown as Record<string, unknown>).expect;
    await writeFile(path.join(w.fixture, "fixture.json"), JSON.stringify(w.data));
    const invalid = await testSourceForAuthor(w.recipe, w.fixture, { profile: w.profile });
    assert.equal(invalid.diagnostics[0]?.code, "SOURCE_FIXTURE_INVALID");
    let output = "";
    await assert.rejects(recipeValidate([w.recipe, "--json"], { stdout: (text) => { output += text; } }),
      (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.handled);
    assert.equal(JSON.parse(output).diagnostics[0].code, "PROFILE_NOT_AVAILABLE");
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test("installing a Connector recipe stays inert, with no provider or fixture execution", async () => {
  const w = await workspace();
  const fetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("installation must not fetch"); }) as typeof fetch;
  try {
    const loaded = await loadAuthorRecipe(w.recipe);
    assert.ok(loaded.ok);
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
    await installRecipe({ root: "memory://inert-author-install", backend }, loaded.recipe);
    const ids = await backend.list();
    assert.ok(ids.includes("connectors/tickets"));
    assert.ok(ids.every((id) => id.startsWith("conventions/") || id.startsWith("connectors/")));
  } finally { globalThis.fetch = fetch; await rm(w.root, { recursive: true, force: true }); }
});

test("distributed declarative example meets independent core invariants and committed expectations", async () => {
  const example = path.resolve(here, "../../../examples/integrations/rest-json-authoring");
  const fetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("example must remain recorded"); }) as typeof fetch;
  try {
    const validation = await validateRecipeForAuthor(path.join(example, "recipe"));
    assert.equal(validation.ok, true, JSON.stringify(validation));
    assert.equal(validation.connectors[0]?.sources[0]?.profile, "rest-json");
    const report = await testSourceForAuthor(path.join(example, "recipe"), path.join(example, "fixture"));
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.execution, "recorded");
    assert.deepEqual(report.missing, []);
  } finally { globalThis.fetch = fetch; }
});

test("fixture presentation metadata refuses credential-shaped scenario names without disclosure", async () => {
  const w = await recordedWorkspace();
  const marker = "xoxb-synthetic-scenario-12345678";
  assert.equal(containsCredentialText(marker), true);
  try {
    assert.equal((await testSourceForAuthor(w.recipe, w.fixture, { profile: w.profile })).ok, true);
    w.data.scenarios.push({ ...w.data.scenarios[0]!, name: marker });
    await writeFile(path.join(w.fixture, "fixture.json"), JSON.stringify(w.data));
    const report = await testSourceForAuthor(w.recipe, w.fixture, { profile: w.profile });
    assert.equal(report.ok, false);
    assert.equal(report.diagnostics[0]?.code, "SOURCE_FIXTURE_INVALID");
    assert.equal(JSON.stringify(report).includes(marker), false);
    for (const format of [[], ["--json"]]) {
      let output = "";
      await assert.rejects(sourceCommand(["test", w.recipe, "--fixture", w.fixture, "--profile", w.profile, ...format], { stdout: (text) => { output += text; } }),
        (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.handled && !error.message.includes(marker));
      assert.equal(output.includes(marker), false, "JSON and TOON must not disclose the metadata");
    }
  } finally { await rm(w.root, { recursive: true, force: true }); }
});

test("valid recipe ancestors refuse hidden operational state before traversal, including aliases", async (t) => {
  const root = await fs.realpath(await mkdtemp(path.join(tmpdir(), "superbee-author-private-boundary-")));
  const example = path.resolve(here, "../../../examples/integrations/rest-json-authoring");
  const recipe = path.join(root, "recipe");
  const fixture = path.join(root, "fixture");
  await cp(path.join(example, "recipe"), recipe, { recursive: true });
  await cp(path.join(example, "fixture"), fixture, { recursive: true });
  const privateRoot = path.join(recipe, ".superbee-state");
  const sentinel = "invented-private-operational-payload-do-not-acquire";
  const entered: string[] = [], opened: string[] = [];
  const originalOpendir = fs.opendir, originalOpen = fs.open;
  t.mock.method(fs, "opendir", (...args: Parameters<typeof fs.opendir>) => { entered.push(String(args[0])); return originalOpendir(...args); });
  t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => { opened.push(String(args[0])); return originalOpen(...args); });
  try {
    assert.equal((await validateRecipeForAuthor(recipe)).ok, true);
    assert.equal((await testSourceForAuthor(recipe, fixture)).ok, true);
    // Manifest at the ancestor only: private state contains no recipe.
    await mkdir(privateRoot);
    await writeFile(path.join(privateRoot, "records.json"), sentinel);
    const aliases = [recipe];
    if (process.platform !== "win32") {
      const alias = path.join(root, "recipe-alias");
      await symlink(recipe, alias); aliases.push(alias);
    }
    for (const selected of aliases) {
      entered.length = 0; opened.length = 0;
      for (const invoke of [
        (stdout: (text: string) => void) => recipeValidate([selected, "--json"], { stdout }),
        (stdout: (text: string) => void) => sourceCommand(["test", selected, "--fixture", fixture, "--json"], { stdout }),
      ]) {
        let output = "";
        await assert.rejects(invoke((text) => { output += text; }), (error: unknown) => error instanceof CliError && error.exitCode === 2 && error.handled);
        assert.equal(entered.some((file) => file === privateRoot || file.startsWith(privateRoot + path.sep)), false, "never enumerate hidden operational state");
        assert.equal(opened.some((file) => file.startsWith(privateRoot + path.sep)), false, "never read hidden operational leaves");
        const report = JSON.parse(output);
        assert.equal(report.diagnostics[0]?.code, "AUTHOR_UNSAFE_PATH");
        assert.equal(report.diagnostics[0]?.file, ".superbee-state");
        assert.equal(output.includes(sentinel), false);
      }
      assert.equal(entered.some((file) => file === privateRoot || file.startsWith(privateRoot + path.sep)), false);
      assert.equal(opened.some((file) => file.startsWith(privateRoot + path.sep)), false);
    }
    await rm(privateRoot, { recursive: true });
    await mkdir(path.join(fixture, ".private"));
    await writeFile(path.join(fixture, ".private", "records.json"), sentinel);
    const report = await testSourceForAuthor(recipe, fixture);
    assert.equal(report.diagnostics[0]?.code, "AUTHOR_UNSAFE_PATH");
    assert.equal(report.diagnostics[0]?.file, ".private");
    assert.equal(JSON.stringify(report).includes(sentinel), false);
    assert.equal(entered.includes(path.join(fixture, ".private")), false);
    assert.equal(opened.includes(path.join(fixture, ".private", "records.json")), false);
  } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});

test("early hidden-entry refusals redact credential-shaped filenames before opening", async (t) => {
  const w = await workspace();
  const marker = "xoxb-synthetic-hidden-12345678";
  const filename = `.${marker}`;
  const opened: string[] = [];
  const originalOpen = fs.open;
  t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => { opened.push(String(args[0])); return originalOpen(...args); });
  try {
    await writeFile(path.join(w.recipe, filename), "invented private data");
    const report = await validateRecipeForAuthor(w.recipe);
    assert.equal(report.diagnostics[0]?.code, "AUTHOR_UNSAFE_PATH");
    assert.equal(report.diagnostics[0]?.file, "[redacted location]");
    assert.equal(JSON.stringify(report).includes(marker), false);
    assert.equal(opened.some((file) => path.basename(file) === filename), false);
  } finally { t.mock.restoreAll(); await rm(w.root, { recursive: true, force: true }); }
});
