// One document the client cannot store never stops a hosted checkout or sync: it is held with a row
// naming its limit code, the rest of the bundle proceeds, and the next sync places it once the
// host's copy is repaired.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkout } from "../src/commands/checkout.js";
import { sync } from "../src/commands/sync.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath } from "../src/hosted/binding.js";
import { hostedPull } from "../src/hosted/sync.js";
import { BUNDLE, FakeHost, HOST, TOKEN } from "./support/fake-hosted-sync.js";

const nested = (depth: number): unknown => {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
};

/** Each frontmatter the client refuses, with the code its row must carry. */
const LIMITS = [
  { name: "size", code: "FRONTMATTER_TOO_LARGE", frontmatter: { type: "Note", title: "Big", blob: "x".repeat(300 * 1024) } },
  { name: "depth", code: "FRONTMATTER_TOO_DEEP", frontmatter: { type: "Note", title: "Deep", nest: nested(40) } },
  { name: "depth past the serializer's stack", code: "FRONTMATTER_TOO_DEEP", frontmatter: { type: "Note", title: "Deep", nest: nested(5_000) } },
] as const;

interface Run {
  out: Record<string, any>;
  err?: CliError;
}

interface Harness {
  host: FakeHost;
  home: string;
  folder: string;
  auth: HostedAuthDeps;
  cwd: string;
  checkout(): Promise<Run>;
  sync(...argv: string[]): Promise<Run>;
  edit(id: string, body: string): Promise<void>;
  file(id: string): string;
}

async function harness(host = new FakeHost()): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-unstorable-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-unstorable-cwd-")));
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  const folder = path.join(cwd, "team");
  const instant = async () => {};
  const capture = async (run: (stdout: (text: string) => void) => Promise<void>): Promise<Run> => {
    const out: string[] = [];
    let err: CliError | undefined;
    try {
      await run((text) => void out.push(text));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      err = error;
    }
    const text = out.at(-1);
    return { out: text === undefined ? {} : (JSON.parse(text) as Record<string, any>), ...(err ? { err } : {}) };
  };
  const file = (id: string) => path.join(folder, `${id}.md`);
  return {
    host, home, folder, auth, cwd, file,
    checkout: () => capture((stdout) => checkout([BUNDLE, "--host", HOST, "--dir", "team", "--json"], { stdout, auth, cwd, fetch: host.fetch })),
    sync: (...argv) => capture((stdout) => sync(["--dir", folder, "--json", ...argv], { stdout, auth, cwd, fetch: host.fetch, write: { sleep: instant, lookupDelayMs: 0 }, sleep: instant } as never)),
    edit: async (id, body) => {
      const raw = await readFile(file(id), "utf8");
      await writeFile(file(id), `${raw.slice(0, raw.indexOf("\n---\n") + 5)}${body}`);
    },
  };
}

function heldRow(run: Run, id: string): Record<string, any> {
  const row = (run.out.rows as Record<string, any>[]).find((candidate) => candidate.id === id);
  assert.ok(row, `the receipt names '${id}'`);
  return row;
}

