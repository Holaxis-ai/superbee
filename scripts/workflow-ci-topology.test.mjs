import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci-tests.yml"), "utf8");
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const mcpAppPackage = JSON.parse(readFileSync(path.join(root, "packages", "mcp-app", "package.json"), "utf8"));
const browserLocalPackage = JSON.parse(readFileSync(path.join(root, "packages", "browser-local", "package.json"), "utf8"));
const uiPackage = JSON.parse(readFileSync(path.join(root, "packages", "ui", "package.json"), "utf8"));
const workspacePackages = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(path.join(root, "packages", entry.name, "package.json"), "utf8")));
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
const PLAYWRIGHT_IMAGE_DIGEST = "sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48";
const PLAYWRIGHT_VERSION = packageLock.packages["node_modules/playwright-core"]?.version;
const PLAYWRIGHT_IMAGE = `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble@${PLAYWRIGHT_IMAGE_DIGEST}`;

const BROWSER_PREFLIGHT = `      - name: Verify baked Playwright browser artifacts
        shell: bash
        run: |
          set -euo pipefail
          node --input-type=module <<'NODE'
          import assert from "node:assert/strict";
          import { constants } from "node:fs";
          import { access, readFile } from "node:fs/promises";
          import path from "node:path";

          assert.equal(process.platform, "linux", "the browser container must run Linux");
          assert.equal(process.arch, "x64", "the browser job is pinned to GitHub's x64 runner");
          const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
          assert.equal(root, "/ms-playwright", "the baked browser registry path must remain explicit");
          const manifest = JSON.parse(await readFile("node_modules/playwright-core/browsers.json", "utf8"));
          const browser = (name) => {
            const matches = manifest.browsers.filter((entry) => entry.name === name);
            assert.equal(matches.length, 1, \`Playwright must declare exactly one \${name} artifact\`);
            assert.equal(matches[0].installByDefault, true, \`\${name} must remain installed by default\`);
            return matches[0];
          };
          const chromium = browser("chromium");
          const headless = browser("chromium-headless-shell");
          const ffmpeg = browser("ffmpeg");
          assert.equal(chromium.revision, headless.revision, "Chromium revisions must stay aligned");
          const required = [
            [path.join(root, \`chromium-\${chromium.revision}\`, "INSTALLATION_COMPLETE"), constants.F_OK],
            [path.join(root, \`chromium-\${chromium.revision}\`, "chrome-linux64", "chrome"), constants.X_OK],
            [path.join(root, \`chromium_headless_shell-\${headless.revision}\`, "INSTALLATION_COMPLETE"), constants.F_OK],
            [path.join(root, \`chromium_headless_shell-\${headless.revision}\`, "chrome-headless-shell-linux64", "chrome-headless-shell"), constants.X_OK],
            [path.join(root, \`ffmpeg-\${ffmpeg.revision}\`, "INSTALLATION_COMPLETE"), constants.F_OK],
            [path.join(root, \`ffmpeg-\${ffmpeg.revision}\`, "ffmpeg-linux"), constants.X_OK],
          ];
          for (const [artifact, mode] of required) await access(artifact, mode);
          NODE`;

function extractJobs(text) {
  const lines = text.split("\n");
  const at = lines.indexOf("jobs:");
  assert.notEqual(at, -1, "workflow must declare jobs");
  const jobs = {};
  let current = null;
  for (let index = at + 1; index < lines.length; index += 1) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (header) {
      current = header[1];
      jobs[current] = [];
      continue;
    }
    if (lines[index] && !/^ {3,}/.test(lines[index]) && !/^ {0,2}#/.test(lines[index])) break;
    if (current) jobs[current].push(lines[index]);
  }
  return Object.fromEntries(Object.entries(jobs).map(([name, lines]) => [name, lines.join("\n")]));
}

function parseStepField(step, source) {
  const field = /^([A-Za-z0-9_-]+):(?:\s(.*))?$/.exec(source);
  assert.ok(field, `unsupported workflow step field: ${source}`);
  assert.equal(
    Object.hasOwn(step.fields, field[1]),
    false,
    `workflow step ${step.position + 1} must not repeat field ${field[1]}`,
  );
  step.fields[field[1]] = field[2] ?? "";
}

