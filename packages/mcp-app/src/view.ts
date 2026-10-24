import { createViewLaunchFence, type ViewLaunchAttempt } from "@superbee/core/view-launch-contract";
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ActionConfirmation, ActionTerminalResult } from "@superbee/view-runtime";
import {
  actionError,
  actionReply,
  parseActionBridgeMessage,
  type DocumentSetFieldAction,
} from "@superbee/view-runtime/action-bridge";
import type {
  ActiveViewLaunchPayload,
  McpViewPayload,
} from "./contract.js";
import { mayForwardDurableActivity } from "./durable-activity.js";
import {
  RecoveryGuard,
  extractClaimId,
  extractViewPayload,
  firstResultText,
  isActiveViewPayload,
} from "./result-recovery.js";
import { FrameLoadGuard } from "./frame-load-guard.js";
import {
  appendFrameSizingScript,
  clampFrameHeight,
  createFrameSizingSession,
  flexibleHostHeightLimit,
  hasFixedHostHeight,
  measureShellChromeHeight,
  readFrameSizeEvent,
  type FrameSizingSession,
} from "./frame-sizing.js";

type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;
type PrepareResult =
  | {
      status: "prepared";
      approvalToken: string;
      expiresAt: number;
      confirmation: ActionConfirmation;
    }
  | ActionTerminalResult;

const statusEl = document.getElementById("status")!;
const frame = document.getElementById("active-view") as HTMLIFrameElement;
const shell = frame.closest(".shell") as HTMLElement;
const confirmationBackdrop = document.getElementById("confirmation-backdrop")!;
const confirmationApply = document.getElementById("confirmation-apply") as HTMLButtonElement;
const confirmationCancel = document.getElementById("confirmation-cancel") as HTMLButtonElement;
const authorizationBackdrop = document.getElementById("authorization-backdrop")!;
const authorizationDescription = document.getElementById("authorization-description")!;
const authorizationApply = document.getElementById("authorization-apply") as HTMLButtonElement;
const authorizationCancel = document.getElementById("authorization-cancel") as HTMLButtonElement;
const authorizationAccess = document.getElementById("authorization-access")!;
const displayModeButton = document.getElementById("display-mode") as HTMLButtonElement;

let app: App;
let currentPayload: McpViewPayload | null = null;
type PendingAction =
  { launchId: string; approvalToken: string; requestId: string; attempt: ViewLaunchAttempt };

let pending: PendingAction | null = null;
let preparingActiveAction: { launchId: string; requestId: string; attempt: ViewLaunchAttempt } | null = null;
let finishingAction: PendingAction | null = null;
const launchFence = createViewLaunchFence();
let pollTimer: number | null = null;
let pollAcknowledgement: string | undefined;
let suspendedDurableLaunch: string | null = null;
let frameObjectUrl: string | null = null;
let frameSizingSession: FrameSizingSession | null = null;
let requestedFrameHeight: number | null = null;
let currentHostContext: HostContext | null = null;
let displayModeContextRevision = 0;
let resumingDurableLaunch: {
  launchId: string;
  attempt: ViewLaunchAttempt;
} | null = null;
const retiredDurableLaunchIds = new Set<string>();
const MAX_RETIRED_DURABLE_LAUNCH_IDS = 256;
const frameLoadGuard = new FrameLoadGuard();

const ACTIVE_VIEW_CHILD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredResult(result: CallToolResult): Record<string, unknown> | null {
  return isRecord(result.structuredContent) ? result.structuredContent : null;
}

function resultMessage(result: unknown): string {
  if (!isRecord(result) || typeof result.status !== "string") return "The action returned an invalid result.";
  if (typeof result.message === "string" && result.message) return `${result.status}: ${result.message}`;
  if (result.status === "committed") return "The confirmed change was committed.";
  if (result.status === "cancelled") return "The proposed change was cancelled.";
  if (result.status === "conflict") return "The document changed after this View loaded. Refresh before trying again.";
  return `Superbee action: ${result.status}.`;
}

function scalarLabel(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : String(value);
}

function setConfirmationField(id: string, value: unknown): void {
  document.getElementById(id)!.textContent = scalarLabel(value);
}

function closeConfirmation(): void {
  confirmationBackdrop.hidden = true;
  pending = null;
  syncDialogState();
}

