#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cliVersion, isBareVersionFlag, configureSourceIdentity, staticBuildIdentity, createPosixCliRuntime } from '@superbee/cli';
declare const __SUPERBEE_BUILD_IDENTITY__: unknown;
if(typeof __SUPERBEE_BUILD_IDENTITY__==='undefined') {
 const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 configureSourceIdentity({name:manifest.name,version:manifest.version});
}
const argv=process.argv.slice(2);
if(isBareVersionFlag(argv[0])) {
 process.stdout.write(`${cliVersion()}\n`);
} else if(process.platform!=='darwin'&&process.platform!=='linux') {
 process.stdout.write("error:\n  code: RUNTIME\n  message: This Superbee distribution supports macOS and Linux. Use a Windows distribution on Windows.\n");
 process.exitCode=1;
} else {
 const executablePath=fileURLToPath(import.meta.url);
 const runtime=createPosixCliRuntime({
  identity:staticBuildIdentity(),executablePath,assetRoot:dirname(dirname(executablePath)),
  install:{packageName:'superbee',entryRelativePath:'dist/superbee.mjs',bins:['superbee']},
  predecessorLayouts:[{packageName:'@holaxis/aslite',entryRelativePath:'dist/superbee.mjs',bins:['aslite','agentstate-lite']}],
  ownedSkillPackages:['superbee','aslite','@holaxis/aslite'],updatesEnabled:true,
 });
 if(argv[0]==='__managed-ui-v1') {if(argv.length===1)await runtime.runManagedUiWorker();}
 else if(argv[0]==='__update-refresh-v1') {if(argv.length===2)await runtime.runUpdateRefreshWorker(argv[1]!);}
 else await runtime.run(argv);
}
