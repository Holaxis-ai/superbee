// `superbee turn-end` — the end-of-turn hook payload: sync a hosted checkout when an agent's turn
// ends, so a batch of edits reaches the host without anyone remembering to run sync.
//
// `hook install --turn-end-sync` wires it as the Stop hook for Claude Code and Codex. It never
// fails the turn (exit 0 on every path) and is silent unless the sync needs the agent: a conflict,
// a held file, or a sign-in link to relay. Then it prints the hosts' Stop-hook decision
// (`{"decision":"block","reason":...}`), which hands the reason back to the agent once; a turn that
// is already continuing because of this hook (`stop_hook_active`) is never blocked again.
// Anywhere other than a hosted checkout it does nothing, so a Git board is never synced by a hook.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { parseLeafOrUsage } from "../args.js";
import { hostedCheckoutAt } from "../autopull.js";
import { CLI_LEAVES } from "../command-spec.js";
import { commandFragment, commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { renderUsage } from "../output.js";
import type { CheckoutBinding } from "../hosted/binding.js";
import { ageMs, backgroundSyncDeps, HOSTED_AUTOPULL_STALE_MS, readFreshness, recordTurnEndBlock } from "../hosted/freshness.js";
import type { HostedSyncDeps } from "../hosted/sync.js";

/** Set to any non-empty value to turn the end-of-turn sync off without uninstalling the hook. */
export const NO_TURN_SYNC_ENV = "SUPERBEE_NO_TURN_SYNC";
/** The sync's network budget, under the hook's timeout. */
export const TURN_END_BUDGET_MS = 20_000;
/** Rows the reason carries; the agent runs sync itself for the rest. */
const REASON_ROWS = 10;
const STDIN_BYTES = 64 * 1024;

export const TURN_END_USAGE = `superbee turn-end — the end-of-turn hook payload (sync a hosted checkout)

Usage:
  superbee turn-end [--dir <path>]

In a hosted checkout (made by 'superbee checkout'), runs one sync: edited files are sent and host
changes are pulled. With nothing to send and a pull under five minutes old it does not touch the
network. Anywhere else it does nothing. It never fails the turn (exit 0) and prints nothing unless
the sync needs the agent: a conflict, a held file, or a sign-in link to relay. Then it prints a
Stop-hook decision ({"decision":"block","reason":...}) whose reason is the sync receipt and the
next command, once per condition: the same unresolved condition is not reported again until it
changes.

\`hook install --turn-end-sync\` installs it as the Stop hook for Claude Code and Codex; \`hook
uninstall --turn-end-sync\` removes only that hook. ${NO_TURN_SYNC_ENV}=<any value> turns it off
without uninstalling.

Options:
  --dir <path>   Directory to run from (default: the cwd)
  -h, --help     Show this help
`;

export interface TurnEndDeps {
  stdout: (text: string) => void;
  env: Record<string, string | undefined>;
  /** The hook's stdin (the host's JSON event), or null when there is none. */
  readStdin: () => Promise<string | null>;
  hostedCheckout: (dir: string | undefined) => Promise<CheckoutBinding | null>;
  /** The sync (default: `superbee sync` in the checkout). */
  sync: (argv: string[], deps: Partial<HostedSyncDeps>) => Promise<void>;
  /** Sync seams (tests pass the fake host's fetch and auth). */
  syncDeps: Partial<HostedSyncDeps>;
  budgetMs: number;
  /** Whether the checkout has anything to send (default: the private store and folder, read-only). */
  localState: (binding: CheckoutBinding) => Promise<"changed" | "clean" | "busy">;
}

async function readHookStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (value: string | null) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.pause();
      resolve(value);
    };
    const timer = setTimeout(() => done(size > 0 ? Buffer.concat(chunks).toString("utf8") : null), 500);
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDIN_BYTES) return done(null);
      chunks.push(chunk);
    });
    process.stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => done(null));
  });
}

/** True when the host says this turn is already continuing because of a Stop hook. */
function continuingForHook(stdin: string | null): boolean {
  if (!stdin) return false;
  try {
    return (JSON.parse(stdin) as { stop_hook_active?: unknown }).stop_hook_active === true;
  } catch {
    return false;
  }
}

/** Locks that never clear on their own: the conflict-resolution steps cannot help with them. */
const ORPHANED_LOCK_REASONS = new Set(["lock_orphaned", "session_lock_orphaned"]);

