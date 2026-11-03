/** `recipe add --index`: the CLI byte adapter over Core's published-index verifier. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, readDoc } from "@superbee/core";
import { builtinRecipeFiles, loadBuiltinRecipe } from "@superbee/core/builtin-recipes";
import { recipeSourceDigest } from "@superbee/core/recipe-lifecycle";
import { RECIPE_INDEX_FORMAT } from "@superbee/core/recipe-sources";

import { recipe } from "../src/commands/recipe.js";
import { CliError } from "../src/errors.js";
import { fetchHttpsText, type FetchLike } from "../src/recipe-source-index.js";

const OFFERING = { id: "starter", title: "Starter", summary: "Notes and tasks.", recipes: ["context-notes", "work-tracking"] };

function digestOf(name: string): string {
  const loaded = loadBuiltinRecipe(name);
  assert.ok(loaded?.ok);
  return recipeSourceDigest(loaded.recipe);
}

/** Writes built-in recipe bytes under `layout(name)` and an index naming them; returns the index path. */
async function writeIndex(root: string, source: string, indexDir: string, layout: (name: string) => string, names: string[], offerings: unknown[] = [OFFERING]): Promise<string> {
  const recipes = [];
  for (const name of names) {
    const files = builtinRecipeFiles(name)!;
    for (const file of files) {
      const target = path.join(root, indexDir, layout(name), file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }
    recipes.push({ id: name, version: "1", source_digest: digestOf(name), root: layout(name), files: files.map((file) => file.path) });
  }
  const indexPath = path.join(root, indexDir, "index.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify({ format: RECIPE_INDEX_FORMAT, source, title: `${source} recipes`, recipes, offerings }, null, 2));
  return indexPath;
}

async function run(argv: string[], fetch?: FetchLike): Promise<Record<string, unknown>> {
  let out = "";
  await recipe([...argv, "--json"], { stdout: (s) => (out += s), ...(fetch ? { fetch } : {}) });
  return JSON.parse(out) as Record<string, unknown>;
}

async function refusal(argv: string[], fetch?: FetchLike): Promise<CliError> {
  try {
    await run(argv, fetch);
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail(`expected ${argv.join(" ")} to refuse`);
}

/** Every file under a bundle, path to bytes: the zero-write oracle. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = await readFile(full, "utf8");
  }
  return out;
}

async function withScratch(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-recipe-index-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Installed definition content: the stamp is compared separately and clocks always differ. */
function definitionContent(doc: { frontmatter: Record<string, unknown>; body: string }) {
  const { generated: _generated, timestamp: _timestamp, superbee_updated_by: _by, ...frontmatter } = doc.frontmatter;
  return { frontmatter, body: doc.body };
}

test("recipe add --index installs one verified recipe and names the index and digest in the receipt", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes", "work-tracking"]);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const receipt = await run(["add", "context-notes", "--index", index, "--dir", bundle]);
    assert.equal(receipt.recipe, "added");
    assert.equal(receipt.id, "context-notes");
    assert.equal(receipt.version, "1");
    assert.equal(receipt.source, "index:alpha");
    assert.equal(receipt.source_digest, digestOf("context-notes"));
    assert.deepEqual(receipt.index, { source: "alpha", location: index });
    const installed = await readDoc({ root: bundle }, "conventions/context-note");
    assert.equal((installed.frontmatter.x_recipe as Record<string, unknown>).source_digest, receipt.source_digest);

    const again = await run(["add", "context-notes", "--index", index, "--dir", bundle]);
    assert.equal(again.recipe, "already applied");
    assert.equal(again.changed, false);
  });
});

test("swap: two index sources with different ids and layouts install identical documents", async () => {
  await withScratch(async (root) => {
    const a = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes", "work-tracking"]);
    const b = await writeIndex(root, "beta", "mirror/v1", (name) => `packages/${name}-pkg/src`, ["work-tracking", "context-notes"]);
    const bundles = [path.join(root, "one"), path.join(root, "two")];
    const receipts = [];
    for (const [i, index] of [a, b].entries()) {
      await initBundle(bundles[i]!);
      receipts.push(await run(["add", "starter", "--offering", "--index", index, "--dir", bundles[i]!]));
    }
    const rows = receipts.map((receipt) => (receipt.recipes as Array<Record<string, unknown>>).map((row) => [row.id, row.source_digest]));
    assert.deepEqual(rows[0], rows[1]);
    for (const id of ["conventions/context-note", "conventions/task"]) {
      const [one, two] = await Promise.all(bundles.map((dir) => readDoc({ root: dir }, id)));
      assert.deepEqual(definitionContent(one!), definitionContent(two!), id);
    }
  });
});

