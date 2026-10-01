export { createSurfaceContext, SurfaceContextError } from "./context.js";
export type { SurfaceSnapshot } from "./context.js";
export { createRevealPolicy, FOLLOW_MS, OFFER_MS } from "./reveal.js";
export type { RevealMode, RevealSurface, RevealResult, RevealNavigationContext } from "./reveal.js";
export type { ToolDescriptor, NavigationOrigin, NavigationTarget, NavigationOutcome, NavigationRequest, NavigationReceipt, AssistantSourceRef, AssistantEvent, AssistantSourceRead } from "./types.js";
export { mountAssistantPanel } from "./panel.js";
export type { AssistantPanelContext, AssistantPanelSession, AssistantPanelTransport, AssistantPanelOptions, AssistantNavigationCommit } from "./panel.js";