function abandonPendingAction(): void {
  const abandoned = pending;
  closeConfirmation();
  if (!abandoned) return;
  void app.callServerTool({
    name: "finish_view_action",
    arguments: {
      launchId: abandoned.launchId,
      approvalToken: abandoned.approvalToken,
      decision: "cancel",
    },
  }).catch(() => {});
}

function abandonActionOperations(): void {
  abandonPendingAction();
  preparingActiveAction = null;
  finishingAction = null;
}

function stopPolling(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
  pollAcknowledgement = undefined;
}

function closeAuthorization(): void {
  authorizationBackdrop.hidden = true;
  authorizationApply.disabled = true;
  authorizationCancel.disabled = false;
  syncDialogState();
}

function rememberRetiredDurableLaunch(launchId: string): void {
  if (retiredDurableLaunchIds.has(launchId)) return;
  while (
    retiredDurableLaunchIds.size >= MAX_RETIRED_DURABLE_LAUNCH_IDS
  ) {
    const oldest = retiredDurableLaunchIds.values().next().value as
      | string
      | undefined;
    if (!oldest) break;
    retiredDurableLaunchIds.delete(oldest);
  }
  retiredDurableLaunchIds.add(launchId);
}

async function closeDurableLaunch(launchId: string): Promise<void> {
  rememberRetiredDurableLaunch(launchId);
  await app.callServerTool({
    name: "close_durable_view",
    arguments: { launchId },
  });
}

function closeDurableLaunchEventually(launchId: string): void {
  void closeDurableLaunch(launchId).catch(() => {});
}

function resetFrameSizing(): void {
  frameSizingSession = null;
  requestedFrameHeight = null;
  frame.style.removeProperty("height");
}

function setFrameDocument(
  html: string,
  sizing: FrameSizingSession,
  contentType = "text/html; charset=utf-8",
): void {
  resetFrameSizing();
  frameSizingSession = sizing;
  if (frameObjectUrl) URL.revokeObjectURL(frameObjectUrl);
  frameObjectUrl = URL.createObjectURL(new Blob([html], { type: contentType }));
  frame.removeAttribute("srcdoc");
  frameLoadGuard.expectNext();
  frame.src = frameObjectUrl;
}

function clearFrameDocument(): void {
  frameLoadGuard.reset();
  resetFrameSizing();
  frame.removeAttribute("srcdoc");
  frame.removeAttribute("src");
  if (frameObjectUrl) URL.revokeObjectURL(frameObjectUrl);
  frameObjectUrl = null;
}

function retirePayload(closeDurable = true): void {
  const previous = currentPayload;
  const current = launchFence.current();
  if (current) launchFence.retire(current);
  stopPolling();
  closeAuthorization();
  abandonActionOperations();
  suspendedDurableLaunch = null;
  resumingDurableLaunch = null;
  currentPayload = null;
  syncDisplayModeButton();
  clearFrameDocument();
  frame.setAttribute("sandbox", "");
  frame.removeAttribute("csp");
  if (
    closeDurable &&
    isActiveViewPayload(previous)
  ) {
    closeDurableLaunchEventually(previous.launch.launchId);
  }
}

function openConfirmation(
  action: PendingAction,
  confirmation: ActionConfirmation,
): void {
  pending = action;
  setConfirmationField("confirmation-document", `${confirmation.target.title} (${confirmation.target.docId})`);
  setConfirmationField("confirmation-kind", confirmation.target.kind);
  setConfirmationField("confirmation-field", confirmation.field);
  setConfirmationField("confirmation-before", confirmation.before);
  setConfirmationField("confirmation-after", confirmation.after);
  setConfirmationField("confirmation-actor", confirmation.actor);
  confirmationApply.disabled = true;
  confirmationBackdrop.hidden = false;
  syncDialogState();
  window.setTimeout(() => {
    if (launchFence.isCurrent(action.attempt) && pending?.approvalToken === action.approvalToken) confirmationApply.disabled = false;
  }, 350);
}

