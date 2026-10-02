// A stored hosted sign-in session, written where sign-in leaves one: the `session.json` record in
// the target's session directory under the private state root. Tests seed it instead of signing in.
import path from "node:path";

import { resolveHostedTarget } from "../../src/hosted-auth/discovery.js";
import { sessionAccount, sessionDirFor } from "../../src/hosted-auth/session.js";
import { writeUserStateFileAtomic0600 } from "../../src/user-state.js";

export interface SeededSession {
  /** The host the session is for, as `--host` names it. */
  readonly host: string;
  readonly accessToken: string;
  /** When the access token expires; 0 is an expired session. */
  readonly expiresAtMs: number;
  /** The issuer the record names (never reached while the token is valid). */
  readonly issuer?: string;
}

/** Write the session record, and return its file. The refresh token is absent (`has_refresh_token: false`). */
export async function seedHostedSession(home: string, session: SeededSession): Promise<string> {
  const target = resolveHostedTarget(session.host);
  const dir = sessionDirFor(home, sessionAccount(target));
  const issuer = session.issuer ?? "https://issuer.example/";
  const record = {
    schema: 1, host: target.origin, audience: target.audience, issuer, client_id: "cli",
    token_endpoint: new URL("oauth/token", issuer).href, credential_store: "file", has_refresh_token: false,
    access_token: session.accessToken, access_token_expires_at_ms: session.expiresAtMs, subject: { sub: "auth0|person" }, signed_in_at_ms: 0,
  };
  await writeUserStateFileAtomic0600(home, dir, "session.json", `${JSON.stringify(record)}\n`);
  return path.join(dir, "session.json");
}
