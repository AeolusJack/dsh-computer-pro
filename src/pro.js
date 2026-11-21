import { native } from './extras-runtime.js';
import { desktopGate } from './desktop-gate.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { requireFullAccess } from './policy.js';
import { run } from './process.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'computer-pro-pro-tools';
export const inject = ['tools', 'attachments', 'systemPrompt'];
const scriptDir = fileURLToPath(new URL('./pwsh/', import.meta.url));
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [
  { type: 'text', text: JSON.stringify(value) },
  ...(value.attachment ? [{ type: 'image', attachment: value.attachment }] : [])] };

function powershell(script, scriptArgs, signal, timeoutMs) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_ONLY: this helper needs Windows.');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(scriptDir, script), ...scriptArgs],
    { signal, timeoutMs, maxBytes: 48 * 1024 * 1024 });
}
function parseJson(text, code) {
  try { return JSON.parse(text.trim()); } catch { throw new Error(code + ': unexpected helper output ' + String(text).slice(0, 200)); }
}
const asArray = value => Array.isArray(value) ? value : [value];
/** Write an optional copy, creating its parent directory so a missing folder never fails the capture. */
async function saveCopy(filePath, data) {
  if (!filePath) return null;
  if(!isAbsolute(filePath))throw new Error('ABSOLUTE_SAVE_PATH_REQUIRED');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, data, {flag:'wx'});
  return filePath;
}
/** Decide how an application can actually be driven, from what its tree exposes. */
function classify(entry) {
  if (entry.error) return 'UNAVAILABLE';
  const total = entry.total ?? 0, named = entry.named ?? 0;
  const coverage = total ? named / total : 0;
  if (named >= 10 && coverage >= 0.55) return 'UIA_SEMANTIC';
  if (named >= 4 && coverage >= 0.15) return 'UIA_PARTIAL';
  return 'VISION_FIRST';
}
const strategy = {
  UIA_SEMANTIC: 'createDesktop -> selectApp -> describe/act/findAll. Selectors by name, role or automationId.',
  UIA_PARTIAL: 'describe + waitFor before each step, verify every dispatch; fall back to computer_pro_window_capture + computer_pro_ocr.',
  VISION_FIRST: 'computer_pro_window_capture -> read the pixels or OCR; drive with pressKey and computer_pro_desktop_action.',
  UNAVAILABLE: 'Inspect the error. Permission and secure-desktop denials must not be bypassed. A UIA timeout may use another authorized observation channel.',
};

