// `superbee export` against the fake hosted sync family (`support/fake-hosted-sync.ts`), whose
// `/sync/v1/export` answer is held byte for byte to the archive the real gateway answered
// (`hosted-fake-contract.test.ts`). No request leaves the process: the fake is a `fetch`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { exportCommand, IN_PLACE_STAGING } from "../src/commands/export.js";
import { bundleHomeAt } from "../src/bundle-home.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath, releaseCheckout } from "../src/hosted/binding.js";
import { hostedStatus } from "../src/hosted/status.js";
import { readCheckoutMarker, unboundCopyDetail } from "../src/hosted/marker.js";
import { ExportArchiveError, readStoredZip, verifyExport } from "../src/hosted/export-archive.js";
import { exportEntries, storedZip, type ZipEntryInput } from "./support/fake-export-archive.js";
import { BUNDLE, FakeHost, HOST, jwt, SYNC_FIXTURES, TOKEN } from "./support/fake-hosted-sync.js";

interface Harness {
  home: string;
  cwd: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  out: string[];
}

async function harness(host = new FakeHost(), env: NodeJS.ProcessEnv = { SUPERBEE_ACCESS_TOKEN: TOKEN }): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-export-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-export-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env,
    fetch: async () => {
      throw new Error("the sign-in module must not be reached");
    },
  });
  return { home, cwd, auth, host, out: [] };
}

async function run(h: Harness, argv: string[]): Promise<Record<string, unknown>> {
  h.out.length = 0;
  await exportCommand([...argv], { stdout: (text) => void h.out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch });
  return decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
}

async function rejects(h: Harness, argv: string[]): Promise<CliError> {
  try {
    await run(h, argv);
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail(`expected export to fail; it printed ${h.out.join("")}`);
}

async function checkedOut(h: Harness, dir = "team"): Promise<string> {
  await checkout([BUNDLE, "--host", HOST, "--dir", dir], { stdout: () => {}, auth: h.auth, cwd: h.cwd, fetch: h.host.fetch });
  h.host.requests.length = 0;
  return path.join(h.cwd, dir);
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}

const exists = (file: string) => lstat(file).then(() => true, () => false);
const git = (dir: string, args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout.trim();
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x0d, 0x0a]);

// ── the archive reader, against the archive the real gateway answered ─────────────────────────

const captured = JSON.parse(readFileSync(path.join(SYNC_FIXTURES, "export-200.json"), "utf8")) as { response: { bodyBase64: string } };
const capturedArchive = Buffer.from(captured.response.bodyBase64, "base64");

test("the captured /sync/v1/export archive verifies to the host's values", () => {
  const exported = verifyExport(capturedArchive, "notes.a");
  assert.deepEqual(exported.source, { tenantId: "tenant:a", bundleId: "notes.a", revision: 2, okfEdition: "0.2" });
  assert.equal(exported.exportedAt, "2026-09-24T13:55:23.656Z");
  assert.deepEqual(exported.counts, { documents: 1, reserved: 1, blobs: 0 });
  assert.equal(exported.bytes, 60);
  assert.deepEqual(
    exported.entries.map((entry) => [entry.path, entry.kind, Buffer.from(entry.bytes).toString("utf8")]),
    [
      ["index.md", "reserved", '---\nokf_version: "0.2"\n---\n# notes.a\n'],
      ["notes/one.md", "document", "---\ntype: Note\n---\none\n"],
    ],
  );
  assert.throws(() => verifyExport(capturedArchive, "notes.b"), (error: unknown) => error instanceof ExportArchiveError && error.problem === "wrong_bundle");
});

