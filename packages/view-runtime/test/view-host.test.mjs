import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  VIEW_HOST_PROTOCOL,
  parseViewHostEvent,
  viewHostCsp,
  viewHostDeliver,
  viewHostDocument,
  viewHostLoad,
  encodeViewHtmlDataUrl,
  decorateViewExecution,
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
  assert.deepEqual(parseViewHostEvent({ protocol: VIEW_HOST_PROTOCOL, type: "failed", deliveryId: "d1", reason: "refused" }), {
    protocol: VIEW_HOST_PROTOCOL,
    type: "failed",
    deliveryId: "d1",
    reason: "refused",
  });
  for (const rejected of [
    { protocol: VIEW_HOST_PROTOCOL, type: "failed", deliveryId: "", reason: "x" },
    { protocol: VIEW_HOST_PROTOCOL, type: "failed", deliveryId: "d1" },
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

test("the host policy is opaque-origin, keeps every View directive, and frames only data children", () => {
  const csp = viewHostCsp(VIEW_POLICY);
  assert.match(csp, /^sandbox allow-scripts; /);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.ok(csp.includes("default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'"));
  // The blob child inherits this policy and its opaque ancestor can never match 'self', so
  // frame-ancestors would stop WebKit from rendering any View.
  assert.doesNotMatch(csp, /frame-ancestors/);
  assert.match(csp, /frame-src data:/);
  assert.match(csp, /child-src data:/);
  assert.doesNotMatch(csp, /blob:/);
});

test("the host document sandboxes its child, pins the child policy, and checks message sources", () => {
  const childPolicy = "default-src 'none'; connect-src 'none'";
  const html = viewHostDocument(childPolicy);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(JSON.stringify(childPolicy)));
  assert.match(html, /setAttribute\("sandbox", "allow-scripts"\)/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, /setAttribute\("csp", CHILD_POLICY\)/);
  assert.doesNotMatch(html, /createObjectURL|revokeObjectURL/);
  assert.match(html, /event\.source === view\.contentWindow/);
  assert.match(html, /event\.source !== parent \|\| event\.origin !== shellOrigin/);
  assert.match(html, /securitypolicyviolation/);
  assert.match(html, /type: "failed"/);
  assert.equal(html.split("</script>").length, 2, "exactly one inline script");
});

test("data encoding preserves exact byte ranges and bounds without independently padded chunks", () => {
  for (const size of [0, 1, 2, 3, 8191, 8192, 8193, 512 * 1024]) {
    const backing = Uint8Array.from({ length: size + 6 }, (_, i) => i % 256);
    const bytes = backing.subarray(3, size + 3);
    const url = encodeViewHtmlDataUrl(bytes, 512 * 1024);
    assert.ok(url.startsWith("data:text/html;charset=utf-8;base64,"));
    assert.deepEqual(Buffer.from(url.split(",")[1], "base64"), Buffer.from(bytes));
  }
  assert.throws(() => encodeViewHtmlDataUrl(new Uint8Array(512 * 1024 + 1), 512 * 1024), /byte limit/);
  assert.throws(() => encodeViewHtmlDataUrl(new Uint8Array(), -1), /byte limit/);
});

test("execution policy precedes source activity while preserving bytes and supported prologs", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const policy = decoder.decode(decorateViewExecution(new Uint8Array(), 0));
  for (const prefix of ["", " \n", "<!DOCTYPE html>", "\ufeff\n<!-- license café -->\n<!doctype html >", "<!-- first --><!-- second -->"]) {
    const source = prefix + '<script>window.sourceRan = true</script><p>é 🐝</p>';
    const decorated = decoder.decode(decorateViewExecution(encoder.encode(source), 512 * 1024));
    assert.equal(decorated.replace(policy, ""), source);
    assert.ok(decorated.indexOf(policy) < decorated.indexOf("<script>"));
    if (/<!doctype/i.test(prefix)) assert.ok(decorated.indexOf(policy) > decorated.toLowerCase().indexOf("<!doctype"));
  }
  for (const source of ["<!-->", "<!--->", "<!-- a --!><script>x</script>", "<!-- nested <!-- -->", "<!doctype html PUBLIC 'x'>", "<?xml version='1.0'?>"]) {
    assert.throws(() => decorateViewExecution(encoder.encode(source), 512 * 1024), /unsupported HTML prolog/);
  }
  assert.throws(() => decorateViewExecution(new Uint8Array([255]), 1), /encoded data|encoding|UTF-8/i);
  assert.throws(() => decorateViewExecution(new Uint8Array(513), 512), /byte limit/);
  const ceiling = encoder.encode("<!doctype html>" + " ".repeat(512 * 1024 - 15));
  const decorated = decorateViewExecution(ceiling, 512 * 1024);
  assert.equal(decorated.byteLength, ceiling.byteLength + encoder.encode(policy).byteLength);
  assert.doesNotThrow(() => encodeViewHtmlDataUrl(decorated, decorated.byteLength));
});

function generatedHost() {
  const handlers = new Map();
  const messages = [];
  let child;
  const parent = { postMessage: message => messages.push(message) };
  const context = {
    ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, btoa, URL,
    parent, location: { href: "http://127.0.0.1:1234/__ui/view-host" },
    setTimeout: callback => callback(),
    window: { addEventListener: (type, callback) => handlers.set(type, callback) },
    document: {
      addEventListener() {},
      createElement() {
        child = { setAttribute() {}, addEventListener: (type, callback) => { child[type] = callback; }, contentWindow: {} };
        return child;
      },
      body: { appendChild() {} },
    },
  };
  const html = viewHostDocument("default-src 'none'; worker-src 'none'");
  vm.runInNewContext(html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>")), context);
  return { messages, child: () => child, send(data, origin = "http://127.0.0.1:1234", source = parent) { handlers.get("message")({ data, origin, source }); } };
}

test("the actual generated host encodes once, checks sender and reports bounded preparation failure", () => {
  const host = generatedHost();
  const bytes = new TextEncoder().encode("<!doctype html><p>hello 🐝</p>").buffer;
  const command = viewHostLoad("d1", bytes, "text/html; charset=utf-8", "T");
  host.send(command, "http://other.invalid");
  host.send(command, "http://127.0.0.1:1234", {});
  assert.equal(host.child(), undefined);
  host.send(command);
  const child = host.child();
  assert.match(child.src, /^data:text\/html/);
  const execution = Buffer.from(child.src.split(",")[1], "base64").toString();
  assert.ok(execution.includes("hello 🐝"));
  assert.ok(execution.indexOf("Content-Security-Policy") < execution.indexOf("<p>"));
  host.send(viewHostLoad("d2", bytes, "text/html", "Other"));
  assert.equal(host.child(), child);
  child.load();
  assert.equal(host.messages.at(-1).type, "loaded");

  const invalid = generatedHost();
  invalid.send(viewHostLoad("bad", new Uint8Array(512 * 1024 + 1).buffer, "text/html", "T"));
  assert.equal(invalid.child(), undefined);
  assert.equal(invalid.messages.at(-1).type, "failed");
  assert.ok(invalid.messages.at(-1).reason.length < 200);
  invalid.send(command);
  assert.equal(invalid.child(), undefined, "a failed delivery is not retried in the same host");
});
