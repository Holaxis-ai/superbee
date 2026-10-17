/**
 * Mutation-seam boundary: the body-replace guards (body-replace-guards.ts) are enforced by
 * `mutateDoc` (mutate.ts), so a CLI writer that reaches core's document store directly — through
 * `mutateDocument`, or through the unconditional `writeDoc` family that the versioned-edit
 * migration retired — bypasses them. Every such bypass must be listed here with the reason it cannot
 * lose a body byte; a new one fails this test until it is either routed through `mutateDoc` or
 * recorded with its own reason. Same shape as the quoting checker's UNSCANNABLE map: explicit, one
 * reason per entry, growth fails. A text tripwire cannot see an aliased import or an indirect
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

/**
 * Core writers the CLI reaches without `mutateDoc`, each with the invariant that keeps it safe.
 * `install.ts`: recipe installation writes conventions in create-only mode, so there is never a
 * stored body to lose. `evolution.ts`: additiveConventionCandidate keeps body = existing.body and
 * reports any difference as the RECIPE_EVOLUTION_BODY_REPLACEMENT_UNSUPPORTED blocker; the one
 * body-changing branch requires an EMPTY stored body. Relaxing that rule must route the write
 * through the CLI's mutateDoc.
 */

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
 * Core's direct document-write entry points — the mutation service, the unconditional writers, and
 * the raw backend seam that needs no import at all (`backend` is a public field on `Bundle`).
 */
const DIRECT_WRITE_CALL = /\b(mutateDocument|writeDoc|writeDocVersioned|writeDocVersionedForEdition)\s*\(|\bbackend\.write\s*\(/;

test("every CLI writer reaches core's document store through mutateDoc, or is a recorded body-preserving exemption", () => {
  const direct = typeScriptFiles(SRC).filter((file) => DIRECT_WRITE_CALL.test(readFileSync(join(SRC, file), "utf8")));
  assert.deepEqual(
    direct,
    Object.keys(DIRECT_MUTATION_WRITERS).sort(),
    "the set of files writing documents without mutateDoc changed. Route the new writer through "
      + "mutateDoc so the body-replace guards apply, or add it to DIRECT_MUTATION_WRITERS with the "
      + "invariant that makes the bypass safe.",
  );
  for (const [file, reason] of Object.entries(DIRECT_MUTATION_WRITERS)) {
    assert.ok(reason.trim().length > 0, `${file} needs a reason`);
  }
});

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
