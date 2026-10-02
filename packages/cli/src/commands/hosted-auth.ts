// `superbee login`, `superbee whoami`, `superbee logout` — sign-in to hosted Superbee.
//
// Device-code sign-in is the default and is resumable: `login` returns AUTH_REQUIRED (exit 4)
// with one link for the agent to relay, and re-running it completes sign-in once the person has
// confirmed. `--wait` polls within a bound; `--loopback` runs PKCE with a bounded local redirect
// and falls back to the device flow. No command waits on a browser without a limit.
//
// `whoami` is local: it reports the stored session and the token's unverified claims. The gateway
// identity check arrives with the hosted transport, so no command here calls the hosted API.
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";
import { loopbackSignIn } from "../hosted-auth/loopback.js";
import {
  ACCESS_TOKEN_ENV,
  CLIENT_ID_ENV,
  HOST_ENV,
  assertOverrideFor,
  decodeJwtClaims,
  defaultResumeCommand,
  defaultHostedAuthDeps,
  ensureHostedAccessToken,
  hostArgument,
  logoutHosted,
  readPending,
  readSession,
  resolveHostSelection,
  waitForHostedSignIn,
  type AccessToken,
  type HostedAuthDeps,
  type SessionRecord,
} from "../hosted-auth/session.js";
import { CREDENTIAL_STORE_ENV } from "../hosted-auth/secret-store.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";

export const DEFAULT_WAIT_SECONDS = 120;
export const MAX_WAIT_SECONDS = 600;

export const LOGIN_USAGE = `superbee login — sign in to hosted Superbee

Usage:
  superbee login [--host <url>] [--client-id <id>] [--wait [--timeout <seconds>]] [--json]
  superbee login [--host <url>] --loopback [--port <n>] [--timeout <seconds>] [--json]

Device sign-in is the default and never blocks: without a session this returns AUTH_REQUIRED
(exit 4) with details.sign_in_url, the one link to relay to the person. Re-run the same command
after they confirm and it completes sign-in. --wait polls instead, for at most --timeout seconds
(default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). Already signed in (including with --loopback): refreshes if needed, reports the session, and starts no sign-in.

--loopback signs in through a browser redirect to 127.0.0.1 (PKCE), waits at most --timeout
seconds, then falls back to device sign-in. The link is printed on stderr.

The host is --host, then ${HOST_ENV}, then the host of the last sign-in. The issuer comes from the
host's protected-resource metadata. The CLI client id comes from --client-id, then
${CLIENT_ID_ENV}, then the host's metadata. The refresh token is kept in the OS credential store
(macOS Keychain, Linux Secret Service); ${CREDENTIAL_STORE_ENV}=file opts in to a 0600 file
instead. ${ACCESS_TOKEN_ENV} (for CI) is used as given by hosted commands and is never stored.

Options:
  --host <url>        Hosted Superbee URL (an origin, or an agent connection URL)
  --client-id <id>    CLI client id for this host (provisional until the host publishes it)
  --wait              Poll until the person confirms, within --timeout
  --timeout <seconds> Bound for --wait and --loopback (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS})
  --loopback          Browser redirect to 127.0.0.1 with PKCE instead of a device code
  --port <n>          Fixed loopback port (default: any free port)
  --json              Emit compact JSON instead of TOON
  -h, --help          Show this help
`;

export const WHOAMI_USAGE = `superbee whoami — show the hosted Superbee session

Usage:
  superbee whoami [--host <url>] [--json]

Local and read-only: reports the host, issuer, client, the signed-in subject from the token's
claims (not yet confirmed by the gateway), scopes, token expiry, where the refresh token is kept,
and any sign-in waiting on the person. Never prints a token. Not signed in is a successful result.

Options:
  --host <url>   Hosted Superbee URL (default: ${HOST_ENV}, then the last sign-in)
  --json         Emit compact JSON instead of TOON
  -h, --help     Show this help
`;

export const LOGOUT_USAGE = `superbee logout — sign out of hosted Superbee

Usage:
  superbee logout [--host <url>] [--json]

Revokes the refresh token at the issuer, then deletes it and the cached access token, and cancels
any pending sign-in. An access token already issued stays valid until it expires (reported as
access_token_valid_until) because the gateway does not introspect tokens. Idempotent: signed out
already is signed_out:false, exit 0.

Options:
  --host <url>   Hosted Superbee URL (default: ${HOST_ENV}, then the last sign-in)
  --json         Emit compact JSON instead of TOON
  -h, --help     Show this help
`;

export interface HostedAuthCommandDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  auth: HostedAuthDeps;
}

