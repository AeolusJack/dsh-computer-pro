import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';import {mkdtemp,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';import {createHash} from 'node:crypto';
import {run} from '../src/process.js';
const [directory,fixture]=process.argv.slice(2).map(p=>resolve(p));
const root=await mkdtemp(join(directory,'native-v3-'));const helper=resolve('native/win-x64/dsh-computer-pro-extras.exe');
const checks=[];const check=async(name,fn)=>{await fn();checks.push({name,passed:true});console.log('PASS '+name);};
const call=async request=>{const reply=JSON.parse(await run(helper,[],{input:JSON.stringify(request),timeoutMs:30000,maxBytes:40*1024*1024}));assert(reply.ok);return reply.result;};
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
await run('python',[resolve('test/office-fixtures.py'),root]);
for(const ext of ['docx','rtf','txt'])await check(ext+' read and exact replacement copy',async()=>{
  const path=join(root,'source.'+ext),outputPath=join(root,'edited.'+ext),before=await hash(path);
  const initial=await call({method:'office_read',path});assert.match(initial.data.text,/replace me/);
  const edited=await call({method:'office_edit_copy',path,outputPath,operations:[{kind:'replaceText',find:'replace me',replacement:'已修改 verified'}]});
  assert.match(edited.data.text,/已修改 verified/);assert.equal(await hash(path),before);assert.equal(edited.reopened,true);
  await assert.rejects(call({method:'office_edit_copy',path,outputPath,operations:[{kind:'replaceText',find:'replace me',replacement:'x'}]}),/OUTPUT_ALREADY_EXISTS/);
});
await check('DOCX duplicate match fails atomically',async()=>{
  const outputPath=join(root,'must-not-exist.docx');await assert.rejects(call({method:'office_edit_copy',path:join(root,'source.docx'),outputPath,operations:[{kind:'replaceText',find:'Duplicate',replacement:'bad'}]}),/TEXT_NOT_UNIQUE/);await assert.rejects(access(outputPath));
});
await check('DOCX run formatting retained after spanning replacement',async()=>{
  const code='import sys,zipfile; s=zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode(); assert "<w:b" in s; assert "Table cell 中文" in s';await run('python',['-c',code,join(root,'edited.docx')]);
});
await check('XLSX reads typed values and separate cached formulas',async()=>{
  const r=await call({method:'office_read',path:join(root,'source.xlsx'),sheet:'数据',range:'A1:C2'});assert.deepEqual(r.data.values, [['名称',12,24],['原始内容',null,null]]);assert.equal(r.data.formulas[0][2],'B1*2');
});
await check('XLSX editing preserves literal formula-like text, clears stale formula cache',async()=>{
  const path=join(root,'source.xlsx'),before=await hash(path);
  const r=await call({method:'office_edit_copy',path,outputPath:join(root,'edited.xlsx'),sheet:'数据',range:'A1:D2',operations:[{kind:'setCell',sheet:'数据',cell:'A2',expected:'原始内容',value:'=literal text'},{kind:'setCell',sheet:'数据',cell:'B1',expected:12,value:15},{kind:'setCell',sheet:'数据',cell:'D1',expected:null,formula:'=B1+1'}]});
  assert.equal(r.data.values[1][0],'=literal text');assert.equal(r.data.formulas[1][0],null);assert.equal(r.data.values[0][1],15);assert.equal(r.data.values[0][2],null);assert.equal(r.data.formulas[0][3],'B1+1');assert.equal(await hash(path),before);
});
await check('XLSX stale expectation prevents all output publication',async()=>{
  const outputPath=join(root,'bad.xlsx');await assert.rejects(call({method:'office_edit_copy',path:join(root,'source.xlsx'),outputPath,operations:[{kind:'setCell',cell:'A1',expected:'名称',value:'first'},{kind:'setCell',cell:'B1',expected:999,value:1}]}),/CELL_PRECONDITION_FAILED/);await assert.rejects(access(outputPath));
});
await check('application catalog contains WPS executable even without AppsFolder',async()=>{const apps=await call({method:'apps'});assert(apps.some(a=>a.id.toLowerCase().endsWith('wps.exe')));});
let owned;
try {
  owned=spawn(fixture,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});const iterator=createInterface({input:owned.stdout})[Symbol.asyncIterator]();
  const read=async()=>JSON.parse((await iterator.next()).value);await read();
  const inspect=async command=>{owned.stdin.write(command+'\n');return read();};
  await check('system desktop screenshot and physical coordinates on owned fixture',async()=>{
    await inspect('topmost');let before;
    for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,50));before=await inspect('pointer');if(before.under===before.window)break;}
    assert.equal(before.under,before.window,'fixture must be visible before any input');
    const shot=await call({method:'desktop_capture'});assert(shot.width>100&&shot.height>100);assert(Buffer.from(shot.png,'base64').length>1000);
    await call({method:'desktop_action',action:'click',topology:shot.topology,point:before.cursor});
    const after=await inspect('inspect');assert.equal(after.clicks,before.clicks+1);assert.equal(after.buttons,'None');
  });
  await check('changed topology and off-display points refuse input',async()=>{
    const shot=await call({method:'desktop_capture'}),before=await inspect('inspect');
    await assert.rejects(call({method:'desktop_action',action:'click',topology:'obsolete',point:before.cursor}),/DISPLAY_TOPOLOGY_CHANGED/);
    await assert.rejects(call({method:'desktop_action',action:'click',topology:shot.topology,point:{x:999999,y:999999}}),/POINT_OUTSIDE_DISPLAY/);
    assert.equal((await inspect('inspect')).clicks,before.clicks);
  });
}finally{if(owned){owned.stdin.write('release-input\n');owned.stdin.write('close\n');owned.stdin.end();}}
await writeFile(join(directory,'v3-native-extras-report.json'),JSON.stringify({passed:true,root,checks},null,2));
