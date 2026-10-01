import assert from "node:assert/strict";
import test from "node:test";

import {
  VIEW_HOST_PROTOCOL,
  parseViewHostEvent,
  viewHostCsp,
  viewHostDeliver,
  viewHostDocument,
  viewHostLoad,
} from "../dist/view-host.js";

const VIEW_POLICY = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'";

test("parseViewHostEvent accepts only the three enveloped host events", () => {
  assert.deepEqual(parseViewHostEvent({ protocol: VIEW_HOST_PROTOCOL, type: "ready" }), {
    protocol: VIEW_HOST_PROTOCOL,
    type: "ready",
  });
  assert.deepEqual(parseViewHostEvent({ protocol: VIEW_HOST_PROTOCOL, type: "loaded", deliveryId: "d1" }), {
    protocol: VIEW_HOST_PROTOCOL,
    type: "loaded",
    deliveryId: "d1",
  });
  const message = { bridge: "v0", id: "q", type: "query" };
  assert.deepEqual(parseViewHostEvent({ protocol: VIEW_HOST_PROTOCOL, type: "view-message", message }), {
    protocol: VIEW_HOST_PROTOCOL,
    type: "view-message",
    message,
  });
  for (const rejected of [
    null,
    "ready",
    [],
    message,
    { protocol: "other", type: "ready" },
    { protocol: VIEW_HOST_PROTOCOL, type: "loaded" },
    { protocol: VIEW_HOST_PROTOCOL, type: "loaded", deliveryId: "" },
    { protocol: VIEW_HOST_PROTOCOL, type: "view-message" },
    { protocol: VIEW_HOST_PROTOCOL, type: "load" },
    { protocol: VIEW_HOST_PROTOCOL, type: "deliver", message },
  ]) {
    assert.equal(parseViewHostEvent(rejected), null, JSON.stringify(rejected));
  }
});

test("shell commands are enveloped and carry no launch identity", () => {
  const bytes = new TextEncoder().encode("<p>x</p>").buffer;
  assert.deepEqual(viewHostLoad("d1", bytes, "text/html", "T"), {
    protocol: VIEW_HOST_PROTOCOL,
    type: "load",
    deliveryId: "d1",
    bytes,
    contentType: "text/html",
    title: "T",
  });
  assert.deepEqual(viewHostDeliver({ a: 1 }), { protocol: VIEW_HOST_PROTOCOL, type: "deliver", message: { a: 1 } });
});

test("the host policy is opaque-origin, keeps every View directive, and frames only blob children", () => {
  const csp = viewHostCsp(VIEW_POLICY);
  assert.match(csp, /^sandbox allow-scripts; /);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.ok(csp.includes(VIEW_POLICY));
  assert.match(csp, /frame-src blob:/);
  assert.match(csp, /child-src blob:/);
});

test("the host document sandboxes its child, pins the child policy, revokes the blob, and checks message sources", () => {
  const childPolicy = "default-src 'none'; connect-src 'none'";
  const html = viewHostDocument(childPolicy);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(JSON.stringify(childPolicy)));
  assert.match(html, /setAttribute\("sandbox", "allow-scripts"\)/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, /setAttribute\("csp", CHILD_POLICY\)/);
  assert.match(html, /URL\.revokeObjectURL\(url\)/);
  assert.match(html, /event\.source === view\.contentWindow/);
  assert.match(html, /event\.source !== parent \|\| event\.origin !== shellOrigin/);
  assert.equal(html.split("</script>").length, 2, "exactly one inline script");
});
