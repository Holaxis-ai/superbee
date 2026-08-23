/**
 * `doc write`'s F1 body-blanking guard, exercised against the BUILT CLI (`dist/agentstate-lite.mjs`)
 * over a real subprocess — NOT the in-process command function `doc.test.ts` calls directly.
 *
 * Round-review finding (P1, BLOCKING): the guard was bypassed in agent harnesses because
 * `defaultReadStdin` decided pipe-vs-no-input solely via `process.stdin.isTTY`. In-process tests that
 * inject a `readStdin` override (every test in `doc.test.ts`) never exercise `defaultReadStdin` at
 * all, so they could not have caught this — the bug only reproduces through the REAL adapter, reading
 * REAL `process.stdin` of a REAL child process, which is exactly what an agent harness hands a spawned
 * CLI. This file is that missing test class: it spawns the actual built binary with stdin redirected
 * from `/dev/null` (a character device — `isTTY === undefined`, neither a TTY nor a real pipe, the
 * precise agent-harness shape the live-verified bug reproduced in) and asserts the guard still fires.
 *
 * `test.before` builds the CLI once (`node build.mjs local-dev` in this package) so the test is self-contained
 * regardless of invocation order — no other test file in this package needs the built artifact, so
 * there is no existing "build once" convention to reuse (see CONTRIBUTING.md's running checks: `npm run
 * build` normally precedes `npm test` in `npm run check`, but a bare `npm test -w @holaxis/aslite`
 * does not build first).
 *
 * Platform note discovered while writing this file (see `hasRealStdinInput`'s comment in doc.ts):
 * `spawnSync(cmd, { input })`/`spawn(cmd, { stdio: ["pipe", …] })` feed a child's stdin through
 * Node's OWN "pipe" stdio implementation, which on macOS is an `AF_UNIX` socketpair, NOT a POSIX
 * FIFO — a genuinely different fd type from the FIFO a SHELL `|` operator creates. Both are exercised
 * below (a Node-piped test and a real `sh -c '… | …'` shell-piped test) since real agent harnesses
 * use both mechanisms.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { initBundle, readDoc, writeDoc } from "@superbee/core";
import { commitBoard, makeTwoCloneTopology, pushBoard, writeBoardDoc } from "../../board-git/test/git-harness.js";
import { STDIN_SILENT_NOTE } from "../src/commands/doc/common.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");

const OLD_TS = "2020-01-01T00:00:00.000Z";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-cli-integration-"));
}

// Build ONLY if the bundle is absent. The package's `test` script builds once up front, so under
// `npm test` / `npm run check` this is a no-op — which is what keeps two build-in-a-before-hook
// integration files from launching CONCURRENT `vite build`s that clobber packages/ui/dist (the
// node --test runner runs files in parallel). Building here still supports running THIS file alone.
before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

test("built CLI: raw doc-read channels route early missing-id and unknown-option envelopes only to stderr", () => {
  const cases = [
    ["doc", "read", "--body-out", "-"],
    ["doc", "read", "concepts/a", "--body-out=-", "--unknown"],
    ["doc", "read", "concepts/a", "--body-out", " - ", "--unknown"],
    ["doc", "read", "concepts/a", "--body-out= - ", "--unknown"],
    ["doc", "read", "concepts/a", "--out=-", "--unknown"],
    ["doc", "read", "concepts/a", "--out", " - ", "--unknown"],
    ["doc", "read", "concepts/a", "--out= - ", "--unknown"],
    ["doc", "read", "--rendered-out", "-"],
    ["doc", "read", "concepts/a", "--rendered-out=-", "--unknown"],
    ["doc", "read", "concepts/a", "--rendered-out", " - ", "--unknown"],
    ["doc", "read", "concepts/a", "--rendered-out= - ", "--unknown"],
  ];
  for (const args of cases) {
    const result = spawnSync("node", [cliBin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    assert.equal(result.status, 2, `expected USAGE exit 2 for ${args.join(" ")}`);
    assert.equal(result.stdout, "", "stdout remains a pure, empty byte channel on early failure");
    assert.match(result.stderr, /code: USAGE/);
    assert.equal((result.stderr.match(/code: USAGE/g) ?? []).length, 1, "the envelope is emitted exactly once");
  }
});

test("built CLI: doc write guard refuses to blank an EXISTING doc's body when stdin is redirected from /dev/null (agent-harness shape — no TTY, no real pipe, isTTY undefined)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeDoc(
      { root: dir },
      { id: "concepts/a", frontmatter: { type: "Concept", title: "A", timestamp: OLD_TS }, body: "Original body." },
    );

    // stdio: ["ignore", ...] redirects the child's stdin to /dev/null — a character device, exactly
    // the fd shape many agent harnesses hand a spawned process (not a TTY, not a real pipe/FIFO).
    const result = spawnSync(
      "node",
      [cliBin, "doc", "write", "concepts/a", "--type", "Concept", "--title", "New Title", "--dir", dir, "--json"],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );

    assert.equal(
      result.status,
      2,
      `expected USAGE exit 2, got ${result.status}; stdout=${result.stdout} stderr=${result.stderr}`,
    );
    // Error envelopes render as TOON on stdout regardless of --json (output.ts: formatError never
    // sees per-invocation flags) — assert on the TOON shape, not JSON.parse.
    assert.match(result.stdout ?? "", /code: USAGE/);
    assert.match(result.stdout ?? "", /body source/);

    // Nothing was touched — the original body survives on disk.
    const after = await readFile(path.join(dir, "concepts", "a.md"), "utf8");
    assert.match(after, /Original body\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: a REAL non-empty stdin pipe (Node child_process 'pipe' stdio) still works as an explicit body source and replaces an EXISTING doc's body", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeDoc(
      { root: dir },
      { id: "concepts/b", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "Original body." },
    );

    // `input` makes child_process feed this content to the child's stdin via its own "pipe" stdio
    // implementation — on this platform (macOS) that is a connected AF_UNIX socket, not a POSIX FIFO
    // (see `hasRealStdinInput`'s comment in doc.ts); this exercises that exact path, which is also
    // the shape many Node-based agent harnesses use to pipe real content into a spawned CLI.
    const result = spawnSync(
      "node",
      [cliBin, "doc", "write", "concepts/b", "--type", "Concept", "--dir", dir, "--json"],
      { input: "Piped replacement body.", encoding: "utf8" },
    );

    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}; stdout=${result.stdout} stderr=${result.stderr}`,
    );
    const after = await readFile(path.join(dir, "concepts", "b.md"), "utf8");
    assert.match(after, /Piped replacement body\./);
    assert.doesNotMatch(after, /Original body\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: a REAL shell pipe (printf 'x' | agentstate-lite …, a genuine POSIX FIFO) still works as an explicit body source", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeDoc(
      { root: dir },
      { id: "concepts/c", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "Original body." },
    );

    // Routed through `sh -c '… | …'` so the PIPE ITSELF is created by the shell (a genuine POSIX
    // FIFO on every platform), not by Node's own child_process stdio machinery — the literal
    // `printf 'x' | agentstate-lite …` shape the round-review handback asked to be verified live.
    const quotedDir = dir.replace(/'/g, "'\\''");
    const shellCmd = `printf '%s' 'Shell-piped body.' | node ${JSON.stringify(cliBin)} doc write concepts/c --type Concept --dir '${quotedDir}' --json`;
    const result = spawnSync("sh", ["-c", shellCmd], { encoding: "utf8" });

    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}; stdout=${result.stdout} stderr=${result.stderr}`,
    );
    const after = await readFile(path.join(dir, "concepts", "c.md"), "utf8");
    assert.match(after, /Shell-piped body\./);
    assert.doesNotMatch(after, /Original body\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Live-incident repro: `doc update <id> --title … --description …` (a FIELD-ONLY patch, no
 * --body/--body-file) hung forever when stdin was an OPEN pipe/socket that was never written to and
 * never closed — the shape many agent harnesses hand a spawned process by default (a Node
 * `child_process` "pipe" fd 0 that the parent keeps its write end of, without writing or calling
 * `.end()`). `hasRealStdinInput` correctly reports this fd as a real data source (unlike the
 * character-device false positive the round-review fix above closes), so the old code's unconditional
 * stdin read for a body-less `doc update` blocked on an EOF that would never arrive. Uses real async
 * `spawn` (NOT `spawnSync`, which would block the test's own event loop) with a bounded timeout that
 * kills the child and fails the test if it doesn't exit in time — the affirmative "still hangs"
 * behavior was confirmed live against the pre-fix code before this test was added.
 */
