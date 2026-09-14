/**
 * `bundle-name.ts` — THE bundle display-name derivation (tasks/bundle-display-name).
 *
 * Pins the chain ORDER (explicit marker doc beats parent-of-conventional-dir beats root
 * basename), the two-projects field-report scenario (two bundles both rooted at
 * `.agentstate-lite/` under different parents get DIFFERENT names), the plain `doc write
 * --type "Bundle Name" --title` set path, the SILENT-APPROPRIATION guard (PR #67 review: an
 * ordinary pre-existing `docs/bundle` doc of any other type must NEVER rename the project), and
 * the total degrade property: an absent, malformed, unmarked, or non-string-valued well-known
 * doc — and a backend whose `read` throws outright — all fall silently down the chain, never
 * throwing and never touching anything beyond the one known-id read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, type Bundle, type StorageBackend } from "@superbee/core";
import { deriveBundleDisplayName, BUNDLE_NAME_DOC_ID, BUNDLE_NAME_DOC_TYPE } from "../src/bundle-name.js";
import { CONVENTIONAL_BUNDLE_DIR_NAME } from "../src/bundle.js";

async function makeTmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-bundle-name-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A conventional project bundle: `<tmp>/<project>/.agentstate-lite/` with an `index.md`. */
async function makeConventionalBundle(tmp: string, project: string): Promise<string> {
  const root = path.join(tmp, project, CONVENTIONAL_BUNDLE_DIR_NAME);
  await mkdir(root, { recursive: true });
  await initBundle(root);
  return root;
}

test("chain rung (b): a conventional-dir root displays as its PARENT — two projects get DIFFERENT names", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const rootA = await makeConventionalBundle(dir, "project-a");
    const rootB = await makeConventionalBundle(dir, "project-b");
    const a = await deriveBundleDisplayName({ root: rootA });
    const b = await deriveBundleDisplayName({ root: rootB });
    assert.deepEqual(a, { name: "project-a", source: "conventional-parent" });
    assert.deepEqual(b, { name: "project-b", source: "conventional-parent" });
    assert.notEqual(a.name, b.name); // the field report's exact failure: both used to be ".agentstate-lite"
  } finally {
    await cleanup();
  }
});

test("chain rung (c): a standalone (non-conventional) bundle keeps its root basename", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const root = path.join(dir, "my-standalone-bundle");
    await mkdir(root, { recursive: true });
    await initBundle(root);
    assert.deepEqual(await deriveBundleDisplayName({ root }), {
      name: "my-standalone-bundle",
      source: "root-basename",
    });
  } finally {
    await cleanup();
  }
});

test("chain rung (a): a marker-typed doc's explicit `name` field beats its title and the parent name", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const root = await makeConventionalBundle(dir, "project-a");
    await writeDoc(
      { root },
      {
        id: BUNDLE_NAME_DOC_ID,
        frontmatter: { type: BUNDLE_NAME_DOC_TYPE, name: "Holaxis CE", title: "About this workspace" },
        body: "",
      },
    );
    assert.deepEqual(await deriveBundleDisplayName({ root }), { name: "Holaxis CE", source: "explicit" });
  } finally {
    await cleanup();
  }
});

test("chain rung (a): under the marker type, `title` is the plain-CLI-settable carrier", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const root = await makeConventionalBundle(dir, "project-a");
    // The exact shape `doc write docs/bundle --type "Bundle Name" --title <name>` persists.
    await writeDoc({ root }, { id: BUNDLE_NAME_DOC_ID, frontmatter: { type: BUNDLE_NAME_DOC_TYPE, title: "holaxis-ce" }, body: "" });
    assert.deepEqual(await deriveBundleDisplayName({ root }), { name: "holaxis-ce", source: "explicit" });
  } finally {
    await cleanup();
  }
});

test("SILENT-APPROPRIATION guard: an ORDINARY docs/bundle doc (type Doc, with a title) is IGNORED — parent name wins, NOT the title", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const root = await makeConventionalBundle(dir, "project-a");
    // The PR #67 reproduction: a pre-existing ordinary doc that happens to live at the
    // well-known id. Without the type gate, its title silently renamed the whole project.
    await writeDoc(
      { root },
      { id: BUNDLE_NAME_DOC_ID, frontmatter: { type: "Doc", title: "Bundle Storage Reference" }, body: "notes" },
    );
    assert.deepEqual(await deriveBundleDisplayName({ root }), { name: "project-a", source: "conventional-parent" });
  } finally {
    await cleanup();
  }
});

test("chain order pinned end to end: marker doc beats parent beats basename", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const root = await makeConventionalBundle(dir, "parent-name");
    // basename rung would say ".agentstate-lite"; parent rung says "parent-name"…
    assert.equal((await deriveBundleDisplayName({ root })).name, "parent-name");
    // …and the marker-typed doc beats both.
    await writeDoc({ root }, { id: BUNDLE_NAME_DOC_ID, frontmatter: { type: BUNDLE_NAME_DOC_TYPE, name: "explicit-name" }, body: "" });
    assert.equal((await deriveBundleDisplayName({ root })).name, "explicit-name");
  } finally {
    await cleanup();
  }
});

test("degrade: a marker-typed doc with whitespace-only/non-string name and title falls through to the path chain", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const root = await makeConventionalBundle(dir, "project-a");
    await writeDoc({ root }, { id: BUNDLE_NAME_DOC_ID, frontmatter: { type: BUNDLE_NAME_DOC_TYPE, name: "   ", title: 42 }, body: "" });
    assert.deepEqual(await deriveBundleDisplayName({ root }), { name: "project-a", source: "conventional-parent" });
  } finally {
    await cleanup();
  }
});

test("degrade: a MALFORMED well-known doc (no frontmatter) never throws — falls to the parent name", async () => {
  const { dir, cleanup } = await makeTmp();
  try {
    const root = await makeConventionalBundle(dir, "project-a");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "bundle.md"), "no frontmatter here at all\n", "utf8");
    assert.deepEqual(await deriveBundleDisplayName({ root }), { name: "project-a", source: "conventional-parent" });
  } finally {
    await cleanup();
  }
});

test("no-throw / no-I/O-beyond-the-one-read property: a backend whose read throws still resolves, with ONLY the known id ever requested", async () => {
  const reads: string[] = [];
  const backend = {
    read: (id: string) => {
      reads.push(id);
      return Promise.reject(new Error("backend down"));
    },
  } as unknown as StorageBackend;
  const bundle: Bundle = { root: `/somewhere/proj/${CONVENTIONAL_BUNDLE_DIR_NAME}`, backend };
  assert.deepEqual(await deriveBundleDisplayName(bundle), { name: "proj", source: "conventional-parent" });
  assert.deepEqual(reads, [BUNDLE_NAME_DOC_ID]); // exactly one read, of exactly the well-known id
});

test("edge: a conventional dir directly under the filesystem root falls back to the basename; an empty basename falls back to 'bundle'", async () => {
  const throwing = { read: () => Promise.reject(new Error("absent")) } as unknown as StorageBackend;
  assert.deepEqual(
    await deriveBundleDisplayName({ root: `${path.sep}${CONVENTIONAL_BUNDLE_DIR_NAME}`, backend: throwing }),
    { name: CONVENTIONAL_BUNDLE_DIR_NAME, source: "root-basename" },
  );
  assert.deepEqual(await deriveBundleDisplayName({ root: path.sep, backend: throwing }), {
    name: "bundle",
    source: "root-basename",
  });
});
