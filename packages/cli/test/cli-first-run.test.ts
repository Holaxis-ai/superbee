// The first run of the hosted CLI on a machine with no sign-in: what an agent sees before and
// during its first `login`, and when its sandbox will not let it write the private state root.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CliError, EXIT } from "../src/errors.js";
import { resolveHostedTarget } from "../src/hosted-auth/discovery.js";
import {
  PUBLIC_HOSTED_ORIGIN,
  defaultHostedAuthDeps,
  ensureHostedAccessToken,
  hostedWriteHost,
  requireHostedBundleHost,
} from "../src/hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { login, logout, whoami } from "../src/commands/hosted-auth.js";
import { catalog } from "../src/commands/catalog.js";
import { canonicalUserStateDir, ensureUserStateRoot, userStateWriteRefusal } from "../src/user-state.js";
import { FakeIssuer } from "./support/fake-issuer.js";

const FIRST_SIGN_IN = new RegExp(`superbee login --host ${PUBLIC_HOSTED_ORIGIN.replace(/[.]/g, "\\.")}$`);

async function freshHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sb-first-run-"));
}

function freshDeps(home: string) {
  // No SUPERBEE_HOST, no remembered sign-in, no stored session: a first run.
  return defaultHostedAuthDeps(home, { env: { [CREDENTIAL_STORE_ENV]: "file" } });
}

test("first run: whoami and logout report not signed in (exit 0) with the exact sign-in command", async () => {
  const home = await freshHome();
  try {
    let out = "";
    const io = { stdout: (text: string) => void (out += text), stderr: () => {}, auth: freshDeps(home) };
    await whoami(["--json"], io);
    const me = JSON.parse(out) as Record<string, unknown>;
    assert.equal(me.signed_in, false);
    assert.equal(me.status, "not_signed_in");
    assert.equal(me.host, null);
    assert.match(String((me.help as string[])[0]), FIRST_SIGN_IN);

    out = "";
    await logout(["--json"], io);
    const gone = JSON.parse(out) as Record<string, unknown>;
    assert.equal(gone.signed_out, false);
    assert.equal(gone.status, "not_signed_in");
    // Reading who is signed in must not create the private state root.
    await assert.rejects(stat(canonicalUserStateDir(home)), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("first run: hosted reads and writes with no host are AUTH_REQUIRED not_signed_in, never a USAGE error or a silent host", async () => {
  const home = await freshHome();
  try {
    const assertNotSignedIn = (e: unknown): boolean => {
      assert.ok(e instanceof CliError, String(e));
      assert.equal(e.code, "AUTH_REQUIRED");
      assert.equal(e.exitCode, EXIT.AUTH);
      assert.equal(e.details?.status, "not_signed_in");
      assert.match(String(e.details?.sign_in_command), FIRST_SIGN_IN);
      assert.match(e.help ?? "", FIRST_SIGN_IN);
      return true;
    };
    await assert.rejects(requireHostedBundleHost(undefined, home), assertNotSignedIn);
    await assert.rejects(
      catalog(["list", "--hosted", "--json"], { stdout: () => {}, home: () => home, auth: freshDeps(home) }),
      assertNotSignedIn,
    );
    // Writes keep #367: with no host there is nothing to pick, and nothing is picked.
    assert.equal(await hostedWriteHost(undefined, home, (host) => host), null);
    // login itself must be told which host: SUPERBEE_HOST or --host, never a default.
    await assert.rejects(
      login(["--json"], { stdout: () => {}, stderr: () => {}, auth: freshDeps(home) }),
      (e: CliError) => e.code === "USAGE" && FIRST_SIGN_IN.test((e.help ?? "").replace(/\) or set .*$/, "")),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a sign-in waiting on the person says so: status waiting_for_confirmation, 'not an error', exit 4", async () => {
  const home = await freshHome();
  const issuer = await new FakeIssuer({ now: () => Date.now() }).start();
  try {
    const deps = freshDeps(home);
    let caught: unknown;
    try {
      await ensureHostedAccessToken(resolveHostedTarget(issuer.base), {}, deps);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CliError);
    assert.equal(caught.exitCode, EXIT.AUTH);
    assert.equal(caught.details?.status, "waiting_for_confirmation");
    assert.match(caught.message, /^waiting for the person to confirm sign-in to .* \(not an error\)/);
    assert.ok(caught.details?.sign_in_url);
  } finally {
    await issuer.stop();
    await rm(home, { recursive: true, force: true });
  }
});

const posixOwner = process.platform !== "win32" && process.getuid?.() !== 0;

test("an existing private state root at 0700 is not chmodded again (a sandbox may refuse that write)", { skip: !posixOwner }, async () => {
  const home = await freshHome();
  try {
    const root = await ensureUserStateRoot(home);
    const before = await stat(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ensureUserStateRoot(home);
    const after = await stat(root);
    assert.equal(after.mode & 0o7777, 0o700);
    // chmod updates ctime even when the mode is unchanged; an untouched root keeps it.
    assert.equal(after.ctimeMs, before.ctimeMs);

    await chmod(root, 0o755);
    await ensureUserStateRoot(home);
    assert.equal((await stat(root)).mode & 0o7777, 0o700, "drifted permissions are still repaired");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a home the process may not write names the state directory, the cause and the fix", { skip: !posixOwner }, async () => {
  const home = await freshHome();
  try {
    await chmod(home, 0o500);
    let caught: unknown;
    try {
      await ensureUserStateRoot(home);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CliError, String(caught));
    assert.equal(caught.code, "RUNTIME");
    assert.equal(caught.details?.reason, "state_dir_not_writable");
    assert.equal(caught.details?.path, "~/.superbee-state");
    assert.equal(caught.details?.errno, "EACCES");
    assert.match(caught.message, /sandbox/);
    assert.match(caught.help ?? "", /allow this agent to write ~\/\.superbee-state/);
    assert.ok(!caught.message.includes(home), "the refusal names the root by its ~ spelling");
  } finally {
    await chmod(home, 0o700);
    await rm(home, { recursive: true, force: true });
  }
});

test("only refused writes under the state root (or home itself) are translated", async () => {
  const home = await freshHome();
  try {
    const root = canonicalUserStateDir(home);
    const errnoError = (code: string, target: string) => Object.assign(new Error(code), { code, path: target, syscall: "mkdir" });
    assert.ok(userStateWriteRefusal(errnoError("EPERM", path.join(root, "hosted-auth")), home));
    assert.ok(userStateWriteRefusal(errnoError("EROFS", root), home));
    assert.equal(userStateWriteRefusal(errnoError("EPERM", path.join(home, "project", "x")), home), null);
    assert.equal(userStateWriteRefusal(errnoError("EPERM", `${root}-other`), home), null);
    assert.equal(userStateWriteRefusal(errnoError("ENOSPC", root), home), null);
    assert.equal(userStateWriteRefusal(new Error("plain"), home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