function archiveOf(files: Record<string, string | Uint8Array>, mutate?: (entries: ZipEntryInput[]) => ZipEntryInput[]): Uint8Array {
  const at = new Date("2026-09-24T13:55:23.656Z");
  const state = { tenantId: "tenant:a", bundleId: "notes.a", revision: 2, files: new Map(Object.entries(files).map(([file, bytes]) => [file, typeof bytes === "string" ? Buffer.from(bytes) : bytes])) };
  const entries = exportEntries(state, at);
  return storedZip(mutate ? mutate(entries) : entries, at);
}

const problemOf = (archive: Uint8Array): string => {
  try {
    verifyExport(archive, "notes.a");
  } catch (error) {
    assert.ok(error instanceof ExportArchiveError, String(error));
    return error.problem;
  }
  return "verified";
};

test("the archive reader refuses a stopped, tampered or mislabeled export", () => {
  const good = archiveOf({ "index.md": "# notes\n", "notes/one.md": "---\ntype: Note\n---\none\n", "assets/logo.png": LOGO });
  assert.equal(problemOf(good), "verified");
  // A stopped export: the host ends the body without its central directory.
  const firstDirectory = Buffer.from(good).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.equal(problemOf(good.subarray(0, firstDirectory)), "incomplete");
  assert.equal(problemOf(good.subarray(0, good.length - 1)), "incomplete");
  // One flipped data byte: the CRC no longer matches.
  const flipped = Buffer.from(good);
  flipped[40] = flipped[40]! ^ 0xff;
  assert.equal(problemOf(flipped), "malformed");
  // An entry the manifest does not list, a listed entry missing, a wrong digest, a wrong format.
  const extra = archiveOf({ "a.md": "---\ntype: Note\n---\na\n" }, (entries) => [{ name: "b.md", bytes: Buffer.from("b") }, ...entries]);
  assert.equal(problemOf(extra), "manifest_mismatch");
  const missing = archiveOf({ "a.md": "a", "b.md": "b" }, (entries) => entries.filter((entry) => entry.name !== "b.md"));
  assert.equal(problemOf(missing), "manifest_mismatch");
  const changed = archiveOf({ "a.md": "a" }, (entries) => entries.map((entry) => (entry.name === "a.md" ? { name: "a.md", bytes: Buffer.from("A") } : entry)));
  assert.equal(problemOf(changed), "manifest_mismatch");
  const format = archiveOf({ "a.md": "a" }, (entries) =>
    entries.map((entry) => (entry.name === "superbee-export.json" ? { name: entry.name, bytes: Buffer.from(Buffer.from(entry.bytes).toString("utf8").replace("superbee-export/1", "superbee-export/2")) } : entry)),
  );
  assert.equal(problemOf(format), "unsupported_format");
});

test("the archive reader refuses every path a bundle folder cannot hold", () => {
  for (const unsafe of ["../escape.md", "/abs.md", "notes/../../x.md", ".git/config", ".git/hooks/pre-commit", "notes/.hidden.md", "a\\b.md", "CON.md", "notes/trailing.", "c:/x.md", "x.md/y.md"]) {
    assert.equal(problemOf(archiveOf({ [unsafe]: "x" })), "unsafe_path", unsafe);
  }
  // Two paths that fold together, or a file where a folder must be.
  assert.equal(problemOf(archiveOf({ "Notes/a.md": "1", "notes/b.md": "2" })), "unsafe_path");
  assert.equal(problemOf(archiveOf({ "a.md": "1", "A.md": "2" })), "unsafe_path");
  assert.equal(problemOf(archiveOf({ assets: "1", "assets/logo.png": "2" })), "unsafe_path");
  assert.throws(() => readStoredZip(new Uint8Array(10)), (error: unknown) => error instanceof ExportArchiveError && error.problem === "incomplete");
});

// ── export <bundle-id> --to <folder> ─────────────────────────────────────────────────────────

