import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci-tests.yml"), "utf8");
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const mcpAppPackage = JSON.parse(readFileSync(path.join(root, "packages", "mcp-app", "package.json"), "utf8"));
const uiPackage = JSON.parse(readFileSync(path.join(root, "packages", "ui", "package.json"), "utf8"));
const workspacePackages = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(path.join(root, "packages", entry.name, "package.json"), "utf8")));
const windowsWorkflow = readFileSync(
  path.join(root, ".github", "workflows", "windows-installed-package.yml"),
  "utf8",
);
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
const windowsInstalledProofBytes = readFileSync(
  path.join(root, manifest.lanes.windows.installed_package_proof_script),
);
const windowsInstalledProof = windowsInstalledProofBytes.toString("utf8");

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

function workflowTriggers(text) {
  const on = /^on:\n((?: {2}[^\n]*\n?)*)/m.exec(text);
  assert.ok(on, "workflow must declare triggers");
  return [...on[1].matchAll(/^ {2}([A-Za-z_]+):/gm)].map((match) => match[1]);
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

function proofProgram(source) {
  return ts.createSourceFile("windows-installed-package-proof.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function proofFunction(program, name) {
  const declarations = program.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  assert.equal(declarations.length, 1, `installed-package proof must declare ${name} exactly once`);
  const declaration = declarations[0];
  assert.ok(declaration?.body, `installed-package proof must declare ${name}`);
  return declaration;
}

function awaitedCall(statement) {
  let expression;
  let binding = "";
  if (ts.isExpressionStatement(statement)) {
    expression = statement.expression;
  } else if (ts.isVariableStatement(statement)) {
    assert.equal(statement.declarationList.declarations.length, 1, "proof await bindings must be singular");
    const declaration = statement.declarationList.declarations[0];
    expression = declaration.initializer;
    binding = declaration.name.getText();
  }
  if (!expression || !ts.isAwaitExpression(expression) || !ts.isCallExpression(expression.expression)) return undefined;
  return {
    name: expression.expression.expression.getText(),
    args: expression.expression.arguments.map((argument) => argument.getText()),
    binding,
  };
}

function proofNodes(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function staticMemberPath(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const owner = staticMemberPath(node.expression);
    return owner ? `${owner}.${node.name.text}` : undefined;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression
    && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    const owner = staticMemberPath(node.expression);
    return owner ? `${owner}.${node.argumentExpression.text}` : undefined;
  }
  return undefined;
}

function validateProofCompletionAuthority(program, lifecycle, completionAssertion, successWrite) {
  assert.ok(
    ts.isExpressionStatement(successWrite) && ts.isCallExpression(successWrite.expression),
    "the native proof must retain one terminal success statement",
  );
  const successCall = successWrite.expression;
  assert.equal(
    successWrite.getText(),
    [
      "process.stdout.write(`${JSON.stringify({",
      "    platform: process.platform,",
      '    artifact: "exact installed npm tarball",',
      '    scenarios: ["catalog-lifecycle", "local-remote-sync", "ui-url-lifecycle", "managed-document-lifecycle", "mcp-config-lifecycle"],',
      "  })}\\n`);",
    ].join("\n"),
    "the native proof terminal success payload must retain its reviewed receipt",
  );

  const calls = proofNodes(program, ts.isCallExpression);
  const memberAccesses = proofNodes(program, (node) =>
    ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
  );
  const stdoutAuthorities = memberAccesses.filter((node) => staticMemberPath(node) === "process.stdout.write");
  assert.equal(stdoutAuthorities.length, 1, "the native proof permits exactly one stdout authority");
  assert.equal(
    stdoutAuthorities[0],
    successCall.expression,
    "the native proof stdout authority must be the terminal success statement",
  );
  const stdoutObjects = memberAccesses.filter((node) => staticMemberPath(node) === "process.stdout");
  assert.equal(stdoutObjects.length, 1, "the native proof cannot alias its stdout authority");
  assert.equal(stdoutObjects[0].parent, successCall.expression);

  const exitAuthorities = memberAccesses.filter((node) =>
    ["process.exit", "process.exitCode", "process.abort"].includes(staticMemberPath(node))
  );
  assert.equal(exitAuthorities.length, 0, "the native proof permits no process exit authority");

  const stderrAuthorities = memberAccesses.filter((node) => staticMemberPath(node) === "process.stderr.write");
  const scenarioStderrAuthorities = proofNodes(
    proofFunction(program, "runScenario"),
    (node) => (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && staticMemberPath(node) === "process.stderr.write",
  );
  assert.equal(
    stderrAuthorities.length,
    scenarioStderrAuthorities.length,
    "only the reviewed scenario wrapper may emit progress diagnostics on stderr",
  );
  for (let index = 0; index < stderrAuthorities.length; index += 1) {
    assert.equal(
      stderrAuthorities[index],
      scenarioStderrAuthorities[index],
      "only the reviewed scenario wrapper may emit progress diagnostics on stderr",
    );
  }
  assert.equal(stderrAuthorities.length, 4, "the scenario wrapper must emit START, SLOW, PASS, and FAIL diagnostics");

  const outputAuthorities = memberAccesses.filter((node) =>
    [
      "process.stdout.end",
      "process.stderr.end",
      "console.log",
      "console.info",
      "console.warn",
      "console.error",
    ].includes(staticMemberPath(node))
  );
  assert.equal(outputAuthorities.length, 0, "the native proof permits no alternate success-shaped output authority");

  const successHandlers = calls.filter((call) => {
    const callee = staticMemberPath(call.expression);
    const memberName = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : ts.isElementAccessExpression(call.expression)
        && call.expression.argumentExpression
        && (ts.isStringLiteral(call.expression.argumentExpression)
          || ts.isNoSubstitutionTemplateLiteral(call.expression.argumentExpression))
        ? call.expression.argumentExpression.text
        : undefined;
    if (memberName === "then") return true;
    if (!callee) return false;
    if (!["process.on", "process.once", "process.addListener", "process.prependListener"].includes(callee)) {
      return false;
    }
    return ['"exit"', "'exit'", '"beforeExit"', "'beforeExit'"].includes(call.arguments[0]?.getText());
  });
  assert.equal(successHandlers.length, 0, "the native proof permits no alternate success handler");

  const runnerReferences = proofNodes(program, (node) =>
    ts.isIdentifier(node) && node.text === "runInstalledPackageProof"
  );
  const completionStatement = successWrite.parent.statements[0];
  assert.ok(ts.isVariableStatement(completionStatement));
  const completionAwait = completionStatement.declarationList.declarations[0]?.initializer;
  assert.ok(ts.isAwaitExpression(completionAwait));
  const runnerCall = completionAwait.expression;
  assert.ok(ts.isCallExpression(runnerCall), "the native proof terminal entrypoint must call its lifecycle runner");
  assert.equal(runnerReferences.length, 2, "the native proof permits one lifecycle runner authority");
  assert.equal(runnerReferences[0], lifecycle.name, "the lifecycle runner authority must begin at its declaration");
  assert.equal(runnerReferences[1], runnerCall.expression, "the lifecycle runner authority must end at the terminal call");

  const completionReturn = lifecycle.body.statements.at(-1);
  assert.ok(ts.isReturnStatement(completionReturn), "the lifecycle runner must return its completion token");
  assert.ok(
    ts.isExpressionStatement(completionAssertion) && ts.isCallExpression(completionAssertion.expression),
    "the terminal entrypoint must assert the lifecycle completion token",
  );
  const completionAssertionCall = completionAssertion.expression;
  const completionTokenDeclaration = program.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText() === "installedPackageProofComplete");
  const completionTokenReferences = proofNodes(program, (node) =>
    ts.isIdentifier(node) && node.text === "installedPackageProofComplete"
  );
  assert.equal(completionTokenReferences.length, 3, "the native proof permits one completion-token authority path");
  assert.equal(completionTokenReferences[0], completionTokenDeclaration?.name);
  assert.equal(completionTokenReferences[1], completionReturn.expression);
  assert.equal(completionTokenReferences[2], completionAssertionCall.arguments[1]);
}

function validateProofTopLevel(program) {
  const expectedImports = [
    "node:assert/strict",
    "node:child_process",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:util",
    "node:url",
  ];
  const imports = program.statements.filter(ts.isImportDeclaration);
  assert.deepEqual(
    imports.map((statement) => statement.moduleSpecifier.text),
    expectedImports,
    "the native proof must retain only its reviewed imports",
  );

  const expectedInitializers = new Map([
    ["execFileAsync", "promisify(execFile)"],
    ["entrypoint", "process.env.SUPERBEE_WINDOWS_INSTALLED_ENTRYPOINT"],
    ["prefix", "process.env.SUPERBEE_WINDOWS_INSTALLED_PREFIX"],
    ["COMMAND_TIMEOUT_MS", "45_000"],
    ["SCENARIO_SLOW_MS", "120_000"],
    ["scratch", 'await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "superbee-windows-installed-"))'],
    ["home", 'path.join(scratch, "home")'],
    ["localAppData", 'path.join(home, "AppData", "Local")'],
    ["appData", 'path.join(home, "AppData", "Roaming")'],
    ["commandEnv", `{
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: localAppData,
  APPDATA: appData,
  npm_config_prefix: prefix,
  PATH: \`\${prefix}\${path.delimiter}\${process.env.PATH ?? ""}\`,
  AGENTSTATE_LITE_NO_AUTOPULL: "1",
}`],
    ["installedPackageProofComplete", 'Symbol("installed-package-proof-complete")'],
  ]);
  const expectedFunctions = [
    "run",
    "runScenario",
    "windowsCaseAlias",
    "cli",
    "cliJson",
    "git",
    "proveCatalogLifecycle",
    "configureRepository",
    "proveLocalRemoteSync",
    "proveUiUrlLifecycle",
    "renderManagedDocumentInChromium",
    "proveManagedDocumentLifecycle",
    "proveMcpConfigLifecycle",
    "runInstalledPackageProof",
  ];
  const expectedSetup = [
    'assert.equal(process.platform, "win32", "this proof must execute on the native Windows runner");',
    'assert.ok(entrypoint, "SUPERBEE_WINDOWS_INSTALLED_ENTRYPOINT is required");',
    'assert.ok(prefix, "SUPERBEE_WINDOWS_INSTALLED_PREFIX is required");',
    "await Promise.all([access(entrypoint), access(prefix)]);",
  ];

  let importIndex = 0;
  let functionIndex = 0;
  let setupIndex = 0;
  let entryTry;
  for (const statement of program.statements) {
    if (ts.isImportDeclaration(statement)) {
      assert.equal(importIndex < expectedImports.length, true, "the native proof cannot add imports");
      importIndex += 1;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      assert.equal(statement.declarationList.declarations.length, 1, "top-level proof declarations must be singular");
      const declaration = statement.declarationList.declarations[0];
      const name = declaration.name.getText();
      assert.ok(expectedInitializers.has(name), `the native proof cannot add or duplicate top-level declaration ${name}`);
      assert.equal(
        declaration.initializer?.getText(),
        expectedInitializers.get(name),
        `the native proof top-level declaration ${name} must retain its reviewed initializer`,
      );
      expectedInitializers.delete(name);
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      assert.equal(
        statement.name?.text,
        expectedFunctions[functionIndex],
        "the native proof must retain its reviewed helper and runner declarations",
      );
      functionIndex += 1;
      continue;
    }
    if (ts.isExpressionStatement(statement) && setupIndex < expectedSetup.length) {
      assert.equal(
        statement.getText(),
        expectedSetup[setupIndex],
        "the native proof must retain only its reviewed pre-entry setup",
      );
      setupIndex += 1;
      continue;
    }
    assert.ok(ts.isTryStatement(statement) && !entryTry, "the native proof permits only one terminal entrypoint");
    entryTry = statement;
  }

  assert.equal(importIndex, expectedImports.length, "the native proof import topology is incomplete");
  assert.equal(expectedInitializers.size, 0, "the native proof declaration topology is incomplete");
  assert.equal(functionIndex, expectedFunctions.length, "the native proof function topology is incomplete");
  assert.equal(setupIndex, expectedSetup.length, "the native proof setup topology is incomplete");
  assert.equal(program.statements.at(-1), entryTry, "the native proof entrypoint must be the final top-level statement");
  assert.ok(entryTry, "the native proof must declare its terminal entrypoint");
  return entryTry;
}

function validateWindowsInstalledProofDigest(lane, proof) {
  assert.match(
    lane.installed_package_proof_sha256,
    /^[a-f0-9]{64}$/,
    "Windows installed-package proof SHA-256 must be a lowercase hex digest",
  );
  assert.equal(
    createHash("sha256").update(proof).digest("hex"),
    lane.installed_package_proof_sha256,
    "Windows installed-package proof bytes must match the reviewed SHA-256 digest",
  );
  assert.deepEqual(
    lane.installed_package_proof_digest_update,
    {
      command: "node scripts/windows-installed-package-proof-digest.mjs",
      instructions: "After an intentional review of the proof bytes, run the command and update installed_package_proof_sha256 in this manifest in the same commit.",
    },
    "the reviewed proof digest must have one explicit update workflow",
  );
}

function validateWindowsInstalledProofSemantics(job, lane, proof = windowsInstalledProof) {
  const expectedEntrypoint = '$entrypoint = Join-Path $prefix "node_modules\\superbee\\dist\\superbee.mjs"';
  assert.ok(job.includes(expectedEntrypoint), "Windows runner must derive the exact globally installed entrypoint");
  assert.ok(
    job.indexOf("npm install --global $env:SUPERBEE_WINDOWS_TARBALL --prefix $prefix") < job.indexOf(expectedEntrypoint),
    "Windows runner must install the tarball before binding its global entrypoint",
  );
  assert.match(
    job,
    /\$env:SUPERBEE_WINDOWS_INSTALLED_ENTRYPOINT = \$entrypoint\s+\$env:SUPERBEE_WINDOWS_INSTALLED_PREFIX = \$prefix\s+node scripts\/windows-installed-package-proof\.mjs/,
    "Windows runner must pass the exact installed entrypoint to the proof it executes",
  );

  const program = proofProgram(proof);
  const entrypointDeclaration = program.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText() === "entrypoint");
  assert.equal(
    entrypointDeclaration?.initializer?.getText(),
    "process.env.SUPERBEE_WINDOWS_INSTALLED_ENTRYPOINT",
    "the proof must consume only the runner-bound installed entrypoint",
  );

  const cliDeclaration = proofFunction(program, "cli");
  const cliReturn = cliDeclaration.body.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(ts.isCallExpression(cliReturn), "installed-package cli helper must return one execution call");
  assert.equal(cliReturn.expression.getText(), "run", "installed-package cli helper must use the proof runner");
  assert.equal(
    cliReturn.arguments[0]?.getText(),
    "process.execPath",
    "installed-package lifecycle commands must execute through Node and the bound entrypoint",
  );
  assert.ok(ts.isArrayLiteralExpression(cliReturn.arguments[1]), "installed-package cli helper must build an argv array");
  assert.deepEqual(
    cliReturn.arguments[1].elements.map((element) => element.getText()),
    ["entrypoint", "...args"],
    "installed-package lifecycle commands must execute through Node and the bound entrypoint",
  );

  const runSource = proofFunction(program, "run").getText();
  assert.match(
    runSource,
    /timeout: options\.timeoutMs \?\? COMMAND_TIMEOUT_MS/,
    "every installed-package child process must have the reviewed command deadline",
  );
  assert.match(runSource, /killSignal: "SIGKILL"/, "a timed-out installed-package child must be terminated");
  const scenarioSource = proofFunction(program, "runScenario").getText();
  assert.match(scenarioSource, /const result = await operation\(\)/, "scenario telemetry must observe the complete lifecycle");
  assert.doesNotMatch(scenarioSource, /Promise\.race/, "scenario telemetry must not pretend to cancel still-running work");
  assert.match(scenarioSource, /SCENARIO_SLOW_MS/, "each lifecycle must use the reviewed slow-scenario threshold");
  assert.match(scenarioSource, /WINDOWS_PROOF_SLOW/, "slow scenario telemetry must be explicit and non-terminal");
  for (const state of ["START", "PASS", "FAIL"]) {
    assert.match(scenarioSource, new RegExp(`WINDOWS_PROOF_${state}`), `scenario telemetry must report ${state}`);
  }
  const browserSource = proofFunction(program, "renderManagedDocumentInChromium").getText();
  assert.match(
    browserSource,
    /process\.env\.CHROMEWEBDRIVER/,
    "the native browser render must use the runner's matched ChromeDriver",
  );
  assert.match(
    browserSource,
    /webdriver\("GET", `\/session\/\$\{sessionId\}\/source`\)/,
    "the native browser render must inspect the browser-serialized DOM",
  );
  assert.match(
    browserSource,
    /const renderDeadline = Date\.now\(\) \+ 15_000/,
    "the native browser render must retain a bounded render deadline",
  );

  const lifecycle = proofFunction(program, "runInstalledPackageProof");
  assert.deepEqual(
    lifecycle.body.statements.map((statement) => {
      const call = awaitedCall(statement);
      if (call) return { kind: "await", ...call };
      if (ts.isReturnStatement(statement)) {
        return { kind: "return", expression: statement.expression?.getText() ?? "" };
      }
      return { kind: ts.SyntaxKind[statement.kind] };
    }),
    [
      { kind: "await", name: "runScenario", args: ['"catalog-lifecycle"', "proveCatalogLifecycle"], binding: "{ bundle }" },
      { kind: "await", name: "runScenario", args: ['"local-remote-sync"', "proveLocalRemoteSync"], binding: "" },
      { kind: "await", name: "runScenario", args: ['"ui-url-lifecycle"', "() => proveUiUrlLifecycle(bundle)"], binding: "" },
      { kind: "await", name: "runScenario", args: ['"managed-document-lifecycle"', "() => proveManagedDocumentLifecycle(bundle)"], binding: "" },
      { kind: "await", name: "runScenario", args: ['"mcp-config-lifecycle"', "proveMcpConfigLifecycle"], binding: "" },
      { kind: "return", expression: "installedPackageProofComplete" },
    ],
    "the installed-package runner must wrap exactly five awaited lifecycles before its completion token",
  );
  const entryTry = validateProofTopLevel(program);
  assert.equal(entryTry?.tryBlock.statements.length, 3, "the native proof entrypoint must gate success on completion");
  const completionBinding = awaitedCall(entryTry?.tryBlock.statements[0] ?? {});
  assert.deepEqual(
    completionBinding,
    { name: "runInstalledPackageProof", args: [], binding: "completion" },
    "the native proof entrypoint must capture the complete lifecycle runner's result",
  );
  const completionAssertion = entryTry?.tryBlock.statements[1];
  assert.equal(
    completionAssertion?.getText(),
    'assert.equal(completion, installedPackageProofComplete, "every installed-package lifecycle must complete");',
    "the native proof entrypoint must reject every incomplete lifecycle run",
  );
  const successWrite = entryTry?.tryBlock.statements[2];
  assert.ok(
    ts.isExpressionStatement(successWrite) && ts.isCallExpression(successWrite.expression)
      && successWrite.expression.expression.getText() === "process.stdout.write",
    "the native proof must report success only after the complete lifecycle runner",
  );
  validateProofCompletionAuthority(program, lifecycle, completionAssertion, successWrite);
  assert.equal(entryTry.catchClause, undefined, "the native proof entrypoint cannot convert failures to success");
  assert.equal(entryTry.finallyBlock?.statements.length, 1, "the native proof entrypoint must retain one cleanup action");
  assert.deepEqual(
    awaitedCall(entryTry.finallyBlock?.statements[0] ?? {}),
    {
      name: "rm",
      args: ["scratch", "{ recursive: true, force: true, maxRetries: 20, retryDelay: 150 }"],
      binding: "",
    },
    "the native proof entrypoint must clean only its scratch directory after completion or failure",
  );

  assert.deepEqual(
    Object.keys(lane.installed_package_scenarios).sort(),
    ["catalog-lifecycle", "local-remote-sync", "managed-document-lifecycle", "mcp-config-lifecycle", "ui-url-lifecycle"],
    "Windows installed-package scenario inventory drifted",
  );
  for (const [scenario, literals] of Object.entries(lane.installed_package_scenarios)) {
    assert.ok(Array.isArray(literals) && literals.length > 0, `${scenario} must pin command/evidence literals`);
    for (const literal of literals) {
      assert.ok(proof.includes(literal), `${scenario} lost proof literal ${literal}`);
    }
  }
}

function validateWindowsInstalledProof(job, lane, proof = windowsInstalledProofBytes) {
  validateWindowsInstalledProofDigest(lane, proof);
  validateWindowsInstalledProofSemantics(
    job,
    lane,
    Buffer.isBuffer(proof) ? proof.toString("utf8") : proof,
  );
}

function assertWindowsPreflightJob(job, lane) {
  const steps = stepsOf(job);
  assert.match(job, /^ {4}runs-on: windows-latest\s*$/m);
  assert.match(job, /^ {4}timeout-minutes: 20\s*$/m);
  assert.equal((job.match(/actions\/setup-node@v4/g) ?? []).length, 1);
  assert.deepEqual([...job.matchAll(/^ {10}node-version: (.+)\s*$/gm)].map((match) => Number(match[1])), [lane.runtime_node]);
  const filesystemStep = requiredUnconditionalStep(steps, {
    label: "Windows-sensitive filesystem regressions",
    name: "Run Windows-sensitive filesystem regressions first",
    workingDirectory: undefined,
    run: "|",
  });
  assert.match(job, /npm test -w @superbee\/core -- --test-name-pattern="AC-10"/);
  assert.match(job, /npm test -w @superbee\/publication/);
  const kindDraftProbe = "node scripts/run-test-command.mjs node --test --import ./test/ts-loader.mjs ./test/kind-draft.test.ts";
  const kindDraftStep = requiredUnconditionalStep(steps, {
    label: "Windows command-emission contract",
    name: "Run Windows command-output regressions first",
    workingDirectory: "packages/cli",
    run: kindDraftProbe,
  });
  const managedUiProbe = 'node --test --test-name-pattern="built CLI returns while its managed document remains live|managed worker preserves an indexless project-binding boundary" --import ./test/ts-loader.mjs ./test/ui-managed-authority.test.ts ./test/ui.test.ts';
  const managedUiStep = requiredUnconditionalStep(steps, {
    label: "Windows managed UI startup contract",
    name: "Run the managed UI Windows startup proof first",
    workingDirectory: "packages/cli",
    run: managedUiProbe,
  });
  const typecheck = "npm run typecheck --workspaces --if-present --ignore-scripts";
  const typecheckStep = requiredUnconditionalStep(steps, {
    label: "Windows complete workspace typecheck",
    name: "Typecheck the complete workspace contract natively",
    workingDirectory: undefined,
    run: typecheck,
  });
  const nonCliWorkspaces = [
    "@superbee/board-git",
    "@superbee/core",
    "@superbee/markdown-renderer",
    "@superbee/mcp-app",
    "@superbee/publication",
    "@superbee/server",
    "@superbee/ui",
    "@superbee/ui-server",
    "@superbee/view-runtime",
  ];
  const nonCliCommand = `npm test --if-present --ignore-scripts ${nonCliWorkspaces.map((workspace) => `-w ${workspace}`).join(" ")}`;
  const nonCliStep = requiredUnconditionalStep(steps, {
    label: "Windows non-CLI workspace coverage",
    name: "Run the non-CLI workspace contracts natively",
    workingDirectory: undefined,
    run: nonCliCommand,
  });
  assert.doesNotMatch(job, /run: npm run ci:runtime/, "Windows runtime must remain split into observable failure domains");
  assert.ok(
    filesystemStep.position < kindDraftStep.position
      && kindDraftStep.position < managedUiStep.position
      && managedUiStep.position < typecheckStep.position
      && typecheckStep.position < nonCliStep.position,
    "Windows-sensitive probes must fail before the complete preflight workspace contract",
  );
}

function assertWindowsCliJob(job, lane) {
  const steps = stepsOf(job);
  assert.match(job, /^ {4}runs-on: windows-latest\s*$/m);
  assert.match(job, /^ {4}timeout-minutes: 30\s*$/m);
  assert.match(job, /^ {6}fail-fast: false\s*$/m);
  assert.match(job, /^ {8}shard: \[1, 2, 3, 4\]\s*$/m);
  assert.equal((job.match(/actions\/setup-node@v4/g) ?? []).length, 1);
  assert.deepEqual([...job.matchAll(/^ {10}node-version: (.+)\s*$/gm)].map((match) => Number(match[1])), [lane.runtime_node]);
  const shardCommand = "node scripts/run-test-command.mjs node --test --test-shard=${{ matrix.shard }}/4 --import ./test/ts-loader.mjs './test/*.test.ts'";
  requiredUnconditionalStep(steps, {
    label: "Windows parallel CLI shard",
    name: "Run the CLI runtime contract",
    workingDirectory: "packages/cli",
    run: shardCommand,
  });
  assert.match(job, /^ {6}- run: npm run build\s*$/m, "each fresh Windows shard must build before testing");
}

function assertWindowsPackageJob(job, lane) {
  assert.match(job, /^ {4}runs-on: windows-latest\s*$/m);
  assert.match(job, /^ {4}timeout-minutes: 25\s*$/m);
  assert.equal((job.match(/actions\/setup-node@v4/g) ?? []).length, 2);
  assert.deepEqual(
    [...job.matchAll(/^ {10}node-version: (.+)\s*$/gm)].map((match) => Number(match[1])),
    [lane.runtime_node, lane.installed_package_node],
  );
  assert.match(job, /npm run --silent pack:npm-package -- --pack-destination \$env:RUNNER_TEMP/);
  assert.match(job, /npm run verify:npm-package:tarball -- \$tarball/);
  assert.match(job, /npm install --global \$env:SUPERBEE_WINDOWS_TARBALL --prefix \$prefix/);
  assert.match(job, /Join-Path \$prefix "superbee\.cmd"/);
  assert.equal(lane.installed_package_proof_script, "scripts/windows-installed-package-proof.mjs");
  assert.ok(
    job.includes(`node ${lane.installed_package_proof_script}`),
    "Windows smoke must run the pinned installed-package proof script",
  );
  validateWindowsInstalledProof(job, lane);
  for (const command of lane.built_cli_commands) {
    assert.ok(job.includes(`& $cli ${command}`), `Windows smoke is missing ${command}`);
  }
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

function validateBrowserScripts(packages) {
  const rootCommand = packages.root.scripts["ci:browser"];
  const mcpCommand = packages.mcpApp.scripts["test:browser"];
  const uiCommand = packages.ui.scripts["e2e:gate"];
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

  const packageByName = new Map(workspacePackages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of [packages.root, packages.mcpApp, packages.ui]) packageByName.set(pkg.name, pkg);
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
        if (!/\bnpm\s+run\b/.test(segment)) continue;
        assert.match(segment, /^npm\s+run\s+/, `reachable npm invocation must start its command segment: ${segment}`);
        const tokens = segment.trim().split(/\s+/);
        const nestedScript = tokens[2];
        assert.ok(nestedScript && !nestedScript.startsWith("-"), `reachable npm invocation must name its script: ${segment}`);
        const workspaces = [];
        for (let index = 3; index < tokens.length; index += 1) {
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
          assert.fail(`unsupported reachable npm-run argument ${token}: ${segment}`);
        }
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
    2,
    "the ci:browser chain permits exactly two Playwright install checks",
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
  browserPackages = { root: rootPackage, mcpApp: mcpAppPackage, ui: uiPackage },
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
  }
  assert.match(jobs.runtime, /node-version: \[22, 26\]/);
  assert.match(jobs.runtime, /run: npm run ci:runtime/);
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

function validateWindowsProofWorkflow(text, candidate = manifest) {
  const lane = candidate.lanes.windows;
  assert.equal(lane.required, false, "Windows proof must not be part of automatic required CI");
  assert.equal(lane.trigger, "workflow_dispatch", "Windows proof must declare its explicit trigger");
  assert.equal(lane.workflow, ".github/workflows/windows-installed-package.yml");
  assert.match(text, /^name: Windows installed-package proof$/m);
  assert.deepEqual(workflowTriggers(text), ["workflow_dispatch"], "Windows proof must be manually dispatched only");
  const jobs = extractJobs(text);
  assert.deepEqual(
    Object.keys(jobs),
    ["windows-preflight", "windows-cli", "windows-package"],
    "manual Windows workflow must contain exactly the parallel preflight, CLI, and package proof jobs",
  );
  assert.doesNotMatch(text, /^\s+continue-on-error:/m, "Windows proof jobs must fail closed");
  assertWindowsPreflightJob(jobs["windows-preflight"], lane);
  assertWindowsCliJob(jobs["windows-cli"], lane);
  assertWindowsPackageJob(jobs["windows-package"], lane);
  return jobs;
}

test("CI runs every automatic lane unconditionally and keeps Windows proof manual", () => {
  validateCiTopology(workflow);
  validateWindowsProofWorkflow(windowsWorkflow);
  assert.equal(extractJobs(workflow).windows, undefined, "ordinary CI must not define the Windows proof job");
});

test("browser CI pins a complete no-download Playwright environment", () => {
  const jobs = validateCiTopology(workflow);
  validateBrowserJob(jobs.browser, { root: rootPackage, mcpApp: mcpAppPackage, ui: uiPackage });
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
    () => validateCiTopology(workflow, manifest, { root: rootPackage, mcpApp: forced, ui: uiPackage }),
    /complete reviewed command/,
  );

  const extra = structuredClone(uiPackage);
  extra.scripts["e2e:gate"] += " && playwright install chromium";
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: rootPackage, mcpApp: mcpAppPackage, ui: extra }),
    /complete reviewed command/,
  );

  const nested = structuredClone(rootPackage);
  nested.scripts.prebuild = "npm run browser-environment";
  nested.scripts["browser-environment"] = "apt-get update";
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: nested, mcpApp: mcpAppPackage, ui: uiPackage }),
    /cannot install system dependencies/,
  );

  const hooked = structuredClone(mcpAppPackage);
  hooked.scripts["pretest:browser"] = "playwright install chromium --force";
  assert.throws(
    () => validateCiTopology(workflow, manifest, { root: rootPackage, mcpApp: hooked, ui: uiPackage }),
    /exactly two Playwright install checks|force downloads/,
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
  ]) {
    assert.throws(() => validateCiTopology(workflow.replace(from, to)), error);
  }
  const incomplete = structuredClone(manifest);
  incomplete.required_jobs.pop();
  assert.throws(() => validateCiTopology(workflow, incomplete), /required_jobs must equal the automatically run lane set/);
});

