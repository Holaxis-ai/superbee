/** `recipe add --index`: the CLI byte adapter over Core's published-index verifier. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, readDoc } from "@superbee/core";
import { builtinRecipeFiles, loadBuiltinRecipe } from "@superbee/core/builtin-recipes";
import { recipeSourceDigest } from "@superbee/core/recipe-lifecycle";
import { RECIPE_INDEX_FORMAT, recipeFilesDigest } from "@superbee/core/recipe-sources";
import { symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pluginFileRows } from "../src/trusted-local-plugins.js";

import { recipe } from "../src/commands/recipe.js";
import { CliError } from "../src/errors.js";
import { fetchHttpsBytes, type FetchLike, type RecipeIndexLimits } from "../src/recipe-source-index.js";

const OFFERING = { id: "starter", title: "Starter", summary: "Notes and tasks.", recipes: ["context-notes", "work-tracking"] };

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** files_digest of files as a publisher writes them (text as UTF-8). */
function pin(files: ReadonlyArray<{ path: string; bytes: string | Uint8Array }>): string {
  return recipeFilesDigest(files.map((file) => ({ path: file.path, bytes: typeof file.bytes === "string" ? utf8(file.bytes) : file.bytes })));
}

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
    recipes.push({ id: name, version: "1", source_digest: digestOf(name), files_digest: pin(files), root: layout(name), files: files.map((file) => file.path) });
  }
  const indexPath = path.join(root, indexDir, "index.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify({ format: RECIPE_INDEX_FORMAT, source, title: `${source} recipes`, recipes, offerings }, null, 2));
  return indexPath;
}

async function run(argv: string[], fetch?: FetchLike, indexLimits?: Partial<RecipeIndexLimits>): Promise<Record<string, unknown>> {
  let out = "";
  await recipe([...argv, "--json"], { stdout: (s) => (out += s), ...(fetch ? { fetch } : {}), ...(indexLimits ? { indexLimits } : {}) });
  return JSON.parse(out) as Record<string, unknown>;
}

async function refusal(argv: string[], fetch?: FetchLike, indexLimits?: Partial<RecipeIndexLimits>): Promise<CliError> {
  try {
    await run(argv, fetch, indexLimits);
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
    assert.equal(error.details?.digest, "files_digest");
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
    assert.match(String(unknown.help), /recipe add 'context-notes' --index /);
    assert.deepEqual(unknown.details?.available, { recipes: ["context-notes"], shown: 1, total: 1 });
    const unknownOffering = await refusal(["add", "context-notes", "--offering", "--index", index, "--dir", bundle]);
    assert.equal(unknownOffering.details?.reason, "RECIPE_NOT_FOUND");
  });
});

test("a changed title is refused at the CLI and names files_digest", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes"], []);
    const manifest = path.join(root, "alpha/recipes/context-notes/recipe.md");
    await writeFile(manifest, (await readFile(manifest, "utf8")).replace("title: Context Notes", "title: Free Money"));
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const before = await snapshot(bundle);
    const error = await refusal(["add", "context-notes", "--index", index, "--dir", bundle]);
    assert.equal(error.code, "INTEGRITY_MISMATCH");
    assert.equal(error.details?.digest, "files_digest");
    assert.deepEqual(await snapshot(bundle), before);
  });
});

test("red probe: a listed local file whose real path leaves the index directory is refused, even with matching bytes", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes"], []);
    const note = path.join(root, "alpha/recipes/context-notes/conventions/context-note.md");
    const outside = path.join(root, "outside-context-note.md");
    await writeFile(outside, await readFile(note, "utf8"));
    await rm(note);
    await symlink(outside, note);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const before = await snapshot(bundle);
    const error = await refusal(["add", "context-notes", "--index", index, "--dir", bundle]);
    assert.equal(error.details?.reason, "RECIPE_INDEX_READ_FAILED");
    assert.match(error.message, /outside the index directory/);
    assert.deepEqual(await snapshot(bundle), before);

    // A symlink that stays inside the index directory is honored.
    const inside = path.join(root, "alpha/shared-context-note.md");
    await writeFile(inside, await readFile(outside, "utf8"));
    await rm(note);
    await symlink(inside, note);
    assert.equal((await run(["add", "context-notes", "--index", index, "--dir", bundle])).recipe, "added");
  });
});

