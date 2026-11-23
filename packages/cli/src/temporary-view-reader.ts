import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import {
  BRIDGE_HOST_CAPABILITIES, BRIDGE_SERVICE_LIMITS, BridgeService, mintTransientViewLaunch,
  PageBridgeLaunchAuthority, PageLaunchRegistry, resolvePageLaunchAuthorization, SessionViewAuthorizationStore,
} from "@superbee/view-runtime";
import { openPluginWorkspace } from "./workspace-resolver.js";

export interface TemporaryViewDocument {
  readonly id: string;
  readonly version: string;
  readonly html: string;
  readonly bounded: boolean;
}

export interface TemporaryViewReader {
  readonly workspaceName: string;
  readonly title: string;
  readonly html: string;
  readonly access: "bundle-read";
  readonly contentVersion: string;
  decide(decision: "approve" | "deny"): Promise<void>;
  renderDocument(docId: string): Promise<TemporaryViewDocument>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bind the admitted HTML, the trusted host's decision and reads to one in-memory launch. */
export async function openTemporaryViewReader(
  source: "catalog" | "directory",
  selector: string,
  input: { title: string; html: string; access: "bundle-read" },
): Promise<TemporaryViewReader> {
  const { title, html, access } = input;
  if (access !== "bundle-read") throw new TypeError("a temporary reader requires bundle-read access");
  if (typeof title !== "string" || !title.trim() || title.trim().length > 120) {
    throw new TypeError("a temporary View title must contain 1 to 120 characters");
  }
  if (typeof html !== "string" || !html.length) throw new TypeError("temporary View HTML is required");
  const { bundle, name, viewAuthorization } = await openPluginWorkspace(source, selector);
  const launches = new PageLaunchRegistry();
  const launch = mintTransientViewLaunch(bundle, launches, { title: title.trim(), html, capability: access });
  const approvals = new SessionViewAuthorizationStore();
  const bridge = new BridgeService({
    bundle,
    launches: new PageBridgeLaunchAuthority(bundle, launches, viewAuthorization, approvals),
    config: async () => ({ root: null, name, mode: "temporary-view-reader" }),
    renderDocument: renderDocumentToStaticHtml,
    host: { kind: "oss", capabilities: [BRIDGE_HOST_CAPABILITIES.renderDocument], limits: BRIDGE_SERVICE_LIMITS },
  });
  const { launchId } = launch;
  const close = () => bridge.revoke(launchId);
  return Object.freeze({
    workspaceName: name,
    title: launch.title,
    html: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(launch.bytes),
    access,
    contentVersion: launch.contentVersion,
    async decide(decision: "approve" | "deny") {
      if (decision === "deny") return close();
      if (decision !== "approve") throw new TypeError("the View decision must be approve or deny");
      const status = await resolvePageLaunchAuthorization(bundle, launches, launchId, approvals, true);
      if (!status?.authorized) throw new Error("the temporary View is closed or expired");
    },
    async renderDocument(docId: string) {
      const { reply } = await bridge.handle(launchId, { bridge: "v0", type: "render-document", id: "render", docId });
      if (isRecord(reply?.error)) {
        throw Object.assign(new Error(String(reply.error.message)), { code: reply.error.code });
      }
      const result = reply?.result;
      if (!isRecord(result) || !isRecord(result.document) || typeof result.document.id !== "string" ||
          typeof result.document.version !== "string" || typeof result.html !== "string" || typeof result.bounded !== "boolean") {
        throw new Error("the View bridge did not return a rendered document");
      }
      if (!launches.resolveLaunch(launchId)) throw Object.assign(new Error("the temporary View is closed or expired"), { code: "REVOKED" });
      return { id: result.document.id, version: result.document.version, html: result.html, bounded: result.bounded };
    },
    close,
  });
}
