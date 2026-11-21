import test from 'node:test';
import assert from 'node:assert/strict';
import { findSessionImage } from '../src/extras-runtime.js';
import { run } from '../src/process.js';
const id='sha256:'+'a'.repeat(64);
const ref={attachmentId:id,mediaType:'image/png',bytes:300,width:100,height:80};
test('OCR reference must exist structurally in this session',()=>{
  assert.equal(findSessionImage([{data:{content:[{type:'image',attachment:ref}]}}],id),ref);
  assert.throws(()=>findSessionImage([],id),/IMAGE_NOT_IN_SESSION/);
});
test('text mentioning an attachment is not an attachment capability',()=>{
  assert.throws(()=>findSessionImage([{text:JSON.stringify(ref)}],id),/IMAGE_NOT_IN_SESSION/);
  assert.throws(()=>findSessionImage([ref],'../../secret'),/INVALID_ATTACHMENT_ID/);
});
test('process arguments are literal, not shell instructions',async()=>{
  const arg='test; $(echo injected) & "literal"';
  assert.equal(await run(process.execPath,['-e','process.stdout.write(process.argv[1])',arg]),arg);
});
test('process output is bounded',async()=>{
  await assert.rejects(run(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],{maxBytes:100}),/OUTPUT_LIMIT/);
});
test('hung process is killed and reported uncertain',async()=>{
  await assert.rejects(run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100}),/TIMEOUT/);
});
test('cancelled operation does not spawn a process',async()=>{
  await assert.rejects(async()=>run(process.execPath,[],{signal:AbortSignal.abort(new Error('cancelled'))}),/cancelled/);
});
test('cancellation interrupts an already running worker',async()=>{
  const abort=new AbortController();const promise=run(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:abort.signal});
  setTimeout(()=>abort.abort(),100);await assert.rejects(promise,/CANCELLED/);
});
