// `superbee ui [--dir <path> | --remote <url> --bundle <bundle_id>] [--port <n>] [--open]` — boot the local
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
import type { UiManagementOptions } from "@superbee/ui-server";
import {
  assertResolvedLocalRouteIdentity,
  openBundle,
  resolveLocalBundleRoute,
  resolveLocalBundleTarget,
  resolveRemoteFlag,
} from "../bundle.js";
import { resolveConceptIdCliArgument } from "../concept-id.js";
import { bootUiServer as bootUiServerDefault, type UiServerHandle, type UiServerOptions } from "../ui/server.js";
import { writeUiUrlFile, clearUiUrlFile } from "../ui/url-file.js";
import { CliError } from "../errors.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { render, resolveMode } from "../output.js";
import { cliInvocation } from "../invocation.js";
import { resolveActor } from "../actor.js";
import { DOC_OPEN_USAGE, readErrorToCliError } from "./doc/common.js";
import { commandFragment, commandToken, commandWords } from "../command-text.js";
import { isRenderableToken } from "../shell-quoting.js";
import {
  captureManagedUiLaunchIdentity,
  listManagedUiStatus,
  managedUiAuthority,
  startOrReuseManagedUi,
  stopManagedUi,
  type ManagedUiControllerOptions,
} from "../ui/managed-authority.js";

export const UI_USAGE = `superbee ui — boot the local web UI over the bundle: read its docs as rendered pages (cross-links, backlinks), launch its registered Views (type: View docs framed sandboxed with live updates; legacy type: Page docs are not registered — 'status' lists them and the migrate-legacy-view-names script renames them in place), and see live activity, sharing status, and your workspaces

Usage:
  superbee ui [--dir <path> | --remote <url> --bundle <bundle_id>] [--port <n>] [--actor <name>] [--open]
  superbee ui --status [--dir <path>] [--limit <n>]
  superbee ui --stop [--dir <path>] [--actor <name>]

Options:
  --dir <path>          Bundle directory (default: discovered from the cwd) — mounts the
                         reference router in-process
  --remote <url>         Reverse-proxy /v0/* to a deployed remote instead (explicit only)
  --bundle <bundle_id> Select the exact hosted bundle (requires --remote)
  --port <p>            Port to bind (default: 0 — an OS-assigned ephemeral port)
  --actor <name>        Advisory identity for human-confirmed local View actions. Precedence:
                         --actor > SUPERBEE_ACTOR > AGENTSTATE_LITE_ACTOR (legacy) > absent.
                         Read-only Views need none
  --open                Open the printed URL in a browser once the server is listening
  --status              List managed local document authorities for the selected bundle
  --stop                Stop the exact managed local authority selected by bundle + resolved actor
  --limit <n>           Maximum status rows (default: 20; 0 = all)
  --json                Emit compact JSON instead of TOON
  -h, --help            Show this help

The shell header shows the bundle's DISPLAY NAME: an explicit name doc when one exists
(doc write docs/bundle --type "Bundle Name" --title "<name>" — rename later via doc update),
else the project folder's name for a conventional .superbee/ or legacy .agentstate-lite/ bundle, else the bundle
directory's name.

No --host flag in v1 — always binds 127.0.0.1 (loopback-only; a network-exposed key proxy is a
separate, unreviewed feature). The printed URL carries a per-run session token; the first load
exchanges it for an HttpOnly, SameSite=Strict cookie. One thing IS persisted: the current run's
tokenized URL is written to the private user-state root for one-click re-entry — a live
credential while this run lasts, removed on clean shutdown; after a crash the leftover token is
dead (the server is gone, and the secret rotates next boot).
`;

/** Injectable seam so boot + shutdown wiring is unit-testable without real sockets/signals/spawns/home-dir writes. */
export interface UiCliDeps {
  stdout: (s: string) => void;
  bootUiServer: (options: UiServerOptions) => Promise<UiServerHandle>;
  waitForShutdown: (handle?: UiServerHandle) => Promise<void>;
  openBrowser: (url: string) => void;
  /** Record the current tokenized URL for one-click re-entry in private user state. Injectable so tests never touch the real profile. */
  writeUrlFile: (url: string) => Promise<void>;
  /** Remove the URL file on clean shutdown (default: the real one, only if it still points at `url`). */
  clearUrlFile: (url: string) => Promise<void>;
  /** Private managed-child seam; public foreground callers never supply it. */
  management?: UiManagementOptions;
  /** Private managed-child cookie isolation; foreground callers keep the compatibility default. */
  sessionCookieName?: string;
  /** Managed-controller injection used by lifecycle tests. */
  managedController?: ManagedUiControllerOptions;
  /** Private managed-child seam: an already-selected and revalidated local bundle. */
  localBundle?: Bundle;
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
      help: `${cliInvocation()} ${commandWords(commandPath)} --port 0 (ephemeral port), or pass a different --port`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new CliError("RUNTIME", message);
}

