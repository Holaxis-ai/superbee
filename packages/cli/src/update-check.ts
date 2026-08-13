export const UPDATE_CHECK_SCHEMA = "superbee.update-check.v1";
export const UPDATE_CHECK_ENDPOINT = "https://registry.npmjs.org/superbee";
export const UPDATE_CHECK_ACCEPT = "application/vnd.npm.install-v1+json";
export const UPDATE_CHECK_TIMEOUT_MS = 2_000;
export const UPDATE_CHECK_MAX_BYTES = 1_048_576;

const PACKAGE_NAME = "superbee";
const MAX_METADATA_LENGTH = 4_096;
const MAX_SEMVER_LENGTH = 256;

export type ReleaseTrack = "latest" | "next";
export type UpdateCheckStatus =
  | "unavailable"
  | "deprecated"
  | "current"
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
  | "selected_deprecated";

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

interface ParsedSemver {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[] | null;
}

const STRICT_SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseStrictSemver(value: string): ParsedSemver | undefined {
  if (value.length > MAX_SEMVER_LENGTH) return undefined;
  const match = STRICT_SEMVER.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    return undefined;
  }
  return { major: match[1]!, minor: match[2]!, patch: match[3]!, prerelease };
}

function compareNumericIdentifiers(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Compare strict SemVer precedence. Build metadata is intentionally ignored. */
export function compareStrictSemver(left: string, right: string): -1 | 0 | 1 | undefined {
  const a = parseStrictSemver(left);
  const b = parseStrictSemver(right);
  if (!a || !b) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    const compared = compareNumericIdentifiers(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const leftPart = a.prerelease[i];
    const rightPart = b.prerelease[i];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
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
}): UpdateCheckResult {
  const { packument, track, runningVersion, checkedAt } = input;
  if (!parseStrictSemver(runningVersion)) {
    throw new Error("running package version is not valid strict SemVer");
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
  if (selectedDeprecation.value !== null && selectedVersion !== runningVersion) {
    return unavailable(
      runningVersion,
      track,
      checkedAt,
      "selected_deprecated",
      `npm ${track} dist-tag selects a deprecated release`,
      known,
    );
  }
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
}

/** Fetch and select the exact release named by the requested public npm track. */
export async function checkSupportedRelease(
  input: { runningVersion: string; track: ReleaseTrack },
  deps: SupportedReleaseCheckDeps = {},
): Promise<UpdateCheckResult> {
  if (!parseStrictSemver(input.runningVersion)) {
    throw new Error("running package version is not valid strict SemVer");
  }
  const fetched = await fetchSupportedReleasePackument(deps);
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
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
  });
}
