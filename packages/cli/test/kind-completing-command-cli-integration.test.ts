/**
 * DoD for `tasks/kind-error-completing-command`: a kind-conformance refusal's `help` field is a
 * LITERAL, ready-to-run `doc update <id>` command — one `--<field> <placeholder>` per violated
 * DECLARED field, an enum-restricted field's placeholder listing its allowed values — run against
 * the BUILT CLI (`dist/superbee.mjs`) over a real subprocess, mirroring
 * `doc-cli-integration.test.ts`'s pattern.
 *
 * The emitted-command-chain discipline (CLAUDE.md: "a review claiming it 'executed' a documented
 * command chain means character-for-character with the emitted artifacts") is honored literally
 * here: this file puts a symlink named `superbee` (the preferred bin) -> the built dist on the
 * CHILD's PATH, so `cliInvocation()` (invocation.ts) resolves to the bare bin name instead of the
 * off-PATH `npx -y superbee` fallback — the emitted `help` string is then DIRECTLY executable (no
 * network, no substitution) by splitting it on whitespace and spawning it verbatim after filling
 * each `<placeholder>` token with a real value. Red-proof for this test: reverting
 * `kind-write.ts`'s `buildCompletingUpdateCommand` (restoring the old fixed `kinds`-pointer help)
 * makes the placeholder-extraction regex find nothing to fill, so the "fill and run" step spawns a
 * bare `doc update <id>` with no field flags — a USAGE error (exit 2, "requires at least one field
 * to patch"), not the exit-0 convergence this test asserts.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");

// Build ONLY if the bundle is absent (see doc-cli-integration.test.ts's identical comment: the
// package `test` script builds once up front, so this is a no-op under `npm test`/`npm run check`).
before(() => {
  if (!existsSync(cliBin)) execFileSync("node", ["build.mjs", "local-dev"], { cwd: cliPackageRoot, stdio: "inherit" });
});

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * Puts a symlink named `superbee` (the preferred bin — BIN_NAMES[0]) -> the built dist on a fresh
 * PATH-only directory, so a child process launched with that directory FIRST on PATH resolves its
 * own `cliInvocation()` to the bare bin name (see invocation.ts's `binNameOnPath`) — making every
 * emitted `help`/follow-up command directly runnable via the SAME bin name, with no `npx`/network
 * involved. Pinning the PREFERRED name keeps the resolution deterministic even when a workspace
 * `node_modules/.bin/aslite` also sits on the inherited PATH.
 */
async function makeBinOnPath(): Promise<{ binDir: string; env: NodeJS.ProcessEnv }> {
  const binDir = await tempDir("superbee-kind-complete-bin-");
  await symlink(cliBin, path.join(binDir, "superbee"));
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
  return { binDir, env };
}

