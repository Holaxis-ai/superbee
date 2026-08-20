import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryBackend,
  readDocVersioned,
  writeBlob,
  writeDoc,
  type Bundle,
} from "@superbee/core";
import { createRouter } from "@superbee/server";
import { bootUiServer, type UiServerHandle } from "../src/server.js";

const SECRET = "view-delivery-secret";
const T = "2026-08-20T00:00:00.000Z";
const COOKIE = `aslite_ui_session=${SECRET}`;
const JSON_HEADERS = {
  cookie: COOKIE,
  "content-type": "application/json",
  "x-requested-with": "superbee-ui",
};
const renderDocument = ({ body }: { body: string }) => ({ html: body, bounded: false });

type Capability = "none" | "bundle-read" | "bundle-propose";

interface Fixture {
  bundle: Bundle;
  server: UiServerHandle;
  html: Record<Capability, string>;
}

async function fixture(): Promise<Fixture> {
  const bundle: Bundle = { root: "mem://view-delivery", backend: new MemoryBackend() };
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
    body: "private target body",
  });

  const html = {
    none: "<!doctype html><h1>none</h1>",
    "bundle-read": "<!doctype html><h1>bundle-read</h1>",
    "bundle-propose": "<!doctype html><h1>bundle-propose</h1>",
  } satisfies Record<Capability, string>;
  for (const capability of Object.keys(html) as Capability[]) {
    await writeDoc(bundle, {
      id: `views-registry/${capability}`,
      frontmatter: {
        type: "View",
        title: capability,
        entry: `views/${capability}.html`,
        access: capability,
        timestamp: T,
      },
      body: "",
    });
    await writeBlob(
      bundle,
      `views/${capability}.html`,
      new TextEncoder().encode(html[capability]),
      "text/html; charset=utf-8",
    );
  }

  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument,
    actor: "delivery-test",
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
  return { bundle, server, html };
}

async function post(server: UiServerHandle, path: string, body: unknown) {
  const response = await fetch(`http://${server.host}:${server.port}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function mint(server: UiServerHandle, capability: Capability) {
  const response = await post(server, "/__page/mint", {
    registryId: `views-registry/${capability}`,
  });
  assert.equal(response.status, 200);
  assert.equal(typeof response.body.launchId, "string");
  assert.equal(typeof response.body.url, "string");
  return response.body as { launchId: string; url: string };
}

for (const capability of ["none", "bundle-read", "bundle-propose"] as const) {
  test(`delivery receipts are capability-neutral and repeatable for ${capability} without granting authority`, async () => {
    const f = await fixture();
    try {
      const launch = await mint(f.server, capability);
      const before = await post(f.server, "/__ui/views/delivered", {
        launchId: launch.launchId,
      });
      assert.equal(before.status, 200);
      assert.equal(before.body.delivered, false);

      const served = await fetch(`http://${f.server.host}:${f.server.port}${launch.url}`);
      const servedText = await served.text();
      assert.equal(served.status, 200);
      assert.equal(servedText, f.html[capability], "delivery tracking must preserve exact authored bytes");
      assert.doesNotMatch(servedText, new RegExp(launch.launchId), "the launch ID must not enter the View");

      for (let attempt = 0; attempt < 2; attempt++) {
        const receipt = await post(f.server, "/__ui/views/delivered", {
          launchId: launch.launchId,
        });
        assert.equal(receipt.status, 200);
        assert.equal(receipt.body.delivered, true, "a current receipt is idempotent");
      }

      if (capability === "bundle-propose") {
        const target = await readDocVersioned(f.bundle, "tasks/alpha");
        const denied = await post(f.server, "/__ui/actions/prepare", {
          launchId: launch.launchId,
          action: {
            kind: "document.set-field",
            docId: "tasks/alpha",
            field: "status",
            value: "done",
            expectedVersion: target.version,
          },
        });
        assert.equal(denied.status, 200);
        assert.equal(denied.body.status, "revoked", "a receipt must not approve a trusted action");
        const unchanged = await readDocVersioned(f.bundle, "tasks/alpha");
        assert.equal(unchanged.doc.frontmatter.status, "todo");
        assert.equal(unchanged.version, target.version);
      } else {
        const denied = await post(f.server, "/__ui/views/bridge", {
          launchId: launch.launchId,
          request: {
            bridge: "v0",
            type: "read",
            id: `denied-${capability}`,
            docId: "tasks/alpha",
          },
        });
        assert.equal(denied.status, 200);
        assert.equal(denied.body.reply.error.code, "FORBIDDEN", "a receipt must not grant bundle reads");
        assert.doesNotMatch(JSON.stringify(denied.body), /private target body/);
        const afterDenial = await post(f.server, "/__ui/views/delivered", {
          launchId: launch.launchId,
        });
        assert.equal(afterDenial.status, 200);
        assert.equal(afterDenial.body.delivered, true, "delivery lookup remains non-destructive");
      }
    } finally {
      await f.server.close();
    }
  });
}

test("delivery verification refuses unknown and stale launches, revoking only failed currentness", async () => {
  const f = await fixture();
  try {
    const unknown = await post(f.server, "/__ui/views/delivered", { launchId: "unknown-launch" });
    assert.equal(unknown.status, 403);

    const launch = await mint(f.server, "none");
    const served = await fetch(`http://${f.server.host}:${f.server.port}${launch.url}`);
    assert.equal(await served.text(), f.html.none);

    const malformed = await post(f.server, "/__ui/views/delivered", {
      launchId: launch.launchId,
      unexpected: true,
    });
    assert.equal(malformed.status, 400);
    const stillCurrent = await post(f.server, "/__ui/views/delivered", {
      launchId: launch.launchId,
    });
    assert.equal(stillCurrent.status, 200);
    assert.equal(stillCurrent.body.delivered, true, "a malformed probe must not revoke the launch");

    await writeBlob(
      f.bundle,
      "views/none.html",
      new TextEncoder().encode("<!doctype html><h1>changed</h1>"),
      "text/html; charset=utf-8",
    );
    const stale = await post(f.server, "/__ui/views/delivered", {
      launchId: launch.launchId,
    });
    assert.equal(stale.status, 403);

    await writeBlob(
      f.bundle,
      "views/none.html",
      new TextEncoder().encode(f.html.none),
      "text/html; charset=utf-8",
    );
    const revoked = await post(f.server, "/__ui/views/delivered", {
      launchId: launch.launchId,
    });
    assert.equal(revoked.status, 403, "restoring bytes must not resurrect the revoked launch");
  } finally {
    await f.server.close();
  }
});

test("delivery verification refuses an expired launch", async () => {
  const realNow = Date.now;
  let now = Date.parse(T);
  Date.now = () => now;
  const f = await fixture();
  try {
    const launch = await mint(f.server, "none");
    const served = await fetch(`http://${f.server.host}:${f.server.port}${launch.url}`);
    assert.equal(await served.text(), f.html.none);
    now += 60 * 60 * 1_000 + 1;
    const expired = await post(f.server, "/__ui/views/delivered", {
      launchId: launch.launchId,
    });
    assert.equal(expired.status, 403);
  } finally {
    Date.now = realNow;
    await f.server.close();
  }
});
