/** Reproducible, fail-on-drift patch of the pinned MIT-licensed Harness runtime.
 * Usage: node scripts/vendor.mjs D:/deepseek-harness */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const upstream=process.argv[2]; if(!upstream)throw new Error('Harness source path required');
const out=new URL('../src/vendor/',import.meta.url);await mkdir(out,{recursive:true});
const sources={};
function replace(text,before,after) {
  if(text.split(before).length!==2)throw new Error('Upstream anchor drift: '+before.slice(0,90));
  return text.replace(before,after);
}
function dependencies(text,owner) {
  // Preserve the host loader's module identity. Resolving dependencies to their
  // built lib paths would create duplicate scope/service symbols in source hosts.
  return `// Derived from DeepSeek Harness 2e39e70496aa02986ca6a820c5d497e816b69d7e (MIT).\nimport {createRequire as resolveZod} from 'node:module';\nimport {pathToFileURL as zodURL} from 'node:url';\n`+text.replace('import { installCua } from "@deepseek-ai/dsh-cua";',`import {installCua} from './cua.js';`).replace('import { z } from "zod";',`const {z}=await import(zodURL(resolveZod(import.meta.resolve('@deepseek-ai/dsh-cua')).resolve('zod')).href);`);
}
for(const [file,pkg] of [['cua.js','cua'],['windows.js','cua-windows']]) {
  let text=await readFile(resolve(upstream,`packages/experimental/${pkg}/lib/index.js`),'utf8');
  sources[pkg]={sha256:createHash('sha256').update(text).digest('hex'),upstream:'2e39e70496aa02986ca6a820c5d497e816b69d7e'};
  if(pkg==='cua') {
    text = "import { desktopGate } from '../desktop-gate.js';\n" + text;
    text = replace(text, 'return "appHandle" in request.params ? access.run(nativeClient, request.params.appHandle, signal, dispatch, route?.prepare) : dispatch(signal);', 'return desktopGate("cua:"+request.method, signal, () => "appHandle" in request.params ? access.run(nativeClient, request.params.appHandle, signal, dispatch, route?.prepare) : dispatch(signal), {mutation: !["getCapabilities","listApps","findApps","getState","listWindows","listActions","screenshot"].includes(request.method)});');

    text=replace(text,'JSON.stringify(new URL("../lib/bridge.js", import.meta.url).href)',`JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-cua/bridge'))`);
    text=replace(text,'JSON.stringify(new URL(`./bridge${extname(new URL(import.meta.url).pathname)}`, import.meta.url).href)',`JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-cua/bridge'))`);
    text=replace(text,'const access = installCuaAccess(ctx, {','const access = installCuaAccess(ctx, {\n\t\tfullAccessControlsDesktop: config.fullAccessControlsDesktop === true,');
    text=replace(text,'if (this.permitted(existing, observed)) return;','if (this.permitted(existing, observed) && (existing.scope !== "full-access" || hasFullAccess(this.ctx, agent, this.options.fullAccessControlsDesktop))) return;');
    text=replace(text,'let scope = saved ? "persistent" : "session";',`let scope = saved ? "persistent" : "session";
            // Transient authorization: never persist this as a human consent decision.
            const full = !saved && decision?.decision !== 'allow' && hasFullAccess(this.ctx, agent, this.options.fullAccessControlsDesktop);
            if (full && Object.values(observed.sessions).some(s=>s.decision==='deny')) throw this.denied(identity);
            if (full) scope = 'full-access';`);
    text=replace(text,'if (!saved && decision?.decision !== "allow") {','if (!full && !saved && decision?.decision !== "allow") {');
    text=replace(text,'if (scope === "persistent" && !saved && !this.options.store.persistent) throw this.denied(identity);',`if (scope === 'full-access') {
                    if (!hasFullAccess(this.ctx, agent, this.options.fullAccessControlsDesktop)) throw new NativeError('APP_ACCESS_REVOKED','Full access was disabled before application selection');
                    return {revoked:app.revoked,revision:app.sessions[agent.id]?.revision};
                }
                if (scope === "persistent" && !saved && !this.options.store.persistent) throw this.denied(identity);`);
    text=replace(text,'const requireAccess = async () => {',`const requireAccess = async () => {
            if (selected.scope === 'full-access' && !hasFullAccess(this.ctx, state.agent, this.options.fullAccessControlsDesktop)) {
                this.invalidate(selected.identity.id, state.agent);
                throw new NativeError('APP_ACCESS_REVOKED','Full access was disabled; select the application again under the current policy');
            }`);
    text=replace(text,'const session = app.sessions[selection.sessionId];',`const session = app.sessions[selection.sessionId];
        if (selection.scope === 'full-access') return !selection.lifetime.signal.aborted && app.revoked === selection.revoked && !Object.values(app.sessions).some(s=>s.decision==='deny');`);
    text=replace(text,'export { CuaAccess, CuaConfig, apply, installCua };','export { ApplicationAccess, CuaAccess, CuaConfig, apply, installCua };');
    text="import {hasFullAccess} from '../policy.js';\n"+text;
  }
  await writeFile(new URL(file,out),dependencies(text,`@deepseek-ai/dsh-${pkg}`));
}
await writeFile(new URL('provenance.json',out),JSON.stringify(sources,null,2)+'\n');
