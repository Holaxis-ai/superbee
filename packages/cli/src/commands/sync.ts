// `agentstate-lite sync` — the historical import surface; the implementation lives in ./sync/
// (orchestration, conflict convergence + receipts, the --show-incoming viewer).
export * from "./sync/orchestrate.js";
export * from "./sync/converge.js";
export * from "./sync/show-incoming.js";
// The refusal/guidance templates live in THE sync-outcome table (../sync-outcomes.ts); these
// re-exports keep the module's historical import surface stable.
export { ffSwallowToError, inTreeNoBasisNote, syncInTreeRefusalMessage, upstreamHelp } from "../sync-outcomes.js";
