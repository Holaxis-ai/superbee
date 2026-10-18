/**
 * `@superbee/core/source-harness`: how a profile and a transport prove the source engine's rules
 * offline.
 *
 * {@link runSourceScenario} replays a profile's scripted provider answers through
 * `observeSource`, writing each committed page through record-overlay over a MemoryBackend
 * bundle, and {@link checkScenario} holds the result to the required scenario's outcome rule
 * ({@link REQUIRED_SCENARIOS}). {@link runTransportConformance} is the suite every transport passes
 * against a scripted peer: the credential only to its host (a custom header included), redirects
 * returned unfollowed, a body over the bound refused, and behind the engine a cross-host or
 * private-address redirect that reaches nothing. {@link peerTransport} is a memory transport that
 * passes it. Results are rows, not assertions, so any test runner can use them.
 *
 * Storage-neutral: no Node globals or builtins, and nothing here calls `fetch`.
 */
export { ExchangePeer, peerTransport, ScriptedPeer } from "./peer.js";
export type { PeerRequest, PeerResponse, ScriptedExchange, TransportCredential } from "./peer.js";
export { CONFORMANCE_SCENARIOS, runTransportConformance } from "./conformance.js";
export type { ConformanceRow, TransportConformanceTarget } from "./conformance.js";
export { checkScenario, missingScenarios, REQUIRED_SCENARIOS, runSourceFixture, runSourceScenario, scenarioBase } from "./fixture.js";
export type { RequiredScenario, ScenarioResult, ScenarioRun, SourceFixture, SourceRunScript, SourceScenario } from "./fixture.js";
