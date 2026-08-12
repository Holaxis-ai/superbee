import { describe, expect, it } from "vitest";
import { parseActionBridgeMessage } from "@superbee/view-runtime/action-bridge";

describe("trusted action bridge parser", () => {
  it("accepts the exact versioned-read and scalar-action messages", () => {
    expect(parseActionBridgeMessage({ bridge: "v1", type: "read-versioned", id: "r1", docId: "tasks/alpha" })?.ok).toBe(true);
    expect(parseActionBridgeMessage({
      bridge: "v1",
      type: "action.propose",
      requestId: "a1",
      action: { kind: "document.set-field", docId: "tasks/alpha", field: "status", value: "done", expectedVersion: "sha256:x" },
    })?.ok).toBe(true);
  });

  it("rejects extra keys, unsafe ids, non-scalars, and non-finite numbers", () => {
    const base = {
      bridge: "v1",
      type: "action.propose",
      requestId: "a1",
      action: { kind: "document.set-field", docId: "tasks/alpha", field: "status", value: "done", expectedVersion: "sha256:x" },
    };
    expect(parseActionBridgeMessage({ ...base, surprise: true })?.ok).toBe(false);
    expect(parseActionBridgeMessage({ ...base, action: { ...base.action, docId: "../secret" } })?.ok).toBe(false);
    expect(parseActionBridgeMessage({ ...base, action: { ...base.action, value: { nested: true } } })?.ok).toBe(false);
    expect(parseActionBridgeMessage({ ...base, action: { ...base.action, value: Number.NaN } })?.ok).toBe(false);
  });
});
