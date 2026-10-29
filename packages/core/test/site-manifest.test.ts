import test from "node:test";
import assert from "node:assert/strict";
import { parseSiteManifestDoc, isSiteLabel } from "../src/site-manifest.js";
import { isJsonData } from "../src/json-data.js";
import { isJsonData as sourceJsonData } from "../src/source-engine/driver.js";
const base = () => ({ id: "sites/example", frontmatter: { type: "Site", title: "Example", audience: "restricted", presentation: "@superbee/portal-document@0.1.0", views: [] as string[], options: { brandName: "Example" }, generated: { by: "process:fixture" } } as Record<string, unknown> });

test("Site parsing admits exact package and repository references without resolving them", () => {
  for (const [raw, reference] of [
    ["@superbee/portal-document@0.1.0", {kind:"package", name:"@superbee/portal-document", version:"0.1.0"}],
    ["presentation@1.2.3-pre.4+build.01", {kind:"package", name:"presentation", version:"1.2.3-pre.4+build.01"}],
    ["repo:Example/site", {kind:"repository", repository:"Example/site"}],
  ] as const) {
    const doc=base();doc.frontmatter.presentation=raw;const before=structuredClone(doc);const result=parseSiteManifestDoc(doc);
    assert.equal(result.ok,true);if(!result.ok)throw new Error("expected valid fixture");
    assert.deepEqual(result.manifest.presentation,reference);assert.equal(result.manifest.site,"example");assert.deepEqual(doc,before);
    (doc.frontmatter.options as {brandName:string}).brandName="Changed";assert.equal(result.manifest.options.brandName,"Example");
  }
});

test("declarations refuse floating, executable and noncanonical presentation inputs",()=>{
  for(const presentation of ["@superbee/portal-document@latest","p@^1.0.0","p@1.0","p@01.0.0","p@1.0.0-01","p@1.0.0+","file:../code","https://example.test/p.tgz","repo:Example/site@main","repo:Example/../site","repo:Example/site.git", "p@9007199254740992.0.0"]){
    const doc=base();doc.frontmatter.presentation=presentation;const result=parseSiteManifestDoc(doc);assert.equal(result.ok,false,presentation);
    if(!result.ok)assert.ok(result.errors.some(e=>e.path==="/presentation"));
  }
});

test("site labels match the existing hosted label boundary",()=>{
 for(const value of ["intro","investor-plan","abc","a".repeat(32)])assert.equal(isSiteLabel(value),true,value);
 for(const value of ["ab","1plan","a--b","Plan","a".repeat(33),"abc-","../abc",null])assert.equal(isSiteLabel(value),false,String(value));
});

test("malformed Site data is refused before a presentation interprets options",()=>{
 const cases=[
  (d:ReturnType<typeof base>)=>{d.id="Sites/example";},
  (d:ReturnType<typeof base>)=>{d.frontmatter.type="Note";},
  (d:ReturnType<typeof base>)=>{d.frontmatter.title=" ";},
  (d:ReturnType<typeof base>)=>{d.frontmatter.audience="public";},
  (d:ReturnType<typeof base>)=>{d.frontmatter.builder="untrusted";},
  (d:ReturnType<typeof base>)=>{d.frontmatter.views=["../outside"];},
  (d:ReturnType<typeof base>)=>{d.frontmatter.views=["views/a","views/a"];},
  (d:ReturnType<typeof base>)=>{d.frontmatter.landing="/outside";},
  (d:ReturnType<typeof base>)=>{d.frontmatter.capabilities=["ask-superbee","ask-superbee"];},
  (d:ReturnType<typeof base>)=>{d.frontmatter.options={code:()=>"run"};},
  (d:ReturnType<typeof base>)=>{d.frontmatter.options={value:"x".repeat(16385)};},
  (d:ReturnType<typeof base>)=>{d.frontmatter.options={value:NaN};},
  (d:ReturnType<typeof base>)=>{d.frontmatter.brand={logo:"/etc/passwd"};},
  (d:ReturnType<typeof base>)=>{d.frontmatter.brand={fonts:["brand/../secret.woff2"]};},
  (d:ReturnType<typeof base>)=>{d.frontmatter.brand={logo:"brand/logo.svg",host:"external"};},
 ];
 for(const change of cases){const d=base();change(d);assert.equal(parseSiteManifestDoc(d).ok,false);}
 const cyclic:Record<string,unknown>={};cyclic.self=cyclic;const d=base();d.frontmatter.options=cyclic;assert.equal(parseSiteManifestDoc(d).ok,false);
});

test("JSON data validation has one owner shared with source acquisition",()=>{
 assert.equal(sourceJsonData,isJsonData);
 for(const [value,accepted] of [[{nested:[null,true,3,"text"]},true],[undefined,false],[new Date(),false],[{nested:[undefined]},false],[Infinity,false]] as const)assert.equal(isJsonData(value),accepted);
});
