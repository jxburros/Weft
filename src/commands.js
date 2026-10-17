import { z } from 'zod';

const tabId = z.number().int().positive().optional();
const page = { tabId };
const url = z.string().max(16384).refine(value => {
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password
      && (['http:', 'https:'].includes(parsed.protocol) || value === 'about:blank');
  } catch {
    return false;
  }
}, 'Expected an HTTP(S) URL without credentials or about:blank');
const cookieUrl = url.refine(value => value !== 'about:blank', 'Cookies require an HTTP(S) URL');
const definitions = {
  'browser.info': ['Get browser and Chromium versions', {}],
  'tabs.list': ['List browser tabs', {}],
  'tabs.new': ['Open a tab', { url: url.optional() }],
  'tabs.activate': ['Activate a tab', { tabId: tabId.unwrap() }],
  'tabs.close': ['Close a tab', { tabId: tabId.unwrap() }],
  'page.navigate': ['Navigate a tab', { ...page, url }],
  'page.back': ['Go back', page],
  'page.forward': ['Go forward', page],
  'page.reload': ['Reload a tab', page],
  'page.stop': ['Stop loading a tab', page],
  'page.title': ['Read the page title', page],
  'page.content': ['Read the page HTML', page],
  'page.evaluate': ['Evaluate JavaScript in the page (trusted automation only)', {
    ...page, expression: z.string().min(1).max(262144),
  }],
  'page.click': ['Click a CSS selector', { ...page, selector: z.string().min(1).max(16384) }],
  'page.fill': ['Fill an input and dispatch input/change events', {
    ...page, selector: z.string().min(1).max(16384), value: z.string().max(262144),
  }],
  'page.screenshot': ['Capture a PNG as base64', { ...page, fullPage: z.boolean().optional() }],
  'page.pdf': ['Print a page to PDF as base64', page],
  'cookies.list': ['List cookies in the shared browser session', { url: cookieUrl.optional() }],
  'cookies.set': ['Set a cookie in the shared browser session', {
    url: cookieUrl, name: z.string().min(1).max(4096), value: z.string().max(16384),
    httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
  }],
  'cookies.clear': ['Clear cookies in the shared browser session', {}],
  'downloads.list': ['List downloads in this browser run', {}],
  'downloads.cancel': ['Cancel a download', { downloadId: z.number().int().positive() }],
  'browser.close': ['Quit the browser and automation API', {}],
};

const schemas = Object.fromEntries(Object.entries(definitions).map(([name, [, shape]]) => [
  name, z.strictObject(shape),
]));

export const commands = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([name, [description]]) => [
    name, { description, inputSchema: z.toJSONSchema(schemas[name]) },
  ]),
));

export function validateCommand(name, args = {}) {
  if (!Object.hasOwn(schemas, name)) throw new Error(`Unknown command: ${name}`);
  return schemas[name].parse(args);
}
