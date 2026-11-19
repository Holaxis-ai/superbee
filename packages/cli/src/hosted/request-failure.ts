import { CliError } from "../errors.js";

export type RequestFailure = "dns" | "timeout" | "network" | "unreadable_token_response" | `http_${number}`;

const descriptions: Partial<Record<RequestFailure, string>> = {
  dns: "DNS lookup failed",
  timeout: "request timed out",
  network: "network request failed",
  unreadable_token_response: "issuer returned an unreadable token response",
};

export function isRequestFailure(value: unknown): value is RequestFailure {
  return typeof value === "string" && (Object.hasOwn(descriptions, value) || /^http_5\d\d$/.test(value));
}

export function networkFailure(error: unknown): "dns" | "timeout" | "network" {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || (error instanceof Error && error.name === "TimeoutError")) return "timeout";
  return "network";
}

export function requestFailureError(
  endpoint: string,
  phase: "gateway_discovery" | "issuer_discovery" | "workspace_discovery" | "device_authorization" | "device_poll" | "token_refresh",
  action: string,
  failure: RequestFailure,
  extra: Readonly<Record<string, unknown>> = {},
): CliError {
  const host = new URL(endpoint).origin;
  const description = descriptions[failure] ?? failure.replace("http_", "HTTP ");
  return new CliError("TRANSIENT", `could not ${action} at ${host} (${description})`, {
    details: { reason: "request_failed", phase, host, failure, retryable: true, ...extra },
    help: failure === "dns" || failure === "timeout" || failure === "network"
      ? `check that this environment can reach ${host}, then retry the same command`
      : "retry the same command",
  });
}
