import { fileURLToPath } from 'node:url';
import { createPosixCliRuntime } from '../../src/runtime.js';
import { staticBuildIdentity } from '../../src/build-identity.js';
const executablePath = fileURLToPath(import.meta.url);
const runtime = createPosixCliRuntime({ identity: staticBuildIdentity(), executablePath, assetRoot: fileURLToPath(new URL('../../', import.meta.url)), install: { packageName: 'superbee', entryRelativePath: 'dist/superbee.mjs', bins: ['superbee'] }, predecessorLayouts: [], ownedSkillPackages: ['superbee'], updatesEnabled: false });
const args = process.argv.slice(2);
if (args[0] === '__git-sync-v1')
    await runtime.runGitSyncWorker();
else if (args[0] === '__embedded')
    await runtime.run(args.slice(1));
else
    await runtime.runFirstParty(args);
