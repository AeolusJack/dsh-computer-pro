/** Opt-in native acceptance. Only the fixture process created here may receive input. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktop } from '../src/workflows.js';

const [harness, fixture, helper, report] = process.argv.slice(2).map(value=>resolve(value));
const { createCuaApi } = await import(pathToFileURL(resolve(harness,'packages/experimental/cua/lib/api.js')));
const children = []; let socket; const checks = []; const events=[];
function child(exe, args=[]) {
  const p=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(p);
  p.stderr.on('data',data=>process.stderr.write(data));p.on('error',error=>console.error(error));return p;
}
function lines(stream) {
  const iterator=createInterface({input:stream})[Symbol.asyncIterator]();
  return async()=>{const item=await iterator.next();assert(!item.done,'Native stream ended');return JSON.parse(item.value);};
}
async function check(name,fn) { const start=performance.now();await fn();checks.push({name,passed:true,elapsedMs:Math.round(performance.now()-start)});console.log('PASS '+name); }
const deadline=setTimeout(()=>{socket?.destroy();for(const p of children)p.kill();},90000);
try {
  const owned=child(fixture);const readFixture=lines(owned.stdout);const initial=await readFixture();
  const inspect=async(command='inspect')=>{owned.stdin.write(command+'\n');return readFixture();};
  const runtimeKey=createHash('sha256').update(await readFile(helper)).digest('hex');
  const launcher=child(helper,['--serve','--instance-id',randomUUID().replaceAll('-',''),'--runtime-key',runtimeKey,'--connect-timeout-ms','15000','--grace-ms','3000']);
  const ready=await lines(launcher.stdout)();
  socket=createConnection(ready.endpoint);await once(socket,'connect');const read=lines(socket);
  const exchange=async frame=>{socket.write(JSON.stringify(frame)+'\n');return read();};
  const hello=await exchange({type:'hello',protocol:1,runtimeKey,config:{maxRequestBytes:1048576,maxResponseBytes:33554432,
    axTimeoutMs:10000,textEventIntervalMs:0,screenshotTimeoutMs:15000,timeoutMs:20000,graceMs:3000,pollIntervalMs:25,launchWaitMs:5000,maxClickHoldMs:1000}});
  assert.equal(hello.instanceId,ready.instanceId);let sequence=0;
  const raw=async(method,params={})=>{
    const reply=await exchange({id:String(++sequence),method,params});
    if(reply.error)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});
    events.push({method,ok:true});return reply.result;
  };
  // Same public facade used by the production workflow; only screenshot storage is not emulated here.
  const cua=createCuaApi(async({method,params})=>{
    const result=await raw(method,params);
    if(method==='getCapabilities')return {...result,platform:'windows',systemPointer:true,appLevelAccessibility:false,
      keyboard:['window'],coordinateSpace:'screenshot-pixels',browser:false,
      methods:['getCapabilities','listApps','getApp','listWindows','getState','setValue','invoke','activate','screenshot','click','typeText','pressKey']};
    return result;
  });
  const desktop=createDesktop(cua,{timeoutMs:3000,pollMs:50});
  let app,win;
  await check('native capability handshake',async()=>{const capabilities=await desktop.capabilities();assert.equal(capabilities.sessionLocked,false);});
  await check('discover and select only the owned fixture',async()=>{
    const apps=await desktop.findApps('dsh-cua-desktop-fixture');
    const entry=apps.find(item=>item.id.toLowerCase()===fixture.toLowerCase());
    assert(entry,'Fixture executable must appear in discovery');app=await desktop.selectApp(entry.id);
    const windows=await app.windows();assert(windows.some(item=>item.windowId===initial.state.window));win=await app.window(initial.state.window);
  });
  await check('read genuine UI Automation controls',async()=>{const state=await win.observe();assert(state.elements.some(e=>e.automationId==='editor'));});
  await check('Chinese Unicode write with readback verification',async()=>{
    const result=await win.setValue({automationId:'editor'},'你好 😀 Windows Computer Pro',{verify:true});
    assert.equal(result.verified,true);assert.equal((await inspect()).text,'你好 😀 Windows Computer Pro');
  });
  await check('invoke button exactly once',async()=>{const before=await inspect();await win.invoke({name:'Record click',role:'Button'});assert.equal((await inspect()).clicks,before.clicks+1);});
  await check('read-only wait verifies text',async()=>{assert.equal((await win.waitFor({selector:{automationId:'editor',value:'你好 😀 Windows Computer Pro'}})).verified,true);});
  await check('unknown control never dispatches input',async()=>{const before=await inspect();await assert.rejects(win.invoke({name:'does not exist'}),{code:'CONTROL_NOT_FOUND'});assert.deepEqual((await inspect()).clicks,before.clicks);});
  await check('window screenshot is valid PNG with declared dimensions',async()=>{
    // Select through the same fixture identity; raw capture exercises native capture independently of LLM image storage.
    const entry=(await desktop.findApps('dsh-cua-desktop-fixture')).find(item=>item.id.toLowerCase()===fixture.toLowerCase());
    const selected=await raw('getApp',{selector:entry.id});
    const shot=await raw('screenshot',{appHandle:selected.appHandle,windowId:initial.state.window});
    const png=Buffer.from(shot.data,'base64');assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),shot.pixelWidth);assert.equal(png.readUInt32BE(20),shot.pixelHeight);
  });
  await check('keyboard text in explicitly focused owned window',async()=>{
    await inspect('focus');await win.activate();await win.typeText(' OK');assert((await inspect()).text.includes(' OK'));
  });
  await writeFile(report,JSON.stringify({passed:checks.length,failed:0,checks,events,modelCalls:false,scope:'owned fixture only'},null,2));
} catch(error) {
  await writeFile(report,JSON.stringify({passed:checks.length,failed:1,checks,error:{message:error.message,code:error.code,stack:error.stack},events},null,2));
  throw error;
} finally {
  clearTimeout(deadline);socket?.end();
  for(const p of children) p.stdin.end();
  const timer=setTimeout(()=>{for(const p of children)if(p.exitCode===null)p.kill();},2000);timer.unref();
}