function renderDurablePayload(payload: ActiveViewLaunchPayload): void {
  const previous = currentPayload;
  const sameLaunch =
    isActiveViewPayload(previous) &&
    previous.launch.launchId === payload.launch.launchId;
  const attempt = launchFence.begin(payload.launch.launchId);
  abandonActionOperations();
  stopPolling();
  closeAuthorization();
  suspendedDurableLaunch = null;
  resumingDurableLaunch = null;
  currentPayload = payload;
  if (
    isActiveViewPayload(previous) &&
    !sameLaunch
  ) {
    closeDurableLaunchEventually(previous.launch.launchId);
  }
  frame.title = payload.title;
  if (!payload.launch.authorization.authorized) {
    clearFrameDocument();
    frame.setAttribute("sandbox", "");
    frame.removeAttribute("csp");
    statusEl.dataset.kind = "ready";
    statusEl.textContent = `Waiting for local approval of "${payload.title}"…`;
    authorizationDescription.textContent =
      `${payload.schemaVersion === "agentstate.durable-view-launch.v1"
        ? "This registered View comes from the bundle and contains executable HTML."
        : "This View contains agent-authored HTML created for this MCP session. It is process-local and is not a registered bundle View."} ` +
      `${payload.launch.access === "bundle-propose"
        ? "Approving trusts these exact bytes to read bundle data and propose version-guarded changes that still require a separate human confirmation."
        : "Approving trusts these exact bytes to read bundle data."} ` +
      "Continue only if you trust the View and its author; browser containment is additional protection, not a substitute for that trust.";
    setConfirmationField(
      "authorization-view",
      payload.schemaVersion === "agentstate.durable-view-launch.v1"
        ? payload.source.viewId
        : "Transient process-local View",
    );
    setConfirmationField("authorization-version", payload.source.contentVersion);
    authorizationAccess.textContent = payload.launch.access;
    authorizationBackdrop.hidden = false;
    syncDialogState();
    window.setTimeout(() => {
      if (
        launchFence.isCurrent(attempt) &&
        isActiveViewPayload(currentPayload) &&
        currentPayload.launch.launchId === payload.launch.launchId &&
        !currentPayload.launch.authorization.authorized
      ) {
        authorizationApply.disabled = false;
      }
    }, 500);
    return;
  }
  statusEl.dataset.kind = "ready";
  statusEl.textContent = `${payload.title} · exact ${payload.schemaVersion === "agentstate.durable-view-launch.v1" ? "registered" : "transient"} View · live ${payload.launch.access} bridge`;
  if (document.visibilityState !== "visible") {
    clearFrameDocument();
    frame.setAttribute("sandbox", "");
    frame.removeAttribute("csp");
    suspendedDurableLaunch = payload.launch.launchId;
    statusEl.textContent = `${payload.title} · paused while hidden`;
    return;
  }
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("csp", ACTIVE_VIEW_CHILD_CSP);
  const sizing = createFrameSizingSession(payload.launch.launchId, attempt.generation);
  setFrameDocument(
    appendFrameSizingScript(payload.source.html, sizing),
    sizing,
    payload.source.contentType,
  );
}

function renderPayload(payload: McpViewPayload): void {
  renderDurablePayload(payload);
  syncDisplayModeButton();
}

const recoveryGuard = new RecoveryGuard();

function renderResult(result: CallToolResult): void {
  const payload = extractViewPayload(result);
  if (payload) {
    if (
      isActiveViewPayload(payload) &&
      (retiredDurableLaunchIds.has(payload.launch.launchId) ||
        (isActiveViewPayload(currentPayload) &&
          currentPayload.launch.launchId === payload.launch.launchId))
    ) {
      return;
    }
    renderPayload(payload);
    return;
  }
  if (currentPayload) return;
  if (result.isError === true) {
    statusEl.dataset.kind = "error";
    statusEl.textContent =
      firstResultText(result) ?? "The Superbee server reported an error for this View.";
    clearFrameDocument();
    return;
  }
  void recoverPayload(result);
}