function commandDeps(deps: Partial<HostedAuthCommandDeps>): HostedAuthCommandDeps {
  return {
    stdout: deps.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: deps.stderr ?? ((text) => void process.stderr.write(text)),
    auth: deps.auth ?? defaultHostedAuthDeps(homedir()),
  };
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function sessionView(session: SessionRecord): Record<string, unknown> {
  return {
    issuer: session.issuer,
    client_id: session.client_id,
    subject: session.subject.sub ?? null,
    ...(session.subject.email ? { email: session.subject.email } : {}),
    ...(session.subject.name ? { name: session.subject.name } : {}),
    scope: session.scope ?? null,
    access_token_expires_at: iso(session.access_token_expires_at_ms),
    credential_store: session.credential_store,
    refresh_token: session.has_refresh_token ? "stored" : "none",
  };
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WAIT_SECONDS) {
    throw new CliError("USAGE", `--timeout must be a whole number of seconds from 1 to ${MAX_WAIT_SECONDS}`, {
      help: `${cliInvocation()} login --help`,
    });
  }
  return value;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new CliError("USAGE", "--port must be a TCP port from 1 to 65535", { help: `${cliInvocation()} login --help` });
  }
  return value;
}

/** The stderr line `login --wait` shows before it waits (stdout stays the structured record). */
function signInPrompt(target: HostedTarget, error: CliError): string {
  const details = error.details ?? {};
  return `To sign in to ${target.origin}, open ${String(details.sign_in_url)} and confirm the code ${String(details.user_code)} (expires ${String(details.expires_at)}). Waiting...\n`;
}

export async function login(argv: string[], partial: Partial<HostedAuthCommandDeps> = {}): Promise<void> {
  const deps = commandDeps(partial);
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          host: { type: "string" },
          "client-id": { type: "string" },
          wait: { type: "boolean" },
          timeout: { type: "string" },
          loopback: { type: "boolean" },
          port: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.login,
  );
  if (values.help) {
    deps.stdout(renderUsage(LOGIN_USAGE));
    return;
  }
  if (values.port !== undefined && !values.loopback) {
    throw new CliError("USAGE", "option '--port' requires '--loopback'", { help: `${cliInvocation()} login --help` });
  }
  if (values.wait && values.loopback) {
    throw new CliError("USAGE", "--wait and --loopback are mutually exclusive", { help: `${cliInvocation()} login --help` });
  }
  if (values.timeout !== undefined && !values.wait && !values.loopback) {
    throw new CliError("USAGE", "option '--timeout' requires '--wait' or '--loopback'", { help: `${cliInvocation()} login --help` });
  }
  const timeoutMs = parseTimeout(values.timeout) * 1000;
  const port = parsePort(values.port);
  const clientIdFlag = values["client-id"] || undefined;
  // Sign-in stores a session; the CI override stays an override for hosted commands only.
  const auth: HostedAuthDeps = { ...deps.auth, env: { ...deps.auth.env, [ACCESS_TOKEN_ENV]: undefined } };
  const target = await resolveHostSelection(values.host, auth);
  const signIn = { ...(clientIdFlag ? { clientIdFlag } : {}) };

  let token: AccessToken | undefined;
  if (values.loopback && (await readSession(auth.home, target))) {
    // An existing session is refreshed rather than replaced; only a dead one falls through.
    try {
      token = await ensureHostedAccessToken(target, signIn, auth);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "AUTH_REQUIRED") throw error;
    }
  }
  if (token) {
    // already signed in
  } else if (values.loopback) {
    const session = await loopbackSignIn(
      target,
      { ...signIn, timeoutMs, ...(port !== undefined ? { port } : {}), announce: (url) => deps.stderr(`Open this link to sign in to ${target.origin}:\n${url}\n`) },
      auth,
    );
    if (session) {
      token = { accessToken: session.access_token, source: "sign-in" };
    } else {
      // Bounded wait ran out: fall back to the resumable device flow (throws AUTH_REQUIRED).
      token = await ensureHostedAccessToken(target, signIn, auth);
    }
  } else if (values.wait) {
    token = await waitForHostedSignIn(
      target,
      { ...signIn, timeoutMs, announce: (error) => deps.stderr(signInPrompt(target, error)) },
      auth,
    );
  } else {
    token = await ensureHostedAccessToken(target, signIn, auth);
  }

  const session = await readSession(auth.home, target);
  deps.stdout(
    render(
      {
        status: token.source === "sign-in" ? "signed_in" : "already_signed_in",
        host: target.origin,
        audience: target.audience,
        ...(session ? sessionView(session) : {}),
        ...(deps.auth.env[ACCESS_TOKEN_ENV] ? { env_override: `${ACCESS_TOKEN_ENV} is set and takes precedence for hosted commands` } : {}),
        help: [`${cliInvocation()} whoami --host ${commandToken(hostArgument(target))}`],
      },
      resolveMode(values),
    ),
  );
}

