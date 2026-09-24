// SIGKILL-at-every-step sweeps for the checkout's own re-create and keep on "deleted remotely".
// The cases live in support/qa-r2-crash-cases.ts, split across files so they run in parallel.
import { registerCrashCases } from "./support/qa-r2-crash-cases.js";

registerCrashCases("recreate");
