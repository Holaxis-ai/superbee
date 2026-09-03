import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
const workflow = readFileSync(path.join(root, manifest.security_analysis.workflow), "utf8");
const config = readFileSync(path.join(root, manifest.security_analysis.config), "utf8");
const contributing = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");

function projectionRows(text, name) {
  const start = `<!-- contributing-${name}:start -->`;
  const end = `<!-- contributing-${name}:end -->`;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  assert.ok(startAt >= 0, `missing ${name} projection start`);
  assert.ok(endAt > startAt, `missing ${name} projection end`);
  return text
    .slice(startAt + start.length, endAt)
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim().replaceAll("`", "")));
}

function globRegex(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (pattern[index] === "*") {
      source += "[^/]*";
      index += 1;
    } else {
      source += pattern[index].replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
      index += 1;
    }
  }
  return new RegExp(`${source}$`);
}

function configIncludesFile(file, candidate = manifest.security_analysis) {
  const inPath = candidate.paths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
  return inPath && candidate.paths_ignore.every((pattern) => !globRegex(pattern).test(file));
}

function yamlDocument(text, subject) {
  const parsed = yaml.safeLoad(text);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${subject} must be a YAML mapping`);
  return parsed;
}

function validateSecurityManifest(candidate = manifest.security_analysis) {
  assert.equal(candidate.workflow, ".github/workflows/codeql.yml");
  assert.equal(candidate.config, ".github/codeql/codeql-config.yml");
  assert.deepEqual(candidate.triggers, ["pull_request", "push", "schedule", "workflow_dispatch"]);
  assert.equal(candidate.schedule, "23 7 * * 1");
  assert.deepEqual(candidate.concurrency, {
    group: "codeql-${{ github.event_name }}-${{ github.ref }}",
    cancel_in_progress: "${{ github.event_name == 'pull_request' }}",
  });
  assert.deepEqual(candidate.permissions, {
    actions: "read",
    contents: "read",
    "security-events": "write",
  });
  assert.deepEqual(candidate.action_pins, {
    checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    codeql_init: "github/codeql-action/init@cdf488f595d80d6e07e03d4674febd5ab45fa938",
    codeql_analyze: "github/codeql-action/analyze@cdf488f595d80d6e07e03d4674febd5ab45fa938",
  });
  assert.equal(candidate.checkout_persist_credentials, false);
  assert.equal(candidate.query_suite, "security-extended");
  assert.equal(candidate.threat_model, "local");
  assert.deepEqual(candidate.paths, ["packages", "scripts"]);
  assert.deepEqual(candidate.paths_ignore, [
    "**/node_modules/**",
    "**/dist/**",
    "**/test/**",
    "**/tests/**",
    "**/e2e/**",
    "**/fixtures/**",
    "**/*.test.*",
  ]);
  assert.deepEqual(Object.keys(candidate.jobs), ["javascript-typescript", "github-actions", "required"]);
  assert.deepEqual(candidate.jobs["javascript-typescript"], {
    display_name: "CodeQL JavaScript/TypeScript",
    language: "javascript-typescript",
    build_mode: "none",
    category: "/language:javascript-typescript",
    timeout_minutes: 30,
  });
  assert.deepEqual(candidate.jobs["github-actions"], {
    display_name: "CodeQL GitHub Actions",
    language: "actions",
    build_mode: "none",
    category: "/language:actions",
    timeout_minutes: 30,
  });
  assert.deepEqual(candidate.jobs.required, {
    display_name: "CodeQL required analyses",
    needs: ["javascript-typescript", "github-actions"],
    timeout_minutes: 5,
  });
  assert.match(candidate.merge_enforcement, /human-owned GitHub ruleset/);
  for (const file of [...candidate.representative_includes, ...candidate.representative_excludes]) {
    assert.equal(existsSync(path.join(root, file)), true, `representative CodeQL path must exist: ${file}`);
  }
}

function expectedAnalysisJob(expected, initWith) {
  const label = expected.display_name.replace(/^CodeQL /, "");
  return {
    name: expected.display_name,
    "runs-on": "ubuntu-latest",
    "timeout-minutes": expected.timeout_minutes,
    permissions: manifest.security_analysis.permissions,
    steps: [
      {
        uses: manifest.security_analysis.action_pins.checkout,
        with: { "persist-credentials": manifest.security_analysis.checkout_persist_credentials },
      },
      {
        name: `Initialize ${label} analysis`,
        uses: manifest.security_analysis.action_pins.codeql_init,
        with: {
          languages: expected.language,
          "build-mode": expected.build_mode,
          ...initWith,
        },
      },
      {
        name: `Analyze ${label}`,
        uses: manifest.security_analysis.action_pins.codeql_analyze,
        with: { category: expected.category },
      },
    ],
  };
}

function expectedWorkflow(candidate) {
  return {
    name: "CodeQL security",
    on: {
      pull_request: { branches: ["main"] },
      push: { branches: ["main"] },
      schedule: [{ cron: candidate.schedule }],
      workflow_dispatch: null,
    },
    permissions: {},
    concurrency: {
      group: candidate.concurrency.group,
      "cancel-in-progress": candidate.concurrency.cancel_in_progress,
    },
    jobs: {
      "javascript-typescript": expectedAnalysisJob(candidate.jobs["javascript-typescript"], {
        "config-file": `./${candidate.config}`,
      }),
      "github-actions": expectedAnalysisJob(candidate.jobs["github-actions"], {
        queries: candidate.query_suite,
      }),
      required: {
        name: candidate.jobs.required.display_name,
        needs: candidate.jobs.required.needs,
        if: "${{ always() }}",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": candidate.jobs.required.timeout_minutes,
        permissions: {},
        steps: [
          {
            name: "Reject every non-success or missing CodeQL result",
            env: {
              JAVASCRIPT_TYPESCRIPT_RESULT: "${{ needs.javascript-typescript.result }}",
              GITHUB_ACTIONS_RESULT: "${{ needs.github-actions.result }}",
            },
            run: [
              'test "$JAVASCRIPT_TYPESCRIPT_RESULT" = "success"',
              'test "$GITHUB_ACTIONS_RESULT" = "success"',
              "",
            ].join("\n"),
          },
        ],
      },
    },
  };
}

function expectedConfig(candidate) {
  return {
    name: "Superbee JavaScript and TypeScript security",
    queries: [{ uses: candidate.query_suite }],
    "threat-models": candidate.threat_model,
    paths: candidate.paths,
    "paths-ignore": candidate.paths_ignore,
  };
}

function validateCodeqlTopology(workflowText = workflow, configText = config, candidate = manifest.security_analysis) {
  validateSecurityManifest(candidate);
  assert.deepEqual(
    yamlDocument(workflowText, "CodeQL workflow"),
    expectedWorkflow(candidate),
    "CodeQL workflow executable topology must match the manifest exactly",
  );
  assert.deepEqual(
    yamlDocument(configText, "CodeQL config"),
    expectedConfig(candidate),
    "CodeQL analysis policy must match the manifest exactly",
  );
  for (const file of candidate.representative_includes) {
    assert.equal(configIncludesFile(file, candidate), true, `${file} must remain in CodeQL scope`);
  }
  for (const file of candidate.representative_excludes) {
    assert.equal(configIncludesFile(file, candidate), false, `${file} must remain outside CodeQL alert scope`);
  }
}

test("CodeQL scans local and remote trust boundaries through fail-closed hosted jobs", () => {
  validateCodeqlTopology();
});

test("CodeQL topology mutations cannot weaken sources, queries, permissions, scope, or aggregation", () => {
  for (const changed of [
    workflow.replace("security-events: write", "security-events: read"),
    workflow.replace("      security-events: write", "      security-events: write\n      id-token: write"),
    workflow.replace("      security-events: write", "      security-events: write\n\n      id-token: write"),
    workflow.replace(manifest.security_analysis.action_pins.checkout, "actions/checkout@v7"),
    workflow.replace(manifest.security_analysis.action_pins.codeql_init, "github/codeql-action/init@v4"),
    workflow.replace(manifest.security_analysis.action_pins.codeql_analyze, "github/codeql-action/analyze@v4"),
    workflow.replace(
      `uses: ${manifest.security_analysis.action_pins.codeql_analyze}`,
      `uses: attacker/example-action@v1 # uses: ${manifest.security_analysis.action_pins.codeql_analyze}`,
    ),
    workflow.replace(
      `      - uses: ${manifest.security_analysis.action_pins.checkout}`,
      `      - run: echo unsafe\n      - uses: ${manifest.security_analysis.action_pins.checkout}`,
    ),
    workflow.replace("queries: security-extended", "queries: default"),
    workflow.replace("build-mode: none", "build-mode: manual"),
    workflow.replace("  schedule:\n    - cron: \"23 7 * * 1\"\n", ""),
    workflow.replace("  workflow_dispatch:\n", "  pull_request_target:\n"),
    workflow.replace("    needs: [javascript-typescript, github-actions]", "    needs: javascript-typescript"),
    workflow.replace('test "$GITHUB_ACTIONS_RESULT" = "success"', "true"),
    workflow.replace('test "$GITHUB_ACTIONS_RESULT" = "success"', 'test "$GITHUB_ACTIONS_RESULT" = "success" || true'),
    workflow.replace('test "$GITHUB_ACTIONS_RESULT" = "success"', 'test "$GITHUB_ACTIONS_RESULT" = "success"\n          true'),
    workflow.replace("    timeout-minutes: 30", "    timeout-minutes: 300"),
    workflow.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true"),
  ]) assert.throws(() => validateCodeqlTopology(changed), /executable topology/);

  assert.throws(
    () => validateCodeqlTopology(workflow, config.replace("threat-models: local", "threat-models: remote")),
    /analysis policy/,
  );
  assert.throws(
    () => validateCodeqlTopology(workflow, config.replace("  - uses: security-extended", "  - uses: default")),
    /analysis policy/,
  );
  assert.throws(
    () => validateCodeqlTopology(
      workflow,
      config.replace("  - '**/*.test.*'", "  - '**/*.test.*'\n\n  - '**/generated/**'"),
    ),
    /analysis policy/,
  );
});

test("contributor guidance distinguishes analysis completion from merge enforcement", () => {
  assert.deepEqual(projectionRows(contributing, "codeql-analysis"), [
    [
      "JavaScript/TypeScript",
      "packages, scripts; excludes dependencies, dist, tests, e2e, fixtures",
      "none",
      "default + security-extended",
      "remote + local (beta)",
    ],
    [
      "GitHub Actions",
      ".github/workflows",
      "none",
      "default + security-extended",
      "CodeQL Actions defaults",
    ],
  ]);
  for (const statement of [
    "CodeQL required analyses",
    "does not mean the result contains no alerts",
    "Require code scanning results",
    "Evaluate",
    "Threat models are a beta CodeQL capability",
  ]) assert.ok(contributing.includes(statement), `CONTRIBUTING.md is missing CodeQL guidance: ${statement}`);
});
