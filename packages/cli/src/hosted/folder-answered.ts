// The host operations a hosted checkout answers from its folder, never by id: run on the host, they
// would skip the folder's unsent edits (designs/seamless-multi-backend-cli, A10). One table for
// every surface that reaches operations by id: `op list`/`op run` and the local MCP app's
// `list_operations`/`run_operation` (through the catalog workspace resolver).
import { commandLiteral, type CommandText } from "../command-text.js";

/** Each folder-answered operation, with the CLI verb that answers it from the folder. */
export const FOLDER_ANSWERED_OPERATIONS: Readonly<Record<string, { readonly verb: string; readonly command: CommandText }>> = Object.freeze({
  "documents.read.v1": Object.freeze({ verb: "doc read", command: commandLiteral("doc read <id>") }),
  "documents.query.v1": Object.freeze({ verb: "list or query", command: commandLiteral("list") }),
});

/** True when a checkout answers `operationId` from its folder (an own key of the table). */
export function isFolderAnswered(operationId: string): boolean {
  return Object.hasOwn(FOLDER_ANSWERED_OPERATIONS, operationId);
}
