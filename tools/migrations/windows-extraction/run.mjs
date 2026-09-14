#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { install } from './artifact.mjs';
import { isolatedEnvironment } from './process.mjs';
import { executeScenario, scenarioNames } from './scenarios.mjs';
import { compare, assertNoWindowsInputs } from './compare.mjs';

export function options(argv) {
  const accepted = new Set(['baseline','candidate','baseline-sha256','candidate-sha256','baseline-source','candidate-source','baseline-channel','candidate-channel','scenarios','report','candidate-inputs']);
  const result = {};
  for (let i=0;i<argv.length;i+=2) {
    const key=argv[i]?.slice(2); assert.ok(argv[i]?.startsWith('--') && accepted.has(key), `Unknown option ${argv[i]}`);
    assert.ok(argv[i+1] && !argv[i+1].startsWith('--'), `Missing ${key} value`); assert.ok(!(key in result), `Duplicate ${key}`); result[key]=argv[i+1];
  }
  for (const key of accepted) if (key !== 'candidate-inputs') assert.ok(result[key], `Required --${key}`);
  const names=result.scenarios.split(','); assert.ok(names.length && new Set(names).size===names.length);
  for (const name of names) assert.ok(scenarioNames.includes(name), `Unknown scenario ${name}`);
  result.scenarios=names; return result;
}
export async function main(argv) {
  const args=options(argv);
  const report={ schema:'superbee.windows-extraction.parity.v1', platform:process.platform, node:process.version, selected:args.scenarios, coverageLimitations:['No native Windows claim unless run on Windows.', 'No full managed listener reuse/ownership, interrupted migration or injected backend contract coverage.', 'Input graph supplied by caller; completeness requires independent build evidence.'], artifacts:{}, raw:{}, normalized:{}, pass:false };
  const scratch=await realpath(await mkdtemp(path.join(tmpdir(),'superbee-parity-')));
  try {
    for (const side of ['baseline','candidate']) {
      const root=path.join(scratch,side); await mkdir(root); const env=await isolatedEnvironment(root);
      const spec={path:args[side],sha256:args[`${side}-sha256`],source:args[`${side}-source`],channel:args[`${side}-channel`]};
      const evidence=report.artifacts[side]={}; const artifact=await install(spec,root,env,evidence);
      report.raw[side]={}; report.normalized[side]={};
      for (const name of args.scenarios) {
        const raw=report.raw[side][name]={};
        report.normalized[side][name]=await executeScenario(name,artifact,root,env,raw);
      }
    }
    if (args['candidate-inputs']) {
      report.candidateInputs=JSON.parse(await readFile(args['candidate-inputs'],'utf8'));
      assertNoWindowsInputs(report.candidateInputs);
      assert.equal(report.candidateInputs.source,args['candidate-source']); assert.equal(report.candidateInputs.artifact_sha256,args['candidate-sha256']);
    }
    assert.deepEqual(report.artifacts.baseline.exports, report.artifacts.candidate.exports, 'public export mappings changed');
    assert.deepEqual(report.artifacts.baseline.exportProbes, report.artifacts.candidate.exportProbes, 'public export names changed');
    report.comparison=compare(report.normalized.baseline,report.normalized.candidate); report.pass=report.comparison.pass;
  } catch (error) { report.error={name:error.name,message:error.message,stack:error.stack}; }
  finally {
    try { await rm(scratch,{recursive:true,force:true}); report.cleanup='removed'; } catch(error) { report.cleanup=error.message; report.pass=false; }
    await writeFile(path.resolve(args.report),JSON.stringify(report,null,2)+'\n');
  }
  return report;
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const report=await main(process.argv.slice(2)); console.log(JSON.stringify({pass:report.pass,report:path.resolve(options(process.argv.slice(2)).report),error:report.error?.message})); process.exitCode=report.pass?0:1; }
  catch(error) { console.error(error.message); process.exitCode=2; }
}
