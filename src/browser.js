import { access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import * as BrowserProvider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp';
export const name='computer-pro-browser';
export const inject=BrowserProvider.inject;
export const Config=Schema.object({executablePath:Schema.string(),headless:Schema.boolean().default(false),toolCallTimeoutMs:Schema.number().min(1000).max(120000).default(30000)});
export async function apply(ctx,config) {
  const candidates=config.executablePath?[config.executablePath]:process.platform==='win32'?
    [join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe')]:
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Chromium.app/Contents/MacOS/Chromium'];
  let executablePath;
  for(const candidate of candidates){if(!isAbsolute(candidate))throw new Error('BROWSER_PATH_MUST_BE_ABSOLUTE');try{await access(candidate);executablePath=candidate;break;}catch{}}
  if(!executablePath){ctx.logger.warn('Computer Pro browser unavailable: install Chrome/Edge or configure an absolute executablePath. Desktop and OCR remain available.');return;}
  await BrowserProvider.apply(ctx,{mode:'launch',headless:config.headless,toolCallTimeoutMs:config.toolCallTimeoutMs,executablePath});
}
