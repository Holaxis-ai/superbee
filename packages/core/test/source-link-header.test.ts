import test from "node:test";
import assert from "node:assert/strict";
import { nextLinkTarget } from "../src/source-profiles/link-header.js";

const base = "https://api.github.com/repos/octo/project/issues";
const next = `${base}?page=2`;
const valid: Array<[string, string | undefined]> = [
  ["", undefined], [" \t", undefined],
  [`<${next}>; rel=next`, next],
  [`<${next}>; title="hint; rel=prev"; rel="Next"`, next],
  [`<${next}>; title="a\\\"; rel=prev, <other>"; rel="prev NEXT"`, next],
  [`<${next}>; title="a\\\\"; rel=next`, next],
  [`<${base}?after=a,b>; rel=next`, `${base}?after=a,b`],
  [`<${next}>; rel=next; rel=prev`, next],
  [`<${next}>; rel=prev; rel=next`, undefined],
  [`<${base}?page=1>; rel=prev; title="comma, quote\\\"", <${next}>; title=hint; rel=next`, next],
  [`<?page=2>; Rel = "NeXt"; title*=UTF-8'en'next`, next],
  [`<${next}>; flag; rel=next; anchor="${base}"`, next],
  [`<${next}>; rel="https://example.org/extension;x,y"`, undefined],
];
for (const [header, expected] of valid) test(`Link tokenizer accepts legitimate parameter structure: ${header}`, () => {
  assert.equal(nextLinkTarget(header, base), expected);
});
for (const header of [
  '<broken', `<${next}>; title="unterminated; rel=next`, `<${next}>; title="dangling\\`,
  `<${next}>; title="hint; rel=next"`, `<${next}>; rel`, `<${next}>; rel=`, `<${next}>; rel=""`,
  `<${next}>; rel=next junk`, `<${next}>; rel=next,`, `<${next}>; rel="next,prev"`,
  `<${next}>; title="line\rbreak"; rel=next`, `<${next}>; rel=next; anchor="https://other.example.org"`,
  `<${next}>; rel=next, <${next}>; rel=next`, "x".repeat(65_537),
  Array(129).fill(`<${next}>; rel=prev`).join(","), `<${next}>${"; flag".repeat(65)}; rel=next`,
]) test(`ambiguous or unsupported Link input cannot establish completeness: ${header.slice(0, 90)}`, () => {
  assert.throws(() => nextLinkTarget(header, base), error => typeof error === "object" && error !== null && "code" in error && error.code === "SOURCE_UNSUPPORTED_CONTENT");
});
