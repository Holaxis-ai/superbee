import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci-tests.yml"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8"));
const windowsInstalledProof = readFileSync(
  path.join(root, manifest.lanes.windows.installed_package_proof_script),
  "utf8",
);

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

function needsOf(job) {
  const list = /^ {4}needs: \[([^\]]*)\]\s*$/m.exec(job);
  if (list) return list[1].split(",").map((name) => name.trim()).filter(Boolean);
  const scalar = /^ {4}needs: ([A-Za-z0-9_-]+)\s*$/m.exec(job);
  return scalar ? [scalar[1]] : [];
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
      '    scenarios: ["catalog-lifecycle", "local-remote-sync", "ui-url-lifecycle", "mcp-config-lifecycle"],',
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

  const outputAuthorities = memberAccesses.filter((node) =>
    [
      "process.stdout.end",
      "process.stderr.write",
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
    "cli",
    "cliJson",
    "git",
    "proveCatalogLifecycle",
    "configureRepository",
    "proveLocalRemoteSync",
    "proveUiUrlLifecycle",
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

function validateWindowsInstalledProof(job, lane, proof = windowsInstalledProof) {
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
      { kind: "await", name: "proveCatalogLifecycle", args: [], binding: "{ bundle }" },
      { kind: "await", name: "proveLocalRemoteSync", args: [], binding: "" },
      { kind: "await", name: "proveUiUrlLifecycle", args: ["bundle"], binding: "" },
      { kind: "await", name: "proveMcpConfigLifecycle", args: [], binding: "" },
      { kind: "return", expression: "installedPackageProofComplete" },
    ],
    "the installed-package runner must contain only the four awaited lifecycles followed by its completion token",
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
    ["catalog-lifecycle", "local-remote-sync", "mcp-config-lifecycle", "ui-url-lifecycle"],
    "Windows installed-package scenario inventory drifted",
  );
  for (const [scenario, literals] of Object.entries(lane.installed_package_scenarios)) {
    assert.ok(Array.isArray(literals) && literals.length > 0, `${scenario} must pin command/evidence literals`);
    for (const literal of literals) {
      assert.ok(proof.includes(literal), `${scenario} lost proof literal ${literal}`);
    }
  }
}

