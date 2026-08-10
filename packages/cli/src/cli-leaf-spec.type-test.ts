import type { CliLeafSpec } from "./command-spec.js";
import { PUBLIC_HANDLERS, type PublicHandlerMap } from "./cli.js";

// A direct structural leaf must remain impossible. If the private brand is removed, typecheck
// fails because this @ts-expect-error becomes unused.
// @ts-expect-error CliLeafSpec values are produced only by the canonical command-spec module.
const forgedLeaf: CliLeafSpec = {
  id: "forged",
  path: "forged",
  command: "forged",
  arity: { kind: "exact", count: 0 },
  canonical: undefined as never,
  exposure: "public",
};
void forgedLeaf;

const { view: omittedView, ...withoutView } = PUBLIC_HANDLERS;
void omittedView;
// @ts-expect-error every catalogued public command must have a handler.
const missingHandler: PublicHandlerMap = withoutView;
void missingHandler;

// @ts-expect-error non-catalogued public handlers are rejected at the exact map boundary.
const extraHandler = { ...PUBLIC_HANDLERS, extra: async (_args: string[]) => undefined } satisfies PublicHandlerMap;
void extraHandler;
