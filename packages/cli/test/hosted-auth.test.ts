// Hosted sign-in against a local fake issuer: discovery, resumable device sign-in (AUTH_REQUIRED),
// refresh rotation, lost-response retry inside the reuse leeway, cross-process single-flight
// refresh, expiry, revocation, env override, per-host/audience isolation, loopback PKCE, and the
// credential-store policy (including a missing keychain).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, EXIT, toExit } from "../src/errors.js";
import {
  PUBLISHED_CLIENT_ID_FIELD,
  discoverHosted,
  resolveClientId,
  resolveHostedTarget,
  trimTrailingSlashes,
} from "../src/hosted-auth/discovery.js";
import {
  ACCESS_TOKEN_ENV,
  REFRESH_REUSE_LEEWAY_MS,
  defaultHostedAuthDeps,
  ensureHostedAccessToken,
  logoutHosted,
  readSession,
  sessionAccount,
  sessionDirFor,
  waitForHostedSignIn,
  type HostedAuthDeps,
} from "../src/hosted-auth/session.js";
import {
  CREDENTIAL_STORE_ENV,
  fileSecretStore,
  macosKeychainStore,
  secretServiceStore,
  selectSecretStore,
  type RunResult,
  type ToolRunner,
} from "../src/hosted-auth/secret-store.js";
import { loopbackSignIn } from "../src/hosted-auth/loopback.js";
import { withSessionLock, HOST_ENV, SESSION_LOCK_ORPHAN_MS } from "../src/hosted-auth/session.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { login, logout, whoami } from "../src/commands/hosted-auth.js";
import { writeUserStateFileAtomic0600 } from "../src/user-state.js";
import { FakeIssuer } from "./support/fake-issuer.js";
import { isolatedUserEnv } from "./support/user-env.js";
import { decode } from "@toon-format/toon";
import { FilesystemMutationLockError, filesystemMutationLockPath } from "@superbee/core";

const here = path.dirname(fileURLToPath(import.meta.url));

class Clock {
  t = Date.parse("2026-09-22T12:00:00Z");
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

interface Harness {
  home: string;
  clock: Clock;
  issuer: FakeIssuer;
  deps: HostedAuthDeps;
  host: string;
  cleanup: () => Promise<void>;
}

async function harness(options: { publishedClientId?: string | null; env?: NodeJS.ProcessEnv; realClock?: boolean } = {}): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-hosted-auth-"));
  const clock = new Clock();
  const now = options.realClock ? () => Date.now() : clock.now;
  const issuer = await new FakeIssuer({ now, ...(options.publishedClientId !== undefined ? { publishedClientId: options.publishedClientId } : {}) }).start();
  const deps = defaultHostedAuthDeps(home, {
    env: { [CREDENTIAL_STORE_ENV]: "file", ...(options.env ?? {}) },
    now,
    sleep: async (ms) => clock.advance(ms),
  });
  return {
    home,
    clock,
    issuer,
    deps,
    host: issuer.base,
    cleanup: async () => {
      await issuer.stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function authRequired(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
    assert.equal(error.code, "AUTH_REQUIRED", error.message);
    return error;
  }
  assert.fail("expected AUTH_REQUIRED");
}

async function signIn(h: Harness): Promise<string> {
  const target = resolveHostedTarget(h.host);
  await authRequired(ensureHostedAccessToken(target, {}, h.deps));
  h.issuer.approve();
  h.clock.advance(1_000);
  const token = await ensureHostedAccessToken(target, {}, h.deps);
  assert.equal(token.source, "sign-in");
  return token.accessToken;
}

async function storedRefreshToken(h: Harness, host = h.host): Promise<string | null> {
  const target = resolveHostedTarget(host);
  return fileSecretStore(h.home, (account) => sessionDirFor(h.home, account)).get(sessionAccount(target));
}

async function expireCachedAccessToken(h: Harness, host = h.host): Promise<void> {
  const target = resolveHostedTarget(host);
  const session = await readSession(h.home, target);
  assert.ok(session);
  await writeUserStateFileAtomic0600(
    h.home,
    sessionDirFor(h.home, sessionAccount(target)),
    "session.json",
    `${JSON.stringify({ ...session, access_token_expires_at_ms: 0 })}\n`,
  );
}

// ---------------------------------------------------------------------------------------------
// Discovery

test("target resolution: an origin means the /mcp audience; a path is its own resource; http only on loopback", () => {
  assert.deepEqual(resolveHostedTarget("https://mcp.getsuperbee.com"), {
    origin: "https://mcp.getsuperbee.com",
    audience: "https://mcp.getsuperbee.com/mcp",
    metadataUrl: "https://mcp.getsuperbee.com/.well-known/oauth-protected-resource/mcp",
  });
  assert.equal(resolveHostedTarget("https://mcp.getsuperbee.com/agents/abc/mcp").audience, "https://mcp.getsuperbee.com/agents/abc/mcp");
  assert.throws(() => resolveHostedTarget("http://mcp.getsuperbee.com"), (e: CliError) => e.code === "USAGE");
  assert.throws(() => resolveHostedTarget("https://user:pw@mcp.getsuperbee.com"), (e: CliError) => e.code === "USAGE");
  assert.equal(resolveHostedTarget("http://127.0.0.1:9/").audience, "http://127.0.0.1:9/mcp");
});

test("discovery reads the issuer and the published client id from protected-resource metadata", async () => {
  const h = await harness();
  try {
    const d = await discoverHosted(h.deps.fetch, resolveHostedTarget(h.host));
    assert.equal(d.issuer, h.issuer.issuer);
    assert.equal(d.publishedClientId, "cli-client");
    assert.match(d.deviceAuthorizationEndpoint ?? "", /\/oauth\/device\/code$/);
    assert.match(d.revocationEndpoint ?? "", /\/oauth\/revoke$/);
  } finally {
    await h.cleanup();
  }
});

test("client id: flag, then env, then host metadata, else a clear USAGE refusal naming the missing field", () => {
  const origin = "https://staging.example";
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  assert.equal(resolveClientId({ flag: "f", env: "e", published: "p", origin }).clientId, "f");
  assert.equal(resolveClientId({ env: "e", published: "p", origin }).clientId, "e");
  assert.deepEqual(resolveClientId({ published: "p", origin }), { clientId: "p", source: "host-metadata" });
  assert.throws(
    () => resolveClientId({ origin, metadataUrl }),
    (e: CliError) =>
      e.code === "USAGE" &&
      e.message === `${origin} publishes no Superbee CLI client id (no superbee_cli_client_id in its protected-resource metadata)` &&
      /--client-id <id>/.test(e.help ?? "") &&
      /SUPERBEE_OAUTH_CLIENT_ID/.test(e.help ?? "") &&
      (e.details as Record<string, unknown>).metadata_url === metadataUrl &&
      (e.details as Record<string, unknown>).field === "superbee_cli_client_id",
  );
  // A malformed published id is the host's defect: refused as RUNTIME, but the overrides still win.
  assert.throws(() => resolveClientId({ origin, publishedMalformed: true }), (e: CliError) => e.code === "RUNTIME" && /malformed superbee_cli_client_id/.test(e.message));
  assert.equal(resolveClientId({ env: "e", publishedMalformed: true, origin }).clientId, "e");
});

// The gateway's protected-resource metadata as the real gateway app answers it with the reviewed
// staging configuration record, captured from superbee-hosted (see the fixture's description).
const CAPTURED_PRM = JSON.parse(readFileSync(path.join(here, "fixtures", "hosted-auth", "protected-resource-metadata-200.json"), "utf8")) as {
  route: string;
  response: { status: number; headers: Record<string, string>; body: string };
};

/** Keys and value types all the way down: the contract the fake's metadata must keep with the host's. */
function prmShape(value: unknown): unknown {
  if (Array.isArray(value)) return ["array", ...new Set(value.map((item) => JSON.stringify(prmShape(item))))];
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, prmShape((value as Record<string, unknown>)[key])]));
  }
  return value === null ? "null" : typeof value;
}

