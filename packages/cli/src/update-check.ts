import {
  compareStrictSemver,
  parseStrictSemver,
  type ParsedStrictSemver,
} from "../../../scripts/strict-semver.mjs";
export { compareStrictSemver, parseStrictSemver } from "../../../scripts/strict-semver.mjs";

export const UPDATE_CHECK_SCHEMA = "superbee.update-check.v1";
export const UPDATE_CHECK_ENDPOINT = "https://registry.npmjs.org/superbee";
export const UPDATE_CHECK_ACCEPT = "application/vnd.npm.install-v1+json";
export const UPDATE_CHECK_TIMEOUT_MS = 2_000;
export const UPDATE_CHECK_MAX_BYTES = 1_048_576;

declare const __SUPERBEE_FUNCTIONAL_VERSION_FLOOR__: unknown;
declare const __SUPERBEE_UPDATE_POLICY__: unknown;

const PACKAGE_NAME = "superbee";
const MAX_METADATA_LENGTH = 4_096;

export type ReleaseTrack = "latest" | "next";
export type UpdateCheckStatus =
  | "unavailable"
  | "deprecated"
  | "current"
  | "successor_not_ready"
  | "upgrade_available"
  | "rollback_available";
export type UpdateCheckRelation = "unknown" | "equal" | "selected_newer" | "selected_older";
export type UpdateUnavailableCode =
  | "timeout"
  | "offline"
  | "http"
  | "too_large"
  | "malformed"
  | "tag_missing"
  | "successor_not_ready"
  | "selected_deprecated"
  | "policy_disabled";

export interface UpdateCheckUnavailable {
  code: UpdateUnavailableCode;
  message: string;
}

export interface UpdateCheckResult {
  schema: typeof UPDATE_CHECK_SCHEMA;
  track: ReleaseTrack;
  status: UpdateCheckStatus;
  relation: UpdateCheckRelation;
  checked_at: string;
  running_version: string;
  selected_version: string | null;
  running_deprecated: string | null;
  selected_integrity: string | null;
  command: string | null;
  verify: string[];
  unavailable: UpdateCheckUnavailable | null;
}

export type { ParsedStrictSemver };

export function bakedFunctionalVersionFloor(): string | undefined {
  if (typeof __SUPERBEE_FUNCTIONAL_VERSION_FLOOR__ === "undefined") return undefined;
  if (
    typeof __SUPERBEE_FUNCTIONAL_VERSION_FLOOR__ !== "string" ||
    !parseStrictSemver(__SUPERBEE_FUNCTIONAL_VERSION_FLOOR__)
  ) {
    return undefined;
  }
  return __SUPERBEE_FUNCTIONAL_VERSION_FLOOR__;
}