// Probe-established (tasks/mcp-shell-payload-without-structuredcontent): some hosts rebuild
// tool-result notifications with prose only, stripping structuredContent while PRESERVING text —
// and proxy the App's own tools/call requests faithfully. The delivered text carries an exact
// one-shot claim marker; redeem it over the app channel. No marker means fail closed: guessing
// (e.g. most-recent fallback) could hand this panel another launch's payload.
async function recoverPayload(result: CallToolResult): Promise<void> {
  const claim = extractClaimId(result);
  if (!claim) {
    reportUndeliveredPayload("the delivered result carried no claim marker");
    return;
  }
  if (!recoveryGuard.tryAcquire()) {
    reportUndeliveredPayload(null);
    return;
  }
  statusEl.dataset.kind = "ready";
  statusEl.textContent = "Recovering the View payload over the app channel…";
  const attempt = launchFence.begin(claim);
  try {
    const response = await app.callServerTool({
      name: "resolve_launch",
      arguments: { claim },
    });
    if (!launchFence.isCurrent(attempt)) return;
    const payload = extractViewPayload(response);
    if (payload) {
      renderPayload(payload);
      return;
    }
    reportUndeliveredPayload(firstResultText(response));
  } catch (error) {
    if (!launchFence.isCurrent(attempt)) return;
    reportUndeliveredPayload(error instanceof Error ? error.message : String(error));
  }
}

function reportUndeliveredPayload(detail: string | null): void {
  if (currentPayload) return;
  statusEl.dataset.kind = "error";
  statusEl.textContent = detail
    ? `This host delivered the tool result without its structured View payload, and recovery failed: ${detail}`
    : "This host delivered the tool result without its structured View payload, and recovery over the app channel was unavailable.";
  clearFrameDocument();
}

function durablePayloadFor(
  launchId: string,
  attempt: ViewLaunchAttempt,
): ActiveViewLaunchPayload | null {
  const payload = currentPayload;
  return (
    mayForwardDurableActivity({
      fence: launchFence,
      attempt,
      visibilityState: document.visibilityState,
      suspendedLaunchId: suspendedDurableLaunch,
    }) &&
    isActiveViewPayload(payload) &&
    payload.launch.launchId === launchId &&
    payload.launch.authorization.authorized
  )
    ? payload
    : null;
}

function scheduleDurablePoll(launchId: string, attempt: ViewLaunchAttempt): void {
  if (!durablePayloadFor(launchId, attempt) || pollTimer !== null) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void pollDurableView(launchId, attempt);
  }, 1_000);
}

