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
//   holds. A write that changes `verified` is refused as `doc verify` is: sync never sends a
//   managed field, so the edit would be lost.
// - A plain local folder that carries a checkout marker but no binding (moved, copied or restored)
//   is not a checkout: nothing written there reaches the host, and `sync` refuses it
//   (`unbound_copy`). It is served for reading, and every write is refused the same way until it is
//   adopted, or its marker is deleted to keep it as a plain local bundle. A Git board carrying a
//   marker syncs through Git, as `sync` treats it, and is served unchanged.
//
// The guard sits on the storage backend, the one path every MCP write takes, so no tool goes around
// it. Every backend method is classified as a read or a write at compile time; a method the table
// does not name is refused. `mcp-app` stays free of hosted knowledge: the CLI hands it the bundle
// already wrapped, from both open paths (the catalog resolver and `mcp --dir`).
import { homedir } from "node:os";
import path from "node:path";

import { assertSafeConceptId, okfValuesEqual, pathFromConceptId, stringifyDoc, type Bundle, type Frontmatter, type OkfDocument, type StorageBackend, type WriteOptions } from "@superbee/core";

import { maybeHostedAutoPull, type HostedAutoPullOptions } from "../autopull.js";
import { resolveLocalBundleTarget } from "../bundle.js";
import { configuredBundle } from "../filesystem-runtime.js";
import { defaultHostedAuthDeps } from "../hosted-auth/session.js";
import { bindingForPath, type CheckoutBinding } from "./binding.js";
import { storeOkfVersion, withIdleCheckoutStore } from "./checkout-store.js";
import { HOSTED_AUTOPULL_STALE_MS } from "./freshness.js";
import { bundleHomeAt, unboundLocalCopyAt, type UnboundCopy } from "../bundle-home.js";
import { readCheckoutMarker } from "./marker.js";
import { hostedHeldWriteRefusal, hostedManagedFieldRefusal, unboundCopyRefusal } from "./refusals.js";
import { heldPathMessage, heldPathReason, unsendable, type HeldFile } from "./sync-scan.js";

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
 * then with the checkout's guard on its backend, or an unbound copy of one, then with every write
 * refused. The binding is read fresh from private state by the bundle's canonical root, never taken
 * from the catalog or the command line.
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
  const backend = (): StorageBackend => bundle.backend ?? configuredBundle(bundle.root).backend!;
  if (binding) {
    const folder = backend();
    return guardedBundle(bundle, folder, checkoutGuard(binding, home, folder, options));
  }
  // Most folders carry no marker: that one small read spares every MCP call the Git lookups below.
  if (readCheckoutMarker(root) === null) return bundle;
  const copy = await unboundLocalCopyAt(root, { home });
  if (!copy) return bundle;
  const folder = backend();
  return guardedBundle(bundle, folder, unboundCopyGuard(copy, home, folder, options));
}

