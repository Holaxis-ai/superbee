/**
 * The oldest published `superbee` version whose update guidance is trusted. The built CLI embeds
 * this value (see build-bundle.mjs) so `superbee version` can suppress upgrade prompts for versions
 * below the floor. Product-owned: the release workflow never reads or writes it.
 */
export const FUNCTIONAL_VERSION_FLOOR = "0.1.0";