async function pollDurableView(launchId: string, attempt: ViewLaunchAttempt): Promise<void> {
  if (!durablePayloadFor(launchId, attempt)) return;
  try {
    const response = await app.callServerTool({
      name: "poll_durable_view",
      arguments: {
        launchId,
        ...(pollAcknowledgement
          ? { acknowledgeGeneration: pollAcknowledgement }
          : {}),
      },
    });
    if (!durablePayloadFor(launchId, attempt)) return;
    const poll = structuredResult(response)?.poll;
    if (!isRecord(poll) || typeof poll.status !== "string") {
      throw new Error("The durable View poll returned an invalid result.");
    }
    pollAcknowledgement = undefined;
    if (poll.status === "change") {
      if (
        typeof poll.generation !== "string" ||
        !isRecord(poll.message)
      ) {
        throw new Error("The durable View poll returned an invalid change.");
      }
      frame.contentWindow?.postMessage(poll.message, "*");
      pollAcknowledgement = poll.generation;
    } else if (poll.status === "reload-required") {
      const message =
        typeof poll.message === "string"
          ? poll.message
          : "the durable View lost continuity";
      retirePayload();
      statusEl.dataset.kind = "error";
      statusEl.textContent = `Reopen this View: ${message}`;
      return;
    } else if (poll.status !== "unchanged") {
      throw new Error(`Unsupported durable View poll status '${poll.status}'.`);
    }
    scheduleDurablePoll(launchId, attempt);
  } catch (error) {
    if (!durablePayloadFor(launchId, attempt)) return;
    retirePayload();
    statusEl.dataset.kind = "error";
    statusEl.textContent = `Reopen this View: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function bridgeError(request: unknown, message: string): Record<string, unknown> | null {
  if (!isRecord(request) || typeof request.id !== "string") return null;
  return {
    bridge: typeof request.bridge === "string" ? request.bridge : "v0",
    id: request.id,
    type: "error",
    error: { code: "UNSUPPORTED", message },
  };
}

async function forwardDurableBridgeMessage(
  launchId: string,
  attempt: ViewLaunchAttempt,
  request: unknown,
): Promise<void> {
  try {
    const response = await app.callServerTool({
      name: "durable_view_bridge",
      arguments: { launchId, request },
    });
    const structured = structuredResult(response);
    const outcome = structured?.outcome;
    if (!isRecord(outcome)) throw new Error("The durable View bridge returned an invalid outcome.");
    if (outcome.openPageId !== undefined) {
      const navigation = structured?.navigation;
      const target = isRecord(navigation) && navigation.status === "opened"
        ? navigation.view
        : null;
      if (!durablePayloadFor(launchId, attempt)) {
        if (
          isActiveViewPayload(target) &&
          (!isActiveViewPayload(currentPayload) ||
            currentPayload.launch.launchId !== target.launch.launchId)
        ) {
          closeDurableLaunchEventually(target.launch.launchId);
        }
        return;
      }
      // The server has already consumed and revoked the source launch before resolving the target.
      // Retire the local source generation without issuing a competing close, then admit only the
      // fresh registered payload returned through trusted shell transport.
      retirePayload(false);
      if (isActiveViewPayload(target)) {
        renderDurablePayload(target);
        return;
      }
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        `Could not open the registered View: ${
          isRecord(navigation) && typeof navigation.message === "string"
            ? navigation.message
            : "the MCP host returned no valid target launch"
        }`;
      return;
    }
    if (!durablePayloadFor(launchId, attempt)) return;
    if (isRecord(outcome.reply)) {
      frame.contentWindow?.postMessage(outcome.reply, "*");
    }
    if (outcome.subscribed === true) scheduleDurablePoll(launchId, attempt);
  } catch (error) {
    if (!durablePayloadFor(launchId, attempt)) return;
    const reply = bridgeError(
      request,
      error instanceof Error ? error.message : String(error),
    );
    if (reply) frame.contentWindow?.postMessage(reply, "*");
  }
}

function postActiveActionResult(
  launchId: string,
  attempt: ViewLaunchAttempt,
  requestId: string,
  result: unknown,
): void {
  if (!durablePayloadFor(launchId, attempt)) return;
  frame.contentWindow?.postMessage(actionReply(requestId, result), "*");
}

async function prepareActiveAction(
  launchId: string,
  attempt: ViewLaunchAttempt,
  requestId: string,
  action: DocumentSetFieldAction,
): Promise<void> {
  if (pending || preparingActiveAction || finishingAction) {
    postActiveActionResult(launchId, attempt, requestId, {
      status: "rejected",
      action: "document.set-field",
      message: "this View already has an action proposal in progress",
    });
    return;
  }
  const reservation = { launchId, attempt, requestId };
  preparingActiveAction = reservation;
  statusEl.dataset.kind = "working";
  statusEl.textContent = "Preparing the exact change for confirmation…";
  try {
    const response = await app.callServerTool({
      name: "prepare_view_action",
      arguments: { launchId, requestId, action },
    });
    const result = structuredResult(response)?.result as PrepareResult | undefined;
    if (!durablePayloadFor(launchId, attempt)) {
      if (result?.status === "prepared") {
        void app.callServerTool({
          name: "finish_view_action",
          arguments: {
            launchId,
            approvalToken: result.approvalToken,
            decision: "cancel",
          },
        }).catch(() => {});
      }
      return;
    }
    if (result?.status === "prepared") {
      openConfirmation(
        {
          launchId,
          approvalToken: result.approvalToken,
          requestId,
          attempt,
        },
        result.confirmation,
      );
      statusEl.dataset.kind = "ready";
      statusEl.textContent = "Review the trusted Superbee confirmation.";
      return;
    }
    statusEl.dataset.kind = result?.status === "conflict" ? "error" : "ready";
    statusEl.textContent = resultMessage(result);
    postActiveActionResult(launchId, attempt, requestId, result ?? {
      status: "failed",
      action: "document.set-field",
      message: "the action service returned an invalid result",
    });
  } catch (error) {
    const result = {
      status: "failed",
      action: "document.set-field",
      message: error instanceof Error ? error.message : String(error),
    };
    if (durablePayloadFor(launchId, attempt)) {
      statusEl.dataset.kind = "error";
      statusEl.textContent = result.message;
      postActiveActionResult(launchId, attempt, requestId, result);
    }
  } finally {
    if (preparingActiveAction === reservation) preparingActiveAction = null;
  }
}

async function authorizeDurableView(): Promise<void> {
  const payload = currentPayload;
  if (
    !isActiveViewPayload(payload) ||
    payload.launch.authorization.authorized ||
    authorizationApply.disabled
  ) {
    return;
  }
  const launchId = payload.launch.launchId;
  const attempt = launchFence.current();
  if (!attempt) return;
  authorizationApply.disabled = true;
  authorizationCancel.disabled = true;
  statusEl.dataset.kind = "working";
  statusEl.textContent = "Verifying and recording approval for these exact View bytes…";
  try {
    const response = await app.callServerTool({
      name: "authorize_durable_view",
      arguments: { launchId },
    });
    if (!launchFence.isCurrent(attempt)) return;
    const view = structuredResult(response)?.view;
    if (!isActiveViewPayload(view) || view.launch.launchId !== launchId) {
      throw new Error("The active View changed or returned an invalid approved launch.");
    }
    renderDurablePayload(view);
  } catch (error) {
    if (!launchFence.isCurrent(attempt)) return;
    retirePayload();
    statusEl.dataset.kind = "error";
    statusEl.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    if (launchFence.isCurrent(attempt)) authorizationCancel.disabled = false;
  }
}

function cancelDurableAuthorization(): void {
  const payload = currentPayload;
  if (!isActiveViewPayload(payload)) return;
  retirePayload();
  statusEl.dataset.kind = "ready";
  statusEl.textContent = "The active View was not authorized.";
}

async function finishAction(decision: "commit" | "cancel"): Promise<void> {
  const selected = pending;
  if (!selected) return;
  finishingAction = selected;
  pending = null;
  confirmationApply.disabled = true;
  confirmationCancel.disabled = true;
  closeConfirmation();
  try {
    const response = await app.callServerTool({
      name: "finish_view_action",
      arguments: {
        launchId: selected.launchId,
        approvalToken: selected.approvalToken,
        decision,
      },
    });
    const structured = structuredResult(response);
    const stillCurrent = finishingAction === selected &&
      durablePayloadFor(selected.launchId, selected.attempt) !== null;
    if (stillCurrent) {
      statusEl.dataset.kind =
        isRecord(structured?.result) && structured.result.status === "conflict" ? "error" : "ready";
      statusEl.textContent = resultMessage(structured?.result);
    }
    if (stillCurrent) {
      postActiveActionResult(
        selected.launchId,
        selected.attempt,
        selected.requestId,
        structured?.result ?? {
          status: "failed",
          action: "document.set-field",
          message: "the action service returned an invalid result",
        },
      );
    }
  } catch (error) {
    const stillCurrent = finishingAction === selected &&
      durablePayloadFor(selected.launchId, selected.attempt) !== null;
    if (stillCurrent) {
      statusEl.dataset.kind = "error";
      statusEl.textContent = error instanceof Error ? error.message : String(error);
    }
    if (stillCurrent) {
      postActiveActionResult(selected.launchId, selected.attempt, selected.requestId, {
        status: "failed",
        action: "document.set-field",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    if (launchFence.isCurrent(selected.attempt)) {
      confirmationApply.disabled = false;
      confirmationCancel.disabled = false;
    }
    if (finishingAction === selected) {
      finishingAction = null;
      closeConfirmation();
    }
  }
}

function applyHostContext(context: HostContext): void {
  if (Object.hasOwn(context, "displayMode")) {
    displayModeContextRevision++;
  }
  currentHostContext = { ...(currentHostContext ?? {}), ...context };
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  document.documentElement.toggleAttribute(
    "data-fixed-height",
    hasFixedHostHeight(currentHostContext.containerDimensions),
  );
  applyRequestedFrameHeight();
  syncDisplayModeButton();
}

function syncDialogState(): void {
  const open = !confirmationBackdrop.hidden || !authorizationBackdrop.hidden;
  document.body.toggleAttribute("data-dialog-open", open);
  if (!open) applyRequestedFrameHeight();
}

function shellChromeHeight(): number {
  return measureShellChromeHeight(
    shell.getBoundingClientRect().height,
    frame.getBoundingClientRect().height,
  );
}

function applyRequestedFrameHeight(): void {
  if (hasFixedHostHeight(currentHostContext?.containerDimensions)) {
    frame.style.removeProperty("height");
    return;
  }
  if (
    requestedFrameHeight === null ||
    document.body.hasAttribute("data-dialog-open")
  ) {
    return;
  }
  const chromeHeight = shellChromeHeight();
  const height = clampFrameHeight(requestedFrameHeight, {
    hostHeightLimit: flexibleHostHeightLimit(
      currentHostContext?.containerDimensions,
    ),
    shellChromeHeight: chromeHeight,
  });
  if (frame.style.height !== `${height}px`) {
    frame.style.height = `${height}px`;
  }
}

function requestedDisplayMode(): "inline" | "fullscreen" | null {
  if (!currentPayload) return null;
  const current = currentHostContext?.displayMode ?? "inline";
  const target = current === "fullscreen" ? "inline" : "fullscreen";
  return currentHostContext?.availableDisplayModes?.includes(target)
    ? target
    : null;
}

function syncDisplayModeButton(): void {
  const target = requestedDisplayMode();
  displayModeButton.hidden = target === null;
  if (target) {
    displayModeButton.textContent =
      target === "fullscreen" ? "Expand" : "Return inline";
  }
}

async function changeDisplayMode(): Promise<void> {
  const target = requestedDisplayMode();
  if (!target) return;
  const contextRevision = displayModeContextRevision;
  displayModeButton.disabled = true;
  try {
    const result = await app.requestDisplayMode({ mode: target });
    if (
      currentHostContext &&
      displayModeContextRevision === contextRevision
    ) {
      currentHostContext = {
        ...currentHostContext,
        displayMode: result.mode,
      };
    }
    syncDisplayModeButton();
  } catch (error) {
    const supersededByHostContext =
      displayModeContextRevision !== contextRevision &&
      currentHostContext?.displayMode === target;
    if (!supersededByHostContext) {
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        error instanceof Error
          ? `This host could not change the View display mode: ${error.message}`
          : "This host could not change the View display mode.";
    }
  } finally {
    displayModeButton.disabled = false;
  }
}

function currentSuspendedDurablePayload(
  launchId: string,
  attempt: ViewLaunchAttempt,
): ActiveViewLaunchPayload | null {
  const payload = currentPayload;
  return (
    document.visibilityState === "visible" &&
    launchFence.isCurrent(attempt) &&
    suspendedDurableLaunch === launchId &&
    isActiveViewPayload(payload) &&
    payload.launch.launchId === launchId &&
    payload.launch.authorization.authorized
  )
    ? payload
    : null;
}

function resumeSuspendedDurableView(): void {
  const payload = currentPayload;
  const launchId = suspendedDurableLaunch;
  if (
    document.visibilityState !== "visible" ||
    resumingDurableLaunch !== null ||
    !isActiveViewPayload(payload) ||
    !payload.launch.authorization.authorized ||
    launchId !== payload.launch.launchId
  ) {
    return;
  }
  const attempt = launchFence.current();
  if (!attempt) return;
  const operation = { launchId, attempt };
  resumingDurableLaunch = operation;
  void (async () => {
    try {
      const response = await app.callServerTool({
        name: "resume_durable_view",
        arguments: { launchId },
      });
      const resumed = structuredResult(response)?.view;
      if (
        !isActiveViewPayload(resumed) ||
        resumed.launch.launchId === launchId ||
        resumed.schemaVersion !== payload.schemaVersion ||
        resumed.source.contentVersion !== payload.source.contentVersion ||
        (resumed.schemaVersion === "agentstate.durable-view-launch.v1" &&
          payload.schemaVersion === "agentstate.durable-view-launch.v1" &&
          resumed.source.viewId !== payload.source.viewId)
      ) {
        throw new Error(
          firstResultText(response) ??
            "The durable View resume returned an invalid replacement.",
        );
      }
      if (!currentSuspendedDurablePayload(launchId, operation.attempt)) {
        closeDurableLaunchEventually(resumed.launch.launchId);
        return;
      }
      renderDurablePayload(resumed);
    } catch (error) {
      if (currentSuspendedDurablePayload(launchId, operation.attempt)) {
        retirePayload();
        statusEl.dataset.kind = "error";
        statusEl.textContent = `Reopen this View: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      if (resumingDurableLaunch === operation) {
        resumingDurableLaunch = null;
      }
      if (
        document.visibilityState === "visible" &&
        suspendedDurableLaunch !== null &&
        resumingDurableLaunch === null
      ) {
        window.queueMicrotask(resumeSuspendedDurableView);
      }
    }
  })();
}