for (const limit of LIMITS) {
  test(`checkout (${limit.name}): the folder is created, the others placed, the document named, exit 5`, async () => {
    const h = await harness();
    h.host.putUnchecked("notes/big", limit.frontmatter, "big body\n");
    const run = await h.checkout();
    assert.equal(run.err?.exitCode, 5);
    assert.equal(run.err?.handled, true, "the receipt is the output; no second envelope");
    assert.equal(run.out.checkout, "created");
    assert.equal(run.out.status, "incomplete");
    assert.equal(run.out.counts.held, 1);
    const row = heldRow(run, "notes/big");
    assert.equal(row.state, "held");
    assert.equal(row.reason, limit.code);
    assert.match(row.message, /repaired where it is stored/);
    assert.equal(run.out.heads_digest, null);
    assert.match(run.out.help[0], /FRONTMATTER_ rows/);
    assert.equal(existsSync(h.file("notes/big")), false);
    assert.equal(existsSync(h.file("notes/alpha")), true);
    assert.equal((await bindingForPath(h.home, h.folder))?.state, "ready");

    // The checkout is usable, and the repair lands with no extra command.
    h.host.put("notes/big", { type: "Note", title: "Fixed" }, "fixed\n");
    const repaired = await h.sync();
    assert.equal(repaired.err, undefined, repaired.err?.message);
    assert.equal(repaired.out.status, "up_to_date");
    assert.match(await readFile(h.file("notes/big"), "utf8"), /fixed/);
  });

  test(`sync (${limit.name}): the edit is sent, the document named, repeats change nothing, repair places it`, async () => {
    const h = await harness();
    assert.equal((await h.checkout()).err, undefined);
    await h.edit("notes/alpha", "alpha edited by me\n");
    h.host.putUnchecked("notes/big", limit.frontmatter, "big body\n");
    const documents = h.host.docs.size;
    h.host.writes.length = 0;

    const first = await h.sync();
    assert.equal(first.err?.exitCode, 5);
    assert.equal(first.out.status, "incomplete", "a run that held a document is not a clean sync");
    assert.equal(heldRow(first, "notes/big").reason, limit.code);
    assert.equal(heldRow(first, "notes/alpha").state, "committed");
    assert.match(h.host.docs.get("notes/alpha")!.body, /alpha edited by me/);
    assert.equal(h.host.writes.length, 1, "only the edit is sent: no create and no delete of the held document");
    assert.equal(h.host.docs.size, documents);
    assert.equal(existsSync(h.file("notes/big")), false);
    assert.equal(first.out.help.some((line: string) => /edit or restore/.test(line)), false, "no edit in the folder repairs it");
    assert.equal(first.out.help.some((line: string) => /FRONTMATTER_ rows/.test(line)), true);

    const again = await h.sync();
    assert.equal(again.err?.exitCode, 5);
    assert.equal(heldRow(again, "notes/big").reason, limit.code, "still held, still named");
    assert.equal(again.out.counts.committed, 0);
    assert.equal(again.out.pulled.refreshed, 0);
    assert.equal(h.host.writes.length, 1, "no write repeats");

    h.host.put("notes/big", { type: "Note", title: "Fixed" }, "fixed\n");
    const repaired = await h.sync();
    assert.equal(repaired.err, undefined, repaired.err?.message);
    assert.equal(repaired.out.pulled.refreshed, 1);
    assert.equal(repaired.out.status, "up_to_date");
    assert.match(await readFile(h.file("notes/big"), "utf8"), /fixed/);
    assert.equal(h.host.writes.length, 1);
  });

  test(`a placed document updated to ${limit.name} over the limit: the old file stays, an edit never overwrites the host`, async () => {
    const h = await harness();
    assert.equal((await h.checkout()).err, undefined);
    const placed = await readFile(h.file("notes/alpha"), "utf8");
    const version = h.host.putUnchecked("notes/alpha", limit.frontmatter, "host body\n");
    h.host.writes.length = 0;

    const held = await h.sync();
    assert.equal(held.err?.exitCode, 5);
    assert.equal(heldRow(held, "notes/alpha").reason, limit.code);
    assert.equal(await readFile(h.file("notes/alpha"), "utf8"), placed, "the old file stays");
    assert.equal(held.out.pulled.removed, 0);
    assert.equal(h.host.writes.length, 0);

    await h.edit("notes/alpha", "my edit of the old copy\n");
    const edited = await h.sync();
    assert.equal(edited.err?.exitCode, 5);
    assert.equal(heldRow(edited, "notes/alpha").state, "conflict");
    assert.equal(h.host.docs.get("notes/alpha")!.version, version, "the host's version stands");
    assert.match(await readFile(h.file("notes/alpha"), "utf8"), /my edit of the old copy/);

    // The row's own next step works, and says what take cannot do.
    const inspected = await h.sync("--inspect", "--doc", "notes/alpha");
    assert.equal(inspected.err, undefined, inspected.err?.message);
    assert.equal(inspected.out.remote.version, version);
    assert.equal(inspected.out.remote.unstorable.code, limit.code);
    assert.deepEqual(Object.keys(inspected.out.choices), ["keep", "revise"]);
    assert.equal(inspected.out.remote.content, "host body\n", "the body a keep would replace is shown");
    assert.equal(inspected.out.remote.chars, "host body\n".length);
    assert.match(inspected.out.remote.full_version, /body only/);
    assert.match(inspected.out.take_unavailable, /take cannot place/);
    const taken = await h.sync("--resolve", "take", "--doc", "notes/alpha");
    assert.equal(taken.err?.exitCode, 5);
    assert.equal(taken.err?.details?.reason, limit.code);
    assert.match(await readFile(h.file("notes/alpha"), "utf8"), /my edit of the old copy/, "a refused take changes nothing");

    // Sending over it takes the person's explicit decision, against the version they inspected.
    const kept = await h.sync("--resolve", "keep", "--doc", "notes/alpha");
    assert.equal(kept.err, undefined, kept.err?.message);
    assert.equal(h.host.docs.get("notes/alpha")!.version, version, "resolving sends nothing");
    const replaced = await h.sync("--resolve", "take", "--doc", "notes/alpha");
    assert.equal(replaced.err?.exitCode, 5);
    assert.match(replaced.err!.message, /kept over cannot be stored/);
    const sent = await h.sync();
    assert.equal(sent.err, undefined, sent.err?.message);
    assert.match(h.host.docs.get("notes/alpha")!.body, /my edit of the old copy/);
  });
}

