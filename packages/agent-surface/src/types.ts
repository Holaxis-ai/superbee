/** Directly callable descriptors can also be registered by a separate WebMCP adapter. */
export type ToolDescriptor<Result = unknown> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input: unknown, invocation?: { signal?: AbortSignal }) => Promise<Result>;
};

export type NavigationOrigin = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  surfaceId: string;
  bindingId: string;
  contextRevision: string;
};
export type NavigationTarget =
  | { kind: "bundle"; bundleId: string }
  | { kind: "document"; bundleId: string; documentId: string }
  | { kind: "view"; bundleId: string; viewId: string }
  | { kind: "page"; pageId: string; args?: Record<string, unknown> };
export type NavigationOutcome = "offered" | "navigated" | "declined" | "stale" | "unsupported" | "cancelled";
export type NavigationRequest = NavigationOrigin & { target: NavigationTarget; expiresAt: number };
export type NavigationReceipt = NavigationOrigin & { outcome: NavigationOutcome };

/** A source reference is minted by a successful host read, never by model-generated URLs. */
export type AssistantSourceRef =
  | { sourceId: string; kind: "hosted-document"; bundleId: string; documentId: string; version: string }
  | { sourceId: string; kind: "portal-document"; bundleId: string; documentId: string; artifactDigest: string; snapshotDigest: string };

/** Additive shell envelope. Hosts validate incoming payloads before delivering them to the panel. */
export type AssistantEvent = { seq: number; at: string; type: string; payload: unknown };
export type AssistantSourceRead = { turnId: string; toolCallId: string; source: AssistantSourceRef };