test("export --to writes the hosted bundle, byte for byte, into a new local bundle", async () => {
  const h = await harness();
  h.host.exportExtras.set("assets/logo.png", LOGO);
  h.host.exportExtras.set("notes/log.md", Buffer.from("# log\n"));
  const receipt = await run(h, [BUNDLE, "--host", HOST, "--to", "copy"]);
  const folder = path.join(h.cwd, "copy");
  assert.equal(receipt.export, "created");
  assert.equal(receipt.folder, folder);
  assert.equal(receipt.home, "local");
  assert.equal(receipt.bundle_id, BUNDLE);
  assert.equal(receipt.host, HOST);
  assert.equal(receipt.revision, h.host.revision);
  assert.deepEqual([receipt.documents, receipt.reserved, receipt.blobs], [3, 2, 1]);
  assert.equal(receipt.root_index, true);
  assert.match(String(receipt.history), /current revision only/);
  assert.match(String(receipt.hosted), /not modified/);

  assert.deepEqual(await filesUnder(folder), ["assets/logo.png", "index.md", "notes/alpha.md", "notes/beta.md", "notes/log.md", "projects/2026/plan.md"]);
  for (const [id, doc] of h.host.docs) assert.equal(await readFile(path.join(folder, `${id}.md`), "utf8"), doc.raw, id);
  assert.deepEqual(await readFile(path.join(folder, "assets/logo.png")), LOGO);
  assert.equal(await readFile(path.join(folder, "index.md"), "utf8"), h.host.rootIndex());
  // Nothing else: no manifest, no staging sibling, no binding.
  assert.deepEqual((await readdir(h.cwd)).sort(), ["copy"]);
  assert.equal(await bindingForPath(h.home, folder), null);
  assert.deepEqual(h.host.requests.map((request) => request.path), ["/sync/v1/export"]);
  assert.deepEqual(h.host.requests[0]!.body, { bundleId: BUNDLE });
  assert.equal(h.host.requests[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
  // The new folder is an ordinary bundle every command reads.
  assert.equal((await bundleHomeAt(await realpath(folder), { home: h.home })).home, "local");
});

test("export --to --git commits the export on the board branch, so the folder is a Git board", async () => {
  const h = await harness();
  h.host.exportExtras.set("assets/logo.png", LOGO);
  const receipt = await run(h, [BUNDLE, "--host", HOST, "--to", "board", "--git"]);
  const folder = path.join(h.cwd, "board");
  assert.equal(receipt.home, "git");
  const gitReceipt = receipt.git as { branch: string; commit: string };
  assert.equal(gitReceipt.branch, "board");
  assert.equal(gitReceipt.commit, git(folder, ["rev-parse", "HEAD"]));
  assert.equal(git(folder, ["symbolic-ref", "--short", "HEAD"]), "board");
  assert.deepEqual(git(folder, ["ls-files"]).split("\n").sort(), await filesUnder(folder));
  assert.equal(git(folder, ["status", "--porcelain"]), "");
  assert.match(git(folder, ["log", "-1", "--format=%s"]), new RegExp(`^Export ${BUNDLE.replace(".", "\\.")} from `));
  assert.ok((receipt.help as string[]).some((line) => line.includes("sync --establish")));
});

test("export --to refuses a folder that is not empty before any request, and fills an empty one", async () => {
  const h = await harness();
  await mkdir(path.join(h.cwd, "taken"));
  await writeFile(path.join(h.cwd, "taken", "mine.txt"), "mine\n");
  const error = await rejects(h, [BUNDLE, "--host", HOST, "--to", "taken"]);
  assert.equal(error.code, "ALREADY_EXISTS");
  assert.equal(h.host.requests.length, 0);
  assert.equal(await readFile(path.join(h.cwd, "taken", "mine.txt"), "utf8"), "mine\n");
  await writeFile(path.join(h.cwd, "file"), "x");
  assert.equal((await rejects(h, [BUNDLE, "--host", HOST, "--to", "file"])).code, "ALREADY_EXISTS");

  await mkdir(path.join(h.cwd, "empty"));
  const receipt = await run(h, [BUNDLE, "--host", HOST, "--to", "empty"]);
  assert.equal(receipt.export, "created");
  assert.ok(await exists(path.join(h.cwd, "empty", "notes", "alpha.md")));
});

test("a stopped or tampered export writes nothing and leaves no partial folder", async () => {
  const h = await harness();
  h.host.exportHook = (archive) => archive.subarray(0, archive.length - 40);
  const stopped = await rejects(h, [BUNDLE, "--host", HOST, "--to", "copy"]);
  assert.equal(stopped.code, "TRANSIENT");
  assert.equal(stopped.details?.reason, "export_incomplete");
  assert.deepEqual(await readdir(h.cwd), []);

  h.host.exportHook = (archive) => {
    const bytes = Buffer.from(archive);
    bytes[60] = bytes[60]! ^ 0x01;
    return bytes;
  };
  const tampered = await rejects(h, [BUNDLE, "--host", HOST, "--to", "copy"]);
  assert.equal(tampered.code, "RUNTIME");
  assert.equal(tampered.details?.reason, "export_malformed");
  assert.deepEqual(await readdir(h.cwd), []);

  // A body cut off mid-stream by the network.
  h.host.exportHook = (archive) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(archive.subarray(0, 100));
          controller.error(new TypeError("terminated"));
        },
      }),
      { status: 200, headers: { "content-type": "application/zip" } },
    );
  const cut = await rejects(h, [BUNDLE, "--host", HOST, "--to", "copy"]);
  assert.equal(cut.code, "TRANSIENT");
  assert.deepEqual(await readdir(h.cwd), []);
});

