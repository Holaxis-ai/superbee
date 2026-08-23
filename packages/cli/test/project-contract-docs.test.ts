import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readProjectFile(relativePath: string): string {
  const absolute = resolve(repoRoot, relativePath);
  assert.ok(
    absolute === repoRoot || absolute.startsWith(`${repoRoot}/`),
    `contract evidence must stay inside the repository: ${relativePath}`,
  );
  return readFileSync(absolute, "utf8");
}

function tableCells(line: string): string[] {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

function evidenceRefs(cells: readonly string[]): Array<{ path: string; needle: string }> {
  const refs: Array<{ path: string; needle: string }> = [];
  for (const cell of cells) {
    for (const match of cell.matchAll(/`([^`]+)::([^`]+)`/g)) {
      refs.push({ path: match[1]!, needle: match[2]! });
    }
  }
  return refs;
}

function assertEvidenceRows(rows: readonly string[], expectedIds: readonly string[]): void {
  const parsed = rows.map(tableCells);
  assert.deepEqual(parsed.map((cells) => cells[0]), expectedIds);
  for (const cells of parsed) {
    const refs = evidenceRefs(cells);
    assert.ok(refs.length >= 2, `${cells[0]} must retain implementation/help and behavioral proof anchors`);
    for (const { path, needle } of refs) {
      const evidence = readProjectFile(path);
      assert.ok(evidence.includes(needle), `${cells[0]} proof '${needle}' disappeared from ${path}`);
    }
  }
}

function evidenceKeys(cells: readonly string[]): string[] {
  return evidenceRefs(cells).map(({ path, needle }) => `${path}::${needle}`);
}

function namedTestBlock(relativePath: string, name: string): string {
  const source = readProjectFile(relativePath);
  const marker = `test(${JSON.stringify(name)}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `proof test '${name}' disappeared from ${relativePath}`);
  const next = source.indexOf("\ntest(", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertNamedTestContains(relativePath: string, name: string, needles: readonly string[]): void {
  const block = namedTestBlock(relativePath, name);
  for (const needle of needles) {
    assert.ok(block.includes(needle), `proof '${needle}' disappeared from test '${name}' in ${relativePath}`);
  }
}

test("AXI contract has ten ordered rows, live proof anchors, and a separate idempotency invariant", () => {
  const contract = readProjectFile("packages/cli/AXI-CONTRACT.md");
  const numberedRows = contract.split("\n").filter((line) => /^\| AXI-\d{2} \|/.test(line));
  assertEvidenceRows(
    numberedRows,
    Array.from({ length: 10 }, (_, index) => `AXI-${String(index + 1).padStart(2, "0")}`),
  );

  const mutationRows = contract.split("\n").filter((line) => /^\| MUTATION \|/.test(line));
  assertEvidenceRows(mutationRows, ["MUTATION"]);

  const repositoryReadme = readProjectFile("README.md");
  assert.match(repositoryReadme, /\[AXI contract\]\(packages\/cli\/AXI-CONTRACT\.md\)/);
  assert.match(repositoryReadme, /\[wire protocol\]\(docs\/WIRE-PROTOCOL\.md\)/);
  assert.match(repositoryReadme, /\[SECURITY\.md\]\(SECURITY\.md\)/);
  assert.match(contract, /\[wire protocol\]\(\.\.\/\.\.\/docs\/WIRE-PROTOCOL\.md\)/);
  assert.match(contract, /\[security policy\]\(\.\.\/\.\.\/SECURITY\.md\)/);

  const normalized = contract.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /`link show` reports both `outbound_count` and the derived `backlink_count`; its backlink rows stay inline with the concept detail/,
  );
  assert.match(
    normalized,
    /Ordinary CLI failures render a structured TOON error envelope on stdout, even when `--json` was requested, and use tool-native codes with the stable `0\/1\/2\/4\/5\/6` exit taxonomy/,
  );
  assert.match(
    normalized,
    /For `doc read --out -`, stdout remains raw bytes and every error envelope goes to stderr/,
  );
  assert.match(
    normalized,
    /For `mcp`, stdout remains the JSON-RPC transport and every CLI startup or runtime error envelope goes to stderr/,
  );

  const rowsById = new Map(numberedRows.map((line) => {
    const cells = tableCells(line);
    return [cells[0]!, cells] as const;
  }));
  assert.deepEqual(evidenceKeys(rowsById.get("AXI-02")!), [
    "packages/cli/src/commands/list.ts::default schema is",
    "packages/cli/src/commands/link.ts::outbound_count/backlink_count always report the true",
    "packages/cli/test/list.test.ts::list (unscoped): stays the minimal",
    "packages/cli/test/link.test.ts::link show --limit caps the outbound/backlink lists; counts stay the true totals (A5)",
    "packages/cli/test/link.test.ts::link show: backlink rows carry the citing link's text",
  ]);
  assert.deepEqual(evidenceKeys(rowsById.get("AXI-06")!), [
    "packages/cli/src/output.ts::Errors are ALWAYS TOON regardless of --json",
    "packages/cli/src/errors.ts::The 0/1/2/4/5/6 exit taxonomy is PRESERVED",
    "packages/cli/src/commands/doc/read.ts::makes the channel invariant unconditional",
    "packages/cli/src/commands/mcp.ts::must be routed once to stderr",
    "packages/cli/test/arity-built.test.ts::must keep its reserved non-error channel byte-clean",
    "packages/cli/test/error-boundary.test.ts::error matrix: a CliError instance passes through",
    "packages/cli/test/doc-cli-integration.test.ts::built CLI: raw doc-read channels route early missing-id and unknown-option envelopes only to stderr",
    "packages/cli/test/mcp.test.ts::mcp routes every pre-initialize failure to stderr and marks it handled",
    "packages/cli/test/mcp-stdio.test.ts::built npm CLI keeps MCP stdout byte-empty for usage and bundle startup failures",
  ]);

  assertNamedTestContains(
    "packages/cli/test/link.test.ts",
    "link show --limit caps the outbound/backlink lists; counts stay the true totals (A5)",
    ["assert.equal(shown.outbound_count, 4", "count is the true total"],
  );
  assertNamedTestContains(
    "packages/cli/test/link.test.ts",
    "link show: backlink rows carry the citing link's text (typed-edge reading v0, rung a)",
    ["assert.equal(shown.backlink_count, 1)", "assert.deepEqual(shown.backlinks"],
  );

  const arityProof = readProjectFile("packages/cli/test/arity-built.test.ts");
  assert.match(arityProof, /const channel = row\.errorChannel \?\? "stdout"/);
  assert.match(arityProof, /assert\.equal\(reserved, "", `\$\{path\} must keep its reserved non-error channel byte-clean`\)/);
  assert.match(arityProof, /assert\.notEqual\(output, "", `\$\{path\} must emit a structured error`\)/);

  const errorProof = readProjectFile("packages/cli/test/error-boundary.test.ts");
  for (const exit of [1, 2, 4, 5, 6]) {
    assert.match(errorProof, new RegExp(`exit: ${exit}([ },])`), `exit ${exit} disappeared from the behavioral matrix`);
  }
  assert.match(errorProof, /assert\.equal\(exit\.exitCode, row\.exit\)/);
  assert.match(errorProof, /assert\.equal\(exit\.envelope\.error\.code, row\.code\)/);

  assertNamedTestContains(
    "packages/cli/test/doc-cli-integration.test.ts",
    "built CLI: raw doc-read channels route early missing-id and unknown-option envelopes only to stderr",
    [
      '["doc", "read", "concepts/a", "--out=-", "--unknown"]',
      'assert.equal(result.stdout, "", "stdout remains a pure, empty byte channel on early failure")',
      "assert.match(result.stderr, /code: USAGE/)",
      "assert.equal(result.status, 2",
    ],
  );
  assertNamedTestContains(
    "packages/cli/test/mcp.test.ts",
    "mcp routes every pre-initialize failure to stderr and marks it handled",
    [
      'name: "server startup"',
      'code: "RUNTIME"',
      'assert.equal(stdout, "", `${row.name}: protocol stdout`)',
      "assert.match(stderr, /^error:\\n/",
    ],
  );
  assertNamedTestContains(
    "packages/cli/test/mcp-stdio.test.ts",
    "built npm CLI keeps MCP stdout byte-empty for usage and bundle startup failures",
    [
      'assert.equal(result.stdout, "", `${row.name}: JSON-RPC stdout must remain pristine`)',
      "assert.match(result.stderr, /^error:\\n/",
      "assert.equal(result.code, row.code",
    ],
  );
});

test("wire contract pins the complete implemented route/method table and every proof anchor", () => {
  const contract = readProjectFile("docs/WIRE-PROTOCOL.md");
  const endpointRows = contract
    .split("\n")
    .filter((line) => /^\| (GET|POST|PUT|HEAD|DELETE) \| `\/v0\//.test(line))
    .map(tableCells)
    .map(([method, path]) => `${method} ${path}`);

  assert.deepEqual(endpointRows, [
    "GET `/v0/capabilities`",
    "GET `/v0/bundles/{bundle}/docs`",
    "POST `/v0/bundles/{bundle}/docs:read-many`",
    "GET `/v0/bundles/{bundle}/docs/{id...}`",
    "PUT `/v0/bundles/{bundle}/docs/{id...}`",
    "HEAD `/v0/bundles/{bundle}/docs/{id...}`",
    "DELETE `/v0/bundles/{bundle}/docs/{id...}`",
    "GET `/v0/bundles/{bundle}/docs/{id...}/versions`",
    "GET `/v0/bundles/{bundle}/reserved/{name}`",
    "PUT `/v0/bundles/{bundle}/reserved/{name}`",
    "GET `/v0/bundles/{bundle}/blobs`",
    "GET `/v0/bundles/{bundle}/blobs/{key...}`",
    "PUT `/v0/bundles/{bundle}/blobs/{key...}`",
    "HEAD `/v0/bundles/{bundle}/blobs/{key...}`",
    "DELETE `/v0/bundles/{bundle}/blobs/{key...}`",
  ]);

  const proofRows = contract.split("\n").filter((line) => /^\| WIRE-PROOF-\d{2} \|/.test(line));
  assertEvidenceRows(
    proofRows,
    Array.from({ length: 9 }, (_, index) => `WIRE-PROOF-${String(index + 1).padStart(2, "0")}`),
  );

  assert.match(contract, /has \*\*no authentication or authorization\*\*/);
  assert.match(contract, /accepts\s+any syntactically valid `\{bundle\}` segment but does not use it to select/);
  assert.match(contract, /canonical OKF serialization/);
  assert.match(contract, /external formatting, YAML key order, quoting, or whitespace may not survive/);

  const distributionAuthority = readProjectFile("packages/cli/src/distribution-resources.ts");
  assert.match(distributionAuthority, /repository-owned wire-protocol contract lives at docs\/WIRE-PROTOCOL\.md/);
  assert.doesNotMatch(distributionAuthority, /currently lives only as project-bundle doc/);
});

