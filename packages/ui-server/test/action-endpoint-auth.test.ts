/**
 * Real-HTTP agreement pins for the trusted-action routes' fail-closed request layers. Service
 * behavior is covered in actions.test.ts; this suite proves routing rejects bad requests before
 * an approval token is consumed or a document can change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import {
  MemoryBackend,
  readDocVersioned,
  writeBlob,
  writeDoc,
  type Bundle,
} from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer, type UiServerHandle } from "../src/server.js";

const SECRET = "action-endpoint-auth-secret";
const renderDocument = ({ body }: { body: string }) => ({ html: body, bounded: false });
const COOKIE = `aslite_ui_session=${SECRET}`;
const T = "2026-07-19T00:00:00.000Z";
const JSON_HEADERS = {
  cookie: COOKIE,
  "content-type": "application/json",
  "x-requested-with": "agentstate-lite-ui",
};
const PREAUTHORIZED_VIEWS = {
  async isAuthorized() { return true; },
  async authorize() {},
};

interface ProbeResponse {
  status: number;
  body: {
    error?: { message?: unknown };
    status?: unknown;
    launchId?: unknown;
    approvalToken?: unknown;
  };
}

interface Fixture {
  bundle: Bundle;
  server: UiServerHandle;
  launchId: string;
  action: Record<string, unknown>;
}

async function post(
  server: UiServerHandle,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<ProbeResponse> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: server.host,
        port: server.port,
        path: pathname,
        method: "POST",
        headers: { "content-length": String(Buffer.byteLength(text)), ...headers },
      },
      (res) => {
        let responseText = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseText += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(responseText) as ProbeResponse["body"] });
          } catch (error) {
            reject(new Error(`response was not JSON: ${responseText} (${String(error)})`));
          }
        });
      },
    );
    req.once("error", reject);
    req.end(text);
  });
}

/**
 * Write a body chunk but deliberately never end the request. A bounded server must answer from
 * headers/stream limits instead of waiting for EOF and buffering the rest.
 */
async function postChunkBeforeEnd(
  server: UiServerHandle,
  pathname: string,
  chunk: Buffer,
  headers: Record<string, string>,
): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: server.host,
        port: server.port,
        path: pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let responseText = "";
        res.setEncoding("utf8");
        res.on("data", (part) => (responseText += part));
        res.on("end", () => {
          req.destroy();
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(responseText) as ProbeResponse["body"],
            });
          } catch (error) {
            reject(new Error(`response was not JSON: ${responseText} (${String(error)})`));
          }
        });
      },
    );
    req.once("error", (error) => {
      if (!req.destroyed) reject(error);
    });
    req.write(chunk);
  });
}

