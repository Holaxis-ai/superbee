// Replay the hosted checkout exchanges for the installed CLI, including on its minimum Node version.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = "https://hosted.example";
const exchanges = new Map([
  ["/sync/v1/whoami", "whoami-200"],
  ["/sync/v1/bundles", "bundles-200"],
  ["/sync/v1/capabilities", "capabilities-200"],
  ["/sync/v1/snapshot", "snapshot-200"],
  ["/sync/v1/heads", "heads-200"],
  ["/sync/v1/export", "export-200-page-first"],
]);
const segment = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const token = [
  segment({ alg: "none", typ: "JWT" }),
  segment({ aud: origin + "/mcp", sub: "fixture" }),
  "sig",
].join(".");
process.env.SUPERBEE_ACCESS_TOKEN = token;

globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  const name =
    url.pathname === "/sync/v1/export" && JSON.parse(init.body).cursor
      ? "export-200-page-last"
      : exchanges.get(url.pathname);
  assert.equal(url.origin, origin);
  assert.ok(name, `unexpected checkout request ${url.pathname}`);
  assert.equal(
    new Headers(init.headers).get("authorization"),
    "Bearer " + token,
  );
  const fixture = new URL(
    `../../packages/core/test/fixtures/hosted-sync-v1/${name}.json`,
    import.meta.url,
  );
  const { request, response } = JSON.parse(await readFile(fixture, "utf8"));
  assert.equal(init.method, request.method);
  const body = response.bodyBase64
    ? Buffer.from(response.bodyBase64, "base64")
    : response.body;
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
};
