import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {initBundle,writeDoc} from '@superbee/core';
import {unreadableDocuments} from '../../core/test/fixtures/unreadable-documents.js';
import {search} from '../src/commands/search.js';
import {list} from '../src/commands/list.js';
import {status} from '../src/commands/status.js';
import {link} from '../src/commands/link.js';
import {indexCommand} from '../src/commands/index.js';

for(const row of unreadableDocuments)test(`discovery agrees on ${row.name} and visibly incomplete indexes`,async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'superbee-discovery-agreement-'));
  try{
    const bundle=await initBundle(dir);
    await writeDoc(bundle,{id:'good',frontmatter:{type:'Note',title:'Alpha'},body:'alpha\n\n[related](other.md)\n'});
    await writeDoc(bundle,{id:'other',frontmatter:{type:'Note'},body:'alpha'});
    await writeDoc(bundle,{id:'nested/bad',frontmatter:{type:'Note'},body:'alpha'});
    const run=async(command:typeof search,args:string[])=>{
      let output='';await command([...args,'--dir',dir,'--json'],{stdout:s=>{output+=s;}});return JSON.parse(output);
    };
    await run(indexCommand,['generate','--force']);
    await writeFile(path.join(dir,'nested/bad.md'),row.source);
    const results=[
      await run(list,[]),await run(search,['alpha']),await run(search,['no-such-word']),
      await run(link,['list']),await run(link,['show','good']),await run(indexCommand,['generate']),
    ];
    const expected=results[0].skipped;
    assert.equal(expected.length,1);assert.equal(expected[0].id,'nested/bad');assert.ok(expected[0].reason);
    for(const result of results)assert.deepEqual(result.skipped,expected);
    assert.equal(results[0].count,2);assert.equal(results[1].count,2);assert.equal(results[2].count,0);
    assert.equal(results[1].corpus.skipped,1);assert.equal(results[1].corpus.documents,3);
    assert.deepEqual(results[3].edges,[{from:'good',to:'other',text:'related'}]);
    const health=await run(status,[]);
    assert.deepEqual(health.malformed_docs.rows,expected);
    for(const file of ['index.md','nested/index.md'])assert.match(await readFile(path.join(dir,file),'utf8'),/Incomplete index: 1 unreadable document/);
    const unchanged=await run(indexCommand,['generate','--check']);
    assert.equal(unchanged.clean,true);assert.deepEqual(unchanged.skipped,expected);
    await writeFile(path.join(dir,'nested/bad.md'),'---\ntype: Note\n---\nalpha repaired\n');
    const repaired=await run(indexCommand,['generate']);assert.equal(repaired.skipped,undefined);
    for(const file of ['index.md','nested/index.md'])assert.doesNotMatch(await readFile(path.join(dir,file),'utf8'),/Incomplete index/);
    assert.equal((await run(search,['alpha'])).count,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});
