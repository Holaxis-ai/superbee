import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RecoveryGuard,
  extractClaimId,
  extractViewPayload,
  firstResultText,
} from "../src/result-recovery.js";

const durablePayload = {
  schemaVersion: "agentstate.durable-view-launch.v1",
  title: "Board",
  source: {
    viewId: "pages-registry/board",
    entry: "pages/board.html",
    html: "<!doctype html>",
    contentType: "text/html",
    contentVersion: "v1",
  },
  launch: { launchId: "launch-2", access: "bundle-read", authorization: { required: true, authorized: true } },
};

const transientPayload = {
  schemaVersion: "agentstate.transient-view-launch.v1",
  title: "Transient",
  source: {
    kind: "transient",
    html: "<!doctype html>",
    contentType: "text/html; charset=utf-8",
    contentVersion: "sha256:transient",
  },
  launch: { launchId: "launch-3", access: "bundle-propose", authorization: { required: true, authorized: false } },
};

test("extractViewPayload finds registered and transient active View schemas", () => {
  assert.equal(extractViewPayload({ structuredContent: durablePayload }), durablePayload);
  assert.equal(
    extractViewPayload({ structuredContent: { view: durablePayload } }),
    durablePayload,
  );
  assert.equal(extractViewPayload({ structuredContent: transientPayload }), transientPayload);
  assert.equal(
    extractViewPayload({ structuredContent: { view: transientPayload } }),
    transientPayload,
  );
});

test("extractViewPayload yields nothing for junk, absent structuredContent, or partial payloads", () => {
  assert.equal(extractViewPayload(undefined), null);
  assert.equal(extractViewPayload({ content: [] }), null);
  assert.equal(extractViewPayload({ structuredContent: { schemaVersion: "other" } }), null);
  const { source, ...durableWithoutSource } = durablePayload;
  assert.equal(extractViewPayload({ structuredContent: durableWithoutSource }), null);
});

test("error results NEVER yield a payload — recovery must not fire for them", () => {
  assert.equal(
    extractViewPayload({ isError: true, structuredContent: durablePayload }),
    null,
  );
});

test("firstResultText surfaces the server's prose, skipping non-text parts", () => {
  assert.equal(
    firstResultText({
      content: [{ type: "image" }, { type: "text", text: "" }, { type: "text", text: "why" }],
    }),
    "why",
  );
  assert.equal(firstResultText({ content: [] }), null);
  assert.equal(firstResultText(null), null);
});

test("RecoveryGuard enforces a hard per-instance attempt cap", () => {
  const guard = new RecoveryGuard(2);
  assert.equal(guard.tryAcquire(), true);
  assert.equal(guard.tryAcquire(), true);
  assert.equal(guard.tryAcquire(), false);
  assert.equal(guard.tryAcquire(), false, "the cap never re-arms");
});

test("extractClaimId finds the marker in any text part and rejects malformed markers", () => {
  assert.equal(
    extractClaimId({
      content: [
        { type: "text", text: "Prepared View..." },
        { type: "text", text: "summary\n[agentstate-claim:v1:AbC123_-xyz789aa]" },
      ],
    }),
    "AbC123_-xyz789aa",
  );
  assert.equal(extractClaimId({ content: [{ type: "text", text: "[agentstate-claim:v1:short]" }] }), null);
  assert.equal(extractClaimId({ content: [{ type: "text", text: "no marker here" }] }), null);
  assert.equal(extractClaimId({ content: [] }), null);
  assert.equal(extractClaimId(null), null);
});

test("extractClaimId selects only the final standalone server marker", () => {
  assert.equal(
    extractClaimId({
      content: [
        {
          type: "text",
          text:
            'Displayed "title [agentstate-claim:v1:attacker1]".\n' +
            "[agentstate-claim:v1:server_claim_123]",
        },
      ],
    }),
    "server_claim_123",
  );
  assert.equal(
    extractClaimId({
      content: [
        { type: "text", text: "[agentstate-claim:v1:earlier_claim]" },
        { type: "text", text: "receipt\n[agentstate-claim:v1:final_claim_123]" },
      ],
    }),
    "final_claim_123",
  );
  assert.equal(
    extractClaimId({
      content: [
        { type: "text", text: "title [agentstate-claim:v1:embedded_claim] suffix" },
      ],
    }),
    null,
  );
});
