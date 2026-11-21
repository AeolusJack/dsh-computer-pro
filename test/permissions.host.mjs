import test from 'node:test';import assert from 'node:assert/strict';
import {ApplicationAccess} from '../src/vendor/cua.js';
function fixture({mode='danger-full-access',enabled=true}={}) {
  let current=mode,saves=0,questions=0;const state={applications:{}};
  const store={persistent:false,drain:async()=>{},withApplication:async(_id,_signal,fn)=>fn(),withState:async(_signal,fn)=>fn({state,save:async next=>{saves++;Object.assign(state,next);}})};
  const ctx={effect:()=>{},get:name=>name==='sandboxPolicy'?{resolve:({session})=>({mode:session.mode??current})}:name==='userQuestions'?{ask:async()=>{questions++;return {answers:[{id:'cua-app-access',selected:['Allow for this session']}]};}}:undefined};
  const access=new ApplicationAccess(ctx,{store,fullAccessControlsDesktop:enabled});const agent={id:'a',session:{header:{}}};
  const identity={id:'a'.repeat(64),name:'Fixture',persistable:true,executablePath:'C:\\fixture.exe'};
  const client={disposed:false,invalidate(){this.disposed=true;}};const signal=new AbortController().signal;
  return{access,agent,identity,client,signal,state,setMode:value=>current=value,saves:()=>saves,questions:()=>questions,
    select:()=>access.select(agent,client,'h',identity,signal),run:()=>access.run(client,'h',signal,async()=>42)};
}
test('full access is prompt-free and creates no persistent or session consent',async()=>{const f=fixture();await f.select();assert.equal(await f.run(),42);assert.equal(f.questions(),0);assert.equal(f.saves(),0);assert.deepEqual(f.state.applications,{});});
test('downgrade invalidates selected handle before dispatch',async()=>{const f=fixture();await f.select();f.setMode('read-only');await assert.rejects(f.run(),{code:'APP_ACCESS_REVOKED'});assert.equal(f.client.disposed,true);});
test('explicit denial remains authoritative under full access',async()=>{const f=fixture();f.state.applications[f.identity.id]={revoked:0,sessions:{a:{decision:'deny',revision:1,identity:f.identity}}};await assert.rejects(f.select(),{code:'APP_ACCESS_DENIED'});assert.equal(f.questions(),0);});
test('turning off plugin integration restores normal approval',async()=>{const f=fixture({enabled:false});await f.select();assert.equal(f.questions(),1);assert.equal(f.saves(),1);});
test('restricted session cannot inherit another session full access',async()=>{const f=fixture();f.agent.session.mode='read-only';await f.select();assert.equal(f.questions(),1);});
test('revocation generation blocks an admitted transient handle',async()=>{const f=fixture();await f.select();f.state.applications[f.identity.id]={revoked:1,sessions:{}};await assert.rejects(f.run(),{code:'APP_ACCESS_REVOKED'});});
test('delegated sessions retain normal application approval policy',async()=>{const f=fixture();f.agent.session.header.origin='subagent';await f.select();assert.equal(f.questions(),1);});