test("built CLI: a FIELD-ONLY `doc update` (--title/--description, no --body/--body-file) never touches stdin — completes promptly even when stdin is an OPEN pipe that is never written to or closed", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeDoc(
      { root: dir },
      { id: "concepts/d", frontmatter: { type: "Concept", title: "Old Title", timestamp: OLD_TS }, body: "Original body." },
    );

    const child = spawn(
      "node",
      [
        cliBin,
        "doc",
        "update",
        "concepts/d",
        "--title",
        "New Title",
        "--description",
        "New desc",
        "--dir",
        dir,
        "--json",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // Deliberately never write to child.stdin and never call .end() on it — the pipe's write end
    // stays open (held by this test process) for the child's entire lifetime, so a read-to-EOF on fd 0
    // would never complete.

    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const BOUND_MS = 5000;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`doc update did not exit within ${BOUND_MS}ms — it must not block on stdin here`));
      }, BOUND_MS);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}; stdout=${stdout}`);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(result.changed, true);

    const after = await readFile(path.join(dir, "concepts", "d.md"), "utf8");
    assert.match(after, /title: New Title/);
    assert.match(after, /description: New desc/);
    // The body is untouched — stdin was never consumed as a body source for this field-only patch.
    assert.match(after, /Original body\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: `doc update` with NO other field flags still accepts a real piped stdin body as a last-resort body source (preserves `cat body.md | … doc update <id>`)", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeDoc(
      { root: dir },
      { id: "concepts/e", frontmatter: { type: "Concept", title: "T", timestamp: OLD_TS }, body: "Original body." },
    );

    const result = spawnSync("node", [cliBin, "doc", "update", "concepts/e", "--dir", dir, "--json"], {
      input: "Piped patch body.",
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}; stdout=${result.stdout} stderr=${result.stderr}`,
    );
    const after = await readFile(path.join(dir, "concepts", "e.md"), "utf8");
    assert.match(after, /Piped patch body\./);
    assert.doesNotMatch(after, /Original body\./);
    assert.match(after, /title: T/); // untouched
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── tasks/doc-write-stdin-open-pipe-hang: bound the stdin probe's wait for the FIRST byte ──────
//
// Live-reproduced (see the board task): `doc write` with NO --body/--body-file falls back to
// probing piped stdin for a body; when stdin is a genuinely OPEN pipe/socket (`hasRealStdinInput`
// correctly says "real data source") that never sends data and never closes — exactly how an agent
// harness's `child_process.spawn(cli, { stdio: ["pipe", …] })` commonly wires a spawned process's
// fd 0, and exactly the shape `doc.ts`'s own header comment already flagged as "would hang the same
// way ... left unchanged" before this fix — the read blocked FOREVER on an EOF that would never
// arrive. `doc write` (unlike `doc update`'s field-only path above) legitimately needs stdin as its
// PRIMARY documented body channel even when other flags are given, so it cannot be gated away the
// way `doc update`'s field-only case was; it needed the READ ITSELF bounded instead
// (`readStdinBounded` in `doc/common.ts`).