test("an export whose process died is cleaned up by the next export to the same folder", async () => {
  const h = await harness();
  const abandoned = path.join(h.cwd, ".copy.superbee-export-999999999-abcdefabcdef.partial");
  await mkdir(path.join(abandoned, "notes"), { recursive: true });
  await writeFile(path.join(abandoned, "notes", "half.md"), "half");
  const live = path.join(h.cwd, `.copy.superbee-export-${process.pid}-abcdefabcdef.partial`);
  await mkdir(live);
  const receipt = await run(h, [BUNDLE, "--host", HOST, "--to", "copy"]);
  assert.equal(receipt.removed_abandoned_exports, 1);
  assert.equal(await exists(abandoned), false);
  // A staging folder whose process is alive may be another export in progress: it is kept.
  assert.equal(await exists(live), true);
});

test("export --to maps the host's refusals and a bad session", async () => {
  const h = await harness();
  const missing = await rejects(h, ["nope.a", "--host", HOST, "--to", "copy"]);
  assert.equal(missing.code, "NOT_FOUND");
  const signedOut = await harness(new FakeHost(), { SUPERBEE_ACCESS_TOKEN: jwt({ aud: `${HOST}/mcp`, sub: "auth0|other" }) });
  const refused = await rejects(signedOut, [BUNDLE, "--host", HOST, "--to", "copy"]);
  assert.equal(refused.code, "AUTH_REQUIRED");
  assert.match(String(refused.details?.resume), /export team\.knowledge --to .*copy --host https:\/\/hosted\.example/);
  h.host.exportHook = () => Response.json({ error: { code: "result_too_large" } }, { status: 422 });
  assert.equal((await rejects(h, [BUNDLE, "--host", HOST, "--to", "copy"])).code, "FORBIDDEN");
  h.host.exportHook = () => Response.json({ error: { code: "backend_unavailable" } }, { status: 503 });
  assert.equal((await rejects(h, [BUNDLE, "--host", HOST, "--to", "copy"])).code, "TRANSIENT");
  assert.deepEqual(await readdir(h.cwd), []);
});

