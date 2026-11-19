import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { escapeHostJson, RemoteError, stripHostData } from "@superbee/core";
import { HostedCarrierError } from "@superbee/core/hosted-transport";
import { parseLeafOrUsage } from "../args.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { bundleHomeAt } from "../bundle-home.js";
import { commandFragment, commandToken } from "../command-text.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError, type CliErrorCode } from "../errors.js";
import { hostedFailure } from "../hosted/client.js";
import type { HostedAccountDeps } from "../hosted/account.js";
import { openCheckoutConnection } from "../hosted/checkout-connection.js";
import { cliInvocation } from "../invocation.js";
import { render, renderUsage, resolveMode } from "../output.js";

const USAGE = `superbee recipe install <catalog-id> [--dir <hosted-checkout>] [--json]
superbee recipe install <catalog-id> --apply <plan-token> --prepared-at <time> --request-id <uuid> [--lookup] [--dir <hosted-checkout>] [--json]

Preview one recipe in the checkout's Hosted bundle. The preview shows what will be created and any blockers.
After reviewing it, use the printed apply command. If the reply is lost, repeat that exact command or add
--lookup to read its recorded outcome. Run sync after a successful install to update the checkout.
`;
const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso = (time: unknown): time is string =>
  typeof time === "string" && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;

export interface RecipeInstallDeps {
  stdout: (text: string) => void;
  hosted?: HostedAccountDeps;
  cwd?: string;
}

export async function recipeInstall(argv: string[], deps: RecipeInstallDeps): Promise<void> {
  const { values, positionals } = parseLeafOrUsage(
    () => parseArgs({
      args: argv, allowPositionals: true,
      options: {
        dir: { type: "string" }, apply: { type: "string" }, "prepared-at": { type: "string" },
        "request-id": { type: "string" }, lookup: { type: "boolean" }, json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }),
    CLI_LEAVES.recipeInstall,
  );
  if (values.help) {
    deps.stdout(renderUsage(USAGE));
    return;
  }
  const id = positionals[0]!;
  const { apply, "prepared-at": preparedAt, "request-id": requestId } = values;
  if (!RECIPE_ID.test(id) ||
    (apply === undefined
      ? preparedAt !== undefined || requestId !== undefined || values.lookup
      : !DIGEST.test(apply) || !iso(preparedAt) || !UUID.test(requestId ?? "")))
    throw new CliError("USAGE", "Use a catalog recipe ID and retain all three apply arguments from its preview.");

  const root = await resolveLocalBundleTarget(values.dir, deps.cwd ?? process.cwd());
  const facts = await bundleHomeAt(root.canonicalRoot, { home: deps.hosted?.auth?.home ?? homedir() });
  if (facts.home !== "hosted")
    throw new CliError("USAGE", "recipe install requires a Hosted checkout", { help: "use recipe add for a local bundle" });
  const { binding } = facts;
  const reference = binding.workspace_slug ? binding.workspace_slug + "/" + binding.bundle_id : binding.bundle_id;
  const receiptArgs = (token: string, time: string, uuid: string) =>
    commandFragment` --apply ${commandToken(token)} --prepared-at ${commandToken(time)} --request-id ${commandToken(uuid)}`;
  const command = commandFragment`${cliInvocation()} recipe install ${commandToken(id)} --dir ${commandToken(binding.path)}`;
  const resume = commandFragment`${command}${apply === undefined ? commandFragment`` : receiptArgs(apply, preparedAt!, requestId!)}${values.lookup ? commandFragment` --lookup` : commandFragment``}${values.json ? commandFragment` --json` : commandFragment``}`;
  const { client, target } = await openCheckoutConnection(binding, deps.hosted, resume);
  const route = apply === undefined ? "recipe-preview" : "recipe-apply";
  const unknown = () => new CliError("TRANSIENT", "The Hosted install did not return a confirmed outcome", {
    details: { request_id: requestId, retryable: true },
    help: `run the exact command again or add --lookup: ${resume}`,
  });
  const body = apply === undefined ? { bundleId: binding.bundle_id, recipe: id } : {
    bundleId: binding.bundle_id, recipe: id, planToken: apply, preparedAt, requestId, mode: values.lookup ? "lookup" : "apply",
  };
  const reply = await client.carrier.json(client.prefix + "/" + route, body, client.signal, {
    maximum: 64 * 1024, ...(requestId ? { writeRequest: requestId } : {}),
  }).catch((error: unknown) => {
    if (requestId && error instanceof HostedCarrierError && error.code === "unavailable") throw unknown();
    throw hostedFailure(error, target, resume);
  });
  const answer = reply.body as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; writeState?: string } | string } | null;
  if (reply.status === 404 && answer?.error === "not_found")
    throw new CliError("NOT_IMPLEMENTED", "This Hosted server does not offer recipe installation yet");
  if (reply.status === 401) throw hostedFailure(new RemoteError("Hosted sign-in expired", "UNAUTHENTICATED", 401), target, resume);
  if (reply.status >= 300 || answer?.ok !== true || !answer.data ||
      Array.isArray(answer.data) || typeof answer.data !== "object") {
    const error = typeof answer?.error === "object" ? answer.error : null;
    if (requestId && error?.code === "preview_expired")
      throw new CliError("STALE_HEAD", "The preview has expired", {
        details: { reason: error.code, request_id: requestId },
        help: `add --lookup to check the original outcome before requesting a fresh preview: ${resume}`,
      });
    if (requestId && (error?.writeState === "unknown" || error?.code === "write_outcome_unknown" ||
      (error?.writeState !== "not_applied" && (reply.status >= 500 || answer?.ok !== false))))
      throw unknown();
    const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : undefined;
    const disposition: CliErrorCode =
      code === "insufficient_scope" ? "FORBIDDEN" :
      code === "bundle_not_found" || code === "recipe_not_found" ? "NOT_FOUND" :
      code === "version_conflict" ? "STALE_HEAD" : "RUNTIME";
    throw new CliError(disposition, "Hosted could not complete the recipe request", {
      details: { ...(code ? { reason: code } : {}), ...(requestId ? { request_id: requestId } : {}) },
      ...(disposition === "STALE_HEAD" ? { help: `request a fresh preview: ${command}` } : {}),
    });
  }
  const data = answer.data;
  if (requestId && (data.status !== "committed" || data.requestId !== requestId)) throw unknown();
  const ready = apply === undefined && data.applyAllowed === true &&
    typeof data.planToken === "string" && DIGEST.test(data.planToken) && iso(data.preparedAt);
  const output = {
    recipe: id,
    bundle: reference,
    result: data,
    ...(ready ? { apply_command: commandFragment`${command}${receiptArgs(data.planToken as string, data.preparedAt as string, randomUUID())}` } : {}),
    ...(requestId
      ? { sync_command: commandFragment`${cliInvocation()} sync --dir ${commandToken(binding.path)}` }
      : {}),
  };
  deps.stdout(resolveMode(values) === "json" ? escapeHostJson(JSON.stringify(output)) + "\n"
    : render({ ...output, result: stripHostData(data).value }, resolveMode(values)));
}
