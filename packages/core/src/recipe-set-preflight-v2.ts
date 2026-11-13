/** Qualified recipe composition; v1 remains unchanged. No acquisition or publication authority. */
import {
  approvedRecipeEntries,
  captureQualifiedData,
  qualifiedFailure,
  qualifiedRegistry,
  type QualifiedApproval,
  type QualifiedArtifact,
  type QualifiedEntry,
  type QualifiedLock,
} from "./qualified-kinds.js";
export interface RecipeSetPreflightV2Input {
  format: "recipe-set-preflight/v2";
  origin: string;
  retainedEntries?: QualifiedEntry[];
  selections: Array<{
    artifact: QualifiedArtifact;
    approval: QualifiedApproval;
  }>;
}
export type RecipeSetPreflightV2Result =
  | {
      format: "recipe-set-preflight-result/v2";
      valid: true;
      lock: QualifiedLock;
      diagnostics: [];
    }
  | {
      format: "recipe-set-preflight-result/v2";
      valid: false;
      diagnostics: string[];
    };
export function preflightRecipeSetV2(
  input: RecipeSetPreflightV2Input,
): RecipeSetPreflightV2Result {
  try {
    const request = captureQualifiedData(input);
    if (
      request.format !== "recipe-set-preflight/v2" ||
      !Array.isArray(request.selections) ||
      request.selections.length > 100 ||
      Object.keys(request).some(
        (k) =>
          !["format", "origin", "retainedEntries", "selections"].includes(k),
      )
    )
      qualifiedFailure("unsupported preflight input");
    const lock: QualifiedLock = {
      format: "qualified-registry/v1",
      origin: request.origin,
      entries: [...(request.retainedEntries ?? [])],
    };
    for (const selection of request.selections) {
      if (
        Object.keys(selection).some((k) => k !== "artifact" && k !== "approval")
      )
        qualifiedFailure("unsupported selection input");
      lock.entries.push(
        ...approvedRecipeEntries(selection.artifact, selection.approval),
      );
    }
    qualifiedRegistry(lock, "preflight");
    if (new TextEncoder().encode(JSON.stringify(lock)).length > 8 * 1024 * 1024)
      qualifiedFailure("preflight registry exceeds 8 MiB");
    return {
      format: "recipe-set-preflight-result/v2",
      valid: true,
      lock,
      diagnostics: [],
    };
  } catch (error) {
    return {
      format: "recipe-set-preflight-result/v2",
      valid: false,
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}