test("captured contract: the fake's protected-resource metadata has the host's shape, including superbee_cli_client_id", async () => {
  assert.equal(CAPTURED_PRM.route, "/.well-known/oauth-protected-resource/mcp");
  assert.equal(CAPTURED_PRM.response.status, 200);
  const captured = JSON.parse(CAPTURED_PRM.response.body) as Record<string, unknown>;
  assert.equal(typeof captured[PUBLISHED_CLIENT_ID_FIELD], "string", "the host publishes the CLI client id under this field");
  const h = await harness();
  try {
    const response = await h.deps.fetch(`${h.host}${CAPTURED_PRM.route}`);
    assert.equal(response.status, CAPTURED_PRM.response.status);
    assert.deepEqual(prmShape(await response.json()), prmShape(captured));
  } finally {
    await h.cleanup();
  }
});

test("discovery takes the client id from the captured host metadata", async () => {
  const captured = JSON.parse(CAPTURED_PRM.response.body) as { resource: string; authorization_servers: string[] };
  const target = resolveHostedTarget(new URL(captured.resource).origin);
  const issuer = captured.authorization_servers[0]!;
  const fetchCaptured = async (url: string): Promise<Response> => {
    if (url === target.metadataUrl) return new Response(CAPTURED_PRM.response.body, { status: 200, headers: CAPTURED_PRM.response.headers });
    if (url === `${issuer}.well-known/openid-configuration`)
      return Response.json({ issuer, token_endpoint: `${issuer}oauth/token`, device_authorization_endpoint: `${issuer}oauth/device/code` });
    return new Response("not found", { status: 404 });
  };
  const d = await discoverHosted(fetchCaptured, target);
  assert.equal(d.publishedClientId, "BC9Yw7kxuHH9TGQmhlSTEghoN6UXWF2r");
  assert.deepEqual(resolveClientId({ ...(d.publishedClientId ? { published: d.publishedClientId } : {}), origin: target.origin }), {
    clientId: "BC9Yw7kxuHH9TGQmhlSTEghoN6UXWF2r",
    source: "host-metadata",
  });
});

test("discovery flags a malformed published client id instead of using it", async () => {
  const h = await harness();
  try {
    for (const bad of ["", "has space", 42, "x".repeat(257), "caf\u00e9"]) {
      h.issuer.prmOverride = { [PUBLISHED_CLIENT_ID_FIELD]: bad };
      const d = await discoverHosted(h.deps.fetch, resolveHostedTarget(h.host));
      assert.equal(d.publishedClientId, undefined, String(bad));
      assert.equal(d.publishedClientIdMalformed, true, String(bad));
    }
    h.issuer.prmOverride = { [PUBLISHED_CLIENT_ID_FIELD]: null };
    const d = await discoverHosted(h.deps.fetch, resolveHostedTarget(h.host));
    assert.equal(d.publishedClientIdMalformed, undefined);
  } finally {
    await h.cleanup();
  }
});

test("login signs in with the host's published client id when SUPERBEE_OAUTH_CLIENT_ID is unset", async () => {
  const h = await harness();
  try {
    assert.equal(h.deps.env.SUPERBEE_OAUTH_CLIENT_ID, undefined);
    const io = { stdout: () => {}, stderr: () => {}, auth: h.deps };
    await authRequired(login(["--host", h.host], io));
    assert.equal([...h.issuer.devices.values()][0]?.clientId, "cli-client");
  } finally {
    await h.cleanup();
  }
});

test("login refuses a host that publishes a malformed client id, naming the field", async () => {
  const h = await harness();
  try {
    h.issuer.prmOverride = { [PUBLISHED_CLIENT_ID_FIELD]: "has space" };
    const io = { stdout: () => {}, stderr: () => {}, auth: h.deps };
    await assert.rejects(login(["--host", h.host], io), (e: CliError) => e.code === "RUNTIME" && /malformed superbee_cli_client_id/.test(e.message));
    assert.equal(h.issuer.counts.deviceCode, 0);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Resumable device sign-in

test("first hosted token request returns AUTH_REQUIRED (exit 4) with one link; re-running completes sign-in", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    const first = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal(first.exitCode, EXIT.AUTH);
    assert.equal(toExit(first).exitCode, 4);
    const details = first.details as Record<string, unknown>;
    assert.equal(details.reason, "no_session");
    assert.match(String(details.sign_in_url), /\/activate\?user_code=/);
    assert.equal(typeof details.user_code, "string");
    assert.match(String(details.resume), /login --host http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(first.message, /ask the person to open/);
    assert.doesNotMatch(JSON.stringify(first.details), /dc-/, "the device code never leaves the machine");

    // Too early to poll: no token request, same link.
    const early = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal(h.issuer.counts.devicePoll, 0);
    assert.equal((early.details as Record<string, unknown>).sign_in_url, details.sign_in_url);

    // Person has not confirmed yet: one poll, same link, still pending.
    h.clock.advance(1_000);
    const pending = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal((pending.details as Record<string, unknown>).reason, "authorization_pending");
    assert.equal((pending.details as Record<string, unknown>).sign_in_url, details.sign_in_url);
    assert.equal(h.issuer.counts.deviceCode, 1, "re-running never starts a second device authorization");

    h.issuer.approve();
    h.clock.advance(1_000);
    const token = await ensureHostedAccessToken(target, {}, h.deps);
    assert.equal(token.source, "sign-in");
    assert.ok(await storedRefreshToken(h), "refresh token stored");

    const cached = await ensureHostedAccessToken(target, {}, h.deps);
    assert.equal(cached.source, "cache");
    assert.equal(cached.accessToken, token.accessToken);
  } finally {
    await h.cleanup();
  }
});

test("an expired or denied device code starts a fresh link with the reason named", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    const first = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    h.clock.advance(601_000);
    const expired = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal((expired.details as Record<string, unknown>).reason, "previous_code_expired");
    assert.notEqual((expired.details as Record<string, unknown>).sign_in_url, (first.details as Record<string, unknown>).sign_in_url);

    h.issuer.deny();
    h.clock.advance(1_000);
    const denied = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal((denied.details as Record<string, unknown>).reason, "previous_request_denied");
    assert.equal(h.issuer.counts.deviceCode, 3);
  } finally {
    await h.cleanup();
  }
});

test("login --wait polls within its bound; it never waits past --timeout", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    const start = h.clock.now();
    const timedOut = await authRequired(waitForHostedSignIn(target, { timeoutMs: 5_000 }, h.deps));
    assert.equal((timedOut.details as Record<string, unknown>).reason, "authorization_pending");
    assert.ok(h.clock.now() - start <= 5_000, "bounded");

    let polls = 0;
    h.issuer.onRefresh = undefined;
    const originalSleep = h.deps.sleep;
    const deps: HostedAuthDeps = {
      ...h.deps,
      sleep: async (ms) => {
        polls += 1;
        if (polls === 2) h.issuer.approve();
        await originalSleep(ms);
      },
    };
    const token = await waitForHostedSignIn(target, { timeoutMs: 60_000 }, deps);
    assert.equal(token.source, "sign-in");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Refresh

test("silent refresh rotates the refresh token; the rotated-out token is dead outside the leeway", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    const firstAccess = await signIn(h);
    const firstRefresh = await storedRefreshToken(h);
    await expireCachedAccessToken(h);
    const refreshed = await ensureHostedAccessToken(target, {}, h.deps);
    assert.equal(refreshed.source, "refresh");
    assert.notEqual(refreshed.accessToken, firstAccess);
    assert.equal(h.issuer.counts.refresh, 1);
    const secondRefresh = await storedRefreshToken(h);
    assert.ok(secondRefresh && secondRefresh !== firstRefresh, "rotated token stored");
    assert.equal(h.issuer.familyOf(secondRefresh!), h.issuer.familyOf(firstRefresh!));

    // A refresh within the skew window uses the cache.
    assert.equal((await ensureHostedAccessToken(target, {}, h.deps)).source, "cache");
  } finally {
    await h.cleanup();
  }
});

