// Specification F8 (and P11): every publication path refuses private-state files wherever they sit
// in a bundle, before anything is committed, staged or sent, with a CONFLICT naming the path and a
// non-lossy way to move it out. This is the section-9 publication table: one row per fixture
// layout, run through every surface that commits or uploads bundle bytes. A layout that must NOT be
// refused is a row too, so an over-eager detector fails here rather than in a user's bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PRIVATE_STATE_CREDENTIAL_FILE_NAME,
  PRIVATE_STATE_MARKER_PREFIX,
  PRIVATE_STATE_REFUSAL_REASON,
  PRIVATE_STATE_ROOT_NAMES,
} from "@superbee/board-git";

import { sync } from "../src/commands/sync.js";
import { publish } from "../src/commands/publish.js";
import { CATALOG_FILE_NAME } from "../src/catalog.js";
import { CRED_FILE_NAME } from "../src/credentials.js";
import { CliError } from "../src/errors.js";
import { defaultHostedAuthDeps } from "../src/hosted-auth/session.js";
import { bindingForPath } from "../src/hosted/binding.js";
import { hostedSync } from "../src/hosted/sync.js";
import {
  LEGACY_USER_STATE_DIR_NAME,
  SUPERBEE_USER_STATE_PATH_SEGMENTS,
  USER_STATE_MARKER_BYTES,
  USER_STATE_MARKER_FILE_NAME,
} from "../src/user-state.js";
import { withIsolatedUserEnv } from "./support/user-env.js";
import { FakeCreateHost } from "./support/fake-hosted-create.js";
import { HOST, TOKEN } from "./support/fake-hosted-sync.js";
import {
  BOARD_BRANCH,
  commitBoard,
  git,
  gitTry,
  initPlainBundleDir,
  makeCommittedFolderTopology,
  makeGreenfieldTopology,
  makeTwoCloneTopology,
  publishNamedBoard,
} from "../../board-git/test/git-harness.js";

// ── the fixture layouts ───────────────────────────────────────────────────────

const CREDENTIALS = `${JSON.stringify({ remotes: { "https://gated.example": { api_key: "sk-test-not-a-real-key" } } })}\n`;
const CATALOG = `${JSON.stringify({ schema_version: 1, entries: [{ id: `bnd_${"0".repeat(32)}`, label: "work", locator: { kind: "local-path", path: "/home/u/work/.superbee" } }] }, null, 2)}\n`;
const SESSION = `${JSON.stringify({ access_token: "at-test", access_token_expires_at_ms: 1, has_refresh_token: true })}\n`;
const REFRESH = `${JSON.stringify({ account: "https://hosted.example api", refresh_token: "rt-test" })}\n`;

interface Layout {
  label: string;
  /** Bundle-relative path -> bytes. */
  files: Record<string, string>;
  /** The bundle-relative paths the refusal must tell the person to move out; empty = no refusal. */
  remove: string[];
  /** Whether a hosted upload (which never sends dot-folders) must refuse it too. */
  hosted: boolean;
}

const LAYOUTS: readonly Layout[] = [
  {
    label: "a copied canonical root (cp -R ~/.superbee-state <bundle>/)",
    files: {
      ".superbee-state/state.json": USER_STATE_MARKER_BYTES,
      ".superbee-state/okf-config.json": CREDENTIALS,
      ".superbee-state/catalog.json": CATALOG,
    },
    remove: [".superbee-state"],
    hosted: true,
  },
  {
    label: "a MARKERLESS legacy root copied under an ordinary name (P11)",
    files: { "backup/agentstate/catalog.json": CATALOG, "backup/agentstate/creds.json": CREDENTIALS },
    remove: ["backup/agentstate/catalog.json", "backup/agentstate/creds.json"],
    hosted: true,
  },
  {
    label: "a legacy root folder nested deep, holding only a non-JSON file",
    files: { "notes/deep/.agentstate/view-authorizations/x": "opaque\n" },
    remove: ["notes/deep/.agentstate"],
    hosted: true,
  },
  {
    label: "the credential file by name, whatever it holds",
    files: { "misc/okf-config.json": "not json at all\n" },
    remove: ["misc/okf-config.json"],
    hosted: true,
  },
  {
    label: "the ownership marker under another name",
    files: { "misc/owner.json": USER_STATE_MARKER_BYTES },
    remove: ["misc/owner.json"],
    hosted: true,
  },
  {
    label: "hosted sign-in records",
    files: { "misc/a/session.json": SESSION, "misc/b/refresh-token.json": REFRESH },
    remove: ["misc/a/session.json", "misc/b/refresh-token.json"],
    hosted: true,
  },
  {
    label: "CONTROL: ordinary JSON and prose that merely mention private state",
    files: {
      "data/config.json": `${JSON.stringify({ product: "other", schema_version: 1 })}\n`,
      "data/remotes.json": `${JSON.stringify({ remotes: { origin: { url: "https://example.com" } } })}\n`,
      "data/list.json": `${JSON.stringify({ schema_version: 2, entries: [1, 2] })}\n`,
      "notes/how-we-store-keys.md": "---\ntype: Note\ntitle: Keys\n---\nKeys live in ~/.superbee-state/okf-config.json, never here.\n",
    },
    remove: [],
    hosted: true,
  },
];

