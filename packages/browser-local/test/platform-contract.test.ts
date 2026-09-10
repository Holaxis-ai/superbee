/**
 * The platform contract kit in Node: every row of `platform-contract.ts` against a
 * request-driven runtime over the in-process remote fixture and a browser-local runtime over
 * fake-indexeddb bootstrapped from the same fixture. Each session is a fresh authority seeded
 * with the synthetic bundle; the carrier can be cut off per session, and the fixture's write
 * knobs are flipped from here.
 */
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import { RemoteBackend, type Version } from "@superbee/core";
import type { ExecutionMode, PlatformRuntime } from "@superbee/core/platform";
import { createRemoteOperationTransport } from "@superbee/core/remote-operations";

import { bootstrap, openLocalBundle, UNSETTLED_STATES, type LocalBundle } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime, createRequestDrivenRuntime } from "../src/platform/index.ts";
import { BASE_URL, BUNDLE, createRemoteFixture, type FixtureKnobs } from "./fixtures/remote-fixture.ts";
import {
  CONTRACT_ACTOR,
  CONTRACT_NOW,
  MODES,
  platformContractRows,
  runRow,
  seedSyntheticBundle,
  type ContractHarness,
  type ContractSession,
  type WriteKnob,
} from "./platform-contract.ts";

const immediate = { sleep: async () => {}, lookupDelayMs: 0 };
const now = () => CONTRACT_NOW;

const harness: ContractHarness = {
  async open(mode: ExecutionMode): Promise<ContractSession> {
    const fixture = await createRemoteFixture();
    await seedSyntheticBundle(fixture.authority);
    const offline = { flag: false };
    const carrier = (request: Request): Promise<Response> =>
      offline.flag ? Promise.reject(new TypeError("fetch failed: client is offline")) : fixture.hosted(request);
    const remote = new RemoteBackend({ baseUrl: BASE_URL, bundle: BUNDLE, fetchImpl: carrier, maxRetries: 0 });
    const factory = new IDBFactory();
    const locals: LocalBundle[] = [];

    const runtimeOf = async (name: string): Promise<PlatformRuntime> => {
      if (mode === "request-driven") return createRequestDrivenRuntime({ remote, actor: CONTRACT_ACTOR, now });
      const local = openLocalBundle(name, { indexedDB: factory });
      locals.push(local);
      await bootstrap(remote, local);
      return createBrowserLocalRuntime({ local, remote, transport: createRemoteOperationTransport(remote), write: immediate, actor: CONTRACT_ACTOR, now });
    };

    const runtime = await runtimeOf("first");
    return {
      mode,
      runtime,
      authority: {
        read: async (id) => {
          const { doc, version } = await fixture.authority.read(id);
          return { version, body: doc.body };
        },
        write: async (id, body): Promise<Version> => {
          const { doc, version } = await fixture.authority.read(id);
          return fixture.authority.write(id, { ...doc, body }, { expectedVersion: version });
        },
      },
      secondClient: () => runtimeOf("second"),
      setOffline: async (flag) => {
        offline.flag = flag;
      },
      setKnob: async (name: WriteKnob, flag) => {
        (fixture.knobs as FixtureKnobs)[name] = flag;
      },
      unsettled: async (id) => {
        const local = locals[0];
        if (!local) return [];
        return (await local.backend.listIntents(UNSETTLED_STATES)).filter((row) => row.target === id).map((row) => ({ requestId: row.requestId, state: row.state }));
      },
      restore: async () => {
        offline.flag = false;
        fixture.knobs.unauthorized = false;
        fixture.knobs.dropAfterApply = false;
        fixture.knobs.failBeforeApply = false;
      },
      close: async () => {
        for (const local of locals) local.close();
      },
    };
  },
};

const rows = platformContractRows();

test(`the contract kit covers ${rows.length} rows across ${MODES.length} modes`, () => {
  if (rows.length < 10) throw new Error(`expected at least ten rows, found ${rows.length}`);
});

for (const row of rows) {
  test(`${row.verb}: ${row.name}`, async () => {
    await runRow(harness, row);
  });
}