/** Run the bare `superbee` bin (resolved via `env.PATH`) with stdin redirected from /dev/null. */
function run(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("superbee", args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Fill every `<...>` placeholder token in an emitted command string with a REAL value: an
 * enum-listing placeholder (`<a|b|c>`) takes its first alternative; the generic `<value>` token
 * takes a fixed literal. Mirrors what an agent following the printed `help` would do.
 */
function fillPlaceholders(command: string): string {
  return command.replace(/<([^>]+)>/g, (_m, inner: string) => {
    const alts = inner.split("|");
    return alts.length > 1 ? alts[0]! : "filled-value";
  });
}

/**
 * Extract the `help: <value>` line from an error envelope's TOON rendering — error envelopes
 * render as TOON on stdout regardless of `--json` (see `doc-cli-integration.test.ts`'s identical
 * note: `output.ts`'s `formatError` never sees per-invocation flags).
 */
function extractHelpLine(toonStdout: string): string | undefined {
  return /^ {2}help: (.+)$/m.exec(toonStdout)?.[1];
}

test("built CLI: a `doc update --strict` kind refusal's help is a literal completing command that, once filled and executed via the real CLI, converges the doc to conformance", async () => {
  const dir = await tempDir("aslite-kind-complete-bundle-");
  const { env } = await makeBinOnPath();
  try {
    run(["init", "--recipe", "none", "--json"], { cwd: dir, env });
    const recipeResult = run(["recipe", "add", "work-tracking", "--json"], { cwd: dir, env });
    assert.equal(recipeResult.status, 0, `recipe add failed: ${recipeResult.stdout}${recipeResult.stderr}`);

    const write = run(["doc", "write", "tasks/x", "--type", "Task", "--title", "Ship it", "--json"], { cwd: dir, env });
    assert.equal(write.status, 0, `doc write failed: ${write.stdout}${write.stderr}`);
    // Warn-and-write: created despite missing the required 'status' field.
    assert.match(write.stdout, /KIND_FIELD_MISSING/);

    // Trigger the refusal via `doc update --strict` (one of the two surfaces the DoD names) —
    // patching an unrelated standard field so the refusal fires against the doc's FULL resulting
    // frontmatter (still missing 'status'), not just the touched field.
    const refusal = run(
      ["doc", "update", "tasks/x", "--description", "d", "--strict", "--json"],
      { cwd: dir, env },
    );
    assert.equal(refusal.status, 2, `expected USAGE exit 2, got ${refusal.status}: ${refusal.stdout}${refusal.stderr}`);
    const help = extractHelpLine(refusal.stdout);
    assert.ok(help, `the refusal must carry a help fixing command; stdout=${refusal.stdout}`);

    // The help is a LITERAL, bare-bin-resolved completing command naming the violated field.
    assert.equal(help, "superbee doc update tasks/x --progress_status <todo|in_progress|blocked|done|canceled>");

    // Fill the placeholder(s) and execute the string VERBATIM (split on whitespace, spawn as
    // argv[0]/argv[1..]) via the real CLI — no hand-picked replacement flags, no reasonable
    // substitutions beyond filling the printed placeholder tokens.
    const filled = fillPlaceholders(help);
    assert.equal(filled, "superbee doc update tasks/x --progress_status todo");
    const [bin, ...argv] = filled.split(" ");
    assert.equal(bin, "superbee");
    const completing = run(argv, { cwd: dir, env });
    assert.equal(
      completing.status,
      0,
      `the filled completing command must succeed, got ${completing.status}: ${completing.stdout}${completing.stderr}`,
    );

    // Convergence proof: re-running the EXACT command that originally refused now succeeds — the
    // doc has converged to conformance.
    const reconfirm = run(
      ["doc", "update", "tasks/x", "--description", "d2", "--strict", "--json"],
      { cwd: dir, env },
    );
    assert.equal(
      reconfirm.status,
      0,
      `expected the doc to now satisfy the kind, got ${reconfirm.status}: ${reconfirm.stdout}${reconfirm.stderr}`,
    );
    const reconfirmed = JSON.parse(reconfirm.stdout) as Record<string, unknown>;
    assert.equal(reconfirmed.changed, true);
    assert.equal(reconfirmed.warnings, undefined, "no residual kind warnings after convergence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: a `doc write --strict` kind refusal OVERWRITING an EXISTING doc gets the same literal completing command, and executing it converges the doc to conformance", async () => {
  const dir = await tempDir("aslite-kind-complete-bundle-");
  const { env } = await makeBinOnPath();
  try {
    run(["init", "--recipe", "none", "--json"], { cwd: dir, env });
    const recipeResult = run(["recipe", "add", "work-tracking", "--json"], { cwd: dir, env });
    assert.equal(recipeResult.status, 0, `recipe add failed: ${recipeResult.stdout}${recipeResult.stderr}`);

    // Create the doc first (warn-and-write, no --strict) so it EXISTS on disk before the refusal —
    // the scenario `doc update <id>` can actually complete (see the next test for the create case).
    const created = run(["doc", "write", "tasks/z", "--type", "Task", "--title", "Zed", "--json"], { cwd: dir, env });
    assert.equal(created.status, 0, `initial doc write failed: ${created.stdout}${created.stderr}`);

    const refusal = run(
      ["doc", "write", "tasks/z", "--type", "Task", "--title", "Zed2", "--strict", "--json"],
      { cwd: dir, env },
    );
    assert.equal(refusal.status, 2, `expected USAGE exit 2, got ${refusal.status}: ${refusal.stdout}${refusal.stderr}`);
    const help = extractHelpLine(refusal.stdout);
    assert.ok(help, `the refusal must carry a help fixing command; stdout=${refusal.stdout}`);
    assert.equal(help, "superbee doc update tasks/z --progress_status <todo|in_progress|blocked|done|canceled>");

    const filled = fillPlaceholders(help);
    const [bin, ...argv] = filled.split(" ");
    assert.equal(bin, "superbee");
    const completing = run(argv, { cwd: dir, env });
    assert.equal(
      completing.status,
      0,
      `the filled completing command must succeed, got ${completing.status}: ${completing.stdout}${completing.stderr}`,
    );

    // Convergence proof: a fresh --strict validation of the CURRENT persisted doc now succeeds.
    // (NOT re-running the same `doc write --strict` — `doc write` is a FULL replace with a fixed
    // flag set that cannot carry `status`, so repeating it would re-drop the very field the
    // completing command just patched in; `doc update --strict` validates the doc AS PERSISTED.)
    const reconfirm = run(["doc", "update", "tasks/z", "--description", "confirmed", "--strict", "--json"], {
      cwd: dir,
      env,
    });
    assert.equal(
      reconfirm.status,
      0,
      `expected the doc to now satisfy the kind, got ${reconfirm.status}: ${reconfirm.stdout}${reconfirm.stderr}`,
    );
    const reconfirmed = JSON.parse(reconfirm.stdout) as Record<string, unknown>;
    assert.equal(reconfirmed.warnings, undefined, "no residual kind warnings after convergence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("built CLI: a `doc write --strict` kind refusal on a BRAND-NEW doc (nothing persisted) falls back to the generic 'kinds' help — a 'doc update' command would 404 against an id that was never written", async () => {
  const dir = await tempDir("aslite-kind-complete-bundle-");
  const { env } = await makeBinOnPath();
  try {
    run(["init", "--recipe", "none", "--json"], { cwd: dir, env });
    const recipeResult = run(["recipe", "add", "work-tracking", "--json"], { cwd: dir, env });
    assert.equal(recipeResult.status, 0, `recipe add failed: ${recipeResult.stdout}${recipeResult.stderr}`);

    const refusal = run(["doc", "write", "tasks/y", "--type", "Task", "--strict", "--json"], { cwd: dir, env });
    assert.equal(refusal.status, 2, `expected USAGE exit 2, got ${refusal.status}: ${refusal.stdout}${refusal.stderr}`);
    const help = extractHelpLine(refusal.stdout);
    assert.equal(help, "superbee kinds", "a create-time refusal must not emit a doc-update command for an id that was never persisted");

    // Confirm the premise: the doc genuinely does not exist (a 'doc update' would NOT_FOUND).
    const reread = run(["doc", "read", "tasks/y", "--json"], { cwd: dir, env });
    assert.equal(reread.status, 6, "NOT_FOUND — nothing was persisted by the refused write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