// This intentionally parses only the job-level step sequence used by these topology assertions.
// Nested `with`, `env`, and block-scalar bodies are opaque; required gates use exact scalar fields.
// Unknown sequence-item shapes fail closed instead of being guessed as YAML semantics.
function stepsOf(job) {
  const lines = job.split("\n");
  const stepsAt = lines.indexOf("    steps:");
  assert.notEqual(stepsAt, -1, "workflow job must declare steps");
  const steps = [];
  let current = null;
  for (let index = stepsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {4}[A-Za-z0-9_-]+:/.test(line)) break;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^ {6}- (.+)$/.exec(line);
    if (item) {
      current = { position: steps.length, fields: Object.create(null) };
      parseStepField(current, item[1]);
      steps.push(current);
      continue;
    }
    assert.doesNotMatch(line, /^ {6}-/, "workflow step sequence items must declare one field inline");
    const field = /^ {8}(\S.*)$/.exec(line);
    if (field && current) {
      parseStepField(current, field[1]);
      continue;
    }
    if (/^ {10}/.test(line)) continue;
    assert.fail(`unsupported workflow step line: ${line}`);
  }
  assert.ok(steps.length > 0, "workflow job must declare at least one step");
  return steps;
}

function requiredUnconditionalStep(steps, expected) {
  const named = steps.filter((step) => step.fields.name === expected.name);
  assert.equal(named.length, 1, `${expected.label} must be declared exactly once by name`);
  const step = named[0];
  assert.equal(step.fields.run, expected.run, `${expected.label} command drifted`);
  assert.equal(
    step.fields["working-directory"],
    expected.workingDirectory,
    `${expected.label} must run directly from its reviewed working directory`,
  );
  assert.equal(step.fields.if, undefined, `${expected.label} must be unconditional`);
  assert.equal(
    step.fields["continue-on-error"],
    undefined,
    `${expected.label} must fail closed rather than continue on error`,
  );
  assert.equal(
    steps.filter((candidate) => candidate.fields.run === expected.run).length,
    1,
    `${expected.label} command must execute exactly once`,
  );
  return step;
}

function needsOf(job) {
  const list = /^ {4}needs: \[([^\]]*)\]\s*$/m.exec(job);
  if (list) return list[1].split(",").map((name) => name.trim()).filter(Boolean);
  const scalar = /^ {4}needs: ([A-Za-z0-9_-]+)\s*$/m.exec(job);
  return scalar ? [scalar[1]] : [];
}

function requiredLaneNames(candidate) {
  return Object.entries(candidate.lanes)
    .filter(([, lane]) => lane.required !== false)
    .map(([name]) => name);
}

