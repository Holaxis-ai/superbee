// The staged creation `superbee publish --to hosted` sends for a bundle past the one-request
// bounds (hosted `docs/person-bundle-create.md`, "Staged creation"): under the one request id,
//
//   bundle-create-begin   the manifest (`manifestBody`); also the status call
//   bundle-create-stage   parts of about 1 MiB (`packParts`), each version staged once
//   bundle-create-blob    each blob's raw bytes, at most two at a time
//   bundle-create-commit  repeated until it answers the one-shot's own success answer
//
// The CLI stages only what the host's latest answer names as `missing`, so a re-run under the same
// request id (the pending-create record) resumes: a killed upload re-stages only what never
// arrived, and a killed commit goes on committing. A status answer whose `missing` is empty means
// "commit again". A plan hash the host holds no manifest for (its expiry sweep removed it) is
// answered by sending begin again. A `503` is retried here a few times; past that, and on a
// dropped connection, the run stops TRANSIENT and the same command resumes it.
import { MalformedAnswer, RemoteError } from "@superbee/core";
import { HostedCarrierError, type HostedAnswer } from "@superbee/core/hosted-transport";

import { CliError } from "../errors.js";
import { hostedFailure, type HostedSyncClient } from "./client.js";
import { manifestBody, packParts, type StagedContent } from "./publish-plan.js";

/** The four staged routes, under the sync family's prefix. */
export const STAGED_CREATE_ROUTES = Object.freeze(["bundle-create-begin", "bundle-create-stage", "bundle-create-blob", "bundle-create-commit"] as const);

const ANSWER_BYTES = 256 * 1024;
const BLOBS_IN_FLIGHT = 2;
/** Delays before each retry of a `503` answer. */
const RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000]);
/** Requests one run makes at most before it stops (a host that never finishes). */
const MAXIMUM_ROUNDS = 5_000;
/** Rounds that stage what `missing` names without it shrinking, before the run stops. */
const MAXIMUM_STALLS = 3;
const NO_MANIFEST = /no staged manifest/i;

/** What a staged creation reports as it goes. */
export type StagedProgress =
  | { readonly phase: "begin"; readonly state: string; readonly versions: number; readonly staged: number; readonly blobs: number; readonly stagedBlobs: number }
  | { readonly phase: "stage"; readonly part: number; readonly parts: number; readonly objects: number }
  | { readonly phase: "blob"; readonly blob: number; readonly blobs: number; readonly key: string; readonly bytes: number }
  | { readonly phase: "commit"; readonly call: number; readonly state: string; readonly written?: Readonly<Record<string, number>> };

/** A refusal the host answered: the caller words it, as it words the one-shot's. */
export class StagedRefusal extends Error {
  readonly code: string;
  readonly hostMessage: string;
  /** True when the creation was reserved: the request id must be kept to finish it. */
  readonly reserved: boolean;
  constructor(code: string, hostMessage: string, reserved: boolean) {
    super(`${code}: ${hostMessage}`);
    this.code = code;
    this.hostMessage = hostMessage;
    this.reserved = reserved;
  }
}

interface Status {
  readonly state: "staging" | "importing" | "created";
  readonly planHash: string;
  readonly staged: { readonly versions: number; readonly blobVersions: number };
  readonly missing: { readonly versions: readonly string[]; readonly blobs: readonly string[] };
  readonly written?: Readonly<Record<string, number>>;
}

