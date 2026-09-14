export type IntegrationHost = "claude_code" | "codex" | "opencode";

const HOST_ORDER: readonly IntegrationHost[] = ["claude_code", "codex", "opencode"];

/** Derive one truthful lifecycle receipt from the host mutations that actually occurred. */
export function integrationChangeReceipt(
  changedByHost: Readonly<Partial<Record<IntegrationHost, boolean>>>,
): {
  changed: boolean;
  restart_required: boolean;
  affected_hosts: IntegrationHost[];
} {
  const affected_hosts = HOST_ORDER.filter((host) => changedByHost[host] === true);
  const changed = affected_hosts.length > 0;
  return { changed, restart_required: changed, affected_hosts };
}
