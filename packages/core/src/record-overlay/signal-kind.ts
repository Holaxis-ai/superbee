/**
 * The attention Kind: the one Kind record-overlay may create documents of, and the only Kind whose
 * documents it updates outside the owned-field guard. Resolved from the ops registry at plan time
 * and again at apply time, by the same rules.
 */
import { claimCoordinates, type KindConvention, type KindRegistry } from "../kinds.js";

/** Fields an attention Kind must declare: the Signal record a raise and a collapse write. */
export const ATTENTION_FIELDS: readonly string[] = Object.freeze(["change_kind", "observed_at", "provider", "external_id", "diff_summary"]);

export interface AttentionKind {
  name: string;
  kind: KindConvention;
  /** The only id prefix a Signal create may target and a Signal update may touch. */
  prefix: string;
  stateField: string;
  ownerField: string;
}

export type AttentionResolution = { ok: true; value: AttentionKind } | { ok: false; reason: string };

/**
 * The attention Kind must be declared in the ops registry, differ from the overlay target Kind,
 * resolve both claim coordinates on this edition, and declare every {@link ATTENTION_FIELDS} member.
 * Its declared `path` (default `signals/`) bounds where its documents may live.
 */
export function resolveAttentionKind(
  registry: KindRegistry,
  okfVersion: string,
  name: string,
  targetKind: string | undefined,
): AttentionResolution {
  const kind = registry.kinds.get(name);
  if (!kind) return { ok: false, reason: `the attention Kind ${name} is not declared in the ops bundle` };
  if (targetKind !== undefined && name === targetKind) return { ok: false, reason: `the attention Kind ${name} is the overlay target Kind` };
  const claim = claimCoordinates(okfVersion, kind);
  if (!claim?.ownerField || !claim.stateField) return { ok: false, reason: `the attention Kind ${name} declares no resolvable claim owner and state fields` };
  const declared = new Set([...kind.fields.required, ...kind.fields.optional]);
  const missing = ATTENTION_FIELDS.filter((field) => !declared.has(field));
  if (missing.length) return { ok: false, reason: `the attention Kind ${name} does not declare ${missing.join(", ")}` };
  return {
    ok: true,
    value: {
      name,
      kind,
      prefix: (kind.path ?? "signals/").replace(/\/?$/, "/"),
      stateField: claim.stateField,
      ownerField: claim.ownerField,
    },
  };
}
