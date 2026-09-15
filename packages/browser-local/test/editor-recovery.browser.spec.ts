import { test, expect } from '@playwright/test';
import { startDriverServer, type DriverServer } from './fixtures/harness.ts';
let server: DriverServer;
test.beforeAll(async()=>{server=await startDriverServer({entry:new URL('./fixtures/editor-recovery.ts',import.meta.url)});});
test.afterAll(async()=>{await server.close();});
test('real IDB retains pending and newer draft across page close and reload, locks and accounts isolate',async({context,page})=>{
  await page.goto(server.origin);
  const seeded=await page.evaluate(()=>(window as any).recoveryTest.seed());
  await page.evaluate(()=>(window as any).recoveryTest.hold());
  await expect.poll(()=>page.evaluate(()=>(window as any).recoveryTest.entered())).toBe(true);
  const other=await context.newPage();await other.goto(server.origin);
  expect(await other.evaluate(()=>(window as any).recoveryTest.read())).toEqual({held:false,reason:'held-elsewhere'});
  expect(await other.evaluate(()=>(window as any).recoveryTest.read('two'))).toEqual({held:true,value:null});
  await page.close();
  await expect.poll(()=>other.evaluate(()=>(window as any).recoveryTest.read())).toEqual(seeded);
  await other.reload();
  expect(await other.evaluate(()=>(window as any).recoveryTest.read())).toEqual(seeded);
  expect(seeded.value.pending.body).toBe('prepared');expect(seeded.value.body).toBe('newer draft');
});
test('real Web Lock remains held while callback-returned write drains',async({context,page})=>{
  await page.goto(server.origin);await page.evaluate(()=>(window as any).recoveryTest.drain());
  await expect.poll(()=>page.evaluate(()=>(window as any).recoveryTest.entered())).toBe(true);
  const other=await context.newPage();await other.goto(server.origin);
  expect(await other.evaluate(()=>(window as any).recoveryTest.read())).toEqual({held:false,reason:'held-elsewhere'});
  await page.evaluate(()=>(window as any).recoveryTest.writeRelease());
  await expect.poll(()=>page.evaluate(()=>(window as any).recoveryTest.drained())).toBe(true);
  expect(await other.evaluate(()=>(window as any).recoveryTest.read())).toEqual({held:true,value:null});
});