test("export --to refuses a folder inside a bundle or a hosted checkout", async () => {
  const h = await harness();
  const folder = await checkedOut(h);
  const inside = await rejects(h, [BUNDLE, "--host", HOST, "--to", path.join(folder, "nested")]);
  assert.equal(inside.code, "FORBIDDEN");
  assert.equal(inside.details?.reason, "inside_checkout");
  await mkdir(path.join(h.cwd, "local"));
  await writeFile(path.join(h.cwd, "local", "index.md"), "# local\n");
  const nested = await rejects(h, [BUNDLE, "--host", HOST, "--to", "local/nested"]);
  assert.equal(nested.details?.reason, "inside_bundle");
  assert.equal(h.host.requests.length, 0);
});

test("export --dir <checkout> --to exports the checkout's own bundle under its own identity", async () => {
  const h = await harness();
  const folder = await checkedOut(h);
  const receipt = await run(h, ["--dir", folder, "--to", "copy"]);
  assert.equal(receipt.bundle_id, BUNDLE);
  assert.deepEqual(h.host.requests.map((request) => request.path), ["/sync/v1/whoami", "/sync/v1/export"]);
  assert.equal(h.host.requests[1]!.headers.get("x-superbee-workspace"), "tenant-a");
  // The checkout is untouched.
  assert.ok(await bindingForPath(h.home, await realpath(folder)));

  h.host.principal = "principal-other";
  const other = await rejects(h, ["--dir", folder, "--to", "copy-2"]);
  assert.equal(other.code, "FORBIDDEN");
  assert.equal(other.details?.reason, "other_principal");
});

test("usage: one destination, one source, and no --with-history", async () => {
  const h = await harness();
  for (const argv of [
    [BUNDLE, "--host", HOST],
    [BUNDLE, "--host", HOST, "--to", "x", "--in-place"],
    [BUNDLE, "--dir", "team", "--to", "x"],
    [BUNDLE, "--in-place"],
    ["--dir", "team", "--host", HOST, "--to", "x"],
    [BUNDLE, "--host", HOST, "--to", "x", "--keep-unsent"],
    [BUNDLE, "--host", HOST, "--to", "x", "--with-history"],
    ["Not A Bundle", "--host", HOST, "--to", "x"],
  ]) {
    assert.equal((await rejects(h, argv)).code, "USAGE", argv.join(" "));
  }
  assert.equal(h.host.requests.length, 0);
  h.out.length = 0;
  await exportCommand(["--help"], { stdout: (text) => void h.out.push(text), auth: h.auth, cwd: h.cwd, fetch: h.host.fetch });
  assert.match(h.out.join(""), /^superbee export — /);
  assert.doesNotMatch(h.out.join(""), /with-history/);
});

// ── export --in-place ────────────────────────────────────────────────────────────────────────

test("export --in-place converts a clean checkout into a local bundle and adds what it lacked", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  h.host.exportExtras.set("assets/logo.png", LOGO);
  h.host.put("notes/gamma", { type: "Note", title: "Gamma" }, "Added on the host.\n");
  const before = await readFile(path.join(folder, "notes", "alpha.md"));
  const receipt = await run(h, ["--dir", folder, "--in-place"]);
  assert.equal(receipt.export, "converted");
  assert.equal(receipt.home, "local");
  assert.equal(receipt.added, 2);
  assert.deepEqual(receipt.added_paths, ["assets/logo.png", "notes/gamma.md"]);
  assert.equal(receipt.unchanged, 4);
  assert.equal(receipt.kept_local, 0);
  assert.equal(receipt.marker, "removed");
  assert.equal(await exists(path.join(folder, ".superbee")), false, "the checkout marker goes with the binding");
  assert.deepEqual(await readFile(path.join(folder, "assets", "logo.png")), LOGO);
  assert.equal(await readFile(path.join(folder, "notes", "gamma.md"), "utf8"), h.host.docs.get("notes/gamma")!.raw);
  assert.deepEqual(await readFile(path.join(folder, "notes", "alpha.md")), before);
  assert.equal(await bindingForPath(h.home, folder), null);
  assert.equal(await exists(path.join(folder, IN_PLACE_STAGING)), false);
  assert.equal((await bundleHomeAt(folder, { home: h.home })).home, "local");
  assert.deepEqual(h.host.requests.map((request) => request.path), ["/sync/v1/whoami", "/sync/v1/export"]);
  assert.equal(h.host.writes.length, 0, "the hosted bundle is never written");

  // Idempotent: the folder is local now, so there is nothing to convert and nothing is sent.
  h.host.requests.length = 0;
  const again = await run(h, ["--dir", folder, "--in-place"]);
  assert.equal(again.export, "unchanged");
  assert.equal(again.home, "local");
  assert.equal(h.host.requests.length, 0);
});

