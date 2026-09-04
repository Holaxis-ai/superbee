import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query/queryClient.js";
import { App } from "./App.js";
import "./styles.css";
import { configureWireBundleId } from "./api/client.js";

// The URL token is a ONE-SHOT bootstrap credential: the response that served this document
// already exchanged it for the HttpOnly session cookie, so scrub it from the address bar before
// anything renders. A URL that kept the token would leak it through `document.referrer` into
// every framed (untrusted) page, and would embed a live secret in any copied/bookmarked address
// (tasks/ui-pages-spike P1 — one of three layers with the shell's `Referrer-Policy: no-referrer`
// response header and the iframe's `referrerpolicy="no-referrer"`).
const bootUrl = new URL(window.location.href);
if (bootUrl.searchParams.has("token")) {
  bootUrl.searchParams.delete("token");
  window.history.replaceState(null, "", `${bootUrl.pathname}${bootUrl.search}${bootUrl.hash}`);
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

async function mount(): Promise<void> {
  try {
    const response = await fetch("/__ui/config", { credentials: "same-origin" });
    if (response.ok) {
      const config = (await response.json()) as { bundleId?: string | null };
      configureWireBundleId(config.bundleId);
    }
  } catch {
    // The mounted app owns the ordinary offline/session-expired recovery surface.
  }

  createRoot(container!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void mount();