async function fixture(): Promise<Fixture> {
  const bundle: Bundle = { root: "mem://action-endpoint-auth", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: {
        required: ["title", "status"],
        optional: [],
        values: { status: ["todo", "done"] },
      },
      timestamp: T,
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "tasks/alpha",
    frontmatter: { type: "Task", title: "Alpha", status: "todo", timestamp: T },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/actions",
    frontmatter: {
      type: "View",
      title: "Actions",
      entry: "views/actions.html",
      access: "bundle-propose",
      timestamp: T,
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/actions.html",
    new TextEncoder().encode("<!doctype html><button>done</button>"),
    "text/html; charset=utf-8",
  );

  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument,
    actor: "mike/test",
    viewAuthorization: PREAUTHORIZED_VIEWS,
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
  const mint = await post(server, "/__page/mint", { registryId: "views-registry/actions" });
  assert.equal(mint.status, 200);
  assert.equal(typeof mint.body.launchId, "string");
  const target = await readDocVersioned(bundle, "tasks/alpha");
  return {
    bundle,
    server,
    launchId: mint.body.launchId as string,
    action: {
      kind: "document.set-field",
      docId: "tasks/alpha",
      field: "status",
      value: "done",
      expectedVersion: target.version,
    },
  };
}

async function prepareApproval(f: Fixture): Promise<string> {
  const response = await post(f.server, "/__ui/actions/prepare", {
    launchId: f.launchId,
    action: f.action,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "prepared");
  assert.equal(typeof response.body.approvalToken, "string");
  return response.body.approvalToken as string;
}

async function cancelApproval(f: Fixture, approvalToken: string): Promise<void> {
  const response = await post(f.server, "/__ui/actions/cancel", { approvalToken });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "cancelled", "the refused request must not consume the approval");
}

const ENDPOINTS = ["prepare", "commit", "cancel"] as const;

interface Guard {
  name: string;
  status: number;
  message: RegExp;
  request(body: Record<string, unknown>): { body: unknown; headers: Record<string, string> };
}

const GUARDS: Guard[] = [
  {
    name: "Host allowlist",
    status: 403,
    message: /Host header is not in the loopback allowlist/,
    request: (body) => ({ body, headers: { ...JSON_HEADERS, host: "example.com" } }),
  },
  {
    name: "session gate",
    status: 403,
    message: /missing or invalid session/,
    request: (body) => {
      const { cookie: _cookie, ...headers } = JSON_HEADERS;
      return { body, headers };
    },
  },
  {
    name: "missing X-Requested-With",
    status: 403,
    message: /a mutation requires an X-Requested-With header/,
    request: (body) => {
      const { "x-requested-with": _requestedWith, ...headers } = JSON_HEADERS;
      return { body, headers };
    },
  },
  {
    name: "wrong X-Requested-With",
    status: 403,
    message: /trusted actions require X-Requested-With: agentstate-lite-ui/,
    request: (body) => ({ body, headers: { ...JSON_HEADERS, "x-requested-with": "wrong" } }),
  },
  {
    name: "JSON content type",
    status: 415,
    message: /trusted action requests require application\/json/,
    request: (body) => ({ body, headers: { ...JSON_HEADERS, "content-type": "text/plain" } }),
  },
  {
    name: "16 KiB body cap",
    status: 413,
    message: /trusted action request body must be at most 16 KiB/,
    request: (body) => ({ body: { ...body, padding: "x".repeat(16 * 1024) }, headers: JSON_HEADERS }),
  },
  {
    name: "exact body keys",
    status: 400,
    message: /trusted action request must contain exactly/,
    request: (body) => ({ body: { ...body, extra: true }, headers: JSON_HEADERS }),
  },
];

test("/__ui/actions endpoints reject every request layer before action state changes", async (t) => {
  const f = await fixture();
  try {
    for (const endpoint of ENDPOINTS) {
      for (const guard of GUARDS) {
        await t.test(`${endpoint}: ${guard.name}`, async () => {
          const approvalToken = endpoint === "prepare" ? undefined : await prepareApproval(f);
          const validBody =
            endpoint === "prepare"
              ? { launchId: f.launchId, action: f.action }
              : { approvalToken: approvalToken! };
          const probe = guard.request(validBody);
          const response = await post(f.server, `/__ui/actions/${endpoint}`, probe.body, probe.headers);

          assert.equal(response.status, guard.status);
          assert.match(String(response.body.error?.message ?? ""), guard.message);
          assert.equal((await readDocVersioned(f.bundle, "tasks/alpha")).doc.frontmatter.status, "todo");

          if (approvalToken) {
            await cancelApproval(f, approvalToken);
          } else {
            const cleanupToken = await prepareApproval(f);
            await cancelApproval(f, cleanupToken);
          }
        });
      }
    }
  } finally {
    await f.server.close();
  }
});

test("request ingress rejects unauthenticated and oversized chunked bodies before EOF", async () => {
  const f = await fixture();
  try {
    const unauthenticated = await postChunkBeforeEnd(
      f.server,
      "/__ui/actions/prepare",
      Buffer.alloc(1024 * 1024),
      {
        "content-type": "application/json",
        "x-requested-with": "agentstate-lite-ui",
      },
    );
    assert.equal(unauthenticated.status, 403);
    assert.match(
      String(unauthenticated.body.error?.message ?? ""),
      /missing or invalid session/,
    );

    const oversized = await postChunkBeforeEnd(
      f.server,
      "/__ui/actions/prepare",
      Buffer.alloc(16 * 1024 + 1),
      JSON_HEADERS,
    );
    assert.equal(oversized.status, 413);
    assert.match(
      String(oversized.body.error?.message ?? ""),
      /trusted action request body must be at most 16 KiB/,
    );
  } finally {
    await f.server.close();
  }
});
