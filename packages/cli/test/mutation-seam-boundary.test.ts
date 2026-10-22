/**
 * Mutation-seam boundary: CLI document writes use `mutateDoc` and deletions use `deleteMutatedDoc`
 * in mutate.ts for error translation and true-only post-persist hooks. Core owns body-replace
 * guards for candidate writes. Bypasses must carry an explicit invariant; a new one fails this
 * test until routed through the seam or recorded with its own reason.
 * A text tripwire cannot see an aliased import or an indirect
 * reference to the backend; that is its limit.
 *
 * Recipe install and evolution write conventions through core (`@superbee/core/recipe-lifecycle`),
 * which the CLI calls without `mutateDoc`; the invariants that keep those writes body-safe are
 * pinned against the core sources below.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const CORE_RECIPE_LIFECYCLE = resolve(dirname(fileURLToPath(import.meta.url)), "../../core/src/recipe-lifecycle");

/** The seam itself plus the writers allowed to bypass it, each with the invariant that keeps it safe. */
const DIRECT_MUTATION_WRITERS: Record<string, string> = {
  "mutate.ts": "THE seam — the one place the guards are applied.",
};

function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return typeScriptFiles(path);
      return entry.name.endsWith(".ts") ? [relative(SRC, path).split("\\").join("/")] : [];
    })
    .sort();
}

/**
 * Core's direct document-mutation entry points, including delete, and the raw backend seam that
 * needs no import at all (`backend` is a public field on `Bundle`).
 */
const DIRECT_WRITE_CALL = /\b(mutateDocument|writeDoc|writeDocVersioned|writeDocVersionedForEdition|deleteDoc)\s*\(|\bbackend\.(write|delete)\s*\(/;

test("every CLI document mutation reaches core through the presentation seam, or is a recorded exemption", () => {
  const direct = typeScriptFiles(SRC).filter((file) => DIRECT_WRITE_CALL.test(readFileSync(join(SRC, file), "utf8")));
  assert.deepEqual(
    direct,
    Object.keys(DIRECT_MUTATION_WRITERS).sort(),
    "the set of files mutating documents without the CLI seam changed. Route writes through "
      + "mutateDoc and deletions through deleteMutatedDoc, or add it to DIRECT_MUTATION_WRITERS with the "
      + "invariant that makes the bypass safe.",
  );
  for (const [file, reason] of Object.entries(DIRECT_MUTATION_WRITERS)) {
    assert.ok(reason.trim().length > 0, `${file} needs a reason`);
  }
});

/**
 * Core writers the CLI reaches without `mutateDoc`, each with the invariant that keeps it safe.
 * `install.ts`: recipe installation writes conventions in create-only mode, so there is never a
 * stored body to lose. `evolution.ts`: additiveConventionCandidate keeps body = existing.body and
 * reports any difference as the RECIPE_EVOLUTION_BODY_REPLACEMENT_UNSUPPORTED blocker; the one
 * body-changing branch requires an EMPTY stored body. Relaxing that rule must route the write
 * through the CLI's mutateDoc.
 */
test("the recorded exemptions still hold the invariants they are excused by", () => {
  const install = readFileSync(join(CORE_RECIPE_LIFECYCLE, "install.ts"), "utf8");
  assert.match(install, /mode:\s*"create-only"/, "core recipe installation must write conventions create-only");
  const evolution = readFileSync(join(CORE_RECIPE_LIFECYCLE, "evolution.ts"), "utf8");
  assert.match(
    evolution,
    /RECIPE_EVOLUTION_BODY_REPLACEMENT_UNSUPPORTED/,
    "core recipe evolution must still refuse a body replacement as a plan blocker",
  );
});
