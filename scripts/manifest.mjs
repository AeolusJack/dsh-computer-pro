import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const native=resolve(root,'native/win-x64');
const files=[];
async function visit(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=resolve(directory,entry.name);
    if(entry.isDirectory())await visit(path);
    else if(entry.isFile()) {
      const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
      files.push({path:relative(native,path).replaceAll('\\','/'),bytes:(await stat(path)).size,sha256:hash.digest('hex')});
    } else throw new Error('Unexpected non-regular payload entry: '+path);
  }
}
await visit(native);files.sort((a,b)=>a.path.localeCompare(b.path));
const upstreamCommit=process.argv[2];
if(!/^[a-f0-9]{40}$/.test(upstreamCommit??''))throw new Error('Pass the full upstream Git commit.');
await writeFile(resolve(root,'payload-manifest.json'),JSON.stringify({format:1,upstreamCommit,architecture:'win-x64',files},null,2)+'\n');
console.log(`Manifest: ${files.length} native files`);
