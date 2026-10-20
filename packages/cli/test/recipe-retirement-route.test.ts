import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { admitRecipeRetirementRoute } from "../src/recipe-retirement-route.js";
import { bundleHomeAt, inspectBundleHomeAt } from "../src/bundle-home.js";
import { folderIdentity, indexCheckoutPath, writeBinding, hostedCheckoutsRoot } from "../src/hosted/binding.js";
import { createHash } from "node:crypto";

const rows = ["plain", "navigation-index", "nested-root", "ancestor-root", "nested-binding", "malformed-binding", "marker-copy", "malformed-marker", "marker-link", "bad-git", "board", "bad-private-index", "null-private-index", "hosted-binding", "bad-binding-record", "descendant-symlink", "deep-tree", "unsafe-index"] as const;
test("retirement admission agreement distinguishes absent, known authority and unknown evidence", async t => {
 for (const row of rows) await t.test(row, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "retirement-route-"));
  try {
   const root = path.join(temp,"bundle"), home = path.join(temp,"home"); await mkdir(root); await mkdir(home);
   const child = path.join(root,"widgets"); await mkdir(child);
   if(row === "navigation-index") await writeFile(path.join(child,"index.md"),"---\ntitle: Navigation\n---\n");
   if(row === "nested-root") await writeFile(path.join(child,"index.md"),"---\nokf_version: '0.2'\n---\n");
   if(row === "ancestor-root") await writeFile(path.join(temp,"index.md"),"---\nokf_version: '0.2'\n---\n");
   if(row === "nested-binding") await writeFile(path.join(child,".superbee.json"),JSON.stringify({bundle:home}));
   if(row === "malformed-binding") await writeFile(path.join(child,".superbee.json"),"{");
   if(row.includes("marker")) { await mkdir(path.join(root,".superbee")); const marker=path.join(root,".superbee/checkout.json");
    if(row === "marker-link") await symlink(path.join(temp,"absent"),marker);
    else await writeFile(marker,row === "malformed-marker"?"{":JSON.stringify({superbee_checkout:1,home:"hosted",host:"https://example.invalid",bundle_id:"bundle",workspace:null}));
   }
   if(row === "bad-git") await writeFile(path.join(root,".git"),"not valid git metadata");
   if(row === "board") { assert.equal(spawnSync("git",["init","-b","board",root]).status,0); assert.equal(spawnSync("git",["-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","fixture"]).status,0); }
   if(row === "bad-private-index" || row === "null-private-index") {const dir=path.join(hostedCheckoutsRoot(home),"paths");await mkdir(dir,{recursive:true});const canonical=await realpath(root); const key=createHash("sha256").update(`superbee:hosted-checkout\0${canonical}`).digest("hex");await writeFile(path.join(dir,`${key}.json`),row === "null-private-index" ? "null" : "{");}
   if(row === "hosted-binding" || row === "bad-binding-record") {
    const canonical=await realpath(root); const binding={schema:1 as const,checkout_id:"11111111-1111-1111-1111-111111111111",path:canonical,origin:"https://example.invalid",audience:"https://example.invalid/mcp",routes:"/sync/v1",workspace:null,workspaces:[],bundle_id:"bundle",principal_id:"fixture",created_at:"2026-10-20T00:00:00Z",state:"ready" as const,folder_identity:(await folderIdentity(root))!};
    await writeBinding(home,binding);await indexCheckoutPath(home,binding);
    if(row === "bad-binding-record") await writeFile(path.join(hostedCheckoutsRoot(home),binding.checkout_id,"binding.json"),"null");
   }
   if(row === "deep-tree") await mkdir(path.join(child,...Array.from({length:34},()=>"nested")),{recursive:true});
   if(row === "unsafe-index") await symlink(path.join(temp,"absent"),path.join(child,"index.md"));
   if(row === "descendant-symlink") await symlink(home,path.join(child,"alias"));
   if(row === "plain" || row === "navigation-index") assert.ok((await admitRecipeRetirementRoute(root,{home})).backend);
   else await assert.rejects(admitRecipeRetirementRoute(root,{home}), (error: any) => {
    assert.match(error.message,/known plain local filesystem route/);
    if (["malformed-marker","marker-link","bad-git","bad-private-index","null-private-index","bad-binding-record"].includes(row)) assert.equal(error.details?.reason,"home-evidence-unknown");
    return true;
   });
   if(["malformed-marker","marker-link","bad-git","bad-private-index","null-private-index","bad-binding-record"].includes(row)) {
    assert.equal((await inspectBundleHomeAt(await realpath(root),{home})).state,"unknown");
    assert.equal((await bundleHomeAt(await realpath(root),{home})).home,"local");
   }
  } finally {await rm(temp,{recursive:true,force:true});}
 });
});