test("Windows proof cannot be reattached to automatic CI or lose its manual trigger", () => {
  assert.throws(
    () => validateWindowsProofWorkflow(windowsWorkflow.replace("workflow_dispatch:", "pull_request:")),
    /manually dispatched only/,
  );
  assert.throws(
    () => validateWindowsProofWorkflow(windowsWorkflow.replace("  workflow_dispatch:", "  workflow_dispatch:\n  push:")),
    /manually dispatched only/,
  );
  const required = structuredClone(manifest);
  required.lanes.windows.required = true;
  assert.throws(() => validateCiTopology(workflow, required), /automatically run lane set/);
});

test("Windows runtime partition cannot lose its early probes, parallel shards, or workspace coverage", () => {
  const kindDraftProbe = "node scripts/run-test-command.mjs node --test --import ./test/ts-loader.mjs ./test/kind-draft.test.ts";
  const kindDraftStep = [
    "      - name: Run Windows command-output regressions first",
    "        working-directory: packages/cli",
    `        run: ${kindDraftProbe}`,
  ].join("\n");
  const nonCliStep = [
    "      - name: Run the non-CLI workspace contracts natively",
    "        run: npm test --if-present --ignore-scripts -w @superbee/board-git -w @superbee/core -w @superbee/markdown-renderer -w @superbee/mcp-app -w @superbee/publication -w @superbee/server -w @superbee/ui -w @superbee/ui-server -w @superbee/view-runtime",
  ].join("\n");
  assert.throws(
    () => validateWindowsProofWorkflow(
      windowsWorkflow.replace("shard: [1, 2, 3, 4]", "shard: [1, 2, 3]"),
    ),
    /shard/,
  );
  assert.throws(
    () => validateWindowsProofWorkflow(
      windowsWorkflow.replace(" -w @superbee/ui -w @superbee/ui-server", " -w @superbee/ui-server"),
    ),
    /workspace coverage.*drifted/,
  );
  assert.throws(
    () => validateWindowsProofWorkflow(
      windowsWorkflow.replace(
        "      - name: Run Windows command-output regressions first\n        working-directory: packages/cli",
        "      - name: Run Windows command-output regressions first\n        working-directory: .",
      ),
    ),
    /command-emission contract.*reviewed working directory/,
  );
  assert.throws(
    () => validateWindowsProofWorkflow(
      windowsWorkflow.replace(
        "      - name: Run the CLI runtime contract\n        working-directory: packages/cli",
        "      - name: Run the CLI runtime contract\n        working-directory: .",
      ),
    ),
    /parallel CLI shard.*reviewed working directory/,
  );
  const lateProbeWithCommentDecoy = windowsWorkflow
    .replace(kindDraftStep, `      # ${kindDraftProbe}`)
    .replace(nonCliStep, `${nonCliStep}\n${kindDraftStep}`);
  assert.throws(
    () => validateWindowsProofWorkflow(lateProbeWithCommentDecoy),
    /Windows-sensitive probes must fail before the complete preflight workspace contract/,
  );
  assert.throws(
    () => validateWindowsProofWorkflow(
      windowsWorkflow.replace(kindDraftStep, `${kindDraftStep}\n        if: \${{ false }}`),
    ),
    /command-emission contract must be unconditional/,
  );
  assert.throws(
    () => validateWindowsProofWorkflow(
      windowsWorkflow.replace(kindDraftStep, `${kindDraftStep}\n        continue-on-error: true`),
    ),
    /must fail closed/,
  );
  const skippedEarlyLateProbe = windowsWorkflow
    .replace(kindDraftStep, `${kindDraftStep}\n        if: \${{ false }}`)
    .replace(nonCliStep, `${nonCliStep}\n${kindDraftStep}`);
  assert.throws(
    () => validateWindowsProofWorkflow(skippedEarlyLateProbe),
    /command-emission contract must be declared exactly once by name/,
  );
  assert.throws(
    () => validateWindowsProofWorkflow(
      windowsWorkflow.replace(
        "npm run typecheck --workspaces --if-present --ignore-scripts",
        "npm run typecheck -w superbee --ignore-scripts",
      ),
    ),
    /complete workspace typecheck/,
  );
  for (const [from, to] of [
    ["timeout-minutes: 20", "timeout-minutes: 90"],
    ["timeout-minutes: 30", "timeout-minutes: 90"],
    ["timeout-minutes: 25", "timeout-minutes: 90"],
  ]) {
    assert.throws(
      () => validateWindowsProofWorkflow(windowsWorkflow.replace(from, to)),
      /timeout-minutes/,
    );
  }
});

