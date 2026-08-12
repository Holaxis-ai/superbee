/**
 * TRIPWIRE (plans/rename-page-kind-to-view, Unit 3 — inherited from Unit 2's review): while
 * dual-read exists, the LEGACY prefix spellings are frozen historical facts shared by two
 * deliberately UNCOUPLED owners:
 *
 *   - core's grammar constants (`PAGE_REGISTRY_PREFIX` / `PAGE_ENTRY_PREFIX` in
 *     `core/src/page.ts`) — what dual-read actually accepts, and
 *   - the CLI's legacy-detection primitive (`cli/src/legacy-page.ts`, Unit 2) — which freezes
 *     the same values as literals ON PURPOSE, without importing the live grammar (a LEGACY
 *     constant can never change by definition, so it must not track a live export).
 *
 * That no-import-coupling design is correct, but it means nothing structural stops the two
 * sides from drifting apart silently. This test is the tripwire: it pins BOTH sides to the
 * frozen literal spellings by EQUALITY ASSERTION ONLY. If either side ever changes — core
 * renaming/retiring a legacy prefix, or the legacy primitive "fixing" its literals — this test
 * fails and forces a conscious decision instead of a silent skew between what is detected as
 * legacy and what is still readable as legacy.
 *
 * The legacy-page module ships in Unit 2; until both units are on the same tree, the module
 * check is presence-gated (the core half of the tripwire always runs), so the test is
 * deterministic under either merge order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PAGE_REGISTRY_PREFIX, PAGE_ENTRY_PREFIX } from "@superbee/core/page";

// The frozen historical spellings — literals on purpose, imported from NOTHING.
const FROZEN_LEGACY_REGISTRY_PREFIX = "pages-registry/";
const FROZEN_LEGACY_BLOB_PREFIX = "pages/";

test("tripwire: core's legacy prefixes still equal the frozen historical spellings", () => {
  assert.equal(PAGE_REGISTRY_PREFIX, FROZEN_LEGACY_REGISTRY_PREFIX);
  assert.equal(PAGE_ENTRY_PREFIX, FROZEN_LEGACY_BLOB_PREFIX);
});

test("tripwire: the CLI legacy-detection primitive's frozen constants equal core's legacy prefixes", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const legacyModulePath = path.resolve(here, "../src/legacy-page.ts");
  if (!existsSync(legacyModulePath)) {
    // Unit 2 not merged into this tree yet — the core half above still guards the values.
    return;
  }
  // Specifier via a plain-string variable so tsc does not statically require the module to
  // exist on a tree where Unit 2 has not merged yet.
  const specifier: string = "../src/legacy-page.js";
  const legacy = (await import(specifier)) as {
    LEGACY_PAGE_REGISTRY_PREFIX: string;
    LEGACY_PAGE_BLOB_PREFIX: string;
  };
  assert.equal(legacy.LEGACY_PAGE_REGISTRY_PREFIX, PAGE_REGISTRY_PREFIX);
  assert.equal(legacy.LEGACY_PAGE_BLOB_PREFIX, PAGE_ENTRY_PREFIX);
});
