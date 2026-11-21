import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {resolve} from 'node:path';import {writeFile} from 'node:fs/promises';
import {native,disposeNative} from '../src/extras-runtime.js';
import {findOcrTargets} from '../src/ocr-targets.js';
const checks=[];const check=async(name,fn)=>{const t=performance.now();await fn();checks.push({name,passed:true,ms:Math.round(performance.now()-t)});console.log('PASS '+name);};
const processFixture=spawn(resolve('../desktop-fixture/dsh-cua-desktop-fixture.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const reader=createInterface({input:processFixture.stdout})[Symbol.asyncIterator]();
const command=async s=>{processFixture.stdin.write(s+'\n');return JSON.parse((await reader.next()).value);};
let report;
try {
  const initial=JSON.parse((await reader.next()).value);let target;
  await check('persistent native protocol advertises version and exact methods',async()=>{const r=await native({method:'capabilities'});assert.equal(r.version,'0.4.0');assert(r.methods.includes('window_capture'));const status=await native({method:'input_status'});assert(status.available);assert(status.hotkeyAvailable);assert.equal(status.hotkey,'Ctrl+Alt+F8');});
  await check('Win32 discovery finds owned window without UIA traversal',async()=>{const rows=await native({method:'windows'});target=rows.find(w=>String(w.handle)===initial.state.window);assert(target);assert.equal(target.pid,processFixture.pid);});
  await check('unknown method rejected without poisoning persistent connection',async()=>{await assert.rejects(native({method:'bad'}),/UNKNOWN_METHOD/);assert.equal((await native({method:'capabilities'})).protocol,1);});
  await check('native OCR returns usable original-image word boxes',async()=>{const r=await native({method:'ocr',path:resolve('../ocr-fixture.png')});assert(findOcrTargets(r,'Computer').count===1);assert(r.lines[0].words[0].width>0);});
  await command('topmost');await command('focus');await command('pointer');await new Promise(r=>setTimeout(r,400));
  await check('exact window capture preserves identity and reports observed foreground',async()=>{const r=await native({method:'window_capture',windowId:target.windowId,bringToFront:false});assert.equal(r.windowId,target.windowId);assert.equal(r.captureKind,'visible-screen-region');assert(r.png.length>100);assert.equal(typeof r.foreground,'boolean');});
  await check('stale desktop state never sends input',async()=>{
    const before=await command('inspect');const shot=await native({method:'desktop_capture'});
    await assert.rejects(native({method:'desktop_action',action:'click',point:before.cursor,topology:shot.topology,expectedState:'invalid'}),/DESKTOP_STATE_CHANGED/);
    const after=await command('inspect');assert.equal(after.clicks,before.clicks);
  });
  await check('fresh desktop action clicks only the owned visible fixture',async()=>{
    const before=await command('inspect');assert.equal(before.under,before.window,'Fixture must own the target pixels');
    const shot=await native({method:'desktop_capture'});
    const r=await native({method:'desktop_action',action:'click',point:before.cursor,topology:shot.topology,expectedState:shot.state});assert.equal(r.dispatched,true);
    await new Promise(r=>setTimeout(r,100));assert.equal((await command('inspect')).clicks,before.clicks+1);
    await assert.rejects(native({method:'desktop_action',action:'click',point:before.cursor,topology:shot.topology,expectedState:shot.state}),/DESKTOP_STATE_CHANGED/);
  });
  report={passed:true,checks};
}catch(error){const blocked=/Fixture must own|DESKTOP_STATE_CHANGED/.test(String(error));report={passed:false,blocked,error:String(error),checks};process.exitCode=1;}
finally{disposeNative();processFixture.stdin.end('close\n');await writeFile(resolve('../v040-native-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
