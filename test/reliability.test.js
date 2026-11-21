import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopGate,desktopStatus} from '../src/desktop-gate.js';
import {Snapshots,imagePoint} from '../src/snapshots.js';
import {findOcrTargets} from '../src/ocr-targets.js';
import {createDesktop} from '../src/workflows.js';
test('host queue serializes different tools and checks cancellation after waiting',async()=>{
  const order=[];let release;const held=new Promise(r=>release=r);const abort=new AbortController();
  const a=desktopGate('cua',null,async()=>{order.push('a');await held;order.push('b');});
  const b=desktopGate('extras',abort.signal,()=>order.push('wrong'));
  const rejected=assert.rejects(b,/stop/);abort.abort(new Error('stop'));release();await a;await rejected;
  await desktopGate('clipboard',null,()=>order.push('c'));
  assert.deepEqual(order,['a','b','c']);assert.equal(desktopStatus().pending,0);
});
test('snapshot consumption, expiration, owner isolation and revision changes',()=>{
  let time=0;const snapshots=new Snapshots({now:()=>time,ttlMs:30});const owner={};
  let shot=snapshots.save(owner,{epoch:2});
  assert.throws(()=>snapshots.read({},shot.snapshotId,2),/EXPIRED/);
  assert.throws(()=>snapshots.read(owner,shot.snapshotId,3),/STATE_CHANGED/);
  assert.equal(snapshots.consume(owner,shot.snapshotId,2),shot);
  assert.throws(()=>snapshots.consume(owner,shot.snapshotId,2),/EXPIRED/);
  shot=snapshots.save(owner,{epoch:2});time=31;
  assert.throws(()=>snapshots.read(owner,shot.snapshotId,2),/EXPIRED/);
});
test('coordinates preserve negative monitor origin and image normalization',()=>{
  const shot={attachment:{width:100,height:50},desktop:{left:-200,top:0,width:200,height:100}};
  assert.deepEqual(imagePoint(shot,{x:50,y:25}),{x:-100,y:50});
  assert.throws(()=>imagePoint(shot,{x:100,y:0}),/INVALID/);
});
test('OCR exact spans retain duplicate candidates and original boxes',()=>{
  const word=(text,x)=>({text,x,y:10,width:10,height:20});
  const result={width:100,height:100,lines:[{words:[word('保',0),word('存',10),word('保存为',30),word('保存',60)]}]};
  const found=findOcrTargets(result,'保存');assert.equal(found.count,2);
  assert.deepEqual(found.matches[0].point,{x:10,y:20});
  assert.equal(findOcrTargets(result,'删除').count,0);
});
async function windowFor(read,overrides={}) {
  const window={windowId:'w',getAccessibilityTree:read,...overrides};
  const app={getWindows:async()=>[{windowId:'w'}],getWindow:async()=>window,activate:async()=>({dispatched:true})};
  const cua={listApps:async()=>[{id:'a',isRunning:true}],getApp:async()=>app,getCapabilities:async()=>({platform:'windows'})};
  return (await createDesktop(cua).selectApp('a')).window('w');
}
test('tree budgets describe actual final read and cannot verify truncated absence',async()=>{
  const calls=[];const window=await windowFor(async o=>{calls.push(o.maxElements);return '- [1] Text "Ready"\ntruncated';});
  const state=await window.observe({maxElements:1});assert.deepEqual(calls,[1,4,16]);assert.equal(state.budget.maxElements,16);assert.equal(state.truncated,true);
  await assert.rejects(window.waitFor({absent:{name:'Missing'}}),{code:'INCOMPLETE_OBSERVATION'});
});
test('native permission errors keep their identity rather than becoming timeouts',async()=>{
  const window=await windowFor(async()=>{throw Object.assign(new Error('Denied'),{code:'APP_ACCESS_DENIED'});});
  await assert.rejects(window.observe(),{code:'APP_ACCESS_DENIED'});
});
test('batch stops with dispatch evidence when subsequent observation fails',async()=>{
  let n=0,clicks=0;const window=await windowFor(async()=>{if(n++)throw new Error('closed');return '- [1] Button "Close"';},{invoke:async()=>{clicks++;return {dispatched:true};}});
  const result=await window.act([{op:'invoke',selector:{name:'Close'}},{op:'invoke',selector:{name:'Close'}}]);
  assert.equal(clicks,1);assert.equal(result.status,'dispatched-unverified');assert.equal(result.stoppedAt,0);
});