test("export --in-place refuses unsent changes, and --keep-unsent keeps them in the folder only", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  const alpha = path.join(folder, "notes", "alpha.md");
  const edited = (await readFile(alpha, "utf8")).replace("Alpha body", "Alpha body, edited locally");
  await writeFile(alpha, edited);
  const refused = await rejects(h, ["--dir", folder, "--in-place"]);
  assert.equal(refused.code, "CONFLICT");
  assert.equal(refused.details?.reason, "unsent_changes");
  assert.match(String(refused.help), /sync --dir /);
  assert.match(String(refused.details?.keep_them_here_only), /export --in-place --dir .* --keep-unsent$/);
  assert.ok(await bindingForPath(h.home, folder), "still a checkout");
  assert.equal(h.host.requests.length, 0);

  const receipt = await run(h, ["--dir", folder, "--in-place", "--keep-unsent"]);
  assert.equal(receipt.export, "converted");
  assert.equal(receipt.unsent_kept, 1);
  assert.equal(receipt.kept_local, 1);
  assert.deepEqual(receipt.kept_local_paths, ["notes/alpha.md"]);
  assert.equal(await readFile(alpha, "utf8"), edited);
  assert.equal(await bindingForPath(h.home, folder), null);
});

test("export --in-place never overwrites a file that differs from the host's", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  const before = await readFile(path.join(folder, "notes", "beta.md"), "utf8");
  // Changed on the host after the last pull: the folder is clean, the host is newer.
  h.host.put("notes/beta", { type: "Note", title: "Beta" }, "Newer on the host.\n");
  const receipt = await run(h, ["--dir", folder, "--in-place"]);
  assert.equal(receipt.kept_local, 1);
  assert.deepEqual(receipt.kept_local_paths, ["notes/beta.md"]);
  assert.equal(await readFile(path.join(folder, "notes", "beta.md"), "utf8"), before);
});

test("export --in-place --git makes the converted checkout a Git board", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  h.host.exportExtras.set("assets/logo.png", LOGO);
  const receipt = await run(h, ["--dir", folder, "--in-place", "--git"]);
  assert.equal(receipt.home, "git");
  assert.equal(git(folder, ["symbolic-ref", "--short", "HEAD"]), "board");
  assert.deepEqual(git(folder, ["ls-files"]).split("\n").sort(), await filesUnder(folder));
  assert.ok(!git(folder, ["ls-files"]).includes(IN_PLACE_STAGING));

  // A folder that already holds a repository is refused before anything is sent.
  const h2 = await harness();
  const other = await realpath(await checkedOut(h2));
  await mkdir(path.join(other, ".git"));
  assert.equal((await rejects(h2, ["--dir", other, "--in-place", "--git"])).details?.reason, "already_git");
  assert.equal(h2.host.requests.length, 0);
});

