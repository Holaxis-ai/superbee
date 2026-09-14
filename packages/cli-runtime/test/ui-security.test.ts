/**
 * Unit tests for the `ui` command's trust-boundary primitives (plans/ui-v1.md rev 3.2): the
 * Host allowlist and the per-run token/cookie session check. Kept dependency-free (no server
 * boot) — `ui.test.ts` covers the end-to-end wiring over a real listener.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAuth,
  constantTimeEqual,
  hostnameOf,
  isAllowedHost,
  mintSessionSecret,
  readCookie,
  sessionCookieHeader,
} from "@superbee/ui-server";

test("hostnameOf strips a port from a plain host", () => {
  assert.equal(hostnameOf("127.0.0.1:4818"), "127.0.0.1");
  assert.equal(hostnameOf("localhost"), "localhost");
});

test("hostnameOf strips a port from a bracketed IPv6 literal", () => {
  assert.equal(hostnameOf("[::1]:4818"), "::1");
  assert.equal(hostnameOf("[::1]"), "::1");
});

test("isAllowedHost accepts exactly localhost / 127.0.0.1 / ::1, with or without a port", () => {
  assert.equal(isAllowedHost("127.0.0.1"), true);
  assert.equal(isAllowedHost("127.0.0.1:9999"), true);
  assert.equal(isAllowedHost("localhost:9999"), true);
  assert.equal(isAllowedHost("[::1]:9999"), true);
});

test("isAllowedHost rejects a DNS-rebinding-shaped host that merely CONTAINS an allowed literal (never a substring match)", () => {
  assert.equal(isAllowedHost("127.0.0.1.evil.example"), false);
  assert.equal(isAllowedHost("evil-localhost"), false);
  assert.equal(isAllowedHost("notlocalhost"), false);
});

test("isAllowedHost rejects an absent/empty Host header", () => {
  assert.equal(isAllowedHost(undefined), false);
  assert.equal(isAllowedHost(null), false);
  assert.equal(isAllowedHost(""), false);
});

test("readCookie finds a named cookie among several, ignoring whitespace", () => {
  assert.equal(readCookie("a=1; aslite_ui_session=tok123 ; b=2", "aslite_ui_session"), "tok123");
  assert.equal(readCookie("a=1", "aslite_ui_session"), undefined);
  assert.equal(readCookie(null, "aslite_ui_session"), undefined);
});

test("constantTimeEqual matches equal strings and rejects differing ones/lengths", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
});

test("sessionCookieHeader emits an HttpOnly, SameSite=Strict, root-path cookie", () => {
  const header = sessionCookieHeader("tok123");
  assert.match(header, /^aslite_ui_session=tok123;/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\//);
});

test("mintSessionSecret produces a fresh, sufficiently long secret each call", () => {
  const a = mintSessionSecret();
  const b = mintSessionSecret();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});

test("checkAuth: a matching ?token= grants access AND signals a cookie should be issued", () => {
  const secret = mintSessionSecret();
  const outcome = checkAuth(secret, secret, null);
  assert.deepEqual(outcome, { ok: true, grantsCookie: true });
});

test("checkAuth: a matching session cookie grants access WITHOUT re-issuing a cookie", () => {
  const secret = mintSessionSecret();
  const outcome = checkAuth(secret, null, `aslite_ui_session=${secret}`);
  assert.deepEqual(outcome, { ok: true, grantsCookie: false });
});

test("checkAuth: neither a valid token nor a valid cookie is rejected", () => {
  const secret = mintSessionSecret();
  assert.deepEqual(checkAuth(secret, null, null), { ok: false });
  assert.deepEqual(checkAuth(secret, "wrong", null), { ok: false });
  assert.deepEqual(checkAuth(secret, null, "aslite_ui_session=wrong"), { ok: false });
});

test("checkAuth: a token param wins even when an (invalid) cookie is also present", () => {
  const secret = mintSessionSecret();
  const outcome = checkAuth(secret, secret, "aslite_ui_session=garbage");
  assert.deepEqual(outcome, { ok: true, grantsCookie: true });
});
