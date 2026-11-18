// The View frame's response headers.
import assert from "node:assert/strict";
import test from "node:test";
import { viewFrameHeaders, viewFramePolicy } from "../dist/view-frame.js";

const ORIGIN = "https://app.example";

test("a View frame is served sandboxed, with no network channel, framed only by its page", () => {
  assert.equal(
    viewFramePolicy(ORIGIN),
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors https://app.example",
  );
  assert.deepEqual(viewFrameHeaders(ORIGIN), {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": viewFramePolicy(ORIGIN),
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  });
  for (const origin of ["https://app.example/", "https://app.example/path", "ftp://app.example", "not a url"])
    assert.throws(() => viewFramePolicy(origin), origin);
});