test("files_digest hashes rows in the source plugin file-row shape, sorted by path", () => {
  // An independent reimplementation over node:crypto: rows {digest, path} as pluginFileRows reports them.
  for (const name of ["context-notes", "roadmap", "site"]) {
    const files = builtinRecipeFiles(name)!;
    const rows = pluginFileRows(files.map((file) => ({ path: file.path, bytes: file.bytes })))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((row) => ({ digest: row.digest, path: row.path }));
    assert.equal(pin(files), `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`, name);
  }
});

// ── HTTPS acquisition, with an injected transport; nothing reaches the network ────────────────

function servedFetch(files: Map<string, string | Uint8Array | { status: number }>, calls: Array<{ url: string; redirect: string }>): FetchLike {
  return async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    const served = files.get(url);
    if (served === undefined) return { status: 404, body: new Response("missing").body };
    if (typeof served !== "string" && !(served instanceof Uint8Array)) return { status: served.status, body: new Response("").body };
    return { status: 200, body: new Response(served).body };
  };
}

function servedIndex(base: string, names: string[]): Map<string, string | Uint8Array | { status: number }> {
  const files = new Map<string, string | Uint8Array | { status: number }>();
  const recipes = names.map((name) => {
    const recipeFiles = builtinRecipeFiles(name)!;
    for (const file of recipeFiles) files.set(`${base}r/${name}/${file.path}`, file.bytes);
    return { id: name, version: "1", source_digest: digestOf(name), files_digest: pin(recipeFiles), root: `r/${name}`, files: recipeFiles.map((file) => file.path) };
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
    assert.equal(unreadable.code, "USAGE", "an HTTP 404 is the publisher's error, not a retry");
    assert.equal(unreadable.details?.reason, "RECIPE_INDEX_READ_FAILED");

    const tampered = servedIndex(base, ["context-notes", "work-tracking"]);
    const key = `${base}r/context-notes/conventions/context-note.md`;
    tampered.set(key, `${tampered.get(key)}\nInjected line.\n`);
    const mismatch = await refusal(["add", "context-notes", "--index", `${base}index.json`, "--dir", bundle], servedFetch(tampered, []));
    assert.equal(mismatch.code, "INTEGRITY_MISMATCH");
    assert.deepEqual(await snapshot(bundle), before);

    const fileServerError = servedIndex(base, ["context-notes", "work-tracking"]);
    fileServerError.set(`${base}r/context-notes/recipe.md`, { status: 502 });
    assert.equal((await refusal(["add", "context-notes", "--index", `${base}index.json`, "--dir", bundle], servedFetch(fileServerError, []))).code, "TRANSIENT");
    const indexMissing = servedIndex(base, ["context-notes", "work-tracking"]);
    indexMissing.delete(`${base}index.json`);
    assert.equal((await refusal(["add", "context-notes", "--index", `${base}index.json`, "--dir", bundle], servedFetch(indexMissing, []))).code, "USAGE");
    assert.deepEqual(await snapshot(bundle), before);

    const big: FetchLike = async () => ({ status: 200, body: new Response("x".repeat(64)).body });
    await assert.rejects(fetchHttpsBytes(new URL(`${base}big`), big, 16, 1000), /exceeds 16 bytes/);
    await assert.rejects(fetchHttpsBytes(new URL("http://insecure.test/"), big, 16, 1000), /non-https/);
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await assert.rejects(fetchHttpsBytes(new URL(`${base}slow`), hang, 16, 20), /timed out after 20 ms/);
    const raw: FetchLike = async () => ({ status: 200, body: new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0xff])).body });
    assert.deepEqual([...await fetchHttpsBytes(new URL(`${base}raw`), raw, 16, 1000)], [0xef, 0xbb, 0xbf, 0xff], "the reader never decodes");
  });
});

