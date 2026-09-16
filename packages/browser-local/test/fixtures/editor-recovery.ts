import { openLocalBundle } from '../../src/local-bundle.ts';
import { withEditorRecovery } from '../../src/editor-recovery.ts';
import { versionOfBytes } from '@superbee/core/versioning';
const local = openLocalBundle('editor-recovery');
const scope = { endpoint: location.origin, principalScope: 'one', workspace: 'w', bundle: 'b', installation: 'i', registrationScope: 'r' };
let release: () => void;
let entered = false;
let drained = false;
let writeRelease: () => void;
(window as any).recoveryTest = {
  async seed() {
    return withEditorRecovery(scope, { backend: local.backend }, async s => {
      const row = await s.saveDraft('notes/one', {base:{version:versionOfBytes('base'),body:'base'},body:'prepared'}, null);
      await s.prepare('notes/one', {requestId:'00000000-0000-4000-8000-000000000001'}, row.revision);
      return s.saveDraft('notes/one', {base:row.base,body:'newer draft'}, row.revision);
    });
  },
  async read(principal = 'one') {
    return withEditorRecovery({...scope, principalScope:principal}, {backend:local.backend}, s=>s.read('notes/one'));
  },
  hold() {
    entered=false;
    void withEditorRecovery(scope, {backend:local.backend}, async()=>{entered=true; await new Promise<void>(r=>release=r);});
  },
  entered:()=>entered,
  release:()=>release(),
  drain() {
    entered=false; drained=false;
    const write = local.backend.writeMeta.bind(local.backend);
    local.backend.writeMeta=async(key,value)=>{entered=true;await new Promise<void>(r=>writeRelease=r);return write(key,value);};
    void withEditorRecovery(scope, {backend:local.backend}, async s=>{
      void s.saveDraft('notes/two',{base:{version:versionOfBytes('base'),body:'base'},body:'draining'},null);
    }).then(()=>{drained=true;local.backend.writeMeta=write;});
  },
  writeRelease:()=>writeRelease(),
  drained:()=>drained,
};
