/**
 * CLI integration: `--remote` against a gated wire handler — the end-to-end proof that a real
 * command's error path closes the documented
 * misclassification (`docs/WIRE-PROTOCOL.md`'s formerly-open "client-side error envelope
 * carries no code" gap): a wrong/missing API key surfaces as `AUTH_REQUIRED`/exit 4 with an
 * `AGENTSTATE_LITE_API_KEY` fixing hint, and a genuine server-side failure (an unconfigured gate)
 * surfaces as `RUNTIME`/exit 1 — NOT
 * the pre-existing generic `USAGE`/exit 2 every command's catch-all used to produce for any
 * non-CliError throw.
 *
 * The gate below is a minimal API-key envelope wrapped around the REAL
 * `@superbee/server` router over a `MemoryBackend` — exactly the generic "wire-protocol
 * router behind an API-key gate" shape the public client must tolerate. `globalThis.fetch` is
 * monkey-patched for the duration of each test to route to
 * this in-process handler — no real socket — mirroring `packages/core/test/wire-protocol.test.ts`'s
 * "router injected as the transport" pattern, applied at the point the CLI's `--remote` resolution
 * (`bundle.ts`) actually calls `fetch` from (it has no injectable `fetchImpl` seam of its own).
 *
 * Exercised through `errors.ts`'s `toExit` (the SAME function `cli.ts`'s `formatError` calls on
 * whatever a command throws), not `instanceof CliError` on the raw thrown value: `list` (used in
 * most tests below) has NO command-local catch-all of its own — like most commands, it relies
 * entirely on `toExit`'s new `RemoteError` branch to classify an uncaught one, which a direct-call
 * unit test only observes by running the SAME step `cli.ts` runs in production. The final test
 * repeats the wrong-key case through `doc read`, which DOES have its own `classifyBundleError`
 * catch-all (`commands/doc.ts`) — proving that path's pre-classified `CliError` survives `toExit`
 * unchanged too, so the seam's two distinct closure points (a command-local catch-all vs. the
 * global fallback) both land on the identical exit code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryBackend, writeDoc, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";

import { list } from "../src/commands/list.js";
import { doc } from "../src/commands/doc.js";
import { link } from "../src/commands/link.js";
import { toExit } from "../src/errors.js";
import { API_KEY_ENV_VAR, SUPERBEE_API_KEY_ENV_VAR, resolveApiKeyEnv } from "../src/bundle.js";
import { saveApiKeyForOrigin } from "../src/credentials.js";

const REMOTE_URL = "http://gate-test.local";
const CORRECT_KEY = "correct-worker-api-key";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Minimal API-key gate using the wire error-envelope shape and HTTP status codes. */
function gate(
  router: (req: Request) => Promise<Response>,
  configuredKey: string | undefined,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (!configuredKey) {
      return jsonResponse(500, { error: { code: "RUNTIME", message: "this deployment has no API_KEY configured" } });
    }
    const match = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") ?? "");
    if (!match || match[1] !== configuredKey) {
      return jsonResponse(401, { error: { code: "AUTH_REQUIRED", message: "missing or invalid API key" } });
    }
    return router(req);
  };
}

/**
 * Simulates the production finding (Stage-1 Unit 2b): an intermediary (Cloudflare's edge,
 * applying Brotli compression) silently stripping BOTH version-transport headers
 * (`X-Version`/`ETag`) from an otherwise-normal response. Wraps a real router's response so a
 * test can drive the ACTUAL `RemoteBackend.extractVersion` -> `RemoteError(VERSION_MISSING)` ->
 * `classifyBundleError`/`toExit` -> exit-code path end to end, through a real CLI command.
 */
function stripVersionHeaders(router: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const res = await router(req);
    const headers = new Headers(res.headers);
    headers.delete("X-Version");
    headers.delete("ETag");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

async function withGatedFetch<T>(handler: (req: Request) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function withApiKeyEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env[API_KEY_ENV_VAR];
  if (value === undefined) delete process.env[API_KEY_ENV_VAR];
  else process.env[API_KEY_ENV_VAR] = value;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env[API_KEY_ENV_VAR];
    else process.env[API_KEY_ENV_VAR] = original;
  }
}