test("security routing is private and fail-closed without bundle, Skill, sync, or visibility premises", () => {
  const policy = readProjectFile("SECURITY.md");

  assert.match(policy, /https:\/\/github\.com\/Holaxis-ai\/superbee\/security\/advisories\/new/);
  assert.match(policy, /does not depend on a Superbee bundle, installed Agent Skill,\nCLI setup, board sync, or bundle visibility/);
  assert.match(policy, /Do not open a public issue, pull request, or discussion/);
  assert.match(policy, /any synchronized Superbee bundle/);
  assert.match(policy, /applies even when the repository or bundle is believed to be private/);
  assert.match(policy, /externally exploitable issue is already present on `main`/);
  assert.match(policy, /same private advisory for sensitive pre-merge or unreleased findings/);
  assert.match(policy, /If the advisory route is unavailable, stop rather than publishing/);
  assert.match(policy, /visibility is unknown, changing, stale, mismatched between repository and bundle, or cannot be\nverified, treat the destination as public/);
  assert.match(policy, /Unknown, unavailable, stale, or mismatched classifier results must preserve/);

  assert.doesNotMatch(policy, /superbee (status|list|doc read|sync)/);
  assert.match(policy, /There is no public fallback for sensitive disclosure/);
});

test("mandatory agent entrypoints stay compact, routed, and safe in degraded states", () => {
  const claude = readProjectFile("CLAUDE.md");
  const agents = readProjectFile("AGENTS.md");
  const normalizedClaude = claude.replace(/\s+/g, " ");
  const lineCount = claude.trimEnd().split("\n").length;

  assert.ok(lineCount >= 170 && lineCount <= 230, `CLAUDE.md must stay in the Phase A range, got ${lineCount}`);
  assert.deepEqual(
    claude.split("\n").filter((line) => /^## \d\. /.test(line)),
    [
      "## 1. Authority and orientation",
      "## 2. Roles, verbs, and evidence",
      "## 3. Engineering contracts",
      "## 4. Security, releases, and human gates",
      "## 5. Delivery and records",
    ],
  );

  for (const route of [
    "[CONTRIBUTING.md](CONTRIBUTING.md)",
    "[OKF compatibility](CONTRIBUTING.md#okf-compatibility)",
    "[Findings and commitments](CONTRIBUTING.md#findings-and-commitments)",
    "[Assurance evolution](CONTRIBUTING.md#assurance-evolution)",
    "[CLI AXI contract](packages/cli/AXI-CONTRACT.md)",
    "[Wire protocol](docs/WIRE-PROTOCOL.md)",
    "[SECURITY.md](SECURITY.md)",
  ]) {
    assert.ok(claude.includes(route), `mandatory entrypoint route disappeared: ${route}`);
  }

  for (const safetyKernel of [
    "initialize or publish a bundle;",
    "Missing authority and stale authority are different states",
    "Builder -> independent",
    "CI on the pushed SHA is the shipping verdict",
    "Never place secrets, exploit mechanisms, reachability conditions, or working reproductions",
    "Never run a direct or manual publish",
    "require an explicit human decision",
  ]) {
    assert.ok(normalizedClaude.includes(safetyKernel), `mandatory safety kernel disappeared: ${safetyKernel}`);
  }

  assert.match(agents, /read and follow \[CLAUDE\.md\]\(CLAUDE\.md\) in full/);
  assert.doesNotMatch(claude, /private implementation remote|archive\/pre-public|The board is public|CORE\.md/);
});
