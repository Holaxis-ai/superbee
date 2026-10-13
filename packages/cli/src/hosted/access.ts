// The hosted routes that change who reaches a bundle, and retire one (`/sync/v1/access-list`,
// `access-grant`, `access-revoke`, `bundle-retire-preview`, `bundle-retire`; superbee-hosted lane
// share-retire). One request each: success is `200 {"ok":true,"data"}`, a refusal decided before
// anything was written is `200 {"ok":false,"error":{"code","message"}}`, and a write whose outcome
// the host could not settle is `503 write_outcome_unknown`, answered again by the same request id.
//
// A grant or revoke whose outcome is unknown keeps its request id in private state
// (`<private state>/hosted-access/`), keyed by host, bundle and person, so re-running the same
// command re-sends the same request and the host answers what it recorded. Any settled answer
// forgets it, and so does a different change for the same person, or an hour passing: then a fresh
// id is sent, which is safe because a grant of the level a person has, or a revoke of no access,
// succeeds and changes nothing.
import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { RemoteError } from "@superbee/core";
import { HostedCarrierError, isAnswerTooLarge } from "@superbee/core/hosted-transport";

import { commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { hostArgument } from "../hosted-auth/session.js";
import { readUserStateFile, userStateDir, writeUserStateFileAtomic0600 } from "../user-state.js";
import { hostedFailure, type HostedSyncClient } from "./client.js";

/** The routes' answers are small; a full people list is bounded by the workspace's members. */
const ANSWER_BYTES = 1024 * 1024;
/** How long an unsettled grant or revoke keeps its request id for a re-run. */
const PENDING_MS = 60 * 60 * 1000;

export type AccessRoute = "access-list" | "access-grant" | "access-revoke" | "bundle-retire-preview" | "bundle-retire";

export type RouteAnswer = { readonly ok: true; readonly data: Record<string, unknown> } | { readonly ok: false; readonly code: string; readonly message: string };

export interface RouteContext {
  readonly client: HostedSyncClient;
  /** The command that repeats this one, carried on AUTH_REQUIRED and on an unknown outcome. */
  readonly resume: string;
  /** The person-facing name of the bundle (`<slug>/<id>` or the id). */
  readonly reference: string;
}

/**
 * One request to a route: its data, or the refusal the host decided before writing anything. An
 * unknown outcome is TRANSIENT (re-run: the same command re-sends the same request id), a gateway
 * without the route is NOT_IMPLEMENTED, and anything else is the shared transport translation.
 */
export async function postRoute(context: RouteContext, route: AccessRoute, body: Record<string, unknown>, writeRequest?: string): Promise<RouteAnswer> {
  const { client, resume } = context;
  const target = client.target;
  const unknown = () =>
    new CliError("TRANSIENT", `the answer from ${target.origin} did not arrive; the change to '${context.reference}' may or may not have been made`, {
      details: { reason: "write_outcome_unknown", route, bundle: context.reference, host: target.origin, ...(writeRequest ? { request_id: writeRequest } : {}), retryable: true },
      help: `re-run the same command; it is safe to repeat: ${resume}`,
    });
  let answer;
  try {
    answer = await client.carrier.json(`${client.prefix}/${route}`, body, client.signal, { maximum: ANSWER_BYTES, ...(writeRequest ? { writeRequest } : {}) });
  } catch (error) {
    if (writeRequest && error instanceof HostedCarrierError && error.code === "unavailable") throw unknown();
    if (isAnswerTooLarge(error)) {
      throw new CliError("RUNTIME", `${target.origin} answered ${route} with more than ${ANSWER_BYTES} bytes`, { details: { host: target.origin, route, retryable: false } });
    }
    throw hostedFailure(error, target, resume);
  }
  const envelope = (answer.body ?? {}) as { ok?: unknown; data?: unknown; error?: unknown };
  const error = envelope.error;
  const code = typeof error === "string" ? error : typeof (error as { code?: unknown } | undefined)?.code === "string" ? (error as { code: string }).code : null;
  const message = typeof (error as { message?: unknown } | undefined)?.message === "string" ? (error as { message: string }).message : "";
  if (answer.status === 503 && code === "write_outcome_unknown") throw unknown();
  if (answer.status === 404 && code === "not_found" && typeof error === "string") {
    throw new CliError("NOT_IMPLEMENTED", `${target.origin} does not offer ${route} yet`, {
      details: { host: target.origin, route, status: 404 },
      help: "a later release of the host offers it; until then do this in the Superbee app",
    });
  }
  if (answer.status === 200 && envelope.ok === true && typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data)) {
    return { ok: true, data: envelope.data as Record<string, unknown> };
  }
  if (answer.status === 200 && envelope.ok === false && code !== null) return { ok: false, code, message };
  throw hostedFailure(new RemoteError(`hosted ${route} answered ${answer.status}`, code ?? "RUNTIME", answer.status), target, resume);
}

