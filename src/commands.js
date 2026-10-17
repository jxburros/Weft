import { z } from 'zod';
import { commandDefinitions as workspaceDefinitions } from './workspace-commands.js';
import { providerCommandDefinitions } from './provider-commands.js';

const tabId = z.number().int().positive().optional();
const workspaceId = z.string().min(1).max(200).optional();
const expectedVersion = z.number().int().positive().optional();
const page = { tabId, workspaceId, expectedVersion };
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
  'browser.emergencyStop': ['Human emergency stop: revoke tab leases, stop loading, and pause running tasks', {}],
  'downloads.approve': ['Human authorizes retry of one blocked download in its original tab', { downloadId: z.number().int().positive() }],
  'browser.info': ['Get browser and Chromium versions', {}],
  'tabs.list': ['List tabs in a workspace', { workspaceId }],
  'tabs.new': ['Open a tab', { url: url.optional(), workspaceId }],
  'tabs.activate': ['Activate a tab', { tabId: tabId.unwrap() }],
  'tabs.close': ['Close a tab', { tabId: tabId.unwrap(), expectedVersion }],
  'tabs.move': ['Reopen a tab in another workspace isolated container', { tabId: tabId.unwrap(), workspaceId: workspaceId.unwrap(), expectedVersion }],
  'tabs.pin': ['Pin or unpin a tab', { tabId: tabId.unwrap(), pinned: z.boolean(), expectedVersion }],
  'tabs.duplicate': ['Duplicate a tab in its workspace', { tabId: tabId.unwrap() }],
  'tabs.claim': ['Claim tab input control', { tabId: tabId.unwrap(), controller: z.string().min(1).max(100).optional(), expectedVersion }],
  'tabs.takeover': ['Human takes control and revokes old versions', { tabId: tabId.unwrap() }],
  'tabs.release': ['Release tab input control', { tabId: tabId.unwrap() }],
  'page.inspect': ['Inspect tab state and navigation version', page],
  'page.readable': ['Read text and links from the current page', page],
  'page.find': ['Find text in page; empty text clears results', { ...page, text: z.string().max(4096), forward: z.boolean().optional(), findNext: z.boolean().optional() }],
  'page.zoom': ['Set page zoom factor', { ...page, factor: z.number().min(0.25).max(5) }],
  'storage.info': ['Describe storage isolation and supported controls', { workspaceId }],
  'storage.clear': ['Clear site origin or entire workspace data (human administration)', { workspaceId, url: cookieUrl.optional() }],
  'page.allowOnce': ['Allow this blocked destination for this tab visit (human only; redirects and other destinations remain checked)', { tabId: tabId.unwrap() }],
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
  'cookies.list': ['List cookies in a workspace session (human administration)', { url: cookieUrl.optional(), workspaceId }],
  'cookies.set': ['Set a cookie in a workspace session (human administration)', { workspaceId,
    url: cookieUrl, name: z.string().min(1).max(4096), value: z.string().max(16384),
    httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
  }],
  'cookies.clear': ['Clear workspace cookies (human administration)', { workspaceId }],
  'downloads.list': ['List workspace downloads in this browser run', { workspaceId }],
  'downloads.cancel': ['Cancel a download', { downloadId: z.number().int().positive() }],
  'browser.close': ['Quit the browser and automation API', {}],
  ...workspaceDefinitions,
  ...providerCommandDefinitions,
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