// ── One decoder for both transports ───────────────────────────────────────────────────────────

/** Publishes one recipe whose files are given as bytes, locally and over the injected https fetch. */
async function publishBoth(root: string, name: string, change: (path: string, bytes: Uint8Array) => Uint8Array) {
  const files = builtinRecipeFiles(name)!.map((file) => ({ path: file.path, bytes: change(file.path, utf8(file.bytes)) }));
  const index = JSON.stringify({
    format: RECIPE_INDEX_FORMAT, source: "both", offerings: [],
    recipes: [{ id: name, version: "1", source_digest: digestOf(name), files_digest: recipeFilesDigest(files), root: `r/${name}`, files: files.map((file) => file.path) }],
  });
  const base = "https://recipes.example.test/both/";
  const served = new Map<string, string | Uint8Array | { status: number }>([[`${base}index.json`, index]]);
  for (const file of files) {
    const target = path.join(root, "both", "r", name, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
    served.set(`${base}r/${name}/${file.path}`, file.bytes);
  }
  await writeFile(path.join(root, "both", "index.json"), index);
  return { local: path.join(root, "both", "index.json"), url: `${base}index.json`, fetch: servedFetch(served, []), files_digest: recipeFilesDigest(files) };
}

test("a leading BOM gives the same files_digest and the same install locally and over https", async () => {
  await withScratch(async (root) => {
    const bom = (file: string, bytes: Uint8Array) => (file === "conventions/context-note.md" ? new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]) : bytes);
    const published = await publishBoth(root, "context-notes", bom);
    assert.notEqual(published.files_digest, pin(builtinRecipeFiles("context-notes")!), "the BOM is pinned as a byte");
    const receipts = [];
    for (const [i, args] of [[published.local], [published.url]].entries()) {
      const bundle = path.join(root, `bundle-${i}`);
      await initBundle(bundle);
      receipts.push(await run(["add", "context-notes", "--index", args[0]!, "--dir", bundle], published.fetch));
    }
    assert.equal(receipts[0]!.source_digest, digestOf("context-notes"));
    assert.equal(receipts[0]!.source_digest, receipts[1]!.source_digest);
    const [one, two] = await Promise.all([0, 1].map((i) => readDoc({ root: path.join(root, `bundle-${i}`) }, "conventions/context-note")));
    assert.deepEqual(definitionContent(one!), definitionContent(two!));
  });
});

test("invalid UTF-8 is refused by both transports, even when its bytes are pinned", async () => {
  await withScratch(async (root) => {
    const published = await publishBoth(root, "context-notes", (file, bytes) => (file === "recipe.md" ? new Uint8Array([...bytes, 0xff]) : bytes));
    for (const location of [published.local, published.url]) {
      const bundle = path.join(root, `bundle-${location.startsWith("https") ? "https" : "local"}`);
      await initBundle(bundle);
      const before = await snapshot(bundle);
      const error = await refusal(["add", "context-notes", "--index", location, "--dir", bundle], published.fetch);
      assert.equal(error.code, "USAGE", location);
      assert.equal(error.details?.reason, "RECIPE_INDEX_ENCODING_INVALID", location);
      assert.deepEqual(await snapshot(bundle), before);
    }
  });
});

