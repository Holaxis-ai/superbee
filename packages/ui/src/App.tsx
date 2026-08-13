/**
 * App shell: mounts the ONE global interceptor gate (plans/ui-v1.md rev 3.2) in front of whichever
 * view the URL names. The pages-spike (tasks/ui-pages-spike) makes the LAUNCHER the SOLE surface:
 * it lists the bundle's `type: View` docs and frames the chosen one in a sandboxed iframe. The old
 * paused React views (board/doc/admin/graph) were removed by human verdict — the launcher REPLACES
 * them, not co-exists — so any non-`page` route falls back to the launcher. The banked plumbing
 * (interceptor + relogin recovery, typed client, query layer) is kept and still ridden here.
 */
import { useSyncExternalStore } from "react";
import { getRoute, subscribeToRoute, navigate } from "./routing.js";
import { useInterceptorStatus } from "./query/interceptor.js";
import { ReloginScreen } from "./views/ReloginScreen.js";
import { Launcher } from "./views/Launcher.js";
import { PageFrame } from "./views/PageFrame.js";
import { DocPage } from "./views/DocPage.js";
import { BrandMark } from "./BrandMark.js";

export function App() {
  const interceptorStatus = useInterceptorStatus();
  // getServerSnapshot === getSnapshot: this is a client-only SPA, never server-rendered.
  const route = useSyncExternalStore(subscribeToRoute, getRoute, getRoute);

  if (interceptorStatus !== "ok") return <ReloginScreen kind={interceptorStatus} />;

  const view =
    route.view === "page" && route.id ? (
      <PageFrame pageId={route.id} />
    ) : route.view === "doc" && route.id ? (
      <DocPage docId={route.id} />
    ) : (
      <Launcher />
    );

  return (
    <div className="app">
      <header className="app-header">
        <BrandMark />
        <button type="button" className="app-title" onClick={() => navigate({ view: "launcher" })}>
          Superbee
        </button>
      </header>
      <main>{view}</main>
    </div>
  );
}
