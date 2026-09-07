import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeService,
  PageBridgeLaunchAuthority,
  PageLaunchRegistry,
  parseBridgeRequest,
  mintTransientViewLaunch,
  pageLaunchAuthorizationSubject,
  SessionViewAuthorizationStore,
} from "../dist/index.js";
import {
  MemoryBackend,
  queryEdges,
  writeDoc,
} from "@superbee/core";

test("bridge parser admits only exact bounded requests", () => {
  assert.deepEqual(
    parseBridgeRequest({
      bridge: "v0",
      type: "query",
      id: "q1",
      params: { type: "Task", open: true, limit: 25 },
    }),
    {
      bridge: "v0",
      type: "query",
      id: "q1",
      params: { type: "Task", open: true, limit: 25 },
    },
  );
  assert.equal(
    parseBridgeRequest({
      bridge: "v0",
      type: "query",
      id: "q1",
      params: {},
      unexpected: true,
    }),
    null,
  );
  assert.equal(
    parseBridgeRequest({
      bridge: "v0",
      type: "query",
      id: "q1",
      params: { limit: 501 },
    }),
    null,
  );
  assert.equal(
    parseBridgeRequest({
      bridge: "v1",
      type: "read-versioned",
      id: "r1",
      docId: "../outside",
    })?.docId,
    "../outside",
    "concept-id safety remains the backend's single authority; the bridge only bounds transport",
  );
  assert.deepEqual(
    parseBridgeRequest({
      bridge: "v0",
      type: "render-document",
      id: "render-1",
      docId: "docs/one",
    }),
    {
      bridge: "v0",
      type: "render-document",
      id: "render-1",
      docId: "docs/one",
    },
  );
  assert.equal(
    parseBridgeRequest({
      bridge: "v0",
      type: "render-document",
      id: "render-1",
      docId: "docs/one",
      html: "<p>caller supplied</p>",
    }),
    null,
    "callers cannot inject presentation bytes into a document render",
  );
});

test("edge selectors preserve exact nonblank UTF-8 bytes and retain transport bounds", () => {
  const exactValues = [
    "reviews/ordinary",
    " reviews/leading",
    "reviews/trailing ",
    "reviews/internal space",
    'reviews/"quoted"',
    "--option-like",
    "reviews/café-🚀",
    "reviews/line\nbreak",
  ];
  for (const facet of ["from", "to"]) {
    for (const value of exactValues) {
      const parsed = parseBridgeRequest({
        bridge: "v0",
        type: "edges",
        id: `edge-${facet}`,
        params: { [facet]: value },
      });
      assert.equal(parsed?.params[facet], value, `${facet} ${JSON.stringify(value)}`);
    }
  }
  for (const text of exactValues) {
    const parsed = parseBridgeRequest({
      bridge: "v0",
      type: "edges",
      id: "edge-text",
      params: { text },
    });
    assert.equal(parsed?.params.text, text, JSON.stringify(text));
  }

  const raw1024 = `${"é".repeat(511)}x `;
  const raw1025 = `${"é".repeat(511)}xx `;
  assert.equal(Buffer.byteLength(raw1024, "utf8"), 1024);
  assert.equal(Buffer.byteLength(raw1025, "utf8"), 1025);
  for (const facet of ["from", "to", "text"]) {
    const accepted = parseBridgeRequest({
      bridge: "v0",
      type: "edges",
      id: `bound-${facet}`,
      params: { [facet]: raw1024 },
    });
    assert.equal(accepted?.params[facet], raw1024, `${facet} retains exactly 1,024 raw bytes`);
    assert.equal(
      parseBridgeRequest({
        bridge: "v0",
        type: "edges",
        id: `over-${facet}`,
        params: { [facet]: raw1025 },
      }),
      null,
      `${facet} rejects 1,025 raw bytes even when trimming would fit`,
    );
  }

  for (const facet of ["from", "to"]) {
    const one = [" reviews/one "];
    const duplicates32 = Array.from({ length: 32 }, () => " reviews/duplicate ");
    assert.deepEqual(
      parseBridgeRequest({ bridge: "v0", type: "edges", id: `one-${facet}`, params: { [facet]: one } })?.params[facet],
      one,
    );
    assert.deepEqual(
      parseBridgeRequest({ bridge: "v0", type: "edges", id: `thirty-two-${facet}`, params: { [facet]: duplicates32 } })?.params[facet],
      duplicates32,
      "transport cardinality is measured before semantic matching and preserves duplicates",
    );
    assert.equal(
      parseBridgeRequest({
        bridge: "v0",
        type: "edges",
        id: `thirty-three-${facet}`,
        params: { [facet]: [...duplicates32, " reviews/duplicate "] },
      }),
      null,
    );
  }

  const invalidParams = [
    { from: "" },
    { from: " \t\n" },
    { from: [] },
    { from: ["reviews/one", " "] },
    { from: ["reviews/one", 2] },
    { to: "" },
    { to: [] },
    { text: " \t\n" },
  ];
  for (const params of invalidParams) {
    assert.equal(
      parseBridgeRequest({ bridge: "v0", type: "edges", id: "invalid-edge", params }),
      null,
      JSON.stringify(params),
    );
  }
});

