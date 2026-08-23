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
