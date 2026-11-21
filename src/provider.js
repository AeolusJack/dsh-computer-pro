import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
const NativeProvider = await (process.platform === 'darwin' ? import('@deepseek-ai/dsh-cua-macos') : import('./vendor/windows.js'));
import { verifyPayload } from './payload.js';

export const name = 'computer-pro-desktop';
export const inject = NativeProvider.inject;
export const Config = Schema.object({
  ...NativeProvider.Config.dict,
  ...(process.platform === 'win32' ? {helperPath: Schema.never().hidden()} : {}),
  maxClickHoldMs: Schema.number().step(1).min(1).max(60000).default(5000),
  fullAccessControlsDesktop: Schema.boolean().default(true).description('Windows: current DSH full access also authorizes desktop control, without per-app prompts. Explicit denials remain enforced; mode changes are checked before every operation.'),
});

/** Delegate all observations and input to Harness's existing consent and session pipeline. */
export async function apply(ctx, config) {
  if (process.platform === 'darwin') {
    if (!['arm64','x64'].includes(process.arch)) throw new Error('Unsupported macOS architecture');
    await NativeProvider.apply(ctx, config);
    ctx.logger.info('Computer Pro macOS adapter loaded. Experimental: real Mac acceptance is still required.');
    return;
  }
  const payload = await verifyPayload(fileURLToPath(new URL('../', import.meta.url)));
  await NativeProvider.apply(ctx, { ...config, helperPath: payload.executable });
  ctx.logger.info(`Computer Pro loaded: ${payload.files} native files verified; SDK-free runtime; upstream ${payload.upstreamCommit}.`);
}