test("an in-place export interrupted after unbinding is finished by re-running it, without the network", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  const binding = (await bindingForPath(h.home, folder))!;
  // The state a crash leaves between unbinding and linking the staged files in.
  const staging = path.join(folder, IN_PLACE_STAGING);
  await mkdir(path.join(staging, "files", "assets"), { recursive: true });
  await writeFile(path.join(staging, "files", "assets", "logo.png"), LOGO);
  await writeFile(
    path.join(staging, "journal.json"),
    JSON.stringify({ schema: 1, bundle_id: BUNDLE, host: HOST, audience: `${HOST}/mcp`, revision: 7, exported_at: "2026-09-25T00:00:00.000Z", git: true, adds: ["assets/logo.png"], same: 4, kept_local: [], deleted_locally: [], unsent_kept: 0 }),
  );
  await releaseCheckout(h.home, binding);
  // Status and the other readers point at finishing the export, not at adopting a copy.
  const marker = readCheckoutMarker(folder)!;
  assert.match(String((unboundCopyDetail(folder, marker).copy_of_checkout as { help: string }).help), /export --in-place --dir /);

  const receipt = await run(h, ["--dir", folder, "--in-place"]);
  assert.equal(receipt.export, "converted");
  assert.equal(receipt.resumed, true);
  assert.equal(receipt.marker, "removed");
  assert.deepEqual(receipt.added_paths, ["assets/logo.png"]);
  assert.equal(receipt.home, "git");
  assert.deepEqual(await readFile(path.join(folder, "assets", "logo.png")), LOGO);
  assert.equal(await exists(staging), false);
  assert.equal(h.host.requests.length, 0);
});

test("a staging folder left under a live binding is invisible to sync and redone by the next run", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  const staging = path.join(folder, IN_PLACE_STAGING);
  await mkdir(path.join(staging, "files", "notes"), { recursive: true });
  await writeFile(path.join(staging, "files", "notes", "stale.md"), "---\ntype: Note\n---\nstale\n");
  const binding = (await bindingForPath(h.home, folder))!;
  // The sync scan never reads it: the checkout is still clean.
  assert.equal((await hostedStatus(binding, h.home)).sync.state, "clean");

  const receipt = await run(h, ["--dir", folder, "--in-place"]);
  assert.equal(receipt.export, "converted");
  assert.equal(receipt.resumed, undefined);
  assert.equal(await exists(path.join(folder, "notes", "stale.md")), false);
  assert.equal(await exists(staging), false);
});

test("export --in-place on a folder that is not a checkout is a successful no-op", async () => {
  const h = await harness();
  await mkdir(path.join(h.cwd, "local"));
  await writeFile(path.join(h.cwd, "local", "index.md"), "# local\n");
  const receipt = await run(h, ["--dir", "local", "--in-place"]);
  assert.equal(receipt.export, "unchanged");
  assert.equal(receipt.home, "local");
  assert.equal(h.host.requests.length, 0);
  assert.equal((await rejects(h, ["--dir", "absent", "--in-place"])).code, "NOT_FOUND");
  assert.equal((await rejects(h, ["--dir", "local", "--to", "copy"])).code, "NOT_FOUND");
  await rm(path.join(h.cwd, "local"), { recursive: true });
});

test("export --in-place on an unbound copy of a checkout removes its marker and fetches nothing", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  const copy = path.join(h.cwd, "copy");
  assert.equal(spawnSync("cp", ["-R", folder, copy]).status, 0);
  assert.ok(await exists(path.join(copy, ".superbee", "checkout.json")), "the copy carries the marker");
  const receipt = await run(h, ["--dir", copy, "--in-place", "--git"]);
  assert.equal(receipt.export, "converted");
  assert.equal(receipt.from, "an unbound copy of a hosted checkout");
  assert.equal(receipt.marker, "removed");
  assert.equal(receipt.fetched, false);
  assert.equal(receipt.home, "git");
  assert.equal(await exists(path.join(copy, ".superbee")), false);
  assert.deepEqual(git(copy, ["ls-files"]).split("\n").sort(), await filesUnder(copy));
  assert.equal(h.host.requests.length, 0);
  // The original checkout is untouched.
  assert.ok(await bindingForPath(h.home, folder));
  assert.ok(await exists(path.join(folder, ".superbee", "checkout.json")));
});

