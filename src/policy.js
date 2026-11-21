/** Full desktop access is a plugin option backed by the LIVE host session policy.
 * Never writes approval answers or persistent application grants. */
export function hasFullAccess(ctx, agent, enabled = true) {
  if (!enabled || !agent?.session || agent.session.header?.origin === 'subagent') return false;
  try { return ctx.get('sandboxPolicy')?.resolve({session:agent.session})?.mode === 'danger-full-access'; }
  catch { return false; }
}
export function requireFullAccess(ctx, execution) {
  execution.signal?.throwIfAborted();
  if (!hasFullAccess(ctx, execution.agent)) throw new Error('FULL_ACCESS_REQUIRED: this Windows integration requires the current DSH session to have full access.');
}