test("a lost refresh response is retried once inside the 30-second reuse leeway without revoking the family", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    await signIn(h);
    await expireCachedAccessToken(h);
    h.issuer.dropNextRefreshResponse = true;
    const token = await ensureHostedAccessToken(target, {}, h.deps);
    assert.equal(token.source, "refresh");
    assert.equal(h.issuer.counts.refresh, 2);
    assert.equal(h.issuer.revokedFamilies.size, 0);
  } finally {
    await h.cleanup();
  }
});

test("a lost refresh response past the leeway is not retried blindly: TRANSIENT, retryable", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    await signIn(h);
    await expireCachedAccessToken(h);
    h.issuer.dropNextRefreshResponse = true;
    h.issuer.onRefresh = () => h.clock.advance(REFRESH_REUSE_LEEWAY_MS + 1);
    await assert.rejects(ensureHostedAccessToken(target, {}, h.deps), (e: CliError) => {
      assert.equal(e.code, "TRANSIENT");
      assert.equal(e.details?.retryable, true);
      return true;
    });
    assert.equal(h.issuer.counts.refresh, 1);
  } finally {
    await h.cleanup();
  }
});

test("an expired refresh token clears the session and returns AUTH_REQUIRED with a fresh link", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    await signIn(h);
    await expireCachedAccessToken(h);
    h.issuer.expireAllRefreshTokens();
    const err = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal((err.details as Record<string, unknown>).reason, "session_expired");
    assert.equal(await storedRefreshToken(h), null, "dead refresh token removed");
    assert.equal(await readSession(h.home, target), null);
  } finally {
    await h.cleanup();
  }
});

