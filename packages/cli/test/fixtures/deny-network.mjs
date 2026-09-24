// A `node --import` preload that records and refuses every network connection a process tries:
// `fetch`, `http(s).request`/`get`, `net.connect`/`createConnection`, `tls.connect`, and any
// `net.Socket#connect` below them. A Unix-socket or named-pipe connection (a `path`) is local and
// allowed. Each attempt appends one JSON line to $SUPERBEE_TEST_NETWORK_LOG, then throws, so a
// command that reaches for the network both fails loudly and leaves evidence.
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const log = process.env.SUPERBEE_TEST_NETWORK_LOG;

function refuse(api, target) {
  const line = JSON.stringify({ api, target: String(target), argv: process.argv.slice(2) });
  if (log) appendFileSync(log, `${line}\n`);
  throw new Error(`network access refused by deny-network preload: ${api} ${target}`);
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

globalThis.fetch = async (input) => refuse("fetch", input instanceof Request ? input.url : input);
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
  return refuse("net.Socket.connect", target);
};
for (const name of ["connect", "createConnection"]) {
  const original = net[name];
  net[name] = function (...args) {
    const target = describe(args);
    if (target === null || (typeof args[0] === "string" && !/^\d+$/.test(args[0]))) return original.apply(this, args);
    return refuse(`net.${name}`, target);
  };
}
tls.connect = (...args) => refuse("tls.connect", describe(args) ?? "unknown");
syncBuiltinESMExports();
