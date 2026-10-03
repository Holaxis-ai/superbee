// `superbee access list|grant|revoke` and `superbee bundle retire` against the fake access routes
// (`support/fake-hosted-access.ts`, which follows the share-retire wire contract). No request
// leaves the process: the fake is a `fetch`, and the person at the terminal is a fake too.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { access } from "../src/commands/access.js";
import { bundleCommand } from "../src/commands/bundle.js";
import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { userStateDir } from "../src/user-state.js";
import { ACCESS_BUNDLE, FakeAccessHost, refused, SLUG } from "./support/fake-hosted-access.js";
import { HOST, TOKEN } from "./support/fake-hosted-sync.js";
import { noTerminal, personAtTerminal, type FakeTerminal } from "./support/fake-terminal.js";

interface Harness {
  home: string;
  auth: HostedAuthDeps;
  host: FakeAccessHost;
  out: string[];
  now: number;
}

async function harness(): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), "sb-access-home-"));
  const h: Harness = { home, auth: undefined as unknown as HostedAuthDeps, host: new FakeAccessHost(), out: [], now: Date.parse("2026-10-02T12:00:00Z") };
  h.auth = {
    ...defaultHostedAuthDeps(home, {
      env: { SUPERBEE_ACCESS_TOKEN: TOKEN },
      fetch: async () => {
        throw new Error("the sign-in module must not be reached");
      },
    }),
    now: () => h.now,
  };
  return h;
}

async function runAccess(h: Harness, argv: string[]): Promise<Record<string, unknown>> {
  h.out.length = 0;
  await access(argv, { stdout: (text) => void h.out.push(text), auth: h.auth, fetch: h.host.fetch });
  return decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
}

async function runRetire(h: Harness, argv: string[], terminal: FakeTerminal): Promise<Record<string, unknown>> {
  h.out.length = 0;
  await bundleCommand(["retire", ...argv], { stdout: (text) => void h.out.push(text), retire: { auth: h.auth, fetch: h.host.fetch, terminal } });
  return decode(h.out.at(-1)!.trim()) as Record<string, unknown>;
}

async function rejects(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail("expected a CliError");
}

/** The requests to the access and retire routes (sign-in's whoami left out). */
const routed = (h: Harness) => h.host.requests.filter((request) => request.route !== "whoami");

// ── access list ──────────────────────────────────────────────────────────────────────────────

test("access list: an admin sees everyone with access, and the grant command", async () => {
  const h = await harness();
  h.host.grants.set("person:ana", "write");
  const receipt = await runAccess(h, ["list", ACCESS_BUNDLE, "--host", HOST]);
  assert.deepEqual(routed(h).map((r) => [r.route, r.body, r.writeRequest]), [["access-list", { bundleId: ACCESS_BUNDLE }, null]]);
  assert.deepEqual(receipt.you, { principal_id: "principal-7", level: "write", admin: true });
  const people = receipt.people as { count: number; complete: boolean; rows: Record<string, unknown>[] };
  assert.equal(people.count, 2);
  assert.equal(people.complete, true);
  assert.deepEqual(people.rows, [
    { principal_id: "person:ana", name: "Ana", email: "ana@example.com", level: "write" },
    { principal_id: "person:bo", name: "Bo", email: "bo@example.com", level: "read" },
  ]);
  assert.match(String((receipt.help as string[])[0]), /access grant team\.knowledge <email> --level read --host /);
});

test("access list: a person who is not an admin sees their own level, and no one else", async () => {
  const h = await harness();
  h.host.you = { level: "read", admin: false };
  const receipt = await runAccess(h, ["list", ACCESS_BUNDLE, "--host", HOST]);
  assert.equal(receipt.people, null);
  assert.deepEqual(receipt.you, { principal_id: "principal-7", level: "read", admin: false });
  assert.match(String(receipt.note), /only a workspace admin/);
  assert.deepEqual(receipt.help, []);
});

test("access list: a list the host cut short says so", async () => {
  const h = await harness();
  h.host.hook = (request) =>
    request.route === "access-list"
      ? Response.json({ ok: true, data: { bundleId: ACCESS_BUNDLE, workspace: "tenant-a", you: { principalId: "principal-7", level: "write", admin: true }, people: [{ principalId: "person:ana", name: null, email: null, level: "read" }], complete: false } })
      : undefined;
  const receipt = await runAccess(h, ["list", ACCESS_BUNDLE, "--host", HOST]);
  assert.equal((receipt.people as { complete: boolean }).complete, false);
  assert.match(String(receipt.note), /first 1 people/);
});