export function apply(ctx) {
  let queue = Promise.resolve(), pending = 0;
  const serial = async operation => {
    if (pending >= 8) throw new Error('EXTRAS_BUSY');
    pending++;
    const task = queue.catch(() => {}).then(operation);
    queue = task;
    try { return await task; } finally { pending--; }
  };
  const register = (toolName, description, parameters, execute) => ctx.tools.register(defineTool({ name: toolName, description, parameters, output,
    execute: async (args, execution) => JSON.parse(JSON.stringify(await serial(() => desktopGate(toolName, execution.signal, () => execute(args, execution), {mutation: toolName === "computer_pro_window_capture"})))) }));

  async function noBlockedApps() {
    const policy=ctx.get('cuaAccess');
    if(!policy)throw new Error('APPLICATION_POLICY_UNAVAILABLE');
    if((await policy.applications()).blockedApps.length)throw new Error('APPLICATION_ACCESS_DENIED: use authorized per-application tools while explicit denials exist');
  }
  register('computer_pro_windows','Enumerate visible Windows top-level windows without UIA traversal. Stable IDs include handle, process ID and process creation time. Use exact windowId for capture.',{},async(_args,exec)=>{
    requireFullAccess(ctx,exec);await noBlockedApps();return {windows:await native({method:'windows'},exec.signal)};
  });
  register('computer_pro_clipboard_image', 'Read the current Windows clipboard image (for example after invoking a copy-image button) and return it as a PNG attachment. This is the reliable way to collect a generated picture: a window screenshot can miss a GPU-composited layer.',
    { savePath: { type: 'string', description: 'Optional absolute path to also write the PNG file.' } },
    async (args, exec) => {
      requireFullAccess(ctx, exec);
      await noBlockedApps();
      const {png,...meta}=await native({method:'clipboard_image'},exec.signal);
      const data=Buffer.from(png,'base64');
      const attachment=await ctx.attachments.saveImage({data,mediaType:'image/png'});
      return {attachment,...meta,bytes:data.length,savedPath:await saveCopy(args.savePath,data)};
    });

  register('computer_pro_window_capture', 'Capture one top-level window as a PNG attachment, optionally raising it first. Uses a real screen bitmap, so Electron/GPU content that window screenshots miss is captured.',
    { windowId: {type:'string'}, titleContains: { type: 'string' }, processName: { type: 'string' }, savePath: { type: 'string' }, bringToFront: { type: 'boolean' } },
    async (args, exec) => {
      requireFullAccess(ctx, exec);
      await noBlockedApps();
      const {png,...meta}=await native({method:'window_capture',...args},exec.signal);
      const data=Buffer.from(png,'base64');
      const attachment=await ctx.attachments.saveImage({data,mediaType:'image/png'});
      return {...meta,attachment,width:attachment.width,height:attachment.height,savedPath:await saveCopy(args.savePath,data)};
    });

  register('computer_pro_app_audit', 'Survey visible top-level windows and classify how well accessibility can drive each one, so every installed application gets the right strategy. Read-only: sends no input.',
    { maxWindows: { type: 'integer' }, maxElements: { type: 'integer' } },
    async (args, exec) => {
      requireFullAccess(ctx, exec);
      await noBlockedApps();
      for(const [key,max] of [['maxWindows',30],['maxElements',2000]]) if(args[key]!==undefined&&(!Number.isSafeInteger(args[key])||args[key]<1||args[key]>max))throw new Error('INVALID_AUDIT_BUDGET');
      const text = await powershell('app-audit.ps1',
        ['-MaxWindows', String(args.maxWindows ?? 20), '-MaxElements', String(args.maxElements ?? 400)], exec.signal, 20000);
      const rows = asArray(parseJson(text || '[]', 'AUDIT_FAILED'));
      const windows = rows.map(entry => {
        const total = entry.total ?? 0, named = entry.named ?? 0;
        const profile = classify(entry);
        return { process: entry.process, pid: entry.pid, title: entry.title, bounds: entry.bounds, total, named, identified: entry.identified ?? 0,
          semanticCoverage: total ? Number((named / total).toFixed(3)) : 0, truncated: Boolean(entry.truncated), profile,
          strategy: strategy[profile], error: entry.error ?? null,
          roles: Object.entries(entry.roles ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([role, count]) => role + ':' + count).join(' ') };
      });
      const byProfile = {};
      for (const item of windows) byProfile[item.profile] = (byProfile[item.profile] ?? 0) + 1;
      return { windows, summary: { windows: windows.length, byProfile },
        guidance: 'UIA_SEMANTIC: drive with workflows. UIA_PARTIAL: describe/waitFor and verify each step. VISION_FIRST: capture + OCR, then keyboard or desktop_action. UNAVAILABLE: no accessibility root.' };
    });

  ctx.systemPrompt.section({ name: 'computer-pro-pro-tools', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 3,
    text: 'Computer Pro also provides computer_pro_clipboard_image (retrieve a copied image, e.g. after invoking a copy-image control), computer_pro_window_capture (real screen bitmap of one window, with optional foreground raise; works when a window screenshot returns a blank GPU layer), and computer_pro_app_audit (classify every window as UIA_SEMANTIC, UIA_PARTIAL, VISION_FIRST or UNAVAILABLE before choosing a strategy). Prefer semantic UIA first, capture+OCR second, keyboard/pointer last. All tools need full access and never replay input.' });
}