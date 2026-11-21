import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktop, parseTree, matching } from '../src/workflows.js';

const row = (value = '', suffix = '') => `- [42/1] Edit valueWritable=true "输入框" = ${JSON.stringify(value)} automationId="editor"${suffix}\n- [42/2] Button "保存" automationId="save"`;
function fixture(overrides = {}) {
  let text = '', reads = 0;
  const calls = [];
  const win = { windowId:'w1',
    async getAccessibilityTree() { reads++; calls.push('read'); return row(text); },
    async setValue(id, value) { calls.push(['setValue', id, value]); text = value; return { dispatched:true }; },
    async invoke(id) { calls.push(['invoke', id]); return { dispatched:true }; },
    async click(point, options) { calls.push(['click', point, options]); return { dispatched:true }; },
    async typeText(value) { calls.push(['typeText', value]); text += value; return { dispatched:true }; },
    async getScreenshot() { return { width:100, height:100, attachmentId:'image' }; }, ...overrides };
  const app = { getWindows: async () => [{windowId:'w1',title:'Fixture'}], getWindow: async () => win,
    activate: async () => ({dispatched:true}) };
  const cua = { listApps: async () => [{id:'test.exe',displayName:'测试 App',isRunning:true}],
    getApp: async () => { calls.push('consent'); return app; }, getCapabilities: async () => ({platform:'windows'}) };
  return { cua, win, app, calls, reads: () => reads,
    async controller(options = {}) { return (await createDesktop(cua,{pollMs:20,timeoutMs:60,...options}).selectApp('test.exe')).window('w1'); } };
}
test('parses Unicode, escaped values, automation IDs and empty values', () => {
  const parsed = parseTree(row('中文\n"quoted"\\path'));
  assert.equal(parsed.elements[0].value,'中文\n"quoted"\\path');
  assert.equal(parsed.elements[0].name,'输入框');
  assert.equal(parsed.elements[0].automationId,'editor');
  assert.equal(parseTree(row()).elements[0].value,'');
});
test('reads semantic flags without confusing words in names', () => {
  const parsed = parseTree('- [1] Button disabled selected=false "focused disabled"\n- [2] Button "disabled"');
  assert.equal(parsed.elements[0].enabled,false); assert.equal(parsed.elements[0].focused,false);
  assert.equal(parsed.elements[0].selected,false); assert.equal(parsed.elements[1].enabled,true);
});
test('unknown text is retained, not fabricated as a control', () => {
  const result = parseTree('unavailable\n- unreadable branch'); assert.equal(result.elements.length,0); assert.match(result.tree,/unavailable/);
});
test('invalid/empty/broad selector typos fail closed', () => {
  for (const selector of [{},{nam:'保存'},{name:''},{enabled:'yes'},null]) assert.throws(()=>matching(parseTree(row()),selector));
});
test('searches current app names and IDs case-insensitively', async () => {
  const f = fixture(); assert.equal((await createDesktop(f.cua).findApps('APP')).length,1);
  assert.equal((await createDesktop(f.cua).findApps('TEST.EXE')).length,1);
});
test('missing and unopened apps do not call getApp or launch', async () => {
  const f = fixture(); const desktop = createDesktop(f.cua);
  await assert.rejects(desktop.selectApp('unknown'),{code:'APP_NOT_FOUND'});
  f.cua.listApps = async()=>[{id:'test.exe',isRunning:false}];
  await assert.rejects(desktop.selectApp('test.exe'),{code:'APP_NOT_RUNNING'}); assert.deepEqual(f.calls,[]);
});
test('application consent denial propagates', async () => {
  const f = fixture(); f.cua.getApp = async()=>{throw new Error('USER_DENIED');};
  await assert.rejects(createDesktop(f.cua).selectApp('test.exe'),/USER_DENIED/);
});
test('unknown window is rejected', async () => {
  const f = fixture(); const app = await createDesktop(f.cua).selectApp('test.exe');
  await assert.rejects(app.window('other'),{code:'WINDOW_NOT_FOUND'});
});
test('setValue refreshes, changes once, and verifies the exact value', async () => {
  const f = fixture(); const win = await f.controller();
  const result = await win.setValue({automationId:'editor'},'你好',{verify:true});
  assert.equal(result.verified,true); assert.equal(f.calls.filter(x=>x[0]==='setValue').length,1);
  assert.equal(f.reads(),2);
});
test('ambiguous controls never dispatch input', async () => {
  const f = fixture({getAccessibilityTree:async()=>'- [1] Button "保存"\n- [2] Button "保存"'});
  await assert.rejects((await f.controller()).invoke({name:'保存'}),{code:'AMBIGUOUS_CONTROL'});
  assert.equal(f.calls.filter(x=>x[0]==='invoke').length,0);
});
test('disabled controls never dispatch input', async () => {
  const f = fixture({getAccessibilityTree:async()=>'- [1] Button disabled "保存"'});
  await assert.rejects((await f.controller()).invoke({name:'保存'}),{code:'CONTROL_DISABLED'});
});
test('no fallback click after invoke reports false', async () => {
  const f = fixture({invoke:async()=>({dispatched:false})});
  await assert.rejects((await f.controller()).invoke({name:'保存'}),{code:'NOT_DISPATCHED'});
  assert.equal(f.calls.filter(x=>x[0]==='click').length,0);
});
test('failed postcondition records uncertainty without repeating action', async () => {
  const f = fixture(); const win = await f.controller();
  await assert.rejects(win.invoke({name:'保存'},{verify:{selector:{name:'Saved'},timeoutMs:40}}),{code:'ACTION_UNVERIFIED'});
  assert.equal(f.calls.filter(x=>x[0]==='invoke').length,1);
});
test('malformed postcondition is rejected before input', async () => {
  const f = fixture(); await assert.rejects((await f.controller()).invoke({name:'保存'},{verify:{}}),{code:'INVALID_ARGUMENT'});
  assert.equal(f.calls.filter(x=>x[0]==='invoke').length,0);
});
test('negative conditions cannot mistake truncated trees for absence', async () => {
  const f = fixture(); await assert.rejects((await f.controller()).waitFor({selector:{name:'Missing'},present:false}),{code:'INCOMPLETE_OBSERVATION'});
});
test('positive wait only retries observations', async () => {
  let n = 0; const f = fixture({getAccessibilityTree:async()=>++n > 2 ? '- [1] Text "Ready"' : row()});
  const result = await (await f.controller({timeoutMs:200})).waitFor({selector:{name:'Ready'}});
  assert.equal(result.attempts,3);
});
test('aborted signal prevents input', async () => {
  const f = fixture(); const win = await f.controller();
  await assert.rejects(win.typeText('x',{signal:AbortSignal.abort(new Error('stop'))}),/stop/);
  assert.equal(f.calls.filter(x=>x[0]==='typeText').length,0);
});
test('aborting polling stops further reads', async () => {
  const f = fixture(); const win = await f.controller(); const abort = new AbortController();
  const pending = win.waitFor({selector:{name:'Missing'},timeoutMs:1000,signal:abort.signal});
  setTimeout(()=>abort.abort(new Error('stopped')),10);
  await assert.rejects(pending,/stopped/); assert.equal(f.reads(),1);
});
test('serialized concurrent mutations preserve observation/action ordering', async () => {
  const f = fixture(); const win = await f.controller();
  await Promise.all([win.setValue({automationId:'editor'},'first',{verify:true}),win.setValue({automationId:'editor'},'second',{verify:true})]);
  assert.deepEqual(f.calls.filter(x=>Array.isArray(x)).map(x=>x[2]),['first','second']);
  assert.equal(f.calls[1],'read');
});
test('rejected queue entry does not poison later calls', async () => {
  const f = fixture(); const win = await f.controller();
  await assert.rejects(win.invoke({name:'missing'})); assert.equal((await win.observe()).elements.length,2);
});
test('click verification options never leak into native parameters', async () => {
  const f = fixture(); const win = await f.controller();
  await win.click([10,20],{clickCount:2,verify:{selector:{name:'保存'}}});
  assert.deepEqual(f.calls.find(x=>x[0]==='click')[2],{clickCount:2});
});
test('plain dispatch never claims verification', async () => {
  const f = fixture(); const result = await (await f.controller()).typeText('abc'); assert.equal(result.verified,false);
});
test('read failure after input is reported as uncertain outcome', async () => {
  const f = fixture({getAccessibilityTree:async()=>{throw new Error('window closed');}});
  const result=await (await f.controller()).typeText('abc');
  assert.equal(result.status,'dispatched-unverified');assert.equal(result.verified,false);
  assert.equal(f.calls.filter(x=>x[0]==='typeText').length,1);
});