/** What a refusal is about, for the words and the next step. */
export interface RefusalSubject {
  readonly reference: string;
  readonly host: Parameters<typeof hostArgument>[0];
  readonly person?: string;
  /** The command that repeats this one. */
  readonly again: string;
  /** Retiring rather than changing access (a refusal then names who may retire). */
  readonly retire?: boolean;
}

/** One refusal of the access and retire routes, as the CLI taxonomy names it. */
export function accessRefusal(code: string, hostMessage: string, subject: RefusalSubject): CliError {
  const { reference, person } = subject;
  const host = commandToken(hostArgument(subject.host));
  const origin = subject.host.origin;
  const details = { reason: code, bundle: reference, host: origin, ...(person !== undefined ? { person } : {}), ...(hostMessage ? { host_message: hostMessage } : {}) };
  const list = `${cliInvocation()} access list ${commandToken(reference)} --host ${host}`;
  switch (code) {
    case "access_denied":
      if (subject.retire) {
        return new CliError("FORBIDDEN", `you may not retire '${reference}' on ${origin}: only a workspace admin, or the bundle's owner, may`, {
          details,
          help: "ask a workspace admin to retire it",
        });
      }
      return new CliError("FORBIDDEN", `you may not change who reaches '${reference}' on ${origin}: only a workspace admin may (and the bundle's owner may retire it)`, {
        details,
        help: `ask a workspace admin to do it, or to make you an admin; ${list} shows your own access`,
      });
    case "level_above_own":
      return new CliError("FORBIDDEN", `you cannot grant more than your own access to '${reference}'`, { details, help: `grant read instead, or ask an admin with write access; ${list} shows your level` });
    case "person_not_member":
      return new CliError("NOT_FOUND", `${person ?? "that person"} is not a member of the workspace that holds '${reference}' on ${origin}`, {
        details,
        help: `invite them from the Members page in the Superbee app first; once they have joined, re-run: ${subject.again}`,
      });
    case "person_ambiguous":
      return new CliError("USAGE", `more than one member of the workspace has the email ${person ?? ""}`, {
        details,
        help: `name them by principal id (person:...) instead; ${list} lists everyone with access and their ids`,
      });
    case "bundle_not_found":
      return new CliError("NOT_FOUND", `no hosted bundle '${reference}' is visible to you on ${origin}`, {
        details,
        help: `${cliInvocation()} catalog list --hosted --host ${host}`,
      });
    case "version_conflict":
      return new CliError("CONFLICT", `someone changed ${person ?? "this person"}'s access to '${reference}' at the same moment; nothing was changed`, { details, help: `run it again: ${subject.again}` });
    case "request_conflict":
      return new CliError("CONFLICT", `${origin} holds this request id for a different change; nothing was changed`, { details, help: `run it again (it sends a new request): ${subject.again}` });
    case "not_retirable":
      return new CliError("FORBIDDEN", `'${reference}' cannot be retired here: it has no hosted storage of its own (a configured or Git-registered bundle)`, {
        details,
        help: "ask a workspace admin to remove it in the Superbee app",
      });
    case "confirm_mismatch":
      return new CliError("USAGE", `${origin} did not accept the typed confirmation for '${reference}'; nothing was retired`, { details, help: `run it again and type the bundle id exactly: ${subject.again}` });
    default:
      return new CliError("RUNTIME", `${origin} refused the request (${code})${hostMessage ? `: ${hostMessage}` : ""}`, { details });
  }
}

// ── the request id an unsettled grant or revoke keeps ────────────────────────────────────────

interface PendingAccess {
  readonly request_id: string;
  /** `grant:<level>` or `revoke`: another change for the same person sends a fresh id. */
  readonly change: string;
  readonly at_ms: number;
}

function pendingFile(home: string, host: string, reference: string, person: string): { dir: string; name: string } {
  const key = createHash("sha256").update(`superbee:access\0${host}\0${reference}\0${person}`, "utf8").digest("hex");
  return { dir: path.join(userStateDir(home), "hosted-access"), name: `${key}.json` };
}

/** The request id for this change: the one an unsettled run of the same change recorded, else a new one (recorded). */
export async function accessRequestId(home: string, host: string, reference: string, person: string, change: string, nowMs: number): Promise<string> {
  const { dir, name } = pendingFile(home, host, reference, person);
  try {
    const value = JSON.parse(await readUserStateFile(home, path.join(dir, name), 4096)) as Partial<PendingAccess>;
    if (typeof value.request_id === "string" && value.change === change && typeof value.at_ms === "number" && nowMs - value.at_ms >= 0 && nowMs - value.at_ms < PENDING_MS) return value.request_id;
  } catch {
    // None, or unreadable: a new id.
  }
  const record: PendingAccess = { request_id: randomUUID(), change, at_ms: nowMs };
  await writeUserStateFileAtomic0600(home, dir, name, `${JSON.stringify(record)}\n`);
  return record.request_id;
}

/** Forget the request id once the host has settled the change (or refused it). */
export async function settleAccessRequest(home: string, host: string, reference: string, person: string): Promise<void> {
  const { dir, name } = pendingFile(home, host, reference, person);
  await unlink(path.join(dir, name)).catch(() => {});
}
