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
      line }));
  }
  return Object.freeze({ tree, elements: Object.freeze(elements), capturedAt: new Date().toISOString() });
}
const selectorKeys = new Set(['name','nameContains','role','automationId','value','enabled','selected']);
function validateSelector(selector) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || Object.keys(selector).length === 0)
    fail('INVALID_SELECTOR', 'Use at least one exact selector field.');
  for (const [key, value] of Object.entries(selector)) {
    if (!selectorKeys.has(key)) fail('INVALID_SELECTOR', `Unsupported selector field: ${key}`);
    if (key === 'enabled' || key === 'selected') { if (typeof value !== 'boolean') fail('INVALID_SELECTOR', `${key} must be boolean`); }
    else if (typeof value !== 'string' || (key !== 'value' && !value.length)) fail('INVALID_SELECTOR', `${key} must be a string`);
  }
  return { ...selector };
}
export function matching(observation, selector) {
  selector = validateSelector(selector);
  return observation.elements.filter(element => Object.entries(selector).every(([key, value]) =>
    key === 'nameContains' ? element.name.includes(value) : element[key] === value));
}
function unique(observation, selector) {
  const matches = matching(observation, selector);
  if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_CONTROL' : 'CONTROL_NOT_FOUND',
    `Expected one control; found ${matches.length}. Refine the selector.`, { selector, matches });
  if (!matches[0].enabled) fail('CONTROL_DISABLED', 'The selected control is disabled.');
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
export function createDesktop(cua, { timeoutMs = 15000, pollMs = 250, maxElements = 2000, maxDepth = 25 } = {}) {
  if (!cua || typeof cua.listApps !== 'function' || typeof cua.getApp !== 'function') fail('INVALID_ARGUMENT', 'Pass the current conversation cua object.');
  integer(timeoutMs, 'timeoutMs', 1, 120000); integer(pollMs, 'pollMs', 20, 5000);
  integer(maxElements, 'maxElements', 1, 10000); integer(maxDepth, 'maxDepth', 1, 100);
  async function selectApp(id, { signal } = {}) {
    nonempty(id, 'appId');
    return serial(cua, signal, async () => {
      const catalog = await cua.listApps();
      const matches = catalog.filter(app => app.id === id);
      if (matches.length !== 1) fail('APP_NOT_FOUND', 'Use an exact current application ID returned by findApps/listApps.');
      if (!matches[0].isRunning) fail('APP_NOT_RUNNING', 'Open an application window before selecting it.');
      const app = await cua.getApp(id); // Built-in application consent remains mandatory.
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
    const read = async () => parseTree(await window.getAccessibilityTree({ details: true, maxElements, maxDepth }));
    const appKeyboard = capabilities.keyboard?.includes('app') && !capabilities.keyboard?.includes('window');
    async function keyboard(method,args,signal) {
      if(appKeyboard) {
        const observation=await read();checkSignal(signal);
        if(!observation.elements.some(e=>e.focused))fail('WINDOW_NOT_FOCUSED','macOS keyboard targets the application. Focus a control in the selected window and observe it before typing.');
      }
      return (appKeyboard?app:window)[method](...args);
    }
    function condition(options) {
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
      let attempts = 0;
      while (true) {
        checkSignal(options.signal);
        const observation = await read(); attempts++;
        checkSignal(options.signal);
        const matches = options.selector ? matching(observation, options.selector) : [];
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
      if (verify && typeof verify === 'object') {
        try { return { dispatch, ...await wait({ ...verify, signal }) }; }
        catch (error) {
          throw new DesktopError('ACTION_UNVERIFIED', 'Action was dispatched, but its postcondition was not verified. Inspect before deciding what to do next.', { dispatch, cause: error.code ?? error.name, message: error.message });
        }
      }
      try { checkSignal(signal); return { dispatch, verified: false, observation: await read() }; }
      catch (error) { throw new DesktopError('ACTION_UNVERIFIED', 'Input was dispatched, but the subsequent observation failed. Do not repeat input blindly.', { dispatch, cause: error.code ?? error.name }); }
    }
    const input = (operation, options = {}) => serial(cua, options.signal, () => once(operation, options));
    return Object.freeze({
      windowId: window.windowId,
      keyboardScope: appKeyboard ? 'app' : 'window',
      observe: (options = {}) => serial(cua, options.signal, read),
      find: (selector, options = {}) => serial(cua, options.signal, async () => matching(await read(), selector)),
      waitFor: (options) => serial(cua, options.signal, () => wait(options)),
      activate: (options = {}) => input(() => app.activate(), options),
      screenshot: (options = {}) => serial(cua, options.signal, () => window.getScreenshot()),
      invoke: (selector, options = {}) => input(async () => {
        const control = unique(await read(), selector); checkSignal(options.signal);
        return window.invoke(control.id);
      }, options),
      setValue(selector, value, options = {}) {
        validateSelector(selector);
        if (typeof value !== 'string') fail('INVALID_ARGUMENT', 'setValue expects a string.');
        const verify = options.verify === true ? { selector: { ...selector, value } } : options.verify;
        return input(async () => {
          const control = unique(await read(), selector); checkSignal(options.signal);
          return window.setValue(control.id, value);
        }, { ...options, verify });
      },
      click: (point, { verify, signal, ...nativeOptions } = {}) => input(() => window.click(point, nativeOptions), { verify, signal }),
      typeText: (text, options = {}) => input(() => keyboard('typeText',[text],options.signal), options),
      pressKey: (key, modifiers, options = {}) => input(() => keyboard('pressKey',[key,modifiers],options.signal), options),
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
  });
}
