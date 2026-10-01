import type { AssistantEvent, AssistantSourceRef, NavigationOutcome, NavigationRequest } from "./types.js";

/** Host context is orientation only; the server establishes source authority itself. */
export type AssistantPanelContext = {
  bundleId: string;
  surfaceId: string;
  bindingId: string;
  contextRevision: string;
  documentId?: string;
  documentVersion?: string;
  label: string;
};
export type AssistantPanelSession = { sessionId: string; status: string };
export type AssistantPanelTransport = {
  start(context: AssistantPanelContext, signal: AbortSignal): Promise<AssistantPanelSession>;
  send(sessionId: string, text: string, context: AssistantPanelContext, signal: AbortSignal): Promise<{ turnId: string }>;
  steer(sessionId: string, turnId: string, text: string, context: AssistantPanelContext, signal: AbortSignal): Promise<{ turnId: string }>;
  cancel(sessionId: string, turnId: string, signal: AbortSignal): Promise<void>;
  events(sessionId: string, after: number, signal: AbortSignal, receive: (event: AssistantEvent) => void): Promise<void>;
  receipt(request: NavigationRequest, outcome: NavigationOutcome, signal: AbortSignal): Promise<void>;
};
export type AssistantPanelOptions = {
  root: HTMLElement;
  context: () => AssistantPanelContext | undefined;
  transport: AssistantPanelTransport;
  /** Host-owned routing, admission, preference, and draft protection. */
  navigate: (request: NavigationRequest, signal: AbortSignal) => Promise<NavigationOutcome>;
  openSource: (source: AssistantSourceRef) => Promise<void>;
  /** Safe host renderer; absent renderers show literal model text. */
  renderText?: (container: HTMLElement, text: string) => (() => void) | void;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** The same small DOM surface serves workspace and publication hosts. It owns no auth,
 * storage, URLs, tool execution or provider connection. Hosts validate event payloads. */
export function mountAssistantPanel(options: AssistantPanelOptions) {
  const { root, transport } = options;
  const doc = root.ownerDocument;
  const lifetime = new AbortController();
  let stream: AbortController | undefined;
  let session: AssistantPanelSession | undefined;
  let sourceBinding: string | undefined;
  let cursor = 0;
  let activeTurn: string | undefined;
  let stopped = false;
  let opening: AbortController | undefined;
  let openingRevision: string | undefined;
  let openingSurface: string | undefined;
  let sending = false;
  let polling = false;
  let epoch = 0;
  let renderDisposals: (() => void)[] = [];
  const turns = new Map<string, { answer: HTMLElement; text: string; sources: HTMLElement }>();
  const tools = new Map<string, HTMLElement>();
  const endedTurns = new Set<string>();
  const sources = new Map<string, AssistantSourceRef>();
  const seenNavigation = new Set<string>();
  const element = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text?: string) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  root.classList.add("superbee-assistant");
  root.setAttribute("aria-label", "Superbee assistant");
  const header = element("header");
  const heading = element("h2", "Ask Superbee");
  const close = element("button", "Close");
  close.type = "button";
  close.setAttribute("aria-label", "Close assistant");
  const sourceLabel = element("p", "Choose a bundle to ask a question.");
  sourceLabel.className = "assistant-source-label";
  const transcript = element("div");
  transcript.className = "assistant-transcript";
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-label", "Conversation");
  transcript.setAttribute("aria-live", "polite");
  transcript.setAttribute("aria-relevant", "additions text");
  const status = element("p");
  status.className = "assistant-status";
  status.setAttribute("role", "status");
  const form = element("form");
  const label = element("label", "Your question");
  const input = element("textarea");
  input.rows = 3;
  input.maxLength = 4096;
  input.placeholder = "Ask about this bundle, or open a source…";
  label.append(input);
  const actions = element("div");
  actions.className = "assistant-actions";
  const send = element("button", "Send");
  send.type = "submit";
  const cancel = element("button", "Stop");
  cancel.type = "button";
  const retry = element("button", "Reconnect");
  retry.type = "button";
  retry.hidden = true;
  actions.append(send, cancel, retry);
  form.append(label, actions);
  header.append(heading, close);
  root.replaceChildren(header, sourceLabel, transcript, status, form);
  function controls() {
    const context = options.context();
    const unavailable = stopped || !session || !context || context.bindingId !== sourceBinding;
    send.disabled = unavailable || sending;
    send.textContent = activeTurn ? "Redirect" : "Send";
    input.disabled = stopped;
    cancel.disabled = unavailable || !activeTurn;
  }
  function clearTranscript() {
    renderDisposals.forEach((dispose) => dispose());
    renderDisposals = [];
    transcript.replaceChildren();
    turns.clear(); tools.clear(); sources.clear(); seenNavigation.clear(); endedTurns.clear();
    cursor = 0;
    activeTurn = undefined;
  }
  function turn(turnId: string) {
    let row = turns.get(turnId);
    if (!row) {
      const article = element("article");
      article.className = "assistant-turn";
      article.dataset.turnId = turnId;
      const answer = element("div");
      answer.className = "assistant-answer";
      const citations = element("div");
      citations.className = "assistant-sources";
      article.append(answer, citations);
      transcript.append(article);
      row = { answer, text: "", sources: citations };
      turns.set(turnId, row);
    }
    return row;
  }
  function source(value: unknown): AssistantSourceRef | undefined {
    const ref = record(value);
    if (!ref || !["hosted-document", "portal-document"].includes(String(ref.kind)) ||
        ![ref.sourceId, ref.bundleId, ref.documentId].every((id) => typeof id === "string" && id.length > 0 && id.length <= 2048)) return;
    if (ref.kind === "hosted-document" && typeof ref.version !== "string") return;
    if (ref.kind === "portal-document" && (typeof ref.artifactDigest !== "string" || typeof ref.snapshotDigest !== "string")) return;
    return ref as AssistantSourceRef;
  }
  async function navigation(request: NavigationRequest) {
    const identity = [request.sessionId, request.turnId, request.toolCallId].join("\0");
    if (seenNavigation.has(identity)) return;
    seenNavigation.add(identity);
    const context = options.context();
    // Another viewer, previous mount, or changed source can read the transcript but cannot move this surface.
    if (!context || request.surfaceId !== context.surfaceId || request.bindingId !== context.bindingId ||
        request.contextRevision !== context.contextRevision || request.sessionId !== session?.sessionId) return;
    let outcome: NavigationOutcome = "stale";
    if (request.expiresAt > Date.now() && !lifetime.signal.aborted) {
      try { outcome = await options.navigate(request, lifetime.signal); }
      catch { outcome = lifetime.signal.aborted ? "cancelled" : "unsupported"; }
    }
    if (lifetime.signal.aborted) return;
    try { await transport.receipt(request, outcome, lifetime.signal); }
    catch { status.textContent = "The navigation result could not be recorded."; }
  }
  function receive(event: AssistantEvent) {
    if (stopped || !Number.isSafeInteger(event.seq) || event.seq <= cursor) return;
    cursor = event.seq;
    const payload = record(event.payload);
    if (!payload) return;
    const turnId = string(payload.turnId);
    if (event.type === "turn.accepted" && turnId) {
      const row = turn(turnId);
      const question = element("p", string(payload.text) ?? "");
      question.className = "assistant-question";
      row.answer.before(question);
      activeTurn = turnId;
      status.textContent = "Reading and answering…";
    } else if (event.type === "agent.text" && turnId && typeof payload.text === "string") {
      const row = turn(turnId);
      // The host also caps output; this surface remains bounded if a broken transport feeds it.
      row.text = (row.text + payload.text).slice(0, 65536);
      row.answer.textContent = row.text;
    } else if (event.type === "tool.started" && turnId && typeof payload.toolCallId === "string") {
      const activity = element("p", "Reading: " + (string(payload.operationId) ?? "source"));
      activity.className = "assistant-tool";
      turn(turnId).answer.before(activity);
      tools.set(payload.toolCallId, activity);
    } else if ((event.type === "tool.finished" || event.type === "tool.cancelled") && typeof payload.toolCallId === "string") {
      const activity = tools.get(payload.toolCallId);
      if (activity) activity.textContent += event.type === "tool.cancelled" ? " — stopped" : payload.ok === true ? " — complete" : " — unavailable";
    } else if (event.type === "source.read" && turnId) {
      const ref = source(payload.source);
      if (ref && !sources.has(ref.sourceId)) {
        sources.set(ref.sourceId, ref);
        const button = element("button", "Open " + ref.documentId);
        button.type = "button";
        button.dataset.sourceId = ref.sourceId;
        button.title = ref.kind === "hosted-document" ? "Saved workspace document" : "Published snapshot document";
        button.addEventListener("click", () => {
          if (!stopped && options.context()?.bindingId === sourceBinding)
            void options.openSource(ref).catch(() => { status.textContent = "This source could not be opened."; });
        });
        turn(turnId).sources.append(button);
      }
    } else if (event.type === "navigation.requested") {
      void navigation(payload as NavigationRequest);
    } else if (event.type === "navigation.receipt") {
      status.textContent = payload.outcome === "navigated" ? "Opened the requested destination." : "Navigation: " + String(payload.outcome);
    } else if (event.type === "turn.ended" && turnId) {
      endedTurns.add(turnId);
      if (activeTurn === turnId) activeTurn = undefined;
      const row = turns.get(turnId);
      if (row && options.renderText) {
        const dispose = options.renderText(row.answer, row.text);
        if (dispose) renderDisposals.push(dispose);
      }
      status.textContent = payload.stopReason === "end_turn" ? "Ready for your next question." : payload.stopReason === "interrupted" ? "Stopped. You can ask another question." : "This turn ended. You can ask another question.";
    } else if (event.type === "session.fenced" || event.type === "session.ended") {
      fence("Access to this conversation has ended. Reopen the assistant after checking your access.");
    } else if (event.type === "log.truncated") {
      status.textContent = "Some earlier conversation activity is no longer available.";
    }
    controls();
  }
  async function poll(signal: AbortSignal, generation: number) {
    if (!session || polling) return;
    polling = true;
    retry.hidden = true;
    try {
      while (!signal.aborted && !stopped && generation === epoch && session) {
        await transport.events(session.sessionId, cursor, signal, (event) => {
          if (generation === epoch && !signal.aborted) receive(event);
        });
      }
    } catch {
      if (!signal.aborted && !stopped && generation === epoch) {
        status.textContent = "Connection interrupted. Reconnect to check the saved conversation.";
        retry.hidden = false;
      }
    } finally { if (generation === epoch) polling = false; }
  }
  async function refresh() {
    if (stopped) return;
    const context = options.context();
    sourceLabel.textContent = context?.label ?? "Choose a bundle to ask a question.";
    if (context && sourceBinding === context.bindingId &&
        (session || (opening && openingRevision === context.contextRevision && openingSurface === context.surfaceId))) {
      controls(); return;
    }
    // Invalidate before starting another admission, even when an obsolete start ignores abort.
    const generation = ++epoch;
    opening?.abort(); opening = undefined;
    stream?.abort(); stream = undefined;
    polling = false;
    session = undefined;
    sourceBinding = context?.bindingId;
    clearTranscript();
    if (!context) {
      status.textContent = "Choose a bundle to continue."; controls(); return;
    }
    const admission = new AbortController();
    opening = admission;
    openingRevision = context.contextRevision;
    openingSurface = context.surfaceId;
    status.textContent = "Opening conversation…";
    controls();
    try {
      const admitted = await transport.start(context, AbortSignal.any([admission.signal, lifetime.signal]));
      if (stopped || admission.signal.aborted || generation !== epoch || options.context()?.bindingId !== sourceBinding) return;
      session = admitted;
      status.textContent = "Ask a question about this source.";
      stream = new AbortController();
      void poll(AbortSignal.any([stream.signal, lifetime.signal]), generation);
    } catch {
      if (!stopped && generation === epoch) { status.textContent = "The assistant is unavailable. Try reconnecting."; retry.hidden = false; }
    } finally {
      if (opening === admission) opening = undefined;
      if (generation === epoch) {
        controls();
        if (!stopped && options.context()?.bindingId !== sourceBinding) void refresh();
      }
    }
  }
  function fence(message: string) {
    stopped = true;
    epoch++;
    opening?.abort(); opening = undefined;
    stream?.abort();
    lifetime.abort();
    session = undefined;
    clearTranscript();
    sourceLabel.textContent = "Conversation unavailable";
    status.textContent = message;
    retry.hidden = true;
    controls();
  }
  const submit = async (event: Event) => {
    event.preventDefault();
    const context = options.context();
    const text = input.value.trim();
    if (!text || !context || !session || sending || stopped || context.bindingId !== sourceBinding) return;
    const generation = epoch;
    const sessionId = session.sessionId;
    sending = true;
    controls();
    try {
      const accepted = activeTurn
        ? await transport.steer(sessionId, activeTurn, text, context, lifetime.signal)
        : await transport.send(sessionId, text, context, lifetime.signal);
      if (!stopped && generation === epoch && session?.sessionId === sessionId && options.context()?.bindingId === context.bindingId) {
        if (!endedTurns.has(accepted.turnId)) { activeTurn = accepted.turnId; status.textContent = "Reading and answering…"; }
        input.value = "";
      }
    } catch { if (!stopped && generation === epoch) status.textContent = "We could not confirm the question was sent. Reconnect before sending it again."; }
    finally { sending = false; controls(); }
  };
  form.addEventListener("submit", submit);
  const inputKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); form.requestSubmit();
    }
  };
  input.addEventListener("keydown", inputKey);
  cancel.addEventListener("click", () => {
    if (!session || !activeTurn || stopped) return;
    const generation = epoch;
    const sessionId = session.sessionId;
    const turnId = activeTurn;
    const current = () => !stopped && generation === epoch && session?.sessionId === sessionId &&
      activeTurn === turnId && !endedTurns.has(turnId);
    cancel.disabled = true;
    void transport.cancel(sessionId, turnId, lifetime.signal).then(
      () => { if (current()) status.textContent = "Stopping…"; },
      () => { if (current()) { status.textContent = "Stop could not be confirmed. Reconnect to check the turn."; controls(); } },
    );
  });
  retry.addEventListener("click", () => {
    if (stopped) return;
    if (!session) { void refresh(); return; }
    if (!polling) { stream = new AbortController(); void poll(AbortSignal.any([stream.signal, lifetime.signal]), epoch); }
  });
  const hide = () => {
    root.hidden = true;
    const EventType = doc.defaultView?.Event ?? Event;
    root.dispatchEvent(new EventType("assistant-close"));
  };
  const rootKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); hide(); } };
  close.addEventListener("click", hide);
  root.addEventListener("keydown", rootKey);
  controls();
  return {
    show() { if (!stopped) { root.hidden = false; input.focus(); void refresh(); } },
    refresh,
    fence,
    dispose() {
      fence(""); form.removeEventListener("submit", submit); input.removeEventListener("keydown", inputKey);
      close.removeEventListener("click", hide); root.removeEventListener("keydown", rootKey); root.replaceChildren();
    },
  };
}
