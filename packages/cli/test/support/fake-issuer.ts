// A local fake of the hosted gateway's discovery surface plus an Auth0-like issuer: device code,
// authorization code with PKCE, rotating refresh tokens with reuse detection inside a leeway, and
// revocation. Real HTTP on 127.0.0.1 so child processes can share it.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeIssuerOptions {
  now?: () => number;
  accessTokenTtlSeconds?: number;
  deviceIntervalSeconds?: number;
  deviceExpiresInSeconds?: number;
  reuseLeewaySeconds?: number;
  /** Published as `superbee_cli_client_id` in the protected-resource metadata. */
  publishedClientId?: string | null;
}

interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  clientId: string;
  audience: string;
  state: "pending" | "approved" | "denied";
  expiresAt: number;
  polls: number;
}

interface RefreshEntry {
  family: string;
  clientId: string;
  audience: string;
  state: "current" | "rotated" | "revoked";
  rotatedAt?: number;
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.sig`;
}

export class FakeIssuer {
  readonly counts = { prm: 0, deviceCode: 0, devicePoll: 0, refresh: 0, authCode: 0, revoke: 0 };
  readonly devices = new Map<string, DeviceGrant>();
  readonly refreshTokens = new Map<string, RefreshEntry>();
  readonly revokedFamilies = new Set<string>();
  /** Process the next refresh (rotate) but drop the response. */
  dropNextRefreshResponse = false;
  /** Called during a refresh before answering (lets a test move the clock). */
  onRefresh: (() => void) | undefined;
  base = "";
  private server: Server;
  private readonly now: () => number;
  private readonly opts: Required<Omit<FakeIssuerOptions, "now" | "publishedClientId">> & { publishedClientId: string | null };
  private readonly codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; audience: string }>();

  constructor(options: FakeIssuerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.opts = {
      accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? 3600,
      deviceIntervalSeconds: options.deviceIntervalSeconds ?? 1,
      deviceExpiresInSeconds: options.deviceExpiresInSeconds ?? 600,
      reuseLeewaySeconds: options.reuseLeewaySeconds ?? 30,
      publishedClientId: options.publishedClientId === undefined ? "cli-client" : options.publishedClientId,
    };
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  get issuer(): string {
    return `${this.base}/issuer/`;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  approve(userCode?: string): void {
    for (const grant of this.devices.values()) if (!userCode || grant.userCode === userCode) grant.state = "approved";
  }

  deny(userCode?: string): void {
    for (const grant of this.devices.values()) if (!userCode || grant.userCode === userCode) grant.state = "denied";
  }

  /** Make every refresh token unusable, as an absolute lifetime expiry would. */
  expireAllRefreshTokens(): void {
    for (const entry of this.refreshTokens.values()) entry.state = "revoked";
  }

  familyOf(refreshToken: string): string | undefined {
    return this.refreshTokens.get(refreshToken)?.family;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async form(req: IncomingMessage): Promise<URLSearchParams> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return new URLSearchParams(raw);
  }

  private issue(res: ServerResponse, clientId: string, audience: string, family: string | undefined): void {
    const now = this.now();
    const refreshToken = `rt-${randomBytes(12).toString("hex")}`;
    const fam = family ?? `fam-${randomBytes(6).toString("hex")}`;
    this.refreshTokens.set(refreshToken, { family: fam, clientId, audience, state: "current" });
    const exp = Math.floor(now / 1000) + this.opts.accessTokenTtlSeconds;
    this.json(res, 200, {
      access_token: jwt({ sub: "auth0|mike", aud: audience, azp: clientId, exp, jti: randomBytes(6).toString("hex") }),
      id_token: jwt({ sub: "auth0|mike", email: "mike@example.com", name: "Mike" }),
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: this.opts.accessTokenTtlSeconds,
      scope: "openid offline_access bundles:discover documents:read documents:write",
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const path = url.pathname;
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource/")) {
      this.counts.prm += 1;
      const resourcePath = path.slice("/.well-known/oauth-protected-resource".length);
      this.json(res, 200, {
        resource: `${this.base}${resourcePath}`,
        authorization_servers: [this.issuer],
        scopes_supported: ["bundles:discover", "documents:read", "documents:write"],
        ...(this.opts.publishedClientId ? { superbee_cli_client_id: this.opts.publishedClientId } : {}),
      });
      return;
    }
    if (req.method === "GET" && path === "/issuer/.well-known/openid-configuration") {
      this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.base}/issuer/authorize`,
        token_endpoint: `${this.base}/issuer/oauth/token`,
        device_authorization_endpoint: `${this.base}/issuer/oauth/device/code`,
        revocation_endpoint: `${this.base}/issuer/oauth/revoke`,
      });
      return;
    }
    if (req.method === "GET" && path === "/issuer/authorize") {
      const p = url.searchParams;
      if (p.get("code_challenge_method") !== "S256") return this.json(res, 400, { error: "invalid_request" });
      const code = `code-${randomBytes(8).toString("hex")}`;
      this.codes.set(code, {
        challenge: p.get("code_challenge") ?? "",
        redirectUri: p.get("redirect_uri") ?? "",
        clientId: p.get("client_id") ?? "",
        audience: p.get("audience") ?? "",
      });
      const redirect = new URL(p.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", p.get("state") ?? "");
      res.writeHead(302, { location: redirect.toString() });
      res.end();
      return;
    }
    if (req.method === "POST" && path === "/issuer/oauth/device/code") {
      this.counts.deviceCode += 1;
      const f = await this.form(req);
      const deviceCode = `dc-${randomBytes(8).toString("hex")}`;
      const userCode = `UC${this.devices.size + 1}-${randomBytes(2).toString("hex")}`;
      this.devices.set(deviceCode, {
        deviceCode,
        userCode,
        clientId: f.get("client_id") ?? "",
        audience: f.get("audience") ?? "",
        state: "pending",
        expiresAt: this.now() + this.opts.deviceExpiresInSeconds * 1000,
        polls: 0,
      });
      this.json(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${this.base}/activate`,
        verification_uri_complete: `${this.base}/activate?user_code=${userCode}`,
        expires_in: this.opts.deviceExpiresInSeconds,
        interval: this.opts.deviceIntervalSeconds,
      });
      return;
    }
    if (req.method === "POST" && path === "/issuer/oauth/revoke") {
      this.counts.revoke += 1;
      const f = await this.form(req);
      const entry = this.refreshTokens.get(f.get("token") ?? "");
      if (entry) {
        this.revokedFamilies.add(entry.family);
        for (const e of this.refreshTokens.values()) if (e.family === entry.family) e.state = "revoked";
      }
      res.writeHead(200).end();
      return;
    }
    if (req.method === "POST" && path === "/issuer/oauth/token") {
      const f = await this.form(req);
      const grant = f.get("grant_type");
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        this.counts.devicePoll += 1;
        const device = this.devices.get(f.get("device_code") ?? "");
        if (!device) return this.json(res, 400, { error: "invalid_grant" });
        device.polls += 1;
        if (device.expiresAt <= this.now()) return this.json(res, 400, { error: "expired_token" });
        if (device.state === "denied") return this.json(res, 403, { error: "access_denied" });
        if (device.state === "pending") return this.json(res, 400, { error: "authorization_pending" });
        this.devices.delete(device.deviceCode);
        return this.issue(res, device.clientId, device.audience, undefined);
      }
      if (grant === "authorization_code") {
        this.counts.authCode += 1;
        const code = this.codes.get(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        if (!code || code.redirectUri !== f.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== code.challenge) {
          return this.json(res, 400, { error: "invalid_grant" });
        }
        this.codes.delete(f.get("code") ?? "");
        return this.issue(res, code.clientId, code.audience, undefined);
      }
      if (grant === "refresh_token") {
        this.counts.refresh += 1;
        this.onRefresh?.();
        const presented = f.get("refresh_token") ?? "";
        const entry = this.refreshTokens.get(presented);
        if (!entry || entry.state === "revoked" || this.revokedFamilies.has(entry.family)) {
          return this.json(res, 403, { error: "invalid_grant" });
        }
        if (entry.state === "rotated") {
          const withinLeeway = entry.rotatedAt !== undefined && this.now() - entry.rotatedAt < this.opts.reuseLeewaySeconds * 1000;
          if (!withinLeeway) {
            this.revokedFamilies.add(entry.family);
            for (const e of this.refreshTokens.values()) if (e.family === entry.family) e.state = "revoked";
            return this.json(res, 403, { error: "invalid_grant", error_description: "reuse detected" });
          }
        }
        for (const e of this.refreshTokens.values()) {
          if (e.family === entry.family && e.state === "current") {
            e.state = "rotated";
            e.rotatedAt = this.now();
          }
        }
        entry.state = "rotated";
        entry.rotatedAt ??= this.now();
        if (this.dropNextRefreshResponse) {
          this.dropNextRefreshResponse = false;
          // Rotate server-side, then lose the answer.
          const refreshToken = `rt-${randomBytes(12).toString("hex")}`;
          this.refreshTokens.set(refreshToken, { family: entry.family, clientId: entry.clientId, audience: entry.audience, state: "current" });
          req.socket.destroy();
          return;
        }
        return this.issue(res, entry.clientId, entry.audience, entry.family);
      }
      return this.json(res, 400, { error: "unsupported_grant_type" });
    }
    res.writeHead(404).end();
  }
}
