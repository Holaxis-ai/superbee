// The one way a command reaches a hosted checkout's host as the checkout's own person: the
// checkout's host and bundle from its binding, a sign-in that carries `resume` when the session is
// missing, and the identity check `connectCheckout` makes. The hosted modules load only here, only
// for a folder bound as a checkout, so a local or Git folder never loads them.
import { homedir } from "node:os";

import type { CommandText } from "../command-text.js";
import type { HostedTarget } from "../hosted-auth/discovery.js";
import type { HostedAccountDeps } from "./account.js";
import type { CheckoutBinding } from "./binding.js";
import type { HostedSyncClient } from "./client.js";

export interface CheckoutConnection {
  readonly client: HostedSyncClient;
  readonly target: HostedTarget;
  /** The command that repeats this one, carried on an AUTH_REQUIRED. */
  readonly resume: CommandText;
}

/** `home` is the directory whose private state holds the session when `hosted` is not given (default: the OS home). */
export async function openCheckoutConnection(binding: CheckoutBinding, hosted: HostedAccountDeps | undefined, resume: CommandText, home: string = homedir()): Promise<CheckoutConnection> {
  const [{ connectCheckout }, { defaultHostedAuthDeps }] = await Promise.all([import("./account.js"), import("../hosted-auth/session.js")]);
  const { client, target } = await connectCheckout(binding, { resume }, hosted ?? { auth: defaultHostedAuthDeps(home) });
  return { client, target, resume };
}
