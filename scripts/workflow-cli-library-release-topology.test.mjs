import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const release = read(".github/workflows/release-cli-library.yml");
const finalize = read(".github/workflows/release-cli-library-finalize.yml");
const cliRelease = read(".github/workflows/release.yml");
const verifier = read("scripts/verify-cli-library.mjs");

function jobs(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1);
  const found = {};
  let current;
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      current = match[1];
      found[current] = [];
    } else if (current) {
      found[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(found).map(([name, linesForJob]) => [name, linesForJob.join("\n")]));
}

function runBody(text, stepName) {
  const start = text.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `${stepName} must exist`);
  const run = text.indexOf("run: |", start);
  assert.notEqual(run, -1, `${stepName} must have a run block`);
  const body = [];
  for (const line of text.slice(text.indexOf("\n", run) + 1).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runSourceGuard({ currentVersion, priorTag, mainMatches = true, depth = "full", refVersion = currentVersion }) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "cli-library-source-guard-"));
  const source = path.join(fixture, "source");
  const remote = path.join(fixture, "remote.git");
  const checkout = path.join(fixture, "checkout");
  mkdirSync(source);
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  git(source, ["config", "user.email", "proof@example.test"]);
  git(source, ["config", "user.name", "proof"]);
  writeFileSync(path.join(source, "prior"), "prior\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "prior"]);
  const priorSha = git(source, ["rev-parse", "HEAD"]);
  if (priorTag) git(source, ["tag", priorTag]);
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  mkdirSync(path.join(source, "packages", "core"), { recursive: true });
  mkdirSync(path.join(source, "packages", "server"), { recursive: true });
  writeFileSync(path.join(source, "scripts", "strict-semver.mjs"), read("scripts/strict-semver.mjs"));
  mkdirSync(path.join(source, "packages", "cli"), { recursive: true });
  writeFileSync(path.join(source, "scripts", "package-version-policy.mjs"), read("scripts/package-version-policy.mjs"));
  const manifest = `${JSON.stringify({ version: currentVersion }, null, 2)}\n`;
  writeFileSync(path.join(source, "packages", "cli", "package.json"), manifest);
  writeFileSync(path.join(source, "packages", "server", "package.json"), manifest);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "current"]);
  const currentSha = git(source, ["rev-parse", "HEAD"]);
  git(source, ["tag", `cli/v${currentVersion}`]);
  git(fixture, ["clone", "--quiet", "--bare", source, remote]);
  const cloneArgs = ["clone", "--quiet"];
  if (depth === "shallow") cloneArgs.push("--depth=1", "--branch", `cli/v${currentVersion}`);
  cloneArgs.push(pathToFileURL(remote).href, checkout);
  git(fixture, cloneArgs);
  const step = path.join(fixture, "source-step.sh");
  const output = path.join(fixture, "output");
  writeFileSync(step, runBody(release, "Resolve the CLI version from the tag"));
  const wrapper = [
    'gh() { printf "%s\\n" "$MAIN_SHA"; }',
    'source "$SOURCE_STEP"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", wrapper], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "example/repository",
      GITHUB_SHA: currentSha,
      GITHUB_REF_NAME: `cli/v${refVersion}`,
      GITHUB_OUTPUT: output,
      MAIN_SHA: mainMatches ? currentSha : priorSha,
      SOURCE_STEP: step,
    },
  });
  rmSync(fixture, { recursive: true, force: true });
  return result;
}