confirmationApply.addEventListener("click", () => void finishAction("commit"));
confirmationCancel.addEventListener("click", () => void finishAction("cancel"));
authorizationApply.addEventListener("click", () => void authorizeDurableView());
authorizationCancel.addEventListener("click", cancelDurableAuthorization);
displayModeButton.addEventListener("click", () => void changeDisplayMode());

frame.addEventListener("load", () => {
  if (frameLoadGuard.accept()) return;
  const payload = currentPayload;
  if (
    !isActiveViewPayload(payload) ||
    !payload.launch.authorization.authorized
  ) {
    return;
  }
  retirePayload();
  statusEl.dataset.kind = "error";
  statusEl.textContent =
    "This View navigated away from its approved document, so Superbee closed the launch. Reopen it to continue.";
});

window.addEventListener("message", (event) => {
  const payload = currentPayload;
  const attempt = launchFence.current();
  if (!payload || !attempt) return;
  if (frameSizingSession) {
    const sizing = readFrameSizeEvent(
      event.data,
      event.source,
      frame.contentWindow,
      frameSizingSession,
      attempt.generation,
    );
    if (sizing.kind !== "other") {
      if (sizing.kind === "accepted") {
        requestedFrameHeight = sizing.height;
        applyRequestedFrameHeight();
      }
      return;
    }
  }
  if (
    document.visibilityState === "hidden" ||
    event.source !== frame.contentWindow ||
    !isActiveViewPayload(payload) ||
    !payload.launch.authorization.authorized
  ) {
    return;
  }
  const actionMessage = parseActionBridgeMessage(event.data);
  if (actionMessage !== null) {
    if (!actionMessage.ok) {
      const raw = event.data as { id?: unknown; requestId?: unknown };
      if (typeof raw.requestId === "string") {
        postActiveActionResult(payload.launch.launchId, attempt, raw.requestId, {
          status: "rejected",
          action: "document.set-field",
          message: actionMessage.message,
        });
      } else if (typeof raw.id === "string") {
        frame.contentWindow?.postMessage(actionError(raw.id, actionMessage.message), "*");
      }
      return;
    }
    if (actionMessage.message.type === "action.propose") {
      if (actionMessage.message.action.kind !== "document.set-field") {
        postActiveActionResult(payload.launch.launchId, attempt, actionMessage.message.requestId, { status: "rejected", action: actionMessage.message.action.kind, message: "this host supports scalar actions only" });
        return;
      }
      void prepareActiveAction(
        payload.launch.launchId,
        attempt,
        actionMessage.message.requestId,
        actionMessage.message.action,
      );
      return;
    }
  }
  void forwardDurableBridgeMessage(
    payload.launch.launchId,
    attempt,
    event.data,
  );
});