export async function whoami(argv: string[], partial: Partial<HostedAuthCommandDeps> = {}): Promise<void> {
  const deps = commandDeps(partial);
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: { host: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
        allowPositionals: true,
      }),
    CLI_LEAVES.whoami,
  );
  if (values.help) {
    deps.stdout(renderUsage(WHOAMI_USAGE));
    return;
  }
  const auth = deps.auth;
  const mode = resolveMode(values);
  const override = auth.env[ACCESS_TOKEN_ENV];
  if (override) {
    const selected = values.host !== undefined ? await resolveHostSelection(values.host, auth) : await resolveHostOrNull(auth);
    let applies: boolean | undefined;
    if (selected) {
      try {
        assertOverrideFor(selected, override, auth);
        applies = true;
      } catch {
        applies = false;
      }
    }
    const where = selected ? { host: selected.origin, audience: selected.audience, applies_to_host: applies } : {};
    deps.stdout(render({ ...where, ...envOverrideView(override) }, mode));
    return;
  }
  const target = await resolveHostSelection(values.host, auth);
  const session = await readSession(auth.home, target);
  const pending = await readPending(auth.home, target);
  const now = auth.now();
  const pendingView =
    pending && pending.expires_at_ms > now
      ? {
          pending_sign_in: {
            sign_in_url: pending.verification_uri_complete ?? pending.verification_uri,
            user_code: pending.user_code,
            expires_at: iso(pending.expires_at_ms),
          },
        }
      : {};
  if (!session) {
    deps.stdout(
      render(
        {
          host: target.origin,
          audience: target.audience,
          signed_in: false,
          ...pendingView,
          help: [defaultResumeCommand(target)],
        },
        mode,
      ),
    );
    return;
  }
  deps.stdout(
    render(
      {
        host: target.origin,
        audience: target.audience,
        signed_in: true,
        source: "session",
        ...sessionView(session),
        access_token_expired: session.access_token_expires_at_ms <= now,
        claims: "unverified (read locally from the token; the gateway confirms identity on hosted commands)",
        ...pendingView,
        help: [`${cliInvocation()} logout --host ${commandToken(hostArgument(target))}`],
      },
      mode,
    ),
  );
}

async function resolveHostOrNull(auth: HostedAuthDeps): Promise<HostedTarget | null> {
  try {
    return await resolveHostSelection(undefined, auth);
  } catch {
    return null;
  }
}

function envOverrideView(token: string): Record<string, unknown> {
  const claims = decodeJwtClaims(token) ?? {};
  const aud = claims.aud;
  const exp = typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : null;
  return {
    signed_in: true,
    source: "env",
    env: ACCESS_TOKEN_ENV,
    subject: typeof claims.sub === "string" ? claims.sub : null,
    token_audience: typeof aud === "string" || Array.isArray(aud) ? aud : null,
    access_token_expires_at: exp,
    refresh_token: "none (used as given, never refreshed or stored)",
    claims: "unverified (read locally from the token)",
  };
}

export async function logout(argv: string[], partial: Partial<HostedAuthCommandDeps> = {}): Promise<void> {
  const deps = commandDeps(partial);
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: { host: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
        allowPositionals: true,
      }),
    CLI_LEAVES.logout,
  );
  if (values.help) {
    deps.stdout(renderUsage(LOGOUT_USAGE));
    return;
  }
  const target = await resolveHostSelection(values.host, deps.auth);
  const result = await logoutHosted(target, deps.auth);
  const notes: string[] = [];
  if (result.access_token_valid_until) {
    notes.push(`the already-issued access token stays valid until ${result.access_token_valid_until}; the gateway does not introspect tokens`);
  }
  if (result.revocation === "failed") notes.push("the issuer did not confirm revocation; the local copy was deleted anyway");
  if (result.revocation === "store_unavailable") {
    notes.push(`the OS credential store could not be reached, so the refresh token was neither revoked nor deleted; the local session was removed. Unlock the store and run logout again, or remove the 'superbee-cli' keychain item`);
  } else if (result.store_cleared === false) {
    notes.push(`the OS credential store could not delete the refresh token (it is ${result.revoked ? "already revoked at the issuer" : "not revoked"}); the local session was removed. Remove the 'superbee-cli' keychain item once the store is unlocked`);
  }
  if (deps.auth.env[ACCESS_TOKEN_ENV]) notes.push(`${ACCESS_TOKEN_ENV} is set; unset it to stop hosted commands using it`);
  deps.stdout(render({ ...result, ...(notes.length ? { notes } : {}) }, resolveMode(values)));
}
