// A workspace browser origin (`<slug>.<parent>`) serves no protected-resource metadata; its
// `/.well-known/superbee-workspace` pointer names the gateway and the workspace. These tests stub
// fetch with a URL table and record every request, so a refused pointer is proven to send nothing
// to the host it names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CliError } from "../src/errors.js";
import {
  WORKSPACE_POINTER_PATH,
  discoverHosted,
  mayBeWorkspaceOrigin,
  resolveHostedTarget,
  trustedPointerTarget,
  type FetchLike,
} from "../src/hosted-auth/discovery.js";
import {
  defaultHostedAuthDeps,
  hostedWriteHost,
  readPending,
  readSession,
  requireHostedBundleHost,
  resolveNamedHost,
  workspaceForNamedHost,
  type HostedAuthDeps,
} from "../src/hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../src/hosted-auth/secret-store.js";
import { login } from "../src/commands/hosted-auth.js";
import { setupHosted } from "../src/commands/setup-hosted.js";

const ORIGIN = "https://holaxis-sites.getsuperbee.com";
const GATEWAY = "https://mcp.getsuperbee.com";
const ISSUER = "https://issuer.getsuperbee.example/";
const PRM = "/.well-known/oauth-protected-resource/mcp";

type Route = { status: number; body?: unknown };

class StubNet {
  readonly routes = new Map<string, Route | (() => Route)>();
  readonly requests: string[] = [];
  readonly fetch: FetchLike = async (input) => {
    this.requests.push(input);
    const found = this.routes.get(input);
    const route = typeof found === "function" ? found() : found ?? { status: 404 };
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), { status: route.status, headers: { "content-type": "application/json" } });
  };
  hosts(): string[] {
    return [...new Set(this.requests.map((url) => new URL(url).origin))].sort();
  }
}

function pointer(resource: unknown, extra: Record<string, unknown> = {}): Route {
  return { status: 200, body: { schema_version: 1, resource, workspace_slug: "holaxis-sites", ...extra } };
}

/** A gateway that serves metadata, an issuer with device sign-in, and a workspace origin pointing at it. */
function network(originPointer: Route = pointer(`${GATEWAY}/mcp`)): StubNet {
  const net = new StubNet();
  net.routes.set(`${ORIGIN}${WORKSPACE_POINTER_PATH}`, originPointer);
  net.routes.set(`${GATEWAY}${PRM}`, {
    status: 200,
    body: { resource: `${GATEWAY}/mcp`, authorization_servers: [ISSUER], superbee_cli_client_id: "superbee-cli" },
  });
  net.routes.set(`${ISSUER}.well-known/openid-configuration`, {
    status: 200,
    body: {
      issuer: ISSUER,
      token_endpoint: `${ISSUER}oauth/token`,
      device_authorization_endpoint: `${ISSUER}oauth/device/code`,
      revocation_endpoint: `${ISSUER}oauth/revoke`,
    },
  });
  net.routes.set(`${ISSUER}oauth/device/code`, {
    status: 200,
    body: { device_code: "dev-1", user_code: "ABCD-EFGH", verification_uri: `${ISSUER}activate`, expires_in: 900, interval: 5 },
  });
  return net;
}

