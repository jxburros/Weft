const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('weft', {
  commands: () => ipcRenderer.invoke('weft:commands'),
  execute: (name, args = {}) => ipcRenderer.invoke('weft:execute', name, args),
});
