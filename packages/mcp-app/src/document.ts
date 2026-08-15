import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  parseDocumentPresentationPayload,
  type DocumentPresentationPayload,
} from "./document-contract.js";
import {
  RecoveryGuard,
  extractClaimId,
  firstResultText,
} from "./result-recovery.js";

type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

const header = document.getElementById("header")!;
const title = document.getElementById("title")!;
const documentId = document.getElementById("document-id")!;
const documentType = document.getElementById("document-type")!;
const documentVersion = document.getElementById("document-version")!;
const documentBody = document.getElementById("document")!;
const bounded = document.getElementById("bounded")!;
const error = document.getElementById("error")!;
const displayModeButton = document.getElementById("display-mode") as HTMLButtonElement;

let app: App;
let hostContext: HostContext | null = null;
let hasDocument = false;
const recoveryGuard = new RecoveryGuard();

function applyHostContext(context: HostContext): void {
  hostContext = { ...(hostContext ?? {}), ...context };
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  syncDisplayModeButton();
}

function requestedDisplayMode(): "inline" | "fullscreen" | null {
  if (!hasDocument) return null;
  const current = hostContext?.displayMode ?? "inline";
  const target = current === "fullscreen" ? "inline" : "fullscreen";
  return hostContext?.availableDisplayModes?.includes(target) ? target : null;
}

function syncDisplayModeButton(): void {
  const target = requestedDisplayMode();
  displayModeButton.hidden = target === null;
  if (target) displayModeButton.textContent = target === "fullscreen" ? "Expand" : "Return inline";
}

async function changeDisplayMode(): Promise<void> {
  const target = requestedDisplayMode();
  if (!target) return;
  displayModeButton.disabled = true;
  try {
    const result = await app.requestDisplayMode({ mode: target });
    hostContext = { ...(hostContext ?? {}), displayMode: result.mode };
  } finally {
    displayModeButton.disabled = false;
    syncDisplayModeButton();
  }
}

function reportError(message: string): void {
  hasDocument = false;
  header.hidden = true;
  bounded.hidden = true;
  documentBody.hidden = true;
  documentBody.replaceChildren();
  error.hidden = false;
  error.textContent = message;
  syncDisplayModeButton();
}

function renderPayload(payload: DocumentPresentationPayload): void {
  const presented = payload.document;
  title.textContent = presented.title;
  documentId.textContent = presented.id;
  documentType.textContent = presented.type ?? "Document";
  documentVersion.textContent = presented.version;
  // This HTML is produced only by Superbee's bounded inert Markdown renderer. The payload parser
  // prevents arbitrary result shapes from reaching this sink; the resource CSP forbids scripts,
  // network access, forms, frames, workers, and base-URI changes.
  documentBody.innerHTML = presented.html;
  bounded.hidden = !presented.bounded;
  error.hidden = true;
  header.hidden = false;
  documentBody.hidden = false;
  hasDocument = true;
  syncDisplayModeButton();
}

function renderResult(result: CallToolResult): void {
  const payload = parseDocumentPresentationPayload(result.structuredContent);
  if (payload) {
    renderPayload(payload);
    return;
  }
  if (result.isError === true) {
    reportError(firstResultText(result) ?? "The Superbee server could not display this document.");
    return;
  }
  void recoverPayload(result);
}

async function recoverPayload(result: CallToolResult): Promise<void> {
  const claim = extractClaimId(result);
  if (!claim || !recoveryGuard.tryAcquire()) {
    reportError("This host did not deliver the structured document payload, and recovery was unavailable.");
    return;
  }
  try {
    const response = await app.callServerTool({
      name: "resolve_document",
      arguments: { claim },
    });
    const payload = parseDocumentPresentationPayload(response.structuredContent);
    if (payload) {
      renderPayload(payload);
      return;
    }
    reportError(
      firstResultText(response) ?? "The host could not recover the document payload.",
    );
  } catch (cause) {
    reportError(cause instanceof Error ? cause.message : String(cause));
  }
}

displayModeButton.addEventListener("click", () => void changeDisplayMode());

void (async () => {
  app = new App(
    { name: "Superbee Document Reader", version: "0.0.1" },
    { availableDisplayModes: ["inline", "fullscreen"] },
  );
  app.ontoolresult = renderResult;
  app.onhostcontextchanged = applyHostContext;
  await app.connect();
  const context = app.getHostContext();
  if (context) applyHostContext(context);
})();
