// A bundle as the local MCP app serves it. A hosted checkout is served through its folder, like
// every other bundle (designs/seamless-multi-backend-cli, section 4.3):
//
// - Reads come from the folder, kept fresh by the checkout's automatic pull (the one CLI reads
//   run), at most once per checkout per stale window in this process. Notes go to stderr only; a
//   pull never starts a sign-in.
// - A document write sync can send is written to the folder exactly as `doc update` writes it, and
//   reaches the host at the next `sync` or Stop hook.
// - A write sync would hold is refused before the file is touched, with the reason the sync scan
//   would record (`HeldReason`): blobs (View entries), reserved files, documents under the folders
//   of conventions the app edits (`conventions/`, `views/`), and a document write `unsendable`
//   rejects (a type change, over the host's bounds, not sendable, an unsafe id). A case collision
//   needs the host's listing, and a mass deletion the deletion window, so both stay scan-time
//   holds.
//
// The guard sits on the storage backend, the one path every MCP write takes, so no tool goes around
// it. Every backend method is classified as a read or a write at compile time; a method the table
// does not name is refused. `mcp-app` stays free of hosted knowledge: the CLI hands it the bundle
// already wrapped, from both open paths (the catalog resolver and `mcp --dir`).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { assertSafeConceptId, parseMarkdown, pathFromConceptId, stringifyDoc, type Bundle, type Frontmatter, type OkfDocument, type StorageBackend } from "@superbee/core";

import { maybeHostedAutoPull, type HostedAutoPullOptions } from "../autopull.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { configuredBundle } from "../filesystem-runtime.js";
import { defaultHostedAuthDeps } from "../hosted-auth/session.js";
import { bindingForPath, type CheckoutBinding } from "./binding.js";
import { storeOkfVersion, withIdleCheckoutStore } from "./checkout-store.js";
import { HOSTED_AUTOPULL_STALE_MS } from "./freshness.js";
import { hostedHeldWriteRefusal } from "./refusals.js";
import { heldPathReason, unsendable, type HeldFile } from "./sync-scan.js";

/** Every storage backend method, as the guard treats it. The compiler keeps the table complete. */
const ACCESS = {
  read: "read",
  readMany: "read",
  exists: "read",
  list: "read",
  versions: "read",
  readReserved: "read",
  readBlob: "read",
  existsBlob: "read",
  listBlobs: "read",
  queryHeads: "read",
  capabilities: "meta",
  write: "write",
  delete: "write",
  writeReserved: "write",
  writeBlob: "write",
  deleteBlob: "write",
} as const satisfies Record<keyof StorageBackend, "read" | "write" | "meta">;

type Method = keyof typeof ACCESS;

const isMethod = (property: string | symbol): property is Method => typeof property === "string" && Object.hasOwn(ACCESS, property);

export interface ServedBundleOptions {
  /** The home whose private state holds the checkout bindings (default: the user's). */
  readonly home?: string;
  /**
   * The automatic pull's seams (tests pass the fake host's). Its notes go to stderr by default: the
   * MCP app's stdout is its protocol channel.
   */
  readonly autoPull?: HostedAutoPullOptions;
}

/**
 * The bundle as the local MCP app serves it: unchanged unless its root is a live hosted checkout,
 * then with the checkout's guard on its backend. The binding is read fresh from private state by
 * the bundle's canonical root, never taken from the catalog or the command line.
 */
export async function servedBundle(bundle: Bundle, options: ServedBundleOptions = {}): Promise<Bundle> {
  const home = options.home ?? homedir();
  let root: string;
  try {
    root = (await resolveLocalBundleTarget(bundle.root)).canonicalRoot;
  } catch {
    // Not a folder on this machine (an in-memory bundle): nothing a checkout binding could name.
    return bundle;
  }
  const binding = await bindingForPath(home, root);
  if (!binding) return bundle;
  const backend: StorageBackend = bundle.backend ?? configuredBundle(bundle.root).backend!;
  const guard = checkoutGuard(binding, home, root, options);
  const guarded = new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      // The backend keeps private fields, so its methods run against the backend itself.
      const method = (value as (...args: unknown[]) => unknown).bind(target);
      if (!isMethod(property)) {
        return () => {
          throw new Error(`the hosted checkout guard does not know the storage method '${String(property)}'`);
        };
      }
      switch (ACCESS[property]) {
        case "meta":
          return method;
        case "read":
          return async (...args: unknown[]) => {
            await guard.freshen();
            return method(...args);
          };
        case "write":
          return async (...args: unknown[]) => {
            await guard.admit(property, args);
            return method(...args);
          };
      }
    },
  });
  return Object.freeze({ ...bundle, backend: guarded });
}

