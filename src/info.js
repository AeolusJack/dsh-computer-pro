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
    output: { schema: { type: 'object',additionalProperties:true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      const payload = process.platform==='win32' ? await verifyPayload(fileURLToPath(new URL('../', import.meta.url))) : null;
      return { version: '0.3.0', platform: `${process.platform}-${process.arch}`, payloadVerified: payload!==null,
        validationStatus: process.platform==='darwin'?'EXPERIMENTAL_UNTESTED_ON_MAC':'WINDOWS_ACCEPTANCE_CANDIDATE',
        nativeFiles: payload?.files ?? null, provider: ctx.get('computerUse')?.providerName ?? null,
        addedTools:['computer_pro_apps','computer_pro_launch','computer_pro_ocr_languages','computer_pro_ocr',...(process.platform==='win32'?['computer_pro_office_read','computer_pro_office_edit_copy','computer_pro_desktop_capture','computer_pro_desktop_action']:[])],
        permissions:'Windows fullAccessControlsDesktop defaults to true: current-session full access avoids per-app prompts without persisting grants. Explicit app denials remain enforced. System pointer requires full access and no blocked apps; launch requires full access and respects blocked executable paths.',
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
        limits: 'No UAC/lock-screen control. File tools read saved content, not unsaved WPS data. Spreadsheet formulas are not calculated. macOS requires acceptance testing. OCR is not proof. Browser uses a separate session. No automatic mutation replay.' };
    },
  }));
  ctx.systemPrompt.section({
    name: 'windows-computer-pro-workflows', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 1,
    text: `Computer Pro is installed. On Windows with fullAccessControlsDesktop enabled, the provider honors the current session's danger-full-access policy without repeated app prompts. Explicit app denials still apply; no grant is persisted from full-access mode. Restricted sessions use normal application consent.
For convenient workflows in cua_run_code, initialize:
var { createDesktop } = await import(${JSON.stringify(workflowUrl)}); var desktop = createDesktop(cua);
In the PTC preset, use run_code instead; tools.cua is available but cua is not preinstalled. Initialize its authorized facade first:
var { connectCua } = await import(${JSON.stringify(bridgeUrl)}); var cua = connectCua(() => tools.cua);
Then import createDesktop and call createDesktop(cua) as above. Retain variables only when the execution mode supports it; otherwise initialize each program.
Use desktop.findApps(query), selectApp(exactId), selectAppByName(exactDisplayName), app.windows(), app.window(exactWindowId). On Windows, selectApp also accepts an absolute executable path discovered by computer_pro_apps; this avoids WPS path/AUMID drift while native identity checks remain enforced.
Windows support observe(), find(selector), waitFor({selector,text,timeoutMs}), invoke(selector,{verify}),
setValue(selector,value,{verify:true}), activate(), screenshot(), click(point,options), typeText(text), paste(text), pressKey(key,modifiers), scroll(options), drag(from,to,options), performAction(selector,action,argument), selectText(selector,text).
Selectors support exact name, role, automationId, value, enabled and selected; nameContains is explicit substring matching.
invoke/setValue refresh the tree and reject zero or multiple matches. Every input action runs once, returns dispatch evidence and reads fresh state; verified:true is only returned when an explicit postcondition passed.
Windows workflow keyboard input activates the application first; native checks still reject a different foreground window. If post-action observation fails, the default returns dispatched-unverified with observationError rather than throwing; strictObservation:true restores the old behavior. Explicit failed verification still throws ACTION_UNVERIFIED. For closing a window use verify:{closed:true}. Never replay input because observation failed. Coverage metrics identify sparse accessibility trees.
Keep each conversation's cua and desktop objects separate. Do not operate a window concurrently outside the desktop wrapper while a workflow is running.
Call computer_pro_info for installation diagnostics. Native desktop observation uses UI Automation on Windows and Accessibility on macOS; browser DOM and local OCR are separate tools. macOS is experimental pending real-device testing.`,
  });
}
