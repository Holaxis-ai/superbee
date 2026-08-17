// `superbee ui [--dir <path> | --remote <url>] [--port <n>] [--open]` — boot the local
// web UI (plans/ui-v1.md rev 3.2): the SPA plus a same-origin `/v0/*` surface, either the
// reference router mounted in-process over a local bundle (`--dir`) or a reverse proxy onto a
// deployed remote (`--remote`) with conditional Bearer injection. The SPA never knows which.
//
// Source resolution follows the explicit-only remote rule (`resolveRemoteFlag`: only `--remote`
// activates HTTP; otherwise local bundle discovery) — EXCEPT `ui` builds its OWN
// remote handling (the reverse proxy in `@superbee/ui-server`) rather than routing through
// `openBundle`'s `RemoteBackend` path, since the SPA needs the raw `/v0/*` wire surface
// same-origin, not the engine-level `StorageBackend` abstraction.
//
// AXI shape mirrors `serve.ts`: the TOON receipt (the resolved, TOKENIZED url — carries the
// per-run session secret the first load exchanges for a cookie) prints FIRST, then the command
// stays in the foreground until SIGINT/SIGTERM close the listener cleanly.
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readDocVersioned, type Bundle } from "@superbee/core";
import { createRouter } from "@superbee/server";
import { openBundle, resolveRemoteFlag, resolveApiKeyEnv } from "../bundle.js";
import { resolveConceptIdCliArgument } from "../concept-id.js";
import { normalizeServer } from "../config.js";
import { getApiKeyForOrigin } from "../credentials.js";
import { bootUiServer as bootUiServerDefault, type UiServerHandle, type UiServerOptions } from "../ui/server.js";
import { writeUiUrlFile, clearUiUrlFile } from "../ui/url-file.js";
import { CliError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { resolveActor } from "../actor.js";
import { DOC_OPEN_USAGE, readErrorToCliError } from "./doc/common.js";

export const UI_USAGE = `superbee ui — boot the local web UI over the bundle: read its docs as rendered pages (cross-links, backlinks), launch its registered Views (type: View docs framed sandboxed with live updates; legacy type: Page docs are not registered — 'status' lists them and the migrate-legacy-view-names script renames them in place), and see live activity, sharing status, and your workspaces

Usage:
  superbee ui [--dir <path> | --remote <url>] [--port <n>] [--actor <name>] [--open]

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd) — mounts the
                         reference router in-process
  --remote <url>         Reverse-proxy /v0/* to a deployed remote instead (explicit only)
  --port <p>            Port to bind (default: 0 — an OS-assigned ephemeral port)
  --actor <name>        Advisory identity for human-confirmed local View actions. Precedence:
                         --actor > SUPERBEE_ACTOR > AGENTSTATE_LITE_ACTOR (legacy) > absent.
                         Read-only Views need none
  --open                Open the printed URL in a browser once the server is listening
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help

The shell header shows the bundle's DISPLAY NAME: an explicit name doc when one exists
(doc write docs/bundle --type "Bundle Name" --title "<name>" — rename later via doc update),
else the project folder's name for a conventional .superbee/ or legacy .agentstate-lite/ bundle, else the bundle
directory's name.

No --host flag in v1 — always binds 127.0.0.1 (loopback-only; a network-exposed key proxy is a
separate, unreviewed feature). The printed URL carries a per-run session token; the first load
exchanges it for an HttpOnly, SameSite=Strict cookie. One thing IS persisted: the current run's
tokenized URL is written to ~/.agentstate/ui-url (0600) for one-click re-entry — a live
credential while this run lasts, removed on clean shutdown; after a crash the leftover token is
dead (the server is gone, and the secret rotates next boot).
`;

/** Injectable seam so boot + shutdown wiring is unit-testable without real sockets/signals/spawns/home-dir writes. */
export interface UiCliDeps {
  stdout: (s: string) => void;
  bootUiServer: (options: UiServerOptions) => Promise<UiServerHandle>;
  waitForShutdown: () => Promise<void>;
  openBrowser: (url: string) => void;
  /** Record the current tokenized URL for one-click re-entry (default: `~/.agentstate/ui-url`, 0600). Injectable so tests never touch the real home dir. */
  writeUrlFile: (url: string) => Promise<void>;
  /** Remove the URL file on clean shutdown (default: the real one, only if it still points at `url`). */
  clearUrlFile: (url: string) => Promise<void>;
}

function defaultWaitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

/** Best-effort cross-platform "open a URL in the default browser" — no dependency (the CLI bundle stays zero-runtime-deps); a failure here never fails the command, since the printed URL is always the fallback. */
export function defaultOpenBrowser(url: string, spawnProcess: typeof spawn = spawn): void {
  try {
    const platform = process.platform;
    const [cmd, args] =
      platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    const child = spawnProcess(cmd, args, { stdio: "ignore", detached: true });
    // A missing platform opener (for example `xdg-open` in a minimal Linux image) reports ENOENT
    // asynchronously on ChildProcess. Contain it here: browser launch is best-effort and the URL
    // printed by the command remains the fallback.
    child.once("error", () => {});
    child.unref();
  } catch {
    // best-effort only
  }
}

/**
 * A deterministic loopback port in the IANA dynamic/private range ([49152, 65535]) derived from
 * `seed` (the bundle root, or the remote base) via FNV-1a, so re-launching `ui` over the SAME
 * bundle prefers the SAME host:port. Best-effort only — the caller falls back to an OS-assigned
 * port if this one is busy, so two instances over one bundle still both start.
 */
function stablePortFor(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const span = 65536 - 49152;
  return 49152 + (Math.abs(h) % span);
}

/** Map a raw `listen()` failure to a structured CliError — mirrors `serve.ts`'s `mapBootError` exactly. */
function mapBootError(err: unknown, port: number, commandPath = "ui"): CliError {
  if (err instanceof CliError) return err;
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    return new CliError("RUNTIME", `port ${port} is already in use — something else is listening there`, {
      help: `${cliInvocation()} ${commandPath} --port 0 (ephemeral port), or pass a different --port`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new CliError("RUNTIME", message);
}

type UiEntry = { kind: "launcher" } | { kind: "document" };

const UI_PARSE_OPTIONS = {
  dir: { type: "string" },
  remote: { type: "string" },
  port: { type: "string" },
  actor: { type: "string" },
  open: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface ParsedUiArgs {
  values: {
    dir?: string;
    remote?: string;
    port?: string;
    actor?: string;
    open?: boolean;
    json?: boolean;
    help?: boolean;
  };
  positionals: string[];
}

export async function ui(argv: string[], deps: Partial<UiCliDeps> = {}): Promise<void> {
  const parsed = parseLeafOrUsage(
    () => parseArgs({ args: argv, options: UI_PARSE_OPTIONS, allowPositionals: true }),
    CLI_LEAVES.ui,
  );
  if (parsed.values.help) {
    (deps.stdout ?? ((s: string) => void process.stdout.write(s)))(UI_USAGE);
    return;
  }
  await runUi(parsed, deps, { kind: "launcher" });
}

/** Open one exact document through the existing web DocPage; exported for the `doc open` adapter. */
export async function openDocumentUi(argv: string[], deps: Partial<UiCliDeps> = {}): Promise<void> {
  const parsed = parseLeafOrUsage(
    () => parseArgs({ args: argv, options: UI_PARSE_OPTIONS, allowPositionals: true }),
    CLI_LEAVES.docOpen,
  );
  if (parsed.values.help) {
    (deps.stdout ?? ((s: string) => void process.stdout.write(s)))(DOC_OPEN_USAGE);
    return;
  }
  await runUi(parsed, deps, { kind: "document" });
}

async function runUi({ values, positionals }: ParsedUiArgs, deps: Partial<UiCliDeps>, entry: UiEntry): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const bootUiServer = deps.bootUiServer ?? bootUiServerDefault;
  const waitForShutdown = deps.waitForShutdown ?? defaultWaitForShutdown;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const writeUrlFile = deps.writeUrlFile ?? ((url: string) => writeUiUrlFile(url));
  const clearUrlFile = deps.clearUrlFile ?? ((url: string) => clearUiUrlFile(url));

  const rawDocumentId = entry.kind === "document" ? positionals[0]! : undefined;
  const commandPath = entry.kind === "document" ? `doc open ${rawDocumentId}` : "ui";

  let port = 0; // rev 3.2: --port defaults to 0 (OS-assigned), unlike `serve`'s stable 4818 default
  const explicitPort = values.port !== undefined;
  if (values.port !== undefined) {
    const raw = values.port.trim();
    if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
      throw new CliError("USAGE", "--port must be an integer between 0 and 65535", {
        help: `${cliInvocation()} ${commandPath} --port <p>`,
      });
    }
    port = Number(raw);
  }

  const remoteFlag = await resolveRemoteFlag(values.remote, values.dir);
  const actor = resolveActor(values.actor, { help: `${cliInvocation()} ${commandPath} --actor <name>` });
  let options: UiServerOptions;
  let rootLabel: string;
  let bundle: Bundle;

  if (remoteFlag) {
    if (values.dir) {
      throw new CliError("USAGE", "--remote and --dir are mutually exclusive", {
        help: `${cliInvocation()} ${commandPath} --remote <url>`,
      });
    }
    let base: string;
    let origin: string;
    try {
      const resolved = normalizeServer(remoteFlag);
      base = resolved.base;
      origin = resolved.resource;
    } catch (err) {
      throw new CliError("USAGE", err instanceof Error ? err.message : String(err), {
        help: `${cliInvocation()} ${commandPath} --remote http://127.0.0.1:4818`,
      });
    }
    const envKey = resolveApiKeyEnv();
    const apiKey = envKey || (await getApiKeyForOrigin(origin));
    // Registered Views, kind/edge reads, and the trusted bridge share the SAME semantic
    // RemoteBackend bundle every other engine-aware command uses over --remote; the SPA's /v0
    // transport path stays the raw proxy.
    bundle = await openBundle(undefined, remoteFlag);
    options = { mode: "remote", port, remoteBase: base, apiKey, bundle, actor };
    rootLabel = base;
  } else {
    bundle = await openBundle(values.dir);
    const router = createRouter(bundle);
    options = { mode: "dir", port, router, bundle, actor };
    rootLabel = bundle.root;
  }

  let documentId: string | undefined;
  if (rawDocumentId !== undefined) {
    documentId = await resolveConceptIdCliArgument(bundle, rawDocumentId);
    try {
      await readDocVersioned(bundle, documentId);
    } catch (error) {
      throw readErrorToCliError(error, documentId, values.remote);
    }
  }

  // Tab-restart friendliness (tasks/ui-pages-spike): with no explicit --port, PREFER a stable
  // per-bundle loopback port so a re-launched `ui` over the same bundle lands on the SAME
  // host:port (the human's open tab/bookmark keeps working — it 403s until they reopen the
  // freshly-printed URL, since the session token still rotates each run, but the ADDRESS is
  // stable). If that port is taken, fall back to an OS-assigned one — never a hard failure.
  let usedStablePort = false;
  if (!explicitPort) {
    options.port = stablePortFor(rootLabel);
    usedStablePort = true;
  }

  let handle: UiServerHandle;
  try {
    handle = await bootUiServer(options);
  } catch (err) {
    if (usedStablePort && (err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      options.port = 0; // stable port busy — retry ephemeral so the command still works
      usedStablePort = false;
      try {
        handle = await bootUiServer(options);
      } catch (err2) {
        throw mapBootError(err2, 0, commandPath);
      }
    } else {
      throw mapBootError(err, options.port ?? port, commandPath);
    }
  }

  const launchUrl = new URL(`http://${handle.host}:${handle.port}/`);
  launchUrl.searchParams.set("token", handle.token);
  if (documentId !== undefined) {
    launchUrl.searchParams.set("view", "doc");
    launchUrl.searchParams.set("id", documentId);
  }
  const url = launchUrl.toString();

  // Record this run's tokenized URL for one-click re-entry after a restart (~/.agentstate/ui-url).
  // While this run lasts the file holds a LIVE credential — the URL embeds the session token —
  // which is why it gets the credentials-file discipline (0600, dir 0700), is overwritten on the
  // next boot, and is removed on clean shutdown. A crash leaves only a token the next boot's
  // fresh secret makes dead.
  await writeUrlFile(url);

  stdout(
    render(
      {
        ui: "listening",
        url,
        mode: options.mode,
        root: rootLabel,
        ...(documentId !== undefined ? { document: documentId } : {}),
        auth:
          "per-run session SECRET, minted fresh each boot; the first load exchanges the URL token for an HttpOnly, SameSite=Strict cookie. The current TOKENIZED URL — a live credential while this run lasts, since it embeds the token — is written to ~/.agentstate/ui-url (0600) for one-click re-entry and cleared on clean shutdown; a crash leaves only a stale URL whose token dies with this process (the secret rotates next boot)",
        help: [
          `open ${url} in a browser`,
          ...(usedStablePort
            ? [`this host:port is stable for this bundle — on restart, reopen the freshly-printed URL (the token rotates each run)`]
            : []),
        ],
      },
      resolveMode(values),
    ),
  );

  if (values.open || documentId !== undefined) openBrowser(url);

  // Stay in the foreground; SIGINT/SIGTERM (or the injected waitForShutdown) close the listener
  // cleanly and this resolves — exit 0. No request logs to stdout by default.
  await waitForShutdown();
  await handle.close();
  await clearUrlFile(url);
}
