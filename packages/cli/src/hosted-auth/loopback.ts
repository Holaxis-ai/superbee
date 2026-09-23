// Optional PKCE sign-in with a loopback redirect (`login --loopback`).
//
// Bounded: the listener on 127.0.0.1 waits at most `timeoutMs`, then the caller falls back to the
// resumable device flow. The authorization URL goes to stderr (stdout stays the structured record),
// and the listener accepts exactly one callback whose `state` matches. There is no `nonce` or
// RFC 9207 `iss` check: the id_token is used only for display (labeled unverified) and each
// session has exactly one issuer, fixed by the host's metadata.
//
// The code exchange and the token write run under the session lock, so a concurrent refresh of
// a previous session cannot interleave with this sign-in and leave the store and the cache from
// different token families.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { CliError } from "../errors.js";
import { REQUESTED_SCOPE, type HostedTarget } from "./discovery.js";
import {
  clearPendingSignIn,
  persistTokens,
  prepareSignIn,
  tokenRequest,
  withSessionLock,
  type HostedAuthDeps,
  type SessionRecord,
  type SignInOptions,
} from "./session.js";

export interface LoopbackOptions extends SignInOptions {
  readonly timeoutMs: number;
  /** A fixed registered port, when the issuer does not accept an ephemeral one. 0 = ephemeral. */
  readonly port?: number;
  /** Shown to the person: the URL to open. Defaults to a stderr line. */
  readonly announce?: (authorizeUrl: string) => void;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const CALLBACK_PATH = "/callback";

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

type CallbackResult = { code: string } | { error: string } | { timedOut: true };

/** Run the loopback sign-in. Returns the session, or null when the bound ran out. */
export async function loopbackSignIn(target: HostedTarget, options: LoopbackOptions, deps: HostedAuthDeps): Promise<SessionRecord | null> {
  const { discovery, clientId, store } = await prepareSignIn(target, options, deps);
  if (!discovery.authorizationEndpoint) {
    throw new CliError("RUNTIME", `the issuer for ${target.origin} has no authorization endpoint`);
  }
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");

  let deliver: (result: CallbackResult) => void = () => {};
  const outcome = new Promise<CallbackResult>((resolve) => (deliver = resolve));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH || url.searchParams.get("state") !== state) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(code ? "Superbee sign-in complete. You can close this tab.\n" : "Superbee sign-in was not completed. You can close this tab.\n");
    deliver(code ? { code } : { error: error ?? "missing_code" });
  });

  let port: number;
  try {
    port = await listen(server, options.port ?? 0);
  } catch {
    throw new CliError("USAGE", `cannot listen on 127.0.0.1:${options.port ?? 0} for the sign-in callback`);
  }
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const authorize = new URL(discovery.authorizationEndpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: REQUESTED_SCOPE,
    audience: target.audience,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const timer = setTimeout(() => deliver({ timedOut: true }), options.timeoutMs);
  try {
    (options.announce ?? ((u) => void process.stderr.write(`Open this link to sign in to ${target.origin}:\n${u}\n`)))(authorize.toString());
    const result = await outcome;
    if ("timedOut" in result) return null;
    if ("error" in result) {
      throw new CliError("AUTH_REQUIRED", `sign-in to ${target.origin} was not completed (${result.error})`, {
        details: { host: target.origin, reason: result.error },
      });
    }
    const code = result.code;
    return await withSessionLock(target, deps, async () => {
      const exchanged = await tokenRequest(deps, discovery.tokenEndpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
    });
    if (exchanged.kind !== "tokens") {
      const why = exchanged.kind === "oauth_error" ? exchanged.error : exchanged.reason;
      throw new CliError(exchanged.kind === "lost" ? "TRANSIENT" : "RUNTIME", `could not complete sign-in to ${target.origin} (${why})`, {
        details: { host: target.origin, reason: why, ...(exchanged.kind === "lost" ? { retryable: true } : {}) },
      });
    }
    const session = await persistTokens(
      target,
      {
        issuer: discovery.issuer,
        client_id: clientId,
        token_endpoint: discovery.tokenEndpoint,
        ...(discovery.revocationEndpoint ? { revocation_endpoint: discovery.revocationEndpoint } : {}),
      },
      exchanged.tokens,
      store,
      deps,
    );
    await clearPendingSignIn(target, deps);
    return session;
    });
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