async function withApiKeyEnvs<T>(
  values: Record<typeof API_KEY_ENV_VAR | typeof SUPERBEE_API_KEY_ENV_VAR, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const originals = new Map<string, string | undefined>();
  for (const key of [API_KEY_ENV_VAR, SUPERBEE_API_KEY_ENV_VAR] as const) {
    originals.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const key of [API_KEY_ENV_VAR, SUPERBEE_API_KEY_ENV_VAR] as const) {
      const original = originals.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

/**
 * Redirect `os.homedir()`'s resolution to `home` for the duration of `run` — `credentials.ts`'s
 * `getApiKeyForOrigin`/`saveApiKeyForOrigin` accept an optional `home` param, but `bundle.ts`'s
 * `openRemoteBundle` calls `getApiKeyForOrigin(origin)` WITHOUT one (real usage always wants the
 * real home dir), so the only way to point it at an isolated temp dir from a test is to redirect
 * the env vars `os.homedir()` itself reads (`HOME` on POSIX). Node re-reads these on every call
 * (no caching), so this is safe to toggle per-test.
 */
async function withHomeEnv<T>(home: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

async function freshRouter(): Promise<(req: Request) => Promise<Response>> {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://gate-test", backend };
  await writeDoc(bundle, { id: "concepts/alpha", frontmatter: { type: "Concept", title: "Alpha" }, body: "hi" });
  return createRouter(bundle);
}

/** Run `run`, catch whatever it throws, and push it through `toExit` — exactly what `cli.ts`'s `formatError` does in production. */
async function exitOf(run: () => Promise<void>): Promise<ReturnType<typeof toExit>> {
  try {
    await run();
  } catch (err) {
    return toExit(err);
  }
  throw new Error("expected run() to throw");
}

test("--remote against a gated handler: wrong API key -> AUTH_REQUIRED, exit 4, help names the supported env credential and no retired verb", async () => {
  const router = await freshRouter();
  await withApiKeyEnv("totally-wrong-key", () =>
    withGatedFetch(gate(router, CORRECT_KEY), async () => {
      const { exitCode, envelope } = await exitOf(() => list(["--remote", REMOTE_URL, "--json"], {}));
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, "AUTH_REQUIRED");
      assert.match(envelope.error.help ?? "", /AGENTSTATE_LITE_API_KEY=<key>/);
      assert.doesNotMatch(envelope.error.help ?? "", /\b(?:login|join|whoami)\s+--remote\b/);
    }),
  );
});

test("--remote against a gated handler: MISSING API key (env unset, no credentials-file entry) -> AUTH_REQUIRED, exit 4", async () => {
  const router = await freshRouter();
  await withApiKeyEnv(undefined, () =>
    withGatedFetch(gate(router, CORRECT_KEY), async () => {
      const { exitCode, envelope } = await exitOf(() => list(["--remote", REMOTE_URL, "--json"], {}));
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, "AUTH_REQUIRED");
      assert.match(envelope.error.help ?? "", /AGENTSTATE_LITE_API_KEY=<key>/);
      assert.doesNotMatch(envelope.error.help ?? "", /\b(?:login|join|whoami)\s+--remote\b/);
    }),
  );
});

test("--remote against a gated handler: server-side fail-closed 500 (unconfigured deployment) -> RUNTIME, exit 1 — the regression this unit closes (previously misclassified as USAGE/exit 2)", async () => {
  const router = await freshRouter();
  await withApiKeyEnv("doesnt-matter-gate-fails-closed", () =>
    withGatedFetch(gate(router, undefined), async () => {
      const { exitCode, envelope } = await exitOf(() => list(["--remote", REMOTE_URL, "--json"], {}));
      assert.equal(exitCode, 1);
      assert.equal(envelope.error.code, "RUNTIME");
    }),
  );
});

test("--remote against a gated handler: the CORRECT API key (via AGENTSTATE_LITE_API_KEY) passes through and the command succeeds", async () => {
  const router = await freshRouter();
  await withApiKeyEnv(CORRECT_KEY, () =>
    withGatedFetch(gate(router, CORRECT_KEY), async () => {
      let out = "";
      await list(["--remote", REMOTE_URL, "--json"], { stdout: (s: string) => (out += s) });
      const parsed = JSON.parse(out) as { count: number };
      assert.equal(parsed.count, 1);
    }),
  );
});

test("--remote against a gated handler, via a command WITH its own catch-all (doc read): wrong API key still lands on AUTH_REQUIRED/exit 4, not the pre-existing blind USAGE/exit 2", async () => {
  const router = await freshRouter();
  await withApiKeyEnv("totally-wrong-key", () =>
    withGatedFetch(gate(router, CORRECT_KEY), async () => {
      const { exitCode, envelope } = await exitOf(() => doc(["read", "concepts/alpha", "--remote", REMOTE_URL, "--json"], {}));
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, "AUTH_REQUIRED");
      assert.match(envelope.error.help ?? "", /AGENTSTATE_LITE_API_KEY=<key>/);
      assert.doesNotMatch(envelope.error.help ?? "", /\b(?:login|join|whoami)\s+--remote\b/);
    }),
  );
});