async function withHome(run: (home: string, now: { t: number }) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-workspace-origin-"));
  try {
    await run(home, { t: Date.parse("2026-10-12T12:00:00Z") });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function deps(home: string, net: StubNet, clock: { t: number }): HostedAuthDeps {
  return defaultHostedAuthDeps(home, {
    env: { [CREDENTIAL_STORE_ENV]: "file" },
    fetch: net.fetch,
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
  });
}

async function refused(promise: Promise<unknown>, code: string): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, `expected CliError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("login on a workspace origin follows its pointer, signs in at the gateway, and stores the session under the gateway", async () => {
  await withHome(async (home, clock) => {
    const net = network();
    const auth = deps(home, net, clock);
    let out = "";
    const io = { stdout: (t: string) => (out += t), stderr: () => {}, auth };

    const waiting = await refused(login(["--host", ORIGIN, "--json"], io), "AUTH_REQUIRED");
    assert.equal(waiting.details?.host, GATEWAY);
    assert.ok(String(waiting.details?.resume).includes(`--host ${GATEWAY}`), "the resume names the gateway");
    assert.ok(await readPending(home, resolveHostedTarget(GATEWAY)), "the pending sign-in is the gateway's");
    assert.equal(await readPending(home, resolveHostedTarget(ORIGIN)), null);
    assert.deepEqual(net.requests.slice(0, 3), [`${ORIGIN}${PRM}`, `${ORIGIN}${WORKSPACE_POINTER_PATH}`, `${GATEWAY}${PRM}`]);

    // The person confirms; the same command completes sign-in.
    net.routes.set(`${ISSUER}oauth/token`, { status: 200, body: { access_token: "at-1", refresh_token: "rt-1", token_type: "Bearer", expires_in: 3600 } });
    clock.t += 6_000;
    await login(["--host", ORIGIN, "--json"], io);
    const signedIn = JSON.parse(out) as Record<string, unknown>;
    assert.equal(signedIn.status, "signed_in");
    assert.equal(signedIn.host, GATEWAY);
    assert.equal(signedIn.audience, `${GATEWAY}/mcp`);
    assert.equal(signedIn.host_from, "workspace-origin");
    assert.equal(signedIn.requested_host, ORIGIN);
    assert.equal(signedIn.workspace_slug, "holaxis-sites");
    assert.ok(await readSession(home, resolveHostedTarget(GATEWAY)), "the session is stored under the gateway");
    assert.equal(await readSession(home, resolveHostedTarget(ORIGIN)), null);

    // Typing the gateway reuses that session with no request at all.
    const before = net.requests.length;
    out = "";
    await login(["--host", GATEWAY, "--json"], io);
    const again = JSON.parse(out) as Record<string, unknown>;
    assert.equal(again.status, "already_signed_in");
    assert.equal(again.host_from, undefined, "a typed gateway is not reported as a workspace origin");
    assert.equal(net.requests.length, before);
  });
});

test("the origin's workspace is used unless --workspace names it too; a different --workspace is USAGE naming both", async () => {
  await withHome(async (home, clock) => {
    const net = network();
    const auth = deps(home, net, clock);
    const named = await requireHostedBundleHost(ORIGIN, auth);
    assert.equal(named.target.origin, GATEWAY);
    assert.equal(named.workspaceSlug, "holaxis-sites");
    assert.equal(workspaceForNamedHost(named, undefined), "holaxis-sites");
    assert.equal(workspaceForNamedHost(named, "holaxis-sites"), "holaxis-sites");
    const conflict = (() => {
      try {
        workspaceForNamedHost(named, "agilesix");
      } catch (error) {
        return error as CliError;
      }
      assert.fail("expected a refusal");
    })();
    assert.equal(conflict.code, "USAGE");
    assert.match(conflict.message, /holaxis-sites/);
    assert.match(conflict.message, /agilesix/);

    // A command refuses before any sign-in is started.
    const before = net.requests.length;
    await refused(setupHosted(["--url", ORIGIN, "--workspace", "agilesix", "--json"], { stdout: () => {}, auth }), "USAGE");
    assert.ok(net.requests.slice(before).every((url) => !url.startsWith(ISSUER)), "no sign-in request after a conflicting --workspace");

    // A host typed as itself carries no workspace of its own.
    const plain = await requireHostedBundleHost(GATEWAY, auth);
    assert.equal(workspaceForNamedHost(plain, "agilesix"), "agilesix");
  });
});

test("a write host from a workspace origin reports host_from workspace-origin; a preview makes no request", async () => {
  await withHome(async (home, clock) => {
    const net = network();
    const followed = await hostedWriteHost(ORIGIN, home, (host) => host, net.fetch);
    assert.equal(followed?.target.origin, GATEWAY);
    assert.equal(followed?.source, "workspace-origin");
    assert.equal(followed?.workspaceSlug, "holaxis-sites");
    const before = net.requests.length;
    const preview = await hostedWriteHost(ORIGIN, home, (host) => host, null);
    assert.equal(preview?.target.origin, ORIGIN);
    assert.equal(preview?.source, "flag");
    assert.equal(net.requests.length, before);
    void clock;
  });
});

const ADVERSARIAL: readonly { readonly name: string; readonly route: Route; readonly foreign?: string }[] = [
  { name: "an unrelated host", route: pointer("https://evil.example/mcp"), foreign: "https://evil.example" },
  { name: "plain http on the gateway", route: pointer(`http://mcp.getsuperbee.com/mcp`), foreign: "http://mcp.getsuperbee.com" },
  { name: "a lookalike suffix", route: pointer("https://mcp.getsuperbee.com.evil.example/mcp"), foreign: "https://mcp.getsuperbee.com.evil.example" },
  { name: "userinfo", route: pointer("https://user:pw@mcp.getsuperbee.com/mcp"), foreign: GATEWAY },
  { name: "an explicit port", route: pointer("https://mcp.getsuperbee.com:8443/mcp"), foreign: "https://mcp.getsuperbee.com:8443" },
  { name: "the parent domain itself", route: pointer("https://getsuperbee.com/mcp"), foreign: "https://getsuperbee.com" },
  { name: "the origin itself", route: pointer(`${ORIGIN}/mcp`) },
  { name: "another workspace origin", route: pointer("https://other-org.getsuperbee.com/mcp"), foreign: "https://other-org.getsuperbee.com" },
  { name: "schema_version 2", route: pointer(`${GATEWAY}/mcp`, { schema_version: 2 }), foreign: GATEWAY },
  { name: "a bad slug", route: pointer(`${GATEWAY}/mcp`, { workspace_slug: "Holaxis_Sites" }), foreign: GATEWAY },
  { name: "a missing slug", route: { status: 200, body: { schema_version: 1, resource: `${GATEWAY}/mcp` } }, foreign: GATEWAY },
  { name: "no pointer", route: { status: 404 }, foreign: GATEWAY },
  { name: "a non-object pointer", route: { status: 200, body: [`${GATEWAY}/mcp`] }, foreign: GATEWAY },
];

for (const { name, route, foreign } of ADVERSARIAL) {
  test(`a pointer with ${name} is refused with the improved error and nothing is sent to the host it names`, async () => {
    await withHome(async (home, clock) => {
      const net = network(route);
      const error = await refused(resolveNamedHost(ORIGIN, deps(home, net, clock)), "RUNTIME");
      assert.equal(error.details?.reason, "no_protected_resource_metadata");
      assert.equal(error.details?.suggested_host, GATEWAY);
      assert.equal(error.details?.suggested_workspace, "holaxis-sites");
      assert.match(String(error.help), /may be a workspace address/);
      assert.match(String(error.help), /--host https:\/\/mcp\.getsuperbee\.com --workspace holaxis-sites/);
      assert.deepEqual(net.hosts(), [ORIGIN]);
      if (foreign) assert.ok(net.requests.every((url) => !url.startsWith(foreign) || url.startsWith(ORIGIN)));
    });
  });
}

test("a pointer is followed one hop only: a gateway without metadata is reported, never asked for its own pointer", async () => {
  await withHome(async (home, clock) => {
    const net = network();
    net.routes.set(`${GATEWAY}${PRM}`, { status: 404 });
    net.routes.set(`${GATEWAY}${WORKSPACE_POINTER_PATH}`, pointer("https://second.getsuperbee.com/mcp"));
    const auth = deps(home, net, clock);
    const error = await refused(login(["--host", ORIGIN, "--json"], { stdout: () => {}, stderr: () => {}, auth }), "RUNTIME");
    assert.equal(error.details?.host, GATEWAY);
    assert.equal(error.details?.suggested_host, undefined, "the gateway label is not suggested as a workspace");
    assert.ok(!net.requests.includes(`${GATEWAY}${WORKSPACE_POINTER_PATH}`), "the gateway's pointer is never read");
    assert.deepEqual(net.hosts(), [GATEWAY, ORIGIN].sort());
  });
});

test("only a bare https named origin may be a workspace origin; a pointer from a non-https origin is never trusted", () => {
  assert.equal(mayBeWorkspaceOrigin(resolveHostedTarget(ORIGIN)), true);
  assert.equal(mayBeWorkspaceOrigin(resolveHostedTarget(`${ORIGIN}/agents/abc/mcp`)), false);
  assert.equal(mayBeWorkspaceOrigin(resolveHostedTarget("https://getsuperbee.com")), false);
  assert.equal(mayBeWorkspaceOrigin(resolveHostedTarget("https://10.0.0.1")), false);
  assert.equal(mayBeWorkspaceOrigin(resolveHostedTarget("https://a.getsuperbee.com:8443")), false);
  assert.equal(mayBeWorkspaceOrigin(resolveHostedTarget("http://127.0.0.1:4000")), false);
  assert.equal(trustedPointerTarget("http://holaxis-sites.getsuperbee.com", `${GATEWAY}/mcp`), null);
  assert.equal(trustedPointerTarget(ORIGIN, `${GATEWAY}/mcp`)?.audience, `${GATEWAY}/mcp`);
  assert.equal(trustedPointerTarget("https://agilesix.getsuperbee-staging.com", "https://mcp.getsuperbee-staging.com/mcp")?.origin, "https://mcp.getsuperbee-staging.com");
  assert.equal(trustedPointerTarget("https://agilesix.getsuperbee-staging.com", `${GATEWAY}/mcp`), null);
});

test("a host with no metadata and a non-workspace shape gets the plain refusal, without a guessed gateway", async () => {
  const net = new StubNet();
  const error = await refused(discoverHosted(net.fetch, resolveHostedTarget("https://getsuperbee.com")), "RUNTIME");
  assert.match(error.message, /returned HTTP 404/);
  assert.equal(error.details?.suggested_host, undefined);
  assert.ok(error.help);
});

test("a host with a stored or pending sign-in is used without a request", async () => {
  await withHome(async (home, clock) => {
    const net = network();
    const auth = deps(home, net, clock);
    await refused(login(["--host", GATEWAY, "--json"], { stdout: () => {}, stderr: () => {}, auth }), "AUTH_REQUIRED");
    const before = net.requests.length;
    const named = await resolveNamedHost(GATEWAY, auth);
    assert.equal(named.target.origin, GATEWAY);
    assert.equal(named.requestedOrigin, null);
    assert.equal(net.requests.length, before);
  });
});