test("concurrent processes refresh once under the cross-process lock and all receive the new token", async () => {
  const h = await harness({ realClock: true });
  try {
    const target = resolveHostedTarget(h.host);
    await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    h.issuer.approve();
    await new Promise((r) => setTimeout(r, 1_050));
    await ensureHostedAccessToken(target, {}, h.deps);
    await expireCachedAccessToken(h);

    const signal = path.join(h.home, "go");
    const loader = path.join(here, "ts-loader.mjs");
    const child = path.join(here, "support", "hosted-auth-child.ts");
    const runs = Array.from({ length: 8 }, () =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(process.execPath, ["--import", loader, child, h.home, h.host, signal], {
          env: { ...process.env, [CREDENTIAL_STORE_ENV]: "file" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let errOut = "";
        proc.stdout.on("data", (c) => (out += c));
        proc.stderr.on("data", (c) => (errOut += c));
        proc.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exit ${code}: ${errOut}`))));
      }));
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(signal, "go");
    const results = (await Promise.all(runs)).map((line) => JSON.parse(line) as { ok: boolean; source: string; token: string });
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.equal(h.issuer.counts.refresh, 1, "exactly one refresh across eight processes");
    assert.equal(new Set(results.map((r) => r.token)).size, 1, "everyone got the same fresh token");
    assert.equal(results.filter((r) => r.source === "refresh").length, 1);
    assert.equal(h.issuer.revokedFamilies.size, 0);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Logout, env override, isolation

test("logout revokes the refresh token at the issuer and deletes the local session; repeating is a no-op", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    await signIn(h);
    const refresh = await storedRefreshToken(h);
    const result = await logoutHosted(target, h.deps);
    assert.equal(result.signed_out, true);
    assert.equal(result.revoked, true);
    assert.ok(result.access_token_valid_until, "reports the unrevocable access-token window");
    assert.equal(h.issuer.counts.revoke, 1);
    assert.ok(h.issuer.revokedFamilies.has(h.issuer.familyOf(refresh!)!));
    assert.equal(await storedRefreshToken(h), null);
    assert.equal(await readSession(h.home, target), null);

    const again = await logoutHosted(target, h.deps);
    assert.equal(again.signed_out, false);
    assert.equal(h.issuer.counts.revoke, 1);

    const next = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal((next.details as Record<string, unknown>).reason, "no_session");
  } finally {
    await h.cleanup();
  }
});

function unsignedJwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

test("SUPERBEE_ACCESS_TOKEN wins, is used as given, and touches neither the network nor the store", async () => {
  const h = await harness();
  try {
    const ciToken = unsignedJwt({ sub: "ci", aud: `${h.host}/mcp` });
    const deps = { ...h.deps, env: { ...h.deps.env, [ACCESS_TOKEN_ENV]: ciToken } };
    const token = await ensureHostedAccessToken(resolveHostedTarget(h.host), {}, deps);
    assert.deepEqual(token, { accessToken: ciToken, source: "env" });
    assert.equal(h.issuer.counts.prm, 0);
    assert.deepEqual(await readdir(h.home), []);
  } finally {
    await h.cleanup();
  }
});

test("sessions are isolated per host and audience", async () => {
  const h = await harness();
  try {
    const broad = resolveHostedTarget(h.host);
    const agent = resolveHostedTarget(`${h.host}/agents/abc/mcp`);
    await signIn(h);
    await authRequired(ensureHostedAccessToken(agent, {}, h.deps));
    assert.equal(await readSession(h.home, agent), null);
    assert.notEqual(sessionDirFor(h.home, sessionAccount(broad)), sessionDirFor(h.home, sessionAccount(agent)));
    await logoutHosted(agent, h.deps);
    assert.ok(await readSession(h.home, broad), "logging out of one audience leaves the other");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Loopback PKCE

test("loopback PKCE sign-in completes through the redirect and stores the session", async () => {
  const h = await harness({ realClock: true });
  try {
    const target = resolveHostedTarget(h.host);
    const session = await loopbackSignIn(
      target,
      {
        timeoutMs: 10_000,
        announce: (url) => {
          void (async () => {
            const authorize = await fetch(url, { redirect: "manual" });
            await fetch(authorize.headers.get("location")!);
          })();
        },
      },
      h.deps,
    );
    assert.ok(session);
    assert.equal(h.issuer.counts.authCode, 1);
    assert.equal((await readSession(h.home, target))?.subject.email, "mike@example.com");
  } finally {
    await h.cleanup();
  }
});

test("loopback waits only within its bound, then login falls back to the device link", async () => {
  const h = await harness({ realClock: true });
  try {
    let stderr = "";
    const err = await authRequired(
      login(["--host", h.host, "--loopback", "--timeout", "1"], {
        stdout: () => assert.fail("no success record"),
        stderr: (t) => (stderr += t),
        auth: h.deps,
      }),
    );
    assert.match(stderr, /\/issuer\/authorize\?/);
    assert.match(String((err.details as Record<string, unknown>).sign_in_url), /activate/);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Commands

test("login / whoami / logout commands: structured records, never a token on stdout", async () => {
  const h = await harness();
  try {
    let out = "";
    const io = { stdout: (t: string) => (out += t), stderr: () => {}, auth: h.deps };
    const err = await authRequired(login(["--host", h.host, "--json"], io));
    assert.equal(err.exitCode, 4);

    out = "";
    await whoami(["--host", h.host, "--json"], io);
    const pending = JSON.parse(out) as Record<string, unknown>;
    assert.equal(pending.signed_in, false);
    assert.ok((pending.pending_sign_in as Record<string, unknown>).sign_in_url);

    h.issuer.approve();
    h.clock.advance(1_000);
    out = "";
    await login(["--host", h.host, "--json"], io);
    const signedIn = JSON.parse(out) as Record<string, unknown>;
    assert.equal(signedIn.status, "signed_in");
    assert.equal(signedIn.subject, "auth0|mike");
    assert.equal(signedIn.credential_store, "file");

    out = "";
    await login(["--json"], io); // default host = last sign-in
    assert.equal((JSON.parse(out) as Record<string, unknown>).status, "already_signed_in");

    out = "";
    await whoami(["--json"], io);
    const me = JSON.parse(out) as Record<string, unknown>;
    assert.equal(me.signed_in, true);
    assert.equal(me.email, "mike@example.com");
    assert.equal(me.refresh_token, "stored");
    const session = await readSession(h.home, resolveHostedTarget(h.host));
    assert.ok(!out.includes(session!.access_token), "whoami never prints the access token");
    assert.ok(!out.includes((await storedRefreshToken(h))!), "whoami never prints the refresh token");

    out = "";
    await logout(["--json"], io);
    const loggedOut = JSON.parse(out) as Record<string, unknown>;
    assert.equal(loggedOut.signed_out, true);
    assert.equal(loggedOut.revoked, true);

    out = "";
    await whoami(["--json"], io);
    assert.equal((JSON.parse(out) as Record<string, unknown>).signed_in, false);
  } finally {
    await h.cleanup();
  }
});

test("login refuses a host that publishes no client id unless one is supplied", async () => {
  const h = await harness({ publishedClientId: null });
  try {
    const io = { stdout: () => {}, stderr: () => {}, auth: h.deps };
    await assert.rejects(login(["--host", h.host], io), (e: CliError) => e.code === "USAGE" && /client id/.test(e.message));
    assert.equal(h.issuer.counts.deviceCode, 0);
    const err = await authRequired(login(["--host", h.host, "--client-id", "staging-cli"], io));
    assert.match(String((err.details as Record<string, unknown>).resume), /--client-id staging-cli$/);
    assert.equal([...h.issuer.devices.values()][0]?.clientId, "staging-cli");
  } finally {
    await h.cleanup();
  }
});

test("login flag validation is USAGE (exit 2)", async () => {
  const h = await harness();
  try {
    const io = { stdout: () => {}, stderr: () => {}, auth: h.deps };
    for (const argv of [["--port", "8080"], ["--timeout", "5"], ["--wait", "--timeout", "601"], ["--wait", "--loopback"]]) {
      await assert.rejects(login(["--host", h.host, ...argv], io), (e: CliError) => e.exitCode === EXIT.USAGE, argv.join(" "));
    }
    await assert.rejects(whoami([], { ...io, auth: { ...h.deps, env: {} } }), (e: CliError) => e.code === "USAGE" && /--host/.test(e.help ?? ""));
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Credential store policy

function fakeRunner(handler: (command: string, args: readonly string[], stdin: string) => RunResult): ToolRunner & { calls: { command: string; args: readonly string[]; stdin: string }[] } {
  const calls: { command: string; args: readonly string[]; stdin: string }[] = [];
  const run = (async (command: string, args: readonly string[], stdin: string) => {
    calls.push({ command, args, stdin });
    return handler(command, args, stdin);
  }) as unknown as ToolRunner & { calls: typeof calls };
  run.calls = calls;
  return run;
}

test("macOS keychain: the secret travels hex-encoded on stdin, never in argv; not-found and timeouts are distinct", async () => {
  const secrets = new Map<string, string>();
  const run = fakeRunner((_command, args, stdin) => {
    if (args[0] === "-i") {
      const m = /-a "([^"]+)" -l "Superbee CLI" -X ([0-9a-f]+)\n$/.exec(stdin);
      assert.ok(m, stdin);
      secrets.set(m[1]!, Buffer.from(m[2]!, "hex").toString("utf8"));
      return { code: 0, stdout: "", stderr: "" };
    }
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "find-generic-password") {
      return secrets.has(account) ? { code: 0, stdout: `${secrets.get(account)}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "not found" };
    }
    if (args[0] === "delete-generic-password") return secrets.delete(account) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  });
  const store = macosKeychainStore(run);
  const account = "https://h.example https://h.example/mcp";
  assert.equal(await store.get(account), null);
  await store.set(account, "v1.secret-refresh");
  assert.equal(await store.get(account), "v1.secret-refresh");
  assert.ok(run.calls.every((c) => !c.args.join(" ").includes("v1.secret-refresh")), "secret never in argv");
  assert.equal(await store.delete(account), true);
  assert.equal(await store.delete(account), false);

  const locked = macosKeychainStore(fakeRunner(() => ({ code: null, stdout: "", stderr: "", timedOut: true })));
  await assert.rejects(locked.get(account), (e: CliError) => e.code === "CREDENTIAL_STORE_UNAVAILABLE" && e.exitCode === 1 && /SUPERBEE_CREDENTIAL_STORE=file/.test(e.help ?? ""));
});

test("Linux Secret Service: secret on stdin; a missing secret-tool or D-Bus is CREDENTIAL_STORE_UNAVAILABLE", async () => {
  const store = secretServiceStore(fakeRunner((_c, args, stdin) => {
    if (args[0] === "store") {
      assert.equal(stdin, "rt-value");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "lookup") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }));
  assert.equal(await store.get("a b"), null);
  await store.set("a b", "rt-value");

  const missing = secretServiceStore(fakeRunner(() => ({ code: null, stdout: "", stderr: "", missing: true })));
  await assert.rejects(missing.get("a b"), (e: CliError) => e.code === "CREDENTIAL_STORE_UNAVAILABLE" && /not installed/.test(e.message));
  const noBus = secretServiceStore(fakeRunner(() => ({ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" })));
  await assert.rejects(noBus.get("a b"), (e: CliError) => e.code === "CREDENTIAL_STORE_UNAVAILABLE" && /D-Bus/.test(e.message));
});

test("store policy: explicit file opt-in, no Windows package, no silent plaintext fallback", () => {
  const base = { home: "/nonexistent", directoryFor: (a: string) => a };
  assert.equal(selectSecretStore({ ...base, env: {}, platform: "darwin" }).kind, "macos-keychain");
  assert.equal(selectSecretStore({ ...base, env: {}, platform: "linux" }).kind, "secret-service");
  assert.equal(selectSecretStore({ ...base, env: { [CREDENTIAL_STORE_ENV]: "file" }, platform: "win32" }).kind, "file");
  assert.throws(() => selectSecretStore({ ...base, env: {}, platform: "win32" }), (e: CliError) => e.code === "CREDENTIAL_STORE_UNAVAILABLE");
  assert.throws(() => selectSecretStore({ ...base, env: { [CREDENTIAL_STORE_ENV]: "plaintext" }, platform: "linux" }), (e: CliError) => e.code === "USAGE");
});

test("a missing keychain refuses sign-in before anyone is asked to open a link", async () => {
  const h = await harness();
  try {
    const deps: HostedAuthDeps = {
      ...h.deps,
      env: {},
      platform: "linux",
      run: fakeRunner(() => ({ code: null, stdout: "", stderr: "", missing: true })),
    };
    await assert.rejects(ensureHostedAccessToken(resolveHostedTarget(h.host), {}, deps), (e: CliError) => {
      assert.equal(e.code, "CREDENTIAL_STORE_UNAVAILABLE");
      assert.equal(toExit(e).exitCode, 1);
      return true;
    });
    assert.equal(h.issuer.counts.deviceCode, 0);
    assert.equal(h.issuer.counts.prm, 0);
  } finally {
    await h.cleanup();
  }
});

test("a keychain that reads but cannot write refuses sign-in before a device code is issued", async () => {
  // The shape `security` gives under a HOME with no default keychain: reads say not found (44), writes fail.
  const h = await harness();
  try {
    const run = fakeRunner((_command, args) => {
      if (args[0] === "find-generic-password") return { code: 44, stdout: "", stderr: "security: The specified item could not be found in the keychain." };
      if (args[0] === "-i") {
        return { code: 154, stdout: "", stderr: "security: SecKeychainItemCreateFromContent (<default>): The authorization was canceled by the user.\nadd-generic-password: returned -60006" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const deps: HostedAuthDeps = { ...h.deps, env: {}, platform: "darwin", run };
    const target = resolveHostedTarget(h.host);
    await assert.rejects(ensureHostedAccessToken(target, {}, deps), (e: CliError) => {
      assert.equal(e.code, "CREDENTIAL_STORE_UNAVAILABLE");
      assert.match(e.message, /keychain write failed/);
      assert.match(e.help ?? "", /SUPERBEE_CREDENTIAL_STORE=file/);
      return true;
    });
    assert.equal(h.issuer.counts.deviceCode, 0, "no device code is issued, so none can be spent");
    assert.ok(run.calls.some((c) => c.args[0] === "-i" && c.stdin.includes(`-a "${sessionAccount(target)} probe"`)), "the probe writes a throwaway account");
    assert.ok(!run.calls.some((c) => c.stdin.includes(`-a "${sessionAccount(target)}" `)), "the session's own account is never written by the probe");
  } finally {
    await h.cleanup();
  }
});

test("a store write failing after the device code is redeemed is a store error; the next run starts a fresh sign-in", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    const first = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    h.issuer.approve();
    h.clock.advance(1_000);
    const file = fileSecretStore(h.home, (account) => sessionDirFor(h.home, account));
    const refusing = {
      kind: "file" as const,
      get: (a: string) => file.get(a),
      delete: (a: string) => file.delete(a),
      set: async () => {
        throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "cannot use the OS credential store: keychain write failed", {
          help: `unlock or install the OS credential store and retry, or opt in with ${CREDENTIAL_STORE_ENV}=file`,
        });
      },
    };
    await assert.rejects(ensureHostedAccessToken(target, {}, { ...h.deps, store: refusing }), (e: CliError) => {
      assert.equal(e.code, "CREDENTIAL_STORE_UNAVAILABLE");
      assert.match(e.message, /confirmed but could not be saved/);
      assert.equal(e.details?.reason, "store_write_failed_after_sign_in");
      assert.equal(e.details?.sign_in_discarded, true);
      assert.match(e.help ?? "", /SUPERBEE_CREDENTIAL_STORE=file/);
      assert.match(e.help ?? "", /starts a fresh sign-in/);
      return true;
    });
    assert.equal(h.issuer.counts.devicePoll, 1);
    assert.equal(h.issuer.revokedFamilies.size, 1, "the unsaved refresh token is revoked, not left live");
    assert.equal(await readSession(h.home, target), null);
    const dir = sessionDirFor(h.home, sessionAccount(target));
    assert.ok(!(await readdir(dir)).includes("pending.json"), "the spent device code is dropped");

    // Once the store works, re-running relays a fresh link instead of polling the spent code.
    const next = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal(h.issuer.counts.devicePoll, 1, "the spent code is never polled again");
    assert.equal(h.issuer.counts.deviceCode, 2);
    assert.notEqual((next.details as Record<string, unknown>).sign_in_url, (first.details as Record<string, unknown>).sign_in_url);
    h.issuer.approve();
    h.clock.advance(1_000);
    assert.equal((await ensureHostedAccessToken(target, {}, h.deps)).source, "sign-in");
  } finally {
    await h.cleanup();
  }
});

test("a persisted device code the issuer answers invalid_grant is dropped for a fresh link (AUTH_REQUIRED, not RUNTIME)", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    const first = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    const dir = sessionDirFor(h.home, sessionAccount(target));
    const spentCode = (JSON.parse(await readFile(path.join(dir, "pending.json"), "utf8")) as { device_code: string }).device_code;
    h.issuer.devices.clear(); // The issuer no longer knows the code, as after a redemption whose save was lost.
    h.clock.advance(1_000);
    const fresh = await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    const details = fresh.details as Record<string, unknown>;
    assert.equal(fresh.exitCode, EXIT.AUTH);
    assert.equal(details.reason, "previous_code_rejected");
    assert.notEqual(details.sign_in_url, (first.details as Record<string, unknown>).sign_in_url);
    assert.notEqual(details.user_code, (first.details as Record<string, unknown>).user_code);
    assert.match(String(details.resume), /login --host/);
    assert.equal(h.issuer.counts.devicePoll, 1);
    assert.equal(h.issuer.counts.deviceCode, 2);
    const pending = JSON.parse(await readFile(path.join(dir, "pending.json"), "utf8")) as { device_code: string };
    assert.notEqual(pending.device_code, spentCode, "the rejected code is replaced");

    h.issuer.approve();
    h.clock.advance(1_000);
    assert.equal((await ensureHostedAccessToken(target, {}, h.deps)).source, "sign-in");
  } finally {
    await h.cleanup();
  }
});

test("the file store keeps the refresh token 0600 inside the private state root", async () => {
  const h = await harness();
  try {
    await signIn(h);
    const dir = sessionDirFor(h.home, sessionAccount(resolveHostedTarget(h.host)));
    const { statSync } = await import("node:fs");
    if (process.platform !== "win32") {
      assert.equal(statSync(path.join(dir, "refresh-token.json")).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(dir, "session.json")).mode & 0o777, 0o600);
    }
    const raw = await readFile(path.join(dir, "session.json"), "utf8");
    assert.ok(!raw.includes("rt-"), "the refresh token is not in the access-token cache");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Boundary: no existing command reaches hosted before the transport exists

test("only the sign-in commands, the hosted checkout and hosted sync import the hosted session module", async () => {
  const src = path.resolve(here, "../src");
  const offenders: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "hosted-auth") await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const text = await readFile(full, "utf8");
      const allowed = [
        path.join("commands", "hosted-auth.ts"),
        path.join("commands", "checkout.ts"),
        path.join("commands", "checkout-adopt.ts"),
        path.join("hosted", "client.ts"),
        path.join("hosted", "sync.ts"),
        // Hosted-checkout triggers: each reaches the session only for a folder bound as a hosted checkout.
        "autopull.ts",
        path.join("commands", "session-start.ts"),
        path.join("commands", "turn-end.ts"),
        path.join("commands", "setup-hosted.ts"),
        path.join("hosted", "defaults.ts"),
        path.join("hosted", "freshness.ts"),
      ];
      if (/hosted-auth\//.test(text) && !allowed.includes(path.relative(src, full))) {
        offenders.push(path.relative(src, full));
      }
    }
  }
  await walk(src);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------------------------
// Built CLI: the agent-relay journey end to end

test("built CLI: login returns a TOON AUTH_REQUIRED envelope (exit 4); after confirmation re-running signs in", async () => {
  const cli = path.resolve(here, "../../superbee/dist/superbee.mjs");
  const home = await mkdtemp(path.join(tmpdir(), "sb-hosted-built-"));
  const issuer = await new FakeIssuer().start();
  const env = isolatedUserEnv(home, { [CREDENTIAL_STORE_ENV]: "file", ASLITE_NO_UPDATE_CHECK: "1" });
  const runCli = (argv: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const proc = spawn(process.execPath, [cli, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c) => (stdout += c));
      proc.stderr.on("data", (c) => (stderr += c));
      proc.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  try {
    const first = await runCli(["login", "--host", issuer.base]);
    assert.equal(first.status, 4, first.stdout + first.stderr);
    const envelope = decode(first.stdout.trim()) as { error: { code: string; details: Record<string, unknown>; help: string } };
    assert.equal(envelope.error.code, "AUTH_REQUIRED");
    assert.match(String(envelope.error.details.sign_in_url), /activate\?user_code=/);
    assert.match(envelope.error.help, /re-run: .*login --host/);

    issuer.approve();
    await new Promise((r) => setTimeout(r, 1_100));
    const second = await runCli(["login", "--host", issuer.base, "--json"]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal((JSON.parse(second.stdout) as { status: string }).status, "signed_in");

    const me = await runCli(["whoami", "--json"]);
    assert.equal(me.status, 0);
    assert.equal((JSON.parse(me.stdout) as { email: string }).email, "mike@example.com");

    const out = await runCli(["logout", "--json"]);
    assert.equal(out.status, 0);
    assert.equal((JSON.parse(out.stdout) as { revoked: boolean }).revoked, true);
  } finally {
    await issuer.stop();
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Review follow-ups (PR 290 review at d5d1bedb)

test("B1: login --wait shows the link and code on stderr before its first wait", async () => {
  const h = await harness();
  try {
    let stderr = "";
    let sleptBeforeAnnounce = false;
    const deps: HostedAuthDeps = {
      ...h.deps,
      sleep: async (ms) => {
        if (!stderr.includes("activate?user_code=")) sleptBeforeAnnounce = true;
        h.issuer.approve();
        h.clock.advance(ms);
      },
    };
    let out = "";
    await login(["--host", h.host, "--wait", "--json"], { stdout: (t) => (out += t), stderr: (t) => (stderr += t), auth: deps });
    assert.equal(sleptBeforeAnnounce, false);
    assert.match(stderr, /open http:\/\/127\.0\.0\.1:\d+\/activate\?user_code=\S+ and confirm the code/);
    assert.equal((JSON.parse(out) as { status: string }).status, "signed_in");
    assert.equal(stderr.split("activate?").length - 1, 1, "one announcement for one link");
  } finally {
    await h.cleanup();
  }
});

test("B1: login --wait announces again when the link changes (expired code restarts)", async () => {
  const h = await harness();
  try {
    let stderr = "";
    let sleeps = 0;
    const deps: HostedAuthDeps = {
      ...h.deps,
      sleep: async (ms) => {
        sleeps += 1;
        h.clock.advance(sleeps === 1 ? 601_000 : ms);
      },
    };
    await authRequired(login(["--host", h.host, "--wait", "--timeout", "3"], { stdout: () => {}, stderr: (t) => (stderr += t), auth: deps }));
    assert.equal(stderr.split("activate?").length - 1, 2);
  } finally {
    await h.cleanup();
  }
});

test("S1: SUPERBEE_ACCESS_TOKEN is refused for a different audience or an unpinned opaque token", async () => {
  const h = await harness();
  try {
    const staging = unsignedJwt({ sub: "ci", aud: "https://staging.example/mcp" });
    const deps = (env: NodeJS.ProcessEnv): HostedAuthDeps => ({ ...h.deps, env: { ...h.deps.env, ...env } });
    const broad = resolveHostedTarget(h.host);
    const agent = resolveHostedTarget(`${h.host}/agents/abc/mcp`);
    await assert.rejects(ensureHostedAccessToken(broad, {}, deps({ [ACCESS_TOKEN_ENV]: staging })), (e: CliError) => e.code === "USAGE" && /different audience/.test(e.message));
    const broadToken = unsignedJwt({ aud: [`${h.host}/mcp`, "https://issuer/userinfo"] });
    assert.equal((await ensureHostedAccessToken(broad, {}, deps({ [ACCESS_TOKEN_ENV]: broadToken }))).source, "env");
    await assert.rejects(ensureHostedAccessToken(agent, {}, deps({ [ACCESS_TOKEN_ENV]: broadToken })), (e: CliError) => e.code === "USAGE");
    await assert.rejects(ensureHostedAccessToken(broad, {}, deps({ [ACCESS_TOKEN_ENV]: "opaque" })), (e: CliError) => e.code === "USAGE" && /SUPERBEE_HOST/.test(e.message));
    assert.equal((await ensureHostedAccessToken(broad, {}, deps({ [ACCESS_TOKEN_ENV]: "opaque", [HOST_ENV]: h.host }))).source, "env");
    await assert.rejects(ensureHostedAccessToken(agent, {}, deps({ [ACCESS_TOKEN_ENV]: "opaque", [HOST_ENV]: h.host })), (e: CliError) => e.code === "USAGE");
    assert.equal(h.issuer.counts.prm, 0);
  } finally {
    await h.cleanup();
  }
});

async function driveLoopback(url: string, stateOverride?: string): Promise<void> {
  const authorize = await fetch(url, { redirect: "manual" });
  const location = new URL(authorize.headers.get("location")!);
  if (stateOverride !== undefined) {
    const forged = new URL(location);
    forged.searchParams.set("state", stateOverride);
    const res = await fetch(forged);
    assert.equal(res.status, 404, "a callback with the wrong state is ignored");
  }
  await fetch(location);
}

test("S7: loopback ignores a callback with the wrong state and still completes with the right one", async () => {
  const h = await harness({ realClock: true });
  try {
    const session = await loopbackSignIn(resolveHostedTarget(h.host), { timeoutMs: 10_000, announce: (url) => void driveLoopback(url, "forged") }, h.deps);
    assert.ok(session);
    assert.equal(h.issuer.counts.authCode, 1);
  } finally {
    await h.cleanup();
  }
});

test("S2: loopback saves tokens only under the session lock", async () => {
  const h = await harness({ realClock: true });
  try {
    const target = resolveHostedTarget(h.host);
    const deps: HostedAuthDeps = { ...h.deps, lockWaitMs: 300 };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = withSessionLock(target, deps, async () => {
      locked();
      await held;
    });
    await isLocked;
    await assert.rejects(
      loopbackSignIn(target, { timeoutMs: 10_000, announce: (url) => void driveLoopback(url) }, deps),
      (e: CliError) => e.code === "TRANSIENT" && e.details?.reason === "session_busy",
    );
    assert.equal(await readSession(h.home, target), null, "nothing written while another process holds the lock");
    release();
    await holder;
  } finally {
    await h.cleanup();
  }
});

test("S3: signing in again revokes the replaced refresh-token family; loopback on a live session reports already_signed_in", async () => {
  const h = await harness({ realClock: true });
  try {
    const target = resolveHostedTarget(h.host);
    const first = await loopbackSignIn(target, { timeoutMs: 10_000, announce: (url) => void driveLoopback(url) }, h.deps);
    assert.ok(first);
    const oldRefresh = await storedRefreshToken(h);
    await loopbackSignIn(target, { timeoutMs: 10_000, announce: (url) => void driveLoopback(url) }, h.deps);
    assert.ok(h.issuer.revokedFamilies.has(h.issuer.familyOf(oldRefresh!)!), "old family revoked");
    assert.notEqual(await storedRefreshToken(h), oldRefresh);

    let out = "";
    let stderr = "";
    await login(["--host", h.host, "--loopback", "--json"], { stdout: (t) => (out += t), stderr: (t) => (stderr += t), auth: h.deps });
    assert.equal((JSON.parse(out) as { status: string }).status, "already_signed_in");
    assert.equal(stderr, "", "no browser link for a live session");
    assert.equal(h.issuer.counts.authCode, 2);
  } finally {
    await h.cleanup();
  }
});

test("S4: logout still signs out locally when the OS store is locked", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    await signIn(h);
    const locked = {
      kind: "file" as const,
      get: async () => {
        throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "locked");
      },
      set: async () => {
        throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "locked");
      },
      delete: async () => {
        throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "locked");
      },
    };
    let out = "";
    await logout(["--host", h.host, "--json"], { stdout: (t) => (out += t), stderr: () => {}, auth: { ...h.deps, store: locked } });
    const result = JSON.parse(out) as { signed_out: boolean; revoked: boolean; revocation: string; notes: string[] };
    assert.equal(result.signed_out, true);
    assert.equal(result.revoked, false);
    assert.equal(result.revocation, "store_unavailable");
    assert.ok(result.notes.some((n) => /logout again/.test(n)));
    assert.equal(await readSession(h.home, target), null, "the live access token is gone from disk");
  } finally {
    await h.cleanup();
  }
});

test("S7: a store write failing after rotation surfaces CREDENTIAL_STORE_UNAVAILABLE and a retry inside the leeway recovers", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    await signIn(h);
    await expireCachedAccessToken(h);
    const file = fileSecretStore(h.home, (account) => sessionDirFor(h.home, account));
    let failNextSet = true;
    const flaky = {
      kind: "file" as const,
      get: (a: string) => file.get(a),
      delete: (a: string) => file.delete(a),
      set: async (a: string, v: string) => {
        if (failNextSet) {
          failNextSet = false;
          throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "keychain write failed");
        }
        return file.set(a, v);
      },
    };
    const deps = { ...h.deps, store: flaky };
    await assert.rejects(ensureHostedAccessToken(target, {}, deps), (e: CliError) => e.code === "CREDENTIAL_STORE_UNAVAILABLE");
    h.clock.advance(5_000);
    const token = await ensureHostedAccessToken(target, {}, deps);
    assert.equal(token.source, "refresh");
    assert.equal(h.issuer.revokedFamilies.size, 0);
  } finally {
    await h.cleanup();
  }
});

test("S5/S7: discovery refuses a missing or mismatched resource, a foreign issuer, plain-http endpoints and redirects", async () => {
  const h = await harness();
  try {
    const target = resolveHostedTarget(h.host);
    const refuses = async (pattern: RegExp) =>
      assert.rejects(discoverHosted(h.deps.fetch, target), (e: CliError) => e.code === "RUNTIME" && pattern.test(e.message));

    h.issuer.prmOverride = { resource: undefined };
    await refuses(/has no resource/);
    h.issuer.prmOverride = { resource: "https://elsewhere.example/mcp" };
    await refuses(/names resource/);
    h.issuer.prmOverride = {};

    h.issuer.oidcOverride = { issuer: "https://evil.example/" };
    await refuses(/names a different issuer/);
    h.issuer.oidcOverride = { token_endpoint: "http://evil.example/token" };
    await refuses(/not an https URL/);
    h.issuer.oidcOverride = {};

    const redirecting = createServer((_req, res) => {
      res.writeHead(302, { location: `${h.host}/.well-known/oauth-protected-resource/mcp` });
      res.end();
    });
    await new Promise<void>((r) => redirecting.listen(0, "127.0.0.1", r));
    try {
      const port = (redirecting.address() as AddressInfo).port;
      await assert.rejects(discoverHosted(h.deps.fetch, resolveHostedTarget(`http://127.0.0.1:${port}`)), (e: CliError) => e.code === "TRANSIENT");
    } finally {
      redirecting.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("S5: a non-https verification link is never relayed", async () => {
  const h = await harness();
  try {
    h.issuer.deviceOverride = { verification_uri_complete: "http://evil.example/activate?user_code=X" };
    await assert.rejects(ensureHostedAccessToken(resolveHostedTarget(h.host), {}, h.deps), (e: CliError) => e.code === "RUNTIME" && /refusing to relay/.test(e.message));
  } finally {
    await h.cleanup();
  }
});

test("trimTrailingSlashes strips only trailing slashes and stays linear on long slash runs", () => {
  assert.equal(trimTrailingSlashes(""), "");
  assert.equal(trimTrailingSlashes("/"), "");
  assert.equal(trimTrailingSlashes("///"), "");
  assert.equal(trimTrailingSlashes("https://a.example/mcp"), "https://a.example/mcp");
  assert.equal(trimTrailingSlashes("https://a.example/mcp///"), "https://a.example/mcp");
  assert.equal(trimTrailingSlashes("https://a.example//mcp/"), "https://a.example//mcp");
  const hostile = `${"/".repeat(200_000)}x${"/".repeat(200_000)}`;
  const started = performance.now();
  assert.equal(trimTrailingSlashes(hostile), `${"/".repeat(200_000)}x`);
  assert.ok(performance.now() - started < 500, "linear time on a hostile slash run");
  const noRegex = /\.replace\(\/\\\/\+\$\//;
  for (const file of ["discovery.ts", "session.ts"]) {
    const text = readFileSync(path.resolve(here, "../src/hosted-auth", file), "utf8");
    assert.doesNotMatch(text, noRegex, `${file} must use trimTrailingSlashes`);
  }
});

test("discovery tolerates trailing slashes on resource and issuer through the shared helper", async () => {
  const h = await harness();
  try {
    h.issuer.prmOverride = { resource: `${h.host}/mcp//` };
    h.issuer.oidcOverride = { issuer: `${h.issuer.issuer}//` };
    const d = await discoverHosted(h.deps.fetch, resolveHostedTarget(`${h.host}//`));
    assert.equal(d.issuer, h.issuer.issuer);
    const token = unsignedJwt({ aud: `${h.host}/mcp///` });
    const deps = { ...h.deps, env: { ...h.deps.env, [ACCESS_TOKEN_ENV]: token } };
    assert.equal((await ensureHostedAccessToken(resolveHostedTarget(h.host), {}, deps)).source, "env");
  } finally {
    await h.cleanup();
  }
});

test("logout keeps revoked:true when revocation succeeded but the store delete failed", async () => {
  const h = await harness();
  try {
    await signIn(h);
    const file = fileSecretStore(h.home, (account) => sessionDirFor(h.home, account));
    const stuck = {
      kind: "file" as const,
      get: (a: string) => file.get(a),
      set: (a: string, v: string) => file.set(a, v),
      delete: async () => {
        throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "locked");
      },
    };
    let out = "";
    await logout(["--host", h.host, "--json"], { stdout: (t) => (out += t), stderr: () => {}, auth: { ...h.deps, store: stuck } });
    const result = JSON.parse(out) as { revoked: boolean; revocation: string; store_cleared: boolean; notes: string[] };
    assert.equal(result.revoked, true);
    assert.equal(result.revocation, "revoked");
    assert.equal(result.store_cleared, false);
    assert.ok(result.notes.some((n) => /already revoked at the issuer/.test(n)));
    assert.ok(!result.notes.some((n) => /neither revoked/.test(n)));
    assert.equal(await readSession(h.home, resolveHostedTarget(h.host)), null);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Background work (a pull on a read, a session start) never starts or clears a sign-in

test("signIn:false: a revoked refresh token is signed_out, with no device request and the stored session untouched", async () => {
  const h = await harness();
  try {
    await signIn(h);
    await expireCachedAccessToken(h);
    h.issuer.expireAllRefreshTokens();
    const target = resolveHostedTarget(h.host);
    const dir = sessionDirFor(h.home, sessionAccount(target));
    const before = await readFile(path.join(dir, "session.json"), "utf8");
    const devices = h.issuer.counts.deviceCode;
    const error = await authRequired(ensureHostedAccessToken(target, { signIn: false }, h.deps));
    assert.equal((error.details as Record<string, unknown>).reason, "signed_out");
    assert.equal(h.issuer.counts.deviceCode, devices, "no device authorization was started");
    assert.equal(await readFile(path.join(dir, "session.json"), "utf8"), before, "the stored session is left for an explicit command");
    assert.ok(await storedRefreshToken(h), "the refresh token is not cleared");
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("pending")), []);
    // An explicit command still handles it: it clears the dead session and relays a new link.
    await authRequired(ensureHostedAccessToken(target, {}, h.deps));
    assert.equal(h.issuer.counts.deviceCode, devices + 1);
  } finally {
    await h.cleanup();
  }
});

test("signIn:false: no session at all is signed_out without any request", async () => {
  const h = await harness();
  try {
    const error = await authRequired(ensureHostedAccessToken(resolveHostedTarget(h.host), { signIn: false }, h.deps));
    assert.equal((error.details as Record<string, unknown>).reason, "signed_out");
    assert.equal(h.issuer.counts.deviceCode + h.issuer.counts.prm, 0);
  } finally {
    await h.cleanup();
  }
});

test("a busy session lock is session_busy inside the caller's lock wait, not the 65-second default", async () => {
  const h = await harness();
  try {
    await signIn(h);
    await expireCachedAccessToken(h);
    const target = resolveHostedTarget(h.host);
    let release!: () => void;
    const held = withSessionLock(target, h.deps, () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await assert.rejects(ensureHostedAccessToken(target, { signIn: false }, { ...h.deps, lockWaitMs: 100 }), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal((error.details as Record<string, unknown>).reason, "session_busy");
      return true;
    });
    assert.ok(Date.now() - started < 2_000);
    release();
    await held;
  } finally {
    await h.cleanup();
  }
});

/** The session lock directory for the harness's host, with the session directory in place. */
async function sessionLockPath(h: Harness): Promise<string> {
  const target = resolveHostedTarget(h.host);
  await withSessionLock(target, h.deps, async () => {});
  return filesystemMutationLockPath(path.join(await realpath(sessionDirFor(h.home, sessionAccount(target))), "session"));
}

/** Leave a session lock behind as a command that is gone would: its directory, `ageMs` old. */
async function plantSessionLock(h: Harness, owner: Record<string, unknown> | null, ageMs: number): Promise<string> {
  const lock = await sessionLockPath(h);
  await mkdir(lock);
  if (owner) await writeFile(path.join(lock, "owner.json"), `${JSON.stringify(owner)}\n`);
  const when = new Date(Date.now() - ageMs);
  await utimes(lock, when, when);
  return lock;
}

async function sessionLockError(h: Harness): Promise<CliError> {
  try {
    await withSessionLock(resolveHostedTarget(h.host), { ...h.deps, lockWaitMs: 100 }, async () => {});
  } catch (error) {
    assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the session lock to be refused");
}

test("an owner-less session lock left by a killed command is session_lock_orphaned, not retryable, and names the lock", async () => {
  const h = await harness();
  const lock = await plantSessionLock(h, null, 60_000);
  try {
    const error = await sessionLockError(h);
    assert.equal(error.code, "CONFLICT");
    assert.equal(toExit(error).exitCode, EXIT.CONFLICT);
    assert.deepEqual(error.details, { reason: "session_lock_orphaned", host: h.host, lock, retryable: false });
    assert.ok(error.help?.includes(lock), error.help);
    await rm(lock, { recursive: true });
    assert.equal(await withSessionLock(resolveHostedTarget(h.host), h.deps, async () => "ran"), "ran", "removing the named lock clears it");
  } finally {
    await rm(lock, { recursive: true, force: true });
    await h.cleanup();
  }
});

test("an owner-less session lock inside the claim grace is a claim in progress: session_busy", async () => {
  const h = await harness();
  const lock = await plantSessionLock(h, null, 0);
  try {
    const error = await sessionLockError(h);
    assert.equal(error.code, "TRANSIENT");
    assert.equal((error.details as Record<string, unknown>).reason, "session_busy");
  } finally {
    await rm(lock, { recursive: true, force: true });
    await h.cleanup();
  }
});

test("a session lock held far past any refresh is orphaned though its PID is alive or its host is another", async () => {
  const h = await harness();
  // A live process other than this one: a record naming this process's own id and claimed before
  // it started is a prior incarnation's, which the filesystem lock reclaims by itself.
  const livePid = process.ppid;
  process.kill(livePid, 0);
  const record = (host: string) => ({ pid: livePid, hostname: host, created_at_ms: Date.now() - SESSION_LOCK_ORPHAN_MS, token: "gone", target: "session" });
  try {
    for (const host of [hostname(), "another-host.example"]) {
      const lock = await plantSessionLock(h, record(host), SESSION_LOCK_ORPHAN_MS + 60_000);
      try {
        const error = await sessionLockError(h);
        assert.equal(error.code, "CONFLICT", host);
        assert.deepEqual(error.details, { reason: "session_lock_orphaned", host: h.host, lock, retryable: false });
        // The same holder inside the bound may still finish, even well past the claim grace: busy.
        const recent = new Date(Date.now() - 60_000);
        await utimes(lock, recent, recent);
        assert.equal((await sessionLockError(h)).details?.reason, "session_busy", host);
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    }
  } finally {
    await h.cleanup();
  }
});

/** An owner record for a session lock another host claimed at `createdAtMs`. */
const claimedAt = (createdAtMs: number) => ({ pid: process.pid, hostname: "another-host.example", created_at_ms: createdAtMs, token: "held", target: "session" });

test("a session lock whose directory is old but whose owner claimed it just now is session_busy, not orphaned", async () => {
  const h = await harness();
  const lock = await plantSessionLock(h, claimedAt(Date.now()), SESSION_LOCK_ORPHAN_MS + 60_000);
  try {
    const error = await sessionLockError(h);
    assert.equal(error.code, "TRANSIENT");
    assert.deepEqual(error.details, { reason: "session_busy", retryable: true, host: h.host });
  } finally {
    await rm(lock, { recursive: true, force: true });
    await h.cleanup();
  }
});

test("a session lock whose directory and owner claim are both old is session_lock_orphaned", async () => {
  const h = await harness();
  const lock = await plantSessionLock(h, claimedAt(Date.now() - SESSION_LOCK_ORPHAN_MS - 60_000), SESSION_LOCK_ORPHAN_MS + 60_000);
  try {
    const error = await sessionLockError(h);
    assert.equal(error.code, "CONFLICT");
    assert.deepEqual(error.details, { reason: "session_lock_orphaned", host: h.host, lock, retryable: false });
  } finally {
    await rm(lock, { recursive: true, force: true });
    await h.cleanup();
  }
});

test("a session lock whose owner claim time is far ahead of this clock is session_lock_orphaned, not busy until the clock catches up", async () => {
  const h = await harness();
  const lock = await plantSessionLock(h, claimedAt(Date.now() + 100 * SESSION_LOCK_ORPHAN_MS), SESSION_LOCK_ORPHAN_MS + 60_000);
  try {
    const error = await sessionLockError(h);
    assert.equal(error.code, "CONFLICT");
    assert.deepEqual(error.details, { reason: "session_lock_orphaned", host: h.host, lock, retryable: false });
  } finally {
    await rm(lock, { recursive: true, force: true });
    await h.cleanup();
  }
});

test("a session lock claimed just now by a holder whose clock runs slightly ahead is session_busy", async () => {
  const h = await harness();
  const lock = await plantSessionLock(h, claimedAt(Date.now() + 30_000), SESSION_LOCK_ORPHAN_MS + 60_000);
  try {
    const error = await sessionLockError(h);
    assert.equal(error.code, "TRANSIENT");
    assert.deepEqual(error.details, { reason: "session_busy", retryable: true, host: h.host });
  } finally {
    await rm(lock, { recursive: true, force: true });
    await h.cleanup();
  }
});

test("a session lock that cannot be released after its work is reported as such, never as session_busy", async () => {
  const h = await harness();
  const lock = await sessionLockPath(h);
  try {
    let error: unknown;
    try {
      await withSessionLock(resolveHostedTarget(h.host), h.deps, async () => {
        const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as Record<string, unknown>;
        await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ ...owner, token: "another" })}\n`);
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
    assert.equal(error.code, "RUNTIME");
    assert.deepEqual(error.details, { reason: "session_lock_release_failed", host: h.host, lock, retryable: false });

    // A lock error the session work itself raised passes through unchanged.
    await rm(lock, { recursive: true, force: true });
    const own = new FilesystemMutationLockError("inner", { lockPath: "/elsewhere", owner: null, stale: false, malformed: true });
    await assert.rejects(
      withSessionLock(resolveHostedTarget(h.host), h.deps, async () => {
        throw own;
      }),
      (caught: unknown) => caught === own,
    );
  } finally {
    await rm(lock, { recursive: true, force: true });
    await h.cleanup();
  }
});