test("built CLI: `doc write` with NO body source completes PROMPTLY (does not hang) when stdin is an OPEN pipe that is never written to or closed — the live-reproduced hang this fix closes", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    // A BRAND-NEW id — a new doc with no body source is always a valid creation (no F1 guard to
    // interfere), isolating the assertion to the stdin-probe bound itself.
    const child = spawn(
      "node",
      [cliBin, "doc", "write", "concepts/open-pipe", "--type", "Concept", "--title", "Open pipe", "--dir", dir, "--json"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // Deliberately never write to child.stdin and never call .end() on it — the pipe's write end
    // stays open (held by THIS test process) for the child's entire lifetime. A pre-fix run of this
    // exact test (bound removed — the unconditional `for await` restored) was confirmed live to hang
    // until the BOUND_MS kill fires below; that is this test's own red-proof.

    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const start = Date.now();
    const BOUND_MS = 5000; // generous relative to the ~200ms production bound — never flaky, never a real hang
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`doc write did not exit within ${BOUND_MS}ms — it must not block on stdin here`));
      }, BOUND_MS);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const elapsedMs = Date.now() - start;

    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}; stdout=${stdout}`);
    assert.ok(elapsedMs < BOUND_MS, `expected a prompt exit well under ${BOUND_MS}ms, took ${elapsedMs}ms`);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(result.doc, "written");
    // The residual silent case is NOT silent: a write that proceeded with an empty body because a
    // real open pipe stayed quiet past the probe bound says so on its receipt — an agent whose slow
    // producer's bytes arrived too late can tell this apart from a deliberate body-less write.
    assert.equal(result.note, STDIN_SILENT_NOTE);

    const saved = await readDoc({ root: dir }, "concepts/open-pipe");
    assert.equal(saved.body, "\n", "no body source arrived within the bound — an empty body, exactly the documented empty-pipe semantics");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: a legit piped body arriving AFTER the first-byte bound has started (a slow multi-chunk write spanning well past it) is still read to completion, byte-exact — the bound only guards the FIRST byte, never an in-progress transfer", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const child = spawn(
      "node",
      [cliBin, "doc", "write", "concepts/slow-pipe", "--type", "Concept", "--dir", dir, "--json"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));

    // First chunk arrives immediately (well inside the ~200ms bound), disarming it permanently;
    // the second chunk arrives 600ms later — well PAST the bound — proving the bound never re-arms
    // mid-transfer.
    child.stdin.write("chunk-one ");
    setTimeout(() => {
      child.stdin.write("chunk-two");
      child.stdin.end();
    }, 600);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("doc write did not exit — a slow multi-chunk piped body must still be read to completion"));
      }, 5000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}; stdout=${stdout}`);
    // A DELIVERED piped body is not the silent-timeout path — no note.
    assert.equal("note" in (JSON.parse(stdout) as Record<string, unknown>), false);
    const saved = await readDoc({ root: dir }, "concepts/slow-pipe");
    // BYTE-EXACT pin of the legit piped-body path (the DoD's explicit ask): the FULL, exact
    // concatenation of both chunks, with the engine's usual single trailing-newline normalization —
    // no truncation, no dropped bytes, no timeout artifact.
    assert.equal(saved.body, "chunk-one chunk-two\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: `--body \"\"` (explicit empty) never consults stdin — a byte sitting in an open, never-closed pipe on fd 0 neither contaminates the body nor hangs the process", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const child = spawn(
      "node",
      [cliBin, "doc", "write", "concepts/explicit-empty", "--type", "Concept", "--body", "", "--dir", dir, "--json"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // The child normally exits while this parent still holds the pipe; a write racing that exit can
    // surface EPIPE on the parent's stream — expected here, never a failure.
    child.stdin.on("error", () => {});
    // CONTENT-BASED discrimination, no wall-clock assertion anywhere (a whole-child-lifetime bound
    // like the earlier `elapsedMs < 150` was machine-dependent by construction — node boot + bundle
    // load vary per runner). A byte goes into the pipe IMMEDIATELY and the pipe is NEVER closed: if
    // `--body ""` ever regressed to consult stdin, the bounded probe would see this byte, disarm its
    // first-byte timeout, and read on toward an EOF that never comes — a hang this test's kill-timer
    // turns red deterministically — or, were the byte delivered as the body instead, the byte-exact
    // empty-body assertion below fails. (A DELAYED write — e.g. at ~300ms — would race the ~200ms
    // probe bound: a byte landing after a hypothetical probe's timeout would let that regression
    // slip green, so the byte is written up front, before the child can possibly probe.)
    child.stdin.write("must-never-be-consumed");

    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("doc write --body '' must never touch stdin, and so must never wait on it"));
      }, 5000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}; stdout=${stdout}`);
    const receipt = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(receipt.doc, "written");
    assert.equal("note" in receipt, false, "--body '' is an explicit source — never the silent-stdin-timeout path");
    const saved = await readDoc({ root: dir }, "concepts/explicit-empty");
    // Still EMPTY: the byte waiting in the pipe never reached the body — --body "" is the one
    // unambiguous explicit-empty channel and stdin was never consulted.
    assert.equal(saved.body, "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: a NEW-doc `doc write` with stdin from /dev/null (no real data source — never probed, never timed out) succeeds with NO silent-stdin note", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    // stdio: ["ignore", …] = /dev/null on fd 0 — a character device `hasRealStdinInput` rejects
    // up front, so the bounded probe (and its timeout sentinel) never runs at all.
    const result = spawnSync(
      "node",
      [cliBin, "doc", "write", "concepts/devnull-new", "--type", "Concept", "--title", "T", "--dir", dir, "--json"],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );

    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}; stdout=${result.stdout} stderr=${result.stderr}`,
    );
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(receipt.doc, "written");
    assert.equal("note" in receipt, false, "no-real-source stdin is not the silent-TIMEOUT path — no note");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: `doc update` with NO field flags and an OPEN-never-written pipe on stdin exits PROMPTLY with USAGE (never hangs) and NAMES the silent-stdin condition — the same signal doc write's receipt carries", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeDoc(
      { root: dir },
      { id: "concepts/no-fields", frontmatter: { type: "Concept", title: "T", timestamp: OLD_TS }, body: "Original body." },
    );

    // No field flags at all, so update's LAST-RESORT stdin consultation runs — against a pipe whose
    // write end this test holds open forever without writing. Pre-fix, this exact shape read to EOF
    // and hung; post-fix it must exit USAGE promptly, and the error must say WHY there was nothing
    // to patch (the caller's piped body may simply have arrived too late).
    const child = spawn("node", [cliBin, "doc", "update", "concepts/no-fields", "--dir", dir, "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("doc update did not exit — the bounded probe must keep the no-field path from hanging"));
      }, 5000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 2, `expected USAGE exit 2, got ${exitCode}; stdout=${stdout}`);
    // Error envelopes render as TOON on stdout (see the F1 guard test above's identical note).
    assert.match(stdout, /code: USAGE/);
    assert.match(stdout, /requires at least one field to patch/);
    assert.ok(stdout.includes(STDIN_SILENT_NOTE), `the envelope must name the silent-stdin condition; stdout=${stdout}`);

    // Nothing was touched.
    const after = await readFile(path.join(dir, "concepts", "no-fields.md"), "utf8");
    assert.match(after, /Original body\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the opportunistic-pull DEFAULT-WIRING pin (autopull fix round, MEDIUM 3) ────────────────────
//
// Every IN-PROCESS suite either injects the `autoPull` seam or runs under the suite-wide
// AGENTSTATE_LITE_NO_AUTOPULL=1 knob (packages/cli's test script) — so deleting the default
// `deps.autoPull ?? maybeAutoPull` binding in the read commands would still pass all of them.
// This test spawns the BUILT CLI with the knob explicitly DELETED from the child env, in a real
// two-clone topology, and requires the read ITSELF to have pulled the teammate's pushed doc —
// only the live default wiring can make that pass. The second half pins the documented knob
// semantics: "0" is a non-empty value, so it DISABLES too (the variable's PRESENCE is the
// switch). This file (the one place that builds the real CLI — a second concurrent `build.mjs`
// in another test file would race on dist/) is deliberately where this pin lives.

test("built CLI: default auto-pull wiring is LIVE — `list` pulls a stale board with the knob deleted from the child env; '0' still disables", async () => {
  const topo = await makeTwoCloneTopology();
  const childHomeA = await tempDir(); // isolated ~/.agentstate for the first child (no state → stale)
  const childHomeB = await tempDir(); // …and a separate one for the knob="0" child (also stale)
  try {
    await writeBoardDoc(topo.a, "tasks/wired-in", {
      frontmatter: { type: "Task", title: "Wired in", actor: "mike" },
      body: "# Wired in\n",
    });
    commitBoard(topo.a, "board: A adds tasks/wired-in");
    pushBoard(topo.a);

    const env = { ...process.env, HOME: childHomeA, USERPROFILE: childHomeA };
    delete env.AGENTSTATE_LITE_NO_AUTOPULL;
    const r = spawnSync("node", [cliBin, "list", "--dir", topo.b.board], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(
      r.stdout ?? "",
      /tasks\/wired-in/,
      "the DEFAULT-wired trigger must pull A's pushed doc into B before serving the read",
    );

    // Knob semantics: "0" is non-empty → disables. Fresh child HOME (no state → stale), so the
    // pull WOULD fire here if "0" were ever treated as falsey.
    await writeBoardDoc(topo.a, "tasks/knob-zero", {
      frontmatter: { type: "Task", title: "Knob zero", actor: "mike" },
      body: "# Knob zero\n",
    });
    commitBoard(topo.a, "board: A adds tasks/knob-zero");
    pushBoard(topo.a);

    const envZero = {
      ...process.env,
      HOME: childHomeB,
      USERPROFILE: childHomeB,
      AGENTSTATE_LITE_NO_AUTOPULL: "0",
    };
    const r2 = spawnSync("node", [cliBin, "list", "--dir", topo.b.board], {
      env: envZero,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(r2.status, 0, `expected exit 0, got ${r2.status}; stdout=${r2.stdout} stderr=${r2.stderr}`);
    assert.match(r2.stdout ?? "", /tasks\/wired-in/, "B still serves what the first read pulled");
    assert.doesNotMatch(
      r2.stdout ?? "",
      /tasks\/knob-zero/,
      "AGENTSTATE_LITE_NO_AUTOPULL='0' must DISABLE the pull — presence is the switch",
    );
  } finally {
    await topo.cleanup();
    await rm(childHomeA, { recursive: true, force: true });
    await rm(childHomeB, { recursive: true, force: true });
  }
});

// Extract and execute the actual help example from the bundle root. The documented outside-path
// placeholder is substituted with a file in this test's unique scratch tree, never a shared path.

test("built CLI: `doc read --help`'s documented safe-edit-cycle example, extracted from the ACTUAL help text and run from the bundle root with placeholders substituted, succeeds end to end", async () => {
  const scratch = await tempDir();
  const dir = path.join(scratch, "bundle");
  const bodyOutTarget = path.join(scratch, "body.md");
  try {
    await initBundle(dir);
    await writeDoc(
      { root: dir },
      { id: "concepts/a", frontmatter: { type: "Concept", title: "A", timestamp: OLD_TS }, body: "Original body." },
    );

    const helpText = execFileSync("node", [cliBin, "doc", "read", "--help"], { encoding: "utf8" });

    // Extract the exact two example lines (never a hand-copied literal — a drift in the source
    // string would change what this regex matches, and thus what actually runs).
    const readLineMatch = helpText.match(/^ {2,}(superbee doc read <id> --body-out \S+ --json)\s*$/m);
    assert.ok(readLineMatch, `expected a 'doc read <id> --body-out ... --json' example line in:\n${helpText}`);
    const updateLineMatch = helpText.match(
      /^ {2,}(superbee doc update <id> --body-file \S+) \\\n\s*(--expected-version <version>)\s*$/m,
    );
    assert.ok(updateLineMatch, `expected a two-line 'doc update <id> --body-file ... --expected-version <version>' example in:\n${helpText}`);

    assert.match(readLineMatch![1]!, /--body-out <path-outside-bundle>/);
    assert.match(updateLineMatch![1]!, /--body-file <path-outside-bundle>/);

    const substitute = (line: string, version?: string): string[] => {
      const withId = line
        .replace(/<id>/g, "concepts/a")
        .replace(/<path-outside-bundle>/g, bodyOutTarget)
        .replace(/<version>/g, version ?? "<version>");
      return withId.trim().split(/\s+/).slice(1); // drop the leading 'agentstate-lite' token
    };

    // Run the documented read from the bundle root — the exact shape the help promises.
    const readArgs = substitute(readLineMatch![1]!);
    const readResult = spawnSync("node", [cliBin, ...readArgs], { cwd: dir, encoding: "utf8" });
    assert.equal(
      readResult.status,
      0,
      `the documented example must succeed when copy-pasted from the bundle root; ` +
        `stdout=${readResult.stdout} stderr=${readResult.stderr}`,
    );
    const readReceipt = JSON.parse(readResult.stdout) as Record<string, unknown>;
    const version = readReceipt.version as string;
    assert.ok(version, "the safe edit cycle depends on the receipt's version");
    const exportedBody = await readFile(bodyOutTarget, "utf8");
    assert.equal(exportedBody, "Original body.\n");

    // Perform the documented manual edit.
    await writeFile(bodyOutTarget, "Edited body.\n", "utf8");

    // Join the documented line continuation and use the receipt's own version.
    const updateLine = `${updateLineMatch![1]} ${updateLineMatch![2]}`;
    const updateArgs = substitute(updateLine, version);
    const updateResult = spawnSync("node", [cliBin, ...updateArgs], { cwd: dir, encoding: "utf8" });
    assert.equal(
      updateResult.status,
      0,
      `the documented follow-up must succeed; stdout=${updateResult.stdout} stderr=${updateResult.stderr}`,
    );

    const after = await readDoc({ root: dir }, "concepts/a");
    assert.equal(after.body, "Edited body.\n", "the safe-edit-cycle example must actually land the edit");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