type UiEntry = { kind: "launcher" } | { kind: "document" };

const UI_PARSE_OPTIONS = {
  dir: { type: "string" },
  remote: { type: "string" },
  bundle: { type: "string" },
  port: { type: "string" },
  actor: { type: "string" },
  open: { type: "boolean" },
  status: { type: "boolean" },
  stop: { type: "boolean" },
  limit: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface ParsedUiArgs {
  values: {
    dir?: string;
    remote?: string;
    bundle?: string;
    port?: string;
    actor?: string;
    open?: boolean;
    status?: boolean;
    stop?: boolean;
    limit?: string;
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
  if (parsed.values.status || parsed.values.stop) {
    await runManagedUiControl(parsed, deps);
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
  const remoteFlag = await resolveRemoteFlag(parsed.values.remote, parsed.values.dir, parsed.values.bundle);
  if (remoteFlag !== undefined) {
    await runUi(parsed, deps, { kind: "document" });
    return;
  }
  await runManagedDocumentUi(parsed, deps);
}

function parsedPort(raw: string | undefined, commandPath: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed) || Number(trimmed) > 65535) {
    throw new CliError("USAGE", "--port must be an integer between 0 and 65535", {
      help: `${cliInvocation()} ${commandWords(commandPath)} --port <p>`,
    });
  }
  return Number(trimmed);
}

async function runManagedDocumentUi(
  { values, positionals }: ParsedUiArgs,
  deps: Partial<UiCliDeps>,
): Promise<void> {
  if (values.status || values.stop) throw new CliError("USAGE", "doc open does not accept --status or --stop");
  const rawDocumentId = positionals[0]!;
  const route = await resolveLocalBundleRoute(values.dir);
  await assertResolvedLocalRouteIdentity(route);
  const target = route.target;
  const bundle = route.bundle;
  const documentId = await resolveConceptIdCliArgument(bundle, rawDocumentId);
  try {
    await readDocVersioned(bundle, documentId);
  } catch (error) {
    throw readErrorToCliError(error, documentId, undefined);
  }
  const actor = resolveActor(values.actor, { help: `${cliInvocation()} doc open --actor <name>` });
  const requestedPort = parsedPort(values.port, `doc open ${rawDocumentId}`);
  const authority = managedUiAuthority(target.canonicalRoot, actor, bundle.root);
  const receipt = await startOrReuseManagedUi(authority, documentId, requestedPort, {
    ...deps.managedController,
    launchIdentity: deps.managedController?.launchIdentity ?? await captureManagedUiLaunchIdentity(authority),
  });
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  stdout(render({
    ui: "managed",
    state: receipt.state,
    url: receipt.url,
    mode: "dir",
    root: target.canonicalRoot,
    document: documentId,
    actor: authority.actor,
    actor_present: authority.actor !== null,
    help: [`open ${receipt.url} in a browser`, `${cliInvocation()} ui --status --dir ${commandToken(target.canonicalRoot)}`],
  }, resolveMode(values)));
  openBrowser(receipt.url);
}

async function runManagedUiControl(
  { values, positionals }: ParsedUiArgs,
  deps: Partial<UiCliDeps>,
): Promise<void> {
  if (values.status && values.stop) throw new CliError("USAGE", "--status and --stop are mutually exclusive");
  if (values.remote !== undefined || values.bundle !== undefined) {
    throw new CliError("USAGE", "managed UI status and stop are local-only; --remote and --bundle apply only to foreground UI");
  }
  if (values.port !== undefined || values.open || positionals.length > 0) {
    throw new CliError("USAGE", "ui --status/--stop accept only their documented --dir, --actor, --limit, and --json options");
  }
  const target = await resolveLocalBundleTarget(values.dir);
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  if (values.status) {
    if (values.actor !== undefined) throw new CliError("USAGE", "ui --status lists every actor authority and does not accept --actor");
    const rawLimit = values.limit ?? "20";
    if (!/^\d+$/u.test(rawLimit)) throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)");
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit)) throw new CliError("USAGE", "--limit must be a non-negative safe integer (0 = unlimited)");
    const instances = await listManagedUiStatus(target.canonicalRoot, deps.managedController);
    const rows = instances.map((item) => ({
      actor: item.authority.actor,
      actor_present: item.authority.actor !== null,
      phase: item.phase,
      live: item.live,
      port: item.port,
      ...(item.active_clients === undefined ? {} : { active_clients: item.active_clients }),
      started_at: item.started_at,
    }));
    const shown = limit === 0 ? rows : rows.slice(0, limit);
    stdout(render({
      ui: "managed-status",
      root: target.canonicalRoot,
      count: rows.length,
      shown: shown.length,
      instances: shown,
      ...(shown.length < rows.length
        ? { help: [`${cliInvocation()} ui --status --dir ${commandToken(target.canonicalRoot)} --limit 0`] }
        : {}),
    }, resolveMode(values)));
    return;
  }
  if (values.limit !== undefined) throw new CliError("USAGE", "--limit is available only with ui --status");
  const actor = resolveActor(values.actor, { help: `${cliInvocation()} ui --stop --dir ${commandToken(target.canonicalRoot)} --actor <name>` });
  const result = await stopManagedUi(managedUiAuthority(target.canonicalRoot, actor), deps.managedController);
  stdout(render({
    ui: "managed-stop",
    root: target.canonicalRoot,
    actor: actor ?? null,
    actor_present: actor !== undefined,
    stopped: result.stopped,
  }, resolveMode(values)));
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
        help: `${cliInvocation()} ${commandWords(commandPath)} --port <p>`,
      });
    }
    port = Number(raw);
  }

  const remoteFlag = await resolveRemoteFlag(values.remote, values.dir, values.bundle);
  const actor = resolveActor(values.actor, { help: `${cliInvocation()} ${commandWords(commandPath)} --actor <name>` });
  const renderDocumentOpenCommand = (id: string): string | null => {
    if (!isRenderableToken(id)) return null;
    if (remoteFlag && (!isRenderableToken(remoteFlag.baseUrl) || !isRenderableToken(remoteFlag.bundleId))) return null;
    if (!remoteFlag && !isRenderableToken(bundle.root)) return null;
    const sourceArgs = remoteFlag
      ? commandFragment`--remote ${commandToken(remoteFlag.baseUrl)} --bundle ${commandToken(remoteFlag.bundleId)}`
      : commandFragment`--dir ${commandToken(bundle.root)}`;
    const actorFlag = actor === undefined
      ? commandFragment``
      : commandFragment` --actor ${commandToken(actor)}`;
    return explicitPort
      ? commandFragment`${cliInvocation()} doc open ${sourceArgs} --port ${commandToken(String(port))}${actorFlag} -- ${commandToken(id)}`
      : commandFragment`${cliInvocation()} doc open ${sourceArgs}${actorFlag} -- ${commandToken(id)}`;
  };
  let options: UiServerOptions;
  let rootLabel: string;
  let bundle: Bundle;

  if (remoteFlag) {
    // Registered Views, kind/edge reads, and the trusted bridge share the SAME semantic
    // RemoteBackend bundle every other engine-aware command uses over --remote; the SPA's /v0
    // transport path stays the raw proxy.
    bundle = await openBundle(undefined, remoteFlag);
    options = { mode: "remote", port, remote: remoteFlag, bundle, actor, renderDocumentOpenCommand };
    rootLabel = bundle.root;
  } else {
    bundle = deps.localBundle ?? await openBundle(values.dir);
    const router = createRouter(bundle);
    options = {
      mode: "dir",
      port,
      router,
      bundle,
      actor,
      renderDocumentOpenCommand,
      ...(deps.management ? { management: deps.management } : {}),
      ...(deps.sessionCookieName ? { sessionCookieName: deps.sessionCookieName } : {}),
    };
    rootLabel = bundle.root;
  }

  let documentId: string | undefined;
  if (rawDocumentId !== undefined) {
    const resolvedDocumentId = await resolveConceptIdCliArgument(bundle, rawDocumentId);
    documentId = resolvedDocumentId;
    try {
      await readDocVersioned(bundle, resolvedDocumentId);
    } catch (error) {
      throw readErrorToCliError(error, resolvedDocumentId, values.remote, values.bundle);
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

  // Record this run's tokenized URL for one-click re-entry after a restart.
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
          "per-run session SECRET, minted fresh each boot; the first load exchanges the URL token for an HttpOnly, SameSite=Strict cookie. The current TOKENIZED URL — a live credential while this run lasts, since it embeds the token — is written to private user state for one-click re-entry and cleared on clean shutdown; a crash leaves only a stale URL whose token dies with this process (the secret rotates next boot)",
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
  await waitForShutdown(handle);
  await handle.close();
  await clearUrlFile(url);
}