document.addEventListener("visibilitychange", () => {
  const payload = currentPayload;
  if (
    document.visibilityState === "hidden" &&
    isActiveViewPayload(payload) &&
    payload.launch.authorization.authorized
  ) {
    abandonActionOperations();
    suspendedDurableLaunch = payload.launch.launchId;
    launchFence.begin(payload.launch.launchId);
    resetFrameSizing();
    stopPolling();
    return;
  }
  if (
    document.visibilityState === "visible" &&
    isActiveViewPayload(payload) &&
    suspendedDurableLaunch === payload.launch.launchId
  ) {
    resumeSuspendedDurableView();
  }
});

void (async () => {
  app = new App(
    { name: "Superbee View Host", version: "0.0.1" },
    { availableDisplayModes: ["inline", "fullscreen"] },
  );
  app.ontoolresult = renderResult;
  app.onhostcontextchanged = applyHostContext;
  app.onteardown = async () => {
    closeConfirmation();
    const launchId =
      isActiveViewPayload(currentPayload)
        ? currentPayload.launch.launchId
        : null;
    retirePayload(false);
    if (launchId) {
      await closeDurableLaunch(launchId).catch(() => {});
    }
    return {};
  };
  await app.connect();
  const context = app.getHostContext();
  if (context) applyHostContext(context);
})();
