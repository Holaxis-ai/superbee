// `superbee sync --replace-links <id>` in a hosted checkout: the one explicit way to send an edit
// that removes outbound links. The default stays refusal, the acceptance covers one document in
// one run, and the truncated-preview guard is never relaxed by it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { parseMarkdown } from "@superbee/core";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { BODY_PREVIEW_TRUNCATION_MARKER } from "../src/body-replace-guards.js";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { commitLocal, openLocalBundle } from "@superbee/browser-local";
import { bindingForPath, checkoutStoreDir } from "../src/hosted/binding.js";
import { readProjection, scanCheckout } from "../src/hosted/sync-scan.js";
import { hostedStatus } from "../src/hosted/status.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness { home: string; cwd: string; folder: string; auth: HostedAuthDeps; host: FakeHost; out: string[] }

const LINKED = "Alpha links to [Beta](beta.md) and [Gamma](gamma.md).\n";

/** A checkout whose `notes/alpha` and `notes/delta` each link to two documents. */
async function harness(): Promise<Harness> {
  const host = new FakeHost();
  const home = await mkdtemp(path.join(tmpdir(), "sb-replace-links-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-replace-links-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("the sign-in module must not be reached"); } });
  const alpha = host.docs.get("notes/alpha")!;
  const { superbee_updated_by: _managed, ...frontmatter } = alpha.frontmatter as Record<string, unknown>;
  host.put("notes/alpha", frontmatter, LINKED);
  host.put("notes/delta", { ...frontmatter, title: "Delta" }, LINKED.replace("Alpha", "Delta"));
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  host.writes.length = 0;
  return { home, cwd, folder: path.join(cwd, "team"), auth, host, out: [] };
}

const instant = async () => {};

function syncDeps(h: Harness) {
  return { stdout: (text: string) => void h.out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch, write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant, lockWaitMs: 200 };
}

/** A sync and its receipt, whether it exits 0 or fails with a receipt printed. */
async function runSync(h: Harness, argv: string[] = []): Promise<{ receipt: Record<string, unknown>; error?: CliError }> {
  h.out.length = 0;
  try {
    await sync(["--dir", h.folder, ...argv], syncDeps(h));
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    assert.ok(h.out.length > 0, `sync failed with no receipt: ${error.message}`);
    return { receipt: decode(h.out.at(-1)!.trim()) as Record<string, unknown>, error };
  }
  return { receipt: decode(h.out.at(-1)!.trim()) as Record<string, unknown> };
}

type Row = { id: string; state: string; reason: string; message: string };
const rowFor = (receipt: Record<string, unknown>, id: string): Row | undefined => ((receipt.rows as Row[]) ?? []).find((row) => row.id === id);
const replaces = (h: Harness, id: string) => h.host.writes.filter((call) => call.route === "replace" && call.body.documentId === id);

async function setBody(h: Harness, id: string, body: string): Promise<void> {
  const file = path.join(h.folder, `${id}.md`);
  const parsed = parseMarkdown(await readFile(file, "utf8"), id);
  const yaml = Object.entries(parsed.frontmatter as Record<string, unknown>).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(file, `---\n${yaml}\n---\n${body}`);
}

test("a body that drops a link is held with the override named, and nothing is sent; naming another document does not admit it", async () => {
  const h = await harness();
  await setBody(h, "notes/alpha", "Alpha links to [Beta](beta.md) only.\n");

  const plain = await runSync(h);
  assert.ok(plain.error, "a held row fails the run");
  const row = rowFor(plain.receipt, "notes/alpha")!;
  assert.deepEqual([row.state, row.reason], ["held", "dropped_links"]);
  assert.match(row.message, /notes\/gamma/);
  assert.match(row.message, /--replace-links notes\/alpha/);
  assert.ok((plain.receipt.help as string[]).some((line) => line.includes("--replace-links notes/alpha")), "the receipt's help names the override for this document");
  assert.equal(replaces(h, "notes/alpha").length, 0);

  const other = await runSync(h, ["--replace-links", "notes/delta"]);
  assert.deepEqual([rowFor(other.receipt, "notes/alpha")?.state, rowFor(other.receipt, "notes/alpha")?.reason], ["held", "dropped_links"]);
  assert.deepEqual(other.receipt.replace_links, { doc: "notes/delta", applied: false });
  assert.equal(replaces(h, "notes/alpha").length, 0);
  assert.equal(h.host.docs.get("notes/alpha")!.body, LINKED, "the host keeps the linked body");
});

test("--replace-links <id> sends that document's drop exactly once; the next drop in the same or another document is held again", async () => {
  const h = await harness();
  await setBody(h, "notes/alpha", "Alpha links to [Beta](beta.md) only.\n");
  await setBody(h, "notes/delta", "Delta links to nothing now.\n");

  // A file path names the same document.
  const base = h.host.docs.get("notes/alpha")!.version;
  const accepted = await runSync(h, ["--replace-links", "notes/alpha.md"]);
  assert.deepEqual(accepted.receipt.replace_links, { doc: "notes/alpha", applied: true });
  assert.equal(rowFor(accepted.receipt, "notes/alpha")?.state, "committed");
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Alpha links to [Beta](beta.md) only.\n");
  assert.equal(replaces(h, "notes/alpha").length, 1);
  // The host admits a checkout's whole-document link removal on its own; the wire request is the
  // plain replace against the version the scan judged, with no posture field for it to refuse.
  const [sent] = replaces(h, "notes/alpha");
  assert.deepEqual(Object.keys(sent!.body).sort(), ["body", "bundleId", "documentId", "expectedVersion", "frontmatter"]);
  assert.equal(sent!.body.expectedVersion, base);
  // The same run never extends the acceptance to a document it did not name.
  assert.deepEqual([rowFor(accepted.receipt, "notes/delta")?.state, rowFor(accepted.receipt, "notes/delta")?.reason], ["held", "dropped_links"]);
  assert.equal(replaces(h, "notes/delta").length, 0);

  // Nothing is resent: the accepted write was delivered once.
  await setBody(h, "notes/delta", LINKED.replace("Alpha", "Delta"));
  const quiet = await runSync(h);
  assert.equal(quiet.error, undefined);
  assert.equal(replaces(h, "notes/alpha").length, 1);

  // A later edit of the accepted document that drops its remaining link is refused again.
  await setBody(h, "notes/alpha", "Alpha links to nothing.\n");
  const later = await runSync(h);
  assert.deepEqual([rowFor(later.receipt, "notes/alpha")?.state, rowFor(later.receipt, "notes/alpha")?.reason], ["held", "dropped_links"]);
  assert.match(rowFor(later.receipt, "notes/alpha")!.message, /notes\/beta/);
  assert.equal(replaces(h, "notes/alpha").length, 1);
  assert.equal(h.host.docs.get("notes/alpha")!.body, "Alpha links to [Beta](beta.md) only.\n");
});

test("an edit that keeps every link needs no override, and --replace-links on an unedited document applies nothing", async () => {
  const h = await harness();
  await setBody(h, "notes/alpha", `${LINKED}More text.\n`);
  const { receipt, error } = await runSync(h, ["--replace-links", "notes/delta"]);
  assert.equal(error, undefined);
  assert.equal(rowFor(receipt, "notes/alpha")?.state, "committed");
  assert.deepEqual(receipt.replace_links, { doc: "notes/delta", applied: false });
  assert.equal(replaces(h, "notes/delta").length, 0);
});

test("--replace-links never admits a truncated-preview body, with or without a dropped link", async () => {
  const h = await harness();
  const notice = `${BODY_PREVIEW_TRUNCATION_MARKER} 900 more character(s) are NOT shown`;
  await setBody(h, "notes/alpha", `Alpha links to [Beta](beta.md) only.\n\n${notice}\n`);
  await setBody(h, "notes/delta", `${LINKED.replace("Alpha", "Delta")}\n${notice}\n`);
  const { receipt, error } = await runSync(h, ["--replace-links", "notes/alpha"]);
  assert.ok(error);
  for (const id of ["notes/alpha", "notes/delta"]) {
    const row = rowFor(receipt, id)!;
    assert.deepEqual([row.state, row.reason], ["held", "not_sendable"], id);
    assert.match(row.message, /preview_marker/, id);
  }
  assert.deepEqual(receipt.replace_links, { doc: "notes/alpha", applied: false });
  assert.equal(h.host.writes.length, 0);
});

test("--replace-links goes with a plain sync only, names one valid document id, and is hosted-only", async () => {
  const h = await harness();
  for (const extra of [["--inspect", "--doc", "notes/alpha"], ["--resolve", "keep", "--doc", "notes/alpha"], ["--restore-deletes"], ["--take-host-deletions", "1:0123456789ab"], ["--accept-deletes", "blobs:1:0123456789ab"]]) {
    await assert.rejects(sync(["--dir", h.folder, "--replace-links", "notes/alpha", ...extra], syncDeps(h)), (error: unknown) => error instanceof CliError && error.code === "USAGE", extra.join(" "));
  }
  await assert.rejects(sync(["--dir", h.folder, "--replace-links", "../outside"], syncDeps(h)), (error: unknown) => error instanceof CliError && error.code === "USAGE");
  assert.equal(h.host.writes.length, 0);

  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "sb-replace-links-plain-")));
  await assert.rejects(
    sync(["--dir", plain, "--replace-links", "notes/alpha"], { stdout: () => {}, auth: h.auth, cwd: plain }),
    (error: unknown) => error instanceof CliError && /replace-links/.test(error.message) && /hosted checkout/.test(error.message),
  );
});

