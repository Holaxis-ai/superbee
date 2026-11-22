import {
  createPageActionService,
  launchIsCurrent,
  mintActiveViewLaunch,
  PageLaunchRegistry,
  pageLaunchAuthorizationSubject,
  parseDocumentSetFieldAction,
} from "@superbee/view-runtime";
import { assertActorAcceptedByBundle, resolveActor } from "./actor.js";
import { openPluginWorkspace } from "./workspace-resolver.js";

type Scalar = string | number | boolean;

export interface ViewFieldEdit {
  readonly kind: "document.set-field";
  readonly docId: string;
  readonly expectedVersion: string;
  readonly field: string;
  readonly value: Scalar;
}

export interface ViewActionOutcome {
  readonly status: "committed" | "unchanged" | "cancelled" | "conflict" | "revoked" | "expired" | "rejected" | "failed";
  readonly docId?: string;
  readonly field?: string;
  readonly version?: string;
  readonly expectedVersion?: string;
  readonly actualVersion?: string | null;
  readonly message?: string;
  readonly warnings?: readonly { code: string; message: string; severity: "warning" | "info"; field?: string }[];
}

export interface PreparedViewEdit {
  readonly status: "prepared";
  readonly approvalToken: string;
  readonly expiresAt: number;
  readonly confirmation: {
    source: { id: string; title: string; version: string; contentVersion: string };
    target: { docId: string; title: string; kind: string; version: string };
    field: string;
    storageField?: string;
    before: Scalar | null;
    after: Scalar;
    actor: string;
    timestamp: string;
  };
}

export interface RegisteredViewActions {
  readonly title: string;
  readonly html: string;
  readonly contentVersion: string;
  prepare(edit: ViewFieldEdit): Promise<PreparedViewEdit | ViewActionOutcome>;
  finish(approvalToken: string, decision: "commit" | "cancel"): Promise<ViewActionOutcome>;
  close(): void;
}

/** Open the exact registered View already approved in the user's selected workspace. */
export async function openRegisteredViewActions(
  source: "catalog" | "directory",
  selector: string,
  options: { viewId: string; actor: string },
): Promise<RegisteredViewActions> {
  const { viewId, actor } = options;
  if (typeof actor !== "string" || !actor.trim()) throw new TypeError("a View action actor is required");
  const { bundle, viewAuthorization } = await openPluginWorkspace(source, selector);
  const attribution = resolveActor(actor);
  await assertActorAcceptedByBundle(bundle, attribution);

  const launches = new PageLaunchRegistry();
  const launch = await mintActiveViewLaunch(bundle, launches, viewId);
  if (launch.capability !== "bundle-propose" || !(await viewAuthorization.isAuthorized(pageLaunchAuthorizationSubject(launch)))) {
    throw new Error("the registered View requires bundle-propose access and local approval for its current content");
  }
  if (!launches.resolveLaunch(launch.launchId) || !(await launchIsCurrent(bundle, launch))) {
    throw new Error("the registered View changed or expired while checking its approval");
  }
  const actions = createPageActionService(bundle, launches, viewAuthorization, attribution);
  const { launchId } = launch;
  return Object.freeze({
    title: launch.registryTitle,
    html: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(launch.bytes),
    contentVersion: launch.contentVersion,
    async prepare(edit: ViewFieldEdit) {
      return actions.prepare(launchId, parseDocumentSetFieldAction(edit));
    },
    async finish(token: string, decision: "commit" | "cancel") {
      if (decision === "cancel") return actions.cancel(token, launchId);
      if (decision === "commit") return actions.commit(token, launchId);
      throw new TypeError("a View action decision must be commit or cancel");
    },
    close: () => launches.revoke(launchId),
  });
}
