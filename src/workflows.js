/** Observation-driven helpers. All I/O goes through the caller's authorized, logged cua binding. */
export class DesktopError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'DesktopError'; this.code = code; this.details = details; }
}
const queues = new WeakMap();
const fail = (code, message, details) => { throw new DesktopError(code, message, details); };
const jsonString = '"(?:[^"\\\\]|\\\\.)*"';
const checkSignal = signal => signal?.throwIfAborted();
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  checkSignal(signal);
  const done = () => { signal?.removeEventListener('abort', aborted); resolve(); };
  const timer = setTimeout(done, ms);
  const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
  signal?.addEventListener('abort', aborted, { once: true });
});
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}`);
  return value;
}
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT', `${name} must be a nonempty string`);
  return value;
}
function stringField(rest, key) {
  const match = rest.match(new RegExp(`(?:^| )${key}=(${jsonString})`));
  return match ? JSON.parse(match[1]) : undefined;
}
/** UI Automation patterns an element advertises, which decide what can be done without the foreground. */
function patternsField(rest) {
  const match = rest.match(/ patterns=\[([^\]]*)\]/);
  return match ? Object.freeze(match[1].split(',').map(part => part.trim().replace(/^"|"$/g, '')).filter(Boolean)) : Object.freeze([]);
}
const declares = (element, pattern) => Array.isArray(element?.patterns) && element.patterns.includes(pattern);
/** Screen rectangle of an element, in physical pixels, when the provider reports one. */
function boundsField(rest) {
  const match = rest.match(/ bounds=\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/);
  return match ? Object.freeze({ x: +match[1], y: +match[2], width: +match[3], height: +match[4] }) : undefined;
}
/** Parse only complete UIA rows; retain the raw tree so unknown formats are never hidden. */
export function parseTree(tree) {
  if (typeof tree !== 'string' || tree.length > 4_000_000) fail('INVALID_OBSERVATION', 'Expected bounded accessibility text.');
  const elements = [];
  for (const line of tree.split('\n')) {
    const row = line.match(/^\s*- \[([^\]]+)\] (\w+)(.*)$/);
    if (!row) continue;
    const [, id, role, rest] = row;
    const nameMatch = rest.match(new RegExp(`^((?: (?:disabled|focused|selected=(?:true|false)|expanded=(?:true|false)|valueWritable=\\w+|selectionWritable=(?:true|false)))*) (${jsonString})(?= |$)`));
    const valueMatch = rest.match(new RegExp(` = (${jsonString})(?= |$)`));
    const flags = nameMatch ? nameMatch[1] : rest.split('"')[0];
    elements.push(Object.freeze({ id, role, name: nameMatch ? JSON.parse(nameMatch[2]) : '',
      automationId: stringField(rest, 'automationId'), value: valueMatch ? JSON.parse(valueMatch[1]) : undefined,
      enabled: !/(?:^| )disabled(?: |$)/.test(flags), focused: /(?:^| )focused(?: |$)/.test(flags),
      selected: / selected=true(?: |$)/.test(flags) ? true : / selected=false(?: |$)/.test(flags) ? false : undefined,
      valueWritable: / valueWritable=true(?: |$)/.test(flags), indent: line.length - line.trimStart().length, index: elements.length,
      bounds: boundsField(rest), patterns: patternsField(rest),
      line }));
  }
  const named=elements.filter(e=>e.name.trim()).length, identified=elements.filter(e=>e.automationId).length;
  return Object.freeze({ tree, elements: Object.freeze(elements), capturedAt: new Date().toISOString(),
    coverage: {total:elements.length,named,identified,semanticCoverage:elements.length ? named/elements.length : 0,
      recommendation:named<3 || named/Math.max(elements.length,1)<0.15 ? 'Sparse accessibility: use an application API for document data; screenshots/OCR for visible UI.' : 'Use unique semantic selectors where available.'} });
}
const selectorKeys = new Set(['name','nameContains','nameMatches','role','automationId','value','valueContains','valueMatches','enabled','selected','valueWritable']);
function validateSelector(selector) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || Object.keys(selector).length === 0)
    fail('INVALID_SELECTOR', 'Use at least one exact selector field.');
  for (const [key, value] of Object.entries(selector)) {
    if (!selectorKeys.has(key)) fail('INVALID_SELECTOR', `Unsupported selector field: ${key}`);
    if (key === 'enabled' || key === 'selected' || key === 'valueWritable') { if (typeof value !== 'boolean') fail('INVALID_SELECTOR', `${key} must be boolean`); }
    else if (typeof value !== 'string' || (key !== 'value' && !value.length)) fail('INVALID_SELECTOR', `${key} must be a string`);
    else if (key === 'nameMatches' || key === 'valueMatches') { try { new RegExp(value); } catch { fail('INVALID_SELECTOR', `${key} must be a valid regular expression.`); } }
  }
  return { ...selector };
}
export function matching(observation, selector, pool) {
  selector = validateSelector(selector);
  return (pool ?? observation.elements).filter(element => Object.entries(selector).every(([key, value]) =>
    key === 'nameContains' ? element.name.includes(value)
      : key === 'nameMatches' ? new RegExp(value).test(element.name)
        : key === 'valueContains' ? (element.value ?? '').includes(value)
          : key === 'valueMatches' ? new RegExp(value).test(element.value ?? '')
            : element[key] === value));
}
/** Elements nested under one anchor, using the observed indentation of the accessibility tree. */
export function subtreeOf(observation, anchor) {
  if (!anchor || typeof anchor.index !== 'number') fail('INVALID_ARGUMENT', 'subtreeOf needs an element from a parsed observation.');
  const nested = [];
  for (let i = anchor.index + 1; i < observation.elements.length; i++) {
    const element = observation.elements[i];
    if (element.indent <= anchor.indent) break;
    nested.push(element);
  }
  return nested;
}
/** Compact candidates: enough to fix a selector without dumping a whole tree into the message. */
const brief = (matches, limit = 6) => Object.freeze(matches.slice(0, limit).map(element => Object.freeze({
  id: element.id, role: element.role, name: element.name, automationId: element.automationId ?? null,
  value: element.value ?? null, enabled: element.enabled })));
/** Resolve an anchor first, then search only its observed subtree. */
function resolveScoped(observation, selector, within) {
  if (!within) return matching(observation, selector);
  const scope = uniqueAny(observation, within);
  return matching(observation, selector, subtreeOf(observation, scope));
}
function uniqueAny(observation, selector, within) {
  const matches = resolveScoped(observation, selector, within);
  if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_CONTROL' : 'CONTROL_NOT_FOUND',
    `Expected one control; found ${matches.length}. Refine the selector${within ? ' or the within scope' : ''}.`,
    { selector, within, candidates: brief(matches) });
  return matches[0];
}
function unique(observation, selector, within) {
  const matches = resolveScoped(observation, selector, within);
  if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_CONTROL' : 'CONTROL_NOT_FOUND',
    `Expected one control; found ${matches.length}. Refine the selector${within ? ' or the within scope' : ''}.`,
    { selector, within, candidates: brief(matches) });
  if (!matches[0].enabled) fail('CONTROL_DISABLED', 'The selected control is disabled.', { candidates: brief([matches[0]]) });
  return matches[0];
}
/** Serialize across all windows sharing one cua facade: its snapshots are application-scoped. */
function serial(cua, signal, operation) {
  const previous = queues.get(cua) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => { checkSignal(signal); return operation(); });
  const settled = next.then(() => {}, () => {});
  queues.set(cua, settled);
  void settled.then(() => { if (queues.get(cua) === settled) queues.delete(cua); });
  return next;
}
/** Create a workflow controller for one conversation's cua facade. Never share between agents. */
export function createDesktop(cua, { timeoutMs = 15000, pollMs = 250, maxElements = 2000, maxDepth = 25, autoActivate = true, strictObservation = false } = {}) {
  if (!cua || typeof cua.listApps !== 'function' || typeof cua.getApp !== 'function') fail('INVALID_ARGUMENT', 'Pass the current conversation cua object.');
  integer(timeoutMs, 'timeoutMs', 1, 120000); integer(pollMs, 'pollMs', 20, 5000);
  integer(maxElements, 'maxElements', 1, 10000); integer(maxDepth, 'maxDepth', 1, 100);
  async function selectApp(id, { signal } = {}) {
    nonempty(id, 'appId');
    return serial(cua, signal, async () => {
      const catalog = await cua.listApps();
      const matches = catalog.filter(app => app.id === id);
      const executable = matches.length===0 && /^(?:[a-z]:[\\/]|\\\\)[^\0]+\.exe$/i.test(id) && (await cua.getCapabilities()).platform==='windows';
      if (matches.length !== 1 && !executable) fail('APP_NOT_FOUND', 'Use a current application ID or a discovered absolute Windows executable path.');
      if (matches[0] && !matches[0].isRunning) fail('APP_NOT_RUNNING', 'Launch the application before selecting it.');
      const app = await cua.getApp(id); // Provider enforces current host policy and explicit application denials.
      return {
        id,
        windows: (options = {}) => serial(cua, options.signal, () => app.getWindows()),
        async window(windowId, options = {}) {
          nonempty(windowId, 'windowId');
          return serial(cua, options.signal, async () => {
            const windows = await app.getWindows();
            if (!windows.some(item => item.windowId === windowId)) fail('WINDOW_NOT_FOUND', 'Window does not belong to this selected app.');
            return wrapWindow(app, await app.getWindow(windowId), await cua.getCapabilities());
          });
        },
      };
    });
  }
  function wrapWindow(app, window, capabilities) {
    /** Auto-escalate the tree budget: a full page is indistinguishable from a truncated one, so re-read bigger. */
    const read = async (options = {}) => {
      const budget0 = options.maxElements ?? maxElements, depth0 = options.maxDepth ?? maxDepth;
      integer(budget0,'maxElements',1,10000);integer(depth0,'maxDepth',1,100);
      let budget = budget0, depth = depth0, observation, truncated = false;
      const attempts = options.autoExpand === false ? 1 : 3;
      const slowMs = options.slowTreeMs ?? 10000;
      const started = Date.now();
      for (let attempt = 0; attempt < attempts; attempt++) {
        checkSignal(options.signal);
        const tick = Date.now();
        try { observation = parseTree(await window.getAccessibilityTree({details:true,maxElements:budget,maxDepth:depth})); }
        catch (error) {
          if (!/TIMEOUT|timed out|exceeded.*ms/i.test(String(error.code)+' '+String(error.message))) throw error;
          fail('TREE_READ_TIMEOUT','Native UIA observation timed out. Reduce the native tree budget or use another authorized channel; within only filters the returned tree.',{cause:error});
        }
        truncated = /\btruncated\b/i.test(observation.tree) || observation.elements.length >= budget;
        if (!truncated || budget >= 10000 || attempt + 1 >= attempts || Date.now()-tick > slowMs) break;
        budget = Math.min(budget*4,10000); depth = Math.min(Math.max(depth*2,50),100);
      }
      return Object.freeze({...observation,truncated,elapsedMs:Date.now()-started,
        budget:{maxElements:budget,maxDepth:depth,requestedElements:budget0,requestedDepth:depth0}});
    };
    const appKeyboard = capabilities.keyboard?.includes('app') && !capabilities.keyboard?.includes('window');
    const isForegroundDenial = error => /FOREGROUND|ACCESSDENIED/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
    // Providers wrap the native code in their own error type, so read the cause out of the message when needed.
    const denialCause = error => /FOREGROUND_DENIED/.test(`${error?.code ?? ''} ${error?.message ?? ''}`) ? 'FOREGROUND_DENIED' : (error?.code ?? error?.name ?? 'FOREGROUND_DENIED');
    async function keyboard(method,args,signal) {
      if (!appKeyboard && autoActivate) {
        checkSignal(signal);
        try { await app.activate(); }
        catch (error) {
          if (!isForegroundDenial(error)) throw error;
          if (method === 'typeText') {
            const observation = await read(); checkSignal(signal);
            const target = observation.elements.find(element => element.focused && element.valueWritable);
            if (target) throw new DesktopError('FOREGROUND_DENIED','Typing was not dispatched. Use setValue explicitly to replace a field value; appending text must not silently replace it.');

          }
          throw new DesktopError('FOREGROUND_DENIED', 'Windows refused foreground access for keyboard input. Write through a valueWritable control with setValue, click with invoke, or call focus() to see what is reachable without the foreground.', { cause: denialCause(error) });
        }
        checkSignal(signal);
      }
      if(appKeyboard) {
        const observation=await read();checkSignal(signal);
        if(!observation.elements.some(e=>e.focused))fail('WINDOW_NOT_FOCUSED','macOS keyboard targets the application. Focus a control in the selected window and observe it before typing.');
      }
      return (appKeyboard?app:window)[method](...args);
    }
    function condition(options) {
      if(options.closed===true) {
        if(options.selector || options.text!==undefined) fail('INVALID_ARGUMENT','closed cannot be combined with a control/text condition.');
        integer(options.timeoutMs ?? timeoutMs, 'timeoutMs', 1, 120000);
        return {...options};
      }
      if (options.settle !== undefined) {
        if (options.selector || options.text !== undefined || options.present !== undefined || options.absent !== undefined) fail('INVALID_ARGUMENT', 'settle stands alone: it reports a pause in change, not the presence of a control.');
        const raw = options.settle === true ? {quietMs:1500} : options.settle;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_ARGUMENT', 'settle must be true or { quietMs }.');
        const quietMs = integer(raw.quietMs ?? 1500, 'quietMs', 100, 60000);
        integer(options.timeoutMs ?? timeoutMs, 'timeoutMs', 1, 120000);
        return { ...options, quietMs };
      }
      if (options.absent !== undefined) {
        const absent = validateSelector(options.absent);
        const within = options.within === undefined ? undefined : validateSelector(options.within);
        if (options.selector || options.text !== undefined) fail('INVALID_ARGUMENT', 'absent cannot be combined with selector or text.');
        integer(options.timeoutMs ?? timeoutMs, 'timeoutMs', 1, 120000);
        return { ...options, absent, within };
      }
      if(options.within!==undefined)validateSelector(options.within);
      const selector = options.selector ? validateSelector(options.selector) : undefined;
      if (!selector && typeof options.text !== 'string') fail('INVALID_ARGUMENT', 'A selector or text condition is required.');
      if (options.text !== undefined) nonempty(options.text, 'text');
      if (options.present !== undefined && typeof options.present !== 'boolean') fail('INVALID_ARGUMENT', 'present must be boolean');
      if (options.present === false) fail('INCOMPLETE_OBSERVATION', 'This facade does not expose traversal completeness. Absence cannot be verified safely; use a positive confirmation control.');
      integer(options.timeoutMs ?? timeoutMs, 'timeoutMs', 1, 120000);
      return { ...options, selector };
    }
    async function wait(rawOptions) {
      const options = condition(rawOptions);
      const deadline = performance.now() + (options.timeoutMs ?? timeoutMs);
      let attempts = 0, lastTree = null, changedAt = performance.now();
      while (true) {
        checkSignal(options.signal);
        if(options.closed===true) {
          const windows=await app.getWindows(); attempts++; checkSignal(options.signal);
          if(!windows.some(item=>item.windowId===window.windowId)) return {verified:true,windowClosed:true,attempts,windows};
          const remaining=deadline-performance.now();
          if(remaining<=0) fail('CONDITION_TIMEOUT','The selected window has not closed.',{windows,attempts});
          await sleep(Math.min(pollMs,remaining),options.signal);continue;
        }
        const observation = await read(); attempts++;
        checkSignal(options.signal);
        if (options.quietMs !== undefined) {
          const now = performance.now();
          if (observation.tree !== lastTree) { lastTree = observation.tree; changedAt = now; }
          const quietFor = now - changedAt;
          if (attempts >= 2 && quietFor >= options.quietMs) return { settled: true, quietFor: Math.round(quietFor), attempts, observation };
          const settleRemaining = deadline - now;
          if (settleRemaining <= 0) fail('CONDITION_TIMEOUT', `The observation never stayed unchanged for ${options.quietMs}ms. Do not repeat the preceding action blindly.`, { attempts, quietMs: options.quietMs, quietFor: Math.round(quietFor) });
          await sleep(Math.min(pollMs, settleRemaining), options.signal);
          continue;
        }
        if (options.absent) {
          const scope = options.within ? uniqueAny(observation, options.within) : null;
          const pool = scope ? subtreeOf(observation, scope) : observation.elements;
          if(observation.truncated)fail('INCOMPLETE_OBSERVATION','Absence cannot be verified from a truncated tree.');
          const hits = matching(observation,options.absent,pool);
          if (hits.length === 0) return { verified: true, absent: true, attempts, scope: scope ? { id: scope.id, name: scope.name } : null, observation };
        }
        const matches = options.selector ? resolveScoped(observation, options.selector,options.within) : [];
        const exists = options.selector ? matches.length > 0 : observation.tree.includes(options.text);
        const textMatches = options.text === undefined || observation.tree.includes(options.text);
        if (performance.now() <= deadline && exists && textMatches)
          return { verified: true, attempts, observation, matches };
        const remaining = deadline - performance.now();
        if (remaining <= 0) fail('CONDITION_TIMEOUT', 'Postcondition did not become true; do not repeat the preceding action blindly.', { attempts, observation });
        await sleep(Math.min(pollMs, remaining), options.signal);
      }
    }
    async function once(invoke, { verify, signal } = {}) {
      if (verify !== undefined && verify !== false) condition(verify);
      checkSignal(signal);
      const dispatch = await invoke();
      if (!dispatch || dispatch.dispatched !== true) fail('NOT_DISPATCHED', 'The native provider did not dispatch this action. No fallback input was attempted.', { dispatch });
      // Surface how the input reached the application, so a degraded path is never mistaken for native keystrokes.
      const path = dispatch.inputPath ? { inputPath: dispatch.inputPath, foreground: dispatch.foreground, degradedFrom: dispatch.degradedFrom, elementId: dispatch.elementId } : {};
      if (verify && typeof verify === 'object') {
        try { return { dispatch, ...path, ...await wait({ ...verify, signal }) }; }
        catch (error) {
          throw new DesktopError('ACTION_UNVERIFIED', 'Action was dispatched, but its postcondition was not verified. Inspect before deciding what to do next.', { dispatch, cause: error.code ?? error.name, message: error.message });
        }
      }
      try { checkSignal(signal); return { dispatch, ...path, verified: false, observation: await read() }; }
      catch (error) {
        if(strictObservation || signal?.aborted) throw new DesktopError('ACTION_UNVERIFIED', 'Input was dispatched, but the subsequent observation failed. Do not repeat input blindly.', { dispatch, cause: error.code ?? error.name });
        return {dispatch,...path,verified:false,status:'dispatched-unverified',observationError:{code:error.code??error.name,message:error.message},next:'Observe current application windows. Do not replay input.'};
      }
    }
    const input = (operation, options = {}) => serial(cua, options.signal, () => once(operation, options));
    return Object.freeze({
      windowId: window.windowId,
      keyboardScope: appKeyboard ? 'app' : 'window',
      observe: (options = {}) => serial(cua, options.signal, () => read(options)),
      find: (selector, options = {}) => serial(cua, options.signal, async () => {
        const observation = await read(options);
        return resolveScoped(observation, selector, options.within);
      }),
      findAll: (selector, options = {}) => serial(cua, options.signal, async () => {
        const observation = await read(options);
        const matches = resolveScoped(observation, selector, options.within);
        const limit = integer(options.limit ?? 50,'limit',1,500);
        return { count: matches.length, elements: brief(matches, limit), truncated: matches.length > limit };
      }),
      /** Cheap window summary, so a caller does not have to pull a full tree just to see what exists. */
      describe: (options = {}) => serial(cua, options.signal, async () => {
        const observation = await read(options);
        return { windowId: window.windowId, capturedAt: observation.capturedAt, coverage: observation.coverage,
          budget: observation.budget, truncated: observation.truncated,
          focused: brief(observation.elements.filter(e => e.focused)),
          editable: brief(observation.elements.filter(e => e.valueWritable)),
          buttons: brief(observation.elements.filter(e => e.role === 'Button' && e.name.trim())),
          navigation: brief(observation.elements.filter(e => /^(MenuItem|TabItem|ListItem|ComboBox|Hyperlink|TreeItem)$/.test(e.role))) };
      }),
      /** One observation, many verified steps: the fast path for a form or a wizard. */
      act: (steps, options = {}) => serial(cua, options.signal, async () => {
        if (!Array.isArray(steps) || !steps.length || steps.length > 100) fail('INVALID_ARGUMENT', 'act expects a nonempty step array.');
        const results = [];
        let observation = await read(options);
        for (const [index, step] of steps.entries()) {
          checkSignal(options.signal);
          const op = String(step?.op ?? '');
          let control, dispatch;
          if (op === 'observe') { results.push({ index, op, coverage: observation.coverage, budget: observation.budget, truncated: observation.truncated }); continue; }
          if (op === 'waitFor') { results.push({ index, op, ...(await wait({ ...step, signal: options.signal })) }); observation = await read(options); continue; }
          if (op === 'sleep') { const ms = integer(step.ms ?? 250, 'ms', 1, 60000); await sleep(ms, options.signal); results.push({ index, op, slept: ms }); observation = await read(options); continue; }
          if (op === 'click' && step.point) dispatch = await window.click(step.point, step.options);
          else {
            if (!['invoke','setValue','performAction','selectText','click'].includes(op)) fail('INVALID_ARGUMENT', `Unsupported act step: ${op}`);
            if (op === 'setValue' && typeof step.value !== 'string') fail('INVALID_ARGUMENT', 'setValue step needs a string value.');
            control = unique(observation, step.selector, step.within);
            checkSignal(options.signal);
            if (op === 'invoke') dispatch = await window.invoke(control.id);
            else if (op === 'setValue') dispatch = await window.setValue(control.id, step.value);
            else if (op === 'performAction') dispatch = await window.performAction(control.id, step.action, step.argument);
            else if (op === 'selectText') dispatch = await window.selectText(control.id, step.text, step.options);
            else dispatch = await window.click(control.id, step.options);
          }
          if (!dispatch || dispatch.dispatched !== true) fail('NOT_DISPATCHED', 'The native provider did not dispatch this action.', { index, dispatch });
          results.push({ index, op, dispatched: true, element: control ? { id: control.id, name: control.name, role: control.role } : undefined, inputPath: dispatch.inputPath });
          try { observation = await read(options); }
          catch(error) { return {steps:results,status:'dispatched-unverified',stoppedAt:index,observationError:{code:error.code??error.name,message:error.message}}; }
        }
        return { steps: results, coverage: observation.coverage, budget: observation.budget };
      }),
      waitFor: (options) => serial(cua, options.signal, () => wait(options)),
      activate: (options = {}) => input(() => app.activate(), options),
      /** Request the foreground. A refusal is reported as data, so callers can switch to semantic input. */
      focus: (options = {}) => serial(cua, options.signal, async () => {
        try { const dispatch = await app.activate(); return { dispatch, foreground: 'granted' }; }
        catch (error) {
          if (!isForegroundDenial(error)) throw error;
          const observation = await read(); checkSignal(options.signal);
          return { foreground: 'denied', cause: denialCause(error),
            hint: 'Semantic input still works without the foreground: setValue a valueWritable control, invoke a Button, or use computer_pro_desktop_action to click the taskbar.',
            semanticTargets: observation.elements.filter(element => element.valueWritable).slice(0, 5).map(element => ({ id: element.id, name: element.name, focused: element.focused })),
            buttons: observation.elements.filter(element => element.role === 'Button').slice(0, 8).map(element => element.name) };
        }
      }),
      /** Focus by default: an occluded Electron window can return a blank frame without the foreground. */
      screenshot: (options = {}) => serial(cua, options.signal, async () => {
        let foreground = 'skipped';
        if (options.focus !== false) {
          try { await app.activate(); foreground = 'granted'; }
          catch (error) { if (!isForegroundDenial(error)) throw error; foreground = 'denied'; }
          if (foreground === 'granted') await sleep(options.settleMs ?? 150, options.signal);
        }
        const image = await window.getScreenshot();
        return options.withInfo ? { image, foreground, windowId: window.windowId } : image;
      }),
      invoke: (selector, options = {}) => input(async () => {
        const control = unique(await read(options), selector, options.within); checkSignal(options.signal);
        return window.invoke(control.id);
      }, options),
      setValue(selector, value, options = {}) {
        validateSelector(selector);
        if (typeof value !== 'string') fail('INVALID_ARGUMENT', 'setValue expects a string.');
        const verify = options.verify === true ? { selector: { ...selector, value } } : options.verify;
        return input(async () => {
          const control = unique(await read(options), selector, options.within); checkSignal(options.signal);
          return window.setValue(control.id, value);
        }, { ...options, verify });
      },
      /** Accepts a point, or a selector that is resolved to exactly one element before the click. */
      click: (target, { verify, signal, within, ...nativeOptions } = {}) => input(async () => {
        if (!(target && typeof target === 'object' && !Array.isArray(target))) return window.click(target, nativeOptions);
        const control = unique(await read(nativeOptions), target, within); checkSignal(signal);
        try { return await window.click(control.id, nativeOptions); }
        catch (error) {
          // A refused foreground dispatch sent no input, so the semantic path is not a replay.
          if (!isForegroundDenial(error)) throw error;
          const invokable = declares(control, 'Invoke'), toggleable = declares(control, 'Toggle');
          if (!invokable && !toggleable) throw error;
          const fallback = !invokable && toggleable
            ? await window.performAction(control.id, 'Toggle.Toggle')
            : await window.invoke(control.id);
          return { ...fallback, inputPath: invokable ? 'invoke' : 'toggle', degradedFrom: 'click', foreground: 'denied', elementId: control.id };
        }
      }, { verify, signal }),
      typeText: (text, options = {}) => input(() => keyboard('typeText',[text],options.signal), options),
      pressKey: (key, modifiers, options = {}) => input(() => keyboard('pressKey',[key,modifiers],options.signal), options),
      paste: (text, {verify,signal,...nativeOptions} = {}) => input(() => keyboard('paste',[text,nativeOptions],signal),{verify,signal}),
      performAction: (selector, action, argument, options = {}) => input(async()=>{
        const control=unique(await read(options),selector,options.within);checkSignal(options.signal);return window.performAction(control.id,action,argument);
      },options),
      selectText: (selector,text,{verify,signal,within,...nativeOptions} = {}) => input(async()=>{
        const control=unique(await read(nativeOptions),selector,within);checkSignal(signal);return window.selectText(control.id,text,nativeOptions);
      },{verify,signal}),
      scroll: ({ verify, signal, ...nativeOptions }) => input(() => window.scroll(nativeOptions), { verify, signal }),
      drag: (from, to, { verify, signal, ...nativeOptions } = {}) => input(() => window.drag(from, to, nativeOptions), { verify, signal }),
    });
  }
  return Object.freeze({
    capabilities: () => cua.getCapabilities(),
    async findApps(query = '') {
      if (typeof query !== 'string') fail('INVALID_ARGUMENT', 'query must be a string');
      const needle = query.toLocaleLowerCase();
      return (await cua.listApps()).filter(app => `${app.displayName}\n${app.id}`.toLocaleLowerCase().includes(needle));
    },
    selectApp,
    async selectAppByName(name, options={}) {
      nonempty(name,'name');checkSignal(options.signal);
      const matches=(await cua.listApps()).filter(app=>app.displayName===name && app.isRunning);
      if(matches.length!==1)fail(matches.length?'AMBIGUOUS_APP':'APP_NOT_FOUND','Expected one running application with this exact display name.',{matches});
      return selectApp(matches[0].id,options);
    },
  });
}
