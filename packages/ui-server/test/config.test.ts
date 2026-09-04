/**
 * `/__ui/config` sharing/workspaces contract (designs/home-surface, PR-B): the consumer-injected
 * loaders pass through verbatim; a THROWING sharing loader reads as `unavailable` — NEVER a
 * fabricated "private" (the truth-table's fail-honest rule); a throwing workspaces loader reads
 * as an empty list; an absent loader makes no claim (`sharing: null`); remote mode derives
 * `hosted` in the runtime itself with no injection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { get as httpGet } from "node:http";

import { MemoryBackend, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer, type SharingSummary, type UiServerHandle, type UiServerOptions } from "../src/server.js";

const SECRET = "config-contract-secret";
const renderDocument = ({ body }: { body: string }) => ({ html: body, bounded: false });

function stubAsset(): { status: number; headers: Record<string, string>; body: Uint8Array } {
  return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: new Uint8Array() };
}

async function fetchConfig(server: UiServerHandle): Promise<Record<string, unknown>> {
  return fetchJson(server, "/__ui/config");
}

async function fetchJson(server: UiServerHandle, requestPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    httpGet(
      { hostname: server.host, port: server.port, path: requestPath, headers: { cookie: `aslite_ui_session=${SECRET}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(text) as Record<string, unknown>);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    ).on("error", reject);
  });
}

function memoryBundle(): Bundle {
  return { root: "mem://config-contract", backend: new MemoryBackend() };
}

async function bootDir(extra: Partial<UiServerOptions>): Promise<UiServerHandle> {
  const bundle = memoryBundle();
  return bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument,
    serveAsset: stubAsset,
    ...extra,
  });
}

const SHARED: SharingSummary = {
  kind: "shared_branch",
  remote: "org/repo",
  as_of: "2026-07-21T00:00:00.000Z",
  refresh_after_ms: 30_000,
};

test("config passes an injected sharing summary and workspaces through verbatim", async () => {
  const server = await bootDir({
    loadSharingSummary: async () => SHARED,
    loadWorkspaces: async () => [{ label: "alpha", path: "/a", open: true }],
  });
  try {
    const config = await fetchConfig(server);
    assert.deepEqual(config.sharing, SHARED);
    assert.deepEqual(config.workspaces, [{ label: "alpha", path: "/a", open: true }]);
  } finally {
    await server.close();
  }
});

test("the session-gated document recovery endpoint returns only the consumer-rendered command", async () => {
  const server = await bootDir({
    renderDocumentOpenCommand: (id) => `consumer-safe:${id}`,
  });
  try {
    const payload = await fetchJson(server, "/__ui/document-open-command?id=docs%2Fcore");
    assert.deepEqual(payload, { command: "consumer-safe:docs/core" });
  } finally {
    await server.close();
  }
});

test("a THROWING sharing loader reads as unavailable with the reason — never a fabricated private", async () => {
  const server = await bootDir({
    loadSharingSummary: async () => {
      throw new Error("git exploded");
    },
    loadWorkspaces: async () => {
      throw new Error("catalog exploded");
    },
  });
  try {
    const config = await fetchConfig(server);
    const sharing = config.sharing as SharingSummary;
    assert.equal(sharing.kind, "unavailable");
    assert.match(String(sharing.reason), /git exploded/);
    assert.ok(sharing.as_of, "unavailable still carries as_of");
    assert.deepEqual(config.workspaces, [], "a throwing workspaces loader is an empty list");
  } finally {
    await server.close();
  }
});

test("an absent loader makes NO claim (sharing null), and workspaces default to empty", async () => {
  const server = await bootDir({});
  try {
    const config = await fetchConfig(server);
    assert.equal(config.sharing, null);
    assert.deepEqual(config.workspaces, []);
  } finally {
    await server.close();
  }
});

test("remote mode derives hosted from the private remote target — no injection involved", async () => {
  const baseUrl = "http://127.0.0.1:1";
  const server = await bootUiServer({
    mode: "remote",
    remote: {
      baseUrl,
      origin: new URL(baseUrl).origin,
      bundleId: "bnd_00000000000000000000000000000000",
    }, // never dialed by the config route
    bundle: memoryBundle(),
    sessionSecret: SECRET,
    renderDocument,
    serveAsset: stubAsset,
  });
  try {
    const config = await fetchConfig(server);
    const sharing = config.sharing as SharingSummary;
    assert.equal(sharing.kind, "hosted");
    assert.equal(sharing.remote, "127.0.0.1:1");
    assert.equal(sharing.refresh_after_ms, undefined, "hosted state is stable for this run and does not poll config");
    assert.deepEqual(config.workspaces, [], "workspaces are a dir-mode block");
    assert.equal(config.bundleId, "bnd_00000000000000000000000000000000");
    assert.equal(JSON.stringify(config).includes("apiKey"), false);
  } finally {
    await server.close();
  }
});