test("recipe add --index --offering verifies every member, installs in order and reports each digest", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes", "work-tracking"]);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const receipt = await run(["add", "starter", "--offering", "--index", index, "--dir", bundle]);
    assert.equal(receipt.offering, "starter");
    assert.equal(receipt.title, "Starter");
    assert.equal(receipt.changed, true);
    assert.deepEqual(receipt.index, { source: "alpha", location: index });
    const rows = receipt.recipes as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => [row.id, row.version, row.source_digest, row.recipe]), [
      ["context-notes", "1", digestOf("context-notes"), "added"],
      ["work-tracking", "1", digestOf("work-tracking"), "added"],
    ]);
    assert.match(String(receipt.install_note), /verified .* before the first write/);
    assert.match(String(receipt.install_note), /rerunning this command .* converges/);

    const again = await run(["add", "starter", "--offering", "--index", index, "--dir", bundle]);
    assert.equal(again.changed, false);
    assert.deepEqual((again.recipes as Array<Record<string, unknown>>).map((row) => row.recipe), ["already applied", "already applied"]);
  });
});

test("offering atomicity: one tampered member means zero writes, even for members before it", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes", "work-tracking"]);
    const task = path.join(root, "alpha/recipes/work-tracking/conventions/task.md");
    await writeFile(task, (await readFile(task, "utf8")).replace("# ", "# Tampered "));
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const before = await snapshot(bundle);
    const error = await refusal(["add", "starter", "--offering", "--index", index, "--dir", bundle]);
    assert.equal(error.code, "INTEGRITY_MISMATCH");
    assert.equal(error.details?.reason, "RECIPE_INDEX_DIGEST_MISMATCH");
    assert.equal(error.details?.recipe, "work-tracking");
    assert.deepEqual(await snapshot(bundle), before);
  });
});

test("red probes at the CLI: unlisted files are ignored, path escapes and tampered single recipes write nothing", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes"], []);
    await writeFile(path.join(root, "alpha/recipes/context-notes/conventions/injected.md"), "---\ntype: Convention\ngoverns: Injected\n---\n# Injected\n");
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const receipt = await run(["add", "context-notes", "--index", index, "--dir", bundle]);
    assert.ok(!(receipt.docs as Array<Record<string, unknown>>).some((doc) => String(doc.id).includes("injected")));
    await assert.rejects(readDoc({ root: bundle }, "conventions/injected"));

    const parsed = JSON.parse(await readFile(index, "utf8"));
    parsed.recipes[0].files.push("../../outside.md");
    const escaping = path.join(root, "alpha/escaping.json");
    await writeFile(escaping, JSON.stringify(parsed));
    const fresh = path.join(root, "fresh");
    await initBundle(fresh);
    const before = await snapshot(fresh);
    const escape = await refusal(["add", "context-notes", "--index", escaping, "--dir", fresh]);
    assert.equal(escape.code, "USAGE");
    assert.equal(escape.details?.reason, "RECIPE_INDEX_PATH_INVALID");

    const note = path.join(root, "alpha/recipes/context-notes/conventions/context-note.md");
    await writeFile(note, (await readFile(note, "utf8")).replace("# ", "# Changed "));
    const tampered = await refusal(["add", "context-notes", "--index", index, "--dir", fresh]);
    assert.equal(tampered.code, "INTEGRITY_MISMATCH");
    assert.deepEqual(await snapshot(fresh), before);
  });
});

test("recipe add --index refuses other schemes, --offering without --index and unknown ids", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes"], []);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    for (const location of ["http://example.com/index.json", "file:///tmp/index.json", "ftp://example.com/i.json"]) {
      const error = await refusal(["add", "context-notes", "--index", location, "--dir", bundle]);
      assert.equal(error.code, "USAGE", location);
      assert.equal(error.details?.reason, "RECIPE_INDEX_SCHEME_REFUSED", location);
    }
    assert.equal((await refusal(["add", "starter", "--offering", "--dir", bundle])).code, "USAGE");
    const unknown = await refusal(["add", "nope", "--index", index, "--dir", bundle]);
    assert.equal(unknown.details?.reason, "RECIPE_NOT_FOUND");
    assert.match(String(unknown.help), /context-notes/);
    const unknownOffering = await refusal(["add", "context-notes", "--offering", "--index", index, "--dir", bundle]);
    assert.equal(unknownOffering.details?.reason, "RECIPE_NOT_FOUND");
  });
});