test("status shows a link-dropping edit as held, not as an unsent change", async () => {
  const h = await harness();
  await setBody(h, "notes/alpha", "Alpha links to [Beta](beta.md) only.\n");
  await setBody(h, "notes/delta", `${LINKED.replace("Alpha", "Delta")}More.\n`);
  const { sync: state } = await hostedStatus((await bindingForPath(h.home, h.folder))!, h.home);
  assert.equal(state.state, "needs_decision");
  assert.deepEqual(state.held_rows, [{ id: "notes/alpha", reason: "dropped_links" }]);
  assert.equal(h.host.writes.length, 0);
});

test("--resolve keep after --inspect sends a file that lacks a link the host added", async () => {
  const h = await harness();
  const current = h.host.docs.get("notes/alpha")!;
  const { superbee_updated_by: _managed, ...frontmatter } = current.frontmatter as Record<string, unknown>;
  const remote = h.host.put("notes/alpha", frontmatter, `${LINKED}See also [Epsilon](epsilon.md).\n`);
  await setBody(h, "notes/alpha", `${LINKED}Local text.\n`);
  const conflicted = await runSync(h);
  assert.equal(rowFor(conflicted.receipt, "notes/alpha")?.state, "conflict");
  await runSync(h, ["--inspect", "notes/alpha"]);
  await runSync(h, ["--resolve", "keep", "--doc", "notes/alpha"]);
  const after = await runSync(h);
  assert.equal(after.error, undefined);
  assert.equal(rowFor(after.receipt, "notes/alpha")?.state, "committed");
  assert.equal(h.host.docs.get("notes/alpha")!.body, `${LINKED}Local text.\n`);
  assert.equal(replaces(h, "notes/alpha").at(-1)!.body.expectedVersion, remote);
});

