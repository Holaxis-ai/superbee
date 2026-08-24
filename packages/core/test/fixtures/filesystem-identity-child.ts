/**
 * Cross-process identity proof child: keep attempting one document write through the production
 * adapter, reporting every lock refusal with the owner it observed, until the write is fulfilled,
 * refused as an alias, or fails for another reason.
 */
import { FilesystemBackend } from "../../src/backend.js";
import { FilesystemIdentityAliasError } from "../../src/errors.js";
import { FilesystemMutationLockError } from "../../src/filesystem-lock.js";

const [root, id] = process.argv.slice(2);

if (!root || !id) throw new Error("usage: filesystem-identity-child <root> <id>");

const send = (message: Record<string, unknown>): void => {
  process.send?.(message);
};

const backend = new FilesystemBackend(root);
send({ type: "attempting" });
for (;;) {
  try {
    const version = await backend.write(id, {
      id,
      frontmatter: { type: "Concept", timestamp: "2026-07-16T00:00:00.000Z" },
      body: id,
    });
    send({ type: "fulfilled", version, id });
    break;
  } catch (err) {
    if (err instanceof FilesystemMutationLockError) {
      send({ type: "blocked", owner: err.owner, id });
      continue;
    }
    if (err instanceof FilesystemIdentityAliasError) {
      send({ type: "refused", id });
      break;
    }
    send({ type: "error", message: err instanceof Error ? err.stack ?? err.message : String(err), id });
    process.exitCode = 1;
    break;
  }
}