// ── HTTPS acquisition, with an injected transport; nothing reaches the network ────────────────

function servedFetch(files: Map<string, string | { status: number }>, calls: Array<{ url: string; redirect: string }>): FetchLike {
  return async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    const served = files.get(url);
    if (served === undefined) return { status: 404, body: new Response("missing").body };
    if (typeof served !== "string") return { status: served.status, body: new Response("").body };
    return { status: 200, body: new Response(served).body };
  };
}

function servedIndex(base: string, names: string[]): Map<string, string | { status: number }> {
  const files = new Map<string, string | { status: number }>();
  const recipes = names.map((name) => {
    const recipeFiles = builtinRecipeFiles(name)!;
    for (const file of recipeFiles) files.set(`${base}r/${name}/${file.path}`, file.bytes);
    return { id: name, version: "1", source_digest: digestOf(name), root: `r/${name}`, files: recipeFiles.map((file) => file.path) };
  });
  files.set(`${base}index.json`, JSON.stringify({ format: RECIPE_INDEX_FORMAT, source: "remote", recipes, offerings: [OFFERING] }));
  return files;
}

test("recipe add --index <https-url> resolves files against the index URL and refuses redirects", async () => {
  await withScratch(async (root) => {
    const base = "https://recipes.example.test/catalog/";
    const calls: Array<{ url: string; redirect: string }> = [];
    const fetch = servedFetch(servedIndex(base, ["context-notes", "work-tracking"]), calls);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const receipt = await run(["add", "starter", "--offering", "--index", `${base}index.json`, "--dir", bundle], fetch);
    assert.deepEqual(receipt.index, { source: "remote", location: `${base}index.json` });
    assert.ok(calls.every((call) => call.redirect === "error" && call.url.startsWith(base)));
    assert.ok(calls.some((call) => call.url === `${base}r/work-tracking/conventions/task.md`));
  });
});

test("HTTPS failures: non-200, oversize and invalid UTF-8 refuse; a tampered served file writes nothing", async () => {
  await withScratch(async (root) => {
    const base = "https://recipes.example.test/";
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const before = await snapshot(bundle);

    const gone = servedIndex(base, ["context-notes", "work-tracking"]);
    gone.set(`${base}index.json`, { status: 503 });
    const unavailable = await refusal(["add", "context-notes", "--index", `${base}index.json`, "--dir", bundle], servedFetch(gone, []));
    assert.equal(unavailable.code, "TRANSIENT");

    const missingFile = servedIndex(base, ["context-notes", "work-tracking"]);
    missingFile.delete(`${base}r/context-notes/recipe.md`);
    const unreadable = await refusal(["add", "context-notes", "--index", `${base}index.json`, "--dir", bundle], servedFetch(missingFile, []));
    assert.equal(unreadable.code, "TRANSIENT");
    assert.equal(unreadable.details?.reason, "RECIPE_INDEX_READ_FAILED");

    const tampered = servedIndex(base, ["context-notes", "work-tracking"]);
    const key = `${base}r/context-notes/conventions/context-note.md`;
    tampered.set(key, `${tampered.get(key)}\nInjected line.\n`);
    const mismatch = await refusal(["add", "context-notes", "--index", `${base}index.json`, "--dir", bundle], servedFetch(tampered, []));
    assert.equal(mismatch.code, "INTEGRITY_MISMATCH");
    assert.deepEqual(await snapshot(bundle), before);

    const big: FetchLike = async () => ({ status: 200, body: new Response("x".repeat(64)).body });
    await assert.rejects(fetchHttpsText(new URL(`${base}big`), big, 16, 1000), /exceeds 16 bytes/);
    const latin1: FetchLike = async () => ({ status: 200, body: new Response(new Uint8Array([0xff, 0xfe])).body });
    await assert.rejects(fetchHttpsText(new URL(`${base}bad`), latin1, 16, 1000), /not valid UTF-8/);
    await assert.rejects(fetchHttpsText(new URL("http://insecure.test/"), big, 16, 1000), /non-https/);
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await assert.rejects(fetchHttpsText(new URL(`${base}slow`), hang, 16, 20), /timed out after 20 ms/);
  });
});