test("an acceptance is pinned to the version it judged: a store that moves mid-write journals nothing for the removal", async () => {
  const h = await harness();
  await setBody(h, "notes/alpha", "Alpha links to [Beta](beta.md) only.\n");
  const binding = (await bindingForPath(h.home, h.folder))!;
  const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(h.home, binding.checkout_id) });
  try {
    const projection = await readProjection(h.home, binding.checkout_id, store);
    const real = openLocalBundle(binding.checkout_id, { backend: store });
    let moved = false;
    // The scan's read of the stored document returns, and only then another writer moves the head.
    const racing = new Proxy(store, {
      get(inner, key) {
        if (key === "readWithJournal") {
          return async (id: string, options?: { meta?: readonly string[] }) => {
            const result = await inner.readWithJournal(id, options);
            if (id === "notes/alpha" && !moved) {
              moved = true;
              await commitLocal(real, "notes/alpha", { mode: "replace-document", onAbsent: "fail", buildCandidate: () => ({ frontmatter: result.document!.doc.frontmatter, body: `${LINKED}Moved.\n` }) });
            }
            return result;
          };
        }
        const value = Reflect.get(inner, key, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
    const report = await scanCheckout({ folder: h.folder, bundleId: binding.bundle_id, okfVersion: undefined, local: openLocalBundle(binding.checkout_id, { backend: racing as FileJournaledBackend }), projection, replaceLinks: "notes/alpha" });
    assert.ok(moved, "the race ran");
    assert.deepEqual(report.held.map((row) => [row.id, row.reason]), [["notes/alpha", "dropped_links"]]);
    assert.equal(report.replaceLinksApplied, undefined);
    assert.ok(!report.committed.includes("notes/alpha"));
    const stored = await store.readWithJournal("notes/alpha");
    assert.equal(stored.document!.doc.body, `${LINKED}Moved.\n`, "the store holds the other writer's version, never the removal");
    assert.ok(stored.intents.every((row) => !String(row.content ?? "").includes("only.")), "no intent carries the link removal");
  } finally {
    await store.close();
  }
});
