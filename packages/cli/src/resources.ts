import { renderNpm } from "./skill-render.js";
export interface DistributionResources {
  readonly skill: string;
  readonly references: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}
declare const __SUPERBEE_DISTRIBUTION_REFERENCES__: readonly {
  readonly path: string;
  readonly content: string;
}[];
/** Build-only resource projection; contains no CLI bootstrap or filesystem discovery. */
export function getDistributionResources(input: {
  packageName: string;
  binName: string;
}): DistributionResources {
  if (
    !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(input.packageName) ||
    !/^[a-z0-9._-]+$/.test(input.binName)
  )
    throw new Error("Invalid distribution resource identity");
  return {
    skill: renderNpm(input),
    references: __SUPERBEE_DISTRIBUTION_REFERENCES__.map((row) => ({ ...row })),
  };
}
