const { contextBridge, ipcRenderer } = require('electron');

// Only the browser-owned credential entry window loads this preload.
contextBridge.exposeInMainWorld('weftCredentialEntry', {
  info: () => ipcRenderer.invoke('weft:credential-entry:info'),
  submit: value => ipcRenderer.invoke('weft:credential-entry:submit', { username: String(value?.username ?? ''), password: String(value?.password ?? '') }),
  cancel: () => ipcRenderer.invoke('weft:credential-entry:cancel'),
});
