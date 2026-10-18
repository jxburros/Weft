const { contextBridge, ipcRenderer } = require('electron');

// Only the browser-owned credential entry window loads this preload.
contextBridge.exposeInMainWorld('weftCredentialEntry', {
  info: () => ipcRenderer.invoke('weft:credential-entry:info'),
  submit: value => ipcRenderer.invoke('weft:credential-entry:submit', value?.kind === 'payment_card'
    ? { number: String(value?.number ?? ''), expiry: String(value?.expiry ?? ''), cvc: String(value?.cvc ?? ''), name: String(value?.name ?? '') }
    : { username: String(value?.username ?? ''), password: String(value?.password ?? '') }),
  cancel: () => ipcRenderer.invoke('weft:credential-entry:cancel'),
});
