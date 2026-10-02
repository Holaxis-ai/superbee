// SIGKILL-at-every-step sweeps for a bulk deletion window and a scan-journaled delete. The
// cases live in support/qa-r2-crash-cases.ts, split across files so they run in parallel.
import { registerCrashCases } from "./support/qa-r2-crash-cases.js";

registerCrashCases("delete");