test("BridgeService edge queries agree with core for exact boundary ids and relation text", async () => {
  const bundle = { root: "mem://bridge-edge-identity", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: " reviews/leading",
    frontmatter: { type: "Review", timestamp: "2026-08-08T00:00:00.000Z" },
    body: "[leading](/targets/one.md)",
  });
  await writeDoc(bundle, {
    id: "reviews/trailing ",
    frontmatter: { type: "Review", timestamp: "2026-08-08T00:00:00.000Z" },
    body: "[trailing](/targets/one.md)",
  });
  await writeDoc(bundle, {
    id: "reviews/plain",
    frontmatter: { type: "Review", timestamp: "2026-08-08T00:00:00.000Z" },
    body: "[ exact relation ](/targets/one.md) and [other](/reviews/other.md)",
  });
  const bridge = new BridgeService({
    bundle,
    launches: {
      async resolve(launchId) {
        return launchId === "launch" ? { launchId, capability: "bundle-read" } : null;
      },
      revoke() {},
    },
    config: async () => ({ root: null, name: "Test", mode: "test" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    allowActionProtocol: false,
  });
  const filters = [
    { from: " reviews/leading" },
    { from: "reviews/trailing " },
    { to: "reviews/ " },
    { text: " exact relation " },
  ];
  for (const [index, params] of filters.entries()) {
    const direct = (await queryEdges(bundle, params)).map(({ from, to, text }) => ({ from, to, text }));
    const outcome = await bridge.handle("launch", {
      bridge: "v0",
      type: "edges",
      id: `edge-${index}`,
      params,
    });
    assert.deepEqual(outcome.reply?.result?.edges, direct, JSON.stringify(params));
    assert.equal(outcome.reply?.result?.count, direct.length, JSON.stringify(params));
  }
});

for (const row of [
  { version: "0.1", field: "status" },
  { version: "0.2", field: "superbee_progress_status" },
]) {
  test(`BridgeService query exposes logical progress_status over declared ${row.version} storage`, async () => {
    const bundle = { root: `mem://bridge-progress-${row.version}`, backend: new MemoryBackend() };
    if (row.version === "0.2") {
      await bundle.backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
    }
    await writeDoc(bundle, {
      id: "conventions/task",
      frontmatter: {
        type: "Convention",
        governs: "Task",
        fields: {
          required: ["title", row.field],
          optional: [],
          values: { [row.field]: ["todo", "done"] },
        },
      },
      body: "",
    });
    await writeDoc(bundle, {
      id: "tasks/one",
      frontmatter: { type: "Task", title: "One", [row.field]: "todo" },
      body: "",
    });
    const bridge = new BridgeService({
      bundle,
      launches: {
        async resolve(launchId) {
          return launchId === "launch" ? { launchId, capability: "bundle-propose" } : null;
        },
        revoke() {},
      },
      config: async () => ({ root: null, name: "Test", mode: "test" }),
      renderDocument: ({ body }) => ({ html: body, bounded: false }),
      allowActionProtocol: true,
    });
    const outcome = await bridge.handle("launch", {
      bridge: "v0",
      type: "query",
      id: "progress",
      params: { type: "Task", field: "progress_status=todo" },
    });
    assert.equal(outcome.reply?.result?.count, 1);
    const frontmatter = outcome.reply?.result?.rows?.[0]?.frontmatter;
    assert.equal(frontmatter?.progress_status, "todo");
    assert.equal(frontmatter?.[row.field], "todo", "raw coordinate remains visible");

    const untyped = await bridge.handle("launch", {
      bridge: "v0",
      type: "query",
      id: "progress-feed",
      params: { limit: 10 },
    });
    const task = untyped.reply?.result?.rows?.find((candidate) => candidate.id === "tasks/one");
    assert.equal(task?.frontmatter?.progress_status, "todo", "untyped View feeds receive the same projection");

    for (const type of ["read", "read-versioned"]) {
      const read = await bridge.handle("launch", {
        bridge: type === "read" ? "v0" : "v1",
        type,
        id: `progress-${type}`,
        docId: "tasks/one",
      });
      const doc = type === "read" ? read.reply?.result : read.reply?.result?.doc;
      assert.equal(doc?.frontmatter?.progress_status, "todo", `${type} receives the same logical projection`);
      assert.equal(doc?.frontmatter?.[row.field], "todo", `${type} preserves the raw coordinate`);
    }
  });
}

test("BridgeService never projects v0.2 lifecycle status as workflow progress", async () => {
  const bundle = { root: "mem://bridge-lifecycle-only", backend: new MemoryBackend() };
  await bundle.backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  await writeDoc(bundle, {
    id: "conventions/release",
    frontmatter: {
      type: "Convention",
      governs: "Release",
      fields: { required: ["title", "status"], optional: [], values: { status: ["draft", "stable", "deprecated"] } },
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "releases/one",
    frontmatter: { type: "Release", title: "One", status: "stable" },
    body: "",
  });
  const bridge = new BridgeService({
    bundle,
    launches: {
      async resolve() { return { launchId: "launch", capability: "bundle-read" }; },
      revoke() {},
    },
    config: async () => ({ root: null, name: "Test", mode: "test" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    allowActionProtocol: false,
  });
  const outcome = await bridge.handle("launch", {
    bridge: "v0",
    type: "query",
    id: "lifecycle",
    params: { type: "Release" },
  });
  const frontmatter = outcome.reply?.result?.rows?.[0]?.frontmatter;
  assert.equal(frontmatter?.status, "stable");
  assert.equal(Object.hasOwn(frontmatter ?? {}, "progress_status"), false);
  const read = await bridge.handle("launch", {
    bridge: "v0",
    type: "read",
    id: "lifecycle-read",
    docId: "releases/one",
  });
  assert.equal(read.reply?.result?.frontmatter?.status, "stable");
  assert.equal(Object.hasOwn(read.reply?.result?.frontmatter ?? {}, "progress_status"), false);
});

test("invalid v0 envelopes correlate only a bounded existing id and perform no launch work", async () => {
  let launchResolutions = 0;
  const bridge = new BridgeService({
    bundle: { root: "mem://invalid-envelope", backend: new MemoryBackend() },
    launches: {
      async resolve() {
        launchResolutions += 1;
        throw new Error("invalid requests must not resolve a launch");
      },
      revoke() {},
    },
    config: async () => {
      throw new Error("invalid requests must not load configuration");
    },
    renderDocument: () => {
      throw new Error("invalid requests must not render bundle data");
    },
    allowActionProtocol: false,
  });

  const id128 = "i".repeat(128);
  const correlated = [
    { bridge: "v0", type: "edges", id: "extra", params: {}, extra: true },
    { bridge: "v0", type: "unknown", id: "unknown" },
    { bridge: "v0", type: "edges", id: "thirty-three", params: { from: Array.from({ length: 33 }, (_, i) => `reviews/${i}`) } },
    { bridge: "v0", type: "edges", id: "selector-bytes", params: { to: `x${"y".repeat(1024)}` } },
    { bridge: "v0", type: "edges", id: id128, params: { from: [] } },
  ];
  for (const request of correlated) {
    const outcome = await bridge.handle("launch", request);
    assert.deepEqual(outcome.reply, {
      bridge: "v0",
      id: request.id,
      type: "error",
      error: { code: "USAGE", message: "invalid or unsupported bridge request" },
    });
  }

  const uncorrelated = [
    null,
    [],
    {},
    { bridge: "v0", type: 1, id: "not-string-type" },
    { bridge: "v0", type: "edges", params: {} },
    { bridge: "v0", type: "edges", id: 1, params: {} },
    { bridge: "v0", type: "edges", id: "i".repeat(129), params: {} },
    { bridge: "v1", type: "unknown", id: "v1-invalid" },
    { bridge: "v2", type: "edges", id: "wrong-protocol", params: {} },
  ];
  for (const request of uncorrelated) {
    const outcome = await bridge.handle("launch", request);
    assert.deepEqual(outcome.reply, {
      bridge: "v0",
      id: undefined,
      type: "error",
      error: { code: "USAGE", message: "invalid or unsupported bridge request" },
    });
  }
  assert.equal(launchResolutions, 0);
});

test("bridge runtime failures preserve classification without exposing storage diagnostics", async () => {
  const backend = new MemoryBackend();
  Object.defineProperty(backend, "read", {
    configurable: true,
    value: async () => {
      throw new Error("SECRET_BRIDGE_SENTINEL /private/bridge/path");
    },
  });
  const bridge = new BridgeService({
    bundle: { root: "mem://bridge-redaction", backend },
    launches: {
      async resolve(launchId) {
        return { launchId, capability: "bundle-read" };
      },
      revoke() {},
    },
    config: async () => ({ root: null, name: "Test", mode: "test" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    allowActionProtocol: false,
  });

  const outcome = await bridge.handle("launch", {
    bridge: "v0",
    type: "read",
    id: "redaction",
    docId: "docs/secret",
  });
  assert.equal(outcome.reply?.error?.code, "RUNTIME");
  assert.equal(outcome.reply?.error?.message, "the View request failed");
  assert.equal(JSON.stringify(outcome).includes("SECRET_BRIDGE_SENTINEL"), false);
  assert.equal(JSON.stringify(outcome).includes("/private/bridge/path"), false);
});

test("session authorization keys approval to the complete active-View subject", async () => {
  const store = new SessionViewAuthorizationStore();
  const subject = {
    sourceKind: "registered",
    registryId: "views-registry/a",
    contentVersion: "sha256:a",
    contentType: "text/html; charset=utf-8",
    capability: "bundle-read",
    execution: "active",
    policyVersion: "active-view-v1",
  };
  assert.equal(await store.isAuthorized(subject), false);
  await store.authorize(subject);
  assert.equal(await store.isAuthorized(subject), true);
  assert.equal(
    await store.isAuthorized({ ...subject, capability: "bundle-propose" }),
    false,
  );
});

test("transient active Views have exact-byte identity and process-local authorization", async () => {
  const bundle = { root: "mem://transient-view", backend: new MemoryBackend() };
  const launches = new PageLaunchRegistry();
  const authorizations = new SessionViewAuthorizationStore();
  const launch = mintTransientViewLaunch(bundle, launches, {
    title: "Transient proof",
    html: "<!doctype html><script>parent.postMessage({bridge:'v0',type:'hello',id:'h'}, '*')</script>",
  });
  assert.equal(launch.sourceKind, "transient");
  assert.equal(launch.bundleIdentity, bundle.root);
  assert.match(launch.contentVersion, /^sha256:/);
  assert.equal("registryId" in launch, false, "transient identity never fabricates a registry id");

  const authority = new PageBridgeLaunchAuthority(
    bundle,
    launches,
    new SessionViewAuthorizationStore(),
    authorizations,
  );
  assert.equal(await authority.resolve(launch.launchId, true), null);
  await authorizations.authorize(pageLaunchAuthorizationSubject(launch));
  assert.deepEqual(await authority.resolve(launch.launchId, true), {
    launchId: launch.launchId,
    capability: "bundle-read",
  });

  const differentBundle = {
    root: "mem://different-bundle",
    backend: new MemoryBackend(),
  };
  const wrongAuthority = new PageBridgeLaunchAuthority(
    differentBundle,
    launches,
    new SessionViewAuthorizationStore(),
    authorizations,
  );
  assert.equal(await wrongAuthority.resolve(launch.launchId, true), null);
});

test("bridge authority never reuses registered approval for a transient View by default", async () => {
  const bundle = { root: "mem://transient-default-auth", backend: new MemoryBackend() };
  const launches = new PageLaunchRegistry();
  const registeredAuthorizations = new SessionViewAuthorizationStore();
  const launch = mintTransientViewLaunch(bundle, launches, {
    title: "Transient isolation proof",
    html: "<!doctype html><p>Transient</p>",
  });
  await registeredAuthorizations.authorize(pageLaunchAuthorizationSubject(launch));

  const authority = new PageBridgeLaunchAuthority(
    bundle,
    launches,
    registeredAuthorizations,
  );
  assert.equal(
    await authority.resolve(launch.launchId, true),
    null,
    "omitting a transient store must create an isolated session store, not reuse registered approval",
  );
});

test("bridge polling retains a bounded change until acknowledgement and stays read-only when configured", async () => {
  const bundle = { root: "mem://bridge-poll", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "tasks/one",
    frontmatter: {
      type: "Task",
      title: "One",
      status: "todo",
      timestamp: "2026-07-26T12:00:00.000Z",
    },
    body: "",
  });
  let current = true;
  const launches = {
    async resolve(launchId, requireAuthorization) {
      return launchId === "launch" && current && requireAuthorization
        ? { launchId, capability: "bundle-read" }
        : null;
    },
    revoke() {
      current = false;
    },
  };
  const bridge = new BridgeService({
    bundle,
    launches,
    config: async () => ({ root: null, name: "Test", mode: "test" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    allowActionProtocol: false,
    enablePolling: true,
  });

  const rejectedActionRead = await bridge.handle("launch", {
    bridge: "v1",
    type: "read-versioned",
    id: "action",
    docId: "tasks/one",
  });
  assert.equal(rejectedActionRead.reply.error.code, "FORBIDDEN");

  const subscribed = await bridge.handle("launch", {
    bridge: "v0",
    type: "subscribe",
    id: "subscribe",
  });
  assert.equal(subscribed.subscribed, true);
  assert.deepEqual(await bridge.poll("launch"), { status: "unchanged" });

  await writeDoc(bundle, {
    id: "tasks/one",
    frontmatter: {
      type: "Task",
      title: "One",
      status: "done",
      timestamp: "2026-07-26T12:01:00.000Z",
    },
    body: "",
  });
  const changed = await bridge.poll("launch");
  assert.equal(changed.status, "change");
  assert.deepEqual(changed.message.event.changes.map((entry) => entry.id), ["tasks/one"]);
  assert.deepEqual(
    await bridge.poll("launch"),
    changed,
    "delivery failure cannot silently advance the server-owned baseline",
  );
  assert.deepEqual(
    await bridge.poll("launch", changed.generation),
    { status: "unchanged" },
  );
  assert.deepEqual(await bridge.poll("launch", changed.generation), {
    status: "reload-required",
    message: "the View poll acknowledgement did not match the pending generation",
  });
  assert.equal(current, false);
});

test("render-document reads one canonical version, bounds it, and revalidates the launch", async () => {
  const bundle = { root: "mem://bridge-render", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "docs/one",
    frontmatter: { type: "Doc", title: "One", timestamp: "2026-08-02T00:00:00.000Z" },
    body: "# One\n\nBody",
  });
  let current = true;
  let revokeDuringRender = false;
  const calls = [];
  const bridge = new BridgeService({
    bundle,
    launches: {
      async resolve(launchId) {
        return launchId === "launch" && current
          ? { launchId, capability: "bundle-read" }
          : null;
      },
      revoke() {
        current = false;
      },
    },
    config: async () => ({ root: null, name: "Test", mode: "test" }),
    renderDocument(document) {
      calls.push(document);
      if (revokeDuringRender) current = false;
      return { html: `<article>${document.body}</article>`, bounded: false };
    },
  });

  const rendered = await bridge.handle("launch", {
    bridge: "v0",
    type: "render-document",
    id: "render",
    docId: "docs/one",
  });
  assert.deepEqual(calls, [{ id: "docs/one", body: "# One\n\nBody" }]);
  assert.deepEqual(rendered.reply.result.document.id, "docs/one");
  assert.match(rendered.reply.result.document.version, /^sha256:/);
  assert.equal(rendered.reply.result.html, "<article># One\n\nBody</article>");
  assert.equal(rendered.reply.result.bounded, false);

  const missing = await bridge.handle("launch", {
    bridge: "v0",
    type: "render-document",
    id: "missing",
    docId: "docs/missing",
  });
  assert.equal(missing.reply.error.code, "NOT_FOUND");
  assert.doesNotMatch(JSON.stringify(missing.reply), /ENOENT|mem:\/\//);

  revokeDuringRender = true;
  const revoked = await bridge.handle("launch", {
    bridge: "v0",
    type: "render-document",
    id: "revoked",
    docId: "docs/one",
  });
  assert.equal(revoked.reply.error.code, "REVOKED");
  assert.doesNotMatch(JSON.stringify(revoked.reply), /<article>/);
});