test("Windows installed-package topology mutations cannot skip lifecycles or weaken artifact binding", () => {
  const windowsJob = extractJobs(windowsWorkflow)["windows-package"];
  const lane = manifest.lanes.windows;
  for (const call of [
    'const { bundle } = await runScenario("catalog-lifecycle", proveCatalogLifecycle);',
    'await runScenario("local-remote-sync", proveLocalRemoteSync);',
    'await runScenario("ui-url-lifecycle", () => proveUiUrlLifecycle(bundle));',
    'await runScenario("managed-document-lifecycle", () => proveManagedDocumentLifecycle(bundle));',
    'await runScenario("mcp-config-lifecycle", proveMcpConfigLifecycle);',
  ]) {
    assert.throws(
      () => validateWindowsInstalledProofSemantics(windowsJob, lane, windowsInstalledProof.replace(call, "")),
      /five awaited lifecycles/,
    );
    assert.throws(
      () => validateWindowsInstalledProofSemantics(windowsJob, lane, windowsInstalledProof.replace(call, call.replace("await ", "void "))),
      /five awaited lifecycles/,
    );
  }
  const runnerStart = "async function runInstalledPackageProof() {";
  for (const bypass of [
    "return;",
    "if (true) return;",
    "if (process.env.CI) return installedPackageProofComplete;",
    "throw new Error('skip');",
  ]) {
    assert.throws(
      () => validateWindowsInstalledProofSemantics(
        windowsJob,
        lane,
        windowsInstalledProof.replace(runnerStart, `${runnerStart}\n  ${bypass}`),
      ),
      /five awaited lifecycles/,
    );
  }
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob,
      lane,
      windowsInstalledProof.replace(
        "async function runInstalledPackageProof() {",
        "async function runInstalledPackageProof() {}\nasync function runInstalledPackageProof() {",
      ),
    ),
    /exactly once/,
  );
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob,
      lane,
      windowsInstalledProof.replace(
        '  assert.equal(completion, installedPackageProofComplete, "every installed-package lifecycle must complete");\n',
        "",
      ),
    ),
    /gate success on completion/,
  );
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob.replace(
        '$entrypoint = Join-Path $prefix "node_modules\\superbee\\dist\\superbee.mjs"',
        '$entrypoint = Join-Path $prefix "superbee.cmd"',
      ),
      lane,
    ),
    /exact globally installed entrypoint/,
  );
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob,
      lane,
      windowsInstalledProof.replace(
        "return run(process.execPath, [entrypoint, ...args], options);",
        'return run("superbee", args, options);',
      ),
    ),
    /bound entrypoint/,
  );
  const entryStart = "\ntry {\n  const completion = await runInstalledPackageProof();";
  for (const bypass of [
    "if (process.env.CI) process.exit(0);",
    "process.exit(0);",
    "const bypass = process.exit(0);",
    'process.stdout.write("installed package proof passed\\n");',
    "await runInstalledPackageProof();",
    "if (true) { await runInstalledPackageProof(); }",
  ]) {
    assert.throws(
      () => validateWindowsInstalledProofSemantics(
        windowsJob,
        lane,
        windowsInstalledProof.replace(entryStart, `\n${bypass}\n${entryStart}`),
      ),
      /one terminal entrypoint|pre-entry setup|cannot add or duplicate top-level declaration/,
    );
  }
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob,
      lane,
      windowsInstalledProof.replace(
        "} finally {\n  await rm(scratch",
        '} catch {\n  process.stdout.write("installed package proof passed\\n");\n} finally {\n  await rm(scratch',
      ),
    ),
    /stdout authority|cannot convert failures to success/,
  );
  const helperStart = "async function proveCatalogLifecycle() {";
  for (const [authority, error] of [
    ['process.stdout.write("installed package proof passed\\n");', /stdout authority/],
    ['process.stderr.write("fake progress\\n");', /reviewed scenario wrapper/],
    ["process.exit(0);", /process exit authority/],
    ['process["exit"](0);', /process exit authority/],
    ["process.exitCode = 0;", /process exit authority/],
    ['console.log("installed package proof passed");', /success-shaped output authority/],
    ["await runInstalledPackageProof();", /lifecycle runner authority/],
    ["Promise.resolve().then(() => undefined);", /success handler/],
    ["return installedPackageProofComplete;", /completion-token authority/],
  ]) {
    assert.throws(
      () => validateWindowsInstalledProofSemantics(
        windowsJob,
        lane,
        windowsInstalledProof.replace(helperStart, `${helperStart}\n  ${authority}`),
      ),
      error,
    );
  }
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob,
      lane,
      windowsInstalledProof.replace('artifact: "exact installed npm tarball"', 'artifact: "success"'),
    ),
    /terminal success payload/,
  );
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob,
      lane,
      windowsInstalledProof.replace("timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,", ""),
    ),
    /command deadline/,
  );
  assert.throws(
    () => validateWindowsInstalledProofSemantics(
      windowsJob,
      lane,
      windowsInstalledProof.replace("const result = await operation();", "const result = operation();"),
    ),
    /complete lifecycle/,
  );
});