async function plant(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

function assertRefusal(error: CliError | undefined, layout: Layout, root: string, surface: string): void {
  assert.ok(error, `${surface} / ${layout.label}: expected a refusal`);
  assert.equal(error.code, "CONFLICT", `${surface} / ${layout.label}: ${error.message}`);
  assert.equal(error.exitCode, 5);
  assert.equal(error.details?.reason, PRIVATE_STATE_REFUSAL_REASON);
  assert.deepEqual(error.details?.remove, layout.remove, `${surface} / ${layout.label}: what to move out`);
  assert.ok(error.message.includes(`'${layout.remove[0]}'`), `${surface}: the message names the path: ${error.message}`);
  assert.ok(error.message.includes(root), `${surface}: the message names the folder: ${error.message}`);
  assert.match(error.help ?? "", /mv -- .*mktemp -d ~\/superbee-private-state-removed\.XXXXXX/, `${surface}: a non-lossy move out`);
  assert.doesNotMatch(error.help ?? "", /\brm\b/, `${surface}: never a delete`);
  for (const bytes of Object.values(layout.files)) {
    assert.ok(!error.message.includes("sk-test") && !(error.help ?? "").includes("sk-test"), "no secret is echoed");
    void bytes;
  }
}

async function runSync(home: string, argv: string[]): Promise<{ out: string; err?: CliError }> {
  const chunks: string[] = [];
  try {
    await withIsolatedUserEnv(home, () => sync(argv, { stdout: (s) => void chunks.push(s), hookInstalled: () => true }));
    return { out: chunks.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: chunks.join(""), err };
    throw err;
  }
}

async function scratch(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const ref = (repo: string, name: string): string | null => {
  const result = gitTry(repo, ["rev-parse", "--verify", "--quiet", name]);
  return result.status === 0 ? result.stdout.trim() : null;
};

// ── agreement: the detector's names are the product's names ───────────────────

test("F8 detector names agree with the private-state constants they project", () => {
  assert.deepEqual(
    [...PRIVATE_STATE_ROOT_NAMES].sort(),
    [SUPERBEE_USER_STATE_PATH_SEGMENTS.at(-1)!, LEGACY_USER_STATE_DIR_NAME].sort(),
  );
  assert.equal(PRIVATE_STATE_CREDENTIAL_FILE_NAME, CRED_FILE_NAME);
  assert.ok(USER_STATE_MARKER_BYTES.startsWith(PRIVATE_STATE_MARKER_PREFIX), "the marker is matched on its own prefix");
  assert.equal(USER_STATE_MARKER_FILE_NAME, "state.json");
  assert.equal(CATALOG_FILE_NAME, "catalog.json");
});

// ── surface 1: sync on a Git board (the worktree, before anything is staged) ───

test("F8 sync: each layout in the board worktree is refused before staging; the control syncs", async () => {
  for (const layout of LAYOUTS) {
    const topo = await makeTwoCloneTopology();
    const { dir: home, cleanup } = await scratch("sb-f8-home-");
    try {
      const head = git(topo.a.board, ["rev-parse", "HEAD"]).trim();
      const origin = ref(topo.origin, BOARD_BRANCH);
      await plant(topo.a.board, layout.files);
      const result = await runSync(home, ["--dir", topo.a.root]);
      if (layout.remove.length === 0) {
        assert.equal(result.err, undefined, `${layout.label}: ${result.err?.message}`);
        assert.notEqual(ref(topo.origin, BOARD_BRANCH), origin, "the control's files were published");
        continue;
      }
      assertRefusal(result.err, layout, topo.a.board, "sync");
      assert.equal(result.err!.details?.stage, "files");
      assert.equal(ref(topo.origin, BOARD_BRANCH), origin, `${layout.label}: nothing was pushed`);
      assert.equal(git(topo.a.board, ["rev-parse", "HEAD"]).trim(), head, `${layout.label}: nothing was committed`);
      assert.equal(git(topo.a.board, ["diff", "--cached", "--name-only"]).trim(), "", `${layout.label}: the index stays clean`);
      for (const relative of Object.keys(layout.files)) {
        assert.equal(await readFile(path.join(topo.a.board, relative), "utf8"), layout.files[relative], "the files are left in place");
      }
    } finally {
      await cleanup();
      await topo.cleanup();
    }
  }
});

test("F8 sync: an unpushed commit carrying private state (made by hand) is refused before the push", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: home, cleanup } = await scratch("sb-f8-home-");
  try {
    const layout = LAYOUTS[0]!;
    const origin = ref(topo.origin, BOARD_BRANCH);
    await plant(topo.a.board, layout.files);
    commitBoard(topo.a, "by hand");
    // Removed again in a later commit: the earlier commit's blobs would still be sent.
    git(topo.a.board, ["rm", "-r", "-q", ".superbee-state"]);
    git(topo.a.board, ["commit", "-q", "-m", "removed, but still in history"]);
    const result = await runSync(home, ["--dir", topo.a.root]);
    assertRefusal(result.err, layout, topo.a.board, "sync (commits)");
    assert.equal(result.err!.details?.stage, "commits");
    assert.match(result.err!.help ?? "", /reset --soft origin\/board/);
    assert.equal(ref(topo.origin, BOARD_BRANCH), origin, "nothing was pushed");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("F8 sync: a NAMED board branch (#405) goes through the same refusal", async () => {
  const topo = await makeTwoCloneTopology();
  const { dir: home, cleanup } = await scratch("sb-f8-home-");
  try {
    const name = "board-fairport";
    publishNamedBoard(topo, name);
    const clone = path.join(topo.dir, "named-clone");
    git(topo.dir, ["clone", "--no-local", "--branch", name, topo.origin, clone]);
    const before = ref(topo.origin, name);
    const layout = LAYOUTS[1]!;
    await plant(clone, layout.files);
    const result = await runSync(home, ["--dir", clone]);
    assertRefusal(result.err, layout, clone, "sync (named board)");
    assert.equal(ref(topo.origin, name), before, "the named board is untouched");
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── surface 2: establishment (greenfield snapshot and committed folder) ─────────

test("F8 establish: a greenfield bundle carrying private state publishes nothing and leaves no marker", async () => {
  const topo = await makeGreenfieldTopology();
  const { dir: home, cleanup } = await scratch("sb-f8-home-");
  try {
    await initPlainBundleDir(topo.a);
    const layout = LAYOUTS[0]!;
    await plant(topo.a.board, layout.files);
    const result = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assertRefusal(result.err, layout, topo.a.board, "sync --establish");
    assert.equal(ref(topo.origin, BOARD_BRANCH), null, "no board was published");
    assert.equal(ref(topo.a.root, `refs/heads/${BOARD_BRANCH}`), null, "no local board branch");
    assert.equal(gitTry(topo.a.root, ["config", "--get-regexp", "superbee"]).stdout.includes("establish"), false, "no recovery marker");
    // Moving the state out is the whole remedy.
    await rm(path.join(topo.a.board, ".superbee-state"), { recursive: true });
    const retried = await runSync(home, ["--establish", "--dir", topo.a.root]);
    assert.equal(retried.err, undefined, retried.err?.message);
    assert.notEqual(ref(topo.origin, BOARD_BRANCH), null);
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

test("F8 establish: a committed bundle folder carrying private state is refused before any board ref exists", async () => {
  const topo = await makeCommittedFolderTopology();
  const { dir: home, cleanup } = await scratch("sb-f8-home-");
  try {
    const layout = LAYOUTS[3]!;
    const bundle = path.join(topo.a.root, ".superbee");
    await plant(bundle, layout.files);
    git(topo.a.root, ["add", "-A"]);
    git(topo.a.root, ["commit", "-q", "-m", "a credential committed into the bundle"]);
    for (const argv of [["--establish", "--dir", topo.a.root], ["--establish", "--yes", "--dir", topo.a.root]]) {
      const result = await runSync(home, argv);
      assertRefusal(result.err, layout, bundle, `sync ${argv.join(" ")}`);
      assert.equal(ref(topo.origin, BOARD_BRANCH), null, "no board was published");
      assert.equal(ref(topo.a.root, `refs/heads/${BOARD_BRANCH}`), null, "no local board branch was created");
    }
  } finally {
    await cleanup();
    await topo.cleanup();
  }
});

// ── surface 3 and 4: publish --to hosted, and hosted checkout sync ─────────────

const ROOT = '---\nokf_version: "0.2"\ntitle: Team notes\n---\n# Team notes\n';

async function hostedBundle(folder: string): Promise<void> {
  await plant(folder, { "index.md": ROOT, "notes/alpha.md": "---\ntype: Note\ntitle: Alpha\n---\nAlpha.\n" });
}

async function runPublish(home: string, cwd: string, argv: string[], fake: FakeCreateHost): Promise<{ out: string; err?: CliError }> {
  const out: string[] = [];
  const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
  try {
    await publish(argv, { stdout: (text) => void out.push(text), stderr: () => {}, auth, cwd, fetch: fake.fetch });
    return { out: out.join("") };
  } catch (err) {
    if (err instanceof CliError) return { out: out.join(""), err };
    throw err;
  }
}

test("F8 publish --to hosted: each layout refuses the preview and --yes before any request; the control publishes", async () => {
  for (const layout of LAYOUTS.filter((row) => row.hosted)) {
    const { dir, cleanup } = await scratch("sb-f8-publish-");
    try {
      const home = path.join(dir, "home");
      const folder = path.join(dir, "bundle");
      await mkdir(home);
      await hostedBundle(folder);
      await plant(folder, layout.files);
      const fake = new FakeCreateHost();
      if (layout.remove.length === 0) {
        const created = await runPublish(home, dir, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake);
        assert.equal(created.err, undefined, `${layout.label}: ${created.err?.message}`);
        assert.equal(fake.creates.length, 1);
        continue;
      }
      for (const argv of [["--to", "hosted", "--dir", folder, "--host", HOST], ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"]]) {
        const result = await runPublish(home, dir, argv, fake);
        assertRefusal(result.err, layout, folder, "publish");
      }
      assert.equal(fake.requests.length, 0, `${layout.label}: no request was made`);
    } finally {
      await cleanup();
    }
  }
});

test("F8 hosted sync: private state copied into a hosted checkout refuses the run before anything is sent", async () => {
  const { dir, cleanup } = await scratch("sb-f8-hosted-");
  try {
    const home = path.join(dir, "home");
    const folder = path.join(dir, "bundle");
    await mkdir(home);
    await hostedBundle(folder);
    const fake = new FakeCreateHost();
    const created = await runPublish(home, dir, ["--to", "hosted", "--dir", folder, "--host", HOST, "--yes"], fake);
    assert.equal(created.err, undefined, created.err?.message);
    const binding = await bindingForPath(home, folder);
    assert.ok(binding, "the folder is a hosted checkout");
    const sent = fake.requests.length;
    for (const layout of LAYOUTS.filter((row) => row.hosted && row.remove.length > 0)) {
      await plant(folder, layout.files);
      const auth = defaultHostedAuthDeps(home, { env: { SUPERBEE_ACCESS_TOKEN: TOKEN }, fetch: async () => { throw new Error("no sign-in"); } });
      let error: CliError | undefined;
      try {
        await hostedSync(["--dir", folder], binding, { auth, cwd: dir, fetch: fake.fetch, stdout: () => {} });
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        error = err;
      }
      assertRefusal(error, layout, folder, "hosted sync");
      assert.equal(fake.requests.length, sent, `${layout.label}: nothing was sent`);
      for (const relative of layout.remove) await rm(path.join(folder, ...relative.split("/")), { recursive: true });
    }
  } finally {
    await cleanup();
  }
});
