const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('weft', {
  layout: bounds => ipcRenderer.invoke('weft:layout', bounds),
  commands: () => ipcRenderer.invoke('weft:commands'),
  executeOutcome: (name, args = {}) => ipcRenderer.invoke('weft:execute', name, args),
  execute: async (name, args = {}) => {
    const outcome = await ipcRenderer.invoke('weft:execute', name, args);
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), outcome.error);
    return outcome.result;
  },
});
