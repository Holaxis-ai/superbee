import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSiteManifestDoc,readPublicationSiteManifest} from '../dist/index.js';
const declaration=()=>({id:'sites/example',frontmatter:{type:'Site',title:'Example',audience:'restricted',presentation:'@superbee/portal-document@0.1.0',views:['views/chart'],landing:'plans/main',brand:{logo:'brand/logo.svg',fonts:['fonts/body.woff2']}}});
const fixture=()=>({documents:[declaration(),{id:'plans/main',frontmatter:{type:'Plan'}},{id:'views/chart',frontmatter:{type:'View'}}],views:[{id:'views/chart'}],blobs:[{key:'brand/logo.svg'},{key:'fonts/body.woff2'}]});
test('the publication facade projects the same Core declaration after checking frozen references',()=>{
 const snapshot=fixture();assert.deepEqual(readPublicationSiteManifest(snapshot,'example'),parseSiteManifestDoc(snapshot.documents[0]));
});
test('a publication refuses missing, multiple, misbound or unresolved Site inputs',()=>{
 const cases=[s=>s.documents.shift(),s=>s.documents.push({...declaration(),id:'sites/another'}),s=>s.documents[0].id='sites/another',s=>s.views=[],s=>s.blobs=[],s=>s.documents=s.documents.filter(d=>d.id!=='plans/main'),s=>{s.views.push({id:'views/other'});s.documents.push({id:'views/other',frontmatter:{type:'View'}});s.documents[0].frontmatter.landing='views/other';}];
 for(const change of cases){const s=fixture();change(s);assert.equal(readPublicationSiteManifest(s,'example').ok,false);}
});
