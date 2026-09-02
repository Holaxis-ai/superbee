// Per-run session token minting + cookie plumbing for the loopback UI server (plans/ui-v1.md rev
// 3.2, "Session token — v1, not an upgrade path"): a bare loopback proxy widens the trust
// boundary past the 0600 credentials file on a multi-user host (any local user could otherwise
// drive the key through it), so a random per-run secret gates every request. The printed URL
// carries `?token=...`; the FIRST request exchanges it for an HttpOnly `SameSite=Strict` session
// cookie (closing the drive-by hole: `POST /docs:read-many` is a CORS "simple request", so a
// malicious same-machine page could otherwise fire blind key-injected reads through the proxy
// if the token alone — visible in a URL a page's JS can read via `location.search` — were the
// ongoing credential). The cookie value IS the token (one secret, two transport forms) —
// correct because both are equally trust-boundary-scoped to this one local run.
import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "aslite_ui_session";

/** Mint a fresh per-run secret. 32 random bytes, base64url — long enough that guessing is not a real attack surface for a local dev tool. */
export function mintSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The `Set-Cookie` header value that exchanges the URL token for a session cookie. */
export function sessionCookieHeader(secret: string, cookieName: string = SESSION_COOKIE_NAME): string {
  return `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Parse one named cookie out of a raw `Cookie` request header, or `undefined` if absent. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Constant-time string equality (both inputs are attacker-observable-length secrets; a short-circuiting `===` would leak a timing side-channel on the token/cookie compare). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type AuthOutcome =
  | { ok: false }
  /** Authenticated via the URL `?token=` param — the response must also exchange it for a cookie. */
  | { ok: true; grantsCookie: true }
  /** Authenticated via an already-established session cookie — nothing more to do. */
  | { ok: true; grantsCookie: false };

/** Check a request's token/cookie against the per-run `secret`. */
export function checkAuth(
  secret: string,
  tokenParam: string | null,
  cookieHeader: string | null | undefined,
  cookieName: string = SESSION_COOKIE_NAME,
): AuthOutcome {
  if (tokenParam && constantTimeEqual(tokenParam, secret)) return { ok: true, grantsCookie: true };
  const cookie = readCookie(cookieHeader, cookieName);
  if (cookie && constantTimeEqual(cookie, secret)) return { ok: true, grantsCookie: false };
  return { ok: false };
}
