import type { ArityDecision } from "./args.js";

// A direct structural decision must remain impossible. If the private brand is removed,
// typecheck fails because this @ts-expect-error becomes unused.
// @ts-expect-error ArityDecision values are produced only by the owning factories.
const forgedDecision: ArityDecision = { kind: "deferred", reason: "new:schema" };
void forgedDecision;