export interface StagedCreateRequest {
  readonly client: HostedSyncClient;
  readonly requestId: string;
  readonly target: { readonly workspace: string; readonly bundleId: string; readonly name: string };
  readonly content: StagedContent;
  /** The command that resumes this one, for a TRANSIENT stop. */
  readonly resume: string;
  readonly progress?: (event: StagedProgress) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

const VERSION = /^sha256:[0-9a-f]{64}$/;
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Runs a staged creation to its end and answers the host's success answer's `data` (the one-shot's,
 * byte for byte), or throws: a {@link StagedRefusal} for the host's refusals, a TRANSIENT
 * `CliError` when the outcome is unknown and the same command resumes it, and the client's own
 * errors otherwise.
 */
export async function runStagedCreate(request: StagedCreateRequest): Promise<Record<string, unknown>> {
  const { client, requestId, target, content } = request;
  const sleep = request.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = request.progress ?? (() => {});
  const route = (name: (typeof STAGED_CREATE_ROUTES)[number]) => `${client.prefix}/${name}`;
  let reserved = false;
  let planHash = "";

  const unknownOutcome = (why: string) =>
    new CliError("TRANSIENT", `${why}; the bundle may be partly created`, {
      details: { reason: "write_outcome_unknown", bundle_id: target.bundleId, workspace: target.workspace, host: client.target.origin, request_id: requestId, retryable: true },
      help: `re-run the same command; it resumes the same creation, sending only what the host is missing: ${request.resume}`,
    });

  /** One request, with a `503` retried; a dropped connection stops the run. */
  async function send(name: (typeof STAGED_CREATE_ROUTES)[number], body: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<HostedAnswer> {
    for (let attempt = 0; ; attempt++) {
      let answer: HostedAnswer;
      try {
        if (body instanceof Uint8Array) {
          if (!client.carrier.bytes) throw new CliError("RUNTIME", "this client cannot send a file's raw bytes");
          answer = await client.carrier.bytes(route(name), body, client.signal, { maximum: ANSWER_BYTES, writeRequest: requestId, ...(headers ? { headers } : {}) });
        } else {
          answer = await client.carrier.json(route(name), body, client.signal, { maximum: ANSWER_BYTES, writeRequest: requestId });
        }
      } catch (error) {
        if (error instanceof HostedCarrierError && error.code === "unavailable") throw unknownOutcome(`the answer from ${client.target.origin} to ${name} did not arrive`);
        throw hostedFailure(error, client.target, request.resume);
      }
      if (answer.status !== 503) return answer;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw unknownOutcome(`${client.target.origin} kept answering ${name} 503`);
      await sleep(delay);
    }
  }

  /** The answer's `data`, `no_manifest`, or the refusal it names. */
  function read(name: string, answer: HostedAnswer): Record<string, unknown> | "no_manifest" {
    const envelope = (answer.body ?? {}) as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    const code = typeof envelope.error?.code === "string" ? envelope.error.code : null;
    const message = typeof envelope.error?.message === "string" ? envelope.error.message : "";
    if (answer.status === 200 && envelope.ok === true && typeof envelope.data === "object" && envelope.data !== null) return envelope.data as Record<string, unknown>;
    // The host holds no manifest under this plan hash (its expiry sweep removed it): begin again.
    if (answer.status === 200 && envelope.ok === false && code === "staged_manifest_missing") return "no_manifest";
    if (answer.status === 200 && envelope.ok === false && code !== null) throw new StagedRefusal(code, message, reserved);
    if (answer.status === 429 && code === "bundle_create_limit") throw new StagedRefusal(code, message, reserved);
    // The host's only answer for a plan hash it holds no manifest for: begin again.
    if (answer.status === 400 && code === "invalid_input" && NO_MANIFEST.test(message)) return "no_manifest";
    if (answer.status === 400 && !reserved) throw new StagedRefusal(code ?? "invalid_input", message || `the host refused ${name} as malformed`, false);
    throw hostedFailure(new RemoteError(`hosted ${name} answered ${answer.status}`, code ?? "RUNTIME", answer.status), client.target, request.resume);
  }

  function status(name: string, data: Record<string, unknown>): Status {
    const missing = data.missing as { versions?: unknown; blobs?: unknown } | undefined;
    const staged = data.staged as { versions?: unknown; blobVersions?: unknown } | undefined;
    if (
      (data.state !== "staging" && data.state !== "importing" && data.state !== "created") ||
      typeof data.planHash !== "string" ||
      !VERSION.test(data.planHash) ||
      !isStringList(missing?.versions) ||
      !isStringList(missing?.blobs) ||
      typeof staged?.versions !== "number" ||
      typeof staged.blobVersions !== "number"
    ) {
      throw hostedFailure(new MalformedAnswer(`not a staged creation's status`, route(name as (typeof STAGED_CREATE_ROUTES)[number])), client.target, request.resume);
    }
    const answer = data as unknown as Status;
    planHash = answer.planHash;
    if (answer.state !== "staging") reserved = true;
    return answer;
  }

  const manifest = manifestBody(content, target);
  async function begin(): Promise<Status> {
    const data = read("bundle-create-begin", await send("bundle-create-begin", manifest));
    if (data === "no_manifest") throw hostedFailure(new MalformedAnswer("begin answered that no manifest is staged", route("bundle-create-begin")), client.target, request.resume);
    const answer = status("bundle-create-begin", data);
    progress({ phase: "begin", state: answer.state, versions: content.objects.size, staged: answer.staged.versions, blobs: content.blobBytes.size, stagedBlobs: answer.staged.blobVersions });
    return answer;
  }

  /** Stages what `from` names as missing: blobs first, then parts. Answers the last part's status, or null to ask commit. */
  async function fill(from: Status): Promise<Status | null | "no_manifest"> {
    const unknown = [...from.missing.versions.filter((v) => !content.objects.has(v)), ...from.missing.blobs.filter((v) => !content.blobBytes.has(v))];
    if (unknown.length > 0) {
      throw new CliError("RUNTIME", `${client.target.origin} asks for ${unknown.length} object(s) this folder does not hold (client/host contract mismatch)`, {
        details: { reason: "staged_mismatch", versions: unknown.slice(0, 5), host: client.target.origin, request_id: requestId, retryable: false },
        help: "upgrade Superbee (npm install -g superbee), then re-run the same command",
      });
    }
    const blobs = from.missing.blobs;
    let next = 0;
    let gone = false;
    const upload = async () => {
      for (let at = next++; at < blobs.length && !gone; at = next++) {
        const version = blobs[at]!;
        const blob = content.blobBytes.get(version)!;
        const data = read(
          "bundle-create-blob",
          await send("bundle-create-blob", blob.bytes, {
            "X-Superbee-Workspace": target.workspace,
            "X-Superbee-Bundle": target.bundleId,
            "X-Superbee-Blob-Version": version,
            "X-Superbee-Plan-Hash": planHash,
          }),
        );
        if (data === "no_manifest") {
          gone = true;
          return;
        }
        progress({ phase: "blob", blob: at + 1, blobs: blobs.length, key: blob.key, bytes: blob.bytes.byteLength });
      }
    };
    await Promise.all(Array.from({ length: Math.min(BLOBS_IN_FLIGHT, blobs.length) }, upload));
    if (gone) return "no_manifest";
    const parts = packParts(content, from.missing.versions);
    let last: Status | null = null;
    for (const [index, part] of parts.entries()) {
      const data = read(
        "bundle-create-stage",
        await send("bundle-create-stage", { workspace: target.workspace, bundleId: target.bundleId, planHash, documents: part.documents, reserved: part.reserved, history: part.history }),
      );
      if (data === "no_manifest") return "no_manifest";
      last = status("bundle-create-stage", data);
      progress({ phase: "stage", part: index + 1, parts: parts.length, objects: part.versions.length });
    }
    // Blobs alone answer no status: commit says what is still missing, or goes on.
    return blobs.length > 0 ? null : last;
  }

  const outstanding = (s: Status) => s.missing.versions.length + s.missing.blobs.length;
  const missingKey = (s: Status) => `${outstanding(s)}:${s.missing.versions[0] ?? ""}:${s.missing.blobs[0] ?? ""}`;
  let current: Status | null = await begin();
  let stalls = 0;
  let commits = 0;
  for (let round = 0; round < MAXIMUM_ROUNDS; round++) {
    if (current !== null && current.state !== "created" && outstanding(current) > 0) {
      const before = missingKey(current);
      const after = await fill(current);
      if (after === "no_manifest") {
        current = await begin();
        continue;
      }
      if (after !== null && outstanding(after) > 0) {
        stalls = missingKey(after) === before ? stalls + 1 : 0;
        if (stalls >= MAXIMUM_STALLS) {
          throw new CliError("RUNTIME", `${client.target.origin} keeps naming the same objects as missing after they were sent`, {
            details: { reason: "staged_stall", missing: after.missing, host: client.target.origin, request_id: requestId, retryable: true },
            help: `re-run the same command later: ${request.resume}`,
          });
        }
        current = after;
        continue;
      }
    }
    commits += 1;
    const answer = await send("bundle-create-commit", { workspace: target.workspace, bundleId: target.bundleId, planHash });
    const data = read("bundle-create-commit", answer);
    if (data === "no_manifest") {
      current = await begin();
      continue;
    }
    if (typeof data.state !== "string") {
      // The one-shot's own success answer: the creation is done.
      return data;
    }
    current = status("bundle-create-commit", data);
    progress({ phase: "commit", call: commits, state: current.state, ...(current.written ? { written: current.written } : {}) });
  }
  throw unknownOutcome(`${client.target.origin} did not finish the creation within ${MAXIMUM_ROUNDS} requests`);
}