test("access list: a qualified reference names the bundle in that workspace", async () => {
  const h = await harness();
  await runAccess(h, ["list", `${SLUG}/${ACCESS_BUNDLE}`, "--host", HOST]);
  assert.deepEqual(routed(h)[0]!.body, { bundleId: `${SLUG}/${ACCESS_BUNDLE}` });
  const other = await rejects(runAccess(h, ["list", `other/${ACCESS_BUNDLE}`, "--host", HOST]));
  assert.equal(other.code, "NOT_FOUND");
  assert.equal(other.details?.reason, "not_a_member");
});

// ── access grant and revoke ─────────────────────────────────────────────────────────────────

test("access grant without --yes previews with no request, and names the --yes command", async () => {
  const h = await harness();
  const receipt = await runAccess(h, ["grant", ACCESS_BUNDLE, "ana@example.com", "--level", "write", "--host", HOST]);
  assert.equal(h.host.requests.length, 0, "a preview makes no request at all");
  assert.equal(receipt.access, "preview");
  assert.equal(receipt.level, "write");
  assert.match(String(receipt.will), /Members page/);
  assert.deepEqual(receipt.help, [`${cliInvocation()} access grant team.knowledge ana@example.com --level write --host ${HOST} --yes`]);
  assert.equal(h.host.grants.has("person:ana"), false);
});

test("access grant --yes sends one identified request; a repeat changes nothing", async () => {
  const h = await harness();
  const receipt = await runAccess(h, ["grant", ACCESS_BUNDLE, "Ana@Example.com", "--level", "write", "--host", HOST, "--yes"]);
  const [sent] = routed(h);
  assert.equal(routed(h).length, 1);
  assert.equal(sent!.route, "access-grant");
  assert.deepEqual(sent!.body, { bundleId: ACCESS_BUNDLE, person: "Ana@Example.com", level: "write" });
  assert.match(sent!.writeRequest ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h.host.grants.get("person:ana"), "write");
  assert.equal(receipt.access, "granted");
  assert.equal(receipt.before, "none");
  assert.equal(receipt.level, "write");
  assert.deepEqual(receipt.person, { principal_id: "person:ana", email: "ana@example.com" });
  assert.equal(receipt.change_id, "change-1");

  h.host.requests.length = 0;
  const again = await runAccess(h, ["grant", ACCESS_BUNDLE, "ana@example.com", "--level", "write", "--host", HOST, "--yes"]);
  assert.equal(again.access, "unchanged");
  assert.equal(again.before, "write");
  assert.equal(again.change_id, undefined, "nothing changed, so the host names no change");
  assert.notEqual(routed(h)[0]!.writeRequest, sent!.writeRequest, "a settled grant does not reuse its request id");
  // Settled: no request id is kept for a re-run.
  assert.deepEqual(await readdir(path.join(userStateDir(h.home), "hosted-access")), []);
});

test("access grant: a change of level reads as changed", async () => {
  const h = await harness();
  const receipt = await runAccess(h, ["grant", ACCESS_BUNDLE, "person:bo", "--level", "write", "--host", HOST, "--yes"]);
  assert.equal(receipt.access, "changed");
  assert.equal(receipt.before, "read");
  assert.equal(h.host.grants.get("person:bo"), "write");
});

