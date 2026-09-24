// SIGKILL-at-every-step sweeps for keep and take on a deletion in conflict. The cases live
// in support/qa-r2-crash-cases.ts, split across files so they run in parallel.
import { registerCrashCases } from "./support/qa-r2-crash-cases.js";

registerCrashCases("conflict");