test("--remote against a gated handler, via `link list` (graph-query-v0's queryEdges scan): wrong API key lands on AUTH_REQUIRED/exit 4, AND the help names the REAL remote origin, not the generic '<url>' placeholder a command with no local catch-all would fall back to (P2c)", async () => {
  const router = await freshRouter();
  await withApiKeyEnv("totally-wrong-key", () =>
    withGatedFetch(gate(router, CORRECT_KEY), async () => {
      const { exitCode, envelope } = await exitOf(() => link(["list", "--remote", REMOTE_URL, "--json"], {}));
      assert.equal(exitCode, 4);
      assert.equal(envelope.error.code, "AUTH_REQUIRED");
      assert.match(envelope.error.help ?? "", /AGENTSTATE_LITE_API_KEY=<key>/);
      assert.doesNotMatch(envelope.error.help ?? "", /\b(?:login|join|whoami)\s+--remote\b/);
      assert.match(
        envelope.error.help ?? "",
        new RegExp(REMOTE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `help must name the real remote origin (${REMOTE_URL}), not fall back to a generic '<url>' placeholder`,
      );
      assert.ok(!(envelope.error.help ?? "").includes("<url>"), "help must not contain the unresolved '<url>' placeholder");
    }),
  );
});

test("--remote: AGENTSTATE_LITE_API_KEY (env) beats a stored credentials-file key for the SAME origin when BOTH are set", async () => {
  const router = await freshRouter();
  const home = await mkdtemp(path.join(tmpdir(), "agentstate-lite-envkey-test-"));
  try {
    // The gate accepts ONLY the env-sourced key. A credentials-file entry for the SAME origin
    // carries a DIFFERENT key that the gate would reject — so the command succeeding is only
    // possible if bundle.ts's `openRemoteBundle` actually preferred the env var over the file.
    const origin = new URL(REMOTE_URL).origin;
    await saveApiKeyForOrigin(origin, "credentials-file-key-should-NOT-be-sent", home);

    await withHomeEnv(home, () =>
      withApiKeyEnv(CORRECT_KEY, () =>
        withGatedFetch(gate(router, CORRECT_KEY), async () => {
          let out = "";
          await list(["--remote", REMOTE_URL, "--json"], { stdout: (s: string) => (out += s) });
          const parsed = JSON.parse(out) as { count: number };
          assert.equal(
            parsed.count,
            1,
            "the command succeeded against a gate that only accepts the ENV key — proves env beat the credentials file",
          );
        }),
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("--remote: Superbee and legacy API-key env vars are compatible aliases with conflict checks", () => {
  assert.equal(resolveApiKeyEnv({ [SUPERBEE_API_KEY_ENV_VAR]: `  ${CORRECT_KEY}  ` }), CORRECT_KEY);
  assert.equal(resolveApiKeyEnv({ [API_KEY_ENV_VAR]: `  ${CORRECT_KEY}  ` }), CORRECT_KEY);
  assert.equal(
    resolveApiKeyEnv({ [SUPERBEE_API_KEY_ENV_VAR]: `  ${CORRECT_KEY}  `, [API_KEY_ENV_VAR]: CORRECT_KEY }),
    CORRECT_KEY,
  );
  assert.equal(resolveApiKeyEnv({ [SUPERBEE_API_KEY_ENV_VAR]: "", [API_KEY_ENV_VAR]: "   " }), undefined);
  assert.throws(
    () => resolveApiKeyEnv({ [SUPERBEE_API_KEY_ENV_VAR]: "superbee-secret", [API_KEY_ENV_VAR]: "legacy-secret" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(SUPERBEE_API_KEY_ENV_VAR));
      assert.match(err.message, new RegExp(API_KEY_ENV_VAR));
      assert.doesNotMatch(err.message, /superbee-secret|legacy-secret/);
      return true;
    },
  );
});

test("--remote: SUPERBEE_API_KEY env alias beats a stored credentials-file key for the SAME origin", async () => {
  const router = await freshRouter();
  const home = await mkdtemp(path.join(tmpdir(), "agentstate-lite-superbee-envkey-test-"));
  try {
    const origin = new URL(REMOTE_URL).origin;
    await saveApiKeyForOrigin(origin, "credentials-file-key-should-NOT-be-sent", home);

    await withHomeEnv(home, () =>
      withApiKeyEnvs({ [API_KEY_ENV_VAR]: undefined, [SUPERBEE_API_KEY_ENV_VAR]: CORRECT_KEY }, () =>
        withGatedFetch(gate(router, CORRECT_KEY), async () => {
          let out = "";
          await list(["--remote", REMOTE_URL, "--json"], { stdout: (s: string) => (out += s) });
          const parsed = JSON.parse(out) as { count: number };
          assert.equal(parsed.count, 1);
        }),
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("--remote: a response stripped of BOTH version headers (the production finding) surfaces as RUNTIME/exit 1 through the CLI, never a silent success or a misclassified USAGE/exit 2", async () => {
  const router = await freshRouter();
  await withGatedFetch(stripVersionHeaders(router), async () => {
    // doc read (commands/doc.ts) has its OWN classifyBundleError catch-all — proves the
    // command-local closure point maps VERSION_MISSING to RUNTIME, complementing the
    // toExit-fallback coverage the other tests in this file already give `list`.
    const { exitCode, envelope } = await exitOf(() => doc(["read", "concepts/alpha", "--remote", REMOTE_URL, "--json"], {}));
    assert.equal(exitCode, 1);
    assert.equal(envelope.error.code, "RUNTIME");
    assert.match(envelope.error.message, /neither an X-Version nor an ETag/);
  });
});

/**
 * Wraps a router so any doc/blob/reserved WRITE (PUT) returns a `403 FORBIDDEN` role-denial,
 * exactly as the Stage-2 auth gate does for a `reader` attempting a write — while reads pass
 * through (so `doc write`'s F1 read-guard sees a normal 404 for a fresh id and proceeds to the
 * PUT that then gets forbidden). This drives the ACTUAL `RemoteBackend.write` -> `toError`
 * (envelope `code`) -> `mutateDoc`'s `classify` -> `classifyBundleError` -> `toExit` path.
 */
function forbidWrites(router: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "PUT") {
      return jsonResponse(403, {
        error: { code: "FORBIDDEN", message: "role 'reader' does not satisfy the required 'writer' role for this route" },
      });
    }
    return router(req);
  };
}

test("--remote: a 403 role-denial on doc write keeps its FORBIDDEN code through mutateDoc (regression: was flattened to USAGE) — exit 2, code FORBIDDEN, not USAGE", async () => {
  const router = await freshRouter();
  await withApiKeyEnv(CORRECT_KEY, () =>
    withGatedFetch(gate(forbidWrites(router), CORRECT_KEY), async () => {
      // A FRESH id: the F1 read-guard GET returns 404 (creation, nothing to guard), then the PUT
      // is the request the gate forbids. mutateDoc's classify (overwrite mode) must delegate to
      // classifyBundleError so the server's FORBIDDEN survives instead of collapsing to USAGE.
      const { exitCode, envelope } = await exitOf(() =>
        doc(["write", "concepts/fresh-doc", "--type", "Concept", "--title", "t", "--body", "b", "--remote", REMOTE_URL, "--json"], {}),
      );
      assert.equal(exitCode, 2); // FORBIDDEN maps to exit 2 (least-wrong; re-auth would not grant a role)
      assert.equal(envelope.error.code, "FORBIDDEN"); // NOT "USAGE" — the code the fix preserves
      assert.match(envelope.error.message, /does not satisfy the required 'writer' role/);
    }),
  );
});

/** Answers every request with a 5xx carrying a code the CLI has never heard of. */
function unknownCode5xx(): (req: Request) => Promise<Response> {
  return async (): Promise<Response> =>
    jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "unexpected condition" } });
}

/** Answers every request with a 4xx carrying a code the CLI has never heard of. */
function unknownCode4xx(): (req: Request) => Promise<Response> {
  return async (): Promise<Response> =>
    jsonResponse(422, { error: { code: "UNPROCESSABLE", message: "the request was understood but rejected" } });
}

test("--remote: an unknown wire code on a 5xx (INTERNAL_ERROR) -> RUNTIME, exit 1 — never USAGE (P1 fix round 2)", async () => {
  await withApiKeyEnv(CORRECT_KEY, () =>
    withGatedFetch(unknownCode5xx(), async () => {
      const { exitCode, envelope } = await exitOf(() => list(["--remote", REMOTE_URL, "--json"], {}));
      assert.equal(exitCode, 1);
      assert.equal(envelope.error.code, "RUNTIME");
      assert.match(envelope.error.message, /unexpected condition/);
    }),
  );
});

test("--remote: an unknown wire code on a 4xx (UNPROCESSABLE, 422) -> USAGE, exit 2 — the adjudicated attested-client-fault rule", async () => {
  await withApiKeyEnv(CORRECT_KEY, () =>
    withGatedFetch(unknownCode4xx(), async () => {
      const { exitCode, envelope } = await exitOf(() => list(["--remote", REMOTE_URL, "--json"], {}));
      assert.equal(exitCode, 2);
      assert.equal(envelope.error.code, "USAGE");
      assert.match(envelope.error.message, /understood but rejected/);
    }),
  );
});
