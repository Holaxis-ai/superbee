import test from "node:test";
import assert from "node:assert/strict";
import { BodyReplaceError, guardBodyReplace as coreGuard, type OkfDocument } from "@superbee/core";
import { bodyReplaceCases } from "../../core/test/body-replace-cases.js";
import { bodyReplaceCliError, guardBodyReplace } from "../src/body-replace-guards.js";
import { CliError } from "../src/errors.js";
import { mutateDoc } from "../src/mutate.js";
import { MemoryBackend } from "@superbee/core/memory-backend";
for (const row of bodyReplaceCases) test(`CLI/core agreement: ${row.name}`, () => {
  const existing: OkfDocument = { id: "a", frontmatter: { type: "Note" }, body: row.existing };
  const bundle = { root: "/unused" };
  if (!row.reason) { guardBodyReplace(bundle, existing, row.next); return; }
  let coreError: BodyReplaceError | undefined;
  try { coreGuard(bundle, existing, row.next); } catch (e) { if (!(e instanceof BodyReplaceError)) throw e; coreError = e; }
  assert.ok(coreError);
  assert.equal(coreError.finding.reason, row.reason);
  const projected = bodyReplaceCliError(coreError);
  assert.equal(projected.code, "USAGE");
  assert.match(projected.message, row.reason === "dropped_links" ? /Pass --replace-links/ : /Pass --accept-truncated-body/);
  assert.throws(() => guardBodyReplace(bundle, existing, row.next), (e: unknown) => e instanceof CliError && e.message === projected.message && JSON.stringify(e.details) === JSON.stringify(projected.details));
});
test("CLI mutation forwards explicit loss posture and translates core refusal", async () => {
  const backend = new MemoryBackend(), bundle = { root: "/unused", backend };
  await backend.write("a", { id: "a", frontmatter: { type: "Note" }, body: "[edge](b.md)" });
  const opts = { bundle, id: "a", mode: "patch" as const, registry: { kinds: new Map(), warnings: [] }, strict: false, helpOnKindReject: "kinds", errors: {}, buildCandidate: (existing: OkfDocument | undefined) => ({ frontmatter: existing!.frontmatter, body: "removed deliberately" }) };
  await assert.rejects(() => mutateDoc(opts), (e: unknown) => e instanceof CliError && e.code === "USAGE" && e.message.includes("--replace-links"));
  assert.equal((await mutateDoc({ ...opts, bodyReplace: { replaceLinks: true } })).changed, true);
});
test("a dropped cross-bundle link is named by its okf: target with the --bundle recovery", () => {
  const existing: OkfDocument = { id: "a", frontmatter: { type: "Design" }, body: "[part of](okf://plan/roadmap.md)" };
  assert.throws(() => guardBodyReplace({ root: "/unused" }, existing, "replacement"), (e: unknown) =>
    e instanceof CliError && /'part of' -> okf:\/\/plan\/roadmap/.test(e.message) && /--bundle <alias>/.test(e.message)
      && JSON.stringify(e.details) === JSON.stringify({ dropped_links: [{ to: "roadmap", text: "part of", bundle: "plan" }] }));
});