interface CheckoutGuard {
  /** The automatic pull, at most once per checkout per stale window in this process. */
  freshen(): Promise<void>;
  /** Throw the held refusal for a write sync could not send; resolve for one it can. */
  admit(method: Method, args: readonly unknown[]): Promise<void>;
}

/** When this process last started an automatic pull of each checkout, and the pull in flight. */
const lastPulls = new Map<string, { at: number; pending: Promise<void> }>();

function checkoutGuard(binding: CheckoutBinding, home: string, root: string, options: ServedBundleOptions): CheckoutGuard {
  const refuse = (held: HeldFile): never => {
    throw hostedHeldWriteRefusal(binding, held);
  };
  const documentPath = (id: string): string => {
    try {
      assertSafeConceptId(id);
    } catch (error) {
      return refuse({ id, path: id, reason: "unsafe_path", message: `'${id}' cannot be a document id (${(error as Error).message})` });
    }
    const rel = pathFromConceptId(id);
    const reason = heldPathReason(rel);
    if (reason === "convention_folder") refuse({ id, path: rel, reason, message: `${rel} is under ${rel.split("/")[0]}/, which holds conventions edited in the Superbee app` });
    if (reason !== null) refuse({ id, path: rel, reason, message: `${rel} is a reserved OKF file, which sync does not send` });
    return rel;
  };
  return {
    freshen() {
      const last = lastPulls.get(binding.checkout_id);
      if (last && Date.now() - last.at < HOSTED_AUTOPULL_STALE_MS) return last.pending;
      const pending = maybeHostedAutoPull(binding, { sync: { auth: defaultHostedAuthDeps(home) }, ...options.autoPull }).then(
        () => undefined,
        () => undefined,
      );
      lastPulls.set(binding.checkout_id, { at: Date.now(), pending });
      return pending;
    },
    async admit(method, args) {
      switch (method) {
        case "write": {
          const [id, doc] = args as [string, OkfDocument];
          const rel = documentPath(id);
          const bytes = Buffer.from(stringifyDoc(doc.frontmatter, doc.body ?? ""), "utf8");
          const stored = await storedDocument(binding, home, root, id, rel);
          const held = unsendable(id, rel, bytes, stored.frontmatter ? { frontmatter: stored.frontmatter } : null, { bundleId: binding.bundle_id, okfVersion: stored.okfVersion });
          if (held) refuse(held);
          return;
        }
        case "delete":
          // A document delete syncs; the mass-delete hold is decided by the scan over its window.
          documentPath(args[0] as string);
          return;
        case "writeReserved":
          return refuse({ id: String(args[1]), path: path.posix.join(String(args[0] ?? ""), String(args[1])), reason: "reserved_file", message: `${String(args[1])} is a reserved OKF file, which sync does not send` });
        case "writeBlob":
        case "deleteBlob": {
          const key = String(args[0]);
          return refuse({ id: key, path: key, reason: heldPathReason(key) ?? "not_a_document", message: `${key} is not a .md document; files other than documents do not sync` });
        }
        default:
          return refuse({ id: String(args[0]), path: String(args[0]), reason: "not_sendable", message: `'${method}' is not a write sync sends` });
      }
    },
  };
}

/**
 * The document as sync last accounted it, for the type-change rule, and the checkout's OKF edition.
 * Read from the checkout's private store when no other command holds the checkout. While a sync
 * runs, the guard never waits on it: it reads the folder's current file instead, which sync is
 * bringing up to the host's version. The residual: a file already retyped by hand is not caught
 * then, and the scan still holds it (`type_change`), so nothing wrong is ever sent.
 */
async function storedDocument(binding: CheckoutBinding, home: string, root: string, id: string, rel: string): Promise<{ frontmatter: Frontmatter | null; okfVersion: "0.1" | "0.2" | undefined }> {
  const fromStore = await withIdleCheckoutStore(binding, home, async (store) => ({
    frontmatter: (await store.readWithJournal(id)).document?.doc.frontmatter ?? null,
    okfVersion: await storeOkfVersion(store),
  }));
  if (fromStore) return fromStore;
  const okfVersion = await folderOkfVersion(root);
  const text = await readFile(path.join(root, rel), "utf8").catch(() => null);
  if (text === null) return { frontmatter: null, okfVersion };
  try {
    return { frontmatter: parseMarkdown(text, id, { okfVersion }).frontmatter, okfVersion };
  } catch {
    return { frontmatter: null, okfVersion };
  }
}

async function folderOkfVersion(root: string): Promise<"0.1" | "0.2" | undefined> {
  try {
    const version = parseMarkdown(await readFile(path.join(root, "index.md"), "utf8"), "index").frontmatter.okf_version;
    return version === "0.1" || version === "0.2" ? version : undefined;
  } catch {
    return undefined;
  }
}
