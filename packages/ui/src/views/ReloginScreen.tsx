/**
 * The terminal screen for a tripped interceptor (plans/ui-v1.md rev 3.2): a 401, a 429, or a 403
 * from the shell's own session gate (`session_expired` — see `interceptor.ts`'s doc comment for
 * why that's a distinct status from `unauthorized`) stops every poll in the app and replaces the
 * whole view — never a banner over stale data, since stale task state under a dead session is
 * actively misleading.
 */
import type { InterceptorStatus } from "../query/interceptor.js";

export function ReloginScreen({ kind }: { kind: Exclude<InterceptorStatus, "ok"> }) {
  if (kind === "rate_limited") {
    return (
      <div className="relogin-screen" role="alert">
        <h1>Rate limited</h1>
        <p>Too many requests reached the server recently. Polling has stopped. Reload this page after a moment.</p>
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
      <h1>Access refused</h1>
      <p>
        The server refused this tab&rsquo;s requests. Polling has stopped. Go back to the terminal, rerun the{" "}
        <code>ui</code> command, then open the fresh URL it prints.
      </p>
    </div>
  );
}
