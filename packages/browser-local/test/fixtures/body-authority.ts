/** Synthetic authority port: core authors content; immutable results survive client replacement. */
import { MemoryBackend, type StorageBackend } from "@superbee/core";
import { mutateDocument } from "@superbee/core/document-mutation";
import { stringifyDoc } from "@superbee/core/document-codec";
import { validatePreparedBodyDelivery, assertSameBodyDelivery, type PreparedBodyDelivery, type BodyDeliveryOutcome, type BodyDeliveryTransport } from "@superbee/core/governed-body-write";
import { VersionConflict } from "@superbee/core/versioning";

export async function createBodyAuthority(backend: StorageBackend = new MemoryBackend(), okfVersion: "0.1" | "0.2" = "0.2") {
  await backend.writeReserved("", "index.md", `---\nokf_version: '${okfVersion}'\n---\n# Synthetic body delivery\n`);
  const bundle = { root: "memory://body-authority", backend };
  const registry = { kinds: new Map() };
  const initial = await mutateDocument({ bundle, id: "notes/example", mode: "create-only", registry, strict: false, actor: "process:authority", now: () => "2026-09-15T00:00:00.000Z", buildCandidate: () => ({ frontmatter: { type: "Note", title: "Example" }, body: "Original body" }) });
  const records = new Map<string, { prepared: PreparedBodyDelivery; outcome?: BodyDeliveryOutcome }>();
  const counts = { submitted: 0, lookedUp: 0, applied: 0 };
  const knobs = { offline: false, unauthorized: false, terminalRefusal: false, dropNextResponse: false, lookupUnavailable: false, delay: undefined as (() => Promise<void>) | undefined };
  const refusal = (): BodyDeliveryOutcome => ({ kind: "refused", code: "AUTH_REQUIRED", message: "Authorization required" });
  const transport: BodyDeliveryTransport = {
    async submit(input) {
      const prepared = validatePreparedBodyDelivery(input);
      if (knobs.offline) throw new TypeError("Synthetic authority offline");
      counts.submitted++;
      if (knobs.unauthorized) return refusal();
      const previous = records.get(prepared.requestId);
      if (previous) { assertSameBodyDelivery(previous.prepared, prepared); return previous.outcome ?? { kind: "unknown" }; }
      const record: { prepared: PreparedBodyDelivery; outcome?: BodyDeliveryOutcome } = { prepared };
      records.set(prepared.requestId, record);
      await knobs.delay?.();
      if (knobs.terminalRefusal) record.outcome = refusal();
      else {
        try {
          const result = await mutateDocument({ bundle, id: prepared.target, mode: "patch", registry, strict: false, expectedVersion: prepared.expectedVersion,
            actor: "process:authority", now: () => "2026-09-15T01:00:00.000Z", buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: prepared.operation.body }) });
          counts.applied++;
          record.outcome = { kind: "committed", receipt: { scope: prepared.scope, requestId: prepared.requestId, target: prepared.target, expectedVersion: prepared.expectedVersion, body: prepared.operation.body, version: result.version, content: stringifyDoc(result.doc.frontmatter, result.doc.body ?? "") } };
        } catch (error) {
          if (error instanceof VersionConflict) record.outcome = { kind: "conflict", actual: error.actual };
          else throw error;
        }
      }
      if (knobs.dropNextResponse) { knobs.dropNextResponse = false; throw new TypeError("Synthetic response dropped"); }
      return record.outcome;
    },
    async lookup(input) {
      const prepared = validatePreparedBodyDelivery(input);
      counts.lookedUp++;
      if (knobs.offline || knobs.lookupUnavailable) return { kind: "unknown" };
      if (knobs.unauthorized) return refusal();
      const record = records.get(prepared.requestId);
      if (!record) return null;
      assertSameBodyDelivery(record.prepared, prepared);
      return record.outcome ?? { kind: "unknown" };
    },
  };
  return { backend, bundle, initial, transport, records, counts, knobs };
}