test("access grant refusals map to the CLI taxonomy, and nothing is changed", async () => {
  const cases: { name: string; argv: string[]; setup?: (host: FakeAccessHost) => void; code: string; reason: string; help: RegExp }[] = [
    { name: "not an admin", argv: ["ana@example.com", "--level", "read"], setup: (host) => (host.you = { level: "write", admin: false }), code: "FORBIDDEN", reason: "access_denied", help: /workspace admin/ },
    { name: "above own level", argv: ["ana@example.com", "--level", "write"], setup: (host) => (host.you = { level: "read", admin: true }), code: "FORBIDDEN", reason: "level_above_own", help: /grant read instead/ },
    { name: "not a member", argv: ["stranger@example.com", "--level", "read"], code: "NOT_FOUND", reason: "person_not_member", help: /Members page in the Superbee app first.*access grant team\.knowledge stranger@example\.com --level read/ },
    { name: "two members share the email", argv: ["twin@example.com", "--level", "read"], code: "USAGE", reason: "person_ambiguous", help: /principal id .*access list team\.knowledge/ },
    { name: "a concurrent change", argv: ["ana@example.com", "--level", "read"], setup: (host) => (host.hook = (r) => (r.route === "access-grant" ? Response.json(refused("version_conflict")) : undefined)), code: "CONFLICT", reason: "version_conflict", help: /run it again/ },
    { name: "a request id held for another change", argv: ["ana@example.com", "--level", "read"], setup: (host) => (host.hook = (r) => (r.route === "access-grant" ? Response.json(refused("request_conflict")) : undefined)), code: "CONFLICT", reason: "request_conflict", help: /new request/ },
  ];
  for (const each of cases) {
    const h = await harness();
    each.setup?.(h.host);
    const before = [...h.host.grants];
    const error = await rejects(runAccess(h, ["grant", ACCESS_BUNDLE, ...each.argv, "--host", HOST, "--yes"]));
    assert.equal(error.code, each.code, each.name);
    assert.equal(error.details?.reason, each.reason, each.name);
    assert.match(error.help ?? "", each.help, each.name);
    assert.deepEqual([...h.host.grants], before, `${each.name}: nothing changed`);
  }
  const h = await harness();
  const absent = await rejects(runAccess(h, ["grant", "other.bundle", "ana@example.com", "--level", "read", "--host", HOST, "--yes"]));
  assert.equal(absent.code, "NOT_FOUND");
  assert.equal(absent.details?.reason, "bundle_not_found");
  assert.match(absent.help ?? "", /catalog list --hosted/);
});

test("access grant: a bad level or person is refused before any request", async () => {
  const h = await harness();
  for (const argv of [
    ["grant", ACCESS_BUNDLE, "ana@example.com", "--host", HOST, "--yes"],
    ["grant", ACCESS_BUNDLE, "ana@example.com", "--level", "admin", "--host", HOST, "--yes"],
    ["grant", ACCESS_BUNDLE, "ana @example.com", "--level", "read", "--host", HOST, "--yes"],
  ]) {
    const error = await rejects(runAccess(h, argv));
    assert.equal(error.code, "USAGE", argv.join(" "));
  }
  assert.equal(h.host.requests.length, 0);
});

test("access grant: an unknown outcome keeps the request id, and the re-run re-sends it", async () => {
  const h = await harness();
  let unknown = 1;
  h.host.hook = (request) => {
    if (request.route !== "access-grant" || unknown === 0) return undefined;
    unknown -= 1;
    return Response.json({ error: { code: "write_outcome_unknown", message: "send the same request again" } }, { status: 503 });
  };
  const argv = ["grant", ACCESS_BUNDLE, "ana@example.com", "--level", "read", "--host", HOST, "--yes"];
  const error = await rejects(runAccess(h, argv));
  assert.equal(error.code, "TRANSIENT");
  assert.equal(error.details?.reason, "write_outcome_unknown");
  assert.match(error.help ?? "", /re-run the same command/);
  const first = routed(h).at(-1)!.writeRequest;
  assert.equal(error.details?.request_id, first);

  const receipt = await runAccess(h, argv);
  assert.equal(routed(h).at(-1)!.writeRequest, first, "the re-run re-sends the same request");
  assert.equal(receipt.access, "granted");

  // Settled: the next change is a new request.
  await runAccess(h, ["revoke", ACCESS_BUNDLE, "ana@example.com", "--host", HOST, "--yes"]);
  assert.notEqual(routed(h).at(-1)!.writeRequest, first);
});

test("access: an unsettled grant's id is not reused by another change, nor after an hour", async () => {
  const h = await harness();
  h.host.hook = (request) => (request.route === "access-grant" || request.route === "access-revoke" ? Response.json({ error: { code: "write_outcome_unknown" } }, { status: 503 }) : undefined);
  await rejects(runAccess(h, ["grant", ACCESS_BUNDLE, "ana@example.com", "--level", "read", "--host", HOST, "--yes"]));
  const grant = routed(h).at(-1)!.writeRequest;
  await rejects(runAccess(h, ["revoke", ACCESS_BUNDLE, "ana@example.com", "--host", HOST, "--yes"]));
  const revoke = routed(h).at(-1)!.writeRequest;
  assert.notEqual(revoke, grant, "a revoke never replays a grant's recorded answer");
  await rejects(runAccess(h, ["revoke", ACCESS_BUNDLE, "ana@example.com", "--host", HOST, "--yes"]));
  assert.equal(routed(h).at(-1)!.writeRequest, revoke);
  h.now += 61 * 60 * 1000;
  await rejects(runAccess(h, ["revoke", ACCESS_BUNDLE, "ana@example.com", "--host", HOST, "--yes"]));
  assert.notEqual(routed(h).at(-1)!.writeRequest, revoke);
});

