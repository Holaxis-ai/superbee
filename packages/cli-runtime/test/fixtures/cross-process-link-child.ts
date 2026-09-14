import { addLink } from "../../src/commands/link.js";

const [root, target] = process.argv.slice(2);

if (!root || !target) throw new Error("usage: cross-process-link-child <root> <target>");

process.send?.({ type: "attempting" });

try {
  const result = await addLink({ root }, "hub", target, {
    text: target,
    keepTimestamp: true,
    actor: "test/cross-process",
  });
  process.send?.({ type: "result", status: "fulfilled", target, changed: result.changed });
} catch (err) {
  process.send?.({
    type: "result",
    status: "error",
    target,
    message: err instanceof Error ? err.stack ?? err.message : String(err),
  });
  process.exitCode = 1;
}