test("Windows installed-package proof digest rejects every unreviewed byte mutation", () => {
  const windowsJob = extractJobs(windowsWorkflow)["windows-package"];
  const lane = manifest.lanes.windows;
  const helperStart = "async function proveCatalogLifecycle() {";
  for (const mutation of [
    `${helperStart}\n  const proc = process; proc.exit(0);`,
    `${helperStart}\n  const authority = "exit"; process[authority](0);`,
    `${windowsInstalledProof}\n`,
  ]) {
    const proof = mutation.startsWith(helperStart)
      ? windowsInstalledProof.replace(helperStart, mutation)
      : mutation;
    assert.throws(
      () => validateWindowsInstalledProof(windowsJob, lane, proof),
      /reviewed SHA-256 digest/,
    );
  }
});

test("Windows installed-package proof digest update command prints the reviewed value", () => {
  const lane = manifest.lanes.windows;
  const output = execFileSync(
    process.execPath,
    [path.join(root, "scripts", "windows-installed-package-proof-digest.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(output, `${lane.installed_package_proof_sha256}\n`);
});

test("merge-queue posture is current configuration, not a permanent prohibition", () => {
  assert.equal(manifest.merge_queue.enabled, false);
  const enabled = structuredClone(manifest);
  enabled.merge_queue.enabled = true;
  const withMergeGroup = workflow.replace("on:\n", "on:\n  merge_group:\n");
  assert.doesNotThrow(() => validateCiTopology(withMergeGroup, enabled));
  assert.throws(() => validateCiTopology(workflow, enabled), /merge-queue posture/);
});