test("a local deletion of the old copy of an over-limit document is a conflict, never a host delete", async () => {
  const h = await harness();
  assert.equal((await h.checkout()).err, undefined);
  const version = h.host.putUnchecked("notes/alpha", LIMITS[0].frontmatter, "host body\n");
  await unlink(h.file("notes/alpha"));
  const run = await h.sync();
  assert.equal(run.err?.exitCode, 5);
  assert.equal(heldRow(run, "notes/alpha").state, "conflict");
  assert.equal(h.host.docs.get("notes/alpha")?.version, version);

  // Inspect offers what works, and shows what a kept deletion removes.
  const inspected = await h.sync("--inspect", "--doc", "notes/alpha");
  assert.equal(inspected.err, undefined, inspected.err?.message);
  assert.deepEqual(Object.keys(inspected.out.choices), ["keep"]);
  assert.equal(inspected.out.help.length, 1);
  assert.equal(inspected.out.remote.content, "host body\n");
  assert.match(inspected.out.take_unavailable, /repaired where it is stored/);
  const taken = await h.sync("--resolve", "take", "--doc", "notes/alpha");
  assert.equal(taken.err?.details?.reason, "FRONTMATTER_TOO_LARGE");
  assert.equal(h.host.docs.get("notes/alpha")?.version, version);

  // Once it is repaired, take brings it back.
  h.host.put("notes/alpha", { type: "Note", title: "Fixed" }, "fixed\n");
  const again = await h.sync("--inspect", "--doc", "notes/alpha");
  assert.ok(Object.keys(again.out.choices).includes("take"));
  const restored = await h.sync("--resolve", "take", "--doc", "notes/alpha");
  assert.equal(restored.err, undefined, restored.err?.message);
  assert.match(await readFile(h.file("notes/alpha"), "utf8"), /fixed/);
});

test("keeping a local deletion over an over-limit version takes the inspection, then sends the delete", async () => {
  const h = await harness();
  assert.equal((await h.checkout()).err, undefined);
  h.host.putUnchecked("notes/alpha", LIMITS[0].frontmatter, "host body\n");
  await unlink(h.file("notes/alpha"));
  await h.sync();
  const blind = await h.sync("--resolve", "keep", "--doc", "notes/alpha");
  assert.equal(blind.err?.details?.reason, "not_inspected");
  assert.equal((await h.sync("--inspect", "--doc", "notes/alpha")).err, undefined);
  assert.equal((await h.sync("--resolve", "keep", "--doc", "notes/alpha")).err, undefined);
  assert.equal(h.host.docs.has("notes/alpha"), true, "resolving sends nothing");
  const sent = await h.sync();
  assert.equal(sent.err, undefined, sent.err?.message);
  assert.equal(h.host.docs.has("notes/alpha"), false);
});

test("a host deletion of a held document ends the hold", async () => {
  const h = await harness();
  h.host.putUnchecked("notes/big", LIMITS[0].frontmatter, "big body\n");
  assert.equal((await h.checkout()).err?.exitCode, 5);
  h.host.docs.delete("notes/big");
  const run = await h.sync();
  assert.equal(run.err, undefined, run.err?.message);
  assert.equal(run.out.status, "up_to_date");
  assert.equal(run.out.pulled.removed, 0);
});

