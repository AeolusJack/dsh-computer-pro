import { spawn } from 'node:child_process';
/** Bounded direct process execution: no shell, no background orphan after timeout. */
export function run(executable, args, { input='', signal, timeoutMs=30000, maxBytes=8*1024*1024 }={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let stdout=[],stderr=[],bytes=0,failure;
    const stop=error=>{failure??=error;
      if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill();}}
      else child.kill();
    };
    const abort=()=>stop(new Error('CANCELLED: operation may already have been dispatched; inspect before retrying.'));
    const timer=setTimeout(()=>stop(new Error('TIMEOUT: inspect state before retrying a mutation.')),timeoutMs);
    const collect=target=>chunk=>{bytes+=chunk.length;if(bytes>maxBytes)stop(new Error('OUTPUT_LIMIT'));else target.push(chunk);};
    child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
    child.on('error',error=>{failure=error;});child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(failure)return reject(failure);
      const out=Buffer.concat(stdout).toString('utf8');
      if(code!==0)return reject(new Error(out||Buffer.concat(stderr).toString('utf8')||`PROCESS_EXIT_${code}`));
      resolve(out);
    });
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    child.stdin.end(input);
  });
}