function assertAggregator(job, label) {
  assert.deepEqual(needsOf(job).sort(), [...manifest.required_jobs].sort(), `${label} needs every required lane`);
  assert.match(job, /^ {4}if: \$\{\{ always\(\) \}\}\s*$/m, `${label} must run after every conclusion`);
  assert.match(job, /REQUIRED_RESULTS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(job, /run: npm run ci:aggregate/);
}

function displayNameOf(job) {
  return /^ {4}name: (.+)\s*$/m.exec(job)?.[1] ?? null;
}

function assertSmokeJob(job, lane) {
  assert.equal((job.match(/actions\/setup-node@v4/g) ?? []).length, 2, "floor smoke needs build and floor runtimes");
  assert.deepEqual(
    [...job.matchAll(/^ {10}node-version: (.+)\s*$/gm)].map((match) => match[1]),
    [String(manifest.singleton_node), String(lane.runtime_setup_node)],
    "the second setup-node invocation must select the declared engine floor",
  );
  assert.ok(job.includes(lane.version_guard), "floor smoke must self-check the active Node major");
  assert.match(job, new RegExp(`CLI=${lane.built_cli.replaceAll("/", "\\/")}`));
  const commands = [...job.matchAll(/^ {10}node "\$CLI" (.+)$/gm)].map((match) => match[1]);
  const surface = [...new Set(commands.map((argv) => {
    return [...lane.built_cli_commands]
      .sort((left, right) => right.length - left.length)
      .find((command) => argv === command || argv.startsWith(`${command} `)) ?? `<unknown:${argv}>`;
  }))].sort();
  assert.deepEqual(surface, [...lane.built_cli_commands].sort(), "floor smoke built-CLI command surface drifted");
}

// Every lane that declares a host-class expectation must run on the pinned runner, export the
// expectation to the tests, and self-check the filesystem before any test can observe it.
function assertHostExpectations(jobs, candidate) {
  const variable = candidate.host_expectation_variable;
  assert.equal(typeof variable, "string", "manifest must name the host-class expectation variable");
  const expectations = {};
  for (const [name, lane] of Object.entries(candidate.lanes)) {
    if (lane.expect_aliasing_host === undefined) continue;
    expectations[name] = lane.expect_aliasing_host;
    const job = jobs[name];
    assert.match(job, new RegExp(`^ {4}runs-on: ${lane.runs_on}\\s*$`, "m"), `${name} must run on ${lane.runs_on}`);
    assert.match(job, /^ {4}env:\s*$/m, `${name} must export the host-class expectation at job level`);
    assert.match(
      job,
      new RegExp(`^ {6}${variable}: "${lane.expect_aliasing_host}"\\s*$`, "m"),
      `${name} must pin the host-class expectation`,
    );
    assert.ok(job.includes(lane.host_guard), `${name} must self-check its host class`);
    assert.equal(typeof lane.script, "string", `${name} must declare the script its job runs`);
    assert.match(job, new RegExp(`run: npm run ${lane.script}$`, "m"), `${name} must run its declared script`);
  }
  assert.deepEqual(expectations, { runtime: "0", "aliasing-host": "1" }, "both host classes must be pinned");
}

// The runtime lane splits each Node version into shards. Every shard index must be a matrix leg and
// must reach the tests through the declared variable, or files would silently go unrun.
function assertRuntimeShards(job, lane) {
  assert.ok(Number.isInteger(lane.shards) && lane.shards >= 1, "runtime must declare an integer shard count");
  assert.equal(typeof lane.shard_variable, "string", "runtime must name its shard variable");
  const indexes = Array.from({ length: lane.shards }, (_, index) => index + 1).join(", ");
  assert.match(
    job,
    new RegExp(`^ {8}shard: \\[${indexes}\\]\\s*$`, "m"),
    "runtime matrix must run every declared shard",
  );
  assert.ok(
    job.includes(`\n      ${lane.shard_variable}: \${{ matrix.shard }}/${lane.shards}\n`),
    "runtime must export its shard to the tests",
  );
}

function validateBrowserScripts(packages) {
  const rootCommand = packages.root.scripts["ci:browser"];
  const mcpCommand = packages.mcpApp.scripts["test:browser"];
  const uiCommand = packages.ui.scripts["e2e:gate"];
  const browserLocalCommand = packages.browserLocal.scripts["test:browser"];
  assert.equal(typeof rootCommand, "string", "ci:browser must remain declared");
  assert.equal(
    mcpCommand,
    "playwright install chromium && playwright test --config playwright.config.ts",
    "MCP browser coverage must retain its complete reviewed command",
  );
  assert.equal(
    uiCommand,
    "playwright install chromium && playwright test e2e/pages.spec.ts e2e/security.spec.ts e2e/personal-task-system.spec.ts --project=chromium",
    "UI browser coverage must retain its complete reviewed command",
  );
  assert.equal(
    browserLocalCommand,
    "playwright install chromium && playwright test --config playwright.config.ts",
    "browser-local Chromium proof must retain its complete reviewed command",
  );

  const packageByName = new Map(workspacePackages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of [packages.root, packages.mcpApp, packages.ui, packages.browserLocal]) packageByName.set(pkg.name, pkg);
  const completed = new Set();
  const active = new Set();
  const reachableCommands = [];

  const visit = (pkg, scriptName) => {
    const key = `${pkg.name}:${scriptName}`;
    assert.equal(active.has(key), false, `ci:browser script cycle reached ${key}`);
    if (completed.has(key)) return;
    active.add(key);
    for (const candidate of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
      const command = pkg.scripts?.[candidate];
      if (candidate === scriptName) assert.equal(typeof command, "string", `missing reachable npm script ${key}`);
      if (typeof command !== "string") continue;
      reachableCommands.push({ packageName: pkg.name, scriptName: candidate, command });
      assert.doesNotMatch(command, /\|\||[;\n]/, `reachable npm script ${pkg.name}:${candidate} must remain statically traceable`);
      for (const segment of command.split(/\s*&&\s*/)) {
        if (!/(?:^|\s)npm(?:\s|$)/.test(segment)) continue;
        assert.match(segment, /^npm(?:\s|$)/, `reachable npm invocation must start its command segment: ${segment}`);
        const tokens = segment.trim().split(/\s+/);
        const workspaces = [];
        let sawRun = false;
        let nestedScript;
        for (let index = 1; index < tokens.length; index += 1) {
          const token = tokens[index];
          if (token === "--") break;
          if (token === "-w" || token === "--workspace") {
            const workspace = tokens[++index];
            assert.ok(workspace, `workspace flag must name its target: ${segment}`);
            workspaces.push(workspace);
            continue;
          }
          if (token.startsWith("--workspace=")) {
            workspaces.push(token.slice("--workspace=".length));
            continue;
          }
          if (!sawRun && (token === "run" || token === "run-script")) {
            sawRun = true;
            continue;
          }
          if (sawRun && nestedScript === undefined && !token.startsWith("-")) {
            nestedScript = token;
            continue;
          }
          assert.fail(`unsupported reachable npm-run argument ${token}: ${segment}`);
        }
        assert.equal(sawRun, true, `reachable npm invocation must use run or run-script: ${segment}`);
        assert.ok(nestedScript, `reachable npm invocation must name its script: ${segment}`);
        const targets = workspaces.length > 0
          ? workspaces.map((name) => {
              const target = packageByName.get(name);
              assert.ok(target, `reachable npm script names unknown workspace ${name}`);
              return target;
            })
          : [pkg];
        for (const target of targets) visit(target, nestedScript);
      }
    }
    active.delete(key);
    completed.add(key);
  };

  visit(packages.root, "ci:browser");
  const reachable = reachableCommands.map(({ packageName, scriptName, command }) => {
    return `${packageName}:${scriptName}: ${command}`;
  }).join("\n");
  assert.equal(
    (reachable.match(/\bplaywright install\b/g) ?? []).length,
    3,
    "the ci:browser chain permits exactly three Playwright install checks",
  );
  assert.doesNotMatch(
    reachable,
    /\b(?:apt|apt-get)\b|\bplaywright install-deps\b|\bplaywright install[^\n]*(?:--with-deps|--force)|PLAYWRIGHT_BROWSERS_PATH/,
    "the ci:browser script chain cannot install system dependencies, force downloads, or override the baked registry",
  );
}

function validateBrowserJob(job, packages) {
  assert.equal(packageLock.packages["node_modules/playwright"]?.version, PLAYWRIGHT_VERSION);
  assert.equal(packageLock.packages["node_modules/@playwright/test"]?.version, PLAYWRIGHT_VERSION);
  assert.deepEqual(
    [...job.matchAll(/^ {6}image: (.+)$/gm)].map((match) => match[1]),
    [PLAYWRIGHT_IMAGE],
    "browser job must use the byte-exact reviewed immutable Playwright image",
  );
  assert.deepEqual(
    [...job.matchAll(/^ {6}options: (.+)$/gm)].map((match) => match[1]),
    ["--ipc=host"],
    "browser job must use the exact reviewed container option",
  );
  assert.equal(
    (job.match(/^ {4}container:\s*$/gm) ?? []).length,
    1,
    "browser job must declare one container",
  );
  assert.match(
    job,
    /^ {4}env:\n {6}PLAYWRIGHT_BROWSERS_PATH: \/ms-playwright$/m,
    "browser job must expose the baked registry at the reviewed path",
  );
  assert.ok(job.includes(BROWSER_PREFLIGHT), "browser job must fail closed on every baked artifact");
  assert.ok(
    job.indexOf(BROWSER_PREFLIGHT) < job.indexOf("      - run: npm run ci:browser"),
    "browser preflight must precede the browser suites",
  );
  assert.doesNotMatch(
    job,
    /\b(?:apt|apt-get)\b|\bplaywright install(?:-deps)?\b|--with-deps|--force/,
    "browser workflow must not perform runtime installation",
  );
  validateBrowserScripts(packages);
}

function validateCiTopology(
  text,
  candidate = manifest,
  browserPackages = { root: rootPackage, mcpApp: mcpAppPackage, ui: uiPackage, browserLocal: browserLocalPackage },
) {
  const jobs = extractJobs(text);
  assert.deepEqual(
    [...candidate.required_jobs].sort(),
    requiredLaneNames(candidate).sort(),
    "required_jobs must equal the automatically run lane set",
  );
  assert.doesNotMatch(text, /^\s+continue-on-error:/m, "required CI jobs cannot mask a failing step");
  for (const required of candidate.required_jobs) {
    assert.ok(jobs[required], `missing required job ${required}`);
    assert.equal(displayNameOf(jobs[required]), candidate.lanes[required].display_name, `${required} display name drifted`);
    const steps = stepsOf(jobs[required]);
    const preflight = requiredUnconditionalStep(steps, {
      name: 'Check package version sources before installation',
      run: candidate.source_preflight,
      label: `${required} package source preflight`,
    });
    const install = steps.find(step => step.fields.run === 'npm ci');
    assert.ok(install && preflight.position < install.position, `${required} source preflight must precede installation`);
  }
  assert.match(jobs.runtime, /node-version: \[22, 26\]/);
  assert.match(jobs.runtime, /run: npm run ci:runtime/);
  assertRuntimeShards(jobs.runtime, candidate.lanes.runtime);
  assert.match(jobs["aliasing-host"], /node-version: 26/);
  assert.match(text, /^permissions:\n {2}contents: read$/m, "required CI must retain read-only contents permission");
  assertHostExpectations(jobs, candidate);
  for (const [job, script] of [
    ["distribution", "ci:distribution"],
    ["browser", "ci:browser"],
    ["scripts", "ci:scripts"],
  ]) {
    assert.match(jobs[job], /node-version: 26/);
    assert.match(jobs[job], new RegExp(`run: npm run ${script.replace(":", "\\:")}`));
  }
  validateBrowserJob(jobs.browser, browserPackages);
  assertSmokeJob(jobs["smoke-node-20"], candidate.lanes["smoke-node-20"]);
  assert.doesNotMatch(text, /^\s*paths(?:-ignore)?:/m, "required workflow cannot skip based on paths");
  assert.equal(
    /^ {2}merge_group:/m.test(text),
    candidate.merge_queue.enabled,
    "workflow trigger must match the recorded current merge-queue posture",
  );
  assert.equal(typeof candidate.merge_queue.evidence, "string");
  assert.equal(typeof candidate.merge_queue.enablement_requirement, "string");
  return jobs;
}

test('package source preflight cannot be removed, skipped or moved after installation', () => {
  const step = '      - name: Check package version sources before installation\n        run: npm run check:package-versions';
  for (const changed of [
    workflow.replace(step, ''),
    workflow.replace(step, `${step}\n        if: false`),
    workflow.replace(`${step}\n      - run: npm ci`, `      - run: npm ci\n${step}`),
  ]) assert.throws(() => validateCiTopology(changed), /source preflight/);
});

test("CI runs every maintained lane unconditionally", () => {
  validateCiTopology(workflow);
  assert.equal(extractJobs(workflow).windows, undefined, "Windows proof belongs to the independent Windows distribution");
});

test("browser CI pins a complete no-download Playwright environment", () => {
  const jobs = validateCiTopology(workflow);
  validateBrowserJob(jobs.browser, { root: rootPackage, mcpApp: mcpAppPackage, ui: uiPackage, browserLocal: browserLocalPackage });
});

test("browser container and reachable install-policy mutations fail closed", () => {
  for (const [name, changed, error] of [
    ["digest", workflow.replace(PLAYWRIGHT_IMAGE_DIGEST, `${PLAYWRIGHT_IMAGE_DIGEST.slice(0, -1)}0`), /immutable Playwright image/],
    ["tag", workflow.replace(`v${PLAYWRIGHT_VERSION}-noble`, "v1.61.0-noble"), /immutable Playwright image/],
    ["ipc", workflow.replace("options: --ipc=host", "options: --init"), /exact reviewed container option/],
    ["registry", workflow.replace("PLAYWRIGHT_BROWSERS_PATH: /ms-playwright", "PLAYWRIGHT_BROWSERS_PATH: /tmp/browsers"), /baked registry/],
    ["chromium marker", workflow.replace('`chromium-${chromium.revision}`, "INSTALLATION_COMPLETE"', '`chromium-${chromium.revision}`'), /every baked artifact/],
    ["headless executable", workflow.replace('"chrome-headless-shell-linux64", "chrome-headless-shell"', '"chrome-headless-shell-linux64"'), /every baked artifact/],
    ["ffmpeg marker", workflow.replace('`ffmpeg-${ffmpeg.revision}`, "INSTALLATION_COMPLETE"', '`ffmpeg-${ffmpeg.revision}`'), /every baked artifact/],
    ["ffmpeg executable", workflow.replace('`ffmpeg-${ffmpeg.revision}`, "ffmpeg-linux"', '`ffmpeg-${ffmpeg.revision}`'), /every baked artifact/],
    ["workflow install", workflow.replace("      - run: npm run ci:browser", "      - run: playwright install --with-deps chromium\n      - run: npm run ci:browser"), /runtime installation/],
  ]) {
    assert.throws(() => validateCiTopology(changed), error, name);
  }

  const forced = structuredClone(mcpAppPackage);
  forced.scripts["test:browser"] = forced.scripts["test:browser"].replace(
    "playwright install chromium",
    "playwright install chromium --force",
  );
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: rootPackage, mcpApp: forced, ui: uiPackage, browserLocal: browserLocalPackage }),
    /complete reviewed command/,
  );

  const extra = structuredClone(uiPackage);
  extra.scripts["e2e:gate"] += " && playwright install chromium";
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: rootPackage, mcpApp: mcpAppPackage, ui: extra, browserLocal: browserLocalPackage }),
    /complete reviewed command/,
  );

  const nested = structuredClone(rootPackage);
  nested.scripts.prebuild = "npm run browser-environment";
  nested.scripts["browser-environment"] = "apt-get update";
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: nested, mcpApp: mcpAppPackage, ui: uiPackage, browserLocal: browserLocalPackage }),
    /cannot install system dependencies/,
  );

  const alternateRoot = structuredClone(rootPackage);
  const alternateUi = structuredClone(uiPackage);
  alternateRoot.scripts.prebuild = "npm --workspace @superbee/ui run browser-environment";
  alternateUi.scripts["browser-environment"] = "apt-get update";
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: alternateRoot, mcpApp: mcpAppPackage, ui: alternateUi, browserLocal: browserLocalPackage }),
    /cannot install system dependencies/,
  );

  const hooked = structuredClone(mcpAppPackage);
  hooked.scripts["pretest:browser"] = "playwright install chromium --force";
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: rootPackage, mcpApp: hooked, ui: uiPackage, browserLocal: browserLocalPackage }),
    /exactly three Playwright install checks|force downloads/,
  );

  const forcedLocal = structuredClone(browserLocalPackage);
  forcedLocal.scripts["test:browser"] = forcedLocal.scripts["test:browser"].replace(
    "playwright install chromium",
    "playwright install chromium --force",
  );
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: rootPackage, mcpApp: mcpAppPackage, ui: uiPackage, browserLocal: forcedLocal }),
    /complete reviewed command/,
  );
});