test("access revoke previews, then takes the access away; a repeat changes nothing", async () => {
  const h = await harness();
  const preview = await runAccess(h, ["revoke", ACCESS_BUNDLE, "bo@example.com", "--host", HOST]);
  assert.equal(preview.access, "preview");
  assert.equal(h.host.requests.length, 0);
  assert.deepEqual(preview.help, [`${cliInvocation()} access revoke team.knowledge bo@example.com --host ${HOST} --yes`]);
  assert.equal(h.host.grants.get("person:bo"), "read");

  const receipt = await runAccess(h, ["revoke", ACCESS_BUNDLE, "bo@example.com", "--host", HOST, "--yes"]);
  assert.deepEqual(routed(h).map((r) => [r.route, r.body]), [["access-revoke", { bundleId: ACCESS_BUNDLE, person: "bo@example.com" }]]);
  assert.equal(receipt.access, "revoked");
  assert.equal(receipt.level, "none");
  assert.equal(receipt.before, "read");
  assert.equal(h.host.grants.has("person:bo"), false);

  const again = await runAccess(h, ["revoke", ACCESS_BUNDLE, "bo@example.com", "--host", HOST, "--yes"]);
  assert.equal(again.access, "unchanged");
});

test("access: a host without the routes is NOT_IMPLEMENTED, pointing at the app", async () => {
  const h = await harness();
  h.host.hook = (request) => (request.route === "access-list" ? Response.json({ error: "not_found" }, { status: 404 }) : undefined);
  const error = await rejects(runAccess(h, ["list", ACCESS_BUNDLE, "--host", HOST]));
  assert.equal(error.code, "NOT_IMPLEMENTED");
  assert.match(error.help ?? "", /Superbee app/);
});

// ── bundle retire ────────────────────────────────────────────────────────────────────────────

test("bundle retire: the host's statement is shown, the person types the id, and the bundle is retired", async () => {
  const h = await harness();
  const terminal = personAtTerminal(() => `${ACCESS_BUNDLE}\n`);
  const receipt = await runRetire(h, [ACCESS_BUNDLE, "--host", HOST], terminal);
  assert.equal(terminal.prompts.length, 1);
  const prompt = terminal.prompts[0]!;
  assert.ok(prompt.includes(h.host.retire.statement), "the host's own words are shown");
  assert.match(prompt, /2 people have access; 1 pending invitation\(s\) will be canceled/);
  assert.match(prompt, /export team\.knowledge --host .* --to <folder> --git/);
  assert.match(prompt, /Type team\.knowledge to retire it/);
  const sent = routed(h);
  assert.deepEqual(sent.map((r) => r.route), ["bundle-retire-preview", "bundle-retire"]);
  assert.equal(sent[0]!.writeRequest, null);
  assert.deepEqual(sent[1]!.body, { bundleId: ACCESS_BUNDLE, confirm: ACCESS_BUNDLE });
  assert.match(sent[1]!.writeRequest ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(receipt.retire, "retired");
  assert.equal(receipt.revoked_grants, 1);
  assert.equal(receipt.canceled_invitations, 1);
  assert.equal(h.host.retire.state, "retired");

  // Retired already: the preview says so, and nothing is asked or sent.
  h.host.requests.length = 0;
  const again = await runRetire(h, [ACCESS_BUNDLE, "--host", HOST], noTerminal());
  assert.equal(again.retire, "already_retired");
  assert.deepEqual(routed(h).map((r) => r.route), ["bundle-retire-preview"]);
});

test("bundle retire: a wrong id typed retires nothing and sends nothing", async () => {
  const h = await harness();
  for (const typed of ["team", `${SLUG}/${ACCESS_BUNDLE}`, "", "yes"]) {
    h.host.requests.length = 0;
    const terminal = personAtTerminal(() => `${typed}\n`);
    const error = await rejects(runRetire(h, [ACCESS_BUNDLE, "--host", HOST], terminal));
    assert.equal(error.code, "USAGE", typed);
    assert.equal(error.details?.reason, "not_confirmed", typed);
    assert.equal(terminal.prompts.length, 1);
    assert.deepEqual(routed(h).map((r) => r.route), ["bundle-retire-preview"], `${typed}: only the preview was read`);
  }
  assert.equal(h.host.retire.state, "ready");
});

test("bundle retire with no person at a terminal is FORBIDDEN, tells the agent to hand it over, and sends nothing", async () => {
  const h = await harness();
  const error = await rejects(runRetire(h, [ACCESS_BUNDLE, "--host", HOST], noTerminal()));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "needs_person_at_terminal");
  assert.match(String(error.details?.agent_instruction), /Do not retry this or work around it/);
  assert.equal(error.details?.command_for_person, `${cliInvocation()} bundle retire team.knowledge --host ${HOST}`);
  assert.equal(error.details?.statement, h.host.retire.statement);
  assert.match(error.help ?? "", /ask the person to run in their own terminal: .*bundle retire team\.knowledge --host /);
  assert.deepEqual(routed(h).map((r) => r.route), ["bundle-retire-preview"]);
  assert.equal(h.host.retire.state, "ready");
});

