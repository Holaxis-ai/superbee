import type { BridgeCapability } from "@superbee/core/page";

export const ACTIVE_VIEW_POLICY_VERSION = "active-view-v1";
export { admitActiveView, MAX_ACTIVE_VIEW_BYTES, ACTIVE_VIEW_CONTENT_TYPE } from "@superbee/core/view-admission";

interface ActiveViewAuthorizationSubject {
  contentVersion: string;
  contentType: string;
  capability: BridgeCapability;
  execution: "active";
  policyVersion: typeof ACTIVE_VIEW_POLICY_VERSION;
}

export interface RegisteredViewAuthorizationSubject extends ActiveViewAuthorizationSubject {
  sourceKind: "registered";
  registryId: string;
}

export interface TransientViewAuthorizationSubject extends ActiveViewAuthorizationSubject {
  sourceKind: "transient";
  bundleIdentity: string;
}

export type ViewAuthorizationSubject =
  | RegisteredViewAuthorizationSubject
  | TransientViewAuthorizationSubject;

export interface ViewAuthorizationStore {
  isAuthorized(subject: ViewAuthorizationSubject): Promise<boolean>;
  authorize(subject: ViewAuthorizationSubject): Promise<void>;
}

function stableSubject(subject: ViewAuthorizationSubject): string {
  const common = {
    sourceKind: subject.sourceKind,
    contentVersion: subject.contentVersion,
    contentType: subject.contentType,
    capability: subject.capability,
    execution: subject.execution,
    policyVersion: subject.policyVersion,
  };
  return JSON.stringify(
    subject.sourceKind === "registered"
      ? { ...common, registryId: subject.registryId }
      : { ...common, bundleIdentity: subject.bundleIdentity },
  );
}

/** Process-local fallback. Product hosts may inject a persistent user-controlled store. */
export class SessionViewAuthorizationStore implements ViewAuthorizationStore {
  private readonly authorized = new Set<string>();

  async isAuthorized(subject: ViewAuthorizationSubject): Promise<boolean> {
    return this.authorized.has(stableSubject(subject));
  }

  async authorize(subject: ViewAuthorizationSubject): Promise<void> {
    this.authorized.add(stableSubject(subject));
  }
}