test("held documents do not count in the deletion window", async () => {
  const h = await harness();
  for (let index = 0; index < 8; index += 1) h.host.put(`notes/extra-${index}`, { type: "Note", title: `Extra ${index}` }, "body\n");
  // Enough held documents that a window counting them would judge the deletions below ordinary.
  for (let index = 0; index < 20; index += 1) h.host.putUnchecked(`notes/held-${index}`, LIMITS[0].frontmatter, "big\n");
  const created = await h.checkout();
  assert.equal(created.out.counts.held, 20);
  const placed = Number(created.out.documents);
  const removing = Array.from({ length: 8 }, (_, index) => `notes/extra-${index}`);
  assert.ok(removing.length * 2 > placed, "the fixture deletes over half of what was placed");
  for (const id of removing) await unlink(h.file(id));
  h.host.writes.length = 0;
  const run = await h.sync();
  assert.equal(run.err?.exitCode, 5);
  assert.equal(run.out.deletions_held?.baseline, placed, "counted over the placed documents only");
  assert.equal(run.out.deletions_held?.count, removing.length);
  assert.equal(h.host.writes.length, 0, "nothing is deleted");
  assert.equal(heldRow(run, "notes/held-0").reason, "FRONTMATTER_TOO_LARGE");
});

test("a pull with no push holds the document without throwing, and reports it held", async () => {
  const h = await harness();
  assert.equal((await h.checkout()).err, undefined);
  h.host.putUnchecked("notes/big", LIMITS[0].frontmatter, "big body\n");
  const binding = await bindingForPath(h.home, h.folder);
  const result = await hostedPull(binding!, { auth: h.auth, cwd: h.cwd, fetch: h.host.fetch } as never);
  assert.equal(result.state, "pulled");
  assert.equal((result as { held?: number }).held, 1);
});

test("checkout --adopt of a copy holds the document and names it, and its local file is not called new", async () => {
  const source = await harness();
  assert.equal((await source.checkout()).err, undefined);
  const copy = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "sb-unstorable-copy-"))), "team");
  await cp(source.folder, copy, { recursive: true });
  await writeFile(path.join(copy, "stray.md"), "---\ntype: Note\ntitle: Stray\n---\nmine\n");
  source.host.putUnchecked("stray", LIMITS[0].frontmatter, "host\n");
  const out: string[] = [];
  const failure = await checkout(["--adopt", copy, "--host", HOST, "--json"], { stdout: (text: string) => void out.push(text), auth: source.auth, cwd: source.cwd, fetch: source.host.fetch }).then(() => null, (error: unknown) => error as CliError);
  assert.equal(failure?.exitCode, 5, failure?.message);
  const record = JSON.parse(out.at(-1)!) as Record<string, any>;
  assert.equal(record.adopted, "copy");
  assert.equal(record.status, "incomplete");
  assert.equal(record.rows[0].id, "stray");
  assert.equal(record.rows[0].reason, "FRONTMATTER_TOO_LARGE");
  assert.equal(record.documents.local_only, 0);
});

test("a front page the client cannot store is held and named by checkout and sync, and repair places it", async () => {
  const h = await harness();
  assert.equal((await h.checkout()).err, undefined);
  const before = await readFile(path.join(h.folder, "index.md"), "utf8");
  const big = `---\nokf_version: '0.2'\nblob: ${"x".repeat(300 * 1024)}\n---\nfront\n`;
  h.host.putRoot(big);
  h.host.put("notes/alpha", { type: "Note", title: "Alpha 2" }, "alpha two\n");
  const synced = await h.sync();
  assert.equal(synced.err?.exitCode, 5);
  assert.equal(heldRow(synced, "index.md").reason, "FRONTMATTER_TOO_LARGE");
  assert.equal(synced.out.pulled.refreshed, 1, "the other document still arrives");
  assert.equal(await readFile(path.join(h.folder, "index.md"), "utf8"), before);

  const fresh = await harness(h.host);
  const created = await fresh.checkout();
  assert.equal(created.err?.exitCode, 5);
  assert.equal(heldRow(created, "index.md").reason, "FRONTMATTER_TOO_LARGE");
  assert.equal(existsSync(fresh.file("notes/alpha")), true);

  h.host.putRoot("---\nokf_version: '0.2'\n---\nrepaired\n");
  const repaired = await h.sync();
  assert.equal(repaired.err, undefined, repaired.err?.message);
  assert.match(await readFile(path.join(h.folder, "index.md"), "utf8"), /repaired/);
  const placed = await fresh.sync();
  assert.equal(placed.err, undefined, placed.err?.message);
  assert.match(await readFile(path.join(fresh.folder, "index.md"), "utf8"), /repaired/);
});

