// A stateful fake of the hosted access and retire routes (`/sync/v1/access-list`, `access-grant`,
// `access-revoke`, `bundle-retire-preview`, `bundle-retire`), for `superbee access` and
// `superbee bundle retire` tests. No request leaves the process: the fake is a `fetch`.
//
// No golden exchanges from the real gateway exist for these routes yet, so the fake follows the
// wire contract of superbee-hosted lane share-retire as written down for the CLI:
// - success `200 {"ok":true,"data"}`; a refusal decided before anything was written
//   `200 {"ok":false,"error":{"code","message","writeState":"not_applied"}}`;
// - write routes need `X-Superbee-Write-Request` (a v4 UUID, else `400 {"error":{"code":"invalid_input"}}`);
//   the same id with the same body replays the recorded answer, with another body is `request_conflict`;
// - `access-list` names everyone with access (sorted by principal id) only to an admin, `people: null` otherwise;
// - `access-grant`/`access-revoke`: admin only (`access_denied`), never above the admin's own level
//   (`level_above_own`), a member by email (any case) or principal id (`person_not_member`,
//   `person_ambiguous`); an unchanged level answers `before == level` with `changeId` and `at` null;
// - `bundle-retire-preview` and `bundle-retire` (`confirm` must equal the bare id: `confirm_mismatch`;
//   `already_retired`; `not_retirable`; `access_denied` when `allowed` is null);
// - a qualified `<slug>/<bundle-id>` reaches the bundle only under its workspace's slug;
// - `hook` may answer any request first (an injected `write_outcome_unknown`, say);
// - any other route: the family's unknown-route answer, `404 {"error":"not_found"}`.
import assert from "node:assert/strict";

import { HOST, PRINCIPAL, TOKEN } from "./fake-hosted-sync.js";

export const ACCESS_BUNDLE = "team.knowledge";
export const SLUG = "acme";
const WRITE_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Level = "none" | "read" | "write";

export interface Member {
  readonly principalId: string;
  readonly name: string | null;
  readonly email: string | null;
}

export interface AccessRequest {
  readonly route: string;
  readonly body: Record<string, unknown>;
  readonly writeRequest: string | null;
}

export interface RetireState {
  state: "pending" | "ready" | "disabled" | "retired" | null;
  allowed: "admin" | "owner" | null;
  retirable: boolean;
  pendingInvitations: number;
  statement: string;
}

export class FakeAccessHost {
  readonly requests: AccessRequest[] = [];
  /** The signed-in person's own standing on the bundle. */
  you: { level: Level; admin: boolean } = { level: "write", admin: true };
  readonly members = new Map<string, Member>();
  /** Principal id to level, for everyone with access other than the signed-in person. */
  readonly grants = new Map<string, Exclude<Level, "none">>();
  retire: RetireState = {
    state: "ready",
    allowed: "admin",
    retirable: true,
    pendingInvitations: 1,
    statement: "Retiring removes this bundle for everyone in the workspace. Its documents stay stored for 30 days.",
  };
  /** Answers a request before the fake does; undefined lets the fake answer. */
  hook?: (request: AccessRequest) => Response | undefined;
  private readonly recorded = new Map<string, { body: string; answer: unknown }>();
  private changes = 0;

  constructor() {
    for (const member of [
      { principalId: "person:ana", name: "Ana", email: "ana@example.com" },
      { principalId: "person:bo", name: "Bo", email: "bo@example.com" },
      { principalId: "person:twin-1", name: "Twin", email: "twin@example.com" },
      { principalId: "person:twin-2", name: "Twin Two", email: "TWIN@example.com" },
    ]) {
      this.members.set(member.principalId, member);
    }
    this.grants.set("person:bo", "read");
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(url.origin, HOST);
    assert.equal(init?.method, "POST");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const route = url.pathname.replace(/^\/sync\/v1\//, "");
    const request: AccessRequest = { route, body: structuredClone(body), writeRequest: headers.get("x-superbee-write-request") };
    this.requests.push(request);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    const hooked = this.hook?.(request);
    if (hooked) return hooked;
    if (route === "whoami") {
      return Response.json({ principalId: PRINCIPAL, credentialId: "cli", tenantIds: ["tenant-a"], workspaces: [{ tenantId: "tenant-a", slug: SLUG }], surface: "sync" });
    }
    const writes = route === "access-grant" || route === "access-revoke" || route === "bundle-retire";
    const reads = route === "access-list" || route === "bundle-retire-preview";
    if (!writes && !reads) return Response.json({ error: "not_found" }, { status: 404 });
    if (writes) {
      if (!request.writeRequest || !WRITE_REQUEST.test(request.writeRequest)) return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
      const key = `${route}\0${request.writeRequest}`;
      const seen = this.recorded.get(key);
      if (seen) return Response.json(seen.body === JSON.stringify(body) ? seen.answer : refused("request_conflict"));
      const answer = this.answer(route, body);
      this.recorded.set(key, { body: JSON.stringify(body), answer });
      return Response.json(answer);
    }
    return Response.json(this.answer(route, body));
  }) as typeof fetch;

