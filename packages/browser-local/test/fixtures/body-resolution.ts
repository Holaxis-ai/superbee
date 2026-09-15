/**
 * One body-mode working copy over the synthetic body authority, plus the two ways a local edit
 * ends up contested: the authority moved its head (`conflict`) or refused the content
 * (`refused`). Shared by the body delivery and body resolution tests over both adapters.
 */
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbBackend, type IdbFactoryLike } from "@superbee/core/indexeddb-backend";
import type { OperationTransport } from "@superbee/core/uncertain-write";
import { openLocalBundle, bootstrap, push } from "../../src/local-bundle.ts";
import { admitBodyMode, bodySnapshot } from "../../src/body-journal.ts";
import { createBrowserLocalRuntime } from "../../src/platform/browser-local.ts";
import { MemoryJournaledBackend } from "./memory-journaled-backend.ts";
import { createBodyAuthority } from "./body-authority.ts";

/** Body mode never delivers through the exact-document transport; any call is a defect. */
export const exact: OperationTransport = { submit: async () => { throw new Error("Unexpected exact-document submission"); }, lookup: async () => { throw new Error("Unexpected exact-document lookup"); } };
export const immediate = { sleep: async () => {}, lookupDelayMs: 0, maxLookups: 1 };
export type Adapter = "memory" | "indexeddb";
export const ADAPTERS: readonly Adapter[] = ["memory", "indexeddb"];

export function makeBackend(adapter: Adapter, factory?: IdbFactoryLike, name?: string) {
  return adapter === "memory" ? new MemoryJournaledBackend() : new IndexedDbBackend({ databaseName: name ?? crypto.randomUUID(), indexedDB: factory ?? new IDBFactory() });
}

export async function setup(adapter: Adapter, okfVersion: "0.1" | "0.2" = "0.2", backend = makeBackend(adapter)) {
  const local = openLocalBundle("body-test", { backend, bodyDelivery: { scope: "fixture", okfVersion, dedicated: true } });
  const authority = await createBodyAuthority(undefined, okfVersion);
  await bootstrap(authority.backend, local);
  const runtime = createBrowserLocalRuntime({ local, remote: authority.backend, transport: exact, bodyTransport: authority.transport, actor: "process:local", now: () => "2026-09-15T00:30:00.000Z", write: immediate });
  return { local, backend, authority, runtime, close: () => local.close() };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A local body edit the authority answers with a moved head (`conflict`) or a content refusal (`refused`). */
export async function contested(s: Setup, head: "conflict" | "refused", body = "Retain this work") {
  await s.runtime.commit("notes/example", { body });
  if (head === "conflict") {
    const remote = await s.authority.backend.read("notes/example");
    await s.authority.backend.write("notes/example", { ...remote.doc, body: "Concurrent authority edit" });
  } else s.authority.knobs.contentRefusal = true;
  await push(s.local, exact, { bodyTransport: s.authority.transport, remote: s.authority.backend, write: immediate });
  s.authority.knobs.contentRefusal = false;
  const chain = (await s.backend.listIntents()).filter(row => row.state !== "acknowledged");
  assert.deepEqual(chain.map(row => row.state), [head]);
  return chain[0]!;
}

/** The full body guard of one target: the premise every guarded verb composes against. */
export const guardOf = async (s: Setup, id = "notes/example") => (await bodySnapshot(s.backend, id, (await admitBodyMode(s.backend))!)).guard;

export const choices = [{ kind: "keep-local" }, { kind: "take-remote" }, { kind: "revise", body: "Replacement" }] as const;