test("canonical and legacy compatibility contexts are identical fail-closed aggregators", () => {
  const jobs = validateCiTopology(workflow);
  assert.match(jobs.required, /name: CI required lanes/);
  assert.match(jobs["compatibility-gate-node-22"], /name: gate \(node 22\)/);
  assert.match(jobs["compatibility-gate-node-26"], /name: gate \(node 26\)/);
  for (const [name, job] of [
    ["required", jobs.required],
    ["compatibility-gate-node-22", jobs["compatibility-gate-node-22"]],
    ["compatibility-gate-node-26", jobs["compatibility-gate-node-26"]],
  ]) assertAggregator(job, name);
});

test("renamed or removed aggregator dependencies are detected statically", () => {
  const jobs = extractJobs(workflow);
  const removed = jobs.required.replace("runtime, ", "");
  assert.throws(() => assertAggregator(removed, "removed"), /needs every required lane/);
  const renamed = jobs.required.replace("runtime,", "runtime-renamed,");
  assert.throws(() => assertAggregator(renamed, "renamed"), /needs every required lane/);
  const conditional = jobs.required.replace("if: ${{ always() }}", "if: ${{ success() }}");
  assert.throws(() => assertAggregator(conditional, "conditional"), /must run after every conclusion/);
});

test("workflow mutation attacks cannot hide failures or weaken required job identity", () => {
  assert.throws(
    () => validateCiTopology(workflow.replace("        run: npm run ci:runtime", "        run: npm run ci:runtime\n        continue-on-error: true")),
    /cannot mask a failing step/,
  );
  assert.throws(
    () => validateCiTopology(workflow.replace("name: distribution package and installed behavior", "name: distribution")),
    /distribution display name drifted/,
  );
  for (const [from, to, error] of [
    ["    runs-on: macos-latest", "    runs-on: ubuntu-latest", /aliasing-host must run on macos-latest/],
    ["        run: npm run ci:aliasing-host", "        run: npm run ci:runtime", /aliasing-host must run its declared script/],
    ['      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "1"', '      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "0"', /aliasing-host must pin the host-class expectation/],
    ['      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "0"', '      SUPERBEE_TEST_EXPECT_ALIASING_HOST: "1"', /runtime must pin the host-class expectation/],
    ['test -e "$RUNNER_TEMP/host-probe/PROBE-NAME"', "true", /aliasing-host must self-check its host class/],
    ['test ! -e "$RUNNER_TEMP/host-probe/PROBE-NAME"', "true", /runtime must self-check its host class/],
    ["          node-version: 20", "          node-version: 22", /second setup-node|deep-equal/],
    ["          node --version | grep -q '^v20\\.'", "          node --version", /self-check/],
    ["          node \"$CLI\" status --dir \"$DIR\"", "          node --version", /command surface/],
    ["        shard: [1, 2]", "        shard: [1]", /every declared shard/],
    ["      SUPERBEE_TEST_SHARD: ${{ matrix.shard }}/2\n", "", /export its shard/],
    ["      SUPERBEE_TEST_SHARD: ${{ matrix.shard }}/2", "      SUPERBEE_TEST_SHARD: ${{ matrix.shard }}/3", /export its shard/],
  ]) {
    assert.throws(() => validateCiTopology(workflow.replace(from, to)), error);
  }
  const incomplete = structuredClone(manifest);
  incomplete.required_jobs.pop();
  assert.throws(() => validateCiTopology(workflow, incomplete), /required_jobs must equal the automatically run lane set/);
});

test("merge-queue posture is current configuration, not a permanent prohibition", () => {
  assert.equal(manifest.merge_queue.enabled, false);
  const enabled = structuredClone(manifest);
  enabled.merge_queue.enabled = true;
  const withMergeGroup = workflow.replace("on:\n", "on:\n  merge_group:\n");
  assert.doesNotThrow(() => validateCiTopology(withMergeGroup, enabled));
  assert.throws(() => validateCiTopology(workflow, enabled), /merge-queue posture/);
});
