const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('weft', {
  layout: bounds => ipcRenderer.invoke('weft:layout', bounds),
  commands: () => ipcRenderer.invoke('weft:commands'),
  pickPath: kind => ipcRenderer.invoke('weft:pickPath', kind === 'folder' ? 'folder' : 'file'),
  onTurnFrame: callback => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('weft:turn', listener);
    return () => ipcRenderer.off('weft:turn', listener);
  },
  executeOutcome: (name, args = {}) => ipcRenderer.invoke('weft:execute', name, args),
  execute: async (name, args = {}) => {
    const outcome = await ipcRenderer.invoke('weft:execute', name, args);
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), outcome.error);
    return outcome.result;
  },
});
