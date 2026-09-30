// A `node --import` preload that records and refuses every network connection a process tries:
// `fetch`, `http(s).request`/`get`, `net.connect`/`createConnection`, `tls.connect`, and any
// `net.Socket#connect` below them. A Unix-socket or named-pipe connection (a `path`) is local and
// allowed. Each attempt appends one JSON line to $SUPERBEE_TEST_NETWORK_LOG, then throws, so a
// command that reaches for the network both fails loudly and leaves evidence.
//
// Opt-in allowlist: $SUPERBEE_TEST_NETWORK_ALLOW names loopback endpoints (`127.0.0.1:<port>`,
// comma-separated) a test's own fake serves on. A `fetch` or a `net` connection to one of them goes
// through and is still logged, with `"allowed": true` (a `fetch` logs its URL, then the socket under
// it logs its endpoint), so a test can tell which steps touched the fake. `http(s).request`, `tls`
// and every other endpoint stay refused. Any entry that is not a loopback endpoint makes the preload
// fail at load. Unset, everything is refused, as before.
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const log = process.env.SUPERBEE_TEST_NETWORK_LOG;
const allowed = new Set(
  (process.env.SUPERBEE_TEST_NETWORK_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!/^127\.0\.0\.1:\d{1,5}$/.test(entry)) throw new Error(`deny-network preload: only loopback endpoints may be allowed, not '${entry}'`);
      return entry;
    }),
);

function record(api, target, allow) {
  const line = JSON.stringify({ api, target: String(target), argv: process.argv.slice(2), ...(allow ? { allowed: true } : {}) });
  if (log) appendFileSync(log, `${line}\n`);
}

function refuse(api, target) {
  record(api, target, false);
  throw new Error(`network access refused by deny-network preload: ${api} ${target}`);
}

/** The `127.0.0.1:<port>` a URL or connection target names, when the allowlist holds it. */
function allowedEndpoint(target) {
  if (allowed.size === 0 || target === null || target === undefined) return false;
  let endpoint = String(target);
  try {
    const url = new URL(endpoint);
    if (url.protocol === "http:" || url.protocol === "https:") endpoint = `${url.hostname}:${url.port}`;
  } catch {
    // Not a URL: a `host:port` connection target already.
  }
  return allowed.has(endpoint);
}

function describe(args) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return String(first);
  if (first && typeof first === "object") {
    if (typeof first.path === "string" && first.host === undefined && first.hostname === undefined && first.port === undefined) {
      return null;
    }
    return `${first.hostname ?? first.host ?? "localhost"}:${first.port ?? ""}`;
  }
  if (typeof first === "number") return `${args[1] ?? "localhost"}:${first}`;
  return "unknown";
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : input;
  if (allowedEndpoint(target)) {
    record("fetch", target, true);
    return originalFetch(input, init);
  }
  return refuse("fetch", target);
};
for (const [name, mod] of [["http", http], ["https", https]]) {
  mod.request = (...args) => refuse(`${name}.request`, describe(args) ?? "unix-socket");
  mod.get = (...args) => refuse(`${name}.get`, describe(args) ?? "unix-socket");
}
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const target = describe(normalized);
  if (target === null || (typeof normalized[0] === "string" && !/^\d+$/.test(normalized[0]))) {
    return socketConnect.apply(this, args);
  }
  if (allowedEndpoint(target)) {
    record("net.Socket.connect", target, true);
    return socketConnect.apply(this, args);
  }
  return refuse("net.Socket.connect", target);
};
for (const name of ["connect", "createConnection"]) {
  const original = net[name];
  net[name] = function (...args) {
    const target = describe(args);
    if (target === null || (typeof args[0] === "string" && !/^\d+$/.test(args[0]))) return original.apply(this, args);
    if (allowedEndpoint(target)) {
      record(`net.${name}`, target, true);
      return original.apply(this, args);
    }
    return refuse(`net.${name}`, target);
  };
}
tls.connect = (...args) => refuse("tls.connect", describe(args) ?? "unknown");
syncBuiltinESMExports();