export function bakedUpdatePolicy(): { enabled: boolean } {
  const policy = record(typeof __SUPERBEE_UPDATE_POLICY__ === "undefined" ? undefined : __SUPERBEE_UPDATE_POLICY__);
  if (policy?.enabled === true) {
    return { enabled: true };
  }
  return { enabled: false };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedMetadata(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  if ((!allowEmpty && value.length === 0) || value.length > MAX_METADATA_LENGTH) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function packageIntegrity(value: unknown): string | undefined {
  const bounded = boundedMetadata(value);
  const encoded = bounded?.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encoded) return undefined;
  const digest = Buffer.from(encoded, "base64");
  return digest.byteLength === 64 && digest.toString("base64") === encoded ? bounded : undefined;
}

function deprecation(entry: Record<string, unknown>): { valid: true; value: string | null } | { valid: false } {
  if (!("deprecated" in entry)) return { valid: true, value: null };
  const value = boundedMetadata(entry.deprecated, true);
  if (value === undefined) return { valid: false };
  return { valid: true, value: value.length === 0 ? null : value };
}

function unavailable(
  runningVersion: string,
  track: ReleaseTrack,
  checkedAt: string,
  code: UpdateUnavailableCode,
  message: string,
  known: Partial<
    Pick<UpdateCheckResult, "selected_version" | "running_deprecated" | "selected_integrity">
  > = {},
): UpdateCheckResult {
  return {
    schema: UPDATE_CHECK_SCHEMA,
    track,
    status: "unavailable",
    relation: "unknown",
    checked_at: checkedAt,
    running_version: runningVersion,
    selected_version: known.selected_version ?? null,
    running_deprecated: known.running_deprecated ?? null,
    selected_integrity: known.selected_integrity ?? null,
    command: null,
    verify: [],
    unavailable: { code, message },
  };
}

function malformed(runningVersion: string, track: ReleaseTrack, checkedAt: string): UpdateCheckResult {
  return unavailable(
    runningVersion,
    track,
    checkedAt,
    "malformed",
    "npm registry response was not a valid supported-release document",
  );
}

function verificationCommands(track: ReleaseTrack): string[] {
  return [
    track === "latest" ? "superbee version --check" : "superbee version --check --tag next",
    "superbee skill status --scope user",
    "superbee hook status --scope user",
  ];
}

/** Apply the policy-authoritative dist-tag and all deprecation/precedence rules without I/O. */
export function selectSupportedRelease(input: {
  packument: unknown;
  track: ReleaseTrack;
  runningVersion: string;
  checkedAt: string;
  functionalVersionFloor: string;
}): UpdateCheckResult {
  const { packument, track, runningVersion, checkedAt, functionalVersionFloor } = input;
  if (!parseStrictSemver(runningVersion)) {
    throw new Error("running package version is not valid strict SemVer");
  }
  if (!parseStrictSemver(functionalVersionFloor)) {
    throw new Error("functional successor version floor is not valid strict SemVer");
  }
  const root = record(packument);
  if (!root || root.name !== PACKAGE_NAME) return malformed(runningVersion, track, checkedAt);
  const tags = record(root?.["dist-tags"]);
  if (!tags || !Object.hasOwn(tags, track)) {
    return unavailable(
      runningVersion,
      track,
      checkedAt,
      "tag_missing",
      `npm registry response has no ${track} dist-tag`,
    );
  }
  const selectedVersion = tags[track];
  if (typeof selectedVersion !== "string" || !parseStrictSemver(selectedVersion)) {
    return malformed(runningVersion, track, checkedAt);
  }
  const versions = record(root?.versions);
  if (!versions || !Object.hasOwn(versions, selectedVersion)) {
    return malformed(runningVersion, track, checkedAt);
  }
  const selected = record(versions[selectedVersion]);
  const dist = record(selected?.dist);
  const integrity = packageIntegrity(dist?.integrity);
  const selectedDeprecation = selected ? deprecation(selected) : { valid: false as const };
  if (
    !selected ||
    selected.name !== PACKAGE_NAME ||
    selected.version !== selectedVersion ||
    !integrity ||
    !selectedDeprecation.valid
  ) {
    return malformed(runningVersion, track, checkedAt);
  }

  let runningDeprecated: string | null = null;
  if (runningVersion === selectedVersion) {
    runningDeprecated = selectedDeprecation.value;
  } else if (Object.hasOwn(versions, runningVersion)) {
    const running = record(versions[runningVersion]);
    const runningDeprecation = running ? deprecation(running) : { valid: false as const };
    if (
      !running ||
      running.name !== PACKAGE_NAME ||
      running.version !== runningVersion ||
      !runningDeprecation.valid
    ) {
      return malformed(runningVersion, track, checkedAt);
    }
    runningDeprecated = runningDeprecation.value;
  }

  const known = {
    selected_version: selectedVersion,
    running_deprecated: runningDeprecated,
    selected_integrity: integrity,
  };
  if (selectedVersion === runningVersion) {
    return {
      schema: UPDATE_CHECK_SCHEMA,
      track,
      status: selectedDeprecation.value === null ? "current" : "deprecated",
      relation: "equal",
      checked_at: checkedAt,
      running_version: runningVersion,
      ...known,
      command: null,
      verify: [],
      unavailable: null,
    };
  }

  const floorComparison = compareStrictSemver(selectedVersion, functionalVersionFloor);
  if (floorComparison === undefined) return malformed(runningVersion, track, checkedAt);
  if (floorComparison < 0) {
    const comparison = compareStrictSemver(selectedVersion, runningVersion);
    if (comparison === undefined) return malformed(runningVersion, track, checkedAt);
    return {
      schema: UPDATE_CHECK_SCHEMA,
      track,
      status: "successor_not_ready",
      relation: comparison === 0 ? "equal" : comparison > 0 ? "selected_newer" : "selected_older",
      checked_at: checkedAt,
      running_version: runningVersion,
      ...known,
      command: null,
      verify: [],
      unavailable: null,
    };
  }
  if (selectedDeprecation.value !== null) {
    return unavailable(
      runningVersion,
      track,
      checkedAt,
      "selected_deprecated",
      `npm ${track} dist-tag selects a deprecated release`,
      known,
    );
  }

  const comparison = compareStrictSemver(selectedVersion, runningVersion);
  if (comparison === undefined || comparison === 0) return malformed(runningVersion, track, checkedAt);
  return {
    schema: UPDATE_CHECK_SCHEMA,
    track,
    status: comparison > 0 ? "upgrade_available" : "rollback_available",
    relation: comparison > 0 ? "selected_newer" : "selected_older",
    checked_at: checkedAt,
    running_version: runningVersion,
    ...known,
    command: `npm install --global ${PACKAGE_NAME}@${selectedVersion}`,
    verify: verificationCommands(track),
    unavailable: null,
  };
}

interface FetchSuccess {
  ok: true;
  packument: unknown;
}

interface FetchFailure {
  ok: false;
  unavailable: UpdateCheckUnavailable;
}

export type PackumentFetchResult = FetchSuccess | FetchFailure;

class TransportFailure extends Error {
  readonly code: UpdateUnavailableCode;

  constructor(code: UpdateUnavailableCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PackumentFetchDeps {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Fetch one bounded packument. Production has one fixed endpoint; overrides exist only for tests. */
export async function fetchSupportedReleasePackument(
  deps: PackumentFetchDeps = {},
): Promise<PackumentFetchResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const endpoint = deps.endpoint ?? UPDATE_CHECK_ENDPOINT;
  const timeoutMs = deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? UPDATE_CHECK_MAX_BYTES;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const rejectResponse = async (
    response: Response,
    code: UpdateUnavailableCode,
    message: string,
  ): Promise<never> => {
    controller.abort();
    try {
      await response.body?.cancel();
    } catch {
      // Aborting a real fetch may error the stream before explicit cancellation observes it.
    }
    throw new TransportFailure(code, message);
  };

  const request = async (): Promise<unknown> => {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: UPDATE_CHECK_ACCEPT },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return await rejectResponse(response, "http", "npm registry redirected the fixed endpoint");
    }
    if (response.status !== 200) {
      return await rejectResponse(response, "http", `npm registry returned HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
      return await rejectResponse(
        response,
        "too_large",
        `npm registry response exceeded ${maxBytes} bytes`,
      );
    }
    if (!response.body) throw new TransportFailure("malformed", "npm registry response body was empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // The abort may error the reader before explicit cancellation observes it.
        }
        throw new TransportFailure("too_large", `npm registry response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new TransportFailure("malformed", "npm registry response was not valid JSON");
    }
  };

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TransportFailure("timeout", `npm registry check exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return { ok: true, packument: await Promise.race([request(), timeout]) };
  } catch (error) {
    if (error instanceof TransportFailure) {
      return { ok: false, unavailable: { code: error.code, message: error.message } };
    }
    if (controller.signal.aborted) {
      return {
        ok: false,
        unavailable: { code: "timeout", message: `npm registry check exceeded ${timeoutMs}ms` },
      };
    }
    return {
      ok: false,
      unavailable: { code: "offline", message: "npm registry could not be reached" },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface SupportedReleaseCheckDeps extends PackumentFetchDeps {
  now?: () => Date;
  functionalVersionFloor?: string;
  updatePolicy?: { enabled: boolean };
}

/** Fetch and select the exact release named by the requested public npm track. */
export async function checkSupportedRelease(
  input: { runningVersion: string; track: ReleaseTrack },
  deps: SupportedReleaseCheckDeps = {},
): Promise<UpdateCheckResult> {
  if (!parseStrictSemver(input.runningVersion)) {
    throw new Error("running package version is not valid strict SemVer");
  }
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  if (!(deps.updatePolicy ?? bakedUpdatePolicy()).enabled) {
    return unavailable(
      input.runningVersion,
      input.track,
      checkedAt,
      "policy_disabled",
      "supported-release checks are disabled for this build target",
    );
  }
  const functionalVersionFloor = deps.functionalVersionFloor ?? bakedFunctionalVersionFloor();
  if (!functionalVersionFloor) {
    return unavailable(
      input.runningVersion,
      input.track,
      checkedAt,
      "policy_disabled",
      "supported-release policy is unavailable for this build target",
    );
  }
  const fetched = await fetchSupportedReleasePackument(deps);
  if (!fetched.ok) {
    return unavailable(
      input.runningVersion,
      input.track,
      checkedAt,
      fetched.unavailable.code,
      fetched.unavailable.message,
    );
  }
  return selectSupportedRelease({
    packument: fetched.packument,
    track: input.track,
    runningVersion: input.runningVersion,
    checkedAt,
    functionalVersionFloor,
  });
}
