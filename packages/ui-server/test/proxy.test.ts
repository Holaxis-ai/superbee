import assert from "node:assert/strict";
import test from "node:test";
import { proxyToRemote } from "../src/proxy.js";

test("proxy transport failures do not expose upstream exception details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("SECRET_PROXY_SENTINEL /private/proxy/path");
  };

  try {
    const response = await proxyToRemote(
      new Request("http://127.0.0.1/v0/bundles/default/docs"),
      "https://remote.example",
      undefined,
    );
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.match(text, /could not reach remote bundle server/);
    assert.doesNotMatch(text, /SECRET_PROXY_SENTINEL|private\/proxy\/path/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
