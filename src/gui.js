const $ = id => document.getElementById(id);
let catalog = {};
let activeTab;
let refreshing = false;
let tabSnapshot = '';

function showResult(result) {
  $('result').textContent = JSON.stringify(result, null, 2);
  $('artifact').replaceChildren();
  if (result?.data && ['image/png', 'application/pdf'].includes(result.mimeType)) {
    const link = document.createElement('a');
    link.href = `data:${result.mimeType};base64,${result.data}`;
    link.download = result.mimeType === 'image/png' ? 'screenshot.png' : 'page.pdf';
    link.textContent = 'Save artifact';
    $('artifact').append(link);
    $('result').textContent = JSON.stringify({ ...result, data: `[${result.data.length} base64 characters]` }, null, 2);
  }
}

async function execute(name, args = {}) {
  $('status').textContent = `Running ${name}…`;
  try {
    const result = await window.weft.execute(name, args);
    showResult(result);
    $('status').textContent = 'Done';
    await refreshTabs();
    return result;
  } catch (error) {
    $('status').textContent = `Error: ${error.message}`;
    throw error;
  }
}

async function refreshTabs() {
  if (refreshing) return;
  refreshing = true;
  try {
    const tabs = await window.weft.execute('tabs.list', {});
    activeTab = tabs.find(tab => tab.active);
    if (document.activeElement !== $('address')) $('address').value = activeTab?.url ?? '';
    const snapshot = JSON.stringify(tabs);
    if (snapshot === tabSnapshot) return;
    tabSnapshot = snapshot;
    $('tabs').replaceChildren();
    for (const tab of tabs) {
      const group = document.createElement('div');
      group.className = tab.active ? 'tab active' : 'tab';
      const activate = document.createElement('button');
      activate.textContent = tab.title || tab.url || 'New tab';
      activate.title = tab.url;
      activate.onclick = () => void execute('tabs.activate', { tabId: tab.id }).catch(() => {});
      const close = document.createElement('button');
      close.textContent = '×';
      close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`);
      close.onclick = () => void execute('tabs.close', { tabId: tab.id }).catch(() => {});
      group.append(activate, close);
      $('tabs').append(group);
    }
  } finally { refreshing = false; }
}

function selectCommand() {
  const entry = catalog[$('command').value];
  $('description').textContent = entry.description;
  $('schema').textContent = JSON.stringify(entry.inputSchema, null, 2);
  const args = {};
  for (const key of entry.inputSchema.required ?? []) {
    const property = entry.inputSchema.properties[key];
    args[key] = property.type === 'integer' ? (activeTab?.id ?? 1) :
      property.type === 'boolean' ? false : '';
  }
  $('arguments').value = JSON.stringify(args, null, 2);
}

$('command').onchange = selectCommand;
$('run').onclick = async () => {
  try { await execute($('command').value, JSON.parse($('arguments').value)); }
  catch (error) { $('status').textContent = `Error: ${error.message}`; }
};
$('new-tab').onclick = () => void execute('tabs.new').catch(() => {});
for (const action of ['back', 'forward', 'reload', 'stop']) {
  $(action).onclick = () => void execute(`page.${action}`).catch(() => {});
}
$('navigation').onsubmit = event => {
  event.preventDefault();
  let url = $('address').value.trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
  void execute(activeTab ? 'page.navigate' : 'tabs.new', { url }).catch(() => {});
};

try {
  catalog = await window.weft.commands();
  for (const name of Object.keys(catalog)) {
    const option = document.createElement('option');
    option.value = option.textContent = name;
    $('command').append(option);
  }
  selectCommand();
  await refreshTabs();
  setInterval(() => void refreshTabs().catch(() => {}), 1000);
} catch (error) {
  $('status').textContent = `Startup error: ${error.message}`;
}