test('expected close verifies window disappearance without reading a dead window',async()=>{
  const f=fixture();const win=await f.controller();
  f.win.invoke=async()=>{f.app.getWindows=async()=>[];return {dispatched:true};};
  const result=await win.invoke({name:'保存'},{verify:{closed:true}});
  assert.equal(result.windowClosed,true);assert.equal(result.verified,true);
});
test('strict observation retains legacy exception semantics',async()=>{
  const f=fixture({getAccessibilityTree:async()=>{throw new Error('closed');}});
  await assert.rejects((await f.controller({strictObservation:true})).typeText('x'),{code:'ACTION_UNVERIFIED'});
});
test('Windows typing activates once before input without replay',async()=>{
  const f=fixture();f.app.activate=async()=>{f.calls.push('activate');return {dispatched:true};};
  await (await f.controller()).typeText('x');assert.equal(f.calls.filter(x=>x==='activate').length,1);
  assert(f.calls.indexOf('activate')<f.calls.findIndex(x=>x[0]==='typeText'));
});
test('screenshot attachment is passed through unchanged', async () => {
  const f = fixture(); assert.equal((await (await f.controller()).screenshot()).attachmentId,'image');
});

test('cancellation while observing prevents subsequent input', async () => {
  const abort = new AbortController();
  const f = fixture({getAccessibilityTree:async()=>{abort.abort(new Error('stop'));return row();}});
  await assert.rejects((await f.controller()).invoke({name:'保存'},{signal:abort.signal}),/stop/);
  assert.equal(f.calls.filter(x=>x[0]==='invoke').length,0);
});

test('cancellation after dispatch preserves uncertain outcome evidence', async () => {
  const abort = new AbortController();
  const f = fixture({typeText:async()=>{abort.abort(new Error('stop'));return {dispatched:true};}});
  await assert.rejects((await f.controller()).typeText('x',{signal:abort.signal}), error=>
    error.code==='ACTION_UNVERIFIED' && error.details.dispatch.dispatched===true);
});

test('macOS keyboard dispatch uses application scope after observing focused window',async()=>{
  const f=fixture({getAccessibilityTree:async()=>'- [1] Edit focused "Input"'});
  f.cua.getCapabilities=async()=>({platform:'macos',keyboard:['app']});
  let count=0;f.app.typeText=async()=>{count++;return {dispatched:true};};
  const win=await f.controller();assert.equal(win.keyboardScope,'app');
  await win.typeText('hello');assert.equal(count,1);
});
test('macOS typing refuses a window without an observed focused control',async()=>{
  const f=fixture();f.cua.getCapabilities=async()=>({platform:'macos',keyboard:['app']});
  f.app.typeText=async()=>{throw new Error('must not dispatch');};
  await assert.rejects((await f.controller()).typeText('x'),{code:'WINDOW_NOT_FOCUSED'});
});