function guardedBundle(bundle: Bundle, backend: StorageBackend, guard: CheckoutGuard): Bundle {
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

/**
 * The guard on an unbound copy. Reads are served as they are: there is no binding to pull with.
 * Each write derives the folder's home again (`bundleHomeAt`): once it is adopted (bound), the
 * checkout's own guard takes over for the rest of the session; while it is still a local copy, the
 * write is refused; anything else (its marker deleted to keep it as a plain local bundle, or the
 * folder made a Git board) goes through, as `sync` would take it.
 */
function unboundCopyGuard(copy: UnboundCopy, home: string, folder: StorageBackend, options: ServedBundleOptions): CheckoutGuard {
  let adopted: CheckoutGuard | null = null;
  return {
    freshen: async () => adopted?.freshen(),
    async admit(method, args) {
      if (!adopted) {
        const facts = await bundleHomeAt(copy.folder, { home });
        if (facts.home === "hosted") adopted = checkoutGuard(facts.binding, home, folder, options);
        else if (facts.home === "local" && facts.copy) {
          throw unboundCopyRefusal(facts.copy, "FORBIDDEN", `'mcp write' refused: ${copy.folder} is a copy of a hosted checkout of '${facts.copy.marker.bundle_id}' that is not bound here, so nothing written in it reaches the host`, { command: "mcp write" });
        } else return;
      }
      return adopted.admit(method, args);
    },
  };
}

/** When this process last started an automatic pull of each checkout (by home and checkout), and the pull in flight. */
const lastPulls = new Map<string, { at: number; pending: Promise<void> }>();

function checkoutGuard(binding: CheckoutBinding, home: string, folder: StorageBackend, options: ServedBundleOptions): CheckoutGuard {
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
    if (reason === "convention_folder") refuse({ id, path: rel, reason, message: heldPathMessage(rel) });
    if (reason !== null) refuse({ id, path: rel, reason, message: `${rel} is a reserved OKF file, which sync does not send` });
    return rel;
  };
  return {
    freshen() {
      const key = `${home}\0${binding.checkout_id}`;
      const last = lastPulls.get(key);
      if (last && Date.now() - last.at < HOSTED_AUTOPULL_STALE_MS) return last.pending;
      const pending = maybeHostedAutoPull(binding, { sync: { auth: defaultHostedAuthDeps(home) }, ...options.autoPull }).then(
        () => undefined,
        () => undefined,
      );
      lastPulls.set(key, { at: Date.now(), pending });
      return pending;
    },
    async admit(method, args) {
      switch (method) {
        case "write": {
          const [id, doc, writeOptions] = args as [string, OkfDocument, WriteOptions | undefined];
          const rel = documentPath(id);
          const bytes = Buffer.from(stringifyDoc(doc.frontmatter, doc.body ?? ""), "utf8");
          const stored = await storedDocument(binding, home, folder, id);
          const held = unsendable(id, rel, bytes, stored.frontmatter ? { frontmatter: stored.frontmatter } : null, { bundleId: binding.bundle_id, okfVersion: stored.okfVersion });
          if (held) refuse(held);
          // Against the folder's current document, which every write carries `verified` forward
          // from, so only a write that sets it differently is refused. A write made against an
          // older version is left to the version check, which answers a conflict the caller can
          // retry (a pull may have brought a new verification in meanwhile).
          const current = await folder.read(id).then((read) => read, () => null);
          const expected = writeOptions?.expectedVersion;
          const stale = expected !== undefined && expected !== (current?.version ?? null);
          if (!stale && !okfValuesEqual(doc.frontmatter.verified, current?.doc.frontmatter.verified)) throw hostedManagedFieldRefusal(binding, id);
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
          const reason = heldPathReason(key) ?? "not_a_document";
          const message = reason === "convention_folder" ? heldPathMessage(key) : reason === "reserved_file" ? `${key} is a reserved OKF file, which sync does not send` : `${key} is not a .md document; files other than documents do not sync`;
          return refuse({ id: key, path: key, reason, message });
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
 * runs, the guard never waits on it: it reads the folder's current document instead (through the
 * folder's own, unguarded backend), which sync is bringing up to the host's version. The residual:
 * a file already retyped by hand is not caught then, and the scan still holds it (`type_change`), so
 * nothing wrong is ever sent.
 */
async function storedDocument(binding: CheckoutBinding, home: string, folder: StorageBackend, id: string): Promise<{ frontmatter: Frontmatter | null; okfVersion: "0.1" | "0.2" | undefined }> {
  const fromStore = await withIdleCheckoutStore(binding, home, async (store) => ({
    frontmatter: (await store.readWithJournal(id)).document?.doc.frontmatter ?? null,
    okfVersion: await storeOkfVersion(store),
  }));
  if (fromStore) return fromStore;
  const frontmatter = await folder.read(id).then((read) => read.doc.frontmatter, () => null);
  return { frontmatter, okfVersion: await storeOkfVersion(folder) };
}
