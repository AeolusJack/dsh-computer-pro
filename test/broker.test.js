import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {NativeBroker} from '../src/native-broker.js';
function fixture(options={}) {
  let starts=0;
  const code=`let n=0;require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.request.method==='hang')return;process.stdout.write(JSON.stringify({protocol:1,id:r.id,ok:true,result:{n:++n,method:r.request.method}})+'\\n')});`;
  return {starts:()=>starts,broker:new NativeBroker('fixture',{...options,spawnProcess:()=>{starts++;return spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','pipe']});}})};
}
test('broker reuses process and serializes protocol requests',async()=>{const f=fixture();try{const results=await Promise.all([f.broker.request({method:'one'}),f.broker.request({method:'two'})]);assert.deepEqual(results.map(r=>r.n),[1,2]);assert.equal(f.starts(),1);}finally{f.broker.close();}});
test('timeout destroys connection and only a new request restarts it',async()=>{const f=fixture({timeoutMs:150});try{await assert.rejects(f.broker.request({method:'hang'}),/NATIVE_TIMEOUT/);assert.equal(f.starts(),1);const r=await f.broker.request({method:'next'});assert.equal(r.n,1);assert.equal(f.starts(),2);}finally{f.broker.close();}});
test('abort before enqueue never launches a native helper',async()=>{const f=fixture();try{await assert.rejects(f.broker.request({method:'one'},AbortSignal.abort(new Error('stop'))),/stop/);assert.equal(f.starts(),0);}finally{f.broker.close();}});
