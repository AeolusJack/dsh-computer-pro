import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPayload } from '../src/payload.js';
const environment = {platform:'win32',arch:'x64'};
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(),'computer-pro-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'native/win-x64'),{recursive:true});
  const data = Buffer.from('test-only payload');
  const entry = {path:'dsh-computer-pro-0.2.0.exe',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
  await writeFile(join(root,'native/win-x64',entry.path),data);
  const save = files=>writeFile(join(root,'payload-manifest.json'),JSON.stringify({format:1,upstreamCommit:'fixture',files}));
  await save([entry]); return {root,entry,save};
}
test('payload verifies all declared bytes',async t=>{
  const f=await setup(t);assert.equal((await verifyPayload(f.root,environment)).files,1);
});
test('wrong OS/architecture is rejected before native load',async()=>{
  await assert.rejects(verifyPayload('.', {platform:'linux',arch:'x64'}),/PLATFORM/);
  await assert.rejects(verifyPayload('.', {platform:'win32',arch:'arm64'}),/PLATFORM/);
});
test('same-length native corruption is rejected',async t=>{
  const f=await setup(t);await writeFile(join(f.root,'native/win-x64',f.entry.path),Buffer.alloc(f.entry.bytes));
  await assert.rejects(verifyPayload(f.root,environment),/SHA256 mismatch/);
});
test('truncated native file is rejected',async t=>{
  const f=await setup(t);await writeFile(join(f.root,'native/win-x64',f.entry.path),'x');
  await assert.rejects(verifyPayload(f.root,environment),/size mismatch/);
});
test('duplicate manifest entry is rejected',async t=>{
  const f=await setup(t);await f.save([f.entry,f.entry]);await assert.rejects(verifyPayload(f.root,environment),/Invalid file entry/);
});
test('manifest paths cannot escape the payload directory',async t=>{
  const f=await setup(t);await writeFile(join(f.root,'native','outside.exe'),'test-only payload');
  await f.save([{...f.entry,path:'../outside.exe'}]);
  await assert.rejects(verifyPayload(f.root,environment),/escapes/);
});
test('missing executable is rejected',async t=>{
  const f=await setup(t);await writeFile(join(f.root,'native/win-x64','other.dll'),'test-only payload');
  await f.save([{...f.entry,path:'other.dll'}]);await assert.rejects(verifyPayload(f.root,environment),/Executable is missing/);
});