test("the exact source guard allows only current-main channel advancement", () => {
  const advance = runSourceGuard({ currentVersion: "0.1.1", priorTag: "cli/v0.1.0" });
  assert.equal(advance.status, 0, advance.stderr + advance.stdout);

  const oldMain = runSourceGuard({ currentVersion: "0.1.1", priorTag: "cli/v0.1.0", mainMatches: false });
  assert.notEqual(oldMain.status, 0);
  assert.match(oldMain.stderr + oldMain.stdout, /must be tagged from current main/);

  const latestRegression = runSourceGuard({ currentVersion: "0.1.0", priorTag: "cli/v0.1.1" });
  assert.notEqual(latestRegression.status, 0);
  assert.match(latestRegression.stderr + latestRegression.stdout, /would not advance latest/);

  const nextRegression = runSourceGuard({ currentVersion: "0.2.0-pre.1", priorTag: "cli/v0.2.0-pre.2" });
  assert.notEqual(nextRegression.status, 0);
  assert.match(nextRegression.stderr + nextRegression.stdout, /would not advance next/);

  const otherChannel = runSourceGuard({ currentVersion: "0.2.0-pre.1", priorTag: "cli/v9.0.0" });
  assert.equal(otherChannel.status, 0, otherChannel.stderr + otherChannel.stdout);

  const buildMetadataHyphen = runSourceGuard({ currentVersion: "0.2.0+build-hyphen", priorTag: "cli/v0.1.9" });
  assert.notEqual(buildMetadataHyphen.status, 0, "package policy excludes build metadata");

  const malformed = runSourceGuard({ currentVersion: "0.1.1", priorTag: "cli/vnot-semver" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr + malformed.stdout, /protected release tag .* invalid version/);
});

test("full ancestry is load-bearing because a depth-1 tag-only fetch hides the prior release", () => {
  // This recreates actions/checkout's default depth=1 at the current release tag. The workflow's
  // own tag-ref fetch obtains the prior tag object, but the shallow boundary still prevents Git
  // from recognizing that prior commit as merged. That old topology therefore accepts a regression.
  const shallow = runSourceGuard({
    currentVersion: "0.1.0",
    priorTag: "cli/v0.1.1",
    depth: "shallow",
  });
  assert.equal(shallow.status, 0, `depth-1 mutant unexpectedly saw the hidden prior tag: ${shallow.stderr}`);

  // `fetch-depth: 0` restores the current-main ancestry before the exact same committed step runs,
  // so the reachable prior release is visible and the regression is refused.
  const restored = runSourceGuard({ currentVersion: "0.1.0", priorTag: "cli/v0.1.1" });
  assert.notEqual(restored.status, 0);
  assert.match(restored.stderr + restored.stdout, /would not advance latest/);
});


function literal(workflow, step, { env = {}, prefix = '', cwd } = {}) {
  const dir = cwd ?? mkdtempSync(path.join(os.tmpdir(), 'cli-workflow-step-'));
  const script = path.join(dir, 'step.sh');
  writeFileSync(script, runBody(workflow, step));
  const result = spawnSync('bash', ['-c', `${prefix}\nsource "$SOURCE_STEP"`], { cwd: dir, encoding:'utf8', env: { ...process.env, SOURCE_STEP:script, GITHUB_OUTPUT:path.join(dir,'output'), GITHUB_ENV:path.join(dir,'env'), GITHUB_STEP_SUMMARY:path.join(dir,'summary'), ...env } });
  if (!cwd) rmSync(dir,{recursive:true,force:true});
  return result;
}

test('release topology isolates payload execution from credentials and retains exactly one artifact', () => {
  const {build,attest,stage} = jobs(release);
  assert.deepEqual(Object.keys(jobs(release)), ['build','attest','stage']);
  for (const workflow of [release,finalize]) {
    assert.match(workflow,/^permissions: \{\}$/m);
    assert.match(workflow,/group: cli-library-release\n  cancel-in-progress: false/);
    assert.doesNotMatch(workflow,/secrets\.|NODE_AUTH_TOKEN|continue-on-error|gh release/);
    for (const match of workflow.matchAll(/uses: (.*)/g)) assert.match(match[1], /@[a-f0-9]{40} # v/);
  }
  assert.match(release,/tags: \["cli\/v\*"\]/);
  assert.match(build,/fetch-depth: 0\n          persist-credentials: false/);
  assert.match(build,/contents: read\n      checks: read/);
  assert.doesNotMatch(build,/id-token|environment:|attestations:|npm stage/);
  assert.match(build,/npm ci --ignore-scripts/);
  assert.equal((build.match(/run: npm run build\n/g)??[]).length,1);
  assert.equal((build.match(/npm pack -w @superbee\/cli/g)??[]).length,1);
  assert.match(build,/out\/cli-pack.json/); assert.match(build,/npm run verify:cli-library/);
  assert.match(build,/path: out\/superbee-cli.tgz/);
  assert.match(build,/refs\/tags\/libraries\/v\*/);
  assert.match(build,/release source must be clean/);
  assert.doesNotMatch(attest+stage,/actions\/checkout|npm ci|npm run|npm pack|node .*scripts\//);
  assert.match(attest,/subject-path: out\/\$\{\{ needs.build.outputs.tgz \}\}/);
  assert.match(stage,/needs: \[build, attest\]/);
  assert.match(stage,/if: needs.build.outputs.bootstrap != 'true'/);
  assert.match(stage,/environment: release/);
  assert.match(stage,/npm@11\.15\.0/);
  assert.match(build,/if \[ "\$V" = "0\.1\.0-pre\.1" \]; then BOOTSTRAP=true/);
  assert.doesNotMatch(finalize,/actions\/checkout|registry-url:|npm publish|npm stage|npm dist-tag|id-token|contents: write/);
  assert.match(finalize,/contents: read/);
  assert.doesNotMatch(verifier,/\[.pack.|npm run build|process\.argv/);
  assert.equal(JSON.parse(read('package.json')).scripts['verify:cli-library'], 'node scripts/verify-cli-library-entry.mjs');
  assert.equal(read('scripts/verify-cli-library-entry.mjs'), "import { verifyCliLibrary } from './verify-cli-library.mjs';\n\nprocess.stdout.write(`${JSON.stringify(await verifyCliLibrary(), null, 2)}\\n`);\n");
  const proof=read('scripts/cli-library-proof.mjs');
  assert.doesNotMatch(proof,/\[npm, "(?:pack|run)"/);
  assert.match(proof,/embeddedInventory\(path.join\(library, "dist\/index.mjs"\)\)/);
  assert.match(proof,/write: false/);
  assert.match(JSON.parse(read('package.json')).scripts['test:scripts'],/verify-cli-library.test.mjs.*workflow-cli-library-release-topology.test.mjs/);
});

test('CI verdict block remains byte-identical to both established release workflows and fails closed', () => {
  const name='Require the CI verdict already recorded on this exact commit';
  for (const established of [cliRelease,read('.github/workflows/release-libraries.yml')]) assert.equal(runBody(release,name),runBody(established,name));
  for (const verdict of ['success','missing','pending','concluded:failure','unqueryable']) {
    const result=literal(release,name,{env:{VERDICT_FIXTURE:verdict,GITHUB_REPOSITORY:'fixture/repo',GITHUB_SHA:'a'.repeat(40),SOURCE_REF:'main'},prefix:'gh() { [ "$VERDICT_FIXTURE" != unqueryable ] || return 1; printf "%s\\n" "$VERDICT_FIXTURE"; }; sleep() { :; }'});
    assert.equal(result.status===0,verdict==='success',result.stderr+result.stdout);
  }
  assert.notEqual(runSourceGuard({currentVersion:'0.1.0-pre.1',refVersion:'0.1.0-pre.2'}).status,0);
});

test('digest handoffs refuse replaced bytes before attestation or staging', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'cli-digest-')); mkdirSync(path.join(dir,'out'));
  try {
    writeFileSync(path.join(dir,'out/superbee-cli.tgz'),'retained');
    const sha=spawnSync('shasum',['-a','256','out/superbee-cli.tgz'],{cwd:dir,encoding:'utf8'}).stdout.split(' ')[0];
    for (const name of ['Re-hash the retained artifact','Re-hash the CLI bytes about to be staged']) {
      const body=runBody(release,name).replaceAll('${{ needs.build.outputs.tgz }}','superbee-cli.tgz').replaceAll('${{ needs.build.outputs.sha256 }}',sha);
      const run=()=>spawnSync('bash',['-c',`sha256sum() { shasum -a 256 "$@"; };\n${body}`],{cwd:dir,encoding:'utf8'});
      writeFileSync(path.join(dir,'out/superbee-cli.tgz'),'retained'); assert.equal(run().status,0);
      writeFileSync(path.join(dir,'out/superbee-cli.tgz'),'substituted'); assert.notEqual(run().status,0);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('bootstrap only prints fixed-registry next/public commands; later staging submits the literal bytes', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'cli-stage-'));
  try {
    let result=literal(release,'Print the one-time bootstrap gate',{cwd:dir,env:{V:'0.1.0-pre.1',TGZ:'superbee-cli.tgz',SHA:'digest',npm_config_tag:'wrong',npm_config_access:'restricted'}});
    assert.equal(result.status,0,result.stderr);
    const summary=readFileSync(path.join(dir,'summary'),'utf8');
    assert.match(summary,/npm publish "\.\/superbee-cli.tgz" --access public --tag next --ignore-scripts --registry https:\/\/registry.npmjs.org\//);
    assert.match(summary,/digest/);
    result=literal(release,'Stage the exact CLI tarball',{cwd:dir,env:{TGZ:'superbee-cli.tgz',DIST_TAG:'next',ARGS_OUT:path.join(dir,'args'),npm_config_tag:'wrong',npm_config_access:'restricted'},prefix:'npm() { printf "%s\\n" "$@" > "$ARGS_OUT"; printf \'{"stageId":"fixture-stage"}\\n\'; }'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(readFileSync(path.join(dir,'args'),'utf8').trim().split('\n'),['stage','publish','./out/superbee-cli.tgz','--tag','next','--access','public','--provenance=false','--registry','https://registry.npmjs.org/','--ignore-scripts','--json','--loglevel','verbose']);
    assert.match(readFileSync(path.join(dir,'output'),'utf8'),/stage_id=fixture-stage/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('finalizer version policy and channel agree with manifest policy; bad registry metadata refuses', async () => {
  const {versionPattern}=await import('./package-version-policy.mjs');
  assert.equal(finalize.split(versionPattern.toString()).length - 1, 2, 'both inline version validators agree exactly with the package policy');
  const versions=['0.1.0-pre.1','1.2.3','0.0.0','1.2.3-0','1.2.3-alpha.9','1.2.3-01','1.2.3+build','01.2.3','cli/v1.2.3','1.2.3\n','1.2.3-a-b','1.2.3-'];
  for (const V of versions) {
    const result=literal(finalize,'Validate the version and prove the registry channel',{env:{V},prefix:'npm() { printf "%s\\n" "$V"; }; sleep() { :; }'});
    assert.equal(result.status===0,versionPattern.test(V),`${JSON.stringify(V)}: ${result.stderr}`);
  }
  for (const field of ['version','dist-tags.next']) {
    const result=literal(finalize,'Validate the version and prove the registry channel',{env:{V:'0.1.0-pre.1',BAD_FIELD:field},prefix:'npm() { if [ "$3" = "$BAD_FIELD" ]; then echo wrong; else echo "$V"; fi; }; sleep() { :; }'});
    assert.notEqual(result.status,0);
  }
});

test('literal finalizer inspects packed metadata and verifies exact signer, source ref and source digest', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'cli-finalize-'));
  try {
    mkdirSync(path.join(dir,'fixture/package/dist'),{recursive:true});
    const pkg={name:'@superbee/cli',version:'0.1.0-pre.1',publishConfig:{access:'public',registry:'https://registry.npmjs.org/'}};
    const record={schema:'superbee.cli-embedded-engine.v2',source:{commit:'a'.repeat(40),dirty:false},packages:['core','server'].map(name=>({name:`@superbee/${name}`,version:'1.2.3',release_tag:'libraries/v1.2.3'}))};
    for (const attack of ['none','manifest','version','dirty','null','newline','equality','missing-contributor']) {
      const candidate=structuredClone(record), manifest={...pkg};
      if(attack==='manifest') manifest.name='superbee';
      if(attack==='version') manifest.version='9.9.9';
      if(attack==='dirty') candidate.source.dirty=true;
      if(attack==='null') candidate.source.commit=null;
      if(attack==='newline') candidate.source.commit+='\n';
      if(attack==='equality') candidate.matches_release=true;
      if(attack==='missing-contributor') candidate.packages.pop();
      writeFileSync(path.join(dir,'fixture/package/package.json'),JSON.stringify(manifest));
      writeFileSync(path.join(dir,'fixture/package/dist/embedded-engine.json'),JSON.stringify(candidate));
      assert.equal(spawnSync('tar',['-czf',path.join(dir,'fixture.tgz'),'-C',path.join(dir,'fixture'),'package']).status,0);
      const result=literal(finalize,'Download and inspect the exact published bytes',{cwd:dir,env:{V:pkg.version,FIXTURE:path.join(dir,'fixture.tgz')},prefix:'npm() { cp "$FIXTURE" out/from-registry.tgz; echo \'[{"filename":"from-registry.tgz"}]\'; }'});
      assert.equal(result.status===0,attack==='none',`${attack}: ${result.stderr}`);
    }
    for (const failure of ['0','1']) {
      const result=literal(finalize,'Verify the source-bound build attestation',{cwd:dir,env:{V:pkg.version,SOURCE_COMMIT:record.source.commit,GITHUB_REPOSITORY:'fixture/repo',FAILURE:failure,ARGS_OUT:path.join(dir,'args')},prefix:'gh() { printf "%s\\n" "$@" > "$ARGS_OUT"; return "$FAILURE"; }'});
      assert.equal(result.status,Number(failure));
      assert.deepEqual(readFileSync(path.join(dir,'args'),'utf8').trim().split('\n'),['attestation','verify','out/superbee-cli.tgz','-R','fixture/repo','--signer-workflow','fixture/repo/.github/workflows/release-cli-library.yml','--source-ref','refs/tags/cli/v0.1.0-pre.1','--source-digest','a'.repeat(40)]);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
