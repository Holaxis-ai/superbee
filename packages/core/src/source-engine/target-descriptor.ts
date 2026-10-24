/** Validation of the immutable, JSON-persisted establishment boundary. */
import { assertSafeConceptId } from "../paths.js";
import { isRequestIdentity } from "../uncertain-write.js";
import { sha256Hex } from "../versioning.js";
import type { SourceEstablishment } from "./target.js";
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function isSourceEstablishment(v: unknown): v is SourceEstablishment {
  if (!object(v) || v.contract !== 1 || ![v.generation, v.group, v.target, v.observed_at].every(x => typeof x === "string" && x.length > 0)) return false;
  try { assertSafeConceptId(v.target as string); } catch { return false; }
  if (v.kind === "adopt") return typeof v.expectedVersion === "string" && v.expectedVersion.length > 0 && v.intent === undefined;
  if (v.kind !== "create" || v.expectedVersion !== null || !object(v.intent)) return false;
  const i = v.intent;
  return typeof i.requestId === "string" && isRequestIdentity(i.requestId) && i.kind === "document.write"
    && i.target === v.target && i.base === null && i.recreates === undefined && typeof i.content === "string"
    && new TextEncoder().encode(JSON.stringify(i)).length <= 262144
    && i.local === `sha256:${sha256Hex(i.content)}` && i.createdAt === v.observed_at
    && i.attempts === 0 && i.state === "pending";
}
