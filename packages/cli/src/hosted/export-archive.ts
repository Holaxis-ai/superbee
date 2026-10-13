// The CLI and library consumers share the core portable export verifier.
export * from "@superbee/core/portable-export";

/** Checkout conversion state is CLI-owned, never exported bundle content. */
export const IN_PLACE_STAGING = ".superbee-export-partial";
export const IN_PLACE_JOURNAL = "journal.json";
