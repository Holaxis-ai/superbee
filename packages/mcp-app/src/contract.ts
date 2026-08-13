import type { Version } from "@superbee/core";
import type { BridgeCapability } from "@superbee/core/page";

export interface DurableShowViewInput {
  viewId: string;
}

export interface TransientShowViewInput {
  mode: "transient";
  title: string;
  html: string;
  access?: Extract<BridgeCapability, "bundle-read" | "bundle-propose">;
}

export type ShowViewInput =
  | DurableShowViewInput
  | TransientShowViewInput;

export interface DurableViewLaunchPayload {
  schemaVersion: "agentstate.durable-view-launch.v1";
  title: string;
  source: {
    viewId: string;
    entry: string;
    html: string;
    contentType: string;
    contentVersion: Version;
  };
  launch: {
    launchId: string;
    access: BridgeCapability;
    authorization: {
      required: boolean;
      authorized: boolean;
    };
  };
}

export interface TransientViewLaunchPayload {
  schemaVersion: "agentstate.transient-view-launch.v1";
  title: string;
  source: {
    kind: "transient";
    html: string;
    contentType: string;
    contentVersion: Version;
  };
  launch: {
    launchId: string;
    access: BridgeCapability;
    authorization: {
      required: boolean;
      authorized: boolean;
    };
  };
}

export type ActiveViewLaunchPayload =
  | DurableViewLaunchPayload
  | TransientViewLaunchPayload;

export type McpViewPayload = ActiveViewLaunchPayload;
