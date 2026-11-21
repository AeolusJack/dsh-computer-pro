// Only for integration/permission tests against a local Harness checkout.
import {registerHooks,createRequire} from 'node:module';
import {readdirSync,existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.DSH_SOURCE;if(!root)throw new Error('Set DSH_SOURCE to the validated Harness checkout');
const packages=new Map();
function walk(dir,depth=0){if(depth>4)return;
  const manifest=join(dir,'package.json');if(existsSync(manifest)){const p=JSON.parse(readFileSync(manifest));if(p.name)packages.set(p.name,manifest);return;}
  for(const d of readdirSync(dir,{withFileTypes:true}))if(d.isDirectory()&&!d.name.startsWith('.')&&!['node_modules','src','lib','native'].includes(d.name))walk(join(dir,d.name),depth+1);
}
walk(resolve(root,'packages'));
registerHooks({resolve(spec,context,next){if(spec==='zod')return {url:pathToFileURL(createRequire(packages.get('@deepseek-ai/dsh-cua')).resolve(spec)).href,shortCircuit:true};if(spec.startsWith('@deepseek-ai/')){
  const name=spec.split('/').slice(0,2).join('/'),manifest=packages.get(name);
  if(manifest)return {url:pathToFileURL(createRequire(manifest).resolve(spec)).href,shortCircuit:true};
  try{return next(spec,context);}catch{return {url:pathToFileURL(createRequire(packages.get('@deepseek-ai/dsh-cua')).resolve(spec)).href,shortCircuit:true};}
}return next(spec,context);}});
