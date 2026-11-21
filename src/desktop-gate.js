// One host-wide queue, including modules reloaded by Cordis. Never shared with PTC.
const key = Symbol.for('computer-pro.desktop-gate.v1');
const state = globalThis[key] ??= { tail: Promise.resolve(), pending: 0, active: null, epoch: 0, completed: 0 };
export function desktopStatus() {
  return { pending: state.pending, active: state.active, epoch: state.epoch, completed: state.completed };
}
export function setDesktopGuard(guard) { state.guard=guard; return () => {if(state.guard===guard)state.guard=null;}; }
export function invalidateDesktop() { return ++state.epoch; }
export async function desktopGate(label, signal, operation, { mutation = true } = {}) {
  signal?.throwIfAborted();
  if (state.pending >= 64) throw new Error('DESKTOP_BUSY: too many queued operations');
  state.pending++;
  const task = state.tail.catch(() => {}).then(async () => {
    signal?.throwIfAborted(); state.active = label;
    // Invalidate even an uncertain dispatch. Never replay an operation here.
    if (mutation) state.epoch++;
    try { if(mutation&&state.guard)await state.guard(signal);signal?.throwIfAborted();return await operation(); }
    finally { state.active = null; state.completed++; }
  });
  state.tail = task.then(() => {}, () => {});
  try { return await task; } finally { state.pending--; }
}
