// The agent a hosted sync names for its writes: the unverified `;via=` part of the host's agent
// label (`X-Superbee-Via`, superbee-hosted docs/agent-label.md). Attribution only: the host never
// authorizes by it, and it is not part of a write's identity. Only a token the host admits is ever
// sent; anything else is dropped with a note in the sync receipt, and the sync runs as usual.
import { isAgentLabelVia } from "@superbee/core/hosted-transport";

import { SUPERBEE_NO_VIA_ENV, SUPERBEE_VIA_ENV } from "../env-policy.js";

/** Claude Code sets this in the environment of its Bash tool and its hooks. */
export const CLAUDE_CODE_ENV = "CLAUDECODE";

export interface HostedVia {
  /** The token to send, or undefined to send none. */
  readonly token?: string;
  /** Why a token that was named is not sent, for the sync receipt. */
  readonly ignored?: string;
}

/**
 * First match: `SUPERBEE_NO_VIA` (any value) sends none; a non-empty `SUPERBEE_VIA` is sent when
 * the host admits it and otherwise dropped with a note; `CLAUDECODE=1` sends `claude-code`;
 * otherwise none. `SUPERBEE_ACTOR` never labels a hosted write: it is an OKF actor, not a token.
 */
export function resolveHostedVia(env: Readonly<Record<string, string | undefined>>): HostedVia {
  if (env[SUPERBEE_NO_VIA_ENV]) return {};
  const named = env[SUPERBEE_VIA_ENV]?.trim();
  if (named) {
    if (isAgentLabelVia(named)) return { token: named };
    return {
      ignored: `${SUPERBEE_VIA_ENV}=${JSON.stringify(named)} is not a token the host accepts (1 to 32 of a-z 0-9 . _ -, not starting with superbee), so these writes name no agent`,
    };
  }
  if (env[CLAUDE_CODE_ENV] === "1") return { token: "claude-code" };
  return {};
}