function reasonFor(binding: CheckoutBinding, error: CliError, receipt: string): string {
  const sync = commandFragment`${cliInvocation()} sync --dir ${commandToken(binding.path)}`;
  const lines = [`Superbee: the end-of-turn sync of ${binding.path} needs you before this turn ends: ${error.message}.`];
  if (error.code === "AUTH_REQUIRED") {
    const link = (error.details as { sign_in_url?: unknown } | undefined)?.sign_in_url;
    lines.push(
      typeof link === "string"
        ? `Relay this sign-in link to the person: ${link}. After they confirm, run: ${sync}`
        : `Sign in (${error.help ?? `${cliInvocation()} login`}), relay the link it returns, then run: ${sync}`,
    );
  } else if (ORPHANED_LOCK_REASONS.has(String((error.details as { reason?: unknown } | undefined)?.reason)) && error.help) {
    lines.push(`Tell the person: ${error.help}: ${sync}`);
  } else {
    lines.push(
      `Resolve each conflict with ${cliInvocation()} sync --inspect --doc <id>, then --resolve keep|take|revise --doc <id>; fix held files; then run: ${sync}`,
    );
    lines.push("Anything the receipt says to do in the Superbee app is for the person: tell them, do not work around it.");
  }
  if (receipt.trim() !== "") lines.push("", receipt.trim());
  return lines.join("\n");
}

/** CLI entry: exit 0 on every path but a usage error. */
export async function turnEnd(argv: string[], partial: Partial<TurnEndDeps> = {}): Promise<void> {
  const stdout = partial.stdout ?? ((text: string) => void process.stdout.write(text));
  const { values } = parseLeafOrUsage(
    () => parseArgs({ args: argv, options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true }),
    CLI_LEAVES.turnEnd,
  );
  if (values.help) {
    stdout(renderUsage(TURN_END_USAGE));
    return;
  }
  const env = partial.env ?? process.env;
  if (env[NO_TURN_SYNC_ENV]) return;
  let binding: CheckoutBinding | null;
  try {
    binding = await (partial.hostedCheckout ?? ((dir) => hostedCheckoutAt(dir, partial.syncDeps?.auth?.home)))(values.dir);
  } catch {
    return;
  }
  if (!binding) return;
  const stdin = await (partial.readStdin ?? readHookStdin)().catch(() => null);
  if (continuingForHook(stdin)) return;

  const home = partial.syncDeps?.auth?.home ?? homedir();
  const deadline = Date.now() + (partial.budgetMs ?? TURN_END_BUDGET_MS);
  // Nothing to send and a recent pull: no network at all. Reads pull on their own.
  const local = await (partial.localState ?? ((b: CheckoutBinding) => import("../hosted/sync.js").then((m) => m.hostedLocalState(b, home))))(binding).catch(() => "changed" as const);
  if (local === "busy") return;
  if (local === "clean") {
    const age = ageMs((await readFreshness(home, binding.checkout_id)).pulled_at, new Date());
    if (age !== null && age <= HOSTED_AUTOPULL_STALE_MS) return;
  }

  const captured: string[] = [];
  const run = partial.sync ?? (async (args, deps) => (await import("./sync.js")).sync(args, deps));
  let blocking: CliError | null = null;
  try {
    // Every request and lock (the checkout's and the sign-in session's) is bounded by the budget.
    await run(["--dir", binding.path, "--limit", String(REASON_ROWS), "--json"], {
      ...backgroundSyncDeps(partial.syncDeps, home, deadline),
      stdout: (text) => void captured.push(text),
    });
  } catch (error) {
    // Only what the agent can act on blocks the turn; offline, busy or refused writes wait for the
    // next turn or the next sync, which report them in full.
    const reason = error instanceof CliError ? (error.details as { reason?: unknown } | undefined)?.reason : undefined;
    if (error instanceof CliError && (error.code === "AUTH_REQUIRED" || error.code === "CONFLICT") && reason !== "sync_busy" && reason !== "session_busy") {
      blocking = error;
    }
  }
  const receipt = captured.join("");
  if (!blocking) {
    await recordTurnEndBlock(home, binding.checkout_id, null).catch(() => {});
    return;
  }
  // Once per condition: the same unresolved condition does not block every later turn.
  const condition = conditionDigest(blocking, receipt);
  const previous = (await readFreshness(home, binding.checkout_id).catch(() => null))?.turn_end_block ?? null;
  if (condition === previous) return;
  await recordTurnEndBlock(home, binding.checkout_id, condition).catch(() => {});
  stdout(`${JSON.stringify({ decision: "block", reason: reasonFor(binding, blocking, receipt) })}\n`);
}

/** What makes two blocks the same: the error, and the documents still not synced with their states. */
function conditionDigest(error: CliError, receipt: string): string {
  let rows: unknown = null;
  try {
    const parsed = JSON.parse(receipt) as { rows?: { id?: unknown; state?: unknown; reason?: unknown }[] };
    rows = (parsed.rows ?? []).filter((row) => row.state !== "committed").map((row) => [row.id, row.state, row.reason]);
  } catch {
    rows = null;
  }
  const details = error.details as { reason?: unknown; sign_in_url?: unknown } | undefined;
  return createHash("sha256")
    .update(JSON.stringify([error.code, details?.reason ?? null, details?.sign_in_url ?? null, rows]))
    .digest("hex");
}