test("bundle retire: a person the preview does not allow is refused before being asked", async () => {
  const h = await harness();
  h.host.retire.allowed = null;
  const terminal = personAtTerminal(() => `${ACCESS_BUNDLE}\n`);
  const error = await rejects(runRetire(h, [ACCESS_BUNDLE, "--host", HOST], terminal));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "not_allowed");
  assert.equal(terminal.prompts.length, 0, "nobody is asked to confirm what they may not do");
  assert.deepEqual(routed(h).map((r) => r.route), ["bundle-retire-preview"]);
});

test("bundle retire takes no flag that skips the typed id: --yes is USAGE before any request", async () => {
  const h = await harness();
  for (const extra of [["--yes"], ["--force"], ["--confirm", ACCESS_BUNDLE]]) {
    const error = await rejects(runRetire(h, [ACCESS_BUNDLE, "--host", HOST, ...extra], personAtTerminal(() => ACCESS_BUNDLE)));
    assert.equal(error.code, "USAGE", extra.join(" "));
  }
  assert.equal(h.host.requests.length, 0);
});

test("bundle retire: an admin refused names who may retire, not who may change access", async () => {
  const h = await harness();
  h.host.hook = (request) => (request.route === "bundle-retire" ? Response.json(refused("access_denied")) : undefined);
  const error = await rejects(runRetire(h, [ACCESS_BUNDLE, "--host", HOST], personAtTerminal(() => ACCESS_BUNDLE)));
  assert.equal(error.code, "FORBIDDEN");
  assert.match(error.message, /may not retire .*only a workspace admin, or the bundle's owner/);
});

test("access grant: a re-run naming the person in another case is a new request, not a request_conflict", async () => {
  const h = await harness();
  let unknown = 1;
  h.host.hook = (request) => {
    if (request.route !== "access-grant" || unknown === 0) return undefined;
    unknown -= 1;
    return Response.json({ error: { code: "write_outcome_unknown" } }, { status: 503 });
  };
  await rejects(runAccess(h, ["grant", ACCESS_BUNDLE, "Ana@Example.com", "--level", "read", "--host", HOST, "--yes"]));
  const first = routed(h).at(-1)!;
  const receipt = await runAccess(h, ["grant", ACCESS_BUNDLE, "ana@example.com", "--level", "read", "--host", HOST, "--yes"]);
  const second = routed(h).at(-1)!;
  assert.equal(second.body.person, "ana@example.com", "the person is sent as typed");
  assert.notEqual(second.writeRequest, first.writeRequest);
  assert.equal(receipt.access, "granted");
});

test("bundle retire: the host's refusal of the retire itself is named", async () => {
  const h = await harness();
  h.host.retire.retirable = false;
  const error = await rejects(runRetire(h, [ACCESS_BUNDLE, "--host", HOST], personAtTerminal(() => ACCESS_BUNDLE)));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "not_retirable");
});