test("bytes FF and FE pin differently and fail differently on both transports", async () => {
  await withScratch(async (root) => {
    const ff = await publishBoth(root, "context-notes", (file, bytes) => (file === "recipe.md" ? new Uint8Array([0xff]) : bytes));
    const feFiles = builtinRecipeFiles("context-notes")!.map((file) => ({ path: file.path, bytes: file.path === "recipe.md" ? new Uint8Array([0xfe]) : utf8(file.bytes) }));
    assert.notEqual(ff.files_digest, recipeFilesDigest(feFiles));
    // Swap FF for FE behind the FF pin: both transports see a files_digest mismatch, not the same text.
    await writeFile(path.join(root, "both/r/context-notes/recipe.md"), new Uint8Array([0xfe]));
    const served = new Map<string, string | Uint8Array | { status: number }>([
      ["https://recipes.example.test/both/index.json", await readFile(ff.local, "utf8")],
      ...feFiles.map((file) => [`https://recipes.example.test/both/r/context-notes/${file.path}`, file.bytes] as [string, Uint8Array]),
    ]);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    for (const [location, fetch] of [[ff.local, undefined], [ff.url, servedFetch(served, [])]] as const) {
      const error = await refusal(["add", "context-notes", "--index", location, "--dir", bundle], fetch);
      assert.equal(error.details?.digest, "files_digest", location);
    }
  });
});

// ── Whole-command bounds and URL credentials ──────────────────────────────────────────────────

test("one byte budget spans the index and every file", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes", "work-tracking"]);
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const before = await snapshot(bundle);
    const indexSize = (await readFile(index)).byteLength;
    const local = await refusal(["add", "starter", "--offering", "--index", index, "--dir", bundle], undefined, { totalBytes: indexSize + 200 });
    assert.equal(local.code, "USAGE");
    assert.equal(local.details?.reason, "RECIPE_INDEX_READ_FAILED");
    assert.match(local.message, /exceed the \d+ byte total/);

    const base = "https://recipes.example.test/budget/";
    const remote = await refusal(["add", "starter", "--offering", "--index", `${base}index.json`, "--dir", bundle], servedFetch(servedIndex(base, ["context-notes", "work-tracking"]), []), { totalBytes: 2000 });
    assert.match(remote.message, /exceed the 2000 byte total/);
    assert.deepEqual(await snapshot(bundle), before);
  });
});

test("one deadline spans every read of the command", async () => {
  await withScratch(async (root) => {
    const base = "https://recipes.example.test/slow/";
    const files = servedIndex(base, ["context-notes", "work-tracking"]);
    const inner = servedFetch(files, []);
    // Each read is fast enough for its own cap; together they outlast the command deadline.
    const slow: FetchLike = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return inner(url, init);
    };
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const before = await snapshot(bundle);
    const error = await refusal(["add", "starter", "--offering", "--index", `${base}index.json`, "--dir", bundle], slow, { deadlineMs: 100, requestMs: 1000 });
    assert.equal(error.code, "TRANSIENT");
    assert.match(error.message, /deadline/);
    assert.deepEqual(await snapshot(bundle), before);
  });
});

test("an index URL with credentials is refused before any request and the credentials are never echoed", async () => {
  await withScratch(async (root) => {
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const calls: Array<{ url: string; redirect: string }> = [];
    for (const location of ["https://alice:s3cret@recipes.example.test/index.json", "https://token@recipes.example.test/index.json"]) {
      const error = await refusal(["add", "context-notes", "--index", location, "--dir", bundle], servedFetch(new Map(), calls));
      assert.equal(error.code, "USAGE");
      assert.equal(error.details?.reason, "RECIPE_INDEX_SCHEME_REFUSED");
      const rendered = JSON.stringify({ message: error.message, details: error.details, help: error.help });
      assert.ok(!rendered.includes("s3cret") && !rendered.includes("token") && !rendered.includes("alice"), rendered);
    }
    assert.deepEqual(calls, []);
  });
});

test("a missing local file is the publisher's error, not a retry", async () => {
  await withScratch(async (root) => {
    const index = await writeIndex(root, "alpha", "alpha", (name) => `recipes/${name}`, ["context-notes"], []);
    await rm(path.join(root, "alpha/recipes/context-notes/conventions/context-note.md"));
    const bundle = path.join(root, "bundle");
    await initBundle(bundle);
    const error = await refusal(["add", "context-notes", "--index", index, "--dir", bundle]);
    assert.equal(error.code, "USAGE");
    assert.equal(error.details?.reason, "RECIPE_INDEX_READ_FAILED");
    assert.match(error.message, /no such file/);
  });
});
