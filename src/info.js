import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { verifyPayload } from './payload.js';

export const name = 'computer-pro-information';
export const inject = ['tools', 'systemPrompt'];
const workflowUrl = new URL('./workflows.js', import.meta.url).href;
const bridgeUrl = import.meta.resolve('@deepseek-ai/dsh-cua/bridge');
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'computer_pro_info',
    description: 'Read Computer Pro usage and verify its bundled Windows executable and DLLs. Does not operate applications.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const payload = process.platform==='win32' ? await verifyPayload(fileURLToPath(new URL('../', import.meta.url))) : null;
      return JSON.stringify({ version: '0.2.0', platform: `${process.platform}-${process.arch}`, payloadVerified: payload!==null,
        validationStatus: process.platform==='darwin'?'EXPERIMENTAL_UNTESTED_ON_MAC':'WINDOWS_ACCEPTANCE_CANDIDATE',
        nativeFiles: payload?.files, provider: ctx.get('computerUse')?.providerName ?? null,
        addedTools:['computer_pro_apps','computer_pro_launch','computer_pro_ocr_languages','computer_pro_ocr'],
        browserTools:'mcp__playwright-mcp__* in new live sessions when Chrome/Edge is available',
        workflowModule: workflowUrl,
        bridgeModule: bridgeUrl,
        ptcInitialize: `var { connectCua } = await import(${JSON.stringify(bridgeUrl)}); var cua = connectCua(() => tools.cua); var { createDesktop } = await import(${JSON.stringify(workflowUrl)}); var desktop = createDesktop(cua);`,
        initialize: `var { createDesktop } = await import(${JSON.stringify(workflowUrl)}); var desktop = createDesktop(cua);`,
        examples: ['await desktop.findApps("记事本")', 'var app = await desktop.selectApp(exactAppId);',
          'inspect(await app.windows()); var win = await app.window(exactWindowId);',
          'inspect(await win.observe());', 'await win.setValue({automationId:"editor"}, "你好", {verify:true});',
          'await win.invoke({role:"Button", name:"保存"}, {verify:{selector:{name:"已保存"}}});',
          'inspect(await win.screenshot());'],
        limits: 'No UAC/lock-screen control. macOS adapter requires a Mac acceptance run. OCR is not proof of success. Browser uses a separate Chromium session, not personal tabs. Mutations are never automatically replayed after failure.' });
    },
  }));
  ctx.systemPrompt.section({
    name: 'windows-computer-pro-workflows', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 1,
    text: `Computer Pro is installed. The normal cua API and application consent remain authoritative.
For convenient workflows in cua_run_code, initialize:
var { createDesktop } = await import(${JSON.stringify(workflowUrl)}); var desktop = createDesktop(cua);
In the PTC preset, use run_code instead; tools.cua is available but cua is not preinstalled. Initialize its authorized facade first:
var { connectCua } = await import(${JSON.stringify(bridgeUrl)}); var cua = connectCua(() => tools.cua);
Then import createDesktop and call createDesktop(cua) as above. Retain variables only when the execution mode supports it; otherwise initialize each program.
Use desktop.findApps(query), selectApp(exactId), app.windows(), app.window(exactWindowId).
Windows support observe(), find(selector), waitFor({selector,text,timeoutMs}), invoke(selector,{verify}),
setValue(selector,value,{verify:true}), activate(), screenshot(), click(point,options), typeText(text), pressKey(key,modifiers), scroll(options), drag(from,to,options).
Selectors support exact name, role, automationId, value, enabled and selected; nameContains is explicit substring matching.
invoke/setValue refresh the tree and reject zero or multiple matches. Every input action runs once, returns dispatch evidence and reads fresh state; verified:true is only returned when an explicit postcondition passed.
Input requires foreground activation when applicable. On errors, cancellation or uncertain outcomes, inspect fresh state; never blindly repeat input. Do not bypass denied application consent with other tools.
findApps filters the observed application catalog; applications without windows must be opened by the user. Keep each conversation's cua and desktop objects separate. Do not operate a window concurrently outside the desktop wrapper while a workflow is running.
Call computer_pro_info for installation diagnostics. Native desktop observation uses UI Automation on Windows and Accessibility on macOS; browser DOM and local OCR are separate tools. macOS is experimental pending real-device testing.`,
  });
}
