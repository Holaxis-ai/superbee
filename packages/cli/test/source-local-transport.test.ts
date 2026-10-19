import assert from "node:assert/strict";
import test from "node:test";
import { runTransportConformance } from "@superbee/core/source-harness";
import { nodeSourceTransport, publicSourceAddress, sourceHttpsOptions } from "../src/source-local/transport.js";
const input={url:"https://api.github.com/repos/o/r/issues",method:"GET" as const,headers:{},maxBytes:10,credentialHost:true};
const answer=(body="[]",headers:Record<string,string>={})=>({status:200,headers,chunks:(async function*(){yield Buffer.from(body);})(),destroy(){}});
test("Node adapter passes the owning transport conformance rows",async()=>{
  const rows=await runTransportConformance({name:"node-pinned",create:(peer,credential)=>nodeSourceTransport({credential,resolve:async()=>[{address:"8.8.8.8",family:4}],wire:async o=>{
    const r=peer.answer({url:o.url.href,method:o.input.method,headers:o.headers,...(o.input.body===undefined?{}:{body:o.input.body})});
    if (!("status" in r)) throw new Error("scripted failure");
    return {status:r.status,headers:r.headers??{},chunks:(async function*(){yield Buffer.from(r.body??"");})(),destroy(){}};
  }})});
  assert.deepEqual(rows.filter(r=>!r.ok),[]);
});
test("public IP range table refuses nonpublic, mapped and special destinations",()=>{
  for(const address of ["0.0.0.0","10.0.0.1","127.0.0.1","100.64.0.1","169.254.169.254","168.63.129.16","172.31.255.255","192.168.0.1","192.0.2.1","198.19.0.1","198.51.100.1","203.0.113.1","224.0.0.1","255.255.255.255","::","::1","::ffff:127.0.0.1","::ffff:a00:1","fe80::1","fc00::1","ff02::1","2001:db8::1","2002:0808:0808::1","3fff::1","invalid"]) assert.equal(publicSourceAddress(address),false,address);
  for(const address of ["8.8.8.8","1.1.1.1","172.32.0.1","100.128.0.1","2606:4700:4700::1111","::ffff:8.8.8.8"]) assert.equal(publicSourceAddress(address),true,address);
});
test("mixed DNS refuses before wire; per-request re-resolution pins only admitted answers",async()=>{
  let resolves=0,sends=0;const pinned:string[]=[];
  const t=nodeSourceTransport({resolve:async()=>{resolves++;return resolves===1?[{address:"8.8.8.8",family:4}]:[{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}];},wire:async o=>{sends++;pinned.push(o.address);return answer();}});
  await t.request(input);await assert.rejects(t.request(input),/source transport unavailable/);
  assert.equal(resolves,2);assert.equal(sends,1);assert.deepEqual(pinned,["8.8.8.8"]);
});
test("socket options preserve TLS/Host identity while lookup pins one address",()=>{
  const o=sourceHttpsOptions({url:new URL(input.url),address:"8.8.8.8",family:4,headers:{},input});
  assert.equal(o.hostname,"api.github.com");assert.equal(o.servername,"api.github.com");assert.equal(o.rejectUnauthorized,true);assert.equal(o.agent,false);assert.equal(o.autoSelectFamily,false);
  (o.lookup as Function)("api.github.com",{},(e:unknown,a:string,f:number)=>{assert.equal(e,null);assert.equal(a,"8.8.8.8");assert.equal(f,4);});
});
test("DNS cancellation never sends a late answer, overflow destroys and errors hide sentinels",async()=>{
  const controller=new AbortController();let release!:(v:{address:string;family:number}[])=>void;let sent=0;
  const t=nodeSourceTransport({resolve:()=>new Promise(r=>{release=r;}),wire:async()=>{sent++;return answer();}});
  const p=t.request({...input,signal:controller.signal});controller.abort();await assert.rejects(p,/source transport unavailable/);release([{address:"8.8.8.8",family:4}]);await Promise.resolve();assert.equal(sent,0);
  let destroyed=false;
  const large=nodeSourceTransport({resolve:async()=>[{address:"8.8.8.8",family:4}],wire:async()=>({...answer("01234567890"),destroy(){destroyed=true;}})});
  assert.deepEqual(await large.request(input),{ok:false,refused:"too_large"});assert.equal(destroyed,true);
  const secret="invented-secret-sentinel";
  const bad=nodeSourceTransport({resolve:async()=>{throw new Error(secret);}});await assert.rejects(bad.request(input),e=>e instanceof Error&&!e.message.includes(secret));
  const compressed=nodeSourceTransport({resolve:async()=>[{address:"8.8.8.8",family:4}],wire:async()=>answer("secret",{"content-encoding":"gzip"})});await assert.rejects(compressed.request(input));
});