test("export --in-place --keep-unsent never puts back a document deleted in the folder and not sent", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  await rm(path.join(folder, "notes", "alpha.md"));
  const receipt = await run(h, ["--dir", folder, "--in-place", "--keep-unsent"]);
  assert.equal(receipt.export, "converted");
  assert.equal(receipt.deleted_locally, 1);
  assert.deepEqual(receipt.deleted_locally_paths, ["notes/alpha.md"]);
  assert.equal(receipt.added, 0);
  assert.equal(await exists(path.join(folder, "notes", "alpha.md")), false);
});

test("a change made while the export is fetched is refused under the lock, and nothing is converted", async () => {
  const h = await harness();
  const folder = await realpath(await checkedOut(h));
  h.host.exportHook = (archive) => {
    // The person deletes one file and edits another while the archive is on its way.
    spawnSync("rm", [path.join(folder, "notes", "alpha.md")]);
    spawnSync("sh", ["-c", `printf 'more\\n' >> '${path.join(folder, "notes", "beta.md")}'`]);
    return archive;
  };
  const refused = await rejects(h, ["--dir", folder, "--in-place"]);
  assert.equal(refused.code, "CONFLICT");
  assert.equal(refused.details?.reason, "unsent_changes");
  assert.ok(await bindingForPath(h.home, folder), "still a checkout");
  assert.equal(await exists(path.join(folder, IN_PLACE_STAGING)), false);
  assert.equal(await exists(path.join(folder, "notes", "alpha.md")), false);
});

test("a staging folder that is a link, or a journal the folder's marker does not name, is never resumed", async () => {
  const h = await harness();
  const outside = path.join(h.cwd, "outside");
  await mkdir(path.join(outside, "files", "notes"), { recursive: true });
  await writeFile(path.join(outside, "files", "notes", "victim.md"), "victim\n");
  const journal = { schema: 1, bundle_id: BUNDLE, host: HOST, audience: `${HOST}/mcp`, revision: 1, exported_at: "2026-09-25T00:00:00.000Z", git: true, adds: ["notes/victim.md"], same: 0, kept_local: [], deleted_locally: [], unsent_kept: 0 };
  await writeFile(path.join(outside, "journal.json"), JSON.stringify(journal));

  // A plain folder whose staging name links out: not resumed, nothing moved, no repository made.
  const plain = path.join(h.cwd, "plain");
  await mkdir(plain);
  await writeFile(path.join(plain, "index.md"), "# plain\n");
  await symlink(outside, path.join(plain, IN_PLACE_STAGING));
  const receipt = await run(h, ["--dir", plain, "--in-place"]);
  assert.equal(receipt.export, "unchanged");
  assert.equal(await readFile(path.join(outside, "files", "notes", "victim.md"), "utf8"), "victim\n");
  assert.equal(await exists(path.join(plain, "notes", "victim.md")), false);
  assert.equal(await exists(path.join(plain, ".git")), false);

  // A real staging folder whose journal names a bundle the marker does not: not resumed either.
  const folder = await realpath(await checkedOut(h, "team"));
  await releaseCheckout(h.home, (await bindingForPath(h.home, folder))!);
  await mkdir(path.join(folder, IN_PLACE_STAGING, "files", "notes"), { recursive: true });
  await writeFile(path.join(folder, IN_PLACE_STAGING, "files", "notes", "planted.md"), "planted\n");
  await writeFile(path.join(folder, IN_PLACE_STAGING, "journal.json"), JSON.stringify({ ...journal, bundle_id: "other.bundle", adds: ["notes/planted.md"] }));
  const copy = await run(h, ["--dir", folder, "--in-place"]);
  assert.equal(copy.from, "an unbound copy of a hosted checkout");
  assert.equal(await exists(path.join(folder, "notes", "planted.md")), false);
});
