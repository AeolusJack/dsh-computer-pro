import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
/** Persistent, private stdio connection. Cancellation destroys the connection, never retries. */
export class NativeBroker {
  constructor(executable, { spawnProcess = spawn, timeoutMs = 60000, idleMs = 0 } = {}) {
    Object.assign(this, {executable, spawnProcess, timeoutMs, idleMs}); this.tail = Promise.resolve();
  }
  request(request, signal) {
    const pending = this.tail.catch(() => {}).then(() => this.call(request, signal));
    this.tail = pending.then(() => {}, () => {}); return pending;
  }
  start() {
    if (this.child) return;
    const child = this.spawnProcess(this.executable, ['--server'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    this.child = child; let chunks = [], size = 0;
    const fail = error => { if (this.child === child) this.close(error); };
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 48 * 1024 * 1024) return fail(new Error('NATIVE_OUTPUT_LIMIT'));
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      const data = Buffer.concat(chunks); const end = data.indexOf(10);
      if (end !== data.length - 1) return fail(new Error('NATIVE_PROTOCOL: unexpected extra frame'));
      chunks = []; size = 0;
      try {
        const reply = JSON.parse(data.subarray(0,end).toString('utf8'));
        if (!this.active || reply.id !== this.active.id || reply.protocol !== 1) throw new Error('NATIVE_PROTOCOL: mismatched response');
        const active = this.active;
        if (!reply.ok) active.finish(new Error(reply.error || 'NATIVE_FAILED'));
        else active.finish(null, reply.result);
      } catch (error) { fail(error); }
    });
    child.stderr.on('data', () => {}); // Protocol is exclusively stdout; no unbounded logging.
    child.stdin.on('error', error => fail(error));
    child.on('error', error => fail(error));
    child.on('close', () => fail(new Error('NATIVE_EXITED: inspect state before retrying')));
  }
  call(request, signal) {
    signal?.throwIfAborted(); clearTimeout(this.idleTimer); this.start();
    return new Promise((resolve, reject) => {
      const id = randomUUID(); let timer;
      const abort = () => this.close(new Error('NATIVE_CANCELLED: dispatch may have occurred; inspect state'));
      const finish = (error, result) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active = null;
        if(this.idleMs>0){this.idleTimer = setTimeout(() => this.close(), this.idleMs); this.idleTimer.unref();}
        error ? reject(error) : resolve(result);
      };
      this.active = {id, finish};
      timer = setTimeout(() => this.close(new Error('NATIVE_TIMEOUT: dispatch may have occurred; inspect state')), this.timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) return abort();
      this.child.stdin.write(JSON.stringify({protocol:1,id,request}) + '\n');
    });
  }
  close(error = new Error('NATIVE_CLOSED')) {
    const child = this.child; this.child = null;
    clearTimeout(this.idleTimer);
    this.active?.finish(error);
    clearTimeout(this.idleTimer);
    if (child) { child.stdin.destroy(); child.kill(); }
  }
}
