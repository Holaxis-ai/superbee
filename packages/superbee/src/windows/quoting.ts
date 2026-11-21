// PowerShell accepts additional quote terminators; a rendered value must be inert in both shells.
const DOUBLE_QUOTE_LIKE = /["\u201c\u201d\u201e\u201f\u2033\u2036\u275d\u275e\u301d\u301e\u301f\uff02]/u;
const EXPANSION_LIKE = /[$`!%\uff40]/u;
const UNPRINTABLE = /[\u0000-\u001f\u007f]/u;

export function renderWindowsToken(value: string): string | undefined {
  if (UNPRINTABLE.test(value) || DOUBLE_QUOTE_LIKE.test(value) || EXPANSION_LIKE.test(value)) return undefined;
  // CRT consumes trailing backslashes before a quote; PowerShell preserves the doubled run.
  // This is the existing inert-but-not-identical trailing-backslash fidelity boundary.
  let suffixStart = value.length;
  while (suffixStart > 0 && value[suffixStart - 1] === '\\') suffixStart--;
  return `"${value}${value.slice(suffixStart)}"`;
}