function assertWindowsJob(job, lane) {
  assert.match(job, /^ {4}runs-on: windows-latest\s*$/m);
  assert.equal((job.match(/actions\/setup-node@v4/g) ?? []).length, 2);
  assert.deepEqual(
    [...job.matchAll(/^ {10}node-version: (.+)\s*$/gm)].map((match) => Number(match[1])),
    [lane.runtime_node, lane.installed_package_node],
  );
  assert.match(job, /run: npm run ci:runtime/);
  assert.match(job, /npm pack \.\/packages\/cli --ignore-scripts/);
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

function validateCiTopology(text, candidate = manifest) {
  const jobs = extractJobs(text);
  assert.deepEqual(
    [...candidate.required_jobs].sort(),
    Object.keys(candidate.lanes).sort(),
    "required_jobs must equal the complete lane set",
  );
  assert.doesNotMatch(text, /^\s+continue-on-error:/m, "required CI jobs cannot mask a failing step");
  for (const required of candidate.required_jobs) {
    assert.ok(jobs[required], `missing required job ${required}`);
    assert.equal(displayNameOf(jobs[required]), candidate.lanes[required].display_name, `${required} display name drifted`);
  }
  assert.match(jobs.runtime, /node-version: \[22, 26\]/);
  assert.match(jobs.runtime, /run: npm run ci:runtime/);
  assert.match(jobs["aliasing-host"], /node-version: 26/);
  assertHostExpectations(jobs, candidate);
  for (const [job, script] of [
    ["distribution", "ci:distribution"],
    ["browser", "ci:browser"],
    ["scripts", "ci:scripts"],
  ]) {
    assert.match(jobs[job], /node-version: 26/);
    assert.match(jobs[job], new RegExp(`run: npm run ${script.replace(":", "\\:")}`));
  }
  assertSmokeJob(jobs["smoke-node-20"], candidate.lanes["smoke-node-20"]);
  assertWindowsJob(jobs.windows, candidate.lanes.windows);
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

test("CI runs every lane unconditionally with the declared runtime topology", () => {
  validateCiTopology(workflow);
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
  assert.throws(() => validateCiTopology(workflow, incomplete), /required_jobs must equal the complete lane set/);
});

test("Windows installed-package topology mutations cannot skip lifecycles or weaken artifact binding", () => {
  const windowsJob = extractJobs(workflow).windows;
  const lane = manifest.lanes.windows;
  for (const call of [
    "const { bundle } = await proveCatalogLifecycle();",
    "await proveLocalRemoteSync();",
    "await proveUiUrlLifecycle(bundle);",
    "await proveMcpConfigLifecycle();",
  ]) {
    assert.throws(
      () => validateWindowsInstalledProof(windowsJob, lane, windowsInstalledProof.replace(call, "")),
      /four awaited lifecycles/,
    );
    assert.throws(
      () => validateWindowsInstalledProof(windowsJob, lane, windowsInstalledProof.replace(call, call.replace("await ", "void "))),
      /four awaited lifecycles/,
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
      () => validateWindowsInstalledProof(
        windowsJob,
        lane,
        windowsInstalledProof.replace(runnerStart, `${runnerStart}\n  ${bypass}`),
      ),
      /four awaited lifecycles/,
    );
  }
  assert.throws(
    () => validateWindowsInstalledProof(
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
    () => validateWindowsInstalledProof(
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
    () => validateWindowsInstalledProof(
      windowsJob.replace(
        '$entrypoint = Join-Path $prefix "node_modules\\superbee\\dist\\superbee.mjs"',
        '$entrypoint = Join-Path $prefix "superbee.cmd"',
      ),
      lane,
    ),
    /exact globally installed entrypoint/,
  );
  assert.throws(
    () => validateWindowsInstalledProof(
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
      () => validateWindowsInstalledProof(
        windowsJob,
        lane,
        windowsInstalledProof.replace(entryStart, `\n${bypass}\n${entryStart}`),
      ),
      /one terminal entrypoint|pre-entry setup|cannot add or duplicate top-level declaration/,
    );
  }
  assert.throws(
    () => validateWindowsInstalledProof(
      windowsJob,
      lane,
      windowsInstalledProof.replace(
        "} finally {",
        '} catch {\n  process.stdout.write("installed package proof passed\\n");\n} finally {',
      ),
    ),
    /stdout authority|cannot convert failures to success/,
  );
  const helperStart = "async function proveCatalogLifecycle() {";
  for (const [authority, error] of [
    ['process.stdout.write("installed package proof passed\\n");', /stdout authority/],
    ["process.exit(0);", /process exit authority/],
    ['process["exit"](0);', /process exit authority/],
    ["process.exitCode = 0;", /process exit authority/],
    ['console.log("installed package proof passed");', /success-shaped output authority/],
    ["await runInstalledPackageProof();", /lifecycle runner authority/],
    ["Promise.resolve().then(() => undefined);", /success handler/],
    ["return installedPackageProofComplete;", /completion-token authority/],
  ]) {
    assert.throws(
      () => validateWindowsInstalledProof(
        windowsJob,
        lane,
        windowsInstalledProof.replace(helperStart, `${helperStart}\n  ${authority}`),
      ),
      error,
    );
  }
  assert.throws(
    () => validateWindowsInstalledProof(
      windowsJob,
      lane,
      windowsInstalledProof.replace('artifact: "exact installed npm tarball"', 'artifact: "success"'),
    ),
    /terminal success payload/,
  );
});

test("merge-queue posture is current configuration, not a permanent prohibition", () => {
  assert.equal(manifest.merge_queue.enabled, false);
  const enabled = structuredClone(manifest);
  enabled.merge_queue.enabled = true;
  const withMergeGroup = workflow.replace("on:\n", "on:\n  merge_group:\n");
  assert.doesNotThrow(() => validateCiTopology(withMergeGroup, enabled));
  assert.throws(() => validateCiTopology(workflow, enabled), /merge-queue posture/);
});
