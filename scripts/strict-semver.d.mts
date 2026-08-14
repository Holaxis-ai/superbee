export const MAX_STRICT_SEMVER_LENGTH: 256;
export interface ParsedStrictSemver { major: string; minor: string; patch: string; prerelease: string[] | null; }
export function isStrictSemver(value: unknown): value is string;
export function parseStrictSemver(value: unknown): ParsedStrictSemver | undefined;
export function compareStrictSemver(left: unknown, right: unknown): -1 | 0 | 1 | undefined;
export function assertStrictSemver(value: unknown, label?: string): string;