test("the front-page verbs on a held root: take is refused and the edit survives, keep really sends", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  assert.equal((await h.checkout()).err, undefined);
  const index = path.join(h.folder, "index.md");
  const mine = "---\nokf_version: '0.2'\n---\nmy front page\n";
  await writeFile(index, mine);
  const big = `---\nokf_version: '0.2'\nblob: ${"x".repeat(300 * 1024)}\n---\nfront\n`;
  const version = h.host.putRoot(big);

  const held = await h.sync();
  assert.equal(held.err?.exitCode, 5);
  assert.equal(heldRow(held, "index.md").reason, "FRONTMATTER_TOO_LARGE");
  assert.equal(await readFile(index, "utf8"), mine);

  const blindTake = await h.sync("--resolve", "take", "--doc", "index.md");
  assert.equal(blindTake.err?.exitCode, 5);
  assert.equal(blindTake.err?.details?.reason, "FRONTMATTER_TOO_LARGE");
  assert.match(blindTake.err!.message, /nothing changed/);
  assert.equal(await readFile(index, "utf8"), mine, "the local edit survives");

  const inspected = await h.sync("--inspect", "--doc", "index.md");
  assert.equal(inspected.err, undefined, inspected.err?.message);
  assert.deepEqual(Object.keys(inspected.out.choices), ["keep"]);
  assert.equal(inspected.out.help.length, 1);
  assert.equal(inspected.out.remote.version, version);
  assert.equal(inspected.out.remote.unstorable.code, "FRONTMATTER_TOO_LARGE");
  assert.match(inspected.out.take_unavailable, /take cannot place/);

  const take = await h.sync("--resolve", "take", "--doc", "index.md");
  assert.equal(take.err?.details?.reason, "FRONTMATTER_TOO_LARGE");
  assert.equal(await readFile(index, "utf8"), mine, "still there after an inspected take");

  const writes = h.host.writes.length;
  const kept = await h.sync("--resolve", "keep", "--doc", "index.md");
  assert.equal(kept.err, undefined, kept.err?.message);
  assert.equal(h.host.writes.length, writes, "resolving sends nothing");
  const sent = await h.sync();
  assert.equal(sent.err, undefined, sent.err?.message);
  assert.equal(heldRow(sent, "index.md").state, "committed");
  assert.equal(await readFile(index, "utf8"), mine);
  assert.equal((h.host as unknown as { storedRoot: { content: string } }).storedRoot.content, mine);
});

test("a kept front page holding the host's own over-limit bytes stays held with a receipt", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  assert.equal((await h.checkout()).err, undefined);
  const index = path.join(h.folder, "index.md");
  await writeFile(index, "---\nokf_version: '0.2'\n---\nmy front page\n");
  const big = `---\nokf_version: '0.2'\nblob: ${"x".repeat(300 * 1024)}\n---\nfront\n`;
  h.host.putRoot(big);
  assert.equal((await h.sync("--inspect", "--doc", "index.md")).err, undefined);
  assert.equal((await h.sync("--resolve", "keep", "--doc", "index.md")).err, undefined);
  await writeFile(index, big);

  const writes = h.host.writes.length;
  const held = await h.sync();
  assert.equal(held.err?.exitCode, 5, held.err?.message);
  assert.equal(heldRow(held, "index.md").reason, "FRONTMATTER_TOO_LARGE");
  assert.equal(h.host.writes.length, writes);
  assert.equal(await readFile(index, "utf8"), big);
});

test("a pull with no push never sends a kept front page over a held root", async () => {
  const h = await harness(new FakeHost({ rootWrites: "allowed" }));
  assert.equal((await h.checkout()).err, undefined);
  const index = path.join(h.folder, "index.md");
  await writeFile(index, "---\nokf_version: '0.2'\n---\nmine\n");
  const version = h.host.putRoot(`---\nokf_version: '0.2'\nblob: ${"x".repeat(300 * 1024)}\n---\nfront\n`);
  assert.equal((await h.sync("--inspect", "--doc", "index.md")).err, undefined);
  assert.equal((await h.sync("--resolve", "keep", "--doc", "index.md")).err, undefined);
  const binding = await bindingForPath(h.home, h.folder);
  assert.equal((await hostedPull(binding!, { auth: h.auth, cwd: h.cwd, fetch: h.host.fetch } as never)).state, "pulled");
  assert.equal((h.host as unknown as { storedRoot: { version: string } }).storedRoot.version, version);
});
