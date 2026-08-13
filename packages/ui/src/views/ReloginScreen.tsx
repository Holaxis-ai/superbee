/**
 * The terminal screen for a tripped interceptor (plans/ui-v1.md rev 3.2): a 401, a 429, or a 403
 * from the shell's own session gate (`session_expired` — see `interceptor.ts`'s doc comment for
 * why that's a distinct status from `unauthorized`) stops every poll in the app and replaces the
 * whole view — never a banner over stale data, since stale task state under a dead session is
 * actively misleading.
 */
import { useEffect, useState } from "react";
import type { InterceptorStatus } from "../query/interceptor.js";

interface UiConfig {
  mode: "dir" | "remote";
  remoteUrl: string | null;
}

/** Best-effort read of the ui server's own local (non-wire-protocol) bootstrap endpoint — see `packages/ui-server/src/server.ts`'s `/__ui/config`. Never throws; falls back to `null` so this screen always renders something. */
function useUiConfig(): UiConfig | null {
  const [config, setConfig] = useState<UiConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/__ui/config", { credentials: "same-origin" })
      .then((res) => (res.ok ? (res.json() as Promise<UiConfig>) : null))
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch(() => {
        /* best-effort — the screen below has a sensible fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

export function ReloginScreen({ kind }: { kind: Exclude<InterceptorStatus, "ok"> }) {
  const config = useUiConfig();
  const remoteUrl = config?.remoteUrl ?? "<url>";

  if (kind === "rate_limited") {
    return (
      <div className="relogin-screen" role="alert">
        <h1>Rate limited</h1>
        <p>Too many requests reached the remote recently. Polling has stopped. Reload this page after a moment.</p>
      </div>
    );
  }

  if (kind === "session_expired") {
    return (
      <div className="relogin-screen" role="alert">
        <h1>Connection lost</h1>
        <p>
          This tab&rsquo;s session ended — most likely the <code>ui</code> server was restarted, which mints a fresh
          session on every boot. Polling has stopped. Go back to the terminal and reopen the URL it just printed
          (re-running the command if it has already exited).
        </p>
      </div>
    );
  }

  return (
    <div className="relogin-screen" role="alert">
      <h1>Sign-in required</h1>
      <p>
        Your API key was rejected or has expired. Polling has stopped. Set <code>SUPERBEE_API_KEY</code> in the
        environment that launches the CLI, rerun the same <code>ui --remote</code> invocation that opened this page, then
        open the fresh URL it prints.
      </p>
      <p>Remote: <code>{remoteUrl}</code></p>
    </div>
  );
}
