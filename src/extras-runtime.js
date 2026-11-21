import { access, mkdtemp, rm, writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { run } from './process.js';
import { verifyPayload } from './payload.js';
const root=fileURLToPath(new URL('../',import.meta.url));
let preparation;
async function prepare() {
  if(process.platform==='win32') {await verifyPayload(root);return join(root,'native/win-x64/dsh-computer-pro-extras.exe');}
  if(process.platform!=='darwin')throw new Error('UNSUPPORTED_PLATFORM');
  const source=join(root,'native/macos/Extras.swift');
  const hash=createHash('sha256').update(await readFile(source)).digest('hex');
  const directory=join(homedir(),'Library/Caches/DeepSeekComputerPro',`${process.arch}-${hash}`);
  const executable=join(directory,'extras');
  try{await access(executable);return executable;}catch{}
  await mkdir(directory,{recursive:true});
  const staged=executable+'.'+randomUUID();
  try {
    await run('/usr/bin/xcrun',['swiftc','-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx14.0`,source,'-o',staged],{timeoutMs:120000});
    await rename(staged,executable);
  } finally {await rm(staged,{force:true});}
  return executable;
}
export async function native(request,signal) {
  signal?.throwIfAborted();
  preparation??=prepare().catch(error=>{preparation=undefined;throw error;});
  const executable=await preparation;
  const reply=JSON.parse(await run(executable,[],{input:JSON.stringify(request),signal,maxBytes:40*1024*1024,timeoutMs:60000}));
  if(!reply.ok)throw new Error(reply.error||'NATIVE_FAILED');
  return reply.result;
}
/** A capability may refer only to an attachment already recorded in this live Session. */
export function findSessionImage(events,id) {
  if(!/^sha256:[a-f0-9]{64}$/.test(id))throw new Error('INVALID_ATTACHMENT_ID');
  const stack=[events];let visited=0;
  while(stack.length){const value=stack.pop();if(++visited>500000)throw new Error('SESSION_SCAN_LIMIT');
    if(!value||typeof value!=='object')continue;
    if(value.attachmentId===id&&typeof value.mediaType==='string'&&Number.isSafeInteger(value.bytes)&&
        Number.isSafeInteger(value.width)&&Number.isSafeInteger(value.height))return value;
    for(const v of Object.values(value))if(v&&typeof v==='object')stack.push(v);
  }
  throw new Error('IMAGE_NOT_IN_SESSION: return the screenshot first, then call OCR in a subsequent tool call.');
}
export async function recognizeImage(attachments,events,id,language,signal,{region,scale}={}) {
  if(process.platform!=='win32'&&(region!==undefined||scale!==undefined))throw new Error('OCR_CROP_WINDOWS_ONLY');
  const ref=findSessionImage(events,id);
  if(ref.bytes>32*1024*1024||ref.width*ref.height>25000000)throw new Error('IMAGE_LIMIT');
  const stored=await attachments.readImage(ref,signal);
  const directory=await mkdtemp(join(tmpdir(),'computer-pro-ocr-'));
  try {const path=join(directory,'image');await writeFile(path,stored.data,{mode:0o600});
    return await native({method:'ocr',path,...language?{language}:{},...(region?{region}:{}),...(scale!==undefined?{scale}:{})},signal);
  }finally{await rm(directory,{recursive:true,force:true});}
}
