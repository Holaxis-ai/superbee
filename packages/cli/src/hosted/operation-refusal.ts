// One reading of a kernel operation's refusal (`ok: false`) in a hosted checkout, for every command
// that runs an operation (`doc history`, `op list`, `op run`). A command keeps only the codes whose
// wording is its own, then falls through to this. The refusal's message is host text core has
// already stripped; its code is in core's refusal code grammar.
import { RemoteError } from "@superbee/core";
import type { HostedOperationRefusal } from "@superbee/core/hosted-transport";

import { CliError } from "../errors.js";
import type { CheckoutBinding } from "./binding.js";
import { hostedFailure, type HostedSyncClient } from "./client.js";
import { bundleAbsent } from "./refusals.js";

export interface OperationRefusalContext {
  readonly binding: CheckoutBinding;
  /** The checkout's client: a `bundle_not_found` reads its bundle list once, to tell an id that became ambiguous from a bundle gone. */
  readonly client: Pick<HostedSyncClient, "bundles">;
  readonly target: HostedSyncClient["target"];
  readonly resume?: string;
  /** What was refused, as the message names it: an operation id, or "the operation listing". */
  readonly subject: string;
  /** The command that shows the input the subject takes. */
  readonly inputHelp: string;
}

/**
 * The CLI error a refusal means: a bundle the host no longer serves is the checkout's conflict, as
 * sync reports it (`bundleAbsent`: an id now in two of the person's workspaces says so); `invalid_input` is the caller's USAGE; `document_not_found` is NOT_FOUND; every
 * other code goes through the hosted client's one translation, retryable when the kernel says so.
 */
export async function operationRefusalError(refusal: HostedOperationRefusal, context: OperationRefusalContext): Promise<unknown> {
  const { binding, target, subject } = context;
  const details = { host: binding.origin, subject, code: refusal.code, message: refusal.message };
  switch (refusal.code) {
    case "bundle_not_found":
      return bundleAbsent(binding, context.client);
    case "invalid_input":
      return new CliError("USAGE", `${binding.origin} refused the input for ${subject}`, { details, help: context.inputHelp });
    case "document_not_found":
      return new CliError("NOT_FOUND", `${binding.origin} has no such document (${subject})`, {
        details,
        help: "check the document id; a document created in this checkout reaches the host at the next sync",
      });
    default:
      return hostedFailure(new RemoteError(refusal.message, refusal.code, refusal.retryable ? 503 : 422), target, context.resume);
  }
}