  private bundleOf(body: Record<string, unknown>): boolean {
    const id = String(body.bundleId);
    return id === ACCESS_BUNDLE || id === `${SLUG}/${ACCESS_BUNDLE}`;
  }

  private answer(route: string, body: Record<string, unknown>): unknown {
    if (!this.bundleOf(body)) return refused("bundle_not_found");
    switch (route) {
      case "access-list":
        return {
          ok: true,
          data: {
            bundleId: ACCESS_BUNDLE,
            workspace: "tenant-a",
            you: { principalId: PRINCIPAL, level: this.you.level, admin: this.you.admin },
            people: this.you.admin
              ? [...this.grants]
                  .sort(([a], [b]) => (a < b ? -1 : 1))
                  .map(([principalId, level]) => ({ principalId, name: this.members.get(principalId)?.name ?? null, email: this.members.get(principalId)?.email ?? null, level }))
              : null,
          },
        };
      case "access-grant":
      case "access-revoke":
        return this.change(route === "access-grant" ? (body.level as Level) : "none", String(body.person));
      case "bundle-retire-preview":
        return {
          ok: true,
          data: {
            bundleId: ACCESS_BUNDLE,
            workspace: "tenant-a",
            name: "Team knowledge",
            state: this.retire.state,
            people: this.grants.size + 1,
            pendingInvitations: this.retire.pendingInvitations,
            allowed: this.retire.allowed,
            statement: this.retire.statement,
          },
        };
      case "bundle-retire": {
        if (this.retire.allowed === null) return refused("access_denied");
        if (!this.retire.retirable) return refused("not_retirable");
        if (this.retire.state === "retired") return refused("already_retired");
        if (body.confirm !== ACCESS_BUNDLE) return refused("confirm_mismatch");
        const revokedGrants = this.grants.size;
        const canceledInvitations = this.retire.pendingInvitations;
        this.grants.clear();
        this.retire.pendingInvitations = 0;
        this.retire.state = "retired";
        return { ok: true, data: { bundleId: ACCESS_BUNDLE, workspace: "tenant-a", retired: true, revokedGrants, canceledInvitations } };
      }
    }
    return refused("invalid_input");
  }

  private change(level: Level, person: string): unknown {
    if (!this.you.admin) return refused("access_denied");
    const found = person.startsWith("person:") ? [...this.members.values()].filter((m) => m.principalId === person) : [...this.members.values()].filter((m) => m.email?.toLowerCase() === person.toLowerCase());
    if (found.length === 0) return refused("person_not_member");
    if (found.length > 1) return refused("person_ambiguous");
    if (level === "write" && this.you.level !== "write") return refused("level_above_own");
    const member = found[0]!;
    const before: Level = this.grants.get(member.principalId) ?? "none";
    const changed = before !== level;
    if (level === "none") this.grants.delete(member.principalId);
    else this.grants.set(member.principalId, level);
    if (changed) this.changes += 1;
    return {
      ok: true,
      data: {
        bundleId: ACCESS_BUNDLE,
        workspace: "tenant-a",
        principalId: member.principalId,
        email: member.email,
        level,
        before,
        changeId: changed ? `change-${this.changes}` : null,
        at: changed ? "2026-10-02T12:00:00.000Z" : null,
      },
    };
  }
}

export function refused(code: string): unknown {
  return { ok: false, error: { code, message: `refused: ${code}`, writeState: "not_applied" } };
}
