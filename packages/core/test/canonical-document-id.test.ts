/**
 * `nonCanonicalDocumentId`: the one spelling a new document id may take, and why an id is outside
 * it. The cases are the host's own (superbee-hosted `test/canonical-document-ids.test.ts`) and the
 * CLI publish preview's refusals.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { nonCanonicalDocumentId } from "../src/paths.js";
import { nonCanonicalDocumentId as fromStorage } from "../src/storage.js";
import { nonCanonicalDocumentId as fromRoot } from "../src/index.js";
import { assertCanonicalNewDocumentId } from "../src/paths.js";
import { FilesystemIdentityAliasError, NonCanonicalDocumentIdError } from "../src/errors.js";
import { deleteDoc, readDoc, writeDocVersionedGuarded } from "../src/engine.js";
import { mutateDocument, type MutateDocumentOptions } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import type { KindRegistry } from "../src/kinds.js";
import type { Bundle } from "../src/types.js";

test("canonical id: one definition behind the storage and root exports", () => {
  assert.equal(fromStorage, nonCanonicalDocumentId);
  assert.equal(fromRoot, nonCanonicalDocumentId);
});

test("canonical id: whitespace at any segment edge and non-NFC ids are refused; interior spaces are not", () => {
  const whitespace = [
    " notes/space",
    "notes/space ",
    "notes /x",
    "notes/ x",
    "\tnotes/tab",
    "notes/nbsp\u{a0}",
    "\u{3000}notes/ideographic",
    "notes/\u{2003}em",
    "notes/bom\u{feff}",
    "\u{2028}notes/line-separator",
    "notes/nnbsp\u{202f}",
  ];
  for (const id of whitespace) assert.equal(nonCanonicalDocumentId(id), "segment_whitespace", JSON.stringify(id));
  const nfd = ["notes/cafe\u{301}", "notes/A\u{30a}", "notes/가", "notes/Å", "notes/Ω"];
  for (const id of nfd) assert.equal(nonCanonicalDocumentId(id), "not_nfc", JSON.stringify(id));
  for (const id of ["notes/one", "notes/two words", "notes/café", "notes/가", "Notes/One", "notes/ｎｏｔｅ", "notes/İstanbul", "notes/ıd"]) {
    assert.equal(nonCanonicalDocumentId(id), null, JSON.stringify(id));
  }
});

test("canonical id: format characters are refused at a segment edge and inside a segment, except a joiner between visible characters", () => {
  const edges = [
    "\u{200b}notes/one",
    "notes/one\u{200b}",
    "notes\u{200b}/one",
    "notes/\u{200b}one",
    "notes/one\u{2060}",
    "notes/\u{ad}one",
    "notes/one\u{200e}",
    "\u{202e}notes/one",
    "notes/\u{200d}one",
    "notes/one\u{200c}",
    "notes/one\u{e0067}",
    "notes/\u{1d173}one",
    "notes/\u{200b}",
    "notes/one\u{200b}\u{200b}",
  ];
  for (const id of edges) assert.equal(nonCanonicalDocumentId(id), "format_character", JSON.stringify(id));
  const inside = ["notes/on\u{200b}e", "notes/o\u{2060}ne", "notes/o\u{ad}ne", "notes/a\u{202e}cod.exe", "notes/a\u{2066}b\u{2069}c", "notes/o\u{e0067}ne", "notes/o\u{180e}ne"];
  for (const id of inside) assert.equal(nonCanonicalDocumentId(id), "format_character", JSON.stringify(id));
  // U+FEFF is a trimmed space as well as Cf; the whitespace rule names it first.
  assert.equal(nonCanonicalDocumentId("notes/one\u{feff}"), "segment_whitespace");
  for (const id of [
    "notes/می\u{200c}خواهم",
    "notes/क\u{94d}\u{200d}ष",
    "notes/\u{1f469}\u{200d}\u{1f4bb} work",
    "notes/❤\u{fe0f}",
    "notes/one",
  ]) {
    assert.equal(nonCanonicalDocumentId(id), null, JSON.stringify(id));
  }
});

test("canonical id: the publish preview's refused spellings and its accepted joiner", () => {
  assert.deepEqual(
    ["notes/zero\u{200b}width", "notes/\u{200b}edge", "notes/edge\u{2060}", "notes/a\u{202e}b", "notes/nai\u{308}ve"].map(nonCanonicalDocumentId),
    ["format_character", "format_character", "format_character", "format_character", "not_nfc"],
  );
  assert.equal(nonCanonicalDocumentId("notes/\u{1f469}\u{200d}\u{1f4bb}"), null);
});

// mutateDocument decides every policy create, so its one check refuses a non-canonical NEW id in
// every mutation mode and edition, while existing ids stay writable.
const CREATE_EMPTY = { kinds: new Map(), warnings: [] } as KindRegistry;
const note = (body: string) => ({ frontmatter: { type: "Note" }, body });

for (const edition of ["0.1", "0.2"] as const) {
  test(`canonical id: every create mode refuses a non-canonical new id (OKF ${edition})`, async () => {
    const backend = new MemoryBackend();
    await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n# Bundle\n`);
    const bundle: Bundle = { root: "/unused", backend };
    const bad = "notes/zero\u{200b}width";
    const modes: Array<Partial<MutateDocumentOptions>> = [
      { mode: "create-only" },
      { mode: "overwrite" },
      { mode: "patch", onAbsent: "create" },
      { mode: "replace-document", onAbsent: "create" },
    ];
    for (const mode of modes) {
      await assert.rejects(
        () => mutateDocument({ bundle, id: bad, registry: CREATE_EMPTY, strict: false, buildCandidate: () => note("x"), ...mode } as MutateDocumentOptions),
        (error: unknown) => error instanceof NonCanonicalDocumentIdError && error.why === "format_character"
          && error.suggestedId === "notes/zerowidth" && error.reason === "document_id_not_canonical"
          && error.message.includes("'notes/zero\\u200bwidth'"),
        JSON.stringify(mode),
      );
    }
    assert.deepEqual(await backend.list(), []);
    // The guarded whole-document write is the wire router's storage seam: it carries documents that
    // already exist elsewhere (a legacy id pushed to a fresh remote), so it applies no create rule.
    await writeDocVersionedGuarded(backend, { id: "notes/nai\u{308}ve", ...note("x") });
    assert.deepEqual(await backend.list(), ["notes/nai\u{308}ve"]);
  });
}

test("canonical id: an existing non-canonical id stays readable, writable and deletable", async () => {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "/unused", backend };
  const bad = "notes/edge ";
  await backend.write(bad, { id: bad, ...note("old") }); // predates the rule
  for (const mode of ["overwrite", "patch", "replace-document"] as const) {
    const result = await mutateDocument({ bundle, id: bad, mode, registry: CREATE_EMPTY, strict: false, buildCandidate: () => note(`by ${mode}`) });
    assert.equal(result.changed, true, mode);
  }
  await writeDocVersionedGuarded(backend, { id: bad, ...note("guarded") });
  assert.equal((await readDoc(backend, bad)).body.trim(), "guarded");
  assert.equal(await deleteDoc(backend, bad), true);
});

test("canonical id: the suggestion is canonical and safe, or absent", () => {
  const suggest = (id: string) => { try { assertCanonicalNewDocumentId(id); return "accepted"; } catch (error) { return (error as NonCanonicalDocumentIdError).suggestedId; } };
  assert.equal(suggest("notes/plain"), "accepted");
  assert.equal(suggest(" notes/ a \u{200b}"), "notes/a");
  assert.equal(suggest("notes/\u{200d}x"), "notes/x");
  assert.equal(suggest("notes/\u{200b}"), undefined);
  assert.equal(suggest("notes/\u{200b}index"), undefined);
  assert.equal(suggest("notes/nai\u{308}ve"), "notes/na\u{ef}ve");
});

test("canonical id: a suggestion that names an existing document is not offered as the fix", async () => {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "/unused", backend };
  await backend.write("notes/zerowidth", { id: "notes/zerowidth", ...note("taken") });
  await assert.rejects(
    () => mutateDocument({ bundle, id: "notes/zero\u{200b}width", mode: "overwrite", registry: CREATE_EMPTY, strict: false, buildCandidate: () => note("x") }),
    (error: unknown) => error instanceof NonCanonicalDocumentIdError && error.suggestedId === undefined
      && error.existingId === "notes/zerowidth" && /'notes\/zerowidth' already exists/.test(error.message) && !/ Use '/.test(error.message),
  );
  assert.equal((await readDoc(backend, "notes/zerowidth")).body.trim(), "taken");
});

test("canonical id: a suggestion that is itself an alias of an existing entry is not offered", async () => {
  // A legacy NFD folder `café/` on a host that equates NFD and NFC: the NFC suggestion
  // `café/new` reaches that folder under another spelling, so it can never be created either.
  class AliasingSuggestion extends MemoryBackend {
    override async exists(id: string): Promise<boolean> {
      if (id === "caf\u{e9}/new") throw new FilesystemIdentityAliasError("caf\u{e9}/new.md", "caf\u{e9}", "cafe\u{301}", "folder", 0);
      return super.exists(id);
    }
  }
  const backend = new AliasingSuggestion();
  const bundle: Bundle = { root: "/unused", backend };
  await assert.rejects(
    () => mutateDocument({ bundle, id: "cafe\u{301}/new", mode: "overwrite", registry: CREATE_EMPTY, strict: false, buildCandidate: () => note("x") }),
    (error: unknown) => error instanceof NonCanonicalDocumentIdError && error.why === "not_nfc"
      && error.suggestedId === undefined && error.existingId === undefined
      && / Choose a different id\.$/.test(error.message) && !/ Use '/.test(error.message),
  );
  assert.deepEqual(await backend.list(), []);
});
